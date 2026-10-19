/**
 * Test helper: builds circuits through the same data structures the UI
 * creates (PlacedComponent[] + Wire[]) and runs CircuitSimulator.tick()
 * exactly as App.tsx does (sim time advances 100 ms per tick, dt = 0.1 s).
 *
 * Components added with add() are placed far off the breadboard, so they
 * are connected ONLY by wires (pure netlist). Use place() to put a
 * component on breadboard holes.
 */
import { CircuitSimulator } from '../../src/engine/CircuitSimulator';
import type { PlacedComponent, Wire, WireEndpoint } from '../../src/types';
import { COMPONENT_DEFINITIONS } from '../../src/data/components';
import { BOARD_X_OFFSET, GRID_W, GRID_H } from '../../src/data/breadboard';

export type States = Map<string, Record<string, number | string>>;

export class Circuit {
  components: PlacedComponent[] = [];
  wires: Wire[] = [];
  sim = new CircuitSimulator();
  timeMs = 0;
  last: States = new Map();
  private n = 0;

  /** Add an off-board component (wires only). */
  add(type: string, id: string, props: Record<string, number | string> = {}, state: Record<string, number | string> = {}): string {
    const def = COMPONENT_DEFINITIONS[type];
    if (!def) throw new Error(`unknown type ${type}`);
    const defaults: Record<string, number | string> = {};
    for (const [k, p] of Object.entries(def.properties ?? {})) defaults[k] = p.default;
    // Far negative coordinates never map onto a breadboard hole.
    const i = this.n++;
    this.components.push({
      id, type, rotation: 0,
      position: { x: -100000 - i * 1000, y: -100000 },
      properties: { ...defaults, ...props },
      state: { ...state },
    });
    return id;
  }

  /**
   * Place a component so that its pin `anchorPin` sits on board hole (col,row).
   * Works for 2-terminal parts (top/bottom pins) and DIP chips (left/right pins).
   */
  place(type: string, id: string, col: number, row: number, props: Record<string, number | string> = {}, anchorPin?: string): string {
    this.add(type, id, props);
    const comp = this.components[this.components.length - 1];
    const def = COMPONENT_DEFINITIONS[type];
    const pin = def.pins.find((p) => p.id === (anchorPin ?? def.pins[0].id))!;
    const w = def.width * GRID_W;
    const h = def.height * GRID_H;
    let px = 0, py = 0;
    switch (pin.side) {
      case 'left': px = 0; py = h * pin.offset; break;
      case 'right': px = w; py = h * pin.offset; break;
      case 'top': px = w * pin.offset; py = 0; break;
      case 'bottom': px = w * pin.offset; py = h; break;
    }
    const hx = BOARD_X_OFFSET + col * GRID_W + GRID_W / 2;
    const hy = row * GRID_H + GRID_H / 2;
    comp.position = { x: hx - px, y: hy - py };
    return id;
  }

  get(id: string): PlacedComponent {
    const c = this.components.find((x) => x.id === id);
    if (!c) throw new Error(`no component ${id}`);
    return c;
  }

  /** wire('r1:a', 'v1:pos') or wire('board:3,4', ...) */
  wire(from: string, to: string): void {
    const ep = (s: string): WireEndpoint => {
      const idx = s.indexOf(':');
      return { componentId: s.slice(0, idx), pinId: s.slice(idx + 1) };
    };
    this.wires.push({ id: `w${this.wires.length}`, from: ep(from), to: ep(to), waypoints: [], color: '#fff' });
  }

  /** Run n ticks exactly like App.tsx: time += 100 ms, dt = 0.1 s, state written back. */
  run(n = 1, opts: { subSteps?: number; dt?: number; onTick?: (c: Circuit) => void } = {}): States {
    const dt = opts.dt ?? 0.1;
    this.sim.subSteps = opts.subSteps ?? 1;
    for (let k = 0; k < n; k++) {
      this.timeMs += dt * 1000;
      const states = this.sim.tick(this.components, this.wires, this.timeMs, dt);
      this.components = this.components.map((c) => {
        const s = states.get(c.id);
        return s ? { ...c, state: s } : c;
      });
      this.last = states;
      opts.onTick?.(this);
    }
    return this.last;
  }

  s(id: string, key: string): number {
    const v = this.last.get(id)?.[key];
    return Number(v);
  }

  /** Node voltage seen via a 10 MΩ multimeter placed between two endpoints. */
  meter(id: string, pos: string, neg: string): void {
    this.add('multimeter', id);
    this.wire(`${id}:pos`, pos);
    this.wire(`${id}:neg`, neg);
  }
}

/** Collected measurements printed at the end (expected vs simulated). */
export const report: { name: string; expected: number; simulated: number; unit: string }[] = [];

export function record(name: string, expected: number, simulated: number, unit = ''): number {
  report.push({ name, expected, simulated, unit });
  const err = expected === 0 ? simulated - expected : (simulated - expected) / Math.abs(expected) * 100;
  // eslint-disable-next-line no-console
  console.log(`[measure] ${name}: expected ${fmt(expected)}${unit}, simulated ${fmt(simulated)}${unit}, ${expected === 0 ? 'abs err ' + fmt(err) : 'err ' + err.toFixed(2) + '%'}`);
  return simulated;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e5)) return v.toExponential(4);
  return Number(v.toPrecision(5)).toString();
}

/** relative error |a-e|/|e| */
export function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}
