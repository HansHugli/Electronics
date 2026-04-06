import { ComponentDefinition, Pin } from '../types';
import { COMPONENT_DEFINITIONS } from './components';

/**
 * External chip definition JSON format.
 *
 * Example:
 * {
 *   "type": "atmega328",
 *   "label": "ATmega328",
 *   "package": "DIP-28",
 *   "category": "active",
 *   "behavior": "passthrough",
 *   "color": "#4a4a4a",
 *   "width": 2,
 *   "height": 14,
 *   "pins": [
 *     { "number": 1, "id": "pc6", "label": "RST", "side": "left", "offset": 27/28, "type": "input" },
 *     ...
 *   ],
 *   "properties": {
 *     "clockSpeed": { "label": "Clock", "default": 16000000, "unit": "Hz" }
 *   }
 * }
 */
export interface ChipDefinitionJSON {
  type: string;
  label: string;
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

/**
 * Auto-generate pin offsets for a DIP package if offsets are not provided.
 * Pins are numbered 1..N/2 on the left (bottom to top), N/2+1..N on the right (bottom to top).
 */
function autoPinOffset(pin: ChipPinJSON, totalPins: number): number {
  if (pin.offset !== undefined && pin.offset !== null) return pin.offset;
  if (!pin.number) return 0.5;
  const pinsPerSide = totalPins / 2;
  // Pin 1 is at the bottom-left, counting up
  if (pin.side === 'left') {
    const idx = pin.number - 1; // 0-based from bottom
    return (2 * (pinsPerSide - 1 - idx) + 1) / (2 * pinsPerSide);
  } else {
    const idx = pin.number - pinsPerSide - 1; // 0-based from bottom
    return (2 * (pinsPerSide - 1 - idx) + 1) / (2 * pinsPerSide);
  }
}

/**
 * Convert a chip JSON definition into a ComponentDefinition.
 */
export function chipJSONToDefinition(json: ChipDefinitionJSON): ComponentDefinition {
  const pkg = json.package ? PACKAGE_SIZES[json.package] : null;
  const width = json.width ?? pkg?.width ?? 2;
  const height = json.height ?? pkg?.height ?? Math.ceil(json.pins.length / 2);

  const pins: Pin[] = json.pins.map((p) => ({
    id: p.id,
    label: p.label,
    side: p.side,
    offset: autoPinOffset(p, json.pins.length),
    type: p.type,
  }));

  return {
    type: json.type,
    label: json.label,
    category: (json.category as ComponentDefinition['category']) ?? 'active',
    width,
    height,
    color: json.color ?? '#4a4a4a',
    pins,
    properties: json.properties,
  };
}

/**
 * Register external chip definitions into the global COMPONENT_DEFINITIONS.
 * Returns the number of chips loaded.
 */
export function registerChips(chipDefs: ChipDefinitionJSON[]): number {
  let count = 0;
  for (const json of chipDefs) {
    if (!json.type || !json.pins || json.pins.length === 0) continue;
    // Don't overwrite built-in components
    if (COMPONENT_DEFINITIONS[json.type]) continue;
    COMPONENT_DEFINITIONS[json.type] = chipJSONToDefinition(json);
    count++;
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
