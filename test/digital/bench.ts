// Test bench: builds circuits through the engine's own data model
// (PlacedComponent[] + Wire[]) exactly as App.tsx feeds them to
// CircuitSimulator.tick(), but places every part OFF the breadboard so the
// netlist is defined only by explicit pin-to-pin wires.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CircuitSimulator } from '../../src/engine/CircuitSimulator';
import { COMPONENT_DEFINITIONS } from '../../src/data/components';
import type { PlacedComponent, Wire } from '../../src/types';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');
export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf-8');
}
export function ino(name: string): string {
  return readFileSync(join(HERE, '..', '..', 'ino', name), 'utf-8');
}

export class Bench {
  comps: PlacedComponent[] = [];
  wires: Wire[] = [];
  sim = new CircuitSimulator();
  timeMs = 0;
  last = new Map<string, Record<string, number | string>>();
  private n = 0;
  private probes = new Map<string, string>();

  /** Add a part far off the breadboard (no implicit strip connections). */
  add(type: string, id: string, properties: Record<string, number | string> = {}): string {
    const def = COMPONENT_DEFINITIONS[type];
    if (!def) throw new Error(`unknown type ${type}`);
    const props: Record<string, number | string> = {};
    for (const [k, p] of Object.entries(def.properties ?? {})) props[k] = p.default;
    Object.assign(props, properties);
    this.comps.push({
      id, type, rotation: 0, properties: props, state: {},
      position: { x: 20000 + 2000 * this.n, y: 20000 + 2000 * this.n },
    });
    this.n++;
    return id;
  }

  /** A 5 V (default) supply; its '-' pin is the simulator's ground node. */
  power(id = 'pwr', voltage = 5): string {
    return this.add('power', id, { voltage, mode: 'DC', waveform: 'square' });
  }

  /** wire('u1.vcc', 'pwr.pos') */
  wire(a: string, b: string): this {
    const [ac, ap] = a.split('.');
    const [bc, bp] = b.split('.');
    this.wires.push({
      id: `w${this.wires.length}`, from: { componentId: ac, pinId: ap },
      to: { componentId: bc, pinId: bp }, waypoints: [], color: '#fff',
    });
    return this;
  }

  /** Connect pin to supply + (HIGH) or ground (LOW). */
  hi(pin: string, pwr = 'pwr'): this { return this.wire(pin, `${pwr}.pos`); }
  lo(pin: string, pwr = 'pwr'): this { return this.wire(pin, `${pwr}.neg`); }

  /** Attach a 10 MΩ voltmeter from pin to ground so its node voltage is observable. */
  probe(pin: string, pwr = 'pwr'): this {
    const id = `vm_${pin.replace('.', '_')}`;
    if (this.probes.has(pin)) return this;
    this.add('multimeter', id, { mode: 'voltage' });
    this.wire(`${id}.pos`, pin);
    this.wire(`${id}.neg`, `${pwr}.neg`);
    this.probes.set(pin, id);
    return this;
  }
  v(pin: string): number {
    const id = this.probes.get(pin);
    if (!id) throw new Error(`no probe on ${pin}`);
    return Number(this.last.get(id)?.voltage ?? NaN);
  }

  /** Remove every wire touching pin (to re-drive it). */
  unwire(pin: string): this {
    const [c, p] = pin.split('.');
    this.wires = this.wires.filter((w) =>
      !((w.from.componentId === c && w.from.pinId === p) || (w.to.componentId === c && w.to.pinId === p)));
    return this;
  }

  /** Remove only the wires tying pin to a supply rail (keeps signal wires). */
  unrail(pin: string, pwr = 'pwr'): this {
    const [c, p] = pin.split('.');
    const isPin = (e: { componentId: string; pinId: string }) => e.componentId === c && e.pinId === p;
    const isRail = (e: { componentId: string }) => e.componentId === pwr;
    this.wires = this.wires.filter((w) => !((isPin(w.from) && isRail(w.to)) || (isPin(w.to) && isRail(w.from))));
    return this;
  }

  /** Drive pin HIGH/LOW by replacing its rail wire. */
  drive(pin: string, high: boolean): this {
    this.unrail(pin);
    return high ? this.hi(pin) : this.lo(pin);
  }

  /** Run n ticks of dt seconds, applying state back like App.tsx does. */
  tick(n = 1, dt = 0.1): Map<string, Record<string, number | string>> {
    for (let i = 0; i < n; i++) {
      this.timeMs += dt * 1000;
      const states = this.sim.tick(this.comps, this.wires, this.timeMs, dt);
      this.comps = this.comps.map((c) => {
        const s = states.get(c.id);
        return s ? { ...c, state: s } : c;
      });
      this.last = states;
    }
    return this.last;
  }

  /** Tick until the circuit settles (combinational logic has 1 tick per gate). */
  settle(n = 6): this { this.tick(n); return this; }

  s(id: string): Record<string, number | string> { return this.last.get(id) ?? {}; }

  set(id: string, key: string, value: number | string): this {
    const c = this.comps.find((x) => x.id === id)!;
    c.state = { ...c.state, [key]: value };
    return this;
  }
}

export function seg7(state: Record<string, number | string>): string {
  return ['a', 'b', 'c', 'd', 'e', 'f', 'g'].filter((s) => Number(state[`seg_${s}`]) === 1).join('');
}
