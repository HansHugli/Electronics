import { PlacedComponent, Wire, ComponentState, ComponentWarning, WarningCode, ComponentDefinition } from '../types';
import { COMPONENT_DEFINITIONS, LED_FORWARD_VOLTAGE } from '../data/components';
import { BEHAVIOR_MODELS } from '../data/chipLoader';
import {
  GRID_W, GRID_H, BOARD_X_OFFSET,
  buildPinGroups, buildPinLookup,
} from '../data/breadboard';
import { AVRBridge, AVR_GPIO_PINS } from './avrBridge';
import { solveDenseInPlace } from './mna';

/**
 * Circuit simulator: Modified Nodal Analysis with automatic sub-stepping.
 *
 * One call to `tick(components, wires, timeMs, dt)` advances the circuit by
 * `dt` seconds of simulated time. Inside, the engine
 *  - builds the netlist once (wires, breadboard strips, closed switches),
 *  - picks a step size small enough for every RC time constant (≤ τ/50),
 *    every AC / function-generator frequency (≤ 1/(20 f)) and MCU (1 ms),
 *    bounded so a tick never takes more than a few thousand steps,
 *  - for each step solves the nonlinear circuit (LEDs: Shockley + series R,
 *    solved by Newton; outputs with current limits; op-amp as a VCVS with
 *    rail clamping; 7805 with dropout) and lets digital logic settle
 *    (gates, flip-flops, counters, shift registers, 555) by iterating logic
 *    evaluation and the solve until nothing changes,
 *  - integrates capacitors with BDF2 (second order, no ringing on stiff
 *    parts),
 *  - runs each ATmega for the step and replays its pin edges, in cycle order,
 *    through the digital logic so edges shorter than a step are not lost,
 *  - locates 555 comparator crossings inside a step, so oscillator timing
 *    doesn't depend on the step size.
 *
 * Logic is 74HC CMOS: an input reads LOW below 0.3·VCC and HIGH above
 * 0.7·VCC and keeps its previous level in between (hysteresis). A floating
 * input keeps its previous level (LOW at power-up) and is flagged.
 *
 * Problems are reported per component in `state.warning` ({ code, message }).
 */

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function getDef(type: string): ComponentDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(COMPONENT_DEFINITIONS, type) ? COMPONENT_DEFINITIONS[type] : undefined;
}

/** Get the pixel position of a component pin, accounting for rotation. */
function getComponentPinPixel(comp: PlacedComponent, def: ComponentDefinition, pinId: string): { x: number; y: number } | null {
  const pin = def.pins.find((p) => p.id === pinId);
  if (!pin) return null;
  const isRotated = comp.rotation === 90 || comp.rotation === 270;
  const w = (isRotated ? def.height : def.width) * GRID_W;
  const h = (isRotated ? def.width : def.height) * GRID_H;
  const sides: ('top' | 'right' | 'bottom' | 'left')[] = ['top', 'right', 'bottom', 'left'];
  const idx = Math.max(0, sides.indexOf(pin.side));
  const steps = ((Math.round((comp.rotation || 0) / 90) % 4) + 4) % 4;
  const side = sides[(idx + steps) % 4];
  const off = Number.isFinite(pin.offset) ? pin.offset : 0.5;
  let px = 0, py = 0;
  switch (side) {
    case 'left':   px = 0;          py = h * off; break;
    case 'right':  px = w;          py = h * off; break;
    case 'top':    px = w * off;    py = 0;       break;
    case 'bottom': px = w * off;    py = h;       break;
  }
  return { x: comp.position.x + px, y: comp.position.y + py };
}

function pixelToBoardGrid(px: number, py: number): { col: number; row: number } {
  return {
    col: Math.round((px - BOARD_X_OFFSET - GRID_W / 2) / GRID_W),
    row: Math.round((py - GRID_H / 2) / GRID_H),
  };
}

const boardPinGroups = buildPinGroups();
const boardPinLookup = buildPinLookup(boardPinGroups);
const boardGroupById = new Map(boardPinGroups.map((g) => [g.id, g]));

// ---------------------------------------------------------------------------
// Model constants
// ---------------------------------------------------------------------------

const GMIN = 1e-9;             // every node to ground (keeps floating nodes solvable)
const H_MAX = 0.01;            // largest step (s)
const H_MIN = 50e-6;           // smallest automatic step (s)
const H_MCU = 0.001;           // MCU chunk (s)
const MAX_STEPS_PER_TICK = 20000;
const MAX_NEWTON = 60;
const MAX_DIGITAL_ROUNDS = 40;

/** LED: Shockley diode (n·Vt) in series with Rs; Vf is the voltage at 20 mA. */
export const LED_MODEL = { nVt: 0.05, rs: 5, iRef: 0.02, maxSafeCurrent: 0.03 } as const;

/** Voltage across an LED (diode + series R) at `current` amps, for its Vf (at 20 mA). */
export function ledVoltageAt(current: number, vf: number): number {
  const vdRef = vf - LED_MODEL.iRef * LED_MODEL.rs;
  return vdRef + LED_MODEL.nVt * Math.log(current / LED_MODEL.iRef) + current * LED_MODEL.rs;
}

const SUPPLY_R = 0.05;         // bench supply internal resistance (Ω)
const SUPPLY_ILIM = 1;         // bench supply current limit (A)
const FUNCGEN_R = 0.1;
const FUNCGEN_ILIM = 1;
const VREG_R = 0.05;
const VREG_ILIM = 1.5;
const VREG_IQ = 0.005;         // 7805 quiescent current
const OPAMP_RO = 75;
const OPAMP_HEADROOM = 1.25;   // LM741 output swing to each rail
const METER_R_VOLT = 10e6;
const METER_R_AMP = 0.1;

interface Family { vil: number; vih: number; r0: number; ilim: number; vmin: number; name: string }
const FAMILY_HC: Family = { vil: 0.3, vih: 0.7, r0: 50, ilim: 0.025, vmin: 2, name: '74HC' };
const FAMILY_CD4000: Family = { vil: 0.3, vih: 0.7, r0: 400, ilim: 0.01, vmin: 3, name: 'CD4000' };
const AVR_FAMILY: Family = { vil: 0.3, vih: 0.6, r0: 25, ilim: 0.04, vmin: 1.8, name: 'ATmega' };
const AVR_PULLUP = 35e3;
const AVR_RESET_PULLUP = 50e3;

const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
function e12Above(r: number): number {
  if (!(r > 0) || !Number.isFinite(r)) return 100;
  const dec = Math.pow(10, Math.floor(Math.log10(r)));
  for (const m of E12) if (m * dec >= r * 0.999) return Math.round(m * dec);
  return Math.round(10 * dec);
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Linear system
// ---------------------------------------------------------------------------

class Sys {
  n: number;
  A: Float64Array;
  b: Float64Array;
  constructor(n: number) {
    this.n = n;
    this.A = new Float64Array(n * n);
    this.b = new Float64Array(n);
  }
  clear(): void { this.A.fill(0); this.b.fill(0); }
  /** Conductance g between nodes a and b (node 0 = ground). */
  g(a: number, b: number, g: number): void {
    const n = this.n;
    if (a > 0) this.A[(a - 1) * n + (a - 1)] += g;
    if (b > 0) this.A[(b - 1) * n + (b - 1)] += g;
    if (a > 0 && b > 0) {
      this.A[(a - 1) * n + (b - 1)] -= g;
      this.A[(b - 1) * n + (a - 1)] -= g;
    }
  }
  /** Current i injected into node a. */
  inj(a: number, i: number): void { if (a > 0) this.b[a - 1] += i; }
  /** Matrix entry for row `r` (node), column `c` (node). */
  m(r: number, c: number, v: number): void { if (r > 0 && c > 0) this.A[(r - 1) * this.n + (c - 1)] += v; }
  /** Norton source: voltage `v` from node p to node q through conductance g. */
  norton(p: number, q: number, v: number, g: number): void {
    this.g(p, q, g);
    this.inj(p, v * g);
    this.inj(q, -v * g);
  }
}

const V = (x: Float64Array, n: number): number => (n > 0 ? x[n - 1] : 0);

interface Ctx {
  t: number;          // time at the end of the step (s)
  h: number;          // step (s)
  x: Float64Array;    // latest solution
  xPrev: Float64Array; // solution at the start of the step
}

/** Per-tick bookkeeping a model reports on. */
interface TickFlags {
  limited: boolean;      // a current limit was active
  maxCurrent: number;
}

// ---------------------------------------------------------------------------
// Element base
// ---------------------------------------------------------------------------

abstract class Elem {
  constructor(public comp: PlacedComponent, public sim: CircuitSimulator) {}
  /** Add this element to the matrix for the current iteration. */
  stamp(_s: Sys, _c: Ctx): void {}
  /** After a solve: update the linearization / mode. Return true if not converged. */
  iterate(_c: Ctx): boolean { return false; }
  /** The step was accepted: commit integration state and accumulate results. */
  commit(_c: Ctx): void {}
  /** DC connectivity for floating-node detection. */
  edges(_add: (a: number, b: number) => void): void {}
  /** Does this element supply energy (anchors its nodes)? */
  isSource(): boolean { return false; }
  /** Add this element's conductance to each node (time-constant estimate). */
  condEstimate(_g: Float64Array): void {}
  /** Largest step this element tolerates (s). */
  maxStep(): number { return Infinity; }
  /** Rollback support (555 event location). */
  save(): unknown { return undefined; }
  restore(_s: unknown): void {}
  /** Fill the component's result state at the end of the tick. */
  result(_res: ComponentState, _x: Float64Array): void {}
  /** Value plotted by the oscilloscope (V), or undefined. */
  probe(_x: Float64Array): number | undefined { return undefined; }
  /** Called at the start of each tick. */
  beginTick(): void {}
}

// --- Adaptive output: resistance R0, current limited to ilim -----------------

/** Fixed-point for a current-limited driver: R = max(R0, |ΔV| / Ilim). */
function adaptR(rCur: number, r0: number, ilim: number, dv: number): { r: number; changed: boolean } {
  const want = Math.max(r0, Math.abs(dv) / ilim);
  const changed = Math.abs(want - rCur) > 1e-4 * rCur + 1e-9;
  return { r: want, changed };
}

// --- Resistor ----------------------------------------------------------------

class ResistorElem extends Elem {
  r: number;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, public a: number, public b: number) {
    super(comp, sim);
    const R = num(comp.properties.resistance, 220);
    this.r = R > 1e-3 ? R : 1e-3; // zero / negative / invalid → 1 mΩ
  }
  stamp(s: Sys): void { s.g(this.a, this.b, 1 / this.r); }
  edges(add: (a: number, b: number) => void): void { add(this.a, this.b); }
  condEstimate(g: Float64Array): void { g[this.a] += 1 / this.r; g[this.b] += 1 / this.r; }
  result(res: ComponentState, x: Float64Array): void {
    const dv = V(x, this.a) - V(x, this.b);
    res.voltage = dv;
    res.current = dv / this.r;
  }
  probe(x: Float64Array): number { return V(x, this.a) - V(x, this.b); }
}

class PotElem extends Elem {
  r1: number; r2: number;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, public p1: number, public w: number, public p2: number) {
    super(comp, sim);
    const R = Math.max(1, num(comp.properties.resistance, 10000));
    const pos = Math.min(1, Math.max(0, num(comp.properties.position, 50) / 100));
    this.r1 = Math.max(R * pos, 1e-3);
    this.r2 = Math.max(R * (1 - pos), 1e-3);
  }
  stamp(s: Sys): void { s.g(this.p1, this.w, 1 / this.r1); s.g(this.w, this.p2, 1 / this.r2); }
  edges(add: (a: number, b: number) => void): void { add(this.p1, this.w); add(this.w, this.p2); }
  condEstimate(g: Float64Array): void {
    g[this.p1] += 1 / this.r1; g[this.w] += 1 / this.r1 + 1 / this.r2; g[this.p2] += 1 / this.r2;
  }
  result(res: ComponentState, x: Float64Array): void {
    res.voltage = V(x, this.p1) - V(x, this.p2);
    res.wiperVoltage = V(x, this.w);
    res.current = (V(x, this.p1) - V(x, this.w)) / this.r1;
  }
  probe(x: Float64Array): number { return V(x, this.w); }
}

class MeterElem extends Elem {
  amp: boolean;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, public p: number, public n: number) {
    super(comp, sim);
    this.amp = String(comp.properties.mode ?? 'voltage') === 'current';
  }
  get r(): number { return this.amp ? METER_R_AMP : METER_R_VOLT; }
  stamp(s: Sys): void { s.g(this.p, this.n, 1 / this.r); }
  edges(add: (a: number, b: number) => void): void { if (this.amp) add(this.p, this.n); }
  condEstimate(g: Float64Array): void { if (this.amp) { g[this.p] += 1 / this.r; g[this.n] += 1 / this.r; } }
  result(res: ComponentState, x: Float64Array): void {
    const v = V(x, this.p) - V(x, this.n);
    const i = v / this.r;
    res.voltage = v;
    res.current = i;
    res.displayValue = this.amp ? i : v;
    res.displayUnit = this.amp ? 'A' : 'V';
  }
  probe(x: Float64Array): number { return this.amp ? (V(x, this.p) - V(x, this.n)) / this.r : V(x, this.p) - V(x, this.n); }
}

// --- Sources ----------------------------------------------------------------

abstract class SourceElem extends Elem {
  rEff: number;
  flags: TickFlags = { limited: false, maxCurrent: 0 };
  constructor(comp: PlacedComponent, sim: CircuitSimulator, public p: number, public q: number, public r0: number, public ilim: number) {
    super(comp, sim);
    this.rEff = r0;
  }
  abstract value(t: number): number;
  isSource(): boolean { return true; }
  beginTick(): void { this.flags = { limited: false, maxCurrent: 0 }; }
  stamp(s: Sys, c: Ctx): void {
    if (this.p === this.q) return; // shorted by a wire: nothing to stamp
    s.norton(this.p, this.q, this.value(c.t), 1 / this.rEff);
  }
  iterate(c: Ctx): boolean {
    const vs = this.value(c.t);
    if (this.p === this.q) { this.rEff = Math.max(this.r0, Math.abs(vs) / this.ilim); return false; }
    const dv = vs - (V(c.x, this.p) - V(c.x, this.q));
    const a = adaptR(this.rEff, this.r0, this.ilim, dv);
    this.rEff = a.r;
    return a.changed;
  }
  /** Current delivered out of the + terminal (A). */
  sourced(x: Float64Array, t: number): number {
    const vs = this.value(t);
    if (this.p === this.q) return vs / this.rEff;
    return (vs - (V(x, this.p) - V(x, this.q))) / this.rEff;
  }
  commit(c: Ctx): void {
    const i = Math.abs(this.sourced(c.x, c.t));
    if (this.rEff > this.r0 * 1.05 || this.p === this.q) this.flags.limited = true;
    if (i > this.flags.maxCurrent) this.flags.maxCurrent = i;
  }
  edges(add: (a: number, b: number) => void): void { add(this.p, this.q); }
  condEstimate(g: Float64Array): void { g[this.p] += 1 / this.r0; g[this.q] += 1 / this.r0; }
  warnShort(res: ComponentState, what: string): void {
    if (this.flags.limited) {
      setWarning(res, 'short_circuit',
        `Short circuit: the ${what} is connected across (almost) no resistance, so it is limiting the current to ${this.ilim} A. Check for a wire or part joining + and −.`);
    }
  }
}

class SupplyElem extends SourceElem {
  v: number; ac: boolean; sine: boolean; freq: number;
  lastT = 0;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, p: number, q: number) {
    super(comp, sim, p, q, SUPPLY_R, SUPPLY_ILIM);
    this.v = num(comp.properties.voltage, 5);
    this.ac = String(comp.properties.mode ?? 'DC') === 'AC';
    this.sine = String(comp.properties.waveform ?? 'square') === 'sine';
    this.freq = Math.max(0, num(comp.properties.frequency, 1));
  }
  value(t: number): number {
    if (!this.ac) return this.v;
    const phase = ((this.freq * t) % 1 + 1) % 1;
    if (this.sine) return this.v * Math.sin(2 * Math.PI * phase);
    return phase < 0.5 ? this.v : -this.v;
  }
  maxStep(): number { return this.ac && this.freq > 0 ? 1 / (20 * this.freq) : Infinity; }
  commit(c: Ctx): void { super.commit(c); this.lastT = c.t; }
  result(res: ComponentState, x: Float64Array): void {
    res.current = -this.sourced(x, this.lastT); // negative while delivering current (MNA convention)
    res.voltage = this.p === this.q ? 0 : V(x, this.p) - V(x, this.q);
    this.warnShort(res, 'power supply');
  }
  probe(x: Float64Array): number { return V(x, this.p) - V(x, this.q); }
}

class FuncGenElem extends SourceElem {
  amp: number; freq: number; wave: string; dc: number;
  lastT = 0;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, p: number, q: number) {
    super(comp, sim, p, q, FUNCGEN_R, FUNCGEN_ILIM);
    this.amp = num(comp.properties.amplitude, 5);
    this.freq = Math.max(0, num(comp.properties.frequency, 1));
    this.wave = String(comp.properties.waveform ?? 'sine');
    this.dc = num(comp.properties.offset, 0);
  }
  value(t: number): number {
    const phase = ((this.freq * t) % 1 + 1) % 1;
    switch (this.wave) {
      case 'square': return this.amp * (phase < 0.5 ? 1 : -1) + this.dc;
      case 'triangle': return this.amp * (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase) + this.dc;
      case 'sawtooth': return this.amp * (2 * phase - 1) + this.dc;
      default: return this.amp * Math.sin(2 * Math.PI * phase) + this.dc;
    }
  }
  maxStep(): number { return this.freq > 0 ? 1 / (20 * this.freq) : Infinity; }
  commit(c: Ctx): void { super.commit(c); this.lastT = c.t; }
  result(res: ComponentState, x: Float64Array): void {
    res.voltage = V(x, this.p) - V(x, this.q);
    res.current = this.sourced(x, this.lastT);
    this.warnShort(res, 'function generator');
  }
  probe(x: Float64Array): number { return V(x, this.p) - V(x, this.q); }
}

// --- Capacitor (BDF2, variable step) ------------------------------------------

interface CapHist { v1: number; v2: number; hPrev: number; n: number; i: number }

class CapElem extends Elem {
  C: number;
  hist: CapHist;
  g = 0; ihist = 0;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, public p: number, public q: number) {
    super(comp, sim);
    const uF = num(comp.properties.capacitance, 100);
    this.C = uF > 0 ? uF * 1e-6 : 0; // zero / negative / invalid → no capacitor
    this.hist = sim.persistFor<CapHist>(comp, 'cap', () => ({ v1: 0, v2: 0, hPrev: 0, n: 0, i: 0 }));
  }
  private coeffs(h: number): { a0: number; a1: number; a2: number } {
    const H = this.hist;
    if (H.n < 2 || H.hPrev <= 0) return { a0: 1, a1: -1, a2: 0 }; // backward Euler to start
    const w = h / H.hPrev;
    if (w > 2.2) return { a0: 1, a1: -1, a2: 0 };               // BDF2 is only stable for ω < 2.41
    return { a0: (1 + 2 * w) / (1 + w), a1: -(1 + w), a2: (w * w) / (1 + w) };
  }
  stamp(s: Sys, c: Ctx): void {
    if (this.C <= 0) return;
    const { a0, a1, a2 } = this.coeffs(c.h);
    const k = this.C / c.h;
    this.g = k * a0;
    this.ihist = k * (a1 * this.hist.v1 + a2 * this.hist.v2);
    // i(p→q) = g·v + ihist  → stamp g and a source of ihist flowing p→q
    s.g(this.p, this.q, this.g);
    s.inj(this.p, -this.ihist);
    s.inj(this.q, this.ihist);
  }
  commit(c: Ctx): void {
    if (this.C <= 0) { this.hist.i = 0; return; }
    const v = V(c.x, this.p) - V(c.x, this.q);
    const H = this.hist;
    H.i = this.g * v + this.ihist;
    H.v2 = H.v1; H.v1 = v; H.hPrev = c.h; H.n++;
  }
  edges(add: (a: number, b: number) => void): void { if (this.C > 0) add(this.p, this.q); }
  save(): unknown { return { ...this.hist }; }
  restore(s: unknown): void { Object.assign(this.hist, s as CapHist); }
  result(res: ComponentState, x: Float64Array): void {
    res.voltage = V(x, this.p) - V(x, this.q);
    res.current = this.hist.i;
  }
  probe(x: Float64Array): number { return V(x, this.p) - V(x, this.q); }
}

// --- LED (diode + series resistance, Newton) ---------------------------------

interface LedLin { vd: number; v0: number; i0: number; gEff: number }

/** One LED junction: shared by the LED part and each 7-segment segment. */
class LedJunction {
  is: number;
  lin: LedLin;
  acc = { q: 0, vs: 0, t: 0, maxI: 0 };
  altI = 0;
  constructor(public a: number, public k: number, public vf: number, lin: LedLin) {
    const vdRef = vf - LED_MODEL.iRef * LED_MODEL.rs;
    this.is = LED_MODEL.iRef / Math.exp(vdRef / LED_MODEL.nVt);
    this.lin = lin;
  }
  private idiode(vd: number): { i: number; gd: number } {
    const e = Math.exp(Math.min(vd / LED_MODEL.nVt, 80));
    return { i: this.is * (e - 1), gd: (this.is / LED_MODEL.nVt) * e };
  }
  /** Solve the junction voltage for terminal voltage v (diode + Rs in series). */
  solveVd(v: number, guess: number): number {
    const rs = LED_MODEL.rs;
    let lo = Math.min(v, 0), hi = Math.max(v, 0);
    let vd = Math.min(hi, Math.max(lo, guess));
    for (let k = 0; k < 60; k++) {
      const { i, gd } = this.idiode(vd);
      const f = vd + rs * i - v;
      if (Math.abs(f) < 1e-12) break;
      if (f > 0) hi = vd; else lo = vd;
      let nx = vd - f / (1 + rs * gd);
      if (!(nx > lo && nx < hi)) nx = 0.5 * (lo + hi);
      if (Math.abs(nx - vd) < 1e-13) { vd = nx; break; }
      vd = nx;
    }
    return vd;
  }
  /** Current through the LED at terminal voltage v. */
  currentAt(v: number): number {
    const vd = this.solveVd(v, this.lin.vd);
    return this.idiode(vd).i;
  }
  stamp(s: Sys): void {
    const L = this.lin;
    // i(a→k) ≈ i0 + gEff·(v − v0)
    s.g(this.a, this.k, L.gEff + 1e-12);
    const ieq = L.i0 - L.gEff * L.v0;
    s.inj(this.a, -ieq);
    s.inj(this.k, ieq);
  }
  iterate(x: Float64Array): boolean {
    const v = V(x, this.a) - V(x, this.k);
    const L = this.lin;
    const iLin = L.i0 + L.gEff * (v - L.v0);
    const vd = this.solveVd(v, L.vd);
    const { i, gd } = this.idiode(vd);
    L.vd = vd; L.v0 = v; L.i0 = i;
    L.gEff = 1 / (LED_MODEL.rs + 1 / Math.max(gd, 1e-30));
    return Math.abs(i - iLin) > 1e-9 + 1e-6 * Math.abs(i);
  }
  current(x: Float64Array): number {
    return this.lin.i0 + this.lin.gEff * ((V(x, this.a) - V(x, this.k)) - this.lin.v0);
  }
  accumulate(x: Float64Array, h: number, pwmFrac: number | null): void {
    let i = this.current(x);
    if (pwmFrac !== null) i = pwmFrac * i + (1 - pwmFrac) * this.altI;
    const v = V(x, this.a) - V(x, this.k);
    this.acc.q += i * h; this.acc.vs += v * h; this.acc.t += h;
    if (i > this.acc.maxI) this.acc.maxI = i;
  }
  reset(): void { this.acc = { q: 0, vs: 0, t: 0, maxI: 0 }; }
  get avgI(): number { return this.acc.t > 0 ? this.acc.q / this.acc.t : 0; }
  get avgV(): number { return this.acc.t > 0 ? this.acc.vs / this.acc.t : 0; }
}

function ledVf(props: Record<string, number | string>, fallbackColor = 'red'): number {
  const color = String(props.color ?? fallbackColor).toLowerCase();
  const table = LED_FORWARD_VOLTAGE[color] ?? 2.0;
  const vf = num(props.forwardVoltage, 0);
  // 0 (or empty) = from colour. 2.0 V on a non-red LED is the old default value
  // that ignored the colour, so it is treated as "from colour" too.
  if (!(vf > 0.5) || (vf === 2.0 && color !== 'red' && LED_FORWARD_VOLTAGE[color] !== undefined)) return table;
  return Math.min(vf, 10);
}

class LedElem extends Elem {
  j: LedJunction;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, a: number, k: number) {
    super(comp, sim);
    const vf = ledVf(comp.properties);
    const lin = sim.persistFor<LedLin>(comp, 'led', () => ({ vd: 0, v0: 0, i0: 0, gEff: 1e-12 }));
    this.j = new LedJunction(a, k, vf, lin);
  }
  beginTick(): void { this.j.reset(); }
  stamp(s: Sys): void { this.j.stamp(s); }
  iterate(c: Ctx): boolean { return this.j.iterate(c.x); }
  commit(c: Ctx): void { this.j.accumulate(c.x, c.h, this.sim.pwmFrac); }
  save(): unknown { return { ...this.j.lin }; }
  restore(s: unknown): void { Object.assign(this.j.lin, s as LedLin); }
  result(res: ComponentState, x: Float64Array): void {
    const i = this.j.avgI;
    const brightness = Math.max(0, Math.min(1, i / LED_MODEL.iRef));
    res.current = i;
    res.voltage = this.j.acc.t > 0 ? this.j.avgV : V(x, this.j.a) - V(x, this.j.k);
    res.brightness = brightness;
    res.on = i > 0.001 ? 1 : 0;
    const a = this.j.a, k = this.j.k;
    if (i > LED_MODEL.maxSafeCurrent) {
      const vs = this.sim.maxSourceVoltage();
      const r = e12Above(Math.max(10, (vs - this.j.vf) / 0.02));
      setWarning(res, 'led_overcurrent',
        `This LED is drawing ${Math.round(i * 1000)} mA — add a resistor of about ${r} Ω in series.`);
    } else if (this.j.avgV < -1.0 && this.sim.isAnchored(a) && this.sim.isAnchored(k)) {
      setWarning(res, 'led_reversed',
        'This LED is in backwards, so no current flows. Turn it around: the + leg (anode, the longer one) goes toward the positive side.');
    } else if (this.sim.isAnchored(a) !== this.sim.isAnchored(k)) {
      setWarning(res, 'no_ground',
        this.sim.isAnchored(a)
          ? "This LED's − leg isn't connected back to the − side of the supply, so no current can flow."
          : "This LED's + leg isn't connected to the circuit, so no current can flow.");
    }
  }
  probe(x: Float64Array): number { return V(x, this.j.a) - V(x, this.j.k); }
}

const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'];

class SevenSegElem extends Elem {
  segs: LedJunction[];
  constructor(comp: PlacedComponent, sim: CircuitSimulator, segNodes: number[], com: number) {
    super(comp, sim);
    const vf = ledVf(comp.properties);
    const lins = sim.persistFor<LedLin[]>(comp, 'seg7', () => SEGMENTS.map(() => ({ vd: 0, v0: 0, i0: 0, gEff: 1e-12 })));
    this.segs = SEGMENTS.map((_, i) => new LedJunction(segNodes[i], com, vf, lins[i]));
  }
  beginTick(): void { for (const s of this.segs) s.reset(); }
  stamp(s: Sys): void { for (const j of this.segs) j.stamp(s); }
  iterate(c: Ctx): boolean {
    let nc = false;
    for (const j of this.segs) if (j.iterate(c.x)) nc = true;
    return nc;
  }
  commit(c: Ctx): void { for (const j of this.segs) j.accumulate(c.x, c.h, this.sim.pwmFrac); }
  save(): unknown { return this.segs.map((j) => ({ ...j.lin })); }
  restore(s: unknown): void { (s as LedLin[]).forEach((l, i) => Object.assign(this.segs[i].lin, l)); }
  result(res: ComponentState): void {
    let maxB = 0, worst = -1, worstI = 0;
    this.segs.forEach((j, i) => {
      const cur = j.avgI;
      const key = SEGMENTS[i];
      res[`seg_${key}`] = cur > 0.0005 ? 1 : 0;
      res[`bright_${key}`] = Math.max(0, Math.min(1, cur / LED_MODEL.iRef));
      maxB = Math.max(maxB, cur / LED_MODEL.iRef);
      if (cur > worstI) { worstI = cur; worst = i; }
    });
    res.brightness = Math.max(0, Math.min(1, maxB));
    if (worstI > LED_MODEL.maxSafeCurrent && worst >= 0) {
      setWarning(res, 'led_overcurrent',
        `Segment ${SEGMENTS[worst]} is drawing ${Math.round(worstI * 1000)} mA — drive the display through a resistor (about 220 Ω per segment) or from a driver chip such as the CD4026.`);
    }
  }
}

// --- 7805 regulator ------------------------------------------------------------

class VregElem extends Elem {
  vnom: number; drop: number;
  target = 0; iin = 0; rEff = VREG_R; limited = false;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, public vin: number, public vout: number, public gnd: number) {
    super(comp, sim);
    this.vnom = num(comp.properties.outputVoltage, 5);
    this.drop = Math.max(0, num(comp.properties.dropout, 2));
  }
  isSource(): boolean { return false; }
  beginTick(): void { this.limited = false; }
  private targetFor(x: Float64Array): number {
    const vi = V(x, this.vin) - V(x, this.gnd);
    return Math.max(0, Math.min(this.vnom, vi - this.drop));
  }
  private outCurrent(x: Float64Array): number {
    return (this.target - (V(x, this.vout) - V(x, this.gnd))) / this.rEff;
  }
  stamp(s: Sys): void {
    s.norton(this.vout, this.gnd, this.target, 1 / this.rEff);
    // Input draws the output current plus the quiescent current.
    s.inj(this.vin, -this.iin);
    s.inj(this.gnd, this.iin);
  }
  iterate(c: Ctx): boolean {
    const x = c.x;
    const t = this.targetFor(x);
    const io = Math.max(0, this.outCurrent(x));
    const vi = V(x, this.vin) - V(x, this.gnd);
    const scale = Math.max(0, Math.min(1, vi / 1.0)); // no input voltage → no input current
    const iin = (VREG_IQ + io) * scale;
    const a = adaptR(this.rEff, VREG_R, VREG_ILIM, this.target - (V(x, this.vout) - V(x, this.gnd)));
    const changed = Math.abs(t - this.target) > 1e-7 || Math.abs(iin - this.iin) > 1e-8 + 1e-6 * iin || a.changed;
    this.target = t; this.iin = iin; this.rEff = a.r;
    return changed;
  }
  commit(): void { if (this.rEff > VREG_R * 1.05) this.limited = true; }
  edges(add: (a: number, b: number) => void): void { add(this.vin, this.gnd); add(this.vout, this.gnd); }
  condEstimate(g: Float64Array): void { g[this.vout] += 1 / VREG_R; g[this.gnd] += 1 / VREG_R; }
  result(res: ComponentState, x: Float64Array): void {
    res.voltage = V(x, this.vout) - V(x, this.gnd);
    res.inputVoltage = V(x, this.vin) - V(x, this.gnd);
    res.current = this.outCurrent(x);
    if (this.limited) setWarning(res, 'overcurrent', `The regulator is overloaded — it can deliver at most ${VREG_ILIM} A.`);
  }
  probe(x: Float64Array): number { return V(x, this.vout) - V(x, this.gnd); }
}

// --- Op-amp (VCVS with rail clamping) -------------------------------------------

class OpampElem extends Elem {
  gain: number;
  mode: 0 | 1 | -1 | 2 = 0; // 0 linear, 1 saturated high, -1 saturated low, 2 unpowered
  constructor(comp: PlacedComponent, sim: CircuitSimulator,
    public ip: number, public in_: number, public out: number, public vp: number, public vn: number) {
    super(comp, sim);
    this.gain = Math.max(1, num(comp.properties.gain, 100000));
    const st = sim.persistFor<{ mode: number }>(comp, 'opamp', () => ({ mode: 0 }));
    this.mode = st.mode as OpampElem['mode'];
  }
  stamp(s: Sys): void {
    const go = 1 / OPAMP_RO;
    if (this.mode === 2) return;
    if (this.mode === 1) { s.norton(this.out, this.vp, -OPAMP_HEADROOM, go); return; }
    if (this.mode === -1) { s.norton(this.out, this.vn, OPAMP_HEADROOM, go); return; }
    // Linear: current into out = go·(A·(v+ − v−) + (Vpos + Vneg)/2 − vout)
    const A = this.gain;
    s.m(this.out, this.out, go);
    s.m(this.out, this.ip, -go * A);
    s.m(this.out, this.in_, go * A);
    s.m(this.out, this.vp, -go * 0.5);
    s.m(this.out, this.vn, -go * 0.5);
  }
  iterate(c: Ctx): boolean {
    const x = c.x;
    const vpos = V(x, this.vp), vneg = V(x, this.vn);
    let mode: OpampElem['mode'];
    if (vpos - vneg < 3) mode = 2;
    else {
      const lin = this.gain * (V(x, this.ip) - V(x, this.in_)) + 0.5 * (vpos + vneg);
      const hi = vpos - OPAMP_HEADROOM, lo = vneg + OPAMP_HEADROOM;
      if (this.mode === 0) {
        const vo = V(x, this.out);
        mode = vo > hi + 1e-9 ? 1 : vo < lo - 1e-9 ? -1 : 0;
      } else {
        mode = lin > hi ? 1 : lin < lo ? -1 : 0;
      }
    }
    const changed = mode !== this.mode;
    this.mode = mode;
    this.sim.persistFor<{ mode: number }>(this.comp, 'opamp', () => ({ mode: 0 })).mode = mode;
    return changed;
  }
  edges(add: (a: number, b: number) => void): void { add(this.out, this.vp); add(this.out, this.vn); }
  condEstimate(g: Float64Array): void { g[this.out] += 1 / OPAMP_RO; }
  result(res: ComponentState, x: Float64Array): void {
    res.voltage = V(x, this.out);
    res.inputDiff = V(x, this.ip) - V(x, this.in_);
    if (this.mode === 2 && (this.sim.isAnchored(this.ip) || this.sim.isAnchored(this.out))) {
      setWarning(res, 'unpowered', 'This op-amp has no power — connect V+ (pin 7) and V− (pin 4) to the supply.');
    }
  }
  probe(x: Float64Array): number { return V(x, this.out); }
}

// ---------------------------------------------------------------------------
// Digital parts
// ---------------------------------------------------------------------------

/** Something evaluated in the digital phase (Jacobi: compute all, then apply all). */
interface DigitalParticipant {
  /** Compute new outputs from the current inputs; return true if they change. */
  compute(mode: 'analog' | 'replay'): boolean;
  apply(): void;
}

type Out = boolean | null;

interface LogicSpec<S> {
  family: Family;
  inputs: string[];
  outputs: string[];
  init(): S;
  /** inp/prev are input levels now/before; st is the committed state. */
  evaluate(inp: boolean[], prev: boolean[], st: S): { out: Out[]; st: S };
  results(st: S, out: Out[], res: ComponentState): void;
}

interface ChipPersist<S> { inited: boolean; powered: boolean; prevIn: boolean[]; st: S; out: Out[]; rEff: number[] }

const SEG7: string[] = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];

function quadGate(fn: (a: boolean, b: boolean) => boolean): LogicSpec<null> {
  return {
    family: FAMILY_HC,
    inputs: ['1a', '1b', '2a', '2b', '3a', '3b', '4a', '4b'],
    outputs: ['1y', '2y', '3y', '4y'],
    init: () => null,
    evaluate: (inp) => ({ out: [0, 1, 2, 3].map((g) => fn(inp[2 * g], inp[2 * g + 1])), st: null }),
    results: (_st, out, res) => {
      ['1y', '2y', '3y', '4y'].forEach((p, i) => { (res as Record<string, unknown>)[p] = out[i] === true; });
    },
  };
}

const HEX_INV: LogicSpec<null> = {
  family: FAMILY_HC,
  inputs: ['1a', '2a', '3a', '4a', '5a', '6a'],
  outputs: ['1y', '2y', '3y', '4y', '5y', '6y'],
  init: () => null,
  evaluate: (inp) => ({ out: inp.map((v) => !v), st: null }),
  results: (_st, out, res) => {
    ['1y', '2y', '3y', '4y', '5y', '6y'].forEach((p, i) => { (res as Record<string, unknown>)[p] = out[i] === true; });
  },
};

interface DffState { q1: boolean; q2: boolean; both1: boolean; both2: boolean }
const DFF: LogicSpec<DffState> = {
  family: FAMILY_HC,
  inputs: ['1d', '1clk', '1pre', '1clr', '2d', '2clk', '2pre', '2clr'],
  outputs: ['1q', '1qn', '2q', '2qn'],
  init: () => ({ q1: false, q2: false, both1: false, both2: false }),
  evaluate: (inp, prev, st) => {
    const ns = { ...st };
    for (const k of [0, 1]) {
      const o = k * 4;
      const d = inp[o], clk = inp[o + 1], preN = inp[o + 2], clrN = inp[o + 3];
      let q = k === 0 ? ns.q1 : ns.q2;
      let both = false;
      if (!preN && !clrN) { q = true; both = true; }      // datasheet: Q = Q̄ = HIGH
      else if (!clrN) q = false;
      else if (!preN) q = true;
      else if (clk && !prev[o + 1]) q = d;                // rising edge: capture D
      if (k === 0) { ns.q1 = q; ns.both1 = both; } else { ns.q2 = q; ns.both2 = both; }
    }
    return { out: [ns.q1, ns.both1 ? true : !ns.q1, ns.q2, ns.both2 ? true : !ns.q2], st: ns };
  },
  results: (st, out, res) => {
    res['1q'] = out[0] ? 1 : 0;
    res['1qn'] = out[1] ? 1 : 0;
    res['2q'] = out[2] ? 1 : 0;
    res['2qn'] = out[3] ? 1 : 0;
    void st;
  },
};

interface SrState { shift: number; store: number }
const SR595: LogicSpec<SrState> = {
  family: FAMILY_HC,
  inputs: ['ser', 'srclk', 'rclk', 'srclr', 'oe'],
  outputs: ['qa', 'qb', 'qc', 'qd', 'qe', 'qf', 'qg', 'qh', 'qh_p'],
  init: () => ({ shift: 0, store: 0 }),
  evaluate: (inp, prev, st) => {
    const [ser, srclk, rclk, srclrN, oeN] = inp;
    let shift = st.shift, store = st.store;
    // Storage clock samples the shift register as it was before this instant
    // (tied clocks: storage is one pulse behind, per the datasheet).
    if (rclk && !prev[2]) store = st.shift;
    if (!srclrN) shift = 0;
    else if (srclk && !prev[1]) shift = ((shift << 1) | (ser ? 1 : 0)) & 0xff;
    const out: Out[] = [];
    for (let i = 0; i < 8; i++) out.push(oeN ? null : ((store >> i) & 1) === 1);
    out.push(((shift >> 7) & 1) === 1);
    return { out, st: { shift, store } };
  },
  results: (st, _out, res) => { res.shiftBits = st.shift; res.outputBits = st.store; },
};

interface CounterState { count: number }
const CD4026: LogicSpec<CounterState> = {
  family: FAMILY_CD4000,
  inputs: ['clk', 'inh', 'en', 'rst'],
  outputs: ['out_a', 'out_b', 'out_c', 'out_d', 'out_e', 'out_f', 'out_g', 'co', 'deo', 'ung'],
  init: () => ({ count: 0 }),
  evaluate: (inp, prev, st) => {
    const [clk, inh, dei, rst] = inp;
    let count = st.count;
    if (rst) count = 0;
    else if (clk && !prev[0] && !inh) count = (count + 1) % 10;
    const pat = SEG7[count];
    const segs: Out[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => dei && pat.includes(s));
    // Carry out is HIGH for counts 0-4 and LOW for 5-9, so it rises on 9 → 0.
    return { out: [...segs, count < 5, dei, pat.includes('c')], st: { count } };
  },
  results: (st, _out, res) => { res.count = st.count; },
};

/** Built-in digital models by (resolved) component type. */
const LOGIC_SPECS: Record<string, LogicSpec<unknown>> = {
  gate_and: quadGate((a, b) => a && b) as LogicSpec<unknown>,
  gate_or: quadGate((a, b) => a || b) as LogicSpec<unknown>,
  gate_nand: quadGate((a, b) => !(a && b)) as LogicSpec<unknown>,
  gate_nor: quadGate((a, b) => !(a || b)) as LogicSpec<unknown>,
  gate_xor: quadGate((a, b) => a !== b) as LogicSpec<unknown>,
  gate_not: HEX_INV as LogicSpec<unknown>,
  flipflop_d: DFF as LogicSpec<unknown>,
  shift_register: SR595 as LogicSpec<unknown>,
  cd4026: CD4026 as LogicSpec<unknown>,
};

class LogicChipElem extends Elem implements DigitalParticipant {
  ps: ChipPersist<unknown>;
  pendingOut: Out[] | null = null;
  pendingSt: unknown = null;
  pendingIn: boolean[] | null = null;
  inNodes: number[];
  outNodes: number[];
  floatingInputs: number[] = [];
  limited = false;
  powered = false;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, public spec: LogicSpec<unknown>, public vcc: number, public gnd: number,
    nodeOf: (pin: string) => number) {
    super(comp, sim);
    this.inNodes = spec.inputs.map(nodeOf);
    this.outNodes = spec.outputs.map(nodeOf);
    this.ps = sim.persistFor<ChipPersist<unknown>>(comp, `logic:${comp.type}`, () => ({
      inited: false, powered: false, prevIn: spec.inputs.map(() => false), st: spec.init(),
      out: spec.outputs.map(() => null), rEff: spec.outputs.map(() => spec.family.r0),
    }));
    this.powered = this.ps.powered;
  }
  beginTick(): void { this.limited = false; }
  private supply(x: Float64Array): number { return V(x, this.vcc) - V(x, this.gnd); }
  private readInputs(mode: 'analog' | 'replay'): boolean[] {
    const x = mode === 'analog' ? this.sim.ctxX : this.sim.ctxXPrev;
    const vg = V(x, this.gnd), vs = this.supply(x);
    const f = this.spec.family;
    return this.inNodes.map((n, i) => {
      const prev = this.ps.prevIn[i];
      if (mode === 'replay') {
        const lv = this.sim.netLevel(n);
        if (lv !== undefined) return lv;
      }
      if (!this.sim.isAnchored(n)) return prev; // floating: keep the last level
      const v = V(x, n) - vg;
      if (v > f.vih * vs) return true;
      if (v < f.vil * vs) return false;
      return prev;
    });
  }
  compute(mode: 'analog' | 'replay'): boolean {
    const x = mode === 'analog' ? this.sim.ctxX : this.sim.ctxXPrev;
    const powered = this.sim.isAnchored(this.vcc) && this.sim.isAnchored(this.gnd) && this.supply(x) >= this.spec.family.vmin;
    if (!powered) {
      this.pendingIn = null; this.pendingSt = this.ps.st;
      this.pendingOut = this.spec.outputs.map(() => null);
      const changed = this.ps.powered || this.ps.out.some((o) => o !== null);
      this.powered = false;
      return changed;
    }
    const inp = this.readInputs(mode);
    const prev = this.ps.inited && this.ps.powered ? this.ps.prevIn : inp; // power-up: no edges
    const { out, st } = this.spec.evaluate(inp, prev, this.ps.st);
    this.pendingIn = inp; this.pendingSt = st; this.pendingOut = out;
    this.powered = true;
    let changed = !this.ps.powered || !this.ps.inited;
    for (let i = 0; i < out.length; i++) if (out[i] !== this.ps.out[i]) { changed = true; break; }
    return changed;
  }
  apply(): void {
    if (this.pendingOut) this.ps.out = this.pendingOut;
    if (this.pendingIn) this.ps.prevIn = this.pendingIn;
    this.ps.st = this.pendingSt;
    if (!this.powered) this.ps.inited = false;
    this.ps.powered = this.powered;
    this.pendingOut = null; this.pendingIn = null;
  }
  stamp(s: Sys): void {
    if (!this.ps.powered) return;
    const out = this.ps.out;
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      if (o === null) continue;
      s.g(this.outNodes[i], o ? this.vcc : this.gnd, 1 / this.ps.rEff[i]);
    }
  }
  iterate(c: Ctx): boolean {
    if (!this.ps.powered) return false;
    let nc = false;
    const f = this.spec.family;
    for (let i = 0; i < this.ps.out.length; i++) {
      const o = this.ps.out[i];
      if (o === null) { this.ps.rEff[i] = f.r0; continue; }
      const dv = V(c.x, o ? this.vcc : this.gnd) - V(c.x, this.outNodes[i]);
      const a = adaptR(this.ps.rEff[i], f.r0, f.ilim, dv);
      if (a.changed) nc = true;
      this.ps.rEff[i] = a.r;
    }
    return nc;
  }
  commit(): void {
    // Edges count only once the chip has been powered for a whole step (no power-up edges).
    this.ps.inited = this.ps.powered;
    if (!this.ps.powered) return;
    for (let i = 0; i < this.ps.out.length; i++) {
      if (this.ps.out[i] !== null && this.ps.rEff[i] > this.spec.family.r0 * 1.05) this.limited = true;
    }
  }
  edges(add: (a: number, b: number) => void): void {
    // Outputs tie their node to the chip's own VCC (not across VCC–GND, so a
    // missing GND wire still shows as unpowered).
    for (const n of this.outNodes) add(n, this.vcc);
  }
  condEstimate(g: Float64Array): void { for (const n of this.outNodes) g[n] += 1 / this.spec.family.r0; }
  save(): unknown {
    const p = this.ps;
    return { inited: p.inited, powered: p.powered, prevIn: [...p.prevIn], st: cloneState(p.st), out: [...p.out], rEff: [...p.rEff] };
  }
  restore(s: unknown): void {
    const v = s as ChipPersist<unknown>;
    const p = this.ps;
    p.inited = v.inited; p.powered = v.powered; p.prevIn = [...v.prevIn]; p.st = cloneState(v.st); p.out = [...v.out]; p.rEff = [...v.rEff];
  }
  result(res: ComponentState): void {
    const outs = this.ps.powered ? this.ps.out : this.spec.outputs.map(() => null);
    this.spec.results(this.ps.st, outs, res);
    const def = getDef(this.comp.type);
    const label = (pinId: string) => def?.pins.find((p) => p.id === pinId)?.label ?? pinId;
    const anyConnected = [...this.inNodes, ...this.outNodes, this.vcc, this.gnd].some((n) => this.sim.isAnchored(n));
    if (!this.ps.powered) {
      if (anyConnected) {
        setWarning(res, 'unpowered',
          `This chip has no power — connect ${label('vcc')} to + and ${label('gnd')} to − (a chip's outputs only work when it is powered).`);
      }
      return;
    }
    if (this.limited) {
      const i = this.ps.out.findIndex((o, k) => o !== null && this.ps.rEff[k] > this.spec.family.r0 * 1.05);
      const pin = i >= 0 ? label(this.spec.outputs[i]) : 'an output';
      setWarning(res, 'overcurrent',
        `Output ${pin} is overloaded — a ${this.spec.family.name} output can only supply about ${Math.round(this.spec.family.ilim * 1000)} mA. Add a resistor (about 220 Ω for an LED).`);
      return;
    }
    const floating = this.spec.inputs.filter((_, i) => !this.sim.isAnchored(this.inNodes[i]));
    if (floating.length > 0) {
      const names = floating.slice(0, 3).map(label).join(', ') + (floating.length > 3 ? ` and ${floating.length - 3} more` : '');
      setWarning(res, 'floating_input',
        `Input ${names} ${floating.length === 1 ? "isn't" : "aren't"} connected. A ${this.spec.family.name} input must be tied HIGH or LOW — an open input can read either way (here it keeps its last level).`);
    }
  }
}

function cloneState(s: unknown): unknown {
  if (s === null || typeof s !== 'object') return s;
  return Array.isArray(s) ? [...s] : { ...(s as Record<string, unknown>) };
}

// --- 555 timer ----------------------------------------------------------------

interface T555Persist { q: boolean; powered: boolean; rOut: number; prevThr: number; prevTrig: number; prevUpper: number; inited: boolean }

class Timer555Elem extends Elem implements DigitalParticipant {
  ps: T555Persist;
  pending: { q: boolean; powered: boolean } | null = null;
  /** Fraction of the step at which the comparator crossed (for event location). */
  crossAlpha = 1;
  flippedThisStep = false;
  limited = false;
  constructor(comp: PlacedComponent, sim: CircuitSimulator,
    public gnd: number, public trig: number, public out: number, public reset: number,
    public ctrl: number, public thr: number, public dis: number, public vcc: number) {
    super(comp, sim);
    const init = num(comp.state?.outputHigh, 0) === 1;
    this.ps = sim.persistFor<T555Persist>(comp, 'timer', () => ({
      q: init, powered: false, rOut: 10, prevThr: 0, prevTrig: 0, prevUpper: 0, inited: false,
    }));
  }
  beginTick(): void { this.limited = false; }
  stamp(s: Sys): void {
    // Internal 5k / 5k / 5k divider sets CTRL to 2/3 VCC (CTRL pin may override it).
    s.g(this.vcc, this.ctrl, 1 / 5000);
    s.g(this.ctrl, this.gnd, 1 / 10000);
    if (!this.ps.powered) return;
    s.g(this.out, this.ps.q ? this.vcc : this.gnd, 1 / this.ps.rOut);
    if (!this.ps.q) s.g(this.dis, this.gnd, 1 / 10);
  }
  iterate(c: Ctx): boolean {
    if (!this.ps.powered) return false;
    const dv = V(c.x, this.ps.q ? this.vcc : this.gnd) - V(c.x, this.out);
    const a = adaptR(this.ps.rOut, 10, 0.2, dv);
    this.ps.rOut = a.r;
    return a.changed;
  }
  private levels(x: Float64Array): { upper: number; thr: number; trig: number; resetLow: boolean; vs: number } {
    const vg = V(x, this.gnd);
    const upper = V(x, this.ctrl) - vg;
    const resetLow = this.sim.isAnchored(this.reset) ? V(x, this.reset) - vg < 0.7 : false;
    return { upper, thr: V(x, this.thr) - vg, trig: V(x, this.trig) - vg, resetLow, vs: V(x, this.vcc) - vg };
  }
  compute(mode: 'analog' | 'replay'): boolean {
    if (mode === 'replay') return false;
    const x = this.sim.ctxX;
    const L = this.levels(x);
    const powered = this.sim.isAnchored(this.vcc) && this.sim.isAnchored(this.gnd) && L.vs >= 3;
    let q = this.ps.q;
    if (powered) {
      const lower = L.upper / 2;
      if (L.resetLow) q = false;
      else if (L.trig < lower) q = true;          // trigger dominates
      else if (L.thr > L.upper) q = false;
    }
    if (q !== this.ps.q && powered && this.ps.powered && this.ps.inited) {
      // Where inside the step did the comparator cross? (linear interpolation)
      let alpha = 1;
      if (q) {
        const d0 = this.ps.prevTrig - this.ps.prevUpper / 2, d1 = L.trig - L.upper / 2;
        if (d0 > 0 && d1 < 0) alpha = d0 / (d0 - d1);
      } else if (!L.resetLow) {
        const d0 = this.ps.prevUpper - this.ps.prevThr, d1 = L.upper - L.thr;
        if (d0 > 0 && d1 < 0) alpha = d0 / (d0 - d1);
      }
      this.crossAlpha = Math.min(this.crossAlpha, alpha);
      this.flippedThisStep = true;
    }
    const changed = q !== this.ps.q || powered !== this.ps.powered;
    this.pending = { q, powered };
    return changed;
  }
  apply(): void {
    if (!this.pending) return;
    this.ps.q = this.pending.q;
    this.ps.powered = this.pending.powered;
    this.pending = null;
  }
  commit(c: Ctx): void {
    const L = this.levels(c.x);
    this.ps.prevThr = L.thr; this.ps.prevTrig = L.trig; this.ps.prevUpper = L.upper;
    this.ps.inited = this.ps.powered;
    if (this.ps.powered && this.ps.rOut > 10 * 1.05) this.limited = true;
  }
  edges(add: (a: number, b: number) => void): void {
    add(this.ctrl, this.vcc); add(this.out, this.vcc); add(this.dis, this.gnd);
  }
  condEstimate(g: Float64Array): void { g[this.out] += 0.1; g[this.dis] += 0.1; g[this.ctrl] += 1 / 3333; }
  save(): unknown { return { ...this.ps }; }
  restore(s: unknown): void { Object.assign(this.ps, s as T555Persist); }
  result(res: ComponentState, x: Float64Array): void {
    res.outputHigh = this.ps.powered && this.ps.q ? 1 : 0;
    res.voltage = V(x, this.out) - V(x, this.gnd);
    const anyConnected = [this.trig, this.thr, this.out, this.vcc, this.gnd].some((n) => this.sim.isAnchored(n));
    if (!this.ps.powered) {
      if (anyConnected) setWarning(res, 'unpowered', 'This 555 has no power — connect VCC (pin 8) to + and GND (pin 1) to −.');
    } else if (this.limited) {
      setWarning(res, 'overcurrent', 'The 555 output is overloaded — it can supply about 200 mA at most.');
    } else {
      const floating = [['TRIG', this.trig], ['THR', this.thr], ['RESET', this.reset]].filter(([, n]) => !this.sim.isAnchored(n as number)).map(([l]) => l);
      if (floating.length) {
        setWarning(res, 'floating_input',
          `${floating.join(' and ')} ${floating.length === 1 ? "isn't" : "aren't"} connected. Tie RESET (pin 4) to + and connect TRIG and THR to the timing capacitor.`);
      }
    }
  }
  probe(x: Float64Array): number { return V(x, this.out) - V(x, this.gnd); }
}

// --- LED matrix (logic-level display) ------------------------------------------

class LedMatrixElem extends Elem {
  onTime = new Float64Array(35);
  windowT = 0;
  hist: { lastLit: number[] };
  constructor(comp: PlacedComponent, sim: CircuitSimulator, public cols: number[], public rows: number[]) {
    super(comp, sim);
    this.hist = sim.persistFor(comp, 'matrix', () => ({ lastLit: new Array(35).fill(-1) }));
  }
  beginTick(): void { this.onTime.fill(0); this.windowT = 0; }
  /** Accumulate lit time from node voltages. */
  fromVoltages(x: Float64Array, h: number): void {
    for (let c = 0; c < 5; c++) {
      const vc = V(x, this.cols[c]);
      for (let r = 0; r < 7; r++) {
        if (vc - V(x, this.rows[r]) > 1.5) this.onTime[c * 7 + r] += h;
      }
    }
    this.windowT += h;
  }
  /** Accumulate lit time from replayed logic levels (falls back to voltages). */
  fromLevels(x: Float64Array, dur: number): void {
    const cl: (boolean | undefined)[] = this.cols.map((n) => this.sim.netLevel(n));
    const rl: (boolean | undefined)[] = this.rows.map((n) => this.sim.netLevel(n));
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 7; r++) {
        let lit: boolean;
        if (cl[c] !== undefined && rl[r] !== undefined) lit = cl[c]! && !rl[r];
        else {
          const vc = cl[c] === undefined ? V(x, this.cols[c]) : cl[c] ? 5 : 0;
          const vr = rl[r] === undefined ? V(x, this.rows[r]) : rl[r] ? 5 : 0;
          lit = vc - vr > 1.5;
        }
        if (lit) this.onTime[c * 7 + r] += dur;
      }
    }
    this.windowT += dur;
  }
  result(res: ComponentState): void {
    const now = this.sim.tickEndTime;
    const span = Math.max(this.windowT, 1e-9);
    for (let c = 0; c < 5; c++) {
      for (let r = 0; r < 7; r++) {
        const i = c * 7 + r;
        if (this.onTime[i] > 0.002 * span) this.hist.lastLit[i] = now;
        // Persistence of vision: something lit within the last 50 ms stays lit.
        const lit = this.hist.lastLit[i] >= 0 && now - this.hist.lastLit[i] <= Math.max(0, 0.05 - span) + 1e-9;
        res[`led_${c}_${r}`] = lit ? 1 : 0;
      }
    }
  }
}

// --- ATmega328P ---------------------------------------------------------------

interface AvrPersist { inputLevels: Record<string, boolean>; resetLow: boolean; rEff: Record<string, number>; hexSeen: string | null | undefined; firmwareError?: string }

class AvrElem extends Elem {
  bridge: AVRBridge | undefined;
  pins: { id: string; node: number; rail: number }[];
  ps: AvrPersist;
  held = true;
  powered = false;
  transStart = 0;
  cycleStart = 0;
  levels = new Map<string, boolean>();   // replay levels (port output bits)
  override = new Map<string, boolean>(); // PWM alt solve
  limited = false;
  constructor(comp: PlacedComponent, sim: CircuitSimulator, public vcc: number, public gnd: number, public avcc: number,
    public reset: number, public aref: number, nodeOf: (pin: string) => number) {
    super(comp, sim);
    this.bridge = sim.bridgeFor(comp);
    this.pins = AVR_GPIO_PINS.map((id) => ({ id, node: nodeOf(id), rail: id.startsWith('pc') ? avcc : vcc }));
    this.ps = sim.persistFor<AvrPersist>(comp, 'avr', () => ({ inputLevels: {}, resetLow: false, rEff: {}, hexSeen: undefined }));
  }
  get loaded(): boolean { return !!this.bridge?.isLoaded(); }
  beginTick(): void { this.limited = false; this.bridge?.beginTick(); }
  railNode(pinRail: number): number { return this.sim.isAnchored(pinRail) ? pinRail : this.vcc; }
  /** Called before running a chunk: power, reset, inputs from the previous solution. */
  prepareChunk(x: Float64Array): void {
    const b = this.bridge;
    const vg = V(x, this.gnd);
    const vs = V(x, this.vcc) - vg;
    this.powered = this.sim.isAnchored(this.vcc) && this.sim.isAnchored(this.gnd) && vs >= AVR_FAMILY.vmin;
    const vr = V(x, this.reset) - vg;
    if (vr < AVR_FAMILY.vil * vs) this.ps.resetLow = true;
    else if (vr > AVR_FAMILY.vih * vs) this.ps.resetLow = false;
    this.held = !this.loaded || !this.powered || this.ps.resetLow;
    if (!b) return;
    if (b.isLoaded()) b.holdReset(this.held);
    if (this.held) return;
    for (const p of this.pins) {
      const st = b.pinStates.get(p.id);
      if (st === 'input' || st === 'input_pullup') {
        const v = V(x, p.node) - vg;
        let lv = this.ps.inputLevels[p.id] ?? false;
        if (v > AVR_FAMILY.vih * vs) lv = true;
        else if (v < AVR_FAMILY.vil * vs) lv = false;
        this.ps.inputLevels[p.id] = lv;
        b.setInputLevel(p.id, lv);
      }
    }
    const avccV = this.sim.isAnchored(this.avcc) ? V(x, this.avcc) - vg : vs;
    for (let ch = 0; ch < 6; ch++) b.setAnalogInput(ch, V(x, this.pins[14 + ch].node) - vg, avccV > 0.1 ? avccV : vs);
    if (this.sim.isAnchored(this.aref)) b.setAref(V(x, this.aref) - vg);
  }
  runChunk(h: number): void {
    const b = this.bridge;
    if (!b) return;
    this.transStart = b.transitions.length;
    this.cycleStart = b.cycles;
    // Port output bits at chunk start (for replay)
    for (const p of this.pins) this.levels.set(p.id, b.portLevel(p.id));
    if (!this.held) {
      // Levels before the first transition of this chunk are what they were at its start.
      b.runFor(h);
      const seen = new Set<string>();
      for (let i = this.transStart; i < b.transitions.length; i++) {
        const tr = b.transitions[i];
        if (!seen.has(tr.pinId)) { seen.add(tr.pinId); this.levels.set(tr.pinId, !tr.high); }
      }
    }
  }
  /** Is this pin actively driven by the CPU (output mode)? */
  driving(pinId: string): boolean {
    if (this.held || !this.bridge) return false;
    const st = this.bridge.pinStates.get(pinId);
    return st === 'high' || st === 'low';
  }
  pinState(pinId: string): string | undefined {
    if (this.held || !this.bridge) return undefined;
    const ov = this.override.get(pinId);
    if (ov !== undefined) return ov ? 'high' : 'low';
    return this.bridge.pinStates.get(pinId);
  }
  stamp(s: Sys): void {
    // Internal pull-up on RESET (a floating RESET pin reads HIGH).
    s.g(this.reset, this.vcc, 1 / AVR_RESET_PULLUP);
    if (this.held || !this.bridge) return;
    for (const p of this.pins) {
      const st = this.pinState(p.id);
      if (st === 'high') s.g(p.node, this.railNode(p.rail), 1 / (this.ps.rEff[p.id] ?? AVR_FAMILY.r0));
      else if (st === 'low') s.g(p.node, this.gnd, 1 / (this.ps.rEff[p.id] ?? AVR_FAMILY.r0));
      else if (st === 'input_pullup') s.g(p.node, this.railNode(p.rail), 1 / AVR_PULLUP);
    }
  }
  iterate(c: Ctx): boolean {
    if (this.held || !this.bridge) return false;
    let nc = false;
    for (const p of this.pins) {
      const st = this.pinState(p.id);
      if (st !== 'high' && st !== 'low') continue;
      const dv = V(c.x, st === 'high' ? this.railNode(p.rail) : this.gnd) - V(c.x, p.node);
      const cur = this.ps.rEff[p.id] ?? AVR_FAMILY.r0;
      const a = adaptR(cur, AVR_FAMILY.r0, AVR_FAMILY.ilim, dv);
      if (a.changed) nc = true;
      this.ps.rEff[p.id] = a.r;
    }
    return nc;
  }
  commit(): void {
    if (this.held) return;
    for (const p of this.pins) {
      if ((this.ps.rEff[p.id] ?? AVR_FAMILY.r0) > AVR_FAMILY.r0 * 1.05 && (this.pinState(p.id) === 'high' || this.pinState(p.id) === 'low')) this.limited = true;
    }
  }
  edges(add: (a: number, b: number) => void): void {
    add(this.reset, this.vcc);
    if (!this.loaded) return;
    for (const p of this.pins) add(p.node, p.rail);
  }
  condEstimate(g: Float64Array): void { if (this.loaded) for (const p of this.pins) g[p.node] += 1 / AVR_FAMILY.r0; }
  result(res: ComponentState): void {
    const b = this.bridge;
    if (this.ps.firmwareError) res.firmwareError = this.ps.firmwareError;
    else delete res.firmwareError;
    if (!b?.isLoaded()) { res.programLoaded = 0; return; }
    res.programLoaded = 1;
    for (const p of this.pins) {
      const ps = this.held ? 'input' : b.pinStates.get(p.id);
      res[`pin_${p.id}`] = ps === 'high' ? 1 : ps === 'low' ? 0 : ps === 'input_pullup' ? 'pullup' : 'z';
    }
    res.serialOutput = b.serialOutput.join('');
    res.serialLength = b.serialTotal;
    res.running = this.held ? 0 : 1;
    if (!this.powered) {
      setWarning(res, 'unpowered', 'The ATmega has no power — connect VCC (pin 7) and AVCC (pin 20) to +, and GND (pins 8 and 22) to −.');
    } else if (this.limited) {
      const p = this.pins.find((q) => (this.ps.rEff[q.id] ?? AVR_FAMILY.r0) > AVR_FAMILY.r0 * 1.05);
      const label = getDef('atmega328')?.pins.find((q) => q.id === p?.id)?.label ?? 'a pin';
      setWarning(res, 'overcurrent', `Pin ${label} is overloaded — an ATmega pin can supply about 40 mA at most (20 mA recommended). Add a resistor.`);
    }
  }
}

function setWarning(res: ComponentState, code: WarningCode, message: string): void {
  if (res.warning) return; // first (most important) warning wins
  const w: ComponentWarning = { code, message };
  res.warning = w;
}

// ---------------------------------------------------------------------------
// Netlist
// ---------------------------------------------------------------------------

interface Netlist {
  N: number;
  pinNode: Map<string, number>;
  nodeOf: (compId: string, pinId: string) => number;
  rootNode: (key: string) => number | undefined;
  groupNode: Map<string, number>;
  hasGround: boolean;
}

/** Built-in types with a simulation model. */
const MODEL_TYPES = new Set([
  'resistor', 'capacitor', 'led', 'switch', 'timer', 'power', 'potentiometer', 'display7seg', 'cd4026',
  'multimeter', 'gate_and', 'gate_or', 'gate_nand', 'gate_not', 'gate_nor', 'gate_xor', 'opamp', 'atmega328',
  'ledmatrix', 'funcgen', 'shift_register', 'flipflop_d', 'vreg',
]);

/** Which simulation model a component uses (built-in type, or a custom chip's `behavior`). */
export function resolveModelType(type: string): string | undefined {
  if (MODEL_TYPES.has(type)) return type;
  const def = getDef(type);
  const b = def?.behavior;
  if (!b) return undefined;
  if (Object.prototype.hasOwnProperty.call(BEHAVIOR_MODELS, b)) return BEHAVIOR_MODELS[b];
  if (MODEL_TYPES.has(b)) return b;
  return undefined;
}

// ---------------------------------------------------------------------------
// The simulator
// ---------------------------------------------------------------------------

export type ScopeSample = { time: number; voltage: number };

export class CircuitSimulator {
  /** Persistent per-component model state (capacitor history, chip state...). */
  private persist = new Map<string, unknown>();
  private avrBridges = new Map<string, AVRBridge>();
  /** Explicitly loaded programs adopt the component's current `hex` property. */
  private explicitLoads = new Set<string>();
  private lastPinV = new Map<string, number>();

  /** Extra quality multiplier: steps are made this many times smaller (Accuracy setting). */
  subSteps = 1;

  /**
   * Wire current direction info: voltage difference from→to.
   * Positive = current flows from→to, negative = current flows to→from.
   */
  wireCurrents = new Map<string, number>(); // wireId -> voltage diff (from - to)

  /**
   * Pin hole voltages: "col,row" -> voltage at that breadboard hole.
   * Updated each tick for strip highlighting.
   */
  pinHoleVoltages = new Map<string, number>();

  /** Component ids the oscilloscope is probing (set by the UI). */
  scopeProbeIds: Set<string> = new Set();
  /** Samples taken during the last tick, per probed component (sim time in ms). */
  scopeSamples = new Map<string, ScopeSample[]>();
  /** Minimum spacing of scope samples (s). */
  scopeInterval = 0.002;

  /** Number of steps the last tick used (diagnostics). */
  lastStepCount = 0;

  // --- per-tick working state (used by the models) ---
  ctxX: Float64Array = new Float64Array(0);
  ctxXPrev: Float64Array = new Float64Array(0);
  tickEndTime = 0;
  pwmFrac: number | null = null;
  private anchoredSet: Uint8Array = new Uint8Array(1);
  private nodeDrivers: { avr?: AvrElem; pin?: string; chip?: LogicChipElem; k?: number }[][] = [];
  private maxSrcV = 5;

  // Keep the old field name working for code that inspected it.
  private get state() { return { avrBridges: this.avrBridges }; }

  reset(): void {
    this.persist.clear();
    this.lastPinV.clear();
    this.scopeSamples.clear();
    for (const bridge of this.avrBridges.values()) bridge.reset();
  }

  /** Load a hex program into a specific ATmega328 component. Throws on an invalid HEX file. */
  loadAVRProgram(componentId: string, hexString: string): void {
    let bridge = this.avrBridges.get(componentId);
    if (!bridge) {
      bridge = new AVRBridge();
      bridge.load(hexString);
      this.avrBridges.set(componentId, bridge);
    } else {
      bridge.load(hexString);
    }
    this.explicitLoads.add(componentId);
  }

  /** Check if an ATmega328 has a loaded program. */
  isAVRLoaded(componentId: string): boolean {
    return this.avrBridges.get(componentId)?.isLoaded() ?? false;
  }

  /** Send text to an ATmega's serial input (Serial.read() in the sketch). */
  sendSerial(componentId: string, text: string): void {
    this.avrBridges.get(componentId)?.sendSerial(text);
  }

  /** @internal persistent state per component and model kind */
  persistFor<T>(comp: PlacedComponent, kind: string, init: () => T): T {
    const key = `${comp.id}\u0000${kind}`;
    let v = this.persist.get(key) as T | undefined;
    if (v === undefined) { v = init(); this.persist.set(key, v); }
    return v;
  }

  /** @internal the AVR bridge of an ATmega, loading `properties.hex` when it changed. */
  bridgeFor(comp: PlacedComponent): AVRBridge | undefined {
    const ps = this.persistFor<AvrPersist>(comp, 'avr', () => ({ inputLevels: {}, resetLow: false, rEff: {}, hexSeen: undefined }));
    const hex = typeof comp.properties.hex === 'string' && comp.properties.hex.trim() !== '' ? comp.properties.hex : null;
    let bridge = this.avrBridges.get(comp.id);
    if (this.explicitLoads.has(comp.id)) {
      // A program loaded through loadAVRProgram wins over the stored property until it changes.
      this.explicitLoads.delete(comp.id);
      ps.hexSeen = hex;
      ps.firmwareError = undefined;
    } else if (hex !== null && hex !== ps.hexSeen) {
      ps.hexSeen = hex;
      try {
        const b = bridge ?? new AVRBridge();
        b.load(hex);
        bridge = b;
        this.avrBridges.set(comp.id, b);
        ps.firmwareError = undefined;
      } catch (e) {
        ps.firmwareError = e instanceof Error ? e.message : String(e);
      }
    }
    if (bridge) bridge.setClock(num(comp.properties.clockSpeed, 16e6));
    return bridge;
  }

  /** @internal */
  isAnchored(node: number): boolean { return node === 0 || this.anchoredSet[node] === 1; }
  /** @internal highest source voltage in the circuit (for resistor suggestions). */
  maxSourceVoltage(): number { return this.maxSrcV; }

  /** @internal logic level of a net during MCU replay, or undefined when not purely digital. */
  netLevel(node: number): boolean | undefined {
    const ds = this.nodeDrivers[node];
    if (!ds || ds.length === 0) return undefined;
    let lvl: boolean | undefined;
    for (const d of ds) {
      let v: boolean | undefined;
      if (d.avr) {
        if (!d.avr.driving(d.pin!)) continue;
        v = d.avr.levels.get(d.pin!);
      } else if (d.chip) {
        if (!d.chip.ps.powered) continue;
        const o = d.chip.ps.out[d.k!];
        if (o === null) continue;
        v = o;
      }
      if (v === undefined) continue;
      if (lvl === undefined) lvl = v;
      else if (lvl !== v) return undefined; // two drivers disagree
    }
    return lvl;
  }

  // -------------------------------------------------------------------------

  private buildNetlist(components: PlacedComponent[], wires: Wire[]): Netlist {
    const pinKey = (compId: string, pinId: string) => `${compId}:${pinId}`;
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let p = parent.get(k);
      if (p === undefined) { parent.set(k, k); return k; }
      let r = k;
      while (p !== r) { r = p!; p = parent.get(r); }
      // path compression
      let c = k;
      while (c !== r) { const nx = parent.get(c)!; parent.set(c, r); c = nx; }
      return r;
    };
    const union = (a: string, b: string) => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    const defs = new Map<string, ComponentDefinition>();
    for (const comp of components) {
      const def = getDef(comp.type);
      if (!def) continue;
      defs.set(comp.id, def);
      for (const pin of def.pins) find(pinKey(comp.id, pin.id));
    }
    for (const wire of wires) {
      if (!wire?.from || !wire?.to) continue;
      union(pinKey(wire.from.componentId, wire.from.pinId), pinKey(wire.to.componentId, wire.to.pinId));
    }
    for (const comp of components) {
      const model = resolveModelType(comp.type);
      if (comp.type === 'switch' && comp.state?.closed) union(pinKey(comp.id, 'a'), pinKey(comp.id, 'b'));
      if (model === 'display7seg') union(pinKey(comp.id, 'gnd'), pinKey(comp.id, 'vcc')); // both COM pins
      if (model === 'atmega328') union(pinKey(comp.id, 'gnd'), pinKey(comp.id, 'agnd'));   // GND pins bonded together
    }

    // Breadboard: component pins on holes, and wired holes, join their strip.
    const groupFirst = new Map<string, string>();
    const join = (groupId: string, key: string) => {
      const f = groupFirst.get(groupId);
      if (f === undefined) groupFirst.set(groupId, key);
      else union(f, key);
    };
    for (const comp of components) {
      if (comp.type === 'power' || comp.type === 'funcgen') continue; // bench instruments are off-board
      const def = defs.get(comp.id);
      if (!def) continue;
      for (const pin of def.pins) {
        const pos = getComponentPinPixel(comp, def, pin.id);
        if (!pos) continue;
        const grid = pixelToBoardGrid(pos.x, pos.y);
        const groupId = boardPinLookup.get(`${grid.col},${grid.row}`);
        if (groupId) join(groupId, pinKey(comp.id, pin.id));
      }
    }
    for (const wire of wires) {
      if (!wire?.from || !wire?.to) continue;
      for (const ep of [wire.from, wire.to]) {
        if (ep.componentId !== 'board') continue;
        const groupId = boardPinLookup.get(ep.pinId.replace(/\s/g, ''));
        if (groupId) join(groupId, pinKey('board', ep.pinId));
      }
    }

    // Ground: a Power Supply's −, else a function generator's GND, else any ground pin.
    let groundRoot: string | null = null;
    for (const comp of components) if (comp.type === 'power' && defs.has(comp.id)) { groundRoot = find(pinKey(comp.id, 'neg')); break; }
    if (!groundRoot) for (const comp of components) if (comp.type === 'funcgen' && defs.has(comp.id)) { groundRoot = find(pinKey(comp.id, 'gnd')); break; }
    if (!groundRoot) {
      outer: for (const comp of components) {
        const def = defs.get(comp.id);
        if (!def) continue;
        for (const pin of def.pins) if (pin.type === 'ground') { groundRoot = find(pinKey(comp.id, pin.id)); break outer; }
      }
    }

    const rootToNode = new Map<string, number>();
    if (groundRoot) rootToNode.set(groundRoot, 0);
    let next = 1;
    const pinNode = new Map<string, number>();
    for (const comp of components) {
      const def = defs.get(comp.id);
      if (!def) continue;
      for (const pin of def.pins) {
        const k = pinKey(comp.id, pin.id);
        const r = find(k);
        let n = rootToNode.get(r);
        if (n === undefined) { n = next++; rootToNode.set(r, n); }
        pinNode.set(k, n);
      }
    }
    const groupNode = new Map<string, number>();
    for (const [gid, key] of groupFirst) {
      const n = rootToNode.get(find(key));
      if (n !== undefined) groupNode.set(gid, n);
    }
    return {
      N: next - 1,
      pinNode,
      nodeOf: (c, p) => pinNode.get(pinKey(c, p)) ?? -1,
      rootNode: (key) => rootToNode.get(find(key)),
      groupNode,
      hasGround: groundRoot !== null,
    };
  }

  private buildModels(components: PlacedComponent[], net: Netlist): Elem[] {
    const elems: Elem[] = [];
    let floatNode = net.N; // pins that don't exist get their own private node
    const extra: number[] = [];
    for (const comp of components) {
      const model = resolveModelType(comp.type);
      if (!model) continue;
      const nodeOf = (pin: string): number => {
        const n = net.nodeOf(comp.id, pin);
        if (n >= 0) return n;
        floatNode++; extra.push(floatNode);
        return floatNode;
      };
      switch (model) {
        case 'resistor': elems.push(new ResistorElem(comp, this, nodeOf('a'), nodeOf('b'))); break;
        case 'potentiometer': elems.push(new PotElem(comp, this, nodeOf('pin1'), nodeOf('wiper'), nodeOf('pin2'))); break;
        case 'multimeter': elems.push(new MeterElem(comp, this, nodeOf('pos'), nodeOf('neg'))); break;
        case 'capacitor': elems.push(new CapElem(comp, this, nodeOf('pos'), nodeOf('neg'))); break;
        case 'power': elems.push(new SupplyElem(comp, this, nodeOf('pos'), nodeOf('neg'))); break;
        case 'funcgen': elems.push(new FuncGenElem(comp, this, nodeOf('out'), nodeOf('gnd'))); break;
        case 'led': elems.push(new LedElem(comp, this, nodeOf('anode'), nodeOf('cathode'))); break;
        case 'display7seg': elems.push(new SevenSegElem(comp, this, SEGMENTS.map((s) => nodeOf(s)), nodeOf('gnd'))); break;
        case 'vreg': elems.push(new VregElem(comp, this, nodeOf('vin'), nodeOf('vout'), nodeOf('gnd'))); break;
        case 'opamp': elems.push(new OpampElem(comp, this, nodeOf('in_pos'), nodeOf('in_neg'), nodeOf('out'), nodeOf('v_pos'), nodeOf('v_neg'))); break;
        case 'timer':
          elems.push(new Timer555Elem(comp, this, nodeOf('gnd'), nodeOf('trig'), nodeOf('out'), nodeOf('reset'),
            nodeOf('ctrl'), nodeOf('thr'), nodeOf('dis'), nodeOf('vcc')));
          break;
        case 'ledmatrix':
          elems.push(new LedMatrixElem(comp, this, [1, 2, 3, 4, 5].map((i) => nodeOf(`c${i}`)), [1, 2, 3, 4, 5, 6, 7].map((i) => nodeOf(`r${i}`))));
          break;
        case 'atmega328':
          elems.push(new AvrElem(comp, this, nodeOf('vcc'), nodeOf('gnd'), nodeOf('avcc'), nodeOf('pc6'), nodeOf('aref'), nodeOf));
          break;
        case 'switch': break; // handled by the netlist (closed = joined)
        default: {
          const spec = LOGIC_SPECS[model];
          if (spec) elems.push(new LogicChipElem(comp, this, spec, nodeOf('vcc'), nodeOf('gnd'), nodeOf));
        }
      }
    }
    (net as { N: number }).N = floatNode;
    return elems;
  }

  /** Floating-node analysis: nodes DC-connected to ground or to a source. */
  private computeAnchored(N: number, elems: Elem[]): void {
    const parent = new Int32Array(N + 1);
    for (let i = 0; i <= N; i++) parent[i] = i;
    const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const add = (a: number, b: number) => { if (a < 0 || b < 0) return; const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (const e of elems) e.edges(add);
    const anchoredRoot = new Uint8Array(N + 1);
    anchoredRoot[find(0)] = 1;
    for (const e of elems) {
      if (e.isSource()) {
        const s = e as SourceElem;
        anchoredRoot[find(s.p)] = 1;
        anchoredRoot[find(s.q)] = 1;
      }
    }
    const res = new Uint8Array(N + 1);
    for (let i = 0; i <= N; i++) res[i] = anchoredRoot[find(i)];
    this.anchoredSet = res;
  }

  /**
   * Advance the circuit by `dt` seconds of simulated time.
   * @param components - all placed components
   * @param wires - all wires
   * @param time - simulation time in ms at the END of this advance
   * @param dt - how much simulated time to advance (s)
   * @returns map of componentId -> new state record
   */
  tick(
    components: PlacedComponent[],
    wires: Wire[],
    time: number,
    dt: number,
  ): Map<string, ComponentState> {
    const results = new Map<string, ComponentState>();
    for (const comp of components) {
      const st: ComponentState = { ...(comp.state ?? {}) };
      delete st.warning;
      results.set(comp.id, st);
    }
    this.scopeSamples = new Map();
    if (!(dt > 0) || !Number.isFinite(dt)) return results;
    dt = Math.min(dt, 1); // never more than 1 s of sim time in one call

    const net = this.buildNetlist(components, wires);
    const elems = this.buildModels(components, net);
    const N = net.N;
    this.computeAnchored(N, elems);
    let maxV = 0;
    for (const e of elems) {
      if (e instanceof SupplyElem) maxV = Math.max(maxV, Math.abs(e.v));
      else if (e instanceof FuncGenElem) maxV = Math.max(maxV, Math.abs(e.amp) + Math.abs(e.dc));
    }
    this.maxSrcV = maxV > 0 ? maxV : 5;

    const avrs = elems.filter((e): e is AvrElem => e instanceof AvrElem);
    const chips = elems.filter((e): e is LogicChipElem => e instanceof LogicChipElem);
    const timers = elems.filter((e): e is Timer555Elem => e instanceof Timer555Elem);
    const matrices = elems.filter((e): e is LedMatrixElem => e instanceof LedMatrixElem);
    const leds = elems.filter((e) => e instanceof LedElem || e instanceof SevenSegElem);
    const caps = elems.filter((e): e is CapElem => e instanceof CapElem);
    const digital: DigitalParticipant[] = [...chips, ...timers];
    const iterElems = elems.filter((e) => e.iterate !== Elem.prototype.iterate);
    const runningAvrs = avrs.filter((a) => a.loaded);

    // Drivers per node, for MCU edge replay
    this.nodeDrivers = [];
    if (runningAvrs.length) {
      const drv: { avr?: AvrElem; pin?: string; chip?: LogicChipElem; k?: number }[][] = new Array(N + 1);
      for (const a of runningAvrs) for (const p of a.pins) (drv[p.node] ??= []).push({ avr: a, pin: p.id });
      for (const c of chips) c.outNodes.forEach((n, k) => (drv[n] ??= []).push({ chip: c, k }));
      this.nodeDrivers = drv;
    }

    // --- choose the step ---
    const acc = Math.max(1, Math.round(num(this.subSteps, 1)));
    let h = H_MAX;
    for (const e of elems) h = Math.min(h, e.maxStep());
    if (runningAvrs.length) h = Math.min(h, H_MCU);
    if (caps.length) {
      const g = new Float64Array(N + 1);
      for (const e of elems) e.condEstimate(g);
      g[0] = Infinity;
      const timingNodes = new Set<number>();
      for (const tm of timers) { timingNodes.add(tm.thr); timingNodes.add(tm.trig); }
      for (const c of caps) {
        if (c.C <= 0) continue;
        const ra = g[c.p] > 0 ? 1 / g[c.p] : Infinity;
        const rb = g[c.q] > 0 ? 1 / g[c.q] : Infinity;
        const tau = c.C * (ra + rb);
        if (!Number.isFinite(tau) || !(tau > 0)) continue;
        // Very fast RCs (decoupling caps, the 555 CTRL cap) settle within a step
        // and BDF2 handles them without ringing, so they don't force tiny steps —
        // unless they set a 555's timing.
        if (tau / 50 < H_MIN && !timingNodes.has(c.p) && !timingNodes.has(c.q)) continue;
        h = Math.min(h, tau / 50);
      }
    }
    h = Math.max(h, H_MIN) / acc;
    let nSteps = Math.ceil(dt / h - 1e-9);
    nSteps = Math.min(MAX_STEPS_PER_TICK, Math.max(1, nSteps));
    h = dt / nSteps;

    // --- initial solution (warm start from the last tick, by pin) ---
    const x = new Float64Array(N);
    for (const [k, n] of net.pinNode) {
      if (n > 0) { const v = this.lastPinV.get(k); if (v !== undefined) x[n - 1] = v; }
    }
    const sys = new Sys(N);
    const xPrev = new Float64Array(x);
    this.ctxX = x;
    this.ctxXPrev = xPrev;
    const ctx: Ctx = { t: 0, h, x, xPrev };
    for (const e of elems) e.beginTick();

    const tStart = time / 1000 - dt;
    this.tickEndTime = time / 1000;
    let t = tStart;
    const tEnd = time / 1000;
    let steps = 0;
    const probes: { id: string; e: Elem; last: number }[] = [];
    for (const e of elems) if (this.scopeProbeIds.has(e.comp.id)) { probes.push({ id: e.comp.id, e, last: -Infinity }); this.scopeSamples.set(e.comp.id, []); }

    const solveOnce = () => {
      sys.clear();
      const A = sys.A, n = sys.n;
      for (let i = 0; i < n; i++) A[i * n + i] += GMIN;
      for (const e of elems) e.stamp(sys, ctx);
      solveDenseInPlace(A, sys.b, n);
      for (let i = 0; i < n; i++) {
        const v = sys.b[i];
        x[i] = Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : 0;
      }
    };
    const newton = () => {
      for (let it = 0; it < MAX_NEWTON; it++) {
        solveOnce();
        let nc = false;
        for (const e of iterElems) if (e.iterate(ctx)) nc = true;
        if (!nc) return;
      }
    };
    const settleDigital = (mode: 'analog' | 'replay'): boolean => {
      let any = false;
      for (let r = 0; r < MAX_DIGITAL_ROUNDS; r++) {
        let changed = false;
        for (const d of digital) if (d.compute(mode)) changed = true;
        for (const d of digital) d.apply();
        if (!changed) break;
        any = true;
      }
      return any;
    };
    const solveStep = () => {
      for (let round = 0; round < MAX_DIGITAL_ROUNDS; round++) {
        newton();
        if (digital.length === 0) return;
        let changed = false;
        for (const d of digital) if (d.compute('analog')) changed = true;
        for (const d of digital) d.apply();
        if (!changed) return;
      }
    };

    const canRollback = runningAvrs.length === 0 && timers.length > 0;
    let retries = 0;
    while (t < tEnd - 1e-12 && steps < MAX_STEPS_PER_TICK * 2) {
      let hs = Math.min(h, tEnd - t);
      if (tEnd - t - hs < h * 1e-6) hs = tEnd - t;
      ctx.h = hs;
      ctx.t = t + hs;
      xPrev.set(x);
      this.pwmFrac = null;

      // --- MCUs: run the chunk, then replay its edges through the logic ---
      if (runningAvrs.length) {
        for (const a of avrs) a.prepareChunk(xPrev);
        for (const a of avrs) a.runChunk(hs);
        this.replayChunk(runningAvrs, hs, chips.length > 0, matrices, settleDigital, leds.length > 0);
      }

      let snapshot: unknown[] | null = null;
      if (canRollback) {
        snapshot = elems.map((e) => e.save());
        for (const tm of timers) { tm.crossAlpha = 1; tm.flippedThisStep = false; }
      }

      solveStep();

      if (canRollback && snapshot) {
        let alpha = 1;
        for (const tm of timers) if (tm.flippedThisStep) alpha = Math.min(alpha, tm.crossAlpha);
        if (alpha < 0.98 && hs * alpha > 1e-6 && retries < 4) {
          // The 555 switched part-way through the step: redo the step up to the crossing.
          elems.forEach((e, i) => e.restore(snapshot![i]));
          x.set(xPrev);
          h = hs; // keep the nominal step for later
          const hNew = Math.max(hs * alpha * 1.0005, 1e-7);
          retries++;
          // Re-run with the shorter step (loop iteration without advancing t)
          ctx.h = hNew; ctx.t = t + hNew;
          for (const tm of timers) { tm.crossAlpha = 1; tm.flippedThisStep = false; }
          solveStep();
          hs = hNew;
        }
      }
      retries = 0;

      // PWM: LEDs see the time-average of the pin's two levels
      if (this.pendingPwm && leds.length) this.pwmAltSolve(leds, newton, x);

      for (const e of elems) e.commit(ctx);
      if (matrices.length && !runningAvrs.length) for (const m of matrices) m.fromVoltages(x, hs);
      for (const p of probes) {
        if (ctx.t - p.last >= this.scopeInterval - 1e-12 || ctx.t >= tEnd - 1e-12) {
          const v = p.e.probe(x);
          if (v !== undefined && Number.isFinite(v)) {
            this.scopeSamples.get(p.id)!.push({ time: ctx.t * 1000, voltage: v });
            p.last = ctx.t;
          }
        }
      }
      t += hs;
      steps++;
    }
    this.lastStepCount = steps;

    // --- results ---
    for (const e of elems) {
      const res = results.get(e.comp.id);
      if (res) e.result(res, x);
    }
    for (const comp of components) {
      if (comp.type === 'switch') {
        const res = results.get(comp.id)!;
        res.closed = comp.state?.closed ?? 0;
      }
    }

    // Remember node voltages per pin for the next tick's warm start
    this.lastPinV.clear();
    for (const [k, n] of net.pinNode) this.lastPinV.set(k, V(x, n));

    // Wire voltage differences
    this.wireCurrents.clear();
    const nodeV = (ep: { componentId: string; pinId: string }): number => {
      if (ep.componentId === 'board') {
        const n = net.rootNode(`board:${ep.pinId}`);
        return n !== undefined ? V(x, n) : 0;
      }
      const n = net.nodeOf(ep.componentId, ep.pinId);
      return n >= 0 ? V(x, n) : 0;
    };
    for (const wire of wires) {
      if (!wire?.from || !wire?.to) continue;
      this.wireCurrents.set(wire.id, nodeV(wire.from) - nodeV(wire.to));
    }

    // Breadboard strip voltages
    this.pinHoleVoltages.clear();
    for (const [gid, n] of net.groupNode) {
      const v = V(x, n);
      if (Math.abs(v) <= 0.01) continue;
      const group = boardGroupById.get(gid);
      if (!group) continue;
      for (const pin of group.pins) this.pinHoleVoltages.set(`${pin.col},${pin.row}`, v);
    }

    return results;
  }

  // --- MCU replay -------------------------------------------------------------

  private pendingPwm: { avr: AvrElem; pin: string; endLevel: boolean; frac: number }[] | null = null;

  /**
   * Replay every pin edge the MCUs produced in this chunk, in time order,
   * through the digital chips (zero-delay settle after each instant), and
   * accumulate LED-matrix lit time. Also measures PWM duty for LEDs.
   */
  private replayChunk(avrs: AvrElem[], h: number, hasChips: boolean, matrices: LedMatrixElem[],
    settle: (mode: 'analog' | 'replay') => boolean, hasLeds: boolean): void {
    type Ev = { t: number; avr: AvrElem; pin: string; high: boolean };
    const events: Ev[] = [];
    for (const a of avrs) {
      const b = a.bridge!;
      const f = b.clockHz;
      for (let i = a.transStart; i < b.transitions.length; i++) {
        const tr = b.transitions[i];
        events.push({ t: (tr.cycle - a.cycleStart) / f, avr: a, pin: tr.pinId, high: tr.high });
      }
    }
    this.pendingPwm = null;
    if (events.length === 0) {
      if (matrices.length) for (const m of matrices) m.fromLevels(this.ctxXPrev, h);
      return;
    }
    if (avrs.length > 1) events.sort((p, q) => p.t - q.t);

    // PWM duty per toggling output pin (time spent at its final level)
    if (hasLeds) {
      const timeAtEnd = new Map<string, { avr: AvrElem; pin: string; last: number; level: boolean; tEnd: number }>();
      for (const ev of events) {
        if (!ev.avr.driving(ev.pin)) continue;
        const key = `${ev.avr.comp.id}:${ev.pin}`;
        let s = timeAtEnd.get(key);
        if (!s) { s = { avr: ev.avr, pin: ev.pin, last: 0, level: !ev.high, tEnd: 0 }; timeAtEnd.set(key, s); }
        s.level = ev.high; s.last = ev.t;
        s.tEnd = 0; // recomputed below
      }
      const out: { avr: AvrElem; pin: string; endLevel: boolean; frac: number }[] = [];
      for (const s of timeAtEnd.values()) {
        const endLevel = s.avr.bridge!.pinStates.get(s.pin) === 'high';
        // Time at the final level = sum of intervals where the pin equals endLevel
        let lvl = s.avr.levels.get(s.pin) ?? !endLevel;
        let tPrev = 0, atEnd = 0;
        for (const ev of events) {
          if (ev.avr !== s.avr || ev.pin !== s.pin) continue;
          if (lvl === endLevel) atEnd += ev.t - tPrev;
          lvl = ev.high; tPrev = ev.t;
        }
        if (lvl === endLevel) atEnd += h - tPrev;
        const frac = Math.max(0, Math.min(1, atEnd / h));
        if (frac < 0.999) out.push({ avr: s.avr, pin: s.pin, endLevel, frac });
      }
      if (out.length) this.pendingPwm = out;
    }

    if (!hasChips && matrices.length === 0) {
      for (const ev of events) ev.avr.levels.set(ev.pin, ev.high);
      return;
    }
    let tPrev = 0;
    let i = 0;
    while (i < events.length) {
      const tEv = events[i].t;
      if (tEv > tPrev && matrices.length) for (const m of matrices) m.fromLevels(this.ctxXPrev, tEv - tPrev);
      while (i < events.length && events[i].t === tEv) {
        events[i].avr.levels.set(events[i].pin, events[i].high);
        i++;
      }
      if (hasChips) settle('replay');
      tPrev = Math.max(tPrev, tEv);
    }
    if (matrices.length && h > tPrev) for (const m of matrices) m.fromLevels(this.ctxXPrev, h - tPrev);
  }

  /** Second solve with toggling PWM pins at their other level, for LED averaging. */
  private pwmAltSolve(leds: Elem[], newton: () => void, x: Float64Array): void {
    const pwm = this.pendingPwm!;
    const saved = new Float64Array(x);
    const lin = leds.map((e) => e.save());
    for (const p of pwm) p.avr.override.set(p.pin, !p.endLevel);
    newton();
    const juncs: LedJunction[] = [];
    for (const e of leds) {
      if (e instanceof LedElem) juncs.push(e.j);
      else if (e instanceof SevenSegElem) juncs.push(...e.segs);
    }
    for (const j of juncs) j.altI = j.current(x);
    for (const p of pwm) p.avr.override.delete(p.pin);
    leds.forEach((e, i) => e.restore(lin[i]));
    x.set(saved);
    this.pwmFrac = pwm.reduce((s, p) => s + p.frac, 0) / pwm.length;
  }
}
