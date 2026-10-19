import { useRef, useCallback, useMemo, useState, useEffect } from 'react';
import { PlacedComponent, Wire, Point } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';
import { formatValue, formatVoltage, formatCurrent } from '../utils/format';
import { shortcutsBlocked } from './modalStack';
import { resistorBands, getWarning, ledBrightness as ledBrightnessOf } from './partVisuals';
import {
  GRID_W, GRID_H, TOTAL_ROWS, BOARD_TOTAL_COLS,
  BOARD_PIXEL_WIDTH, BOARD_PIXEL_HEIGHT,
  SUPPLY_WIDTH, TOTAL_PIXEL_WIDTH, BOARD_X_OFFSET,
  COMP_COLS, RAIL_GROUP_SIZE,
  NUM_BOARDS, SINGLE_BOARD_COLS,
  boardColumns, boardColOffset,
  REL_COL_GAP,
  gridToPixel, pixelToGrid, isGapColumn, isValidPinHole,
  buildPinGroups, buildPinLookup,
} from '../data/breadboard';

const SELECTED_WIRE_COLOR = '#00ffff';
const CHIP_PIN_LABEL_COLOR = '#c0c0c0';
const CHIP_PIN_LABEL_FONT_FAMILY = 'monospace';
const CHIP_PIN_LABEL_INSET = 8;

interface BreadboardProps {
  components: PlacedComponent[];
  wires: Wire[];
  simRunning: boolean;
  onDropComponent: (type: string, position: Point) => void;
  onMoveComponent: (id: string, position: Point) => void;
  onMoveSelection: (moves: { id: string; position: Point }[]) => void;
  /** Drag finished. `moves` are the final positions (null: nothing to commit). */
  onMoveEnd: (moves: { id: string; position: Point }[] | null) => void;
  onStartWire: (componentId: string, pinId: string) => void;
  onEndWire: (componentId: string, pinId: string) => void;
  wiringFrom: { componentId: string; pinId: string } | null;
  onSelectComponent: (id: string | null, additive?: boolean) => void;
  selectedComponentIds: string[];
  onSelectWire: (id: string | null) => void;
  selectedWireId: string | null;
  onToggleSwitch: (id: string) => void;
  onSetSwitchClosed: (id: string, closed: boolean) => void;
  wireCurrents: Map<string, number>;
  pinHoleVoltages: Map<string, number>;
  onContextMenu?: (e: React.MouseEvent, componentId?: string, wireId?: string) => void;
  /** Change this number to zoom to fit the circuit (after a load). */
  fitRequest?: number;
}

/**
 * Snap a component position so its pins align with breadboard pin hole centers.
 *
 * Pin hole centers are at: x = BOARD_X_OFFSET + col*GRID_W + GRID_W/2
 *                          y = row*GRID_H + GRID_H/2
 *
 * Component pins use fractional offsets (e.g. 0.5 on a 1-wide = GRID_W/2).
 * Snapping the component top-left to grid boundaries ensures pins land on centers:
 *   comp at (BOARD_X_OFFSET + col*GRID_W, row*GRID_H)
 *   pin at offset 0.5 on 1-wide: x = comp_x + GRID_W/2 = pin hole center ✓
 *   left pin at offset 0: x = comp_x = BOARD_X_OFFSET + col*GRID_W (NOT a center)
 *
 * For left/right side pins (offset 0 or width), the component x must be at a
 * pin hole center. For top/bottom pins (offset 0.5), comp x must be at a grid boundary.
 *
 * Solution: snap to grid boundaries. Components with left/right edge pins
 * should use half-grid offsets in their definitions.
 */
/**
 * Snap a component so its first pin lands on a breadboard pin hole center.
 * Pin hole centers: x = BOARD_X_OFFSET + col*GRID_W + GRID_W/2, y = row*GRID_H + GRID_H/2
 */
function snapComponentToGrid(x: number, y: number, compType: string, rotation: number): Point {
  const def = COMPONENT_DEFINITIONS[compType];
  if (!def || def.pins.length === 0) {
    // Fallback: snap to grid boundaries
    const col = Math.round((x - BOARD_X_OFFSET) / GRID_W);
    const row = Math.round(y / GRID_H);
    return { x: BOARD_X_OFFSET + col * GRID_W, y: row * GRID_H };
  }

  // Get the first pin's offset within the component
  const pin = def.pins[0];
  const { w, h } = getRenderedSize(def, rotation);
  const side = rotatedSide(pin.side, rotation);
  let pinOffX = 0, pinOffY = 0;
  switch (side) {
    case 'left':   pinOffX = 0;              pinOffY = h * pin.offset; break;
    case 'right':  pinOffX = w;              pinOffY = h * pin.offset; break;
    case 'top':    pinOffX = w * pin.offset; pinOffY = 0;              break;
    case 'bottom': pinOffX = w * pin.offset; pinOffY = h;              break;
  }

  // Where should this pin land? Nearest pin hole center.
  const pinAbsX = x + pinOffX;
  const pinAbsY = y + pinOffY;
  const col = Math.round((pinAbsX - BOARD_X_OFFSET - GRID_W / 2) / GRID_W);
  const row = Math.round((pinAbsY - GRID_H / 2) / GRID_H);
  const holeX = BOARD_X_OFFSET + col * GRID_W + GRID_W / 2;
  const holeY = row * GRID_H + GRID_H / 2;

  // Component position = hole position minus pin offset
  return { x: holeX - pinOffX, y: holeY - pinOffY };
}

/**
 * Check if a component at the given position has all its pins on valid breadboard holes.
 * Power components are exempt (they live in the supply area).
 */
function isValidPlacement(compType: string, position: Point, rotation: number): boolean {
  const def = COMPONENT_DEFINITIONS[compType];
  if (!def) return true;
  // Power components live off-board in the supply area
  if (compType === 'power') return true;

  for (const pin of def.pins) {
    const { w, h } = getRenderedSizeRaw(def, rotation);
    const side = rotatedSide(pin.side, rotation);
    let px = 0, py = 0;
    switch (side) {
      case 'left':   px = 0;  py = h * pin.offset; break;
      case 'right':  px = w;  py = h * pin.offset; break;
      case 'top':    px = w * pin.offset; py = 0;  break;
      case 'bottom': px = w * pin.offset; py = h;  break;
    }
    const absPx = position.x + px;
    const absPy = position.y + py;
    const grid = pixelToGrid(absPx, absPy);
    if (!isValidPinHole(grid.col, grid.row)) return false;
  }
  return true;
}

/** Raw rendered size helper (used before getRenderedSize is defined to avoid hoisting). */
function getRenderedSizeRaw(def: { width: number; height: number }, rotation: number): { w: number; h: number } {
  const isRotated = rotation === 90 || rotation === 270;
  return {
    w: (isRotated ? def.height : def.width) * GRID_W,
    h: (isRotated ? def.width : def.height) * GRID_H,
  };
}

/**
 * Get the rendered width and height of a component, accounting for rotation.
 * 90/270 degree rotation swaps width and height.
 */
function getRenderedSize(def: { width: number; height: number }, rotation: number): { w: number; h: number } {
  const isRotated = rotation === 90 || rotation === 270;
  return {
    w: (isRotated ? def.height : def.width) * GRID_W,
    h: (isRotated ? def.width : def.height) * GRID_H,
  };
}

/**
 * Map a pin's side based on component rotation.
 */
function rotatedSide(side: 'left' | 'right' | 'top' | 'bottom', rotation: number): 'left' | 'right' | 'top' | 'bottom' {
  const sides: ('top' | 'right' | 'bottom' | 'left')[] = ['top', 'right', 'bottom', 'left'];
  const idx = sides.indexOf(side);
  const steps = Math.round(rotation / 90) % 4;
  return sides[(idx + steps) % 4];
}

export function getPinPosition(comp: PlacedComponent, pinId: string): Point | null {
  const def = COMPONENT_DEFINITIONS[comp.type];
  if (!def) return null;
  const pin = def.pins.find((p) => p.id === pinId);
  if (!pin) return null;

  const { w, h } = getRenderedSize(def, comp.rotation);
  const side = rotatedSide(pin.side, comp.rotation);

  let px = 0, py = 0;
  switch (side) {
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
  const { w, h } = getRenderedSize(def, comp.rotation);
  return { x: comp.position.x, y: comp.position.y, w, h };
}

function componentsOverlap(a: PlacedComponent, b: PlacedComponent): boolean {
  const defA = COMPONENT_DEFINITIONS[a.type];
  const defB = COMPONENT_DEFINITIONS[b.type];
  if (!defA || !defB) return false;
  const isRotA = a.rotation === 90 || a.rotation === 270;
  const isRotB = b.rotation === 90 || b.rotation === 270;
  const aw = (isRotA ? defA.height : defA.width) * GRID_W;
  const ah = (isRotA ? defA.width : defA.height) * GRID_H;
  const bw = (isRotB ? defB.height : defB.width) * GRID_W;
  const bh = (isRotB ? defB.width : defB.height) * GRID_H;
  const margin = 2;
  return (
    a.position.x + margin < b.position.x + bw &&
    a.position.x + aw > b.position.x + margin &&
    a.position.y + margin < b.position.y + bh &&
    a.position.y + ah > b.position.y + margin
  );
}

function getPinSide(comp: PlacedComponent, pinId: string): 'left' | 'right' | 'top' | 'bottom' {
  const def = COMPONENT_DEFINITIONS[comp.type];
  const pin = def?.pins.find((p) => p.id === pinId);
  return rotatedSide(pin?.side ?? 'right', comp.rotation);
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

  // Compute stubs — board pin holes don't need stubs (no component body to escape)
  const fromComp = components.find((c) => c.id === fromCompId);
  const toComp = components.find((c) => c.id === toCompId);

  function stubDir(side: 'left' | 'right' | 'top' | 'bottom'): Point {
    switch (side) {
      case 'left':   return { x: -GRID_W, y: 0 };
      case 'right':  return { x: GRID_W,  y: 0 };
      case 'top':    return { x: 0, y: -GRID_H };
      case 'bottom': return { x: 0, y: GRID_H };
    }
  }

  let a: Point, b: Point;
  if (fromComp) {
    const fd = stubDir(getPinSide(fromComp, fromPinId));
    a = { x: from.x + fd.x, y: from.y + fd.y };
  } else {
    a = from; // board pin — no stub needed
  }
  if (toComp) {
    const td = stubDir(getPinSide(toComp, toPinId));
    b = { x: to.x + td.x, y: to.y + td.y };
  } else {
    b = to; // board pin — no stub needed
  }

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

  // Direct horizontal / vertical route if possible.
  if (a.x === b.x || a.y === b.y) {
    candidates.push([a, b]);
  }

  // L-shapes (2 segments between stubs)
  candidates.push([a, { x: b.x, y: a.y }, b]);
  candidates.push([a, { x: a.x, y: b.y }, b]);

  // Z-shapes (3 segments) at nearby offsets.
  const safeXs = Array.from(new Set([
    a.x, b.x,
    (a.x + b.x) / 2,
    a.x - GRID_W, a.x + GRID_W,
    b.x - GRID_W, b.x + GRID_W,
  ]));
  const safeYs = Array.from(new Set([
    a.y, b.y,
    (a.y + b.y) / 2,
    a.y - GRID_H, a.y + GRID_H,
    b.y - GRID_H, b.y + GRID_H,
  ]));

  for (const mx of safeXs) {
    candidates.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
  }
  for (const my of safeYs) {
    candidates.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
  }

  // U-shapes going wider with increasing offsets.
  for (let offset = 2; offset <= 6; offset++) {
    for (const sign of [1, -1]) {
      const mx = Math.min(a.x, b.x) + sign * GRID_W * offset;
      const my = Math.min(a.y, b.y) + sign * GRID_H * offset;
      candidates.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
      candidates.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
    }
  }

  function pathLength(pts: Point[]) {
    let length = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      length += Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y);
    }
    return length;
  }

  function scoreCandidate(mid: Point[]) {
    const full = [from, ...mid, to];
    return mid.length * 100 + pathLength(full);
  }

  const uniqueCandidates = candidates
    .map((mid) => ({ mid, score: scoreCandidate(mid) }))
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.mid);

  for (const mid of uniqueCandidates) {
    const full = [from, ...mid, to];
    if (pathClear(full)) return full;
  }

  // Second-pass fallback: try jog offsets on the L-shape to avoid existing parallel wires.
  for (let jog = 1; jog <= 5; jog++) {
    for (const sign of [1, -1]) {
      const jogX = a.x + sign * GRID_W * jog;
      const fb1 = [from, a, { x: jogX, y: a.y }, { x: jogX, y: b.y }, b, to];
      if (pathClear(fb1)) return fb1;
      const jogY = b.y + sign * GRID_H * jog;
      const fb2 = [from, a, { x: a.x, y: jogY }, { x: b.x, y: jogY }, b, to];
      if (pathClear(fb2)) return fb2;
    }
  }

  // Final fallback: L through stubs (may overlap but always produces a path)
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

/** Smallest and largest zoom, in screen pixels per board unit. */
const MIN_SCALE = 0.25;
const MAX_SCALE = 12;
/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 3;

type DragState =
  | {
      kind: 'parts';
      ids: string[];
      draggedId: string;
      offsetX: number;
      offsetY: number;
      type: string;
      rotation: number;
      originPositions: Record<string, Point>;
      startClient: Point;
      moved: boolean;
      /** Pressed a member of a multi-selection without Ctrl: a click (no drag) selects just this part. */
      collapseToId: string | null;
      lastMoves: { id: string; position: Point }[] | null;
    }
  | {
      kind: 'pan';
      startClient: Point;
      startPan: Point;
      moved: boolean;
      /** Released without moving: treat as a click on the background. */
      clickClears: boolean;
    };

/** Bounding box of the circuit (parts and the board holes wires use), in board units. */
function circuitBounds(components: PlacedComponent[], wires: Wire[]): Rect | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const c of components) {
    const r = getComponentRect(c);
    if (r.w === 0 && r.h === 0) continue;
    add(r.x, r.y);
    add(r.x + r.w, r.y + r.h);
  }
  for (const w of wires) {
    for (const ep of [w.from, w.to]) {
      if (ep.componentId !== 'board') continue;
      const [c, r] = ep.pinId.split(',').map(Number);
      if (Number.isFinite(c) && Number.isFinite(r)) {
        const p = gridToPixel(c, r);
        add(p.x, p.y);
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export default function Breadboard({
  components,
  wires,
  simRunning,
  onDropComponent,
  onMoveComponent,
  onMoveSelection,
  onMoveEnd,
  onStartWire,
  onEndWire,
  wiringFrom,
  onSelectComponent,
  selectedComponentIds,
  onSelectWire,
  selectedWireId,
  onToggleSwitch,
  onSetSwitchClosed,
  wireCurrents,
  pinHoleVoltages,
  onContextMenu,
  fitRequest = 0,
}: BreadboardProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const lastPointerId = useRef<number | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const [hoveredHole, setHoveredHole] = useState<string | null>(null); // "col,row"

  // Viewport: `scale` is screen pixels per board unit; `pan` is the board
  // point at the top-left corner. The viewBox matches the element's aspect
  // ratio, so there's no letterboxing and the whole canvas is used.
  const [viewSize, setViewSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const viewRef = useRef({ scale: 1, pan: { x: 0, y: 0 }, size: { w: 0, h: 0 } });
  viewRef.current = { scale, pan, size: viewSize };
  const componentsRef = useRef(components);
  componentsRef.current = components;
  const wiresRef = useRef(wires);
  wiresRef.current = wires;

  // Pin group data for hover highlighting
  const pinGroups = useMemo(() => buildPinGroups(), []);
  const pinLookup = useMemo(() => buildPinLookup(pinGroups), [pinGroups]);
  const pinGroupMap = useMemo(() => {
    const m = new Map<string, { col: number; row: number }[]>();
    for (const g of pinGroups) {
      m.set(g.id, g.pins);
    }
    return m;
  }, [pinGroups]);

  // Track the element's size.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const r = svg.getBoundingClientRect();
      setViewSize((prev) => (Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5 ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  const viewBox = useMemo(() => {
    const w = viewSize.w > 0 ? viewSize.w / scale : TOTAL_PIXEL_WIDTH;
    const h = viewSize.h > 0 ? viewSize.h / scale : BOARD_PIXEL_HEIGHT;
    return `${pan.x} ${pan.y} ${w} ${h}`;
  }, [scale, pan, viewSize]);

  /** Show a board rectangle as large as fits, centred. */
  const showRect = useCallback((r: Rect, maxScale = MAX_SCALE) => {
    const { w: cw, h: ch } = viewRef.current.size;
    if (cw <= 0 || ch <= 0) return;
    const s = Math.max(MIN_SCALE, Math.min(maxScale, cw / Math.max(r.w, 1), ch / Math.max(r.h, 1)));
    setScale(s);
    setPan({ x: r.x + r.w / 2 - cw / s / 2, y: r.y + r.h / 2 - ch / s / 2 });
  }, []);

  const fitBoard = useCallback(() => {
    showRect({ x: -6, y: -14, w: TOTAL_PIXEL_WIDTH + 12, h: BOARD_PIXEL_HEIGHT + 20 });
  }, [showRect]);

  /** Zoom to the circuit with a margin of two holes; the whole board when empty. */
  const fitCircuit = useCallback(() => {
    const b = circuitBounds(componentsRef.current, wiresRef.current);
    if (!b) { fitBoard(); return; }
    const mx = GRID_W * 2, my = GRID_H * 2;
    // Don't zoom in so far that a single part fills the screen.
    showRect({ x: b.x - mx, y: b.y - my, w: b.w + 2 * mx, h: b.h + 2 * my }, 5);
  }, [fitBoard, showRect]);

  /** Zoom by `factor` keeping the board point under (clientX, clientY) fixed. */
  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const { scale: s, pan: p, size } = viewRef.current;
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s * factor));
    if (next === s) return;
    const rect = svg.getBoundingClientRect();
    const sx = clientX === undefined ? size.w / 2 : clientX - rect.left;
    const sy = clientY === undefined ? size.h / 2 : clientY - rect.top;
    // Board point under the cursor: p + screen / s. Keep it under the cursor.
    const bx = p.x + sx / s;
    const by = p.y + sy / s;
    setScale(next);
    setPan({ x: bx - sx / next, y: by - sy / next });
  }, []);

  const setZoomCentered = useCallback((target: number) => {
    zoomAt(target / viewRef.current.scale);
  }, [zoomAt]);

  // Fit when asked (circuit loaded, demo, restore) and once the size is known.
  const fittedOnce = useRef(false);
  useEffect(() => {
    if (viewSize.w <= 0 || viewSize.h <= 0) return;
    fittedOnce.current = true;
    fitCircuit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest]);
  useEffect(() => {
    if (viewSize.w <= 0 || viewSize.h <= 0 || fittedOnce.current) return;
    fittedOnce.current = true;
    fitCircuit();
  }, [viewSize, fitCircuit]);

  // Resolve a wire endpoint to pixel coordinates
  function getEndpointPos(endpoint: { componentId: string; pinId: string }): Point | null {
    if (endpoint.componentId === 'board') {
      const [colStr, rowStr] = endpoint.pinId.split(',');
      const col = parseInt(colStr, 10);
      const row = parseInt(rowStr, 10);
      const { x, y } = gridToPixel(col, row);
      return { x, y };
    }
    const comp = components.find((c) => c.id === endpoint.componentId);
    if (!comp) return null;
    return getPinPosition(comp, endpoint.pinId);
  }

  // Pre-compute routed wire paths; each wire avoids overlapping prior wires
  const routedWires = useMemo(() => {
    const allSegments: { ax: number; ay: number; bx: number; by: number }[] = [];
    const results: { wire: Wire; path: string; points: Point[] }[] = [];

    for (const wire of wires) {
      const fromPos = getEndpointPos(wire.from);
      const toPos = getEndpointPos(wire.to);
      if (!fromPos || !toPos) continue;

      const points = routeWire(fromPos, toPos, components,
        wire.from.componentId, wire.from.pinId,
        wire.to.componentId, wire.to.pinId,
        allSegments);

      const clean = cleanPoints(points);
      for (let i = 0; i < clean.length - 1; i++) {
        allSegments.push({ ax: clean[i].x, ay: clean[i].y, bx: clean[i + 1].x, by: clean[i + 1].y });
      }

      results.push({ wire, path: pointsToPathD(points), points: cleanPoints(points) });
    }

    return results;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wires, components]);

  // Compute preview wire path while wiring
  const previewPath = useMemo(() => {
    if (!wiringFrom || !mousePos) return null;
    const fromPos = getEndpointPos(wiringFrom);
    if (!fromPos) return null;
    const points = routeWire(
      fromPos,
      mousePos,
      components,
      wiringFrom.componentId,
      wiringFrom.pinId,
      'board',
      'preview',
      []
    );
    return pointsToPathD(points);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wiringFrom, mousePos, components]);

  /**
   * Screen (client) coordinates to board coordinates. Uses the SVG's own
   * screen transform, so it is right whatever the viewBox, zoom or layout.
   */
  const clientToBoard = useCallback((clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: clientX, y: clientY };
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('componenttype')) e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('componentType');
      if (!type) return;
      const def = COMPONENT_DEFINITIONS[type];
      const p = clientToBoard(e.clientX, e.clientY);
      // Drop with the part centred on the cursor.
      const cx = def ? p.x - (def.width * GRID_W) / 2 : p.x;
      const cy = def ? p.y - (def.height * GRID_H) / 2 : p.y;
      // Power supplies live in the supply strip on the left.
      const pos = type === 'power'
        ? { x: 0, y: Math.max(0, Math.round(cy / GRID_H) * GRID_H) }
        : snapComponentToGrid(cx, cy, type, 0);
      if (!isValidPlacement(type, pos, 0)) return;
      onDropComponent(type, pos);
    },
    [onDropComponent, clientToBoard]
  );

  // ---- Dragging and panning: window-level listeners so a release outside
  // the board (or the window) always ends the gesture. ----

  const endDrag = useCallback((commit: boolean) => {
    const d = dragRef.current;
    dragRef.current = null;
    const svg = svgRef.current;
    if (svg && lastPointerId.current !== null) {
      try { if (svg.hasPointerCapture(lastPointerId.current)) svg.releasePointerCapture(lastPointerId.current); } catch { /* already released */ }
    }
    if (!d) return;
    if (d.kind === 'parts') {
      if (d.moved) {
        onMoveEnd(commit ? d.lastMoves : null);
      } else if (d.collapseToId) {
        onSelectComponent(d.collapseToId);
      }
    } else if (d.kind === 'pan' && !d.moved && d.clickClears) {
      onSelectComponent(null);
      onSelectWire(null);
    }
  }, [onMoveEnd, onSelectComponent, onSelectWire]);

  const handleWindowMove = useCallback((e: MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // The button was released somewhere we didn't hear about.
    if (e.buttons === 0) { endDrag(true); return; }
    const dist = Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y);
    if (!d.moved && dist < DRAG_THRESHOLD) return;
    d.moved = true;

    if (d.kind === 'pan') {
      const s = viewRef.current.scale;
      setPan({
        x: d.startPan.x - (e.clientX - d.startClient.x) / s,
        y: d.startPan.y - (e.clientY - d.startClient.y) / s,
      });
      return;
    }

    const coords = clientToBoard(e.clientX, e.clientY);
    const pos = snapComponentToGrid(coords.x - d.offsetX, coords.y - d.offsetY, d.type, d.rotation);
    if (!isValidPlacement(d.type, pos, d.rotation)) return;
    const baseOrigin = d.originPositions[d.draggedId];
    const delta = { x: pos.x - baseOrigin.x, y: pos.y - baseOrigin.y };
    const groupIds = new Set(d.ids);
    const moves = d.ids
      .filter((id) => d.originPositions[id])
      .map((id) => ({
        id,
        position: { x: d.originPositions[id].x + delta.x, y: d.originPositions[id].y + delta.y },
      }));
    const valid = moves.every(({ id, position }) => {
      const comp = componentsRef.current.find((c) => c.id === id);
      if (!comp) return false;
      if (!isValidPlacement(comp.type, position, comp.rotation)) return false;
      const candidate = { ...comp, position };
      return !componentsRef.current.some(
        (other) => !groupIds.has(other.id) && componentsOverlap(candidate, other)
      );
    });
    if (!valid) return;
    d.lastMoves = moves;
    if (moves.length === 1) onMoveComponent(moves[0].id, moves[0].position);
    else onMoveSelection(moves);
  }, [clientToBoard, endDrag, onMoveComponent, onMoveSelection]);

  useEffect(() => {
    const up = () => endDrag(true);
    const cancel = () => endDrag(true);
    window.addEventListener('mousemove', handleWindowMove);
    window.addEventListener('mouseup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('mousemove', handleWindowMove);
      window.removeEventListener('mouseup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [handleWindowMove, endDrag]);

  /** Capture the pointer for the gesture that's starting, so the board keeps getting its events. */
  const capturePointer = useCallback(() => {
    const svg = svgRef.current;
    if (svg && lastPointerId.current !== null) {
      try { svg.setPointerCapture(lastPointerId.current); } catch { /* pointer already gone */ }
    }
  }, []);

  const handleComponentMouseDown = useCallback(
    (e: React.MouseEvent, compId: string) => {
      if (e.button !== 0) return;
      // Don't select/drag if we're wiring
      if (wiringFrom) return;
      const isSelected = selectedComponentIds.includes(compId);
      const additive = e.ctrlKey || e.metaKey;
      let nextSelectedIds: string[];
      let collapseToId: string | null = null;
      if (additive) {
        nextSelectedIds = isSelected
          ? selectedComponentIds.filter((id) => id !== compId)
          : [...selectedComponentIds, compId];
        onSelectComponent(compId, true);
      } else if (isSelected && selectedComponentIds.length > 1) {
        // Pressing a member of a multi-selection keeps the group so it can
        // be dragged together; a plain click (no drag) selects just this one.
        nextSelectedIds = selectedComponentIds;
        collapseToId = compId;
      } else {
        nextSelectedIds = [compId];
        onSelectComponent(compId, false);
      }
      onSelectWire(null);

      if (!nextSelectedIds.includes(compId)) return;

      const coords = clientToBoard(e.clientX, e.clientY);
      const comp = components.find((c) => c.id === compId);
      if (comp) {
        const originPositions: Record<string, Point> = {};
        nextSelectedIds.forEach((id) => {
          const selected = components.find((c) => c.id === id);
          if (selected) originPositions[id] = { ...selected.position };
        });
        dragRef.current = {
          kind: 'parts',
          ids: nextSelectedIds,
          draggedId: compId,
          offsetX: coords.x - comp.position.x,
          offsetY: coords.y - comp.position.y,
          type: comp.type,
          rotation: comp.rotation,
          originPositions,
          startClient: { x: e.clientX, y: e.clientY },
          moved: false,
          collapseToId,
          lastMoves: null,
        };
        capturePointer();
      }
    },
    [components, clientToBoard, onSelectComponent, onSelectWire, wiringFrom, selectedComponentIds, capturePointer]
  );

  const handleSvgMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (wiringFrom) setMousePos(clientToBoard(e.clientX, e.clientY));
    },
    [clientToBoard, wiringFrom]
  );

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
    // Drop any lingering gesture first.
    if (dragRef.current) endDrag(true);
    if (e.button !== 0 && e.button !== 1) return;

    const isBackground = e.target === svgRef.current ||
      ((e.target as SVGElement).tagName === 'rect' && !(e.target as SVGElement).closest('.component'));

    // Ctrl+drag or middle-drag pans anywhere; a plain drag on the background pans too.
    const forcePan = e.ctrlKey || e.metaKey || e.button === 1;
    if (!forcePan && !isBackground) return;

    if (isBackground && wiringFrom && !forcePan) {
      onStartWire('', '');
      setMousePos(null);
      return;
    }

    // preventDefault stops text selection but also keeps focus where it was;
    // blur a field being edited so its value is committed.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && typeof active.blur === 'function') active.blur();
    e.preventDefault();
    dragRef.current = {
      kind: 'pan',
      startClient: { x: e.clientX, y: e.clientY },
      startPan: { ...viewRef.current.pan },
      moved: false,
      clickClears: isBackground && !forcePan,
    };
    capturePointer();
  }, [wiringFrom, onStartWire, endDrag, capturePointer]);

  // Wheel zoom: a native, non-passive listener (React's onWheel is passive,
  // so preventDefault there only logs errors).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 33 : 1));
      zoomAt(Math.max(0.5, Math.min(2, factor)), e.clientX, e.clientY);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Keyboard zoom: + / − / 0 (100 %) / F (fit). Ctrl+± stays the window zoom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (shortcutsBlocked(e, !!document.querySelector('.modal-overlay'))) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(1.25); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(1 / 1.25); }
      else if (e.key === '0') { e.preventDefault(); setZoomCentered(1); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fitCircuit(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomAt, setZoomCentered, fitCircuit]);

  const handleBoardPinMouseDown = useCallback(
    (col: number, row: number, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const boardPinId = `${col},${row}`;
      if (!wiringFrom) {
        onStartWire('board', boardPinId);
      } else {
        onEndWire('board', boardPinId);
        setMousePos(null);
      }
    },
    [wiringFrom, onStartWire, onEndWire]
  );

  /** Board units that show as `px` screen pixels at the current zoom (for readable labels). */
  const screenPx = (px: number) => px / scale;

  // Compute highlighted holes for the hovered strip + coordinate label
  const highlightedHoles = useMemo(() => {
    if (!hoveredHole) return null;
    const groupId = pinLookup.get(hoveredHole);
    if (!groupId) return null;
    const pins = pinGroupMap.get(groupId);
    if (!pins) return null;
    const [hc, hr] = hoveredHole.split(',').map(Number);
    const hPos = gridToPixel(hc, hr);
    const holeVoltage = simRunning && pinHoleVoltages ? (pinHoleVoltages.get(hoveredHole) ?? 0) : 0;
    const voltageStr = Math.abs(holeVoltage) > 0.01 ? `  ${holeVoltage.toFixed(2)}V` : '';
    const labelText = `col ${hc}, row ${hr}${voltageStr}`;
    // Readable at any zoom: sized in screen pixels.
    const fs = screenPx(11);
    const elements = pins.map(({ col, row }) => {
      const { x, y } = gridToPixel(col, row);
      return (
        <circle
          key={`hl-${col}-${row}`}
          cx={x} cy={y} r={3.5}
          fill="#fbbf2455"
          stroke="#fbbf24"
          strokeWidth={1}
          pointerEvents="none"
        />
      );
    });
    elements.push(
      <g key="hover-label" pointerEvents="none">
        <rect
          x={hPos.x + 5} y={hPos.y - 5 - fs * 1.5}
          width={labelText.length * fs * 0.6 + fs * 0.8} height={fs * 1.5}
          rx={fs * 0.3} fill="rgba(30,41,59,0.92)" stroke="#475569" strokeWidth={fs * 0.08}
        />
        <text
          x={hPos.x + 5 + fs * 0.4} y={hPos.y - 5 - fs * 0.42}
          fill="#e2e8f0" fontSize={fs} fontWeight="500"
        >
          {labelText}
        </text>
      </g>
    );
    return elements;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredHole, pinLookup, pinGroupMap, simRunning, pinHoleVoltages, scale]);

  // Build pin hole elements for all breadboards
  const pinHoles = useMemo(() => {
    const holes: JSX.Element[] = [];
    for (let col = 0; col < BOARD_TOTAL_COLS; col++) {
      if (isGapColumn(col)) continue;
      for (let row = 0; row < TOTAL_ROWS; row++) {
        const { x, y } = gridToPixel(col, row);
        let isPositiveRail = false;
        let isNegativeRail = false;
        for (let bi = 0; bi < NUM_BOARDS; bi++) {
          const bc = boardColumns(bi);
          if (col === bc.leftRailStart || col === bc.rightRailStart) isPositiveRail = true;
          if (col === bc.leftRailStart + 1 || col === bc.rightRailStart + 1) isNegativeRail = true;
        }

        // Voltage-based highlighting during simulation
        const holeVoltage = simRunning && pinHoleVoltages ? (pinHoleVoltages.get(`${col},${row}`) ?? 0) : 0;
        const hasVoltage = Math.abs(holeVoltage) > 0.01;

        let color: string;
        let strokeColor: string;
        let r = 2.5;
        if (hasVoltage) {
          color = holeVoltage > 0 ? '#4ade80' : '#60a5fa';
          strokeColor = holeVoltage > 0 ? '#22c55e' : '#3b82f6';
          r = 3;
        } else if (isPositiveRail || isNegativeRail) {
          color = '#111111';
          strokeColor = '#000000';
        } else {
          color = '#1a1a1a';
          strokeColor = '#00000022';
        }

        const holeKey = `${col},${row}`;
        holes.push(
          <circle
            key={`hole-${col}-${row}`}
            cx={x}
            cy={y}
            r={r}
            fill={color}
            stroke={strokeColor}
            strokeWidth={hasVoltage ? 1 : 0.5}
            className="pin-hole"
            onMouseDown={(e) => handleBoardPinMouseDown(col, row, e)}
            onMouseEnter={() => setHoveredHole(holeKey)}
            onMouseLeave={() => setHoveredHole((prev) => prev === holeKey ? null : prev)}
          />
        );
      }
    }
    return holes;
  }, [handleBoardPinMouseDown, simRunning, pinHoleVoltages]);

  // Draw connection traces for all boards
  const groupTraces = useMemo(() => {
    const traces: JSX.Element[] = [];

    for (let bi = 0; bi < NUM_BOARDS; bi++) {
      const bc = boardColumns(bi);

      // Component area horizontal traces (left and right halves)
      for (const startCol of [bc.leftCompStart, bc.rightCompStart]) {
        for (let row = 0; row < TOTAL_ROWS; row++) {
          const p1 = gridToPixel(startCol, row);
          const p2 = gridToPixel(startCol + COMP_COLS - 1, row);
          traces.push(
            <line
              key={`trace-comp-${bi}-${startCol}-${row}`}
              x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
              stroke="#5a4f3e" strokeWidth={1} opacity={0.5}
            />
          );
        }
      }

      // Power rail vertical traces (2×5 groups)
      for (const railCol of [bc.leftRailStart, bc.rightRailStart]) {
        for (let g = 0; g < TOTAL_ROWS / RAIL_GROUP_SIZE; g++) {
          const startRow = g * RAIL_GROUP_SIZE;
          const endRow = startRow + RAIL_GROUP_SIZE - 1;
          const pp1 = gridToPixel(railCol, startRow);
          const pp2 = gridToPixel(railCol, endRow);
          traces.push(
            <line
              key={`trace-rail-pos-${bi}-${railCol}-${g}`}
              x1={pp1.x} y1={pp1.y} x2={pp2.x} y2={pp2.y}
              stroke="#7f2222" strokeWidth={1} opacity={0.5}
            />
          );
          const np1 = gridToPixel(railCol + 1, startRow);
          const np2 = gridToPixel(railCol + 1, endRow);
          traces.push(
            <line
              key={`trace-rail-neg-${bi}-${railCol}-${g}`}
              x1={np1.x} y1={np1.y} x2={np2.x} y2={np2.y}
              stroke="#1e3a6e" strokeWidth={1} opacity={0.5}
            />
          );
          // No horizontal traces — + and - rails are separate buses
        }
      }
    }

    return traces;
  }, []);

  // Rail labels for all boards
  const railLabels = useMemo(() => {
    const labels: JSX.Element[] = [];
    for (let bi = 0; bi < NUM_BOARDS; bi++) {
      const bc = boardColumns(bi);
      for (const railCol of [bc.leftRailStart, bc.rightRailStart]) {
        const px = gridToPixel(railCol, 0);
        const nx = gridToPixel(railCol + 1, 0);
        labels.push(
          <text key={`rl-p-${bi}-${railCol}`} x={px.x} y={px.y - 8} textAnchor="middle" fill="#ef4444" fontSize={8} fontWeight="bold">+</text>,
          <text key={`rl-n-${bi}-${railCol}`} x={nx.x} y={nx.y - 8} textAnchor="middle" fill="#3b82f6" fontSize={8} fontWeight="bold">-</text>,
        );
      }
    }
    return labels;
  }, []);

  return (
    <>
    <svg
      ref={svgRef}
      className="breadboard-svg"
      viewBox={viewBox}
      preserveAspectRatio="xMinYMin meet"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onPointerDown={(e) => { lastPointerId.current = e.pointerId; }}
      onMouseMove={handleSvgMouseMove}
      onMouseDown={handleBoardMouseDown}
      onMouseLeave={() => { if (wiringFrom) setMousePos(null); }}
      role="application"
      aria-label="Breadboard"
    >
      {/* Supply area background */}
      <rect x={0} y={0} width={SUPPLY_WIDTH} height={BOARD_PIXEL_HEIGHT} fill="#0b1120" rx={8} />
      <text x={SUPPLY_WIDTH / 2} y={20} textAnchor="middle" fill="#475569" fontSize={10} fontWeight="600">POWER</text>

      {/* Breadboard backgrounds and gaps */}
      {Array.from({ length: NUM_BOARDS }).map((_, bi) => {
        const off = boardColOffset(bi);
        const bx = BOARD_X_OFFSET + off * GRID_W;
        const bw = SINGLE_BOARD_COLS * GRID_W;
        return (
          <g key={`board-${bi}`}>
            <rect x={bx} y={0} width={bw} height={BOARD_PIXEL_HEIGHT} fill="#b5ac9d" rx={8} />
            {/* Center gap */}
            <rect
              x={BOARD_X_OFFSET + (off + REL_COL_GAP) * GRID_W}
              y={0}
              width={GRID_W}
              height={BOARD_PIXEL_HEIGHT}
              fill="#9d9486"
            />
          </g>
        );
      })}

      {/* Connection traces (underneath pin holes) */}
      {groupTraces}

      {/* Pin holes */}
      {pinHoles}

      {/* Hover strip highlight */}
      {highlightedHoles}

      {/* Rail labels */}
      {railLabels}

      {/* Wires — routed orthogonally */}
      {routedWires.map(({ wire, path, points }) => {
        const vDiff = wireCurrents?.get(wire.id) ?? 0;
        const hasFlow = simRunning && Math.abs(vDiff) > 0.01;
        // Current flows from high to low voltage.
        // vDiff = V_from - V_to. If positive, current flows from→to (forward along wire).
        const flowReverse = vDiff < 0;

        return (
          <g key={wire.id}>
            {/* Invisible fat hitbox for easier clicking */}
            <path
              d={path}
              stroke="transparent"
              strokeWidth={12}
              fill="none"
              onMouseDown={(e) => handleWireClick(e, wire.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelectWire(wire.id);
                onSelectComponent(null);
                onContextMenu?.(e, undefined, wire.id);
              }}
              className="wire-hitbox"
            />
            <path
              d={path}
              stroke={selectedWireId === wire.id ? SELECTED_WIRE_COLOR : wire.color}
              strokeWidth={selectedWireId === wire.id ? 3.5 : 2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              className="wire"
              pointerEvents="none"
            />
            {/* Current direction arrows */}
            {hasFlow && points.length >= 2 && (() => {
              // Place arrows at midpoints of each segment
              const arrows: JSX.Element[] = [];
              const cleanPts = flowReverse ? [...points].reverse() : points;
              for (let i = 0; i < cleanPts.length - 1; i++) {
                const a = cleanPts[i];
                const b = cleanPts[i + 1];
                const mx = (a.x + b.x) / 2;
                const my = (a.y + b.y) / 2;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len < 10) continue; // skip very short segments
                // Angle in degrees
                const angle = Math.atan2(dy, dx) * 180 / Math.PI;
                arrows.push(
                  <polygon
                    key={`arr-${wire.id}-${i}`}
                    points="-3,-2 3,0 -3,2"
                    transform={`translate(${mx},${my}) rotate(${angle})`}
                    fill="#ffffff"
                    opacity={0.7}
                    pointerEvents="none"
                  />
                );
              }
              return arrows;
            })()}
          </g>
        );
      })}

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
        const { w, h } = getRenderedSize(def, comp.rotation);
        const isSelected = selectedComponentIds.includes(comp.id);
        const ledColorMap: Record<string, string> = {
          red: '#ef4444', green: '#22c55e', blue: '#3b82f6', yellow: '#eab308',
          white: '#f1f5f9', orange: '#f97316', purple: '#a855f7',
        };
        const ledColor = comp.type === 'led'
          ? ledColorMap[comp.properties.color as string] || def.color
          : def.color;
        const ledBrightness = comp.type === 'led' ? ledBrightnessOf(comp) : 0;
        const isLedOn = ledBrightness > 0;
        const warning = getWarning(comp);
        const isSwitchClosed = comp.type === 'switch' && comp.state?.closed;
        const isTimerHigh = comp.type === 'timer' && comp.state?.outputHigh;

        return (
          <g
            key={comp.id}
            transform={`translate(${comp.position.x}, ${comp.position.y})`}
            className={`component ${comp.type === 'switch' ? 'clickable' : ''}`}
            onMouseDown={(e) => {
              if (!wiringFrom) e.stopPropagation();
              if (comp.type === 'switch') {
                e.stopPropagation();
                onSelectComponent(comp.id);
                onSelectWire(null);
                if (comp.properties?.momentary) {
                  // Pushbutton: close on press, open on release. Listen on
                  // window so dragging off the switch still releases it.
                  onSetSwitchClosed(comp.id, true);
                  const release = () => {
                    onSetSwitchClosed(comp.id, false);
                    window.removeEventListener('mouseup', release);
                  };
                  window.addEventListener('mouseup', release);
                } else {
                  onToggleSwitch(comp.id);
                }
                return;
              }
              handleComponentMouseDown(e, comp.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelectComponent(comp.id);
              onSelectWire(null);
              onContextMenu?.(e, comp.id, undefined);
            }}
          >
            {/* Selection highlight */}
            {isSelected && (
              <rect x={-3} y={-3} width={w + 6} height={h + 6} fill="none" stroke="#38bdf8" strokeWidth={2} rx={6} strokeDasharray="4 2" />
            )}

            {/* Component body */}
            {comp.type === 'resistor' ? (() => {
              // Resistor: narrow body with lead wires
              const isVert = comp.rotation === 0 || comp.rotation === 180;
              const bodyW = isVert ? w * 0.5 : w * 0.6;
              const bodyH = isVert ? h * 0.5 : h * 0.5;
              const bx = (w - bodyW) / 2;
              const by = (h - bodyH) / 2;
              return (
                <>
                  {/* Lead wires */}
                  <line
                    x1={w / 2} y1={isVert ? 0 : h / 2}
                    x2={w / 2} y2={isVert ? by : h / 2}
                    stroke="#94a3b8" strokeWidth={1.5}
                  />
                  <line
                    x1={isVert ? w / 2 : 0} y1={isVert ? by + bodyH : h / 2}
                    x2={isVert ? w / 2 : bx} y2={isVert ? h : h / 2}
                    stroke="#94a3b8" strokeWidth={1.5}
                  />
                  {!isVert && (
                    <>
                      <line x1={0} y1={h / 2} x2={bx} y2={h / 2} stroke="#94a3b8" strokeWidth={1.5} />
                      <line x1={bx + bodyW} y1={h / 2} x2={w} y2={h / 2} stroke="#94a3b8" strokeWidth={1.5} />
                    </>
                  )}
                  {/* Resistor body */}
                  <rect
                    x={bx} y={by}
                    width={bodyW} height={bodyH}
                    fill={def.color}
                    stroke={def.color}
                    strokeWidth={1}
                    rx={3}
                  />
                  {/* Colour bands, computed from the value (4.7 kΩ = yellow violet red gold) */}
                  {(resistorBands(Number(comp.properties.resistance ?? 220)) ?? []).map((band, i) => {
                    const f = [0.2, 0.38, 0.56, 0.82][i];
                    const sw = i === 3 ? 1.5 : 2;
                    return isVert ? (
                      <line key={i} x1={bx + 2} y1={by + bodyH * f} x2={bx + bodyW - 2} y2={by + bodyH * f} stroke={band.color} strokeWidth={sw}>
                        <title>{band.name}</title>
                      </line>
                    ) : (
                      <line key={i} x1={bx + bodyW * f} y1={by + 2} x2={bx + bodyW * f} y2={by + bodyH - 2} stroke={band.color} strokeWidth={sw}>
                        <title>{band.name}</title>
                      </line>
                    );
                  })}
                </>
              );
            })() : comp.type === 'capacitor' ? (() => {
              // Electrolytic capacitor: cylindrical body with lead wires and plates
              const isVert = comp.rotation === 0 || comp.rotation === 180;
              const bodyR = Math.min(w, h) * 0.4;
              const cx = w / 2;
              const cy = h / 2;
              return (
                <>
                  {/* Lead wires */}
                  {isVert ? (
                    <>
                      <line x1={cx} y1={0} x2={cx} y2={cy - bodyR * 0.6} stroke="#94a3b8" strokeWidth={1.5} />
                      <line x1={cx} y1={cy + bodyR * 0.6} x2={cx} y2={h} stroke="#94a3b8" strokeWidth={1.5} />
                    </>
                  ) : (
                    <>
                      <line x1={0} y1={cy} x2={cx - bodyR * 0.6} y2={cy} stroke="#94a3b8" strokeWidth={1.5} />
                      <line x1={cx + bodyR * 0.6} y1={cy} x2={w} y2={cy} stroke="#94a3b8" strokeWidth={1.5} />
                    </>
                  )}
                  {/* Capacitor body (cylinder) */}
                  <circle cx={cx} cy={cy} r={bodyR} fill={def.color} stroke="#2563eb" strokeWidth={1} />
                  {/* Plate lines */}
                  {isVert ? (
                    <>
                      <line x1={cx - bodyR * 0.5} y1={cy - 1.5} x2={cx + bodyR * 0.5} y2={cy - 1.5} stroke="#e2e8f0" strokeWidth={1} />
                      <path d={`M ${cx - bodyR * 0.5} ${cy + 1.5} Q ${cx} ${cy + 4} ${cx + bodyR * 0.5} ${cy + 1.5}`} stroke="#e2e8f0" strokeWidth={1} fill="none" />
                    </>
                  ) : (
                    <>
                      <line x1={cx - 1.5} y1={cy - bodyR * 0.5} x2={cx - 1.5} y2={cy + bodyR * 0.5} stroke="#e2e8f0" strokeWidth={1} />
                      <path d={`M ${cx + 1.5} ${cy - bodyR * 0.5} Q ${cx + 4} ${cy} ${cx + 1.5} ${cy + bodyR * 0.5}`} stroke="#e2e8f0" strokeWidth={1} fill="none" />
                    </>
                  )}
                  {/* + marker near positive pin */}
                  <text
                    x={isVert ? cx + bodyR * 0.3 : cx - bodyR * 0.3}
                    y={isVert ? cy - bodyR * 0.2 : cy - bodyR * 0.3}
                    fill="#e2e8f0" fontSize={4} fontWeight="700" textAnchor="middle" pointerEvents="none"
                  >+</text>
                </>
              );
            })() : comp.type === 'led' ? (() => {
              // Brightness 0..1 sets the glow. The flat side of the rim marks
              // the cathode (−), as on a real 5 mm LED.
              const r = w / 2 - 1;
              const cx = w / 2;
              const cy = h / 2;
              const cathodeSide = rotatedSide('bottom', comp.rotation);
              const flat = r * 0.72;
              const [fx1, fy1, fx2, fy2] =
                cathodeSide === 'bottom' ? [cx - flat, cy + flat, cx + flat, cy + flat]
                : cathodeSide === 'top' ? [cx - flat, cy - flat, cx + flat, cy - flat]
                : cathodeSide === 'left' ? [cx - flat, cy - flat, cx - flat, cy + flat]
                : [cx + flat, cy - flat, cx + flat, cy + flat];
              return (
                <>
                  {isLedOn && (
                    <circle cx={cx} cy={cy} r={r + 2 + 6 * ledBrightness} fill={ledColor} opacity={0.15 + 0.4 * ledBrightness} pointerEvents="none" />
                  )}
                  <circle
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill={isLedOn ? ledColor : '#333'}
                    stroke={ledColor}
                    strokeWidth={1.5}
                    opacity={isLedOn ? 0.45 + 0.55 * ledBrightness : 0.4}
                  />
                  <line x1={fx1} y1={fy1} x2={fx2} y2={fy2} stroke="#0f172a" strokeWidth={2.2} strokeLinecap="round" pointerEvents="none">
                    <title>Flat side = cathode (−)</title>
                  </line>
                </>
              );
            })() : comp.type === 'potentiometer' ? (() => {
              // Potentiometer: circular body with wiper arrow
              const cx = w / 2;
              const cy = h / 2;
              const r = Math.min(w, h) * 0.35;
              const pos = Number(comp.properties.position ?? 50) / 100;
              const wiperAngle = -90 + pos * 270; // sweep from top-left to top-right
              const rad = wiperAngle * Math.PI / 180;
              return (
                <>
                  {/* Leads */}
                  <line x1={cx} y1={0} x2={cx} y2={cy - r} stroke="#94a3b8" strokeWidth={1.5} />
                  <line x1={cx} y1={cy + r} x2={cx} y2={h} stroke="#94a3b8" strokeWidth={1.5} />
                  <line x1={w} y1={cy} x2={cx + r} y2={cy} stroke="#94a3b8" strokeWidth={1.5} />
                  {/* Body */}
                  <circle cx={cx} cy={cy} r={r} fill={def.color} stroke="#0284c7" strokeWidth={1} />
                  {/* Wiper indicator */}
                  <line
                    x1={cx} y1={cy}
                    x2={cx + Math.cos(rad) * r * 0.8} y2={cy + Math.sin(rad) * r * 0.8}
                    stroke="#e2e8f0" strokeWidth={1.5} strokeLinecap="round"
                  />
                  <circle cx={cx} cy={cy} r={1.5} fill="#e2e8f0" />
                </>
              );
            })() : comp.type === 'display7seg' ? (() => {
              // 7-segment DIP display
              const onColor = '#ef4444';
              const offColor = '#2a1a1a';
              const segA = comp.state?.seg_a ? onColor : offColor;
              const segB = comp.state?.seg_b ? onColor : offColor;
              const segC = comp.state?.seg_c ? onColor : offColor;
              const segD = comp.state?.seg_d ? onColor : offColor;
              const segE = comp.state?.seg_e ? onColor : offColor;
              const segF = comp.state?.seg_f ? onColor : offColor;
              const segG = comp.state?.seg_g ? onColor : offColor;
              // Display window in the upper 60% of the chip
              const dh = h * 0.55;
              const pad = 4;
              const sw = Math.max(16, (w - pad * 2) * 0.58); // narrower segment area for a more numeric shape
              const windowWidth = sw + 4;
              const windowX = (w - windowWidth) / 2;
              const sh = (dh - pad * 2) * 0.48; // half height
              const t = 1.5;
              const ox = windowX + 2;
              const oy = pad + 2;
              const pinLabelInset = CHIP_PIN_LABEL_INSET;
              const pinLabelStyle = {
                fill: CHIP_PIN_LABEL_COLOR,
                fontSize: 3.5,
                fontFamily: CHIP_PIN_LABEL_FONT_FAMILY,
                pointerEvents: 'none' as const,
              };

              return (
                <>
                  <rect width={w} height={h} fill="#1a1a1a" stroke="#333" strokeWidth={1} rx={2} />
                  {/* Display window */}
                  <rect x={windowX} y={2} width={windowWidth} height={dh} fill="#0a0a0a" rx={1} />
                  {/* a: top horizontal */}
                  <rect x={ox} y={oy} width={sw} height={t} fill={segA} rx={0.5} />
                  {/* b: top-right vertical */}
                  <rect x={ox + sw - t} y={oy} width={t} height={sh} fill={segB} rx={0.5} />
                  {/* c: bottom-right vertical */}
                  <rect x={ox + sw - t} y={oy + sh} width={t} height={sh} fill={segC} rx={0.5} />
                  {/* d: bottom horizontal */}
                  <rect x={ox} y={oy + sh * 2 - t} width={sw} height={t} fill={segD} rx={0.5} />
                  {/* e: bottom-left vertical */}
                  <rect x={ox} y={oy + sh} width={t} height={sh} fill={segE} rx={0.5} />
                  {/* f: top-left vertical */}
                  <rect x={ox} y={oy} width={t} height={sh} fill={segF} rx={0.5} />
                  {/* g: middle horizontal */}
                  <rect x={ox} y={oy + sh - t / 2} width={sw} height={t} fill={segG} rx={0.5} />
                  {/* Pin 1 notch */}
                  <circle cx={w / 2} cy={h} r={2} fill="#0a0a0a" stroke="#444" strokeWidth={0.5} />
                  {/* Pin labels */}
                  {/* Pin labels — hidden during run mode for a cleaner display */}
                  {!simRunning && (
                    <>
                      <text x={pinLabelInset} y={h * 0.9 + 1} textAnchor="start" dominantBaseline="middle" {...pinLabelStyle}>1 e</text>
                      <text x={pinLabelInset} y={h * 0.7 + 1} textAnchor="start" dominantBaseline="middle" {...pinLabelStyle}>2 d</text>
                      <text x={pinLabelInset} y={h * 0.5 + 1} textAnchor="start" dominantBaseline="middle" {...pinLabelStyle}>3 ⏚</text>
                      <text x={pinLabelInset} y={h * 0.3 + 1} textAnchor="start" dominantBaseline="middle" {...pinLabelStyle}>4 c</text>
                      <text x={pinLabelInset} y={h * 0.1 + 1} textAnchor="start" dominantBaseline="middle" {...pinLabelStyle}>5 dp</text>
                      <text x={w - pinLabelInset} y={h * 0.9 + 1} textAnchor="end" dominantBaseline="middle" {...pinLabelStyle}>b 6</text>
                      <text x={w - pinLabelInset} y={h * 0.7 + 1} textAnchor="end" dominantBaseline="middle" {...pinLabelStyle}>a 7</text>
                      <text x={w - pinLabelInset} y={h * 0.5 + 1} textAnchor="end" dominantBaseline="middle" {...pinLabelStyle}>V+ 8</text>
                      <text x={w - pinLabelInset} y={h * 0.3 + 1} textAnchor="end" dominantBaseline="middle" {...pinLabelStyle}>f 9</text>
                      <text x={w - pinLabelInset} y={h * 0.1 + 1} textAnchor="end" dominantBaseline="middle" {...pinLabelStyle}>g 10</text>
                    </>
                  )}
                </>
              );
            })() : comp.type === 'ledmatrix' ? (() => {
              // 5x7 LED Matrix
              const matrixColorMap: Record<string, string> = {
                red: '#ef4444', green: '#22c55e', blue: '#3b82f6', yellow: '#eab308',
                white: '#f1f5f9', orange: '#f97316',
              };
              const matOnColor = matrixColorMap[comp.properties.color as string] || '#ef4444';
              const matOffColor = '#666666';
              const padX = 6;
              const padY = 4;
              const displayW = w - padX * 2;
              const displayH = h * 0.65;
              const dotW = displayW / 5;
              const dotH = displayH / 7;
              const dotR = Math.min(dotW, dotH) * 0.3;

              // Pin labels for matrix
              const leftPins = def.pins.filter((p) => p.side === 'left');
              const rightPins = def.pins.filter((p) => p.side === 'right');
              const leftSorted = [...leftPins].sort((a, b) => b.offset - a.offset);
              const rightSorted = [...rightPins].sort((a, b) => b.offset - a.offset);
              const pinTextStyle = {
                fill: CHIP_PIN_LABEL_COLOR,
                fontSize: 3.5,
                fontFamily: CHIP_PIN_LABEL_FONT_FAMILY,
                pointerEvents: 'none' as const,
              };

              return (
                <>
                  <rect width={w} height={h} fill="#1a1a1a" stroke="#333" strokeWidth={1} rx={2} />
                  {/* Display window */}
                  <rect x={padX - 2} y={padY - 2} width={displayW + 4} height={displayH + 4} fill="#0a0a0a" rx={1} />
                  {/* LED dots (5 cols x 7 rows). The simulator OR-aggregates
                      a sliding window of recent frames into led_c_r, so each
                      LED is either fully on or fully off — multiplexed scans
                      reconstruct as steady binary images. */}
                  {Array.from({ length: 5 }).map((_, c) =>
                    Array.from({ length: 7 }).map((_, r) => {
                      const isOn = !!comp.state?.[`led_${c}_${r}`];
                      return (
                        <circle
                          key={`dot-${c}-${r}`}
                          cx={padX + dotW * c + dotW / 2}
                          cy={padY + dotH * r + dotH / 2}
                          r={dotR}
                          fill={isOn ? matOnColor : matOffColor}
                          opacity={isOn ? 1 : 0.3}
                        />
                      );
                    })
                  )}
                  {/* Pin 1 notch */}
                  <circle cx={w / 2} cy={h} r={2} fill="#0a0a0a" stroke="#444" strokeWidth={0.5} />
                  {/* Pin labels — hidden during run mode for a cleaner display */}
                  {!simRunning && leftSorted.map((pin, i) => (
                    <text
                      key={pin.id}
                      x={CHIP_PIN_LABEL_INSET}
                      y={h * pin.offset + 0.5}
                      textAnchor="start"
                      dominantBaseline="middle"
                      {...pinTextStyle}
                    >
                      {i + 1} {pin.label}
                    </text>
                  ))}
                  {!simRunning && rightSorted.map((pin, i) => (
                    <text
                      key={pin.id}
                      x={w - CHIP_PIN_LABEL_INSET}
                      y={h * pin.offset + 0.5}
                      textAnchor="end"
                      dominantBaseline="middle"
                      {...pinTextStyle}
                    >
                      {pin.label} {leftSorted.length + i + 1}
                    </text>
                  ))}
                  {/* Chip label — hidden in run mode for a cleaner display */}
                  {!simRunning && (
                    <text x={w / 2} y={h / 2 + 1} textAnchor="middle" fill="#e2e8f0" fontSize={4.5} fontWeight="600" pointerEvents="none">
                      {def.chipLabel ?? def.label}
                    </text>
                  )}
                </>
              );
            })() : comp.type === 'multimeter' ? (() => {
              // Multimeter: display panel showing reading
              const displayVal = comp.state?.displayValue;
              const displayUnit = comp.state?.displayUnit ?? 'V';
              const mode = comp.properties.mode ?? 'voltage';
              let readout = '---';
              if (displayVal !== undefined && simRunning) {
                const v = Number(displayVal);
                if (Math.abs(v) < 0.001) readout = '0.000';
                else if (Math.abs(v) < 1) readout = (v * 1000).toFixed(1) + 'm';
                else readout = v.toFixed(3);
              }
              return (
                <>
                  <rect width={w} height={h} fill="#1e293b" stroke="#475569" strokeWidth={1} rx={3} />
                  {/* Screen */}
                  <rect x={3} y={3} width={w - 6} height={h * 0.5} fill="#0f172a" rx={2} />
                  {/* Reading */}
                  <text x={w / 2} y={h * 0.32} textAnchor="middle" fill="#4ade80" fontSize={7} fontFamily="monospace" fontWeight="700" pointerEvents="none">
                    {readout}
                  </text>
                  {/* Unit */}
                  <text x={w - 5} y={h * 0.32} textAnchor="end" fill="#94a3b8" fontSize={4} pointerEvents="none">
                    {displayUnit}
                  </text>
                  {/* Mode label */}
                  <text x={w / 2} y={h * 0.72} textAnchor="middle" fill="#94a3b8" fontSize={4} pointerEvents="none">
                    {mode === 'current' ? 'AMPS' : 'VOLTS'}
                  </text>
                </>
              );
            })() : (
              <rect
                width={w}
                height={h}
                fill={def.category === 'active' || comp.type === 'switch' ? def.color : def.color + '33'}
                stroke={def.color}
                strokeWidth={1.5}
                rx={4}
              />
            )}

            {/* Switch state: show 0 or 1 */}
            {comp.type === 'switch' && (
              <text
                x={w / 2}
                y={h / 2 + 2}
                textAnchor="middle"
                fill={isSwitchClosed ? '#4ade80' : '#ef4444'}
                fontSize={6}
                fontWeight="700"
                pointerEvents="none"
              >
                {isSwitchClosed ? '1' : '0'}
              </text>
            )}

            {/* Waveform icon on power supply */}
            {/* The symbol follows the mode: DC is the ⎓ sign (solid over dashed);
                AC shows its waveform. */}
            {comp.type === 'power' && (comp.properties.mode ?? 'DC') !== 'AC' && (
              <g stroke="#4ade80" strokeWidth={1.5} strokeLinecap="round" opacity={0.6} pointerEvents="none">
                <line x1={6} y1={h - 13} x2={38} y2={h - 13} />
                <line x1={6} y1={h - 7} x2={38} y2={h - 7} strokeDasharray="5 4" />
              </g>
            )}
            {comp.type === 'power' && comp.properties.mode === 'AC' && (
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

            {/* Generic DIP chip rendering for all IC category components.
                ledmatrix is excluded — it has its own dedicated render path
                above (which includes its own pin labels + run-mode-aware
                chip label) and would otherwise get a duplicate label drawn
                on top of the LED grid in run mode. */}
            {def.category === 'active' && comp.type !== 'display7seg' && comp.type !== 'ledmatrix' && (() => {
              const leftPins = def.pins.filter((p) => p.side === 'left');
              const rightPins = def.pins.filter((p) => p.side === 'right');
              const totalPins = leftPins.length + rightPins.length;
              // Use consistent chip pin label size across active DIP parts, matching the 555 style.
              const fontSize = 3.5;
              const inset = CHIP_PIN_LABEL_INSET;
              const notchR = totalPins <= 8 ? 3 : 2;

              // Number pins: left bottom-to-top = 1..N, right bottom-to-top = N+1..2N
              const leftSorted = [...leftPins].sort((a, b) => b.offset - a.offset);
              const rightSorted = [...rightPins].sort((a, b) => b.offset - a.offset);
              const pinTextStyle = {
                fill: CHIP_PIN_LABEL_COLOR,
                fontSize,
                fontFamily: CHIP_PIN_LABEL_FONT_FAMILY,
                pointerEvents: 'none' as const,
              };

              return (
                <>
                  {/* Pin 1 notch */}
                  <circle cx={w / 2} cy={h} r={notchR} fill="#0f172a" stroke="#888" strokeWidth={0.5} opacity={0.6} />
                  {/* Pin labels — hidden during run mode for a cleaner display */}
                  {!simRunning && leftSorted.map((pin, i) => (
                    <text
                      key={pin.id}
                      x={inset}
                      y={h * pin.offset + 0.5}
                      textAnchor="start"
                      dominantBaseline="middle"
                      {...pinTextStyle}
                    >
                      {i + 1} {pin.label}
                    </text>
                  ))}
                  {!simRunning && rightSorted.map((pin, i) => (
                    <text
                      key={pin.id}
                      x={w - inset}
                      y={h * pin.offset + 0.5}
                      textAnchor="end"
                      dominantBaseline="middle"
                      {...pinTextStyle}
                    >
                      {pin.label} {leftSorted.length + i + 1}
                    </text>
                  ))}
                  {/* Chip name — short part number for the body. Stays
                      visible in run mode so you can still identify the part
                      after pin labels are hidden. */}
                  <text x={w / 2} y={h / 2 + 1} textAnchor="middle" fill="#e2e8f0" fontSize={fontSize + 1} fontWeight="600" pointerEvents="none">
                    {def.chipLabel ?? def.label}
                  </text>
                  {/* 555 Timer output indicator */}
                  {comp.type === 'timer' && (
                    <circle cx={w / 2} cy={h * 0.15} r={2} fill={isTimerHigh ? '#4ade80' : '#334155'} />
                  )}
                  {/* CD4026 count display */}
                  {comp.type === 'cd4026' && simRunning && (
                    <text x={w / 2} y={h / 2 + fontSize + 4} textAnchor="middle" fill="#4ade80" fontSize={5} fontWeight="700" pointerEvents="none">
                      {comp.state?.count ?? 0}
                    </text>
                  )}
                </>
              );
            })()}

            {/* Label (skip for components with custom rendering).
                Hidden in run mode for a cleaner display. */}
            {!simRunning && comp.type !== 'led' && comp.type !== 'resistor' && comp.type !== 'capacitor' && comp.type !== 'switch' && comp.type !== 'potentiometer' && comp.type !== 'display7seg' && comp.type !== 'multimeter' && def.category !== 'active' && (
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

            {/* Resistor value label — centered over the body */}
            {comp.type === 'resistor' && (
              <text
                x={w / 2}
                y={h / 2 + 1.5}
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize={4}
                fontWeight="600"
                pointerEvents="none"
              >
                {formatValue(Number(comp.properties.resistance ?? 220), 'Ω')}
              </text>
            )}

            {/* Capacitor value label */}
            {comp.type === 'capacitor' && (
              <text
                x={w / 2}
                y={h / 2 + 1.5}
                textAnchor="middle"
                fill="#e2e8f0"
                fontSize={3.5}
                fontWeight="600"
                pointerEvents="none"
              >
                {formatValue(Number(comp.properties.capacitance ?? 100), 'F', -6)}
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
              const side = rotatedSide(pin.side, comp.rotation);
              let px = 0, py = 0;
              switch (side) {
                case 'left':   px = 0;  py = h * pin.offset; break;
                case 'right':  px = w;  py = h * pin.offset; break;
                case 'top':    px = w * pin.offset; py = 0;  break;
                case 'bottom': px = w * pin.offset; py = h;  break;
              }

              // Generic pin label placement: always inside component, inset from pin.
              // Hidden in run mode for a cleaner display.
              const showLabel = !simRunning && def.category !== 'active' && comp.type !== 'switch';
              const gridUnits = Math.min(def.width, def.height);
              const labelSize = gridUnits <= 1 ? 3.5 : 4;
              const inset = gridUnits <= 1 ? 5 : 7;
              let lx = px, ly = py;
              let anchor: 'start' | 'middle' | 'end' = 'middle';
              switch (side) {
                case 'left':   lx = px + inset; ly = py + 1; anchor = 'start'; break;
                case 'right':  lx = px - inset; ly = py + 1; anchor = 'end'; break;
                case 'top':    ly = py + inset; break;
                case 'bottom': ly = py - inset + 3; break;
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
                  {showLabel && (
                    <text
                      x={lx}
                      y={ly}
                      textAnchor={anchor}
                      fill="#e2e8f0"
                      fontSize={labelSize}
                      pointerEvents="none"
                    >
                      {pin.label}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Warning from the engine: badge on the part, message on hover
                (and in the properties panel when selected). */}
            {warning && (
              <g className="part-warning" data-warning-code={warning.code}>
                <title>{warning.message}</title>
                <rect x={-2} y={-2} width={w + 4} height={h + 4} rx={4} fill="none" stroke="#f59e0b" strokeWidth={screenPx(1.5)} strokeDasharray={`${screenPx(4)} ${screenPx(2)}`} />
                <circle cx={w} cy={0} r={screenPx(8)} fill="#f59e0b" stroke="#0f172a" strokeWidth={screenPx(1.5)} />
                <text x={w} y={screenPx(4)} textAnchor="middle" fill="#0f172a" fontSize={screenPx(12)} fontWeight="800">!</text>
              </g>
            )}
          </g>
        );
      })}

      {/* Simulation readouts — rendered on top of everything */}
      {simRunning && components.map((comp) => {
        if (comp.type === 'power' || comp.type === 'multimeter' || comp.type === 'display7seg' || comp.type === 'ledmatrix'
          || comp.type.startsWith('gate_') || comp.type === 'opamp' || comp.type === 'cd4026' || comp.type === 'atmega328'
          || comp.type === 'shift_register' || comp.type === 'flipflop_d') return null;
        const def = COMPONENT_DEFINITIONS[comp.type];
        if (!def) return null;
        const { w, h } = getRenderedSize(def, comp.rotation);

        const voltage = Number(comp.state?.voltage ?? 0);
        const current = Number(comp.state?.current ?? 0);
        if (Math.abs(voltage) < 0.001 && Math.abs(current) < 0.001) return null;

        const vStr = formatVoltage(voltage);
        const iStr = formatCurrent(current);
        const label = iStr ? `${vStr} ${iStr}` : vStr;

        // Readouts keep a constant, readable screen size (11 px) at any zoom.
        const fs = screenPx(11);
        const rx = comp.position.x + w / 2;
        const ry = comp.position.y + h + 2 + fs;
        const boxW = label.length * fs * 0.6 + fs * 0.8;
        return (
          <g key={`readout-${comp.id}`} pointerEvents="none" className="sim-readout">
            <rect
              x={rx - boxW / 2}
              y={ry - fs * 1.05}
              width={boxW}
              height={fs * 1.4}
              rx={fs * 0.3}
              fill="rgba(255,255,255,0.9)"
              stroke="#cbd5e1"
              strokeWidth={fs * 0.05}
            />
            <text
              x={rx}
              y={ry}
              textAnchor="middle"
              fill="#1e293b"
              fontSize={fs}
              fontWeight="600"
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
    <div className="zoom-controls" role="group" aria-label="Zoom">
      <button type="button" onClick={() => zoomAt(1 / 1.25)} aria-label="Zoom out" title="Zoom out (−)">−</button>
      <span className="zoom-level" aria-live="polite">{Math.round(scale * 100)}%</span>
      <button type="button" onClick={() => zoomAt(1.25)} aria-label="Zoom in" title="Zoom in (+)">+</button>
      <button type="button" onClick={() => setZoomCentered(1)} title="Actual size: 1 screen pixel per board unit (0)">100%</button>
      <button type="button" onClick={fitCircuit} title="Zoom to fit the circuit (F)">Fit</button>
      <button type="button" onClick={fitBoard} title="Show the whole breadboard">Board</button>
    </div>
    </>
  );
}
