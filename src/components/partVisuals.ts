import { PlacedComponent } from '../types';

/** One colour band on a resistor. */
export interface Band {
  name: string;
  color: string;
}

const DIGIT_BANDS: Band[] = [
  { name: 'black', color: '#1a1a1a' },
  { name: 'brown', color: '#7c3f00' },
  { name: 'red', color: '#d32f2f' },
  { name: 'orange', color: '#f57c00' },
  { name: 'yellow', color: '#fbc02d' },
  { name: 'green', color: '#2e7d32' },
  { name: 'blue', color: '#1565c0' },
  { name: 'violet', color: '#7b1fa2' },
  { name: 'grey', color: '#8a8a8a' },
  { name: 'white', color: '#f5f5f5' },
];
const GOLD: Band = { name: 'gold', color: '#d4af37' };
const SILVER: Band = { name: 'silver', color: '#c0c0c0' };

function multiplierBand(exp: number): Band {
  if (exp === -1) return GOLD;
  if (exp === -2) return SILVER;
  return DIGIT_BANDS[exp];
}

/**
 * The four colour bands of a 5 % resistor: two digits, a multiplier, and the
 * gold tolerance band. 4.7 kΩ → yellow, violet, red, gold.
 * Returns null for values a 4-band code can't show (≤ 0, < 0.1 Ω, > 99 GΩ).
 */
export function resistorBands(ohms: number): Band[] | null {
  if (!Number.isFinite(ohms) || ohms <= 0) return null;
  let exp = Math.floor(Math.log10(ohms)) - 1;
  let sig = Math.round(ohms / Math.pow(10, exp));
  if (sig >= 100) { sig = Math.round(sig / 10); exp += 1; }
  if (sig < 10) { sig *= 10; exp -= 1; }
  if (exp < -2 || exp > 9) return null;
  return [DIGIT_BANDS[Math.floor(sig / 10)], DIGIT_BANDS[sig % 10], multiplierBand(exp), GOLD];
}

/** The warning codes the engine reports (shared contract). */
export type WarningCode =
  | 'led_reversed' | 'led_overcurrent' | 'short_circuit' | 'floating_input'
  | 'unpowered' | 'overcurrent' | 'no_ground' | string;

export interface PartWarning {
  code: WarningCode;
  message: string;
}

/** The engine's `state.warning` for a part, if it has a well-formed one. */
export function getWarning(comp: PlacedComponent): PartWarning | null {
  const w = (comp.state as Record<string, unknown> | undefined)?.warning;
  if (!w || typeof w !== 'object') return null;
  const { code, message } = w as { code?: unknown; message?: unknown };
  if (typeof message !== 'string' || !message) return null;
  return { code: typeof code === 'string' ? code : 'unknown', message };
}

/**
 * LED brightness 0..1 from the engine's `state.brightness`. Older engines
 * only reported on/off, so any positive value that isn't a fraction counts
 * as fully on.
 */
export function ledBrightness(comp: PlacedComponent): number {
  const b = Number(comp.state?.brightness ?? 0);
  if (!Number.isFinite(b) || b <= 0) return 0;
  return Math.min(1, b);
}
