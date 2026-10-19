// Automatic sub-stepping, digital settling and MCU edges, advanced the way the
// wall-clock loop does it (uneven frames of a few to tens of milliseconds).
import { describe, it, expect } from 'vitest';
import { Circuit, relErr } from '../helpers/circuit';
import { Bench, fixture } from '../digital/bench';

/** Advance a Circuit with frame-sized steps (ms), like useSimulationLoop at 60 fps. */
function runFrames(c: Circuit, seconds: number, frameMs = 1000 / 60, onFrame?: (c: Circuit) => void) {
  const n = Math.round((seconds * 1000) / frameMs);
  c.run(n, { dt: frameMs / 1000, onTick: onFrame });
}

describe('automatic sub-stepping', () => {
  it('555 astable at T = 146 ms (1k / 10k / 10 uF) is within 2 % when run in 60 fps frames', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('timer', 't');
    c.add('resistor', 'ra', { resistance: 1e3 });
    c.add('resistor', 'rb', { resistance: 10e3 });
    c.add('capacitor', 'c', { capacitance: 10 });
    c.wire('t:vcc', 'v1:pos'); c.wire('t:gnd', 'v1:neg'); c.wire('t:reset', 'v1:pos');
    c.wire('ra:a', 'v1:pos'); c.wire('ra:b', 't:dis'); c.wire('rb:a', 't:dis'); c.wire('rb:b', 't:thr');
    c.wire('t:thr', 't:trig'); c.wire('c:pos', 't:thr'); c.wire('c:neg', 'v1:neg');
    c.sim.scopeProbeIds = new Set(['t']);
    const rises: number[] = [];
    let prev = 0;
    runFrames(c, 4, 1000 / 60, (cc) => {
      for (const s of cc.sim.scopeSamples.get('t') ?? []) {
        const hi = s.voltage > 2.5 ? 1 : 0;
        if (hi && !prev) rises.push(s.time / 1000);
        prev = hi;
      }
    });
    const r = rises.slice(2);
    const period = (r[r.length - 1] - r[0]) / (r.length - 1);
    expect(r.length).toBeGreaterThan(15);
    expect(relErr(period, 0.693 * 21e3 * 10e-6)).toBeLessThan(0.02);
  });

  it('555 CTRL pin: forcing CTRL to 2.5 V moves both thresholds (T = (Ra+Rb)C·ln1.5 + Rb·C·ln2)', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('power', 'vc', { voltage: 2.5 });
    c.add('timer', 't');
    c.add('resistor', 'ra', { resistance: 1e3 });
    c.add('resistor', 'rb', { resistance: 10e3 });
    c.add('capacitor', 'c', { capacitance: 10 });
    c.wire('t:vcc', 'v1:pos'); c.wire('t:gnd', 'v1:neg'); c.wire('t:reset', 'v1:pos');
    c.wire('ra:a', 'v1:pos'); c.wire('ra:b', 't:dis'); c.wire('rb:a', 't:dis'); c.wire('rb:b', 't:thr');
    c.wire('t:thr', 't:trig'); c.wire('c:pos', 't:thr'); c.wire('c:neg', 'v1:neg');
    c.wire('vc:neg', 'v1:neg'); c.wire('vc:pos', 't:ctrl');
    c.sim.scopeProbeIds = new Set(['t']);
    const rises: number[] = [];
    let prev = 0;
    runFrames(c, 3, 1000 / 60, (cc) => {
      for (const s of cc.sim.scopeSamples.get('t') ?? []) {
        const hi = s.voltage > 2.5 ? 1 : 0;
        if (hi && !prev) rises.push(s.time / 1000);
        prev = hi;
      }
    });
    const r = rises.slice(2);
    const period = (r[r.length - 1] - r[0]) / (r.length - 1);
    const want = 11e3 * 10e-6 * Math.log(1.5) + 10e3 * 10e-6 * Math.log(2);
    expect(relErr(period, want)).toBeLessThan(0.03);
  });

  it('10 Hz sine from the function generator: scope peak within 2 % of 5 V', () => {
    const c = new Circuit();
    c.add('funcgen', 'fg', { amplitude: 5, frequency: 10, waveform: 'sine', offset: 0 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('fg:out', 'r:a'); c.wire('r:b', 'fg:gnd');
    c.sim.scopeProbeIds = new Set(['fg']);
    let peak = 0, low = 0;
    runFrames(c, 1, 1000 / 60, (cc) => {
      for (const s of cc.sim.scopeSamples.get('fg') ?? []) { peak = Math.max(peak, s.voltage); low = Math.min(low, s.voltage); }
    });
    expect(relErr(peak, 5)).toBeLessThan(0.02);
    expect(relErr(-low, 5)).toBeLessThan(0.02);
  });

  it('RC time constant: a 1 ms RC low-pass passes 10 Hz and attenuates 1 kHz', () => {
    const run = (f: number) => {
      const c = new Circuit();
      c.add('funcgen', 'fg', { amplitude: 1, frequency: f, waveform: 'sine' });
      c.add('resistor', 'r', { resistance: 1000 });
      c.add('capacitor', 'c', { capacitance: 1 }); // τ = 1 ms, fc = 159 Hz
      c.wire('fg:out', 'r:a'); c.wire('r:b', 'c:pos'); c.wire('c:neg', 'fg:gnd');
      c.sim.scopeProbeIds = new Set(['c']);
      let peak = 0;
      runFrames(c, 0.5, 1000 / 60, (cc) => {
        if (cc.timeMs < 250) return;
        for (const s of cc.sim.scopeSamples.get('c') ?? []) peak = Math.max(peak, s.voltage);
      });
      return peak;
    };
    const lo = run(10), hi = run(1000);
    expect(lo).toBeGreaterThan(0.95);
    // |H(1 kHz)| = 1/sqrt(1+(2π·1000·1e-3)²) = 0.157 (sampled every 2 ms by the scope: ≤ that)
    expect(hi).toBeLessThan(0.2);
  });
});

describe('digital settling', () => {
  it('4 chained inverters settle within one 16 ms advance', () => {
    const b = new Bench();
    b.power();
    b.add('gate_not', 'u');
    b.hi('u.vcc').lo('u.gnd');
    b.lo('u.1a').wire('u.1y', 'u.2a').wire('u.2y', 'u.3a').wire('u.3y', 'u.4a');
    b.probe('u.4y');
    b.tick(3, 0.016);
    expect(b.v('u.4y')).toBeLessThan(0.1);
    b.unwire('u.1a').hi('u.1a');
    b.tick(1, 0.016);
    expect(b.v('u.4y')).toBeGreaterThan(4.4);
  });

  it('a ripple chain of 4 cascaded CD4026 counters carries through in one advance', () => {
    const b = new Bench();
    b.power();
    const ids = ['c0', 'c1', 'c2', 'c3'];
    for (const id of ids) { b.add('cd4026', id); b.hi(`${id}.vcc`).lo(`${id}.gnd`).lo(`${id}.inh`).hi(`${id}.en`).lo(`${id}.rst`); }
    b.wire('c0.co', 'c1.clk').wire('c1.co', 'c2.clk').wire('c2.co', 'c3.clk');
    b.lo('c0.clk');
    b.tick(2);
    // 1000 pulses into c0 → c3 counts 1
    for (let i = 0; i < 1000; i++) { b.drive('c0.clk', true); b.tick(1, 0.002); b.drive('c0.clk', false); b.tick(1, 0.002); }
    expect(ids.map((id) => Number(b.s(id).count))).toEqual([0, 0, 0, 1]);
  });
});

describe('MCU edges at sub-step resolution', () => {
  it('a 4026 clocked by the MCU counts 37 of 37 pulses when advanced in 16 ms frames', () => {
    const b = new Bench();
    b.power();
    b.add('atmega328', 'm');
    b.hi('m.vcc').hi('m.avcc').lo('m.gnd').lo('m.agnd').hi('m.pc6');
    b.sim.loadAVRProgram('m', fixture('pulses.hex'));
    b.add('cd4026', 'u');
    b.hi('u.vcc').lo('u.gnd').lo('u.inh').hi('u.en').lo('u.rst').wire('m.pd7', 'u.clk');
    b.tick(60, 1 / 60); // 1 s
    expect(Number(b.s('u').count)).toBe(7);
  });

  it('two cascaded 4026s count all 37 MCU pulses as 3 tens and 7 ones', () => {
    const b = new Bench();
    b.power();
    b.add('atmega328', 'm');
    b.hi('m.vcc').hi('m.avcc').lo('m.gnd').lo('m.agnd').hi('m.pc6');
    b.sim.loadAVRProgram('m', fixture('pulses.hex'));
    b.add('cd4026', 'ones'); b.add('cd4026', 'tens');
    for (const id of ['ones', 'tens']) b.hi(`${id}.vcc`).lo(`${id}.gnd`).lo(`${id}.inh`).hi(`${id}.en`).lo(`${id}.rst`);
    b.wire('m.pd7', 'ones.clk').wire('ones.co', 'tens.clk');
    b.tick(10);
    expect([Number(b.s('tens').count), Number(b.s('ones').count)]).toEqual([3, 7]);
  });
});
