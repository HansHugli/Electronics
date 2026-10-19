import { useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { PlacedComponent, Wire, ComponentState } from '../types';
import type { CircuitSimulator } from '../engine/CircuitSimulator';

/**
 * Wall-clock pacing for the simulator.
 *
 * Each animation frame the clock measures the wall time since the previous
 * frame, multiplies it by the speed setting and advances the circuit by that
 * much simulated time, so a circuit runs at the same pace on any PC. When
 * the engine can't keep up, one frame never advances more than `maxStepSim`
 * (0.25 s of sim time): the simulation then runs slower than requested
 * instead of freezing the UI ("spiral of death"), and `lagging` is reported.
 */
export class SimClock {
  /** Simulated time since start (ms). */
  simTime = 0;
  /** Measured simulated seconds per wall second (smoothed over ~1 s). */
  effectiveSpeed = 0;
  /** True while the engine can't keep up with the requested speed. */
  lagging = false;

  private lastWall: number | null = null;
  private lastCapAt = -Infinity;
  private warm = 0; // wall seconds of measurement so far

  constructor(
    /** Largest sim-time advance per frame (s). */
    public maxStepSim = 0.25,
    /** A wall gap longer than this (s) is a pause (hidden window), not lag. */
    public pauseGap = 1.0,
  ) {}

  start(nowMs: number): void {
    this.simTime = 0;
    this.lastWall = nowMs;
    this.effectiveSpeed = 0;
    this.lagging = false;
    this.lastCapAt = -Infinity;
    this.warm = 0;
  }

  stop(): void { this.lastWall = null; }

  get running(): boolean { return this.lastWall !== null; }

  /**
   * How much simulated time (s) to advance for a frame at wall time `nowMs`.
   * Advances `simTime` by that amount.
   */
  advance(nowMs: number, speed: number): { dtSim: number; capped: boolean } {
    if (this.lastWall === null) this.lastWall = nowMs;
    const elapsed = Math.max(0, (nowMs - this.lastWall) / 1000);
    this.lastWall = nowMs;
    if (elapsed > this.pauseGap) {
      // The window was hidden or the machine slept: resume without a burst.
      return { dtSim: 0, capped: false };
    }
    const want = elapsed * Math.max(0, speed);
    const capped = want > this.maxStepSim;
    const dtSim = Math.min(want, this.maxStepSim);
    this.simTime += dtSim * 1000;

    if (elapsed > 0) {
      const inst = dtSim / elapsed;
      const a = Math.min(1, elapsed / 1.0); // ~1 s smoothing
      this.effectiveSpeed = this.warm === 0 ? inst : this.effectiveSpeed + a * (inst - this.effectiveSpeed);
      this.warm += elapsed;
    }
    const nowS = nowMs / 1000;
    if (capped) this.lastCapAt = nowS;
    const recentlyCapped = nowS - this.lastCapAt < 0.5;
    this.lagging = speed > 0 && (recentlyCapped || (this.warm > 1 && this.effectiveSpeed < 0.85 * speed));
    return { dtSim, capped };
  }
}

export interface SimulationLoopOptions {
  running: boolean;
  /** Speed multiplier (1 = real time). */
  speed: number;
  /** Extra quality multiplier (the Accuracy setting): steps are made this many times smaller. */
  accuracy: number;
  simulator: CircuitSimulator;
  /** Latest components (the loop reads it each frame). */
  componentsRef: MutableRefObject<PlacedComponent[]>;
  wiresRef: MutableRefObject<Wire[]>;
  setComponents: Dispatch<SetStateAction<PlacedComponent[]>>;
  /** Called after each advance with the updated components and the sim time (ms). */
  onAdvance?: (components: PlacedComponent[], simTimeMs: number) => void;
  /** Clock and frame scheduler (injectable for tests). */
  now?: () => number;
  requestFrame?: (cb: () => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
}

export interface SimulationLoopState {
  /** Simulated time since the simulation started (ms). */
  simTime: number;
  /** True while the engine can't keep up with the requested speed. */
  lagging: boolean;
  /** Measured simulated seconds per wall second. */
  effectiveSpeed: number;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
function defaultRequest(cb: () => void): unknown {
  if (typeof requestAnimationFrame === 'function') return { raf: requestAnimationFrame(() => cb()) };
  return { to: setTimeout(cb, 16) };
}
function defaultCancel(h: unknown): void {
  const handle = h as { raf?: number; to?: ReturnType<typeof setTimeout> } | null;
  if (!handle) return;
  if (handle.raf !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle.raf);
  if (handle.to !== undefined) clearTimeout(handle.to);
}

/** Merge engine results into components (keeps a switch's user-set `closed`). */
export function applyStates(comps: PlacedComponent[], states: Map<string, ComponentState>): PlacedComponent[] {
  return comps.map((c) => {
    const s = states.get(c.id);
    if (!s) return c;
    if (c.type === 'switch' && c.state && 'closed' in c.state) return { ...c, state: { ...s, closed: c.state.closed } };
    return { ...c, state: s };
  });
}

/**
 * One frame of the loop, separated from React so it can be tested with a
 * fake clock. Returns the new components (or null when nothing advanced).
 */
export function runSimulationFrame(
  clock: SimClock,
  nowMs: number,
  opts: Pick<SimulationLoopOptions, 'speed' | 'accuracy' | 'simulator'>,
  components: PlacedComponent[],
  wires: Wire[],
): { components: PlacedComponent[]; states: Map<string, ComponentState> } | null {
  const { dtSim } = clock.advance(nowMs, opts.speed);
  if (!(dtSim > 0)) return null;
  opts.simulator.subSteps = Math.max(1, Math.round(opts.accuracy || 1));
  const states = opts.simulator.tick(components, wires, clock.simTime, dtSim);
  return { components: applyStates(components, states), states };
}

/**
 * Drive the simulator from requestAnimationFrame (setTimeout when there is
 * no rAF), with sim time tied to wall-clock time. The engine tick runs here,
 * outside any React state updater, so StrictMode's double-invoked updaters
 * can't run it twice.
 */
export function useSimulationLoop(opts: SimulationLoopOptions): SimulationLoopState {
  const [state, setState] = useState<SimulationLoopState>({ simTime: 0, lagging: false, effectiveSpeed: 0 });
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const clockRef = useRef<SimClock | null>(null);
  if (!clockRef.current) clockRef.current = new SimClock();

  useEffect(() => {
    const clock = clockRef.current!;
    if (!opts.running) {
      clock.stop();
      setState({ simTime: 0, lagging: false, effectiveSpeed: 0 });
      return;
    }
    const now = opts.now ?? defaultNow;
    const request = opts.requestFrame ?? defaultRequest;
    const cancel = opts.cancelFrame ?? defaultCancel;
    let handle: unknown = null;
    let alive = true;
    clock.start(now());

    const frame = () => {
      if (!alive) return;
      const o = optsRef.current;
      try {
        const res = runSimulationFrame(clock, now(), o, o.componentsRef.current, o.wiresRef.current);
        if (res) {
          // Keep the ref current so the next frame sees these states even
          // before React re-renders; merge into the latest React state with a
          // pure updater (user edits made meanwhile are kept).
          o.componentsRef.current = res.components;
          const states = res.states;
          o.setComponents((prev) => applyStates(prev, states));
          o.onAdvance?.(res.components, clock.simTime);
        }
      } catch (e) {
        console.error('Simulation step failed:', e);
      }
      setState((prev) =>
        prev.simTime === clock.simTime && prev.lagging === clock.lagging && Math.abs(prev.effectiveSpeed - clock.effectiveSpeed) < 0.01
          ? prev
          : { simTime: clock.simTime, lagging: clock.lagging, effectiveSpeed: clock.effectiveSpeed });
      handle = request(frame);
    };
    handle = request(frame);
    return () => {
      alive = false;
      cancel(handle);
      clock.stop();
    };
    // Speed, accuracy and callbacks are read through optsRef each frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.running]);

  return state;
}
