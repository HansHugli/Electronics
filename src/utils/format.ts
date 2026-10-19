/**
 * Format a numeric value with engineering/SI prefixes.
 *
 *   formatValue(47000, 'Ω')   → "47kΩ"
 *   formatValue(0.001, 'F')   → "1mF"
 *   formatValue(2200, 'Ω')    → "2.2kΩ"
 *   formatValue(100, 'μF')    → "100μF"
 *   formatValue(0.047, 'F', -6)  → "47nF"  (value given in μF)
 *   formatValue(999.7, 'Ω')   → "1kΩ"   (rounding never prints "1000")
 *
 * @param value     The numeric value to format
 * @param unit      The unit suffix (e.g. 'Ω', 'F', 'V', 'A', 'Hz')
 * @param baseExp   Exponent of the unit already applied.
 *                  e.g. if value is in μF, baseExp = -6 so 0.047 μF → 47 nF.
 *                  Default 0 (value is in base units).
 */
export function formatValue(value: number, unit: string, baseExp = 0): string {
  if (!Number.isFinite(value)) return `${value > 0 ? '' : value < 0 ? '-' : ''}${Number.isNaN(value) ? '?' : '∞'}${unit}`;
  if (value === 0) return `0${unit}`;

  // Convert to base unit
  const abs = Math.abs(value) * Math.pow(10, baseExp);
  const sign = value < 0 ? '-' : '';

  for (let i = 0; i < PREFIXES.length; i++) {
    const [threshold, prefix] = PREFIXES[i];
    if (abs >= threshold * 0.9995) {
      const scaled = abs / threshold;
      const formatted = smartRound(scaled);
      // Rounding can push the value to the next prefix (999.7 → "1000").
      if (Number(formatted) >= 1000 && i > 0) {
        const [upThreshold, upPrefix] = PREFIXES[i - 1];
        return `${sign}${smartRound(abs / upThreshold)}${upPrefix}${unit}`;
      }
      return `${sign}${formatted}${prefix}${unit}`;
    }
  }

  // Smaller than pico — use scientific
  return `${sign}${abs.toExponential(1)}${unit}`;
}

const PREFIXES: [number, string][] = [
  [1e12, 'T'],
  [1e9,  'G'],
  [1e6,  'M'],
  [1e3,  'k'],
  [1,    ''],
  [1e-3, 'm'],
  [1e-6, 'μ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
];

/** Round to at most 3 significant figures, drop trailing zeros. */
function smartRound(v: number): string {
  if (v >= 99.95) return Math.round(v).toString();
  if (v >= 9.995) return parseFloat(v.toFixed(1)).toString();
  return parseFloat(v.toFixed(2)).toString();
}

/**
 * Format a voltage for display.
 *   formatVoltage(3.3)     → "3.3V"
 *   formatVoltage(0.005)   → "5mV"
 *   formatVoltage(0.0005)  → "500μV"
 *   formatVoltage(0)       → "0V"
 */
export function formatVoltage(v: number): string {
  if (Math.abs(v) < 1e-6) return '0V';
  return formatValue(v, 'V');
}

/**
 * Format a current for display.
 *   formatCurrent(0.015)    → "15mA"
 *   formatCurrent(0.00023)  → "230μA"
 *   formatCurrent(50e-6)    → "50μA"
 *   formatCurrent(0)        → ""   (no current: nothing to show)
 *
 * Currents below 10 nA are leakage of the solver's numerical stabilisers and
 * are shown as no current.
 */
export function formatCurrent(i: number): string {
  if (!Number.isFinite(i) || Math.abs(i) < 1e-8) return '';
  return formatValue(i, 'A');
}

const SI_MULTIPLIERS: Record<string, number> = {
  T: 1e12, G: 1e9, M: 1e6, meg: 1e6, MEG: 1e6, k: 1e3, K: 1e3,
  m: 1e-3, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, n: 1e-9, p: 1e-12,
};

/** Unit words and symbols that may follow the number; they don't change the value. */
const UNIT_SUFFIX = /(ohms?|Ω|ω|r|R|f|F|farads?|v|V|volts?|a|A|amps?|hz|Hz|HZ|s|sec|%)$/;

/**
 * Parse a value typed with an SI prefix and an optional unit.
 *
 *   parseSI("4.7k")   → 4700
 *   parseSI("4k7")    → 4700     (resistor code: the prefix marks the decimal point)
 *   parseSI("100n")   → 1e-7
 *   parseSI("2.2 MΩ") → 2200000
 *   parseSI("10uF")   → 1e-5
 *   parseSI("1e3")    → 1000
 *   parseSI("-5V")    → -5
 *   parseSI("")       → null     (empty or not a number)
 *
 * "M" is mega and "m" is milli; "meg" is also accepted for mega. Returns the
 * value in base units, or null when the text is not a number.
 */
export function parseSI(text: string): number | null {
  if (typeof text !== 'string') return null;
  let s = text.trim().replace(/,/g, '.').replace(/\s+/g, '');
  if (s === '') return null;

  // Strip a trailing unit ("Ω", "F", "Hz", "ohm"...), but keep a prefix letter
  // that is also a unit-like letter only when something numeric precedes it.
  const unit = s.match(UNIT_SUFFIX);
  if (unit && unit.index !== undefined && unit.index > 0) {
    const rest = s.slice(0, unit.index);
    // "4.7mF": strip "F", keep "m". "5m": "m" is a prefix, not stripped (no unit match for m).
    if (/[0-9.]$/.test(rest) || /(T|G|M|meg|MEG|k|K|m|u|µ|μ|n|p)$/.test(rest)) s = rest;
  }

  // Resistor code: digits, prefix letter, digits ("4k7", "2M2", "1R5" handled by R above).
  const rkm = s.match(/^([+-]?)(\d+)(T|G|M|k|K|m|u|µ|μ|n|p|R|r)(\d+)$/);
  if (rkm) {
    const [, sign, whole, p, frac] = rkm;
    const mult = p === 'R' || p === 'r' ? 1 : SI_MULTIPLIERS[p];
    const v = Number(`${whole}.${frac}`) * mult;
    return sign === '-' ? -v : v;
  }

  const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(meg|MEG|T|G|M|k|K|m|u|µ|μ|n|p)?$/);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return null;
  const mult = m[2] ? SI_MULTIPLIERS[m[2]] : 1;
  const v = num * mult;
  // Clean floating-point noise such as 4.7 * 1000 = 4700.000000000001.
  return Number(v.toPrecision(12));
}
