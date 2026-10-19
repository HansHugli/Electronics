// Wall-clock pacing (src/hooks/useSimulationLoop.ts) with a fake clock.
import { describe, it, expect } from 'vitest';
import { SimClock, runSimulationFrame } from '../../src/hooks/useSimulationLoop';
import { CircuitSimulator } from '../../src/engine/CircuitSimulator';
import { Circuit } from '../helpers/circuit';

describe('SimClock: sim time follows wall time', () => {
  it('60 fps for 1 s of wall time at 1x advances 1 s of sim time', () => {
    const clk = new SimClock();
    clk.start(1000);
    for (let i = 1; i <= 60; i++) clk.advance(1000 + i * (1000 / 60), 1);
    expect(clk.simTime).toBeCloseTo(1000, 6);
    expect(clk.lagging).toBe(false);
    expect(clk.effectiveSpeed).toBeCloseTo(1, 3);
  });

  it('the speed setting scales sim time (0.25x, 2x, 10x)', () => {
    for (const speed of [0.25, 2, 10]) {
      const clk = new SimClock();
      clk.start(0);
      for (let i = 1; i <= 120; i++) clk.advance(i * 16, speed);
      expect(clk.simTime).toBeCloseTo(120 * 16 * speed, 6);
      expect(clk.lagging).toBe(false);
    }
  });

  it('uneven frame times still add up to wall time × speed', () => {
    const clk = new SimClock();
    clk.start(0);
    let t = 0;
    for (const d of [5, 40, 16, 33, 2, 90, 16, 16]) { t += d; clk.advance(t, 1); }
    expect(clk.simTime).toBeCloseTo(t, 6);
  });

  it('catch-up cap: one slow frame advances at most 0.25 s and reports lagging', () => {
    const clk = new SimClock();
    clk.start(0);
    clk.advance(16, 1);
    const r = clk.advance(16 + 600, 1); // the previous frame took 600 ms
    expect(r.capped).toBe(true);
    expect(r.dtSim).toBeCloseTo(0.25, 9);
    expect(clk.lagging).toBe(true);
  });

  it('lagging: an engine that needs 300 ms per frame at 1x falls behind and says so', () => {
    const clk = new SimClock();
    clk.start(0);
    let t = 0;
    for (let i = 0; i < 20; i++) { t += 300; clk.advance(t, 1); }
    expect(clk.lagging).toBe(true);
    expect(clk.effectiveSpeed).toBeLessThan(0.9);
    expect(clk.effectiveSpeed).toBeGreaterThan(0.8); // 0.25 s per 0.3 s
  });

  it('lagging clears once the engine keeps up again', () => {
    const clk = new SimClock();
    clk.start(0);
    let t = 0;
    for (let i = 0; i < 5; i++) { t += 400; clk.advance(t, 1); }
    expect(clk.lagging).toBe(true);
    for (let i = 0; i < 200; i++) { t += 16; clk.advance(t, 1); }
    expect(clk.lagging).toBe(false);
  });

  it('a long gap (hidden window) is a pause, not a burst of sim time', () => {
    const clk = new SimClock();
    clk.start(0);
    clk.advance(16, 1);
    const r = clk.advance(16 + 5000, 1);
    expect(r.dtSim).toBe(0);
    expect(clk.lagging).toBe(false);
  });
});

describe('runSimulationFrame: the engine advances by the clock', () => {
  it('RC 10k/100uF driven by 60 fps frames for 1 s of wall time reaches 5(1-1/e)', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('resistor', 'r', { resistance: 10000 });
    c.add('capacitor', 'c', { capacitance: 100 });
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'c:pos'); c.wire('c:neg', 'v1:neg');
    const sim = new CircuitSimulator();
    const clk = new SimClock();
    clk.start(0);
    let comps = c.components;
    for (let i = 1; i <= 60; i++) {
      const res = runSimulationFrame(clk, i * (1000 / 60), { speed: 1, accuracy: 1, simulator: sim }, comps, c.wires);
      if (res) comps = res.components;
    }
    const vc = Number(comps.find((x) => x.id === 'c')!.state.voltage);
    expect(Math.abs(vc - 5 * (1 - Math.exp(-1)))).toBeLessThan(0.005);
  });

  it('at 2x the same wall time charges the capacitor twice as far', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('resistor', 'r', { resistance: 10000 });
    c.add('capacitor', 'c', { capacitance: 100 });
    c.wire('v1:pos', 'r:a'); c.wire('r:b', 'c:pos'); c.wire('c:neg', 'v1:neg');
    const sim = new CircuitSimulator();
    const clk = new SimClock();
    clk.start(0);
    let comps = c.components;
    for (let i = 1; i <= 30; i++) {
      const res = runSimulationFrame(clk, i * (1000 / 60), { speed: 2, accuracy: 1, simulator: sim }, comps, c.wires);
      if (res) comps = res.components;
    }
    const vc = Number(comps.find((x) => x.id === 'c')!.state.voltage);
    expect(clk.simTime).toBeCloseTo(1000, 6);
    expect(Math.abs(vc - 5 * (1 - Math.exp(-1)))).toBeLessThan(0.005);
  });

  it('a switch closed by the user is not reverted by the engine result', () => {
    const c = new Circuit();
    c.add('power', 'v1', { voltage: 5 });
    c.add('switch', 'sw', {}, { closed: 0 });
    c.add('resistor', 'r', { resistance: 1000 });
    c.wire('v1:pos', 'sw:a'); c.wire('sw:b', 'r:a'); c.wire('r:b', 'v1:neg');
    const sim = new CircuitSimulator();
    const clk = new SimClock();
    clk.start(0);
    const res = runSimulationFrame(clk, 16, { speed: 1, accuracy: 1, simulator: sim }, c.components, c.wires)!;
    // The user closes the switch while the frame's result is pending:
    const userEdited = res.components.map((x) => (x.id === 'sw' ? { ...x, state: { ...x.state, closed: 1 } } : x));
    const res2 = runSimulationFrame(clk, 32, { speed: 1, accuracy: 1, simulator: sim }, userEdited, c.wires)!;
    expect(Number(res2.components.find((x) => x.id === 'sw')!.state.closed)).toBe(1);
    expect(Number(res2.components.find((x) => x.id === 'r')!.state.current)).toBeGreaterThan(4e-3);
  });
});
