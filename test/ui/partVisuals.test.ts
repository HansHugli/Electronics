import { describe, it, expect } from 'vitest';
import { resistorBands, getWarning, ledBrightness } from '../../src/components/partVisuals';
import type { PlacedComponent } from '../../src/types';

const names = (ohms: number) => resistorBands(ohms)?.map((b) => b.name);

describe('resistor colour bands', () => {
  it.each([
    [220, ['red', 'red', 'brown', 'gold']],
    [1000, ['brown', 'black', 'red', 'gold']],
    [4700, ['yellow', 'violet', 'red', 'gold']],
    [10000, ['brown', 'black', 'orange', 'gold']],
    [1e6, ['brown', 'black', 'green', 'gold']],
    [10, ['brown', 'black', 'black', 'gold']],
    [4.7, ['yellow', 'violet', 'gold', 'gold']],
    [0.1, ['brown', 'black', 'silver', 'gold']],
    [330, ['orange', 'orange', 'brown', 'gold']],
    [1, ['brown', 'black', 'gold', 'gold']],
  ])('%s Ω → %j', (ohms, expected) => {
    expect(names(ohms)).toEqual(expected);
  });

  it('rounds to two significant digits (2345 Ω → 2.3 kΩ)', () => {
    expect(names(2345)).toEqual(['red', 'orange', 'red', 'gold']);
    expect(names(999)).toEqual(['brown', 'black', 'red', 'gold']); // rounds up to 1.0k
  });

  it('has no bands for impossible values', () => {
    expect(resistorBands(0)).toBeNull();
    expect(resistorBands(-5)).toBeNull();
    expect(resistorBands(NaN)).toBeNull();
    expect(resistorBands(0.01)).toBeNull();
  });
});

const comp = (state: Record<string, unknown>): PlacedComponent =>
  ({ id: 'c', type: 'led', position: { x: 0, y: 0 }, rotation: 0, properties: {}, state } as unknown as PlacedComponent);

describe('engine warnings and LED brightness (shared contract)', () => {
  it('reads a well-formed warning', () => {
    expect(getWarning(comp({ warning: { code: 'led_reversed', message: 'This LED is in backwards.' } })))
      .toEqual({ code: 'led_reversed', message: 'This LED is in backwards.' });
  });

  it('ignores missing or malformed warnings', () => {
    expect(getWarning(comp({}))).toBeNull();
    expect(getWarning(comp({ warning: 'oops' }))).toBeNull();
    expect(getWarning(comp({ warning: { code: 'x' } }))).toBeNull();
  });

  it('clamps brightness to 0..1', () => {
    expect(ledBrightness(comp({ brightness: 0.4 }))).toBe(0.4);
    expect(ledBrightness(comp({ brightness: 3 }))).toBe(1);
    expect(ledBrightness(comp({ brightness: -1 }))).toBe(0);
    expect(ledBrightness(comp({}))).toBe(0);
  });
});
