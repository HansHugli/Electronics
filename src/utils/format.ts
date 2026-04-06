/**
 * Format a numeric value with engineering/SI prefixes.
 *
 *   formatValue(47000, 'Ω')   → "47kΩ"
 *   formatValue(0.001, 'F')   → "1mF"
 *   formatValue(2200, 'Ω')    → "2.2kΩ"
 *   formatValue(100, 'μF')    → "100μF"
 *   formatValue(0.047, 'μF')  → "47nF"  (when baseExp=-6)
 *
 * @param value     The numeric value to format
 * @param unit      The unit suffix (e.g. 'Ω', 'F', 'V', 'A', 'Hz')
 * @param baseExp   Exponent of the unit already applied.
 *                  e.g. if value is in μF, baseExp = -6 so 0.047 μF → 47 nF.
 *                  Default 0 (value is in base units).
 */
export function formatValue(value: number, unit: string, baseExp = 0): string {
  if (value === 0) return `0${unit}`;

  // Convert to base unit
  const abs = Math.abs(value) * Math.pow(10, baseExp);
  const sign = value < 0 ? '-' : '';

  const prefixes: [number, string][] = [
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

  for (const [threshold, prefix] of prefixes) {
    if (abs >= threshold * 0.9999) {
      const scaled = abs / threshold;
      const formatted = smartRound(scaled);
      return `${sign}${formatted}${prefix}${unit}`;
    }
  }

  // Smaller than pico — use scientific
  return `${sign}${abs.toExponential(1)}${unit}`;
}

/** Round to at most 3 significant figures, drop trailing zeros. */
function smartRound(v: number): string {
  if (v >= 100) return Math.round(v).toString();
  if (v >= 10)  return parseFloat(v.toFixed(1)).toString();
  return parseFloat(v.toFixed(2)).toString();
}

/**
 * Format a voltage for display.
 *   formatVoltage(3.3)    → "3.3V"
 *   formatVoltage(0.005)  → "5mV"
 *   formatVoltage(0)      → "0V"
 */
export function formatVoltage(v: number): string {
  if (Math.abs(v) < 0.001) return '0V';
  return formatValue(v, 'V');
}

/**
 * Format a current for display.
 *   formatCurrent(0.015)    → "15mA"
 *   formatCurrent(0.00023)  → "230μA"
 *   formatCurrent(0)        → ""
 */
export function formatCurrent(i: number): string {
  if (Math.abs(i) < 0.0001) return '';
  return formatValue(i, 'A');
}
