// The engine ↔ UI contract: state.warning codes, state.brightness, firmware
// from properties.hex, parseSI.
import { describe, it, expect } from 'vitest';
import { Circuit } from '../helpers/circuit';
import { Bench, fixture } from '../digital/bench';
import { parseSI } from '../../src/utils/format';

type W = { code: string; message: string } | undefined;
const warn = (c: Circuit | Bench, id: string): W =>
  (c instanceof Circuit ? c.last.get(id) : c.s(id))?.warning as W;

describe('state.warning', () => {
  it('led_overcurrent: an LED straight across 5 V, with a resistor suggestion in plain words', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('led', 'd', { color: 'red' });
    c.wire('v1:pos', 'd:anode'); c.wire('d:cathode', 'v1:neg');
    c.run(1);
    const w = warn(c, 'd');
    expect(w?.code).toBe('led_overcurrent');
    expect(w?.message).toMatch(/drawing \d+ mA — add a resistor of about 150 Ω in series\./);
  });

  it('no warning on a correctly wired LED (5 V, 220 Ω)', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('resistor', 'r', { resistance: 220 });
    c.add('led', 'd');
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'd:anode'); c.wire('d:cathode', 'v1:neg');
    c.run(1);
    expect(warn(c, 'd')).toBe(undefined);
    expect(warn(c, 'v1')).toBe(undefined);
  });

  it('led_reversed: LED put in backwards', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('resistor', 'r', { resistance: 220 });
    c.add('led', 'd');
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'd:cathode'); c.wire('d:anode', 'v1:neg');
    c.run(1);
    expect(warn(c, 'd')?.code).toBe('led_reversed');
  });

  it('no_ground: LED whose − leg is not connected', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('resistor', 'r', { resistance: 220 });
    c.add('led', 'd');
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'd:anode');
    c.run(1);
    expect(warn(c, 'd')?.code).toBe('no_ground');
  });

  it('short_circuit: on the supply, with the current limited to a finite value', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.wire('v1:pos', 'v1:neg');
    c.run(1);
    expect(warn(c, 'v1')?.code).toBe('short_circuit');
    expect(Math.abs(c.s('v1', 'current'))).toBeLessThanOrEqual(1.0001);
  });

  it('short_circuit through an ammeter put across the supply', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 9 });
    c.add('multimeter', 'am', { mode: 'current' });
    c.wire('v1:pos', 'am:pos'); c.wire('am:neg', 'v1:neg');
    c.run(1);
    expect(warn(c, 'v1')?.code).toBe('short_circuit');
  });

  it('floating_input: chip input left open', () => {
    const b = new Bench();
    b.power(); b.add('gate_and', 'u'); b.hi('u.vcc').lo('u.gnd');
    for (const g of ['1', '2', '3', '4']) b.hi(`u.${g}a`).hi(`u.${g}b`);
    b.unrail('u.3b');
    b.tick(2);
    const w = warn(b, 'u');
    expect(w?.code).toBe('floating_input');
    expect(w?.message).toContain('3B');
  });

  it('unpowered: a chip with signals wired but no VCC', () => {
    const b = new Bench();
    b.power(); b.add('gate_not', 'u'); b.lo('u.gnd').hi('u.1a');
    b.tick(2);
    expect(warn(b, 'u')?.code).toBe('unpowered');
    expect(b.s('u')['1y']).toBe(false);
  });

  it('unpowered: an ATmega without GND', () => {
    const b = new Bench();
    b.power(); b.add('atmega328', 'm'); b.hi('m.vcc').hi('m.pc6');
    b.sim.loadAVRProgram('m', fixture('blink1s.hex'));
    b.tick(2);
    expect(warn(b, 'm')?.code).toBe('unpowered');
  });

  it('overcurrent: a gate output driving an LED with no resistor is limited and flagged', () => {
    const b = new Bench();
    b.power(); b.add('gate_not', 'u'); b.hi('u.vcc').lo('u.gnd');
    for (const g of ['1', '2', '3', '4', '5', '6']) b.lo(`u.${g}a`);
    b.add('led', 'd'); b.wire('d.anode', 'u.1y').wire('d.cathode', 'pwr.neg');
    b.tick(2);
    expect(warn(b, 'u')?.code).toBe('overcurrent');
    expect(Number(b.s('d').current)).toBeLessThanOrEqual(0.0251);
  });

  it('warnings disappear once the problem is fixed', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('led', 'd');
    c.add('resistor', 'r', { resistance: 330 });
    c.wire('v1:pos', 'd:anode'); c.wire('d:cathode', 'v1:neg');
    c.run(1);
    expect(warn(c, 'd')?.code).toBe('led_overcurrent');
    c.wires = [];
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'd:anode'); c.wire('d:cathode', 'v1:neg');
    c.run(1);
    expect(warn(c, 'd')).toBe(undefined);
  });
});

describe('state.brightness', () => {
  it('is 0..1, proportional to current, about 1 at 20 mA; `on` still works', () => {
    const at = (r: number) => {
      const c = new Circuit();
      c.add('power', 'v1', { voltage: 5 });
      c.add('resistor', 'r', { resistance: r });
      c.add('led', 'd');
      c.wire('v1:pos', 'r:a'); c.wire('r:b', 'd:anode'); c.wire('d:cathode', 'v1:neg');
      c.run(1);
      return { b: c.s('d', 'brightness'), i: c.s('d', 'current'), on: c.s('d', 'on') };
    };
    const full = at(150), half = at(330), off = at(1e7);
    expect(full.b).toBeGreaterThan(0.95);
    expect(full.b).toBeLessThanOrEqual(1);
    expect(half.b).toBeCloseTo(half.i / 0.02, 6);
    expect(off.b).toBeLessThan(0.01);
    expect(full.on).toBe(1);
    expect(off.on).toBe(0);
  });

  it('7-segment segments are LEDs: brightness and seg_x', () => {
    const b = new Bench();
    b.power(); b.add('display7seg', 'd'); b.add('resistor', 'r', { resistance: 220 });
    b.wire('r.a', 'pwr.pos').wire('r.b', 'd.b').lo('d.gnd');
    b.tick(1);
    expect(Number(b.s('d').seg_b)).toBe(1);
    expect(Number(b.s('d').seg_a)).toBe(0);
    expect(Number(b.s('d').brightness)).toBeGreaterThan(0.5);
  });
});

describe('firmware from properties.hex', () => {
  it('an ATmega runs the Intel HEX stored in comp.properties.hex', () => {
    const b = new Bench();
    b.power();
    b.add('atmega328', 'm', { hex: fixture('blink1s.hex') });
    b.hi('m.vcc').hi('m.avcc').lo('m.gnd').lo('m.agnd').hi('m.pc6');
    b.add('resistor', 'r', { resistance: 220 }); b.add('led', 'L');
    b.wire('m.pb5', 'r.a').wire('r.b', 'L.anode').wire('L.cathode', 'pwr.neg');
    let lit = 0;
    for (let i = 0; i < 25; i++) { b.tick(1); lit += Number(b.s('L').on); }
    expect(b.sim.isAVRLoaded('m')).toBe(true);
    expect(lit).toBeGreaterThan(5);
    expect(lit).toBeLessThan(20);
  });

  it('invalid HEX in properties.hex is reported (firmwareError), not run', () => {
    const b = new Bench();
    b.power();
    b.add('atmega328', 'm', { hex: 'this is not a hex file' });
    b.hi('m.vcc').lo('m.gnd');
    b.tick(1);
    expect(String(b.s('m').firmwareError)).toMatch(/HEX/);
    expect(b.sim.isAVRLoaded('m')).toBe(false);
  });

  it('loadAVRProgram still works and is not overridden by an older properties.hex', () => {
    const b = new Bench();
    b.power();
    b.add('atmega328', 'm', { hex: fixture('pulses.hex') });
    b.hi('m.vcc').hi('m.avcc').lo('m.gnd').lo('m.agnd').hi('m.pc6');
    b.sim.loadAVRProgram('m', fixture('blink1s.hex'));
    // blink1s toggles D12 every 10 ms; pulses.hex never drives D12
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = (b.sim as any).state.avrBridges.get('m') as { transitions: { pinId: string }[] };
    let d12 = 0;
    for (let i = 0; i < 3; i++) { b.tick(1); d12 += bridge.transitions.filter((t) => t.pinId === 'pb4').length; }
    expect(d12).toBeGreaterThan(20);
  });
});

describe('parseSI (src/utils/format.ts)', () => {
  it('parses SI prefixes, units and resistor codes', () => {
    expect(parseSI('4.7k')).toBe(4700);
    expect(parseSI('4k7')).toBe(4700);
    expect(parseSI('2.2MΩ')).toBe(2.2e6);
    expect(parseSI('100n')).toBeCloseTo(1e-7, 15);
    expect(parseSI('10uF')).toBeCloseTo(1e-5, 15);
    expect(parseSI('47µF')).toBeCloseTo(47e-6, 15);
    expect(parseSI('5m')).toBe(0.005);
    expect(parseSI('1e3')).toBe(1000);
    expect(parseSI('-5V')).toBe(-5);
    expect(parseSI(' 220 Ω ')).toBe(220);
    expect(parseSI('220R')).toBe(220);
    expect(parseSI('1R5')).toBe(1.5);
    expect(parseSI('60Hz')).toBe(60);
    expect(parseSI('1kohm')).toBe(1000);
  });
  it('returns null for text that is not a number', () => {
    for (const s of ['', '  ', 'abc', 'k', '1..2', '4.7q']) expect(parseSI(s)).toBe(null);
  });
});
