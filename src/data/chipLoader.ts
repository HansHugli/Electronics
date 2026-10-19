import { ComponentDefinition, Pin } from '../types';
import { COMPONENT_DEFINITIONS } from './components';

/**
 * External chip definition JSON format.
 *
 * Example:
 * {
 *   "type": "my_and",
 *   "label": "My AND",
 *   "package": "DIP-14",
 *   "category": "active",
 *   "behavior": "logic_and",
 *   "color": "#4a4a4a",
 *   "pins": [
 *     { "number": 1, "id": "1a", "label": "1A", "side": "left", "type": "input" },
 *     ...
 *   ]
 * }
 *
 * `offset` may be omitted when `number` is given: DIP pins are then laid out
 * like a real chip (pin 1 top-left, counting down the left side and back up
 * the right side).
 *
 * `behavior` picks a built-in simulation model; the chip's pin ids must then
 * match that model's pin ids (see BEHAVIOR_MODELS). 'passthrough' (or any
 * unknown name) means the part is drawn and wired but not simulated.
 */
export interface ChipDefinitionJSON {
  type: string;
  label: string;
  description?: string;   // short blurb for sidebar
  icon?: string;          // 1-3 char icon for sidebar card
  chipLabel?: string;     // short label for chip body on breadboard
  package?: string;       // e.g. "DIP-8", "DIP-14", "DIP-28"
  category?: string;      // defaults to 'active'
  behavior: string;       // built-in model name: 'logic_and', 'logic_or', 'timer555', 'counter', 'opamp', 'passthrough', etc.
  color?: string;         // defaults to '#4a4a4a'
  width?: number;         // grid units, auto-calculated from package if omitted
  height?: number;        // grid units, auto-calculated from package if omitted
  pins: ChipPinJSON[];
  properties?: Record<string, { label: string; default: number | string; unit?: string }>;
}

export interface ChipPinJSON {
  number?: number;        // physical pin number (for display)
  id: string;
  label: string;
  side: 'left' | 'right' | 'top' | 'bottom';
  offset: number;         // 0-1 position along the side
  type: 'power' | 'ground' | 'input' | 'output' | 'bidirectional';
}

/**
 * `behavior` names → the built-in component type whose simulation model the
 * chip uses. Built-in type names are accepted as well.
 */
export const BEHAVIOR_MODELS: Record<string, string> = {
  logic_and: 'gate_and',
  and: 'gate_and',
  logic_or: 'gate_or',
  or: 'gate_or',
  logic_nand: 'gate_nand',
  nand: 'gate_nand',
  logic_nor: 'gate_nor',
  nor: 'gate_nor',
  logic_xor: 'gate_xor',
  xor: 'gate_xor',
  logic_not: 'gate_not',
  not: 'gate_not',
  inverter: 'gate_not',
  timer555: 'timer',
  timer: 'timer',
  counter: 'cd4026',
  cd4026: 'cd4026',
  decade_counter: 'cd4026',
  opamp: 'opamp',
  shift_register: 'shift_register',
  '74hc595': 'shift_register',
  dff: 'flipflop_d',
  flipflop: 'flipflop_d',
  flipflop_d: 'flipflop_d',
  regulator: 'vreg',
  vreg: 'vreg',
};

/** Known DIP packages → dimensions in grid units (width always 2 for DIP). */
const PACKAGE_SIZES: Record<string, { width: number; height: number }> = {
  'DIP-8': { width: 2, height: 4 },
  'DIP-14': { width: 2, height: 7 },
  'DIP-16': { width: 2, height: 8 },
  'DIP-18': { width: 2, height: 9 },
  'DIP-20': { width: 2, height: 10 },
  'DIP-24': { width: 2, height: 12 },
  'DIP-28': { width: 2, height: 14 },
  'DIP-40': { width: 2, height: 20 },
};

const SIDES = new Set(['left', 'right', 'top', 'bottom']);
const PIN_TYPES = new Set(['power', 'ground', 'input', 'output', 'bidirectional']);
const CATEGORIES = new Set(['passive', 'active', 'power', 'output', 'input', 'measurement']);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', 'board']);

/**
 * True when a chip type id is safe to use as an object key and as a file name
 * (letters, digits, '_' and '-', 1-64 characters, not a reserved name).
 * Use it before `path.join(dir, `${type}.json`)`.
 */
export function isSafeChipType(type: unknown): type is string {
  return typeof type === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(type) && !RESERVED.has(type);
}

/**
 * Lay out DIP pins like a real chip when the JSON gives a pin number but no
 * offset: pin 1 is top-left, pins 1..N/2 run down the left side, and pins
 * N/2+1..N run back up the right side (counter-clockwise seen from above), so
 * pin N is top-right, across from pin 1.
 */
function autoPinOffset(pin: ChipPinJSON, totalPins: number): number {
  if (typeof pin.offset === 'number' && Number.isFinite(pin.offset)) {
    return Math.min(1, Math.max(0, pin.offset));
  }
  const pinsPerSide = Math.max(1, Math.ceil(totalPins / 2));
  const n = typeof pin.number === 'number' && Number.isFinite(pin.number) ? Math.round(pin.number) : 0;
  if (n < 1 || n > 2 * pinsPerSide) return 0.5;
  if (n <= pinsPerSide) {
    const idx = n - 1; // 0 = top of the left side
    return (2 * idx + 1) / (2 * pinsPerSide);
  }
  const idx = n - pinsPerSide - 1; // 0 = bottom of the right side
  return 1 - (2 * idx + 1) / (2 * pinsPerSide);
}

function clampDim(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(40, Math.max(1, Math.round(v)));
}

/** Pins of one JSON entry that are well-formed (duplicates and junk dropped). */
function cleanPins(raw: unknown): ChipPinJSON[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ChipPinJSON[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const pin = p as Partial<ChipPinJSON>;
    if (typeof pin.id !== 'string' || pin.id.length === 0 || pin.id.length > 32 || seen.has(pin.id)) continue;
    seen.add(pin.id);
    out.push({
      id: pin.id,
      label: typeof pin.label === 'string' ? pin.label.slice(0, 16) : pin.id,
      side: SIDES.has(pin.side as string) ? (pin.side as ChipPinJSON['side']) : ((typeof pin.number === 'number' && pin.number > raw.length / 2) ? 'right' : 'left'),
      offset: pin.offset as number,
      type: PIN_TYPES.has(pin.type as string) ? (pin.type as ChipPinJSON['type']) : 'bidirectional',
      number: typeof pin.number === 'number' && Number.isFinite(pin.number) ? pin.number : undefined,
    });
  }
  return out;
}

/**
 * Convert a chip JSON definition into a ComponentDefinition. Never throws:
 * malformed pins are dropped and nonsense geometry is clamped.
 */
export function chipJSONToDefinition(json: ChipDefinitionJSON): ComponentDefinition {
  const pinsJson = cleanPins(json?.pins);
  const pkg = typeof json?.package === 'string' ? PACKAGE_SIZES[json.package] : undefined;
  const width = clampDim(json?.width, pkg?.width ?? 2);
  const height = clampDim(json?.height, pkg?.height ?? Math.max(1, Math.ceil(pinsJson.length / 2)));

  const pins: Pin[] = pinsJson.map((p) => ({
    id: p.id,
    label: p.label,
    side: p.side,
    offset: autoPinOffset(p, pinsJson.length),
    type: p.type,
    ...(p.number !== undefined ? { number: p.number } : {}),
  }));

  const category = typeof json?.category === 'string' && CATEGORIES.has(json.category)
    ? (json.category as ComponentDefinition['category'])
    : 'active';

  return {
    type: String(json?.type ?? ''),
    label: typeof json?.label === 'string' && json.label ? json.label : String(json?.type ?? 'Chip'),
    description: typeof json?.description === 'string' ? json.description : undefined,
    icon: typeof json?.icon === 'string' ? json.icon : undefined,
    chipLabel: typeof json?.chipLabel === 'string' ? json.chipLabel : undefined,
    category,
    width,
    height,
    color: typeof json?.color === 'string' ? json.color : '#4a4a4a',
    pins,
    properties: json?.properties && typeof json.properties === 'object' && !Array.isArray(json.properties)
      ? json.properties
      : undefined,
    behavior: typeof json?.behavior === 'string' ? json.behavior : undefined,
  };
}

/**
 * Register external chip definitions into the global COMPONENT_DEFINITIONS.
 * Each entry is validated on its own: a malformed entry is skipped (and
 * reported on the console) without stopping the others. Built-in components
 * are never overwritten. Returns the number of chips loaded.
 */
export function registerChips(chipDefs: ChipDefinitionJSON[]): number {
  let count = 0;
  if (!Array.isArray(chipDefs)) return 0;
  for (const json of chipDefs) {
    try {
      if (!json || typeof json !== 'object') continue;
      if (!isSafeChipType(json.type)) {
        console.warn('Skipping chip with an invalid type id:', (json as { type?: unknown }).type);
        continue;
      }
      // Don't overwrite built-in (or already registered) components
      if (Object.prototype.hasOwnProperty.call(COMPONENT_DEFINITIONS, json.type)) continue;
      const def = chipJSONToDefinition(json);
      if (def.pins.length === 0) {
        console.warn(`Skipping chip "${json.type}": it has no valid pins`);
        continue;
      }
      COMPONENT_DEFINITIONS[json.type] = def;
      count++;
    } catch (e) {
      console.warn('Skipping malformed chip definition:', e);
    }
  }
  return count;
}

/**
 * Load chip definitions from the Electron main process.
 * Falls back to bundled chips in browser mode.
 */
export async function loadExternalChips(): Promise<number> {
  if (window.electronApi?.loadChips) {
    try {
      const chips = (await window.electronApi.loadChips()) as ChipDefinitionJSON[];
      return registerChips(chips);
    } catch {
      return 0;
    }
  }
  return 0;
}
