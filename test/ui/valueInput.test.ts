import { describe, it, expect } from 'vitest';
import { parseSI, parseValueInput, formatValueInput, formatSIShort } from '../../src/components/valueInput';

describe('parseSI (local fallback of the shared contract)', () => {
  it.each([
    ['4.7k', 4700], ['100n', 1e-7], ['1M', 1e6], ['2.2µ', 2.2e-6], ['2.2u', 2.2e-6], ['2.2μ', 2.2e-6],
    ['10', 10], ['  15 ', 15], ['1e3', 1000], ['.5', 0.5], ['-3', -3], ['5m', 0.005], ['3p', 3e-12], ['1G', 1e9],
  ])('%s → %s', (text, expected) => {
    expect(parseSI(text)).toBeCloseTo(expected, 15);
  });

  it.each(['', 'k', 'abc', '1..2', '4.7kk', '1 k 2'])('rejects %j', (text) => {
    expect(parseSI(text)).toBeNull();
  });
});

describe('parseValueInput (properties panel)', () => {
  it('reads SI shorthand for ohms', () => {
    expect(parseValueInput('4.7k', 'Ω')).toEqual({ ok: true, value: 4700 });
    expect(parseValueInput('1k', 'Ω')).toEqual({ ok: true, value: 1000 });
    expect(parseValueInput('10M', 'Ω')).toEqual({ ok: true, value: 1e7 });
    expect(parseValueInput('4.7kΩ', 'Ω')).toEqual({ ok: true, value: 4700 });
    expect(parseValueInput('220 ohm', 'Ω')).toEqual({ ok: true, value: 220 });
  });

  it('a capacitor value with a prefix is absolute; a plain number is in μF', () => {
    expect(parseValueInput('100n', 'μF')).toEqual({ ok: true, value: 0.1 });
    expect(parseValueInput('100nF', 'μF')).toEqual({ ok: true, value: 0.1 });
    expect(parseValueInput('2.2u', 'μF')).toEqual({ ok: true, value: 2.2 });
    expect(parseValueInput('470', 'μF')).toEqual({ ok: true, value: 470 });
  });

  it('frequencies and clocks', () => {
    expect(parseValueInput('16M', 'Hz')).toEqual({ ok: true, value: 16e6 });
    expect(parseValueInput('1kHz', 'Hz')).toEqual({ ok: true, value: 1000 });
  });

  it('never turns an empty or bad field into 0', () => {
    expect(parseValueInput('', 'Ω').ok).toBe(false);
    expect(parseValueInput('   ', 'V').ok).toBe(false);
    expect(parseValueInput('1x', 'Ω').ok).toBe(false);
  });

  it('rejects zero and negative resistance, capacitance and frequency', () => {
    expect(parseValueInput('0', 'Ω').ok).toBe(false);
    expect(parseValueInput('-100', 'μF').ok).toBe(false);
    expect(parseValueInput('0', 'Hz').ok).toBe(false);
    // Voltages may be zero or negative.
    expect(parseValueInput('-5', 'V')).toEqual({ ok: true, value: -5 });
    expect(parseValueInput('0', 'V')).toEqual({ ok: true, value: 0 });
  });
});

describe('formatValueInput', () => {
  it('shows ohms and hertz in shorthand, other units as plain numbers', () => {
    expect(formatValueInput(4700, 'Ω')).toBe('4.7k');
    expect(formatValueInput(220, 'Ω')).toBe('220');
    expect(formatValueInput(16000000, 'Hz')).toBe('16M');
    expect(formatValueInput(100, 'μF')).toBe('100');
    expect(formatValueInput(2, 'V')).toBe('2');
  });

  it('keeps precision (1234 Ω stays 1.234k, not 1.23k)', () => {
    expect(formatSIShort(1234)).toBe('1.234k');
    expect(parseValueInput(formatSIShort(1234), 'Ω')).toEqual({ ok: true, value: 1234 });
  });
});
