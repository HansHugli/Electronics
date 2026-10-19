import { describe, it, expect } from 'vitest';
import { Circuit, record, relErr } from '../helpers/circuit';
import { ledVoltageAt } from '../../src/engine/CircuitSimulator';

function rc(R: number, CuF: number, V = 5) {
  const c = new Circuit();
  c.add('power', 'v1', { voltage: V, mode: 'DC' });
  c.add('resistor', 'r', { resistance: R });
  c.add('capacitor', 'c', { capacitance: CuF });
  c.wire('v1:pos', 'r:a'); c.wire('r:b', 'c:pos'); c.wire('c:neg', 'v1:neg');
  return c;
}

describe('Transient: RC', () => {
  it('RC charge 10k/100uF (tau = 1 s): Vc(1 s) = 5(1-e^-1) = 3.1606 V', () => {
    const c = rc(10000, 100);
    c.run(10);
    const v = record('RC charge Vc(t=RC), dt=100ms (default)', 5 * (1 - Math.exp(-1)), c.s('c', 'voltage'), 'V');
    expect(relErr(v, 5 * (1 - Math.exp(-1)))).toBeLessThan(0.01);
  });

  it('RC charge with Accuracy=10 sub-steps (dt=10ms) is within 0.5%', () => {
    const c = rc(10000, 100);
    c.run(10, { subSteps: 10 });
    const v = record('RC charge Vc(t=RC), subSteps=10', 5 * (1 - Math.exp(-1)), c.s('c', 'voltage'), 'V');
    expect(relErr(v, 5 * (1 - Math.exp(-1)))).toBeLessThan(0.005);
  });

  // The engine now sub-steps automatically (h <= RC/50) with a second-order
  // method (BDF2), so instead of identifying backward Euler the test checks the
  // result is close to the exact solution whatever the Accuracy setting.
  it('step-size independence: Vc(1 s) is within 0.1 % of 5(1-e^-1) for every Accuracy setting', () => {
    for (const sub of [1, 2, 5, 10]) {
      const c = rc(10000, 100);
      c.run(10, { subSteps: sub });
      const exact = 5 * (1 - Math.exp(-1));
      record(`RC Vc(1s) subSteps=${sub} vs exact`, exact, c.s('c', 'voltage'), 'V');
      expect(relErr(c.s('c', 'voltage'), exact)).toBeLessThan(1e-3);
    }
  });

  it('RC discharge from 5 V: Vc(RC) = 5 e^-1 = 1.8394 V', () => {
    const c = rc(10000, 100);
    c.run(200);
    c.get('v1').properties.voltage = 0;
    c.run(10);
    const v = record('RC discharge Vc(t=RC), dt=100ms', 5 * Math.exp(-1), c.s('c', 'voltage'), 'V');
    expect(relErr(v, 5 * Math.exp(-1))).toBeLessThan(0.01);
  });

  it('stiff: 100 ohm / 1 uF (tau = 100 us << dt): no overshoot, no NaN, Vc -> 5 V in one tick', () => {
    const c = rc(100, 1);
    c.run(3);
    const v = c.s('c', 'voltage');
    record('stiff RC Vc after 3 ticks', 5, v, 'V');
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeLessThanOrEqual(5 + 1e-9);
    expect(Math.abs(v - 5)).toBeLessThan(0.01);
  });

  it('tiny C big R: 1 pF / 1 MOhm stays finite and settles at 5 V', () => {
    const c = rc(1e6, 1e-6);
    c.run(3);
    expect(Number.isFinite(c.s('c', 'voltage'))).toBe(true);
    expect(Math.abs(c.s('c', 'voltage') - 5)).toBeLessThan(0.01);
  });

  it('capacitor in parallel with LED+100 ohm, fed by 5 V/1k: Vc settles at the LED-clamped voltage (not 5 V)', () => {
    // Engine LED model (Shockley + 5 ohm, Vf 2.0 V at 20 mA; it replaced the old
    // "Vf + 50 ohm" model, which gave 2.3913 V). Steady state: (5-X)/1000 = I,
    // X = V_led(I) + 100 I.
    let i = 0.003;
    for (let k = 0; k < 200; k++) i = 0.5 * i + 0.5 * (5 - (ledVoltageAt(i, 2.0) + 100 * i)) / 1000;
    const X = 5 - 1000 * i;
    const c = rc(1000, 100);
    c.add('resistor', 'rl', { resistance: 100 });
    c.add('led', 'd', { forwardVoltage: 2.0 });
    c.wire('c:pos', 'rl:a'); c.wire('rl:b', 'd:anode'); c.wire('d:cathode', 'v1:neg');
    c.run(100);
    const vc = record('cap || LED steady state: cap voltage', X, c.s('c', 'voltage'), 'V');
    record('cap || LED steady state: LED voltage+IR (node)', X, c.s('d', 'voltage') + c.s('rl', 'current') * 100, 'V');
    expect(Math.abs(vc - X)).toBeLessThan(0.02);
  });
});

describe('Transient: sources', () => {
  it('AC power supply (sine, 5 V) actually alternates: peak |V| over 1 s ~ 5 V', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5, mode: 'AC', waveform: 'sine' });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'v1:neg');
    let peak = 0;
    const samples: number[] = [];
    c.run(10, { onTick: (cc) => { const v = cc.s('r', 'current') * 1000; samples.push(v); peak = Math.max(peak, Math.abs(v)); } });
    // eslint-disable-next-line no-console
    console.log(`[trace] AC sine node V per tick: ${samples.map((v) => v.toExponential(2)).join(', ')}`);
    // eslint-disable-next-line no-console
    console.log(`[trace] AC sine power state.voltage (what the scope plots): ${c.s('v1', 'voltage')}`);
    record('AC sine 60 Hz peak seen over 10 ticks', 5, peak, 'V');
    expect(peak).toBeGreaterThan(4);
  });

  it('AC power supply (square, 5 V) at its default 1 Hz: 10 ticks sampled', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5, mode: 'AC', waveform: 'square' });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'v1:neg');
    const samples: number[] = [];
    c.run(10, { onTick: (cc) => samples.push(cc.s('r', 'current') * 1000) });
    // eslint-disable-next-line no-console
    console.log(`[trace] AC square node V per tick: ${samples.map((v) => v.toFixed(2)).join(', ')}`);
    // Physically meaningless at this sampling either way; at least must be a defined +/-5 pattern
    expect(samples.some((v) => v > 4) && samples.some((v) => v < -4), 'square must alternate between +5 and -5').toBe(true);
  });

  it('function generator 1 Hz sine 5 V into 1k: node follows 5 sin(2 pi t) at each tick', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 }); // provides ground
    c.add('funcgen', 'fg', { amplitude: 5, frequency: 1, waveform: 'sine', offset: 0 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('fg:gnd', 'v1:neg'); c.wire('fg:out', 'r:a'); c.wire('r:b', 'v1:neg');
    let maxErr = 0;
    c.run(10, {
      onTick: (cc) => {
        const t = cc.timeMs / 1000;
        const exp = 5 * Math.sin(2 * Math.PI * t) * 1000 / 1000.1; // 0.1 ohm source
        maxErr = Math.max(maxErr, Math.abs(cc.s('fg', 'voltage') - exp));
      },
    });
    record('funcgen 1 Hz sine max abs error over 1 s', 0, maxErr, 'V');
    expect(maxErr).toBeLessThan(1e-3);
  });

  // A 10 Hz sine sampled once per 100 ms tick is 0 V at every tick end (that is
  // the true instantaneous value). The scope now receives samples from every
  // sub-step (Hans, 2026-10-18), so the test reads the scope samples.
  it('function generator 10 Hz sine 5 V: the scope samples show the full ±5 V (no aliasing to DC)', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('funcgen', 'fg', { amplitude: 5, frequency: 10, waveform: 'sine', offset: 0 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('fg:gnd', 'v1:neg'); c.wire('fg:out', 'r:a'); c.wire('r:b', 'v1:neg');
    c.sim.scopeProbeIds = new Set(['fg']);
    let peak = 0, low = 0;
    c.run(10, { onTick: (cc) => {
      for (const s of cc.sim.scopeSamples.get('fg') ?? []) { peak = Math.max(peak, s.voltage); low = Math.min(low, s.voltage); }
    } });
    record('funcgen 10 Hz sine peak from scope samples', 5, peak, 'V');
    expect(peak).toBeGreaterThan(4.9);
    expect(low).toBeLessThan(-4.9);
  });

  it('function generator with no Power Supply in the circuit still drives a resistor', () => {
    const c = new Circuit();
    c.add('funcgen', 'fg', { amplitude: 5, frequency: 1, waveform: 'square', offset: 0 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('fg:out', 'r:a'); c.wire('r:b', 'fg:gnd');
    c.run(2);
    const i = c.s('r', 'current');
    record('funcgen alone, 1k current', 5e-3, Number.isNaN(i) ? 0 : Math.abs(i), 'A');
    expect(Math.abs(i)).toBeGreaterThan(4e-3);
  });

  it('scope trace source: resistor state.voltage keeps the sign of V(a)-V(b) (sine goes negative)', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('funcgen', 'fg', { amplitude: 5, frequency: 1, waveform: 'sine', offset: 0 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('fg:gnd', 'v1:neg'); c.wire('fg:out', 'r:a'); c.wire('r:b', 'v1:neg');
    c.run(7); // t = 0.7 s, sin(1.4 pi) = -0.951
    record('scope value (resistor state.voltage) at t=0.7s', -4.755, c.s('r', 'voltage'), 'V');
    expect(c.s('r', 'voltage')).toBeLessThan(0);
  });
});

/** 555 astable, netlist identical to createBlinkDemoCircuit (VCC-R1-DIS-R2-THR/TRIG-C-GND, RST=VCC). */
function astable(R1: number, R2: number, CuF: number) {
  const c = new Circuit();
  c.add('power', 'v1', { voltage: 5 });
  c.add('timer', 't', {}, { outputHigh: 0 });
  c.add('resistor', 'ra', { resistance: R1 });
  c.add('resistor', 'rb', { resistance: R2 });
  c.add('capacitor', 'c', { capacitance: CuF });
  c.wire('t:vcc', 'v1:pos'); c.wire('t:gnd', 'v1:neg'); c.wire('t:reset', 'v1:pos');
  c.wire('ra:a', 'v1:pos'); c.wire('ra:b', 't:dis'); c.wire('rb:a', 't:dis'); c.wire('rb:b', 't:thr');
  c.wire('t:thr', 't:trig'); c.wire('c:pos', 't:thr'); c.wire('c:neg', 'v1:neg');
  return c;
}

function measure555(c: Circuit, ticks: number, subSteps = 1) {
  const out: number[] = [];
  c.run(ticks, { subSteps, onTick: (cc) => out.push(cc.s('t', 'outputHigh')) });
  const rises: number[] = []; const falls: number[] = [];
  for (let k = 1; k < out.length; k++) {
    if (out[k] && !out[k - 1]) rises.push(k);
    if (!out[k] && out[k - 1]) falls.push(k);
  }
  // steady-state: use rises after the first one
  const periods = rises.slice(1).map((r, i) => (r - rises[i]) * 0.1);
  const highs: number[] = [];
  for (const r of rises.slice(1)) { const f = falls.find((x) => x > r); if (f) highs.push((f - r) * 0.1); }
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  return { period: avg(periods), high: avg(highs), cycles: periods.length };
}

describe('555 timer', () => {
  it('astable blink-demo values R1=47k R2=68k C=47uF: f = 1.44/((R1+2R2)C) = 0.1674 Hz, duty 62.8 %', () => {
    const T = 0.693 * (47e3 + 2 * 68e3) * 47e-6;   // 5.961 s (0.693 form)
    const tH = 0.693 * (47e3 + 68e3) * 47e-6;      // 3.746 s
    const m = measure555(astable(47e3, 68e3, 47), 900);
    record('555 slow astable period', T, m.period, 's');
    record('555 slow astable high time', tH, m.high, 's');
    record('555 slow astable duty', tH / T, m.high / m.period, '');
    const m10 = measure555(astable(47e3, 68e3, 47), 900, 10);
    record('555 slow astable period, subSteps=10', T, m10.period, 's');
    expect(m.cycles).toBeGreaterThan(5);
    expect(relErr(m.period, T)).toBeLessThan(0.05);
    expect(relErr(m.high / m.period, tH / T)).toBeLessThan(0.05);
  });

  // Sampling the output once per 100 ms tick cannot measure a 146 ms period (it
  // aliases to ~3 Hz), so the period is measured from the oscilloscope samples,
  // which the engine now records at every sub-step (Hans, 2026-10-18).
  it('astable R1=1k R2=10k C=10uF: f = 6.86 Hz (T = 146 ms) -- faster than the 100 ms tick', () => {
    const T = 0.693 * 21e3 * 10e-6;
    for (const sub of [1, 10]) {
      const c = astable(1e3, 10e3, 10);
      c.sim.scopeProbeIds = new Set(['t']);
      const rises: number[] = [];
      let prev = 0;
      c.run(300, { subSteps: sub, onTick: (cc) => {
        for (const s of cc.sim.scopeSamples.get('t') ?? []) {
          const hi = s.voltage > 2.5 ? 1 : 0;
          if (hi && !prev) rises.push(s.time / 1000);
          prev = hi;
        }
      } });
      const r = rises.slice(2);
      const period = (r[r.length - 1] - r[0]) / (r.length - 1);
      record(`555 fast astable period (scope samples, Accuracy ${sub})`, T, period, 's');
      expect(relErr(period, T)).toBeLessThan(0.02);
    }
  });

  it('monostable R=100k C=10uF: pulse = 1.1 RC = 1.10 s', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('timer', 't', {}, { outputHigh: 0 });
    c.add('resistor', 'r', { resistance: 100e3 });
    c.add('capacitor', 'c', { capacitance: 10 });
    c.add('resistor', 'rpu', { resistance: 10e3 });
    c.add('switch', 'sw', { momentary: 1 }, { closed: 0 });
    c.wire('t:vcc', 'v1:pos'); c.wire('t:gnd', 'v1:neg'); c.wire('t:reset', 'v1:pos');
    c.wire('r:a', 'v1:pos'); c.wire('r:b', 't:thr'); c.wire('t:thr', 't:dis');
    c.wire('c:pos', 't:thr'); c.wire('c:neg', 'v1:neg');
    c.wire('rpu:a', 'v1:pos'); c.wire('rpu:b', 't:trig');
    c.wire('sw:a', 't:trig'); c.wire('sw:b', 'v1:neg');
    c.run(5);
    c.get('sw').state.closed = 1;
    c.run(1);
    c.get('sw').state.closed = 0;
    let highTicks = 0;
    c.run(40, { onTick: (cc) => { if (cc.s('t', 'outputHigh')) highTicks++; } });
    highTicks += 1; // the tick in which the trigger was pressed sets the flip-flop
    record('555 monostable pulse width', 1.1, highTicks * 0.1, 's');
    expect(Math.abs(highTicks * 0.1 - 1.1)).toBeLessThanOrEqual(0.1 + 1e-9); // one-tick quantisation allowed
  });
});
