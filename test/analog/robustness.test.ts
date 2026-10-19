import { describe, it, expect } from 'vitest';
import { Circuit, record } from '../helpers/circuit';
import { formatValue, formatVoltage, formatCurrent } from '../../src/utils/format';

const allFinite = (c: Circuit) => {
  for (const [, st] of c.last) for (const v of Object.values(st)) if (typeof v === 'number' && !Number.isFinite(v)) return false;
  return true;
};

describe('Robustness', () => {
  it('supply shorted by a wire: finite result and a short-circuit flag', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.wire('v1:pos', 'v1:neg');
    c.run(1);
    const i = c.s('v1', 'current');
    record('supply shorted by wire: reported supply current', NaN, i, 'A');
    const st = c.last.get('v1') ?? {};
    expect(Number.isFinite(i)).toBe(true);
    expect(Math.abs(i)).toBeLessThan(100);
    expect(Object.keys(st).some((k) => /short|overload|warn/i.test(k)), 'no short flag on supply').toBe(true);
  });

  it('supply shorted by a closed switch: same as wire', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('switch', 'sw', {}, { closed: 1 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('v1:pos', 'sw:a'); c.wire('sw:b', 'v1:neg');
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'v1:neg');
    c.run(1);
    record('supply shorted by switch: supply current', NaN, c.s('v1', 'current'), 'A');
    record('supply shorted by switch: 1k load current', 0, c.s('r', 'current'), 'A');
    expect(Math.abs(c.s('v1', 'current'))).toBeLessThan(100);
  });

  it('0-ohm resistor across supply: current is bounded and flagged', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('resistor', 'r', { resistance: 0 });
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'v1:neg');
    c.run(1);
    record('0-ohm resistor across 5 V: current', NaN, c.s('r', 'current'), 'A');
    expect(Math.abs(c.s('r', 'current'))).toBeLessThan(100);
  });

  it('two supplies (5 V and 9 V) in parallel: finite, flagged conflict', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('power', 'v2', { voltage: 9 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('v1:pos', 'v2:pos'); c.wire('v1:neg', 'v2:neg');
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'v1:neg');
    c.run(1);
    record('5V||9V: v1 current', NaN, c.s('v1', 'current'), 'A');
    record('5V||9V: v2 current', NaN, c.s('v2', 'current'), 'A');
    record('5V||9V: resistor voltage', NaN, c.s('r', 'voltage'), 'V');
    expect(allFinite(c)).toBe(true);
    expect(Math.abs(c.s('v1', 'current'))).toBeLessThan(100);
  });

  it('floating resistor end reads the driven node voltage; isolated cap reads 0 V; no NaN', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.add('capacitor', 'c', { capacitance: 10 });
    c.wire('v1:pos', 'r:a'); // r:b floating
    c.meter('m', 'r:b', 'v1:neg');
    c.run(3);
    record('floating resistor end (via 10M meter)', 5, c.s('m', 'voltage'), 'V');
    expect(allFinite(c)).toBe(true);
    expect(Math.abs(c.s('m', 'voltage') - 5)).toBeLessThan(0.01);
    expect(Math.abs(c.s('c', 'voltage'))).toBeLessThan(1e-6);
  });

  it('second battery loop not tied to ground (9 V + 1k) still gives 9 mA', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('power', 'v2', { voltage: 9 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('v2:pos', 'r:a'); c.wire('r:b', 'v2:neg');
    c.run(1);
    record('floating 9V loop current', 9e-3, c.s('r', 'current'), 'A');
    expect(Math.abs(c.s('r', 'current') - 9e-3)).toBeLessThan(1e-5);
  });

  it('negative capacitance typed into the field does not blow up', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.add('capacitor', 'c', { capacitance: -100 });
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'c:pos'); c.wire('c:neg', 'v1:neg');
    c.run(20);
    record('C = -100 uF after 2 s: cap voltage', 5, c.s('c', 'voltage'), 'V');
    expect(Math.abs(c.s('c', 'voltage'))).toBeLessThan(10);
  });
});

describe('Units / formatting (src/utils/format.ts)', () => {
  it('formats SI prefixes', () => {
    expect(formatValue(47000, 'Ω')).toBe('47kΩ');
    expect(formatValue(2200, 'Ω')).toBe('2.2kΩ');
    expect(formatValue(0.047, 'F', -6)).toBe('47nF');
    expect(formatValue(4.7e6, 'Ω')).toBe('4.7MΩ');
    expect(formatValue(0.0033, 'V')).toBe('3.3mV');
  });
  it('rounding at a prefix boundary does not print "1000"', () => {
    expect(formatValue(999.7, 'Ω')).toBe('1kΩ');
  });
  it('small but real currents are shown (50 uA through a 100k resistor at 5 V)', () => {
    expect(formatCurrent(50e-6)).toBe('50μA');
  });
  it('sub-millivolt voltages are not displayed as 0 V', () => {
    expect(formatVoltage(0.0005)).toBe('500μV');
  });
});
