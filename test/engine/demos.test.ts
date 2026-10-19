// The built-in demo circuits, after the DIP pinout fix and full-length rails.
import { describe, it, expect } from 'vitest';
import { CircuitSimulator } from '../../src/engine/CircuitSimulator';
import { COMPONENT_DEFINITIONS } from '../../src/data/components';
import {
  createBlinkDemoCircuit, createCounterDemoCircuit, createAVRBlinkDemoCircuit,
  createMatrixDemoCircuit, createNecklaceDemoCircuit,
  AVR_BLINK_HEX, AVR_MATRIX_HEX, AVR_NECKLACE_HEX,
} from '../../src/engine/simulation';
import type { PlacedComponent, Wire, ComponentState } from '../../src/types';

type Demo = { components: PlacedComponent[]; wires: Wire[] };

function runner(d: Demo, hex?: string) {
  const sim = new CircuitSimulator();
  if (hex) sim.loadAVRProgram('avr1', hex);
  let comps = d.components;
  let t = 0;
  let last = new Map<string, ComponentState>();
  return {
    run(seconds: number, dt = 0.1, each?: (s: Map<string, ComponentState>) => void) {
      for (let i = 0; i < Math.round(seconds / dt); i++) {
        t += dt * 1000;
        last = sim.tick(comps, d.wires, t, dt);
        comps = comps.map((c) => (last.get(c.id) ? { ...c, state: last.get(c.id)! } : c));
        each?.(last);
      }
      return last;
    },
    get last() { return last; },
  };
}

const DEMOS: [string, () => Demo, string?][] = [
  ['blink', createBlinkDemoCircuit],
  ['counter', createCounterDemoCircuit],
  ['avr-blink', createAVRBlinkDemoCircuit, AVR_BLINK_HEX],
  ['matrix', createMatrixDemoCircuit, AVR_MATRIX_HEX],
  ['necklace', createNecklaceDemoCircuit, AVR_NECKLACE_HEX],
];

describe('demo circuits', () => {
  for (const [name, make, hex] of DEMOS) {
    it(`${name}: every wire ends on an existing pin or hole`, () => {
      const d = make();
      for (const w of d.wires) {
        for (const ep of [w.from, w.to]) {
          if (ep.componentId === 'board') continue;
          const comp = d.components.find((c) => c.id === ep.componentId);
          expect(comp, `${w.id}: no component ${ep.componentId}`).toBeTruthy();
          const def = COMPONENT_DEFINITIONS[comp!.type];
          expect(def.pins.some((p) => p.id === ep.pinId), `${w.id}: ${ep.componentId} has no pin ${ep.pinId}`).toBe(true);
        }
      }
    });

    it(`${name}: runs without any warning`, () => {
      const r = runner(make(), hex);
      const st = r.run(3);
      const warnings = [...st.entries()].filter(([, s]) => s.warning).map(([id, s]) => `${id}: ${s.warning!.code} ${s.warning!.message}`);
      expect(warnings).toEqual([]);
    });
  }

  it('blink: the LED blinks with the 555 period 0.693·(Ra+2Rb)·C ≈ 5.96 s', () => {
    const r = runner(createBlinkDemoCircuit());
    const rises: number[] = [];
    let prev = 0, t = 0;
    r.run(40, 0.1, (s) => {
      t += 0.1;
      const on = Number(s.get('led1')!.on);
      if (on && !prev) rises.push(t);
      prev = on;
    });
    const p = rises.slice(1);
    const period = (p[p.length - 1] - p[0]) / (p.length - 1);
    expect(Math.abs(period - 0.693 * (47e3 + 2 * 68e3) * 47e-6) / 5.96).toBeLessThan(0.03);
  });

  it('counter: the display counts up with the 555', () => {
    const r = runner(createCounterDemoCircuit());
    const seen = new Set<number>();
    r.run(30, 0.1, (s) => seen.add(Number(s.get('counter1')!.count)));
    expect(seen.size).toBeGreaterThanOrEqual(5);
    const seg = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter((x) => Number(r.last.get('display1')![`seg_${x}`]) === 1).join('');
    const DIG = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
    expect(seg).toBe(DIG[Number(r.last.get('counter1')!.count)]);
  });

  it('avr-blink: the LED on D13 turns on and off', () => {
    const r = runner(createAVRBlinkDemoCircuit(), AVR_BLINK_HEX);
    const states = new Set<number>();
    r.run(5, 0.1, (s) => states.add(Number(s.get('led1')!.on)));
    expect([...states].sort()).toEqual([0, 1]);
  });

  it('necklace: the matrix shows something', () => {
    const r = runner(createNecklaceDemoCircuit(), AVR_NECKLACE_HEX);
    let maxLit = 0;
    r.run(3, 0.1, (s) => {
      const m = s.get('matrix1')!;
      maxLit = Math.max(maxLit, Object.entries(m).filter(([k, v]) => k.startsWith('led_') && Number(v) === 1).length);
    });
    expect(maxLit).toBeGreaterThan(3);
  });
});
