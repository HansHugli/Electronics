import { useMemo } from 'react';
import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';
import { formatValue } from '../utils/format';
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

/** Get a human-readable value string for a component. */
function getValueLabel(comp: PlacedComponent): string {
  const def = COMPONENT_DEFINITIONS[comp.type];
  if (!def) return '';
  switch (comp.type) {
    case 'resistor': return formatValue(Number(comp.properties.resistance ?? 220), 'Ω');
    case 'capacitor': return formatValue(Number(comp.properties.capacitance ?? 100), 'F', -6);
    case 'led': return String(comp.properties.color ?? 'red').toUpperCase();
    default: return def.chipLabel ?? def.label ?? '';
  }
}

/** Map footprint sizes (pixels for PCB layout). */
function getFootprintSize(type: string): { w: number; h: number } {
  switch (type) {
    case 'resistor': return { w: 100, h: 36 };
    case 'capacitor': return { w: 50, h: 50 };
    case 'led': return { w: 44, h: 44 };
    case 'switch': return { w: 50, h: 36 };
    case 'potentiometer': return { w: 60, h: 60 };
    case 'vreg': return { w: 50, h: 70 };
    case 'funcgen': return { w: 90, h: 50 };
    default: {
      const def = COMPONENT_DEFINITIONS[type];
      if (!def) return { w: 70, h: 70 };
      const pinCount = def.pins.length;
      return { w: Math.max(70, def.width * 36), h: Math.max(50, pinCount * 12) };
    }
  }
}

function buildComponentClusters(components: PlacedComponent[], wires: Wire[]): string[][] {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    let cur = parent.get(key)!;
    while (parent.get(cur) !== cur) {
      parent.set(cur, parent.get(parent.get(cur)!)!);
      cur = parent.get(cur)!;
    }
    parent.set(key, cur);
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  components.forEach((comp) => find(comp.id));

  for (const wire of wires) {
    if (wire.from.componentId !== 'board' && wire.to.componentId !== 'board') {
      union(wire.from.componentId, wire.to.componentId);
    }
  }

  const boardGroups = new Map<string, string[]>();
  for (const comp of components) {
    const def = COMPONENT_DEFINITIONS[comp.type];
    if (!def) continue;
    for (const pin of def.pins) {
      const pos = getComponentPinPixel(comp, pin.id);
      if (!pos) continue;
      const grid = pixelToBoardGrid(pos.x, pos.y);
      const groupId = boardPinLookup.get(`${grid.col},${grid.row}`);
      if (!groupId) continue;
      if (!boardGroups.has(groupId)) boardGroups.set(groupId, []);
      boardGroups.get(groupId)!.push(comp.id);
    }
  }

  for (const ids of boardGroups.values()) {
    for (let i = 1; i < ids.length; i++) {
      union(ids[0], ids[i]);
    }
  }

  const clusters = new Map<string, string[]>();
  for (const comp of components) {
    const root = find(comp.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(comp.id);
  }
  return Array.from(clusters.values());
}

function getNetDegree(comp: PlacedComponent, wires: Wire[]): number {
  return wires.reduce((count, wire) => (
    count + (wire.from.componentId === comp.id ? 1 : 0) + (wire.to.componentId === comp.id ? 1 : 0)
  ), 0);
}

function rectIntersectsSegment(rect: { x: number; y: number; w: number; h: number }, ax: number, ay: number, bx: number, by: number): boolean {
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minY = Math.min(ay, by);
  const maxY = Math.max(ay, by);
  if (ax === bx) {
    return ax > rect.x && ax < rect.x + rect.w && maxY > rect.y && minY < rect.y + rect.h;
  }
  if (ay === by) {
    return ay > rect.y && ay < rect.y + rect.h && maxX > rect.x && minX < rect.x + rect.w;
  }
  return false;
}

function segsOverlap(ax1: number, ay1: number, ax2: number, ay2: number, bx1: number, by1: number, bx2: number, by2: number): boolean {
  if (ax1 === ax2 && bx1 === bx2 && ax1 === bx1) {
    const aMin = Math.min(ay1, ay2);
    const aMax = Math.max(ay1, ay2);
    const bMin = Math.min(by1, by2);
    const bMax = Math.max(by1, by2);
    return aMax > bMin && bMax > aMin;
  }
  if (ay1 === ay2 && by1 === by2 && ay1 === by1) {
    const aMin = Math.min(ax1, ax2);
    const aMax = Math.max(ax1, ax2);
    const bMin = Math.min(bx1, bx2);
    const bMax = Math.max(bx1, bx2);
    return aMax > bMin && bMax > aMin;
  }
  return false;
}

function pathIsClear(
  points: { x: number; y: number }[],
  rects: { x: number; y: number; w: number; h: number }[],
  occupied: { ax: number; ay: number; bx: number; by: number }[],
): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x;
    const ay = points[i].y;
    const bx = points[i + 1].x;
    const by = points[i + 1].y;
    for (const rect of rects) {
      if (rectIntersectsSegment(rect, ax, ay, bx, by)) return false;
    }
    for (const seg of occupied) {
      if (segsOverlap(ax, ay, bx, by, seg.ax, seg.ay, seg.bx, seg.by)) return false;
    }
  }
  return true;
}

function pointsToPathD(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  return points.map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ');
}

function routeTrace(
  from: { x: number; y: number },
  to: { x: number; y: number },
  netIdx: number,
  rects: { x: number; y: number; w: number; h: number }[],
  occupied: { ax: number; ay: number; bx: number; by: number }[],
): { path: string; points: { x: number; y: number }[] } {
  const offset = (netIdx % 3 - 1) * 10;
  const candidates: { x: number; y: number }[][] = [];
  const midX = (from.x + to.x) / 2 + offset;
  const midY = (from.y + to.y) / 2 + offset;

  candidates.push([from, { x: midX, y: from.y }, { x: midX, y: to.y }, to]);
  candidates.push([from, { x: from.x, y: midY }, { x: to.x, y: midY }, to]);
  candidates.push([from, { x: from.x, y: to.y }, to]);
  candidates.push([from, { x: to.x, y: from.y }, to]);
  candidates.push([from, { x: midX, y: from.y }, { x: midX, y: midY }, { x: to.x, y: midY }, to]);
  candidates.push([from, { x: from.x, y: midY }, { x: midX, y: midY }, { x: midX, y: to.y }, to]);

  for (const candidate of candidates) {
    if (pathIsClear(candidate, rects, occupied)) {
      return { path: pointsToPathD(candidate), points: candidate };
    }
  }

  return { path: pointsToPathD([from, { x: from.x, y: to.y }, to ]), points: [from, { x: from.x, y: to.y }, to] };
}

const BOARD_PAD = 50;
const COMP_SPACING = 60;

interface LayoutItem {
  comp: PlacedComponent;
  ref: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pins: { id: string; label: string; x: number; y: number }[];
}

/** Assign distinct colors per net for visual clarity. */
const NET_COLORS = [
  '#c8a96e', '#e8783a', '#5bb5e8', '#8bc34a', '#ff7043',
  '#ab47bc', '#26a69a', '#ef5350', '#66bb6a', '#ffa726',
  '#42a5f5', '#ec407a', '#7e57c2', '#29b6f6', '#d4e157',
];

export default function PCBView({ components, wires, onClose }: PCBViewProps) {
  const { items, boardW, boardH, nets } = useMemo(() => {
    const placeable = components.filter((c) => c.type !== 'power' && c.type !== 'multimeter');
    const layoutItems: LayoutItem[] = [];

    // --- Auto-layout: cluster components by connectivity and place connected groups together ---
    const clusters = buildComponentClusters(placeable, wires);
    const sortedClusters = clusters
      .map((cluster) => cluster
        .map((id) => placeable.find((comp) => comp.id === id))
        .filter((comp): comp is PlacedComponent => Boolean(comp)))
      .sort((a, b) => b.length - a.length);

    let curX = BOARD_PAD;
    let curY = BOARD_PAD;
    let rowH = 0;
    const maxW = 900;
    const PAD_INSET = 4; // keep pads slightly inside body edge

    for (const group of sortedClusters) {
      const sortedGroup = group.sort((a, b) => getNetDegree(b, wires) - getNetDegree(a, wires));
      if (curX !== BOARD_PAD) {
        curX = BOARD_PAD;
        curY += rowH + COMP_SPACING;
        rowH = 0;
      }

      for (const comp of sortedGroup) {
        const def = COMPONENT_DEFINITIONS[comp.type];
        if (!def) continue;
        const { w, h } = getFootprintSize(comp.type);

        if (curX + w + COMP_SPACING > maxW) {
          curX = BOARD_PAD;
          curY += rowH + COMP_SPACING;
          rowH = 0;
        }

        const pins: LayoutItem['pins'] = [];
        const leftPins = def.pins.filter((p) => p.side === 'left');
        const rightPins = def.pins.filter((p) => p.side === 'right');
        const topPins = def.pins.filter((p) => p.side === 'top');
        const bottomPins = def.pins.filter((p) => p.side === 'bottom');

        leftPins.forEach((p, i) => {
          pins.push({ id: p.id, label: p.label, x: curX - PAD_INSET, y: curY + ((i + 0.5) / Math.max(leftPins.length, 1)) * h });
        });
        rightPins.forEach((p, i) => {
          pins.push({ id: p.id, label: p.label, x: curX + w + PAD_INSET, y: curY + ((i + 0.5) / Math.max(rightPins.length, 1)) * h });
        });
        topPins.forEach((p, i) => {
          pins.push({ id: p.id, label: p.label, x: curX + ((i + 0.5) / Math.max(topPins.length, 1)) * w, y: curY - PAD_INSET });
        });
        bottomPins.forEach((p, i) => {
          pins.push({ id: p.id, label: p.label, x: curX + ((i + 0.5) / Math.max(bottomPins.length, 1)) * w, y: curY + h + PAD_INSET });
        });

        layoutItems.push({ comp, ref: getRef(comp), x: curX, y: curY, w, h, pins });
        curX += w + COMP_SPACING;
        rowH = Math.max(rowH, h);
      }

      curX = BOARD_PAD;
      curY += rowH + COMP_SPACING;
      rowH = 0;
    }

    const bw = maxW + BOARD_PAD;
    const bh = Math.max(curY + rowH + BOARD_PAD * 2, 200);

    // --- Build nets using Union-Find ---
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

    for (const comp of placeable) {
      const def = COMPONENT_DEFINITIONS[comp.type];
      if (!def) continue;
      for (const pin of def.pins) find(pk(comp.id, pin.id));
    }

    for (const wire of wires) {
      find(pk(wire.from.componentId, wire.from.pinId));
      find(pk(wire.to.componentId, wire.to.pinId));
      union(pk(wire.from.componentId, wire.from.pinId), pk(wire.to.componentId, wire.to.pinId));
    }

    for (const comp of placeable) {
      if (comp.type === 'switch' && comp.state?.closed) {
        union(pk(comp.id, 'a'), pk(comp.id, 'b'));
      }
    }

    // Breadboard internal wiring
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

    // --- Build net traces with MST (minimum spanning tree) for cleaner routing ---
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

    const layoutRects = layoutItems.map((item) => ({
      x: item.x - 10,
      y: item.y - 10,
      w: item.w + 20,
      h: item.h + 20,
    }));

    // Use Prim's MST to connect pins within each net (avoids long chain routing)
    const netTraces: { path: string; netIdx: number }[] = [];
    let netIdx = 0;
    for (const [, pts] of netGroups) {
      if (pts.length < 2) { netIdx++; continue; }

      const inTree = new Set<number>([0]);
      const remaining = new Set<number>();
      for (let i = 1; i < pts.length; i++) remaining.add(i);
      const occupiedSegments: { ax: number; ay: number; bx: number; by: number }[] = [];

      while (remaining.size > 0) {
        let bestDist = Infinity;
        let bestFrom = 0;
        let bestTo = 0;
        for (const fi of inTree) {
          for (const ti of remaining) {
            const dx = pts[fi].x - pts[ti].x;
            const dy = pts[fi].y - pts[ti].y;
            const dist = Math.abs(dx) + Math.abs(dy);
            if (dist < bestDist) {
              bestDist = dist;
              bestFrom = fi;
              bestTo = ti;
            }
          }
        }

        const { path, points } = routeTrace(pts[bestFrom], pts[bestTo], netIdx, layoutRects, occupiedSegments);
        for (let p = 0; p < points.length - 1; p++) {
          occupiedSegments.push({
            ax: points[p].x,
            ay: points[p].y,
            bx: points[p + 1].x,
            by: points[p + 1].y,
          });
        }

        inTree.add(bestTo);
        remaining.delete(bestTo);
        netTraces.push({ path, netIdx });
      }
      netIdx++;
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
            {/* Board background */}
            <rect x={0} y={0} width={boardW} height={boardH} rx={8} fill="#1a5c2a" />
            {/* Board outline */}
            <rect x={4} y={4} width={boardW - 8} height={boardH - 8} rx={6} fill="none" stroke="#2d8a4e" strokeWidth={1.5} />
            {/* Ground plane hatching */}
            <defs>
              <pattern id="pcb-hatch" width={12} height={12} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1={0} y1={0} x2={0} y2={12} stroke="#1b6630" strokeWidth={0.5} />
              </pattern>
            </defs>
            <rect x={6} y={6} width={boardW - 12} height={boardH - 12} rx={4} fill="url(#pcb-hatch)" opacity={0.4} />

            {/* Traces — rendered behind components */}
            {nets.map((net, i) => {
              const color = NET_COLORS[net.netIdx % NET_COLORS.length];
              return (
                <path
                  key={`trace-${i}`}
                  d={net.path}
                  stroke={color}
                  strokeWidth={2.5}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.75}
                />
              );
            })}

            {/* Components */}
            {items.map((item) => {
              const def = COMPONENT_DEFINITIONS[item.comp.type];
              const isChip = def?.category === 'active';
              return (
                <g key={item.comp.id}>
                  {/* Courtyard (clearance area) */}
                  <rect
                    x={item.x - 6} y={item.y - 6}
                    width={item.w + 12} height={item.h + 12}
                    rx={4} fill="#1a5c2a" opacity={0.6}
                  />
                  {/* Component body */}
                  <rect
                    x={item.x} y={item.y}
                    width={item.w} height={item.h}
                    rx={isChip ? 2 : 3}
                    fill={isChip ? '#1a1a1a' : '#2d2d2d'}
                    stroke="#666"
                    strokeWidth={1}
                  />
                  {/* Chip notch */}
                  {isChip && (
                    <circle
                      cx={item.x + 8} cy={item.y + 8}
                      r={3} fill="none" stroke="#555" strokeWidth={0.8}
                    />
                  )}
                  {/* Silkscreen: reference designator */}
                  <text
                    x={item.x + item.w / 2}
                    y={item.y + item.h / 2 - 3}
                    textAnchor="middle"
                    fill="#e2e8f0"
                    fontSize={11}
                    fontWeight="700"
                    fontFamily="monospace"
                    pointerEvents="none"
                  >
                    {item.ref}
                  </text>
                  {/* Silkscreen: value */}
                  <text
                    x={item.x + item.w / 2}
                    y={item.y + item.h / 2 + 9}
                    textAnchor="middle"
                    fill="#94a3b8"
                    fontSize={8}
                    fontFamily="monospace"
                    pointerEvents="none"
                  >
                    {getValueLabel(item.comp)}
                  </text>
                  {/* Pads with pin labels */}
                  {item.pins.map((pin) => {
                    const isLeft = pin.x < item.x + item.w / 2;
                    return (
                      <g key={pin.id}>
                        <rect
                          x={pin.x - 4} y={pin.y - 3}
                          width={8} height={6}
                          rx={1} fill="#c8a96e" stroke="#8b7340" strokeWidth={0.6}
                        />
                        <circle cx={pin.x} cy={pin.y} r={1.5} fill="#1a5c2a" />
                        {/* Pin label (only for chips with > 2 pins) */}
                        {(def?.pins.length ?? 0) > 4 && (
                          <text
                            x={isLeft ? pin.x - 7 : pin.x + 7}
                            y={pin.y + 2.5}
                            textAnchor={isLeft ? 'end' : 'start'}
                            fill="#4ade80"
                            fontSize={5}
                            fontFamily="monospace"
                            opacity={0.7}
                            pointerEvents="none"
                          >
                            {pin.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}

            {/* Mounting holes */}
            {[[16, 16], [boardW - 16, 16], [16, boardH - 16], [boardW - 16, boardH - 16]].map(([cx, cy], i) => (
              <g key={`mh-${i}`}>
                <circle cx={cx} cy={cy} r={7} fill="#2d8a4e" stroke="#1a5c2a" strokeWidth={1.5} />
                <circle cx={cx} cy={cy} r={3} fill="#0f3a1a" />
              </g>
            ))}

            {/* Board title silkscreen */}
            <text
              x={boardW / 2} y={boardH - 14}
              textAnchor="middle"
              fill="#2d8a4e"
              fontSize={8}
              fontFamily="monospace"
              fontWeight="600"
            >
              E101 PCB Rev A
            </text>
          </svg>
        </div>
        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
