/*
 * TEMPORARY local fallback for parseSI (shared contract): the engine branch
 * exports `parseSI(text): number | null` from src/utils/format.ts. After the
 * merge, delete this function and import parseSI from '../utils/format'.
 */
const SI_PREFIX: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9,
};
export function parseSI(text: string): number | null {
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([pnuµμmkKMG])?\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] ? SI_PREFIX[m[2]] : 1);
  return Number.isFinite(n) ? n : null;
}

/** How a property's unit maps to SI: μF is stored as micro-farads. */
const UNIT_MAP: Record<string, { base: string; exp: number }> = {
  'Ω': { base: 'Ω', exp: 0 },
  'μF': { base: 'F', exp: -6 },
  'V': { base: 'V', exp: 0 },
  'A': { base: 'A', exp: 0 },
  'Hz': { base: 'Hz', exp: 0 },
};

/** Units for which zero or a negative value makes no physical sense. */
const POSITIVE_UNITS = new Set(['Ω', 'μF', 'Hz']);

export function unitInfo(unit: string | undefined) {
  return unit ? UNIT_MAP[unit] : undefined;
}

export type ParsedValue = { ok: true; value: number } | { ok: false; error: string };

/**
 * Parse what the user typed into a numeric property.
 *
 * - "4.7k", "100n", "10M", "2.2µ" / "2.2u": an SI value in the base unit
 *   (Ω, F, Hz…); a trailing unit symbol ("4.7kΩ", "100nF") is accepted.
 * - A plain number ("100") is in the unit shown next to the field (μF for a
 *   capacitor), so 100 means 100 μF.
 * - Empty or unreadable text is an error; it is never stored as 0.
 */
export function parseValueInput(text: string, unit: string | undefined): ParsedValue {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Enter a value.' };
  const info = unitInfo(unit);
  // Drop a trailing unit: "4.7kΩ", "100nF", "1kohm", "5V", "1kHz".
  const body = trimmed.replace(/\s+/g, '').replace(/(ohms?|Ω|hz|f|v|a)$/i, '');
  // Case matters: "m" is milli, "M" is mega.
  const hasPrefix = /[pnuµμmkKMG]$/.test(body);
  const n = parseSI(body);
  if (n === null) {
    return { ok: false, error: `"${trimmed}" isn't a number. Try 220, 4.7k, 100n or 1M.` };
  }
  let value = n;
  if (hasPrefix && info && info.exp !== 0) value = n / Math.pow(10, info.exp);
  // Clean float noise (100n / 1e-6 = 0.09999999999999999).
  value = Number(value.toPrecision(12));
  if (unit && POSITIVE_UNITS.has(unit) && !(value > 0)) {
    return { ok: false, error: 'Must be greater than 0.' };
  }
  return { ok: true, value };
}

/**
 * The text shown in a numeric field. Units without a prefix (Ω, Hz) use SI
 * shorthand ("4.7k", "16M"); μF shows the plain number of micro-farads.
 */
export function formatValueInput(value: number | string, unit: string | undefined): string {
  if (typeof value !== 'number') return String(value);
  if (unit === 'Ω' || unit === 'Hz') return formatSIShort(value);
  return String(value);
}

/** SI shorthand that keeps up to 6 significant digits: 4700 → "4.7k", 1234 → "1.234k". */
export function formatSIShort(value: number): string {
  if (!Number.isFinite(value) || value === 0) return String(value);
  const abs = Math.abs(value);
  const steps: [number, string][] = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
  for (const [scale, prefix] of steps) {
    if (abs >= scale * 0.999999) {
      return `${Number((value / scale).toPrecision(6))}${prefix}`;
    }
  }
  return String(value);
}
