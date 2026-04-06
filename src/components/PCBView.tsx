import { useMemo } from 'react';
import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';
import {
  GRID_W, GRID_H, BOARD_X_OFFSET,
  buildPinGroups, buildPinLookup,
} from '../data/breadboard';

// Breadboard data (static)
const boardPinGroups = buildPinGroups();
const boardPinLookup = buildPinLookup(boardPinGroups);

function getComponentPinPixel(comp: PlacedComponent, pinId: string): { x: number; y: number } | null {
  const def = COMPONENT_DEFINITIONS[comp.type];
  if (!def) return null;
  const pin = def.pins.find((p) => p.id === pinId);
  if (!pin) return null;
  const isRotated = comp.rotation === 90 || comp.rotation === 270;
  const w = (isRotated ? def.height : def.width) * GRID_W;
  const h = (isRotated ? def.width : def.height) * GRID_H;
  const sides: ('top' | 'right' | 'bottom' | 'left')[] = ['top', 'right', 'bottom', 'left'];
  const idx = sides.indexOf(pin.side);
  const steps = Math.round(comp.rotation / 90) % 4;
  const side = sides[(idx + steps) % 4];
  let px = 0, py = 0;
  switch (side) {
    case 'left':   px = 0;              py = h * pin.offset; break;
    case 'right':  px = w;              py = h * pin.offset; break;
    case 'top':    px = w * pin.offset; py = 0;              break;
    case 'bottom': px = w * pin.offset; py = h;              break;
  }
  return { x: comp.position.x + px, y: comp.position.y + py };
}

function pixelToBoardGrid(px: number, py: number): { col: number; row: number } {
  return {
    col: Math.round((px - BOARD_X_OFFSET - GRID_W / 2) / GRID_W),
    row: Math.round((py - GRID_H / 2) / GRID_H),
  };
}

interface PCBViewProps {
  components: PlacedComponent[];
  wires: Wire[];
  onClose: () => void;
}

/** Reference designator for a component. */
function getRef(comp: PlacedComponent): string {
  const num = comp.id.replace(/\D/g, '');
  switch (comp.type) {
    case 'resistor': return `R${num}`;
    case 'capacitor': return `C${num}`;
    case 'led': return `D${num}`;
    case 'switch': return `SW${num}`;
    case 'potentiometer': return `RV${num}`;
    case 'display7seg': return `DS${num}`;
    default: return `U${num}`;
  }
}

/** Map footprint sizes (grid units for PCB layout). */
function getFootprintSize(type: string): { w: number; h: number } {
  switch (type) {
    case 'resistor': return { w: 120, h: 40 };
    case 'capacitor': return { w: 60, h: 60 };
    case 'led': return { w: 50, h: 50 };
    case 'switch': return { w: 60, h: 40 };
    case 'potentiometer': return { w: 70, h: 70 };
    case 'vreg': return { w: 60, h: 80 };
    case 'funcgen': return { w: 100, h: 60 };
    default: {
      const def = COMPONENT_DEFINITIONS[type];
      if (!def) return { w: 80, h: 80 };
      const pinCount = def.pins.length;
      return { w: Math.max(80, def.width * 40), h: Math.max(60, pinCount * 14) };
    }
  }
}

const BOARD_PAD = 60;
const COMP_SPACING = 40;

interface LayoutItem {
  comp: PlacedComponent;
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pins: { id: string; label: string; x: number; y: number }[];
}

export default function PCBView({ components, wires, onClose }: PCBViewProps) {
  // Auto-layout components on a PCB board
  const { items, boardW, boardH, nets } = useMemo(() => {
    const placeable = components.filter((c) => c.type !== 'power' && c.type !== 'multimeter');
    const layoutItems: LayoutItem[] = [];

    // Simple grid layout
    let curX = BOARD_PAD;
    let curY = BOARD_PAD;
    let rowH = 0;
    const maxW = 1000;

    for (const comp of placeable) {
      const def = COMPONENT_DEFINITIONS[comp.type];
      if (!def) continue;
      const { w, h } = getFootprintSize(comp.type);

      if (curX + w + COMP_SPACING > maxW) {
        curX = BOARD_PAD;
        curY += rowH + COMP_SPACING;
        rowH = 0;
      }

      // Generate pin positions
      const pins: LayoutItem['pins'] = [];
      const leftPins = def.pins.filter((p) => p.side === 'left');
      const rightPins = def.pins.filter((p) => p.side === 'right');
      const topPins = def.pins.filter((p) => p.side === 'top');
      const bottomPins = def.pins.filter((p) => p.side === 'bottom');

      leftPins.forEach((p, i) => {
        pins.push({ id: p.id, label: p.label, x: curX, y: curY + ((i + 0.5) / Math.max(leftPins.length, 1)) * h });
      });
      rightPins.forEach((p, i) => {
        pins.push({ id: p.id, label: p.label, x: curX + w, y: curY + ((i + 0.5) / Math.max(rightPins.length, 1)) * h });
      });
      topPins.forEach((p, i) => {
        pins.push({ id: p.id, label: p.label, x: curX + ((i + 0.5) / Math.max(topPins.length, 1)) * w, y: curY });
      });
      bottomPins.forEach((p, i) => {
        pins.push({ id: p.id, label: p.label, x: curX + ((i + 0.5) / Math.max(bottomPins.length, 1)) * w, y: curY + h });
      });

      layoutItems.push({
        comp,
        ref: getRef(comp),
        x: curX, y: curY, w, h,
        pins,
      });

      curX += w + COMP_SPACING;
      if (h > rowH) rowH = h;
    }

    const bw = maxW + BOARD_PAD;
    const bh = curY + rowH + BOARD_PAD * 2;

    // Build nets using Union-Find (same as simulator) to capture breadboard internal connections
    const parent = new Map<string, string>();
    function find(k: string): string {
      if (!parent.has(k)) parent.set(k, k);
      let p = parent.get(k)!;
      while (parent.get(p) !== p) {
        parent.set(p, parent.get(parent.get(p)!)!);
        p = parent.get(p)!;
      }
      parent.set(k, p);
      return p;
    }
    function union(a: string, b: string) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    const pk = (compId: string, pinId: string) => `${compId}:${pinId}`;

    // Register all component pins
    for (const comp of placeable) {
      const def = COMPONENT_DEFINITIONS[comp.type];
      if (!def) continue;
      for (const pin of def.pins) find(pk(comp.id, pin.id));
    }

    // Merge by wires
    for (const wire of wires) {
      find(pk(wire.from.componentId, wire.from.pinId));
      find(pk(wire.to.componentId, wire.to.pinId));
      union(pk(wire.from.componentId, wire.from.pinId), pk(wire.to.componentId, wire.to.pinId));
    }

    // Merge switch pins if closed
    for (const comp of placeable) {
      if (comp.type === 'switch' && comp.state?.closed) {
        union(pk(comp.id, 'a'), pk(comp.id, 'b'));
      }
    }

    // Breadboard internal wiring: merge pins in same strip
    const groupToPins = new Map<string, string[]>();
    for (const comp of placeable) {
      if (comp.type === 'power') continue;
      const def = COMPONENT_DEFINITIONS[comp.type];
      if (!def) continue;
      for (const pin of def.pins) {
        const pos = getComponentPinPixel(comp, pin.id);
        if (!pos) continue;
        const grid = pixelToBoardGrid(pos.x, pos.y);
        const groupId = boardPinLookup.get(`${grid.col},${grid.row}`);
        if (!groupId) continue;
        const key = pk(comp.id, pin.id);
        if (!groupToPins.has(groupId)) groupToPins.set(groupId, []);
        groupToPins.get(groupId)!.push(key);
      }
    }
    // Also include board pin wire endpoints
    for (const wire of wires) {
      for (const ep of [wire.from, wire.to]) {
        if (ep.componentId === 'board') {
          const [c, r] = ep.pinId.split(',');
          const groupId = boardPinLookup.get(`${c},${r}`);
          if (!groupId) continue;
          const key = pk(ep.componentId, ep.pinId);
          if (!groupToPins.has(groupId)) groupToPins.set(groupId, []);
          groupToPins.get(groupId)!.push(key);
        }
      }
    }
    for (const [, pins] of groupToPins) {
      for (let i = 1; i < pins.length; i++) union(pins[0], pins[i]);
    }

    // Group layout pins by net root
    const netGroups = new Map<string, { x: number; y: number }[]>();
    for (const item of layoutItems) {
      const def = COMPONENT_DEFINITIONS[item.comp.type];
      if (!def) continue;
      for (const pin of def.pins) {
        const root = find(pk(item.comp.id, pin.id));
        const layoutPin = item.pins.find((p) => p.id === pin.id);
        if (!layoutPin) continue;
        if (!netGroups.has(root)) netGroups.set(root, []);
        netGroups.get(root)!.push({ x: layoutPin.x, y: layoutPin.y });
      }
    }

    // Draw traces: connect each pin in a net to the next (chain)
    const netTraces: { from: { x: number; y: number }; to: { x: number; y: number } }[] = [];
    for (const [, pts] of netGroups) {
      if (pts.length < 2) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        netTraces.push({ from: pts[i], to: pts[i + 1] });
      }
    }

    return { items: layoutItems, boardW: bw, boardH: bh, nets: netTraces };
  }, [components, wires]);

  return (
    <div className="modal-overlay">
      <div className="modal pcb-modal">
        <div className="pcb-header">
          <h2 className="modal-title">PCB Layout Preview</h2>
          <button type="button" className="scope-close-btn" onClick={onClose}>x</button>
        </div>
        <div className="pcb-canvas-wrap">
          <svg className="pcb-canvas" viewBox={`0 0 ${boardW} ${boardH}`} preserveAspectRatio="xMidYMid meet">
            {/* Board */}
            <rect x={0} y={0} width={boardW} height={boardH} rx={8} fill="#1a5c2a" />
            {/* Board outline */}
            <rect x={4} y={4} width={boardW - 8} height={boardH - 8} rx={6} fill="none" stroke="#2d8a4e" strokeWidth={1.5} />

            {/* Traces (wires) */}
            {nets.map((net, i) => {
              const midX = (net.from.x + net.to.x) / 2;
              return (
                <path
                  key={`trace-${i}`}
                  d={`M ${net.from.x} ${net.from.y} L ${midX} ${net.from.y} L ${midX} ${net.to.y} L ${net.to.x} ${net.to.y}`}
                  stroke="#c8a96e"
                  strokeWidth={3.5}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.8}
                />
              );
            })}

            {/* Components */}
            {items.map((item) => {
              const def = COMPONENT_DEFINITIONS[item.comp.type];
              const isChip = def?.category === 'active';
              return (
                <g key={item.comp.id}>
                  {/* Component body */}
                  <rect
                    x={item.x} y={item.y}
                    width={item.w} height={item.h}
                    rx={isChip ? 3 : 4}
                    fill={isChip ? '#1a1a1a' : '#2d2d2d'}
                    stroke="#555"
                    strokeWidth={1.5}
                  />
                  {/* Reference designator */}
                  <text
                    x={item.x + item.w / 2}
                    y={item.y + item.h / 2 - 4}
                    textAnchor="middle"
                    fill="#e2e8f0"
                    fontSize={14}
                    fontWeight="600"
                    pointerEvents="none"
                  >
                    {item.ref}
                  </text>
                  {/* Value */}
                  <text
                    x={item.x + item.w / 2}
                    y={item.y + item.h / 2 + 10}
                    textAnchor="middle"
                    fill="#94a3b8"
                    fontSize={10}
                    pointerEvents="none"
                  >
                    {def?.chipLabel ?? def?.label ?? ''}
                  </text>
                  {/* Pads */}
                  {item.pins.map((pin) => (
                    <g key={pin.id}>
                      <circle cx={pin.x} cy={pin.y} r={5} fill="#c8a96e" stroke="#8b7340" strokeWidth={1} />
                      <circle cx={pin.x} cy={pin.y} r={2.5} fill="#1a5c2a" />
                    </g>
                  ))}
                </g>
              );
            })}

            {/* Mounting holes */}
            {[[16, 16], [boardW - 16, 16], [16, boardH - 16], [boardW - 16, boardH - 16]].map(([cx, cy], i) => (
              <g key={`mh-${i}`}>
                <circle cx={cx} cy={cy} r={8} fill="#2d8a4e" stroke="#1a5c2a" strokeWidth={1.5} />
                <circle cx={cx} cy={cy} r={3.5} fill="#0f3a1a" />
              </g>
            ))}
          </svg>
        </div>
        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
