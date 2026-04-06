import { useRef, useCallback, useMemo, useState } from 'react';
import { PlacedComponent, Wire, Point } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';

const GRID_SIZE = 24;
const BOARD_COLS = 30;
const BOARD_ROWS = 20;
const BOARD_WIDTH = BOARD_COLS * GRID_SIZE;
const BOARD_HEIGHT = BOARD_ROWS * GRID_SIZE;

// Power supply area to the left of the breadboard
const SUPPLY_WIDTH = 5 * GRID_SIZE;
const TOTAL_WIDTH = SUPPLY_WIDTH + BOARD_WIDTH;

// Breadboard starts after the supply area
const BOARD_X = SUPPLY_WIDTH;

// Power rail rows (relative to board area)
const POWER_RAIL_TOP = 1;
const GROUND_RAIL_TOP = 2;
const POWER_RAIL_BOTTOM = BOARD_ROWS - 2;
const GROUND_RAIL_BOTTOM = BOARD_ROWS - 1;


interface BreadboardProps {
  components: PlacedComponent[];
  wires: Wire[];
  simRunning: boolean;
  onDropComponent: (type: string, position: Point) => void;
  onMoveComponent: (id: string, position: Point) => void;
  onStartWire: (componentId: string, pinId: string) => void;
  onEndWire: (componentId: string, pinId: string) => void;
  wiringFrom: { componentId: string; pinId: string } | null;
  onSelectComponent: (id: string | null) => void;
  selectedComponentId: string | null;
  onSelectWire: (id: string | null) => void;
  selectedWireId: string | null;
  onToggleSwitch: (id: string) => void;
}

function snapToGrid(x: number, y: number): Point {
  return {
    x: Math.round(x / GRID_SIZE) * GRID_SIZE,
    y: Math.round(y / GRID_SIZE) * GRID_SIZE,
  };
}

function getPinPosition(comp: PlacedComponent, pinId: string): Point | null {
  const def = COMPONENT_DEFINITIONS[comp.type];
  if (!def) return null;
  const pin = def.pins.find((p) => p.id === pinId);
  if (!pin) return null;

  const w = def.width * GRID_SIZE;
  const h = def.height * GRID_SIZE;

  let px = 0, py = 0;
  switch (pin.side) {
    case 'left':   px = 0;  py = h * pin.offset; break;
    case 'right':  px = w;  py = h * pin.offset; break;
    case 'top':    px = w * pin.offset; py = 0;  break;
    case 'bottom': px = w * pin.offset; py = h;  break;
  }

  return { x: comp.position.x + px, y: comp.position.y + py };
}

interface Rect {
  x: number; y: number; w: number; h: number;
}

function getComponentRect(comp: PlacedComponent): Rect {
  const def = COMPONENT_DEFINITIONS[comp.type];
  if (!def) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: comp.position.x,
    y: comp.position.y,
    w: def.width * GRID_SIZE,
    h: def.height * GRID_SIZE,
  };
}

function getPinSide(comp: PlacedComponent, pinId: string): 'left' | 'right' | 'top' | 'bottom' {
  const def = COMPONENT_DEFINITIONS[comp.type];
  const pin = def?.pins.find((p) => p.id === pinId);
  return pin?.side ?? 'right';
}

/**
 * Checks if a horizontal or vertical segment intersects a rect (with margin).
 */
function segHitsRect(ax: number, ay: number, bx: number, by: number, r: Rect, m: number): boolean {
  const rx = r.x - m, ry = r.y - m, rr = r.x + r.w + m, rb = r.y + r.h + m;
  if (ax === bx) {
    // vertical
    const minY = Math.min(ay, by), maxY = Math.max(ay, by);
    return ax > rx && ax < rr && maxY > ry && minY < rb;
  }
  // horizontal
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx);
  return ay > ry && ay < rb && maxX > rx && minX < rr;
}

/**
 * Simple orthogonal wire router.
 * 1. Exits each pin perpendicular for one grid step (stub).
 * 2. Tries L-shape, Z-shapes, and U-shapes between stub tips.
 * 3. Tests each candidate against component rects.
 * 4. Picks the first clear path (shortest/simplest first).
 */
function routeWire(
  from: Point,
  to: Point,
  components: PlacedComponent[],
  fromCompId: string,
  fromPinId: string,
  toCompId: string,
  toPinId: string,
  existingSegments?: { ax: number; ay: number; bx: number; by: number }[],
): Point[] {
  const margin = 2; // tiny margin so wires don't touch component edges

  // Obstacle rects (ALL components)
  const obstacles = components.map(getComponentRect);

  // Compute stubs
  const fromComp = components.find((c) => c.id === fromCompId)!;
  const toComp = components.find((c) => c.id === toCompId)!;
  const fromSide = getPinSide(fromComp, fromPinId);
  const toSide = getPinSide(toComp, toPinId);

  function stubDir(side: 'left' | 'right' | 'top' | 'bottom'): Point {
    switch (side) {
      case 'left':   return { x: -GRID_SIZE, y: 0 };
      case 'right':  return { x: GRID_SIZE,  y: 0 };
      case 'top':    return { x: 0, y: -GRID_SIZE };
      case 'bottom': return { x: 0, y: GRID_SIZE };
    }
  }

  const fd = stubDir(fromSide);
  const td = stubDir(toSide);
  const a: Point = { x: from.x + fd.x, y: from.y + fd.y }; // stub tip from
  const b: Point = { x: to.x + td.x,   y: to.y + td.y };   // stub tip to

  const priorSegs = existingSegments || [];

  // Check if two axis-aligned segments overlap (run parallel on the same line)
  function segsOverlap(ax1: number, ay1: number, ax2: number, ay2: number,
                       bx1: number, by1: number, bx2: number, by2: number): boolean {
    // Both horizontal on same Y
    if (ay1 === ay2 && by1 === by2 && ay1 === by1) {
      const aMin = Math.min(ax1, ax2), aMax = Math.max(ax1, ax2);
      const bMin = Math.min(bx1, bx2), bMax = Math.max(bx1, bx2);
      return aMax > bMin && bMax > aMin; // ranges overlap
    }
    // Both vertical on same X
    if (ax1 === ax2 && bx1 === bx2 && ax1 === bx1) {
      const aMin = Math.min(ay1, ay2), aMax = Math.max(ay1, ay2);
      const bMin = Math.min(by1, by2), bMax = Math.max(by1, by2);
      return aMax > bMin && bMax > aMin;
    }
    return false;
  }

  // Test if a path is clear of component obstacles and doesn't overlap existing wires.
  function pathClear(pts: Point[]): boolean {
    for (let i = 0; i < pts.length - 1; i++) {
      const px = pts[i].x, py = pts[i].y, qx = pts[i + 1].x, qy = pts[i + 1].y;
      // Check component obstacles
      for (let j = 0; j < obstacles.length; j++) {
        if (i === 0 && components[j].id === fromCompId) continue;
        if (i === pts.length - 2 && components[j].id === toCompId) continue;
        if (segHitsRect(px, py, qx, qy, obstacles[j], margin)) {
          return false;
        }
      }
      // Check existing wire overlap (parallel segments on same line)
      for (const seg of priorSegs) {
        if (segsOverlap(px, py, qx, qy, seg.ax, seg.ay, seg.bx, seg.by)) {
          return false;
        }
      }
    }
    return true;
  }

  // Generate candidate routes between stub tips a and b.
  // Each candidate is the MIDDLE portion; we prepend from→a and append b→to.
  const candidates: Point[][] = [];

  // L-shapes (2 segments between stubs)
  candidates.push([a, { x: b.x, y: a.y }, b]);
  candidates.push([a, { x: a.x, y: b.y }, b]);

  // Z-shapes (3 segments) at various midpoints
  const midXs = [
    (a.x + b.x) / 2,
    a.x - GRID_SIZE, a.x + GRID_SIZE,
    b.x - GRID_SIZE, b.x + GRID_SIZE,
  ];
  const midYs = [
    (a.y + b.y) / 2,
    a.y - GRID_SIZE, a.y + GRID_SIZE,
    b.y - GRID_SIZE, b.y + GRID_SIZE,
  ];
  for (const mx of midXs) {
    candidates.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
  }
  for (const my of midYs) {
    candidates.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
  }

  // U-shapes going wide
  const offsets = [GRID_SIZE * 2, GRID_SIZE * 3, -GRID_SIZE * 2, -GRID_SIZE * 3];
  for (const off of offsets) {
    const my = Math.min(a.y, b.y) + off;
    candidates.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
    const mx = Math.min(a.x, b.x) + off;
    candidates.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
  }

  // Test each candidate with stubs attached
  for (const mid of candidates) {
    const full = [from, ...mid, to];
    if (pathClear(full)) return full;
  }

  // Fallback: L through stubs (may overlap but always works)
  return [from, a, { x: a.x, y: b.y }, b, to];
}

const CORNER_RADIUS = 8;

/** Remove collinear and duplicate points before rendering. */
function cleanPoints(pts: Point[]): Point[] {
  if (pts.length <= 2) return pts;
  const result: Point[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = pts[i];
    const next = pts[i + 1];
    // Skip duplicates
    if (curr.x === prev.x && curr.y === prev.y) continue;
    // Skip collinear (all same X or all same Y)
    if ((prev.x === curr.x && curr.x === next.x) ||
        (prev.y === curr.y && curr.y === next.y)) continue;
    result.push(curr);
  }
  const last = pts[pts.length - 1];
  const prevLast = result[result.length - 1];
  if (last.x !== prevLast.x || last.y !== prevLast.y) {
    result.push(last);
  }
  return result;
}

function pointsToPathD(rawPoints: Point[]): string {
  const points = cleanPoints(rawPoints);
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;

  let d = `M ${points[0].x} ${points[0].y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

    // Clamp radius to half the shortest segment
    const r = Math.min(CORNER_RADIUS, len1 / 2, len2 / 2);

    if (r < 1) {
      d += ` L ${curr.x} ${curr.y}`;
      continue;
    }

    const startX = curr.x - (dx1 / len1) * r;
    const startY = curr.y - (dy1 / len1) * r;
    const endX = curr.x + (dx2 / len2) * r;
    const endY = curr.y + (dy2 / len2) * r;

    const cross = dx1 * dy2 - dy1 * dx2;
    const sweep = cross > 0 ? 1 : 0;

    d += ` L ${startX} ${startY}`;
    d += ` A ${r} ${r} 0 0 ${sweep} ${endX} ${endY}`;
  }

  d += ` L ${points[points.length - 1].x} ${points[points.length - 1].y}`;
  return d;
}

export default function Breadboard({
  components,
  wires,
  simRunning,
  onDropComponent,
  onMoveComponent,
  onStartWire,
  onEndWire,
  wiringFrom,
  onSelectComponent,
  selectedComponentId,
  onSelectWire,
  selectedWireId,
  onToggleSwitch,
}: BreadboardProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);

  // Pre-compute routed wire paths; each wire avoids overlapping prior wires
  const routedWires = useMemo(() => {
    const allSegments: { ax: number; ay: number; bx: number; by: number }[] = [];
    const results: { wire: Wire; path: string }[] = [];

    for (const wire of wires) {
      const fromComp = components.find((c) => c.id === wire.from.componentId);
      const toComp = components.find((c) => c.id === wire.to.componentId);
      if (!fromComp || !toComp) continue;
      const fromPos = getPinPosition(fromComp, wire.from.pinId);
      const toPos = getPinPosition(toComp, wire.to.pinId);
      if (!fromPos || !toPos) continue;

      const points = routeWire(fromPos, toPos, components,
        wire.from.componentId, wire.from.pinId,
        wire.to.componentId, wire.to.pinId,
        allSegments);

      // Record this wire's segments for subsequent wires to avoid
      const clean = cleanPoints(points);
      for (let i = 0; i < clean.length - 1; i++) {
        allSegments.push({ ax: clean[i].x, ay: clean[i].y, bx: clean[i + 1].x, by: clean[i + 1].y });
      }

      results.push({ wire, path: pointsToPathD(points) });
    }

    return results;
  }, [wires, components]);

  // Compute preview wire path while wiring
  const previewPath = useMemo(() => {
    if (!wiringFrom || !mousePos) return null;
    const fromComp = components.find((c) => c.id === wiringFrom.componentId);
    if (!fromComp) return null;
    const fromPos = getPinPosition(fromComp, wiringFrom.pinId);
    if (!fromPos) return null;
    // Simple L-route to cursor
    const midX = mousePos.x;
    const points: Point[] = [fromPos, { x: midX, y: fromPos.y }, { x: midX, y: mousePos.y }, mousePos];
    return pointsToPathD(points);
  }, [wiringFrom, mousePos, components]);

  const getSVGCoords = useCallback((e: React.MouseEvent): Point => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const scaleX = TOTAL_WIDTH / rect.width;
    const scaleY = BOARD_HEIGHT / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('componentType');
      if (!type) return;
      const svg = svgRef.current!;
      const rect = svg.getBoundingClientRect();
      const scaleX = TOTAL_WIDTH / rect.width;
      const scaleY = BOARD_HEIGHT / rect.height;
      const pos = snapToGrid(
        (e.clientX - rect.left) * scaleX,
        (e.clientY - rect.top) * scaleY,
      );
      onDropComponent(type, pos);
    },
    [onDropComponent]
  );

  const handleComponentMouseDown = useCallback(
    (e: React.MouseEvent, compId: string) => {
      // Don't select/drag if we're wiring
      if (wiringFrom) return;
      onSelectComponent(compId);
      onSelectWire(null);
      const coords = getSVGCoords(e);
      const comp = components.find((c) => c.id === compId);
      if (comp) {
        dragRef.current = {
          id: compId,
          offsetX: coords.x - comp.position.x,
          offsetY: coords.y - comp.position.y,
        };
      }
    },
    [components, getSVGCoords, onSelectComponent, onSelectWire, wiringFrom]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const coords = getSVGCoords(e);
      if (wiringFrom) {
        setMousePos(coords);
      }
      if (dragRef.current) {
        const pos = snapToGrid(coords.x - dragRef.current.offsetX, coords.y - dragRef.current.offsetY);
        onMoveComponent(dragRef.current.id, pos);
      }
    },
    [getSVGCoords, onMoveComponent, wiringFrom]
  );

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handlePinMouseDown = useCallback(
    (componentId: string, pinId: string) => {
      if (!wiringFrom) {
        onStartWire(componentId, pinId);
      } else {
        if (wiringFrom.componentId !== componentId || wiringFrom.pinId !== pinId) {
          onEndWire(componentId, pinId);
          setMousePos(null);
        }
      }
    },
    [wiringFrom, onStartWire, onEndWire]
  );

  const handleWireClick = useCallback(
    (e: React.MouseEvent, wireId: string) => {
      e.stopPropagation();
      if (wiringFrom) return;
      onSelectWire(wireId);
      onSelectComponent(null);
    },
    [onSelectWire, onSelectComponent, wiringFrom]
  );

  const handleBoardMouseDown = useCallback((e: React.MouseEvent) => {
    const isBackground = e.target === svgRef.current ||
      ((e.target as SVGElement).tagName === 'rect' && !(e.target as SVGElement).closest('.component'));
    if (!isBackground) return;

    if (wiringFrom) {
      onStartWire('', '');
      setMousePos(null);
      return;
    }

    onSelectComponent(null);
    onSelectWire(null);
  }, [onSelectComponent, onSelectWire, wiringFrom, onStartWire]);

  return (
    <svg
      ref={svgRef}
      className="breadboard-svg"
      viewBox={`0 0 ${TOTAL_WIDTH} ${BOARD_HEIGHT}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseDown={handleBoardMouseDown}
    >
      {/* Supply area background */}
      <rect x={0} y={0} width={SUPPLY_WIDTH} height={BOARD_HEIGHT} fill="#0b1120" rx={8} />
      <text x={SUPPLY_WIDTH / 2} y={20} textAnchor="middle" fill="#475569" fontSize={10} fontWeight="600">POWER</text>

      {/* Breadboard background */}
      <rect x={BOARD_X} y={0} width={BOARD_WIDTH} height={BOARD_HEIGHT} fill="#1e293b" rx={8} />

      {/* Grid dots on breadboard */}
      {Array.from({ length: BOARD_COLS }).map((_, col) =>
        Array.from({ length: BOARD_ROWS }).map((_, row) => (
          <circle
            key={`${col}-${row}`}
            cx={BOARD_X + col * GRID_SIZE + GRID_SIZE / 2}
            cy={row * GRID_SIZE + GRID_SIZE / 2}
            r={1.5}
            fill="#334155"
          />
        ))
      )}

      {/* Power rails on breadboard */}
      {[POWER_RAIL_TOP, POWER_RAIL_BOTTOM].map((row) => (
        <line
          key={`pwr-${row}`}
          x1={BOARD_X + GRID_SIZE}
          y1={row * GRID_SIZE + GRID_SIZE / 2}
          x2={BOARD_X + BOARD_WIDTH - GRID_SIZE}
          y2={row * GRID_SIZE + GRID_SIZE / 2}
          stroke="#ef4444"
          strokeWidth={2}
          strokeDasharray="4 4"
          opacity={0.4}
        />
      ))}
      {[GROUND_RAIL_TOP, GROUND_RAIL_BOTTOM].map((row) => (
        <line
          key={`gnd-${row}`}
          x1={BOARD_X + GRID_SIZE}
          y1={row * GRID_SIZE + GRID_SIZE / 2}
          x2={BOARD_X + BOARD_WIDTH - GRID_SIZE}
          y2={row * GRID_SIZE + GRID_SIZE / 2}
          stroke="#3b82f6"
          strokeWidth={2}
          strokeDasharray="4 4"
          opacity={0.4}
        />
      ))}

      {/* Rail labels */}
      <text x={BOARD_X + 4} y={POWER_RAIL_TOP * GRID_SIZE + GRID_SIZE / 2 + 4} fill="#ef4444" fontSize={10} fontWeight="bold">+</text>
      <text x={BOARD_X + 4} y={GROUND_RAIL_TOP * GRID_SIZE + GRID_SIZE / 2 + 4} fill="#3b82f6" fontSize={10} fontWeight="bold">-</text>
      <text x={BOARD_X + 4} y={POWER_RAIL_BOTTOM * GRID_SIZE + GRID_SIZE / 2 + 4} fill="#ef4444" fontSize={10} fontWeight="bold">+</text>
      <text x={BOARD_X + 4} y={GROUND_RAIL_BOTTOM * GRID_SIZE + GRID_SIZE / 2 + 4} fill="#3b82f6" fontSize={10} fontWeight="bold">-</text>

      {/* Wires — routed orthogonally */}
      {routedWires.map(({ wire, path }) => (
        <g key={wire.id}>
          {/* Invisible fat hitbox for easier clicking */}
          <path
            d={path}
            stroke="transparent"
            strokeWidth={12}
            fill="none"
            onMouseDown={(e) => handleWireClick(e, wire.id)}
            className="wire-hitbox"
          />
          <path
            d={path}
            stroke={selectedWireId === wire.id ? '#38bdf8' : wire.color}
            strokeWidth={selectedWireId === wire.id ? 3.5 : 2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            className="wire"
            pointerEvents="none"
          />
        </g>
      ))}

      {/* Wire preview while drawing */}
      {previewPath && (
        <path
          d={previewPath}
          stroke="#38bdf8"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="6 3"
          fill="none"
          opacity={0.7}
          pointerEvents="none"
        />
      )}

      {/* Components */}
      {components.map((comp) => {
        const def = COMPONENT_DEFINITIONS[comp.type];
        if (!def) return null;
        const w = def.width * GRID_SIZE;
        const h = def.height * GRID_SIZE;
        const isSelected = comp.id === selectedComponentId;
        const isLedOn = comp.type === 'led' && comp.state?.on;
        const isSwitchClosed = comp.type === 'switch' && comp.state?.closed;
        const isTimerHigh = comp.type === 'timer' && comp.state?.outputHigh;

        return (
          <g
            key={comp.id}
            transform={`translate(${comp.position.x}, ${comp.position.y})`}
            className={`component ${comp.type === 'switch' ? 'clickable' : ''}`}
            onMouseDown={(e) => { if (!wiringFrom) e.stopPropagation(); handleComponentMouseDown(e, comp.id); }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (comp.type === 'switch') onToggleSwitch(comp.id);
            }}
          >
            {/* Selection highlight */}
            {isSelected && (
              <rect x={-3} y={-3} width={w + 6} height={h + 6} fill="none" stroke="#38bdf8" strokeWidth={2} rx={6} strokeDasharray="4 2" />
            )}

            {/* Component body */}
            {comp.type === 'led' ? (
              <>
                {/* LED as circle */}
                {isLedOn && (
                  <circle cx={w / 2} cy={h / 2} r={w / 2 + 8} fill={def.color} opacity={0.25} />
                )}
                <circle
                  cx={w / 2}
                  cy={h / 2}
                  r={w / 2 - 1}
                  fill={isLedOn ? def.color : def.color + '33'}
                  stroke={def.color}
                  strokeWidth={1.5}
                />
              </>
            ) : (
              <rect
                width={w}
                height={h}
                fill={isTimerHigh ? def.color + '88' : isSwitchClosed ? def.color + '66' : def.color + '33'}
                stroke={isSwitchClosed ? '#4ade80' : def.color}
                strokeWidth={1.5}
                rx={4}
              />
            )}

            {/* Switch state indicator */}
            {comp.type === 'switch' && (
              <line
                x1={4} y1={h / 2}
                x2={w - 4} y2={isSwitchClosed ? h / 2 : h / 2 - 8}
                stroke={isSwitchClosed ? '#4ade80' : '#94a3b8'}
                strokeWidth={2}
                strokeLinecap="round"
              />
            )}

            {/* Waveform icon on power supply */}
            {comp.type === 'power' && (
              <path
                d={comp.properties.waveform === 'sine'
                  ? `M ${4} ${h - 10} Q ${10} ${h - 22} ${16} ${h - 10} Q ${22} ${h + 2} ${28} ${h - 10} Q ${34} ${h - 22} ${40} ${h - 10}`
                  : `M ${4} ${h - 6} h 6 v -8 h 6 v 8 h 6 v -8 h 6 v 8 h 6`
                }
                stroke="#4ade80"
                strokeWidth={1.5}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.5}
                pointerEvents="none"
              />
            )}

            {/* DIP chip rendering for 555 Timer */}
            {comp.type === 'timer' && (
              <>
                {/* Pin 1 notch */}
                <circle cx={w / 2} cy={h} r={4} fill="#0f172a" stroke="#f472b6" strokeWidth={1} opacity={0.6} />
                {/* Internal pin labels — left side (1-4, bottom to top) */}
                <text x={6} y={h * 0.875 + 3} fill="#e2e8f0" fontSize={7} fontWeight="500" pointerEvents="none">1 GND</text>
                <text x={6} y={h * 0.625 + 3} fill="#e2e8f0" fontSize={7} fontWeight="500" pointerEvents="none">2 TRIG</text>
                <text x={6} y={h * 0.375 + 3} fill="#e2e8f0" fontSize={7} fontWeight="500" pointerEvents="none">3 OUT</text>
                <text x={6} y={h * 0.125 + 3} fill="#e2e8f0" fontSize={7} fontWeight="500" pointerEvents="none">4 RST</text>
                {/* Internal pin labels — right side (5-8, bottom to top) */}
                <text x={w - 6} y={h * 0.875 + 3} fill="#e2e8f0" fontSize={7} fontWeight="500" textAnchor="end" pointerEvents="none">CTRL 5</text>
                <text x={w - 6} y={h * 0.625 + 3} fill="#e2e8f0" fontSize={7} fontWeight="500" textAnchor="end" pointerEvents="none">THR 6</text>
                <text x={w - 6} y={h * 0.375 + 3} fill="#e2e8f0" fontSize={7} fontWeight="500" textAnchor="end" pointerEvents="none">DIS 7</text>
                <text x={w - 6} y={h * 0.125 + 3} fill="#e2e8f0" fontSize={7} fontWeight="500" textAnchor="end" pointerEvents="none">VCC 8</text>
                {/* Output indicator LED */}
                <circle cx={w / 2} cy={8} r={3} fill={isTimerHigh ? '#4ade80' : '#334155'} />
              </>
            )}

            {/* Label (skip for LED — too small) */}
            {comp.type !== 'led' && (
              <text
                x={w / 2}
                y={comp.type === 'power' ? h / 2 - 2 : h / 2 + 4}
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize={11}
                fontWeight="500"
                pointerEvents="none"
              >
                {comp.type === 'power' ? `${comp.properties.mode || 'DC'}` : def.label}
              </text>
            )}

            {/* Voltage display on power supply */}
            {comp.type === 'power' && (
              <text
                x={w / 2}
                y={h / 2 + 12}
                textAnchor="middle"
                fill="#4ade80"
                fontSize={12}
                fontWeight="700"
                pointerEvents="none"
              >
                {comp.properties.voltage}V
              </text>
            )}

            {/* Pins */}
            {def.pins.map((pin) => {
              let px = 0, py = 0;
              switch (pin.side) {
                case 'left':   px = 0;  py = h * pin.offset; break;
                case 'right':  px = w;  py = h * pin.offset; break;
                case 'top':    px = w * pin.offset; py = 0;  break;
                case 'bottom': px = w * pin.offset; py = h;  break;
              }
              // Position label inside the component, next to the pin
              const inset = 8;
              let lx = px, ly = py;
              let anchor: 'start' | 'middle' | 'end' = 'middle';
              switch (pin.side) {
                case 'left':   lx = px + inset; anchor = 'start'; break;
                case 'right':  lx = px - inset; anchor = 'end'; break;
                case 'top':    ly = py + inset + 3; break;
                case 'bottom': ly = py - inset; break;
              }

              return (
                <g key={pin.id}>
                  <circle
                    cx={px}
                    cy={py}
                    r={4}
                    fill={pin.type === 'power' ? '#4ade80' : pin.type === 'ground' ? '#3b82f6' : '#94a3b8'}
                    stroke="#0f172a"
                    strokeWidth={1.5}
                    className="pin-target"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      handlePinMouseDown(comp.id, pin.id);
                    }}
                  />
                  {comp.type !== 'timer' && (
                    <text
                      x={lx}
                      y={ly + 3}
                      textAnchor={anchor}
                      fill="#94a3b8"
                      fontSize={7}
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
    </svg>
  );
}
