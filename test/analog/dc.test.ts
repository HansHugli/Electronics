import { describe, it, expect } from 'vitest';
import { Circuit, record, relErr } from '../helpers/circuit';
import { ledVoltageAt } from '../../src/engine/CircuitSimulator';

/** Current through R in series with an LED (engine model) from supply V: fixed point. */
function ledLoop(v: number, r: number, vf: number): number {
  let i = 0.01;
  for (let k = 0; k < 200; k++) i = 0.5 * i + 0.5 * Math.max(1e-6, (v - ledVoltageAt(i, vf)) / r);
  return i;
}

/** 5 V (or given) supply 'v1' whose neg is circuit ground. */
function supply(c: Circuit, volts: number, id = 'v1') {
  c.add('power', id, { voltage: volts, mode: 'DC' });
}

describe('DC: resistive networks', () => {
  it('voltage divider 9 V, 1k / 2k -> 6 V, 3 mA', () => {
    const c = new Circuit();
    supply(c, 9);
    c.add('resistor', 'r1', { resistance: 1000 });
    c.add('resistor', 'r2', { resistance: 2000 });
    c.wire('v1:pos', 'r1:a'); c.wire('r1:b', 'r2:a'); c.wire('r2:b', 'v1:neg');
    c.meter('m', 'r2:a', 'v1:neg');
    c.run(1);
    const v = record('divider Vmid', 6, c.s('m', 'voltage'), 'V');
    const i = record('divider I', 3e-3, c.s('r1', 'current'), 'A');
    expect(relErr(v, 6)).toBeLessThan(1e-3);
    expect(relErr(i, 3e-3)).toBeLessThan(1e-3);
  });

  it('series + parallel: 12 V, 100 + (200 || 300) -> I = 54.545 mA', () => {
    const c = new Circuit();
    supply(c, 12);
    c.add('resistor', 'r1', { resistance: 100 });
    c.add('resistor', 'r2', { resistance: 200 });
    c.add('resistor', 'r3', { resistance: 300 });
    c.wire('v1:pos', 'r1:a');
    c.wire('r1:b', 'r2:a'); c.wire('r1:b', 'r3:a');
    c.wire('r2:b', 'v1:neg'); c.wire('r3:b', 'v1:neg');
    c.run(1);
    const iTot = 12 / 220;
    record('series/parallel Itotal', iTot, c.s('r1', 'current'), 'A');
    record('series/parallel I(200)', iTot * 300 / 500, c.s('r2', 'current'), 'A');
    expect(relErr(c.s('r1', 'current'), iTot)).toBeLessThan(1e-3);
    expect(relErr(c.s('r2', 'current'), iTot * 0.6)).toBeLessThan(1e-3);
    expect(relErr(c.s('r3', 'current'), iTot * 0.4)).toBeLessThan(1e-3);
  });

  it('unbalanced Wheatstone bridge obeys KCL (hand nodal solution A=6.5807 V, B=5.9355 V)', () => {
    // 10 V; left arm R1=1k (top) R2=2k (bottom); right arm R3=3k, R4=4k; bridge R5=5k A-B
    const c = new Circuit();
    supply(c, 10);
    const R = { r1: 1000, r2: 2000, r3: 3000, r4: 4000, r5: 5000 };
    for (const [id, r] of Object.entries(R)) c.add('resistor', id, { resistance: r });
    c.wire('v1:pos', 'r1:a'); c.wire('v1:pos', 'r3:a');
    c.wire('r1:b', 'r2:a'); c.wire('r3:b', 'r4:a');
    c.wire('r2:b', 'v1:neg'); c.wire('r4:b', 'v1:neg');
    c.wire('r1:b', 'r5:a'); c.wire('r5:b', 'r3:b');
    c.run(1);
    const A = 10 - c.s('r1', 'current') * 1000;
    const B = 10 - c.s('r3', 'current') * 3000;
    record('bridge V(A)', 6.58065, A, 'V');
    record('bridge V(B)', 5.93548, B, 'V');
    expect(Math.abs(A - 6.58065)).toBeLessThan(1e-3);
    expect(Math.abs(B - 5.93548)).toBeLessThan(1e-3);
    // KCL at A and B
    expect(Math.abs(c.s('r1', 'current') - c.s('r2', 'current') - c.s('r5', 'current'))).toBeLessThan(1e-7); // 1e-9 S leak per node
    expect(Math.abs(c.s('r3', 'current') + c.s('r5', 'current') - c.s('r4', 'current'))).toBeLessThan(1e-7); // 1e-9 S leak per node
    // KVL: supply current = r1 + r3
    expect(Math.abs(-c.s('v1', 'current') - (c.s('r1', 'current') + c.s('r3', 'current')))).toBeLessThan(1e-6);
  });

  it('potentiometer 10k across 10 V: wiper = 10*(1-pos) V; loaded 10k at 50% -> 4.0 V', () => {
    for (const [pos, exp] of [[0, 10], [25, 7.5], [50, 5], [75, 2.5], [100, 0]] as const) {
      const c = new Circuit();
      supply(c, 10);
      c.add('potentiometer', 'p', { resistance: 10000, position: pos });
      c.wire('v1:pos', 'p:pin1'); c.wire('p:pin2', 'v1:neg');
      c.run(1);
      const v = record(`pot wiper @${pos}%`, exp, c.s('p', 'wiperVoltage'), 'V');
      expect(Math.abs(v - exp)).toBeLessThan(0.01);
    }
    const c = new Circuit();
    supply(c, 10);
    c.add('potentiometer', 'p', { resistance: 10000, position: 50 });
    c.add('resistor', 'rl', { resistance: 10000 });
    c.wire('v1:pos', 'p:pin1'); c.wire('p:pin2', 'v1:neg');
    c.wire('p:wiper', 'rl:a'); c.wire('rl:b', 'v1:neg');
    c.run(1);
    const v = record('pot 50% loaded by 10k', 4.0, c.s('p', 'wiperVoltage'), 'V');
    expect(Math.abs(v - 4.0)).toBeLessThan(0.01);
  });

  it('switch: open -> no current, closed -> 5 V / 1k = 5 mA', () => {
    const c = new Circuit();
    supply(c, 5);
    c.add('switch', 'sw', { momentary: 0 }, { closed: 0 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('v1:pos', 'sw:a'); c.wire('sw:b', 'r:a'); c.wire('r:b', 'v1:neg');
    c.run(1);
    record('switch open I', 0, c.s('r', 'current'), 'A');
    expect(Math.abs(c.s('r', 'current'))).toBeLessThan(1e-7); // 1e-9 S leak per node
    c.get('sw').state.closed = 1;
    c.run(1);
    record('switch closed I', 5e-3, c.s('r', 'current'), 'A');
    expect(relErr(c.s('r', 'current'), 5e-3)).toBeLessThan(1e-3);
  });

  it('multimeter in current mode, placed in series like a real ammeter, reads 5 mA and does not break the circuit', () => {
    const c = new Circuit();
    supply(c, 5);
    c.add('resistor', 'r', { resistance: 1000 });
    c.add('multimeter', 'am', { mode: 'current' });
    c.wire('v1:pos', 'am:pos'); c.wire('am:neg', 'r:a'); c.wire('r:b', 'v1:neg');
    c.run(1);
    record('ammeter in series reading', 5e-3, c.s('am', 'displayValue'), 'A');
    record('circuit current with ammeter in series', 5e-3, c.s('r', 'current'), 'A');
    expect(relErr(c.s('am', 'displayValue'), 5e-3)).toBeLessThan(0.02);
  });
});

describe('DC: LEDs', () => {
  // Datasheet-typical 5 mm LEDs: red Vf ~1.9-2.0 V, green ~2.1-3.2 V, blue/white ~3.0-3.3 V at 10-20 mA.
  it('5 V + 220 ohm + red LED: I ~ (5-2.0)/220 = 13.6 mA, Vled ~2.0 V', () => {
    const c = new Circuit();
    supply(c, 5);
    c.add('resistor', 'r', { resistance: 220 });
    c.add('led', 'd', { color: 'red', forwardVoltage: 2.0 });
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'd:anode'); c.wire('d:cathode', 'v1:neg');
    c.run(1);
    const i = record('red LED + 220R current', (5 - 2.0) / 220, c.s('d', 'current'), 'A');
    const v = record('red LED + 220R Vf', 2.0, c.s('d', 'voltage'), 'V');
    expect(relErr(i, (5 - 2.0) / 220)).toBeLessThan(0.07);
    expect(Math.abs(v - 2.0)).toBeLessThan(0.15);
  });

  it('blue LED (colour picked in UI) has Vf ~3.1 V: 5 V + 220 ohm -> ~8.6 mA', () => {
    const c = new Circuit();
    supply(c, 5);
    c.add('resistor', 'r', { resistance: 220 });
    c.add('led', 'd', { color: 'blue' }); // UI colour swatch only changes `color`
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'd:anode'); c.wire('d:cathode', 'v1:neg');
    c.run(1);
    const i = record('blue LED + 220R current', (5 - 3.1) / 220, c.s('d', 'current'), 'A');
    expect(relErr(i, (5 - 3.1) / 220)).toBeLessThan(0.15);
  });

  it('blue LED on 3 V through 100 ohm is (nearly) dark (<1 mA)', () => {
    const c = new Circuit();
    supply(c, 3);
    c.add('resistor', 'r', { resistance: 100 });
    c.add('led', 'd', { color: 'blue' });
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'd:anode'); c.wire('d:cathode', 'v1:neg');
    c.run(1);
    record('blue LED 3V/100R current', 0, c.s('d', 'current'), 'A');
    expect(c.s('d', 'current')).toBeLessThan(1e-3);
  });

  it('LED directly across 5 V (no resistor) is flagged as over-current / destroyed', () => {
    const c = new Circuit();
    supply(c, 5);
    c.add('led', 'd', { color: 'red', forwardVoltage: 2.0 });
    c.wire('v1:pos', 'd:anode'); c.wire('d:cathode', 'v1:neg');
    c.run(1);
    const st = c.last.get('d') ?? {};
    // eslint-disable-next-line no-console
    console.log(`[measure] LED with no resistor at 5 V: current ${c.s('d', 'current')} A, state keys: ${Object.keys(st).join(',')}`);
    expect(c.s('d', 'current')).toBeGreaterThan(0.03); // physically: far above the 20-30 mA rating
    const flagged = Object.keys(st).some((k) => /burn|blown|over|damag|warn/i.test(k));
    expect(flagged, 'no over-current flag in LED state').toBe(true);
  });

  // The LED model changed (Shockley diode + 5 ohm, iterated to convergence) from the
  // old one-pass "Vf + 50 ohm" model, so the expected red current is the new model's
  // own operating point (about 29 mA); the point of the test is unchanged: the blue LED
  // must stay dark and the red one carries all of the resistor current.
  it('red (Vf 2.0) and blue (Vf 3.5) LEDs in parallel off 5 V/100 ohm: blue dark, red carries the resistor current', () => {
    const c = new Circuit();
    supply(c, 5);
    c.add('resistor', 'r', { resistance: 100 });
    c.add('led', 'red', { color: 'red', forwardVoltage: 2.0 });
    c.add('led', 'blue', { color: 'blue', forwardVoltage: 3.5 });
    c.wire('v1:pos', 'r:a');
    c.wire('r:b', 'red:anode'); c.wire('r:b', 'blue:anode');
    c.wire('red:cathode', 'v1:neg'); c.wire('blue:cathode', 'v1:neg');
    c.run(1);
    const want = ledLoop(5, 100, 2.0);
    const iRed = record('parallel LEDs: red current', want, c.s('red', 'current'), 'A');
    record('parallel LEDs: resistor current', want, c.s('r', 'current'), 'A');
    expect(relErr(iRed, want)).toBeLessThan(0.02);
    expect(relErr(c.s('r', 'current'), want)).toBeLessThan(0.02);
    expect(Math.abs(c.s('blue', 'current'))).toBeLessThan(1e-6);
  });

  it('red LED reverse-biased carries no current', () => {
    const c = new Circuit();
    supply(c, 5);
    c.add('resistor', 'r', { resistance: 220 });
    c.add('led', 'd', { forwardVoltage: 2.0 });
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'd:cathode'); c.wire('d:anode', 'v1:neg');
    c.run(1);
    expect(Math.abs(c.s('r', 'current'))).toBeLessThan(1e-6);
  });
});

describe('DC: 7805 regulator', () => {
  const reg = (vin: number | null, rload: number) => {
    const c = new Circuit();
    supply(c, vin ?? 9);
    c.add('vreg', 'u', { outputVoltage: 5, dropout: 2 });
    c.add('resistor', 'rl', { resistance: rload });
    if (vin !== null) c.wire('v1:pos', 'u:vin');
    c.wire('u:gnd', 'v1:neg');
    c.wire('u:vout', 'rl:a'); c.wire('rl:b', 'v1:neg');
    c.run(1);
    return c;
  };
  it('Vin 9 V, 100 ohm load: Vout 5.0 V (4.8-5.2), input current ~ Iload + Iq(<8 mA) = ~55 mA', () => {
    const c = reg(9, 100);
    const vout = record('7805 Vin=9 Vout', 5.0, c.s('u', 'voltage'), 'V');
    const iin = record('7805 Vin=9 input current', 0.05 + 0.005, -c.s('v1', 'current'), 'A');
    expect(Math.abs(vout - 5)).toBeLessThan(0.2);
    expect(relErr(iin, 0.055)).toBeLessThan(0.1);
  });
  it('Vin 6 V (below 5 V + 2 V dropout): Vout ~ Vin - 2 = 4.0 V', () => {
    const c = reg(6, 100);
    const vout = record('7805 Vin=6 Vout', 4.0, c.s('u', 'voltage'), 'V');
    expect(Math.abs(vout - 4.0)).toBeLessThan(0.3);
  });
  it('Vin 3 V: Vout ~ 1 V', () => {
    const c = reg(3, 100);
    const vout = record('7805 Vin=3 Vout', 1.0, c.s('u', 'voltage'), 'V');
    expect(Math.abs(vout - 1.0)).toBeLessThan(0.5);
  });
  it('IN pin unconnected: Vout 0 V', () => {
    const c = reg(null, 100);
    const vout = record('7805 IN floating Vout', 0, c.s('u', 'voltage'), 'V');
    expect(Math.abs(vout)).toBeLessThan(0.1);
  });
  it('Vin 12 V, no load: input current = quiescent ~5 mA', () => {
    const c = reg(12, 1e9);
    const iin = record('7805 Vin=12 no-load input current', 0.005, -c.s('v1', 'current'), 'A');
    expect(iin).toBeLessThan(0.01);
  });
});

describe('DC: op-amp (LM741 on +/-12 V)', () => {
  /** ground = v1.neg; v1 = +12 rail; v2 = -12 rail; vin = signal source */
  const rails = (c: Circuit, vin: number) => {
    c.add('power', 'v1', { voltage: 12 });
    c.add('power', 'v2', { voltage: 12 });
    c.add('power', 'vs', { voltage: vin });
    c.wire('v2:pos', 'v1:neg');          // v2 pos = ground, v2 neg = -12
    c.wire('vs:neg', 'v1:neg');
    c.add('opamp', 'u');
    c.wire('u:v_pos', 'v1:pos'); c.wire('u:v_neg', 'v2:neg');
  };
  const settle = (c: Circuit, n = 50) => {
    const outs: number[] = [];
    c.run(n, { onTick: (cc) => outs.push(cc.s('u', 'voltage')) });
    return outs;
  };

  it('inverting amp Rin=1k Rf=10k, Vin=+0.5 V -> Vout = -5.0 V (settles, no oscillation)', () => {
    const c = new Circuit();
    rails(c, 0.5);
    c.add('resistor', 'rin', { resistance: 1000 });
    c.add('resistor', 'rf', { resistance: 10000 });
    c.wire('vs:pos', 'rin:a'); c.wire('rin:b', 'u:in_neg'); c.wire('u:in_neg', 'rf:a'); c.wire('rf:b', 'u:out');
    c.wire('u:in_pos', 'v1:neg');
    const outs = settle(c);
    // eslint-disable-next-line no-console
    console.log(`[trace] inverting amp Vout per tick: ${outs.slice(0, 12).map((v) => v.toFixed(2)).join(', ')} ... last ${outs.slice(-4).map((v) => v.toFixed(2)).join(', ')}`);
    const v = record('inverting amp Vout (tick 50)', -5, outs[outs.length - 1], 'V');
    expect(Math.abs(v + 5)).toBeLessThan(0.05);
    expect(Math.abs(outs[outs.length - 1] - outs[outs.length - 2])).toBeLessThan(0.01);
  });

  it('non-inverting amp Rg=1k Rf=10k, Vin=0.5 V -> Vout = 5.5 V', () => {
    const c = new Circuit();
    rails(c, 0.5);
    c.add('resistor', 'rg', { resistance: 1000 });
    c.add('resistor', 'rf', { resistance: 10000 });
    c.wire('vs:pos', 'u:in_pos');
    c.wire('u:in_neg', 'rg:a'); c.wire('rg:b', 'v1:neg');
    c.wire('u:in_neg', 'rf:a'); c.wire('rf:b', 'u:out');
    const outs = settle(c);
    // eslint-disable-next-line no-console
    console.log(`[trace] non-inverting Vout per tick: ${outs.slice(0, 12).map((v) => v.toFixed(2)).join(', ')} ... last ${outs.slice(-4).map((v) => v.toFixed(2)).join(', ')}`);
    const v = record('non-inverting amp Vout (tick 50)', 5.5, outs[outs.length - 1], 'V');
    expect(Math.abs(v - 5.5)).toBeLessThan(0.05);
  });

  it('voltage follower Vin=2 V -> 2 V', () => {
    const c = new Circuit();
    rails(c, 2);
    c.wire('vs:pos', 'u:in_pos'); c.wire('u:in_neg', 'u:out');
    const outs = settle(c);
    // eslint-disable-next-line no-console
    console.log(`[trace] follower Vout per tick: ${outs.slice(0, 12).map((v) => v.toFixed(2)).join(', ')}`);
    const v = record('follower Vout (tick 50)', 2, outs[outs.length - 1], 'V');
    expect(Math.abs(v - 2)).toBeLessThan(0.02);
  });

  it('comparator (open loop) saturates near the + rail: LM741 typ. Vcc-1..-2 V -> ~ +10.5..+11 V', () => {
    const c = new Circuit();
    rails(c, 1);
    c.add('resistor', 'rl', { resistance: 10000 });
    c.wire('vs:pos', 'u:in_pos'); c.wire('u:in_neg', 'v1:neg');
    c.wire('u:out', 'rl:a'); c.wire('rl:b', 'v1:neg');
    const outs = settle(c, 5);
    const v = record('open-loop +sat', 10.75, outs[outs.length - 1], 'V');
    expect(v).toBeGreaterThan(10);
    expect(v).toBeLessThan(11.6);
  });
});
