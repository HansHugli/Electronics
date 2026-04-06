import { useRef, useCallback, useMemo, useState } from 'react';
import { PlacedComponent, Wire, Point } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';
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


interface BreadboardProps {
  components: PlacedComponent[];
  wires: Wire[];
  simRunning: boolean;
  onDropComponent: (type: string, position: Point) => void;
  onMoveComponent: (id: string, position: Point) => void;
  onMoveEnd: () => void;
  onStartWire: (componentId: string, pinId: string) => void;
  onEndWire: (componentId: string, pinId: string) => void;
  wiringFrom: { componentId: string; pinId: string } | null;
  onSelectComponent: (id: string | null) => void;
  selectedComponentId: string | null;
  onSelectWire: (id: string | null) => void;
  selectedWireId: string | null;
  onToggleSwitch: (id: string) => void;
  wireCurrents: Map<string, number>;
  pinHoleVoltages: Map<string, number>;
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

function getPinPosition(comp: PlacedComponent, pinId: string): Point | null {
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

  // L-shapes (2 segments between stubs)
  candidates.push([a, { x: b.x, y: a.y }, b]);
  candidates.push([a, { x: a.x, y: b.y }, b]);

  // Z-shapes (3 segments) at various midpoints
  const midXs = [
    (a.x + b.x) / 2,
    a.x - GRID_W, a.x + GRID_W,
    b.x - GRID_W, b.x + GRID_W,
  ];
  const midYs = [
    (a.y + b.y) / 2,
    a.y - GRID_H, a.y + GRID_H,
    b.y - GRID_H, b.y + GRID_H,
  ];
  for (const mx of midXs) {
    candidates.push([a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]);
  }
  for (const my of midYs) {
    candidates.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
  }

  // U-shapes going wide
  const xOffsets = [GRID_W * 2, GRID_W * 3, -GRID_W * 2, -GRID_W * 3];
  const yOffsets = [GRID_H * 2, GRID_H * 3, -GRID_H * 2, -GRID_H * 3];
  for (const off of yOffsets) {
    const my = Math.min(a.y, b.y) + off;
    candidates.push([a, { x: a.x, y: my }, { x: b.x, y: my }, b]);
  }
  for (const off of xOffsets) {
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
  onMoveEnd,
  onStartWire,
  onEndWire,
  wiringFrom,
  onSelectComponent,
  selectedComponentId,
  onSelectWire,
  selectedWireId,
  onToggleSwitch,
  wireCurrents,
  pinHoleVoltages,
}: BreadboardProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number; type: string; rotation: number } | null>(null);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const [hoveredHole, setHoveredHole] = useState<string | null>(null); // "col,row"

  // Zoom and pan state
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState<Point>({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef<Point>({ x: 0, y: 0 });
  const panOffsetStart = useRef<Point>({ x: 0, y: 0 });

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

  const viewBox = useMemo(() => {
    const vw = TOTAL_PIXEL_WIDTH / zoom;
    const vh = BOARD_PIXEL_HEIGHT / zoom;
    return `${panOffset.x} ${panOffset.y} ${vw} ${vh}`;
  }, [zoom, panOffset]);

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
  }, [wires, components]);

  // Compute preview wire path while wiring
  const previewPath = useMemo(() => {
    if (!wiringFrom || !mousePos) return null;
    const fromPos = getEndpointPos(wiringFrom);
    if (!fromPos) return null;
    const midX = mousePos.x;
    const points: Point[] = [fromPos, { x: midX, y: fromPos.y }, { x: midX, y: mousePos.y }, mousePos];
    return pointsToPathD(points);
  }, [wiringFrom, mousePos, components]);

  const getSVGCoords = useCallback((e: React.MouseEvent): Point => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const vw = TOTAL_PIXEL_WIDTH / zoom;
    const vh = BOARD_PIXEL_HEIGHT / zoom;
    return {
      x: panOffset.x + (e.clientX - rect.left) / rect.width * vw,
      y: panOffset.y + (e.clientY - rect.top) / rect.height * vh,
    };
  }, [zoom, panOffset]);

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
      const vw = TOTAL_PIXEL_WIDTH / zoom;
      const vh = BOARD_PIXEL_HEIGHT / zoom;
      const svgX = panOffset.x + (e.clientX - rect.left) / rect.width * vw;
      const svgY = panOffset.y + (e.clientY - rect.top) / rect.height * vh;
      const pos = snapComponentToGrid(svgX, svgY, type, 0);
      if (!isValidPlacement(type, pos, 0)) return;
      onDropComponent(type, pos);
    },
    [onDropComponent, zoom, panOffset]
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
          type: comp.type,
          rotation: comp.rotation,
        };
      }
    },
    [components, getSVGCoords, onSelectComponent, onSelectWire, wiringFrom]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Handle panning
      if (isPanning.current) {
        const svg = svgRef.current!;
        const rect = svg.getBoundingClientRect();
        const vw = TOTAL_PIXEL_WIDTH / zoom;
        const vh = BOARD_PIXEL_HEIGHT / zoom;
        const dx = (e.clientX - panStart.current.x) / rect.width * vw;
        const dy = (e.clientY - panStart.current.y) / rect.height * vh;
        setPanOffset({
          x: panOffsetStart.current.x - dx,
          y: panOffsetStart.current.y - dy,
        });
        return;
      }

      const coords = getSVGCoords(e);
      if (wiringFrom) {
        setMousePos(coords);
      }
      if (dragRef.current) {
        const pos = snapComponentToGrid(
          coords.x - dragRef.current.offsetX,
          coords.y - dragRef.current.offsetY,
          dragRef.current.type,
          dragRef.current.rotation,
        );
        if (!isValidPlacement(dragRef.current.type, pos, dragRef.current.rotation)) return;
        onMoveComponent(dragRef.current.id, pos);
      }
    },
    [getSVGCoords, onMoveComponent, wiringFrom, zoom]
  );

  const handleMouseUp = useCallback(() => {
    if (dragRef.current) {
      onMoveEnd();
    }
    dragRef.current = null;
    isPanning.current = false;
  }, [onMoveEnd]);

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
    // Ctrl+click to pan
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      isPanning.current = true;
      panStart.current = { x: e.clientX, y: e.clientY };
      panOffsetStart.current = { ...panOffset };
      return;
    }

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
  }, [onSelectComponent, onSelectWire, wiringFrom, onStartWire, panOffset]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();

    // Mouse position in SVG coords before zoom
    const vw = TOTAL_PIXEL_WIDTH / zoom;
    const vh = BOARD_PIXEL_HEIGHT / zoom;
    const mx = panOffset.x + (e.clientX - rect.left) / rect.width * vw;
    const my = panOffset.y + (e.clientY - rect.top) / rect.height * vh;

    // Zoom in/out
    const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newZoom = Math.max(0.3, Math.min(10, zoom * zoomFactor));

    // Adjust pan so the point under the cursor stays fixed
    const newVw = TOTAL_PIXEL_WIDTH / newZoom;
    const newVh = BOARD_PIXEL_HEIGHT / newZoom;
    const cursorFracX = (e.clientX - rect.left) / rect.width;
    const cursorFracY = (e.clientY - rect.top) / rect.height;

    setPanOffset({
      x: mx - cursorFracX * newVw,
      y: my - cursorFracY * newVh,
    });
    setZoom(newZoom);
  }, [zoom, panOffset]);

  const handleBoardPinMouseDown = useCallback(
    (col: number, row: number, e: React.MouseEvent) => {
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

  // Compute highlighted holes for the hovered strip
  const highlightedHoles = useMemo(() => {
    if (!hoveredHole) return null;
    const groupId = pinLookup.get(hoveredHole);
    if (!groupId) return null;
    const pins = pinGroupMap.get(groupId);
    if (!pins) return null;
    return pins.map(({ col, row }) => {
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
  }, [hoveredHole, pinLookup, pinGroupMap]);

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
        } else if (isPositiveRail) {
          color = '#ef444466';
          strokeColor = '#ef444455';
        } else if (isNegativeRail) {
          color = '#3b82f666';
          strokeColor = '#3b82f655';
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
              stroke="#b0a898" strokeWidth={1} opacity={0.4}
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
              stroke="#ef4444" strokeWidth={1} opacity={0.15}
            />
          );
          const np1 = gridToPixel(railCol + 1, startRow);
          const np2 = gridToPixel(railCol + 1, endRow);
          traces.push(
            <line
              key={`trace-rail-neg-${bi}-${railCol}-${g}`}
              x1={np1.x} y1={np1.y} x2={np2.x} y2={np2.y}
              stroke="#3b82f6" strokeWidth={1} opacity={0.15}
            />
          );
          for (let r = startRow; r <= endRow; r++) {
            const lp = gridToPixel(railCol, r);
            const rp = gridToPixel(railCol + 1, r);
            traces.push(
              <line
                key={`trace-rail-h-${bi}-${railCol}-${r}`}
                x1={lp.x} y1={lp.y} x2={rp.x} y2={rp.y}
                stroke="#b0a898" strokeWidth={0.5} opacity={0.3}
              />
            );
          }
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
    <svg
      ref={svgRef}
      className="breadboard-svg"
      viewBox={viewBox}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
      onMouseDown={handleBoardMouseDown}
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
        const isSelected = comp.id === selectedComponentId;
        const ledColorMap: Record<string, string> = {
          red: '#ef4444', green: '#22c55e', blue: '#3b82f6', yellow: '#eab308',
          white: '#f1f5f9', orange: '#f97316', purple: '#a855f7',
        };
        const ledColor = comp.type === 'led'
          ? ledColorMap[comp.properties.color as string] || def.color
          : def.color;
        const ledBrightness = comp.type === 'led' ? Number(comp.state?.brightness ?? 0) : 0;
        const isLedOn = ledBrightness > 0;
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
                onToggleSwitch(comp.id);
                onSelectComponent(comp.id);
                onSelectWire(null);
                return;
              }
              handleComponentMouseDown(e, comp.id);
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
                  {/* Color bands */}
                  {isVert ? (
                    <>
                      <line x1={bx + 2} y1={by + bodyH * 0.2} x2={bx + bodyW - 2} y2={by + bodyH * 0.2} stroke="#5c4a0e" strokeWidth={2} />
                      <line x1={bx + 2} y1={by + bodyH * 0.4} x2={bx + bodyW - 2} y2={by + bodyH * 0.4} stroke="#1a1a1a" strokeWidth={2} />
                      <line x1={bx + 2} y1={by + bodyH * 0.6} x2={bx + bodyW - 2} y2={by + bodyH * 0.6} stroke="#b91c1c" strokeWidth={2} />
                      <line x1={bx + 2} y1={by + bodyH * 0.8} x2={bx + bodyW - 2} y2={by + bodyH * 0.8} stroke="#d4af37" strokeWidth={1.5} />
                    </>
                  ) : (
                    <>
                      <line x1={bx + bodyW * 0.2} y1={by + 2} x2={bx + bodyW * 0.2} y2={by + bodyH - 2} stroke="#5c4a0e" strokeWidth={2} />
                      <line x1={bx + bodyW * 0.4} y1={by + 2} x2={bx + bodyW * 0.4} y2={by + bodyH - 2} stroke="#1a1a1a" strokeWidth={2} />
                      <line x1={bx + bodyW * 0.6} y1={by + 2} x2={bx + bodyW * 0.6} y2={by + bodyH - 2} stroke="#b91c1c" strokeWidth={2} />
                      <line x1={bx + bodyW * 0.8} y1={by + 2} x2={bx + bodyW * 0.8} y2={by + bodyH - 2} stroke="#d4af37" strokeWidth={1.5} />
                    </>
                  )}
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
            })() : comp.type === 'led' ? (
              <>
                {isLedOn && (
                  <circle cx={w / 2} cy={h / 2} r={w / 2 + 4 + 6 * ledBrightness} fill={ledColor} opacity={0.2 + 0.5 * ledBrightness} />
                )}
                <circle
                  cx={w / 2}
                  cy={h / 2}
                  r={w / 2 - 1}
                  fill={ledColor}
                  stroke={ledColor}
                  strokeWidth={1.5}
                />
              </>
            ) : comp.type === 'potentiometer' ? (() => {
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
              const sw = w - pad * 2; // segment area width
              const sh = (dh - pad * 2) * 0.48; // half height
              const t = 1.5;
              const ox = pad;
              const oy = pad + 2;
              return (
                <>
                  <rect width={w} height={h} fill="#1a1a1a" stroke="#333" strokeWidth={1} rx={2} />
                  {/* Display window */}
                  <rect x={2} y={2} width={w - 4} height={dh} fill="#0a0a0a" rx={1} />
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
                  <text x={4} y={h * 0.9 + 1} fill="#999" fontSize={3} pointerEvents="none">1 e</text>
                  <text x={4} y={h * 0.7 + 1} fill="#999" fontSize={3} pointerEvents="none">2 d</text>
                  <text x={4} y={h * 0.5 + 1} fill="#999" fontSize={3} pointerEvents="none">3 ⏚</text>
                  <text x={4} y={h * 0.3 + 1} fill="#999" fontSize={3} pointerEvents="none">4 c</text>
                  <text x={4} y={h * 0.1 + 1} fill="#999" fontSize={3} pointerEvents="none">5 dp</text>
                  <text x={w - 4} y={h * 0.9 + 1} fill="#999" fontSize={3} textAnchor="end" pointerEvents="none">b 6</text>
                  <text x={w - 4} y={h * 0.7 + 1} fill="#999" fontSize={3} textAnchor="end" pointerEvents="none">a 7</text>
                  <text x={w - 4} y={h * 0.5 + 1} fill="#999" fontSize={3} textAnchor="end" pointerEvents="none">V+ 8</text>
                  <text x={w - 4} y={h * 0.3 + 1} fill="#999" fontSize={3} textAnchor="end" pointerEvents="none">f 9</text>
                  <text x={w - 4} y={h * 0.1 + 1} fill="#999" fontSize={3} textAnchor="end" pointerEvents="none">g 10</text>
                </>
              );
            })() : comp.type === 'ledmatrix' ? (() => {
              // 5x7 LED Matrix
              const matrixColorMap: Record<string, string> = {
                red: '#ef4444', green: '#22c55e', blue: '#3b82f6', yellow: '#eab308',
                white: '#f1f5f9', orange: '#f97316',
              };
              const matOnColor = matrixColorMap[comp.properties.color as string] || '#ef4444';
              const matOffColor = '#1a0a0a';
              const padX = 6;
              const padY = 4;
              const displayW = w - padX * 2;
              const displayH = h * 0.65;
              const dotW = displayW / 5;
              const dotH = displayH / 7;
              const dotR = Math.min(dotW, dotH) * 0.3;
              return (
                <>
                  <rect width={w} height={h} fill="#1a1a1a" stroke="#333" strokeWidth={1} rx={2} />
                  {/* Display window */}
                  <rect x={padX - 2} y={padY - 2} width={displayW + 4} height={displayH + 4} fill="#0a0a0a" rx={1} />
                  {/* LED dots (5 cols x 7 rows) */}
                  {Array.from({ length: 5 }).map((_, c) =>
                    Array.from({ length: 7 }).map((_, r) => {
                      const isOn = comp.state?.[`led_${c}_${r}`];
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

            {/* Generic DIP chip rendering for all IC category components */}
            {def.category === 'active' && comp.type !== 'display7seg' && comp.type !== 'ledmatrix' && (() => {
              const leftPins = def.pins.filter((p) => p.side === 'left');
              const rightPins = def.pins.filter((p) => p.side === 'right');
              const totalPins = leftPins.length + rightPins.length;
              const fontSize = totalPins <= 8 ? 3.5 : totalPins <= 12 ? 3 : 2.5;
              const inset = totalPins <= 8 ? 5 : 4;
              const notchR = totalPins <= 8 ? 3 : 2;

              // Number pins: left bottom-to-top = 1..N, right bottom-to-top = N+1..2N
              const leftSorted = [...leftPins].sort((a, b) => b.offset - a.offset);
              const rightSorted = [...rightPins].sort((a, b) => b.offset - a.offset);

              return (
                <>
                  {/* Pin 1 notch */}
                  <circle cx={w / 2} cy={h} r={notchR} fill="#0f172a" stroke="#888" strokeWidth={0.5} opacity={0.6} />
                  {/* Left pin labels */}
                  {leftSorted.map((pin, i) => (
                    <text key={pin.id} x={inset} y={h * pin.offset + 0.5} fill="#c0c0c0" fontSize={fontSize} pointerEvents="none">
                      {i + 1} {pin.label}
                    </text>
                  ))}
                  {/* Right pin labels */}
                  {rightSorted.map((pin, i) => (
                    <text key={pin.id} x={w - inset} y={h * pin.offset + 0.5} fill="#c0c0c0" fontSize={fontSize} textAnchor="end" pointerEvents="none">
                      {pin.label} {leftSorted.length + i + 1}
                    </text>
                  ))}
                  {/* Chip name */}
                  <text x={w / 2} y={h / 2 + 1} textAnchor="middle" fill="#e2e8f0" fontSize={fontSize + 1} fontWeight="600" pointerEvents="none">
                    {def.label}
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

            {/* Label (skip for components with custom rendering) */}
            {comp.type !== 'led' && comp.type !== 'resistor' && comp.type !== 'capacitor' && comp.type !== 'switch' && comp.type !== 'potentiometer' && comp.type !== 'display7seg' && comp.type !== 'multimeter' && def.category !== 'active' && (
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
                {comp.properties.resistance}{def.properties?.resistance?.unit || 'Ω'}
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
                {comp.properties.capacitance}{def.properties?.capacitance?.unit || 'μF'}
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

              // Generic pin label placement: always inside component, inset from pin
              const showLabel = def.category !== 'active' && comp.type !== 'switch';
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
          </g>
        );
      })}

      {/* Simulation readouts — rendered on top of everything */}
      {simRunning && components.map((comp) => {
        if (comp.type === 'power' || comp.type === 'multimeter' || comp.type === 'display7seg' || comp.type === 'ledmatrix'
          || comp.type.startsWith('gate_') || comp.type === 'opamp' || comp.type === 'cd4026' || comp.type === 'atmega328') return null;
        const def = COMPONENT_DEFINITIONS[comp.type];
        if (!def) return null;
        const { w, h } = getRenderedSize(def, comp.rotation);

        const voltage = Number(comp.state?.voltage ?? 0);
        const current = Number(comp.state?.current ?? 0);
        if (Math.abs(voltage) < 0.001 && Math.abs(current) < 0.001) return null;

        const formatV = (v: number) => {
          const av = Math.abs(v);
          if (av < 0.01) return '0V';
          if (av < 1) return (v * 1000).toFixed(0) + 'mV';
          return v.toFixed(2) + 'V';
        };
        const formatI = (i: number) => {
          const ai = Math.abs(i);
          if (ai < 0.0001) return '';
          if (ai < 0.001) return (i * 1e6).toFixed(0) + 'μA';
          if (ai < 1) return (i * 1000).toFixed(1) + 'mA';
          return i.toFixed(2) + 'A';
        };

        const vStr = formatV(voltage);
        const iStr = formatI(current);
        const label = iStr ? `${vStr} ${iStr}` : vStr;

        return (
          <text
            key={`readout-${comp.id}`}
            x={comp.position.x + w / 2}
            y={comp.position.y + h + 7}
            textAnchor="middle"
            fill="#1e293b"
            fontSize={4}
            fontWeight="600"
            pointerEvents="none"
          >
            {label}
          </text>
        );
      })}
    </svg>
  );
}
