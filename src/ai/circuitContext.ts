import type { ComponentDefinition, PlacedComponent, Wire } from '../types';

/**
 * What the assistant sees of the circuit and the catalog. Pure functions:
 * the grid constants and definitions are passed in.
 */

export interface Grid {
  GRID_W: number;
  GRID_H: number;
  BOARD_X_OFFSET: number;
}

/** Offset of the first pin inside the component, in pixels (unrotated). */
export function firstPinOffset(def: ComponentDefinition, grid: Grid): { x: number; y: number } {
  const pin0 = def.pins[0];
  const w = def.width * grid.GRID_W;
  const h = def.height * grid.GRID_H;
  if (!pin0) return { x: 0, y: 0 };
  switch (pin0.side) {
    case 'left': return { x: 0, y: h * pin0.offset };
    case 'right': return { x: w, y: h * pin0.offset };
    case 'top': return { x: w * pin0.offset, y: 0 };
    case 'bottom': return { x: w * pin0.offset, y: h };
  }
}

/** Pixel position for a component whose first pin lands on hole (col,row). */
export function positionForGrid(def: ComponentDefinition, col: number, row: number, grid: Grid): { x: number; y: number } {
  const off = firstPinOffset(def, grid);
  return {
    x: grid.BOARD_X_OFFSET + col * grid.GRID_W + grid.GRID_W / 2 - off.x,
    y: row * grid.GRID_H + grid.GRID_H / 2 - off.y,
  };
}

/** The (col,row) hole under a component's first pin: the inverse of positionForGrid. */
export function gridOf(comp: PlacedComponent, def: ComponentDefinition | undefined, grid: Grid): { col: number; row: number } {
  const off = def ? firstPinOffset(def, grid) : { x: 0, y: 0 };
  return {
    col: Math.round((comp.position.x + off.x - grid.BOARD_X_OFFSET - grid.GRID_W / 2) / grid.GRID_W),
    row: Math.round((comp.position.y + off.y - grid.GRID_H / 2) / grid.GRID_H),
  };
}

export const MAX_CIRCUIT_CONTEXT_CHARS = 12_000;

/**
 * Compact JSON of the circuit for the model (no live simulation state).
 * When it would be larger than `maxChars`, it is summarised step by step:
 * first wires become counts per component, then components become counts
 * per type, with a note to call list_components for the detail.
 */
export function renderCircuitContext(
  components: PlacedComponent[],
  wires: Wire[],
  selectedId: string | null,
  definitions: Record<string, ComponentDefinition>,
  grid: Grid,
  maxChars = MAX_CIRCUIT_CONTEXT_CHARS,
): string {
  const comps = components.map((c) => {
    const { col, row } = gridOf(c, definitions[c.type], grid);
    const entry: Record<string, unknown> = { id: c.id, type: c.type, col, row };
    if (c.rotation) entry.rotation = c.rotation;
    if (c.properties && Object.keys(c.properties).length) entry.properties = c.properties;
    return entry;
  });
  const full = JSON.stringify({
    selected: selectedId,
    components: comps,
    wires: wires.map((w) => ({ id: w.id, from: `${w.from.componentId}.${w.from.pinId}`, to: `${w.to.componentId}.${w.to.pinId}` })),
  });
  if (full.length <= maxChars) return full;

  const wireCount = new Map<string, number>();
  for (const w of wires) {
    for (const id of [w.from.componentId, w.to.componentId]) wireCount.set(id, (wireCount.get(id) ?? 0) + 1);
  }
  const medium = JSON.stringify({
    note: `Summary: the circuit is large (${components.length} components, ${wires.length} wires). Wires are shown as counts; call list_components for every wire.`,
    selected: selectedId,
    components: comps.map((c) => ({ ...c, wires: wireCount.get(c.id as string) ?? 0 })),
    boardWires: wireCount.get('board') ?? 0,
  });
  if (medium.length <= maxChars) return medium;

  const byType = new Map<string, number>();
  for (const c of components) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
  return JSON.stringify({
    note: `Summary: the circuit is very large (${components.length} components, ${wires.length} wires). Call list_components for IDs, positions and wires.`,
    selected: selectedId,
    componentsByType: Object.fromEntries([...byType.entries()].sort()),
  }).slice(0, maxChars);
}

/** One line per type (sorted, so the system prompt stays byte-stable). */
export function renderComponentCatalog(definitions: Record<string, ComponentDefinition>): string {
  return Object.values(definitions)
    .slice()
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((def) => {
      const pins = def.pins.map((p) => p.id).join(', ');
      const props = def.properties
        ? Object.entries(def.properties).map(([k, p]) => `${k}=${p.default}${p.unit ?? ''}`).join(', ')
        : '';
      return `- ${def.type}: ${def.label} [${pins}]${props ? ` {${props}}` : ''}${def.description ? ` — ${def.description}` : ''}`;
    })
    .join('\n');
}

/** Detail for list_component_types. */
export function describeComponentType(def: ComponentDefinition, builtin: boolean): Record<string, unknown> {
  return {
    type: def.type,
    label: def.label,
    category: def.category,
    builtin,
    size: { width: def.width, height: def.height },
    pins: def.pins.map((p) => ({ id: p.id, label: p.label, side: p.side, type: p.type })),
    properties: def.properties ?? {},
    description: def.description ?? '',
  };
}
