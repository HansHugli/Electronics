import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';
import {
  createMNA, stampConductance, stampCurrentSource, stampVoltageSource, solve,
} from './mna';
import {
  GRID_W, GRID_H, BOARD_X_OFFSET,
  buildPinGroups, buildPinLookup,
} from '../data/breadboard';
import { AVRBridge } from './avrBridge';

/**
 * Analog circuit simulator using Modified Nodal Analysis.
 *
 * Supports: resistors (Ohm's law), voltage sources, capacitors (transient),
 * LEDs (piecewise linear diode), switches, and 555 Timer (behavioral).
 *
 * Persistent state is held between ticks for capacitors and 555 timers.
 */

/**
 * Get the pixel position of a component pin, accounting for rotation.
 */
function getComponentPinPixel(comp: PlacedComponent, pinId: string): { x: number; y: number } | null {
  const def = COMPONENT_DEFINITIONS[comp.type];
  if (!def) return null;
  const pin = def.pins.find((p) => p.id === pinId);
  if (!pin) return null;

  // Rotation swaps width/height and remaps sides
  const isRotated = comp.rotation === 90 || comp.rotation === 270;
  const w = (isRotated ? def.height : def.width) * GRID_W;
  const h = (isRotated ? def.width : def.height) * GRID_H;

  const sides: ('top' | 'right' | 'bottom' | 'left')[] = ['top', 'right', 'bottom', 'left'];
  const idx = sides.indexOf(pin.side);
  const steps = Math.round(comp.rotation / 90) % 4;
  const side = sides[(idx + steps) % 4];

  let px = 0, py = 0;
  switch (side) {
    case 'left':   px = 0;              py = h * pin.offset; break;
    case 'right':  px = w;              py = h * pin.offset; break;
    case 'top':    px = w * pin.offset; py = 0;              break;
    case 'bottom': px = w * pin.offset; py = h;              break;
  }

  return { x: comp.position.x + px, y: comp.position.y + py };
}

/**
 * Convert a pixel position to the nearest breadboard grid (col, row).
 */
function pixelToBoardGrid(px: number, py: number): { col: number; row: number } {
  return {
    col: Math.round((px - BOARD_X_OFFSET - GRID_W / 2) / GRID_W),
    row: Math.round((py - GRID_H / 2) / GRID_H),
  };
}

// Build breadboard pin groups and lookup once (they're static)
const boardPinGroups = buildPinGroups();
const boardPinLookup = buildPinLookup(boardPinGroups);

/** Logic gate type → boolean function. */
const GATE_FUNCTIONS: Record<string, (a: boolean, b: boolean) => boolean> = {
  gate_and: (a, b) => a && b,
  gate_or: (a, b) => a || b,
  gate_nand: (a, b) => !(a && b),
};

interface PersistentState {
  capVoltages: Map<string, number>;       // componentId -> voltage across cap
  timer555: Map<string, boolean>;          // componentId -> flip-flop state (true = output high)
  cd4026: Map<string, { count: number; prevClk: boolean }>; // componentId -> counter state
  gateOutputs: Map<string, Record<string, boolean>>; // componentId -> { '1y': true, '2y': false, ... }
  opampOut: Map<string, number>;           // componentId -> previous output voltage
  ledMatrix: Map<string, boolean[]>;       // componentId -> 35 booleans (col-major: C1R1..C1R7, C2R1..C2R7, ...)
  ledMatrixHistory: Map<string, boolean[][]>; // componentId -> ring buffer of recent per-tick LED states (sliding-window OR)
  avrBridges: Map<string, AVRBridge>;     // componentId -> AVR bridge instance
  shiftReg: Map<string, { bits: number; output: number; prevSrclk: boolean; prevRclk: boolean; prevSer: boolean; prevSrclr: boolean; outputHistory: { cycle: number; output: number }[] }>; // 74HC595
  flipflop: Map<string, { q1: boolean; q2: boolean; prevClk1: boolean; prevClk2: boolean }>;      // 74HC74
}

export class CircuitSimulator {
  private state: PersistentState = {
    capVoltages: new Map(),
    timer555: new Map(),
    cd4026: new Map(),
    gateOutputs: new Map(),
    opampOut: new Map(),
    ledMatrix: new Map(),
    ledMatrixHistory: new Map(),
    avrBridges: new Map(),
    shiftReg: new Map(),
    flipflop: new Map(),
  };

  reset(): void {
    this.state.capVoltages.clear();
    this.state.timer555.clear();
    this.state.cd4026.clear();
    this.state.gateOutputs.clear();
    this.state.opampOut.clear();
    this.state.ledMatrix.clear();
    this.state.ledMatrixHistory.clear();
    this.state.shiftReg.clear();
    this.state.flipflop.clear();
    for (const bridge of this.state.avrBridges.values()) bridge.reset();
  }

  /** Load a hex program into a specific ATmega328 component. */
  loadAVRProgram(componentId: string, hexString: string): void {
    let bridge = this.state.avrBridges.get(componentId);
    if (!bridge) {
      bridge = new AVRBridge();
      this.state.avrBridges.set(componentId, bridge);
    }
    bridge.load(hexString);
  }

  /** Check if an ATmega328 has a loaded program. */
  isAVRLoaded(componentId: string): boolean {
    return this.state.avrBridges.get(componentId)?.isLoaded() ?? false;
  }

  /** Number of sub-steps per tick for improved accuracy (1 = default, higher = more accurate). */
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

  /**
   * Run one simulation tick.
   * @param components - all placed components
   * @param wires - all wires
   * @param time - simulation time in ms
   * @param dt - timestep in seconds (0.1 for 100ms ticks)
   * @returns map of componentId -> state record
   */
  tick(
    components: PlacedComponent[],
    wires: Wire[],
    time: number,
    dt: number,
  ): Map<string, Record<string, number | string>> {
    // Sub-stepping: run multiple smaller steps for accuracy
    if (this.subSteps > 1) {
      const subDt = dt / this.subSteps;
      let result: Map<string, Record<string, number | string>> = new Map();
      for (let s = 0; s < this.subSteps; s++) {
        const subTime = time - (dt * 1000) + ((s + 1) * subDt * 1000);
        result = this._tickInner(components, wires, subTime, subDt);
        // Apply intermediate results so next sub-step sees updated state
        for (const comp of components) {
          const newState = result.get(comp.id);
          if (newState) Object.assign(comp.state, newState);
        }
      }
      return result;
    }
    return this._tickInner(components, wires, time, dt);
  }

  private _tickInner(
    components: PlacedComponent[],
    wires: Wire[],
    time: number,
    dt: number,
  ): Map<string, Record<string, number | string>> {
    const results = new Map<string, Record<string, number | string>>();
    for (const comp of components) {
      results.set(comp.id, { ...comp.state });
    }

    // === Step 1: Build node graph ===
    const pinKey = (compId: string, pinId: string) => `${compId}:${pinId}`;

    // Union-Find for merging connected pins into nodes
    const parent = new Map<string, string>();
    function find(k: string): string {
      if (!parent.has(k)) parent.set(k, k);
      let p = parent.get(k)!;
      while (parent.get(p) !== p) {
        parent.set(p, parent.get(parent.get(p)!)!); // path compression
        p = parent.get(p)!;
      }
      parent.set(k, p);
      return p;
    }
    function union(a: string, b: string): void {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }

    // Register all component pins
    for (const comp of components) {
      const def = COMPONENT_DEFINITIONS[comp.type];
      if (!def) continue;
      for (const pin of def.pins) {
        find(pinKey(comp.id, pin.id));
      }
    }

    // Register board pin endpoints from wires
    for (const wire of wires) {
      find(pinKey(wire.from.componentId, wire.from.pinId));
      find(pinKey(wire.to.componentId, wire.to.pinId));
    }

    // Merge by wires
    for (const wire of wires) {
      union(
        pinKey(wire.from.componentId, wire.from.pinId),
        pinKey(wire.to.componentId, wire.to.pinId),
      );
    }

    // Merge switch pins if closed
    for (const comp of components) {
      if (comp.type === 'switch' && comp.state?.closed) {
        union(pinKey(comp.id, 'a'), pinKey(comp.id, 'b'));
      }
    }

    // === Step 1b: Breadboard internal wiring ===
    // For each component pin, find which breadboard hole it sits on,
    // then merge all pins that share the same 5-pin strip group.
    // Also merge board pin wire endpoints into their groups.

    // Map: groupId -> list of pin keys in that group
    const groupToPins = new Map<string, string[]>();

    // Component pins → breadboard holes
    for (const comp of components) {
      if (comp.type === 'power') continue; // power supply is off-board
      const def = COMPONENT_DEFINITIONS[comp.type];
      if (!def) continue;
      for (const pin of def.pins) {
        const pos = getComponentPinPixel(comp, pin.id);
        if (!pos) continue;
        const grid = pixelToBoardGrid(pos.x, pos.y);
        const groupId = boardPinLookup.get(`${grid.col},${grid.row}`);
        if (!groupId) continue; // pin is not on a valid hole
        const pk = pinKey(comp.id, pin.id);
        if (!groupToPins.has(groupId)) groupToPins.set(groupId, []);
        groupToPins.get(groupId)!.push(pk);
      }
    }

    // Board pin wire endpoints → breadboard holes
    // When a board hole is referenced, register ALL holes in its group
    // so the full strip/rail is connected internally.
    for (const wire of wires) {
      for (const endpoint of [wire.from, wire.to]) {
        if (endpoint.componentId === 'board') {
          const [colStr, rowStr] = endpoint.pinId.split(',');
          const col = parseInt(colStr, 10);
          const row = parseInt(rowStr, 10);
          const groupId = boardPinLookup.get(`${col},${row}`);
          if (!groupId) continue;
          const pk = pinKey(endpoint.componentId, endpoint.pinId);
          if (!groupToPins.has(groupId)) {
            groupToPins.set(groupId, []);
            // Register all holes in this group so internal wiring works
            const group = boardPinGroups.find((g) => g.id === groupId);
            if (group) {
              for (const gpin of group.pins) {
                const gpk = pinKey('board', `${gpin.col},${gpin.row}`);
                find(gpk);
                groupToPins.get(groupId)!.push(gpk);
              }
            }
          }
          // Also add this specific endpoint if not already present
          if (!groupToPins.get(groupId)!.includes(pk)) {
            find(pk);
            groupToPins.get(groupId)!.push(pk);
          }
        }
      }
    }

    // Merge all pins within each breadboard group
    for (const [, pins] of groupToPins) {
      for (let i = 1; i < pins.length; i++) {
        union(pins[0], pins[i]);
      }
    }

    // === Step 2: Assign node IDs ===
    // Ground = node 0: any power source neg pin
    let groundRoot: string | null = null;
    for (const comp of components) {
      if (comp.type === 'power') {
        groundRoot = find(pinKey(comp.id, 'neg'));
        break;
      }
    }
    if (!groundRoot) {
      // No power source — nothing to simulate
      return results;
    }

    // Map root -> node ID. Ground = 0, others = 1, 2, ...
    const rootToNode = new Map<string, number>();
    rootToNode.set(groundRoot, 0);
    let nextNodeId = 1;

    function getNode(compId: string, pinId: string): number {
      const root = find(pinKey(compId, pinId));
      if (!rootToNode.has(root)) {
        rootToNode.set(root, nextNodeId++);
      }
      return rootToNode.get(root)!;
    }

    // Pre-assign all nodes
    for (const comp of components) {
      const def = COMPONENT_DEFINITIONS[comp.type];
      if (!def) continue;
      for (const pin of def.pins) {
        getNode(comp.id, pin.id);
      }
    }

    const N = nextNodeId - 1; // number of non-ground nodes

    // === Step 2.5: AVR pre-pass ===
    // Run all AVR CPUs first so we have:
    //   (a) the final pin states needed for stamping,
    //   (b) the per-tick transition log needed for sequential digital replay.
    // Then update AVR-driven sequential components (shift registers, D flip-
    // flops) BEFORE the MNA matrix is stamped, so the column/output values
    // they drive are consistent with the AVR row pins in the same solve.
    const avrGpioPins = [
      'pd0','pd1','pd2','pd3','pd4','pd5','pd6','pd7',
      'pb0','pb1','pb2','pb3','pb4','pb5',
      'pc0','pc1','pc2','pc3','pc4','pc5',
    ];
    interface AvrDriver { avrId: string; pinId: string; bridge: AVRBridge }
    const nodeToAvrDriver = new Map<number, AvrDriver>();
    const avrFinalPins = new Map<string, Map<string, string>>(); // avrId -> pinId -> state
    for (const comp of components) {
      if (comp.type !== 'atmega328') continue;
      const bridge = this.state.avrBridges.get(comp.id);
      if (!bridge?.isLoaded()) continue;
      const result = bridge.tick(dt);
      avrFinalPins.set(comp.id, result.pins as Map<string, string>);
      for (const pinId of avrGpioPins) {
        const node = getNode(comp.id, pinId);
        nodeToAvrDriver.set(node, { avrId: comp.id, pinId, bridge });
      }
    }

    // Helper used by both shift-register and flip-flop pre-pass to walk an
    // AVR's per-tick transition log and apply edge logic at each event.
    const collectAvrTransitions = (
      drv: AvrDriver | undefined,
      which: string,
    ): { cycle: number; which: string; high: boolean }[] => {
      if (!drv) return [];
      const out: { cycle: number; which: string; high: boolean }[] = [];
      for (const t of drv.bridge.transitions) {
        if (t.pinId === drv.pinId) out.push({ cycle: t.cycle, which, high: t.high });
      }
      return out;
    };

    // 74HC595 pre-pass: replay AVR-sourced edges so sr.output is current
    // BEFORE we stamp it into the MNA matrix below. Shift registers without
    // any AVR driver fall through and are handled in the post-solve update,
    // which uses analog snapshot voltages.
    const shiftRegHandledEarly = new Set<string>();
    for (const comp of components) {
      if (comp.type !== 'shift_register') continue;
      const srclkNode = getNode(comp.id, 'srclk');
      const rclkNode = getNode(comp.id, 'rclk');
      const serNode = getNode(comp.id, 'ser');
      const srclrNode = getNode(comp.id, 'srclr');
      const oeNode = getNode(comp.id, 'oe');
      const srclkDrv = nodeToAvrDriver.get(srclkNode);
      const rclkDrv = nodeToAvrDriver.get(rclkNode);
      const serDrv = nodeToAvrDriver.get(serNode);
      const srclrDrv = nodeToAvrDriver.get(srclrNode);
      const oeDrv = nodeToAvrDriver.get(oeNode);
      // If no clock input is AVR-driven, leave for the post-solve path.
      if (!srclkDrv && !rclkDrv && !srclrDrv) continue;

      if (!this.state.shiftReg.has(comp.id)) {
        this.state.shiftReg.set(comp.id, { bits: 0, output: 0, prevSrclk: false, prevRclk: false, prevSer: false, prevSrclr: true, outputHistory: [] });
      }
      const sr = this.state.shiftReg.get(comp.id)!;

      // Reset per-tick output history. The first entry records the output
      // value at the start of this tick (carried over from the previous tick).
      sr.outputHistory = [{ cycle: 0, output: sr.output }];

      // Build merged event stream
      const events = [
        ...collectAvrTransitions(srclkDrv, 'srclk'),
        ...collectAvrTransitions(rclkDrv, 'rclk'),
        ...collectAvrTransitions(serDrv, 'ser'),
        ...collectAvrTransitions(srclrDrv, 'srclr'),
      ].sort((a, b) => a.cycle - b.cycle);

      let curSrclk = sr.prevSrclk;
      let curRclk = sr.prevRclk;
      let curSer = sr.prevSer;
      let curSrclr = sr.prevSrclr;
      // OE is rarely toggled mid-tick — sample its final AVR state if AVR-
      // driven, otherwise assume enabled (the post-solve fallback handles
      // non-AVR OE properly).
      const oeFinalState = oeDrv ? avrFinalPins.get(oeDrv.avrId)?.get(oeDrv.pinId) : undefined;
      const curOe = oeFinalState === 'high';

      const apply = (next: { srclk: boolean; rclk: boolean; ser: boolean; srclr: boolean }, cycle: number) => {
        if (!next.srclr) {
          sr.bits = 0;
        } else if (next.srclk && !curSrclk) {
          sr.bits = ((sr.bits << 1) | (next.ser ? 1 : 0)) & 0xFF;
        }
        if (next.rclk && !curRclk) {
          const newOut = curOe ? 0 : sr.bits;
          if (newOut !== sr.output) {
            sr.output = newOut;
            sr.outputHistory.push({ cycle, output: sr.output });
          }
        }
        curSrclk = next.srclk;
        curRclk = next.rclk;
        curSer = next.ser;
        curSrclr = next.srclr;
      };

      for (const ev of events) {
        const next = { srclk: curSrclk, rclk: curRclk, ser: curSer, srclr: curSrclr };
        (next as Record<string, boolean>)[ev.which] = ev.high;
        apply(next, ev.cycle);
      }

      // Settle to final AVR-driven levels (non-AVR pins keep their cur values)
      const finalState = (drv: AvrDriver | undefined, fallback: boolean) => {
        if (!drv) return fallback;
        return avrFinalPins.get(drv.avrId)?.get(drv.pinId) === 'high';
      };
      const settled = {
        srclk: finalState(srclkDrv, curSrclk),
        rclk: finalState(rclkDrv, curRclk),
        ser: finalState(serDrv, curSer),
        srclr: srclrDrv ? finalState(srclrDrv, curSrclr) : true, // assume tied high if not AVR-driven
      };
      // Use a sentinel cycle past the last event so any final-state edge is
      // recorded at the end of the tick.
      const tickEndCycle = events.length > 0 ? events[events.length - 1].cycle + 1 : 0;
      apply(settled, tickEndCycle);

      sr.prevSrclk = settled.srclk;
      sr.prevRclk = settled.rclk;
      sr.prevSer = settled.ser;
      sr.prevSrclr = settled.srclr;
      shiftRegHandledEarly.add(comp.id);
    }

    // 74HC74 pre-pass: same idea for AVR-driven D flip-flops.
    const flipflopHandledEarly = new Set<string>();
    for (const comp of components) {
      if (comp.type !== 'flipflop_d') continue;
      let anyAvrDriver = false;
      for (const n of ['1', '2'] as const) {
        if (
          nodeToAvrDriver.get(getNode(comp.id, `${n}clk`)) ||
          nodeToAvrDriver.get(getNode(comp.id, `${n}pre`)) ||
          nodeToAvrDriver.get(getNode(comp.id, `${n}clr`))
        ) {
          anyAvrDriver = true;
          break;
        }
      }
      if (!anyAvrDriver) continue;
      if (!this.state.flipflop.has(comp.id)) {
        this.state.flipflop.set(comp.id, { q1: false, q2: false, prevClk1: false, prevClk2: false });
      }
      const ff = this.state.flipflop.get(comp.id)!;

      for (const n of ['1', '2'] as const) {
        const clkDrv = nodeToAvrDriver.get(getNode(comp.id, `${n}clk`));
        const dDrv = nodeToAvrDriver.get(getNode(comp.id, `${n}d`));
        const preDrv = nodeToAvrDriver.get(getNode(comp.id, `${n}pre`));
        const clrDrv = nodeToAvrDriver.get(getNode(comp.id, `${n}clr`));

        const events = [
          ...collectAvrTransitions(clkDrv, 'clk'),
          ...collectAvrTransitions(dDrv, 'd'),
          ...collectAvrTransitions(preDrv, 'pre'),
          ...collectAvrTransitions(clrDrv, 'clr'),
        ].sort((a, b) => a.cycle - b.cycle);

        const finalState = (drv: AvrDriver | undefined, fallback: boolean) => {
          if (!drv) return fallback;
          return avrFinalPins.get(drv.avrId)?.get(drv.pinId) === 'high';
        };

        let curClk = n === '1' ? ff.prevClk1 : ff.prevClk2;
        let curD = finalState(dDrv, true);
        let curPre = finalState(preDrv, true);
        let curClr = finalState(clrDrv, true);
        let q = n === '1' ? ff.q1 : ff.q2;

        const step = (next: { clk: boolean; d: boolean; pre: boolean; clr: boolean }) => {
          if (!next.clr) q = false;
          else if (!next.pre) q = true;
          else if (next.clk && !curClk) q = next.d;
          curClk = next.clk;
          curD = next.d;
          curPre = next.pre;
          curClr = next.clr;
        };

        for (const ev of events) {
          const next = { clk: curClk, d: curD, pre: curPre, clr: curClr };
          (next as Record<string, boolean>)[ev.which] = ev.high;
          step(next);
        }
        step({
          clk: finalState(clkDrv, curClk),
          d: finalState(dDrv, curD),
          pre: finalState(preDrv, curPre),
          clr: finalState(clrDrv, curClr),
        });

        if (n === '1') { ff.q1 = q; ff.prevClk1 = curClk; }
        else { ff.q2 = q; ff.prevClk2 = curClk; }
      }
      flipflopHandledEarly.add(comp.id);
    }

    // === Step 3: Count voltage sources ===
    let numVSources = 0;
    const vsourceIndex = new Map<string, number>(); // componentId -> branch index

    for (const comp of components) {
      if (comp.type === 'power') {
        vsourceIndex.set(comp.id, numVSources++);
      }
    }

    // LEDs modeled as voltage sources when on (second pass)
    // 555 OUT pin modeled as voltage source
    // Reserve indices for them after first pass

    // === Step 4: Build and stamp MNA matrix ===
    const size = N + numVSources;
    if (size === 0) return results;

    const { G, b } = createMNA(size);

    // Add tiny conductance from every node to ground for numerical stability
    for (let i = 1; i <= N; i++) {
      stampConductance(G, i, 0, 1e-9);
    }

    // --- Stamp power sources ---
    for (const comp of components) {
      if (comp.type === 'power') {
        const nodePos = getNode(comp.id, 'pos');
        const nodeNeg = getNode(comp.id, 'neg'); // should be 0 (ground)
        let voltage = Number(comp.properties.voltage ?? 5);

        // AC support
        if (comp.properties.mode === 'AC') {
          const freq = 60; // 60Hz default
          const t = time / 1000; // convert ms to seconds
          if (comp.properties.waveform === 'sine') {
            voltage *= Math.sin(2 * Math.PI * freq * t);
          } else {
            // square wave
            voltage *= Math.sign(Math.sin(2 * Math.PI * freq * t));
          }
        }

        stampVoltageSource(G, b, nodePos, nodeNeg, voltage, N, vsourceIndex.get(comp.id)!);
      }
    }

    // --- Stamp resistors ---
    for (const comp of components) {
      if (comp.type === 'resistor') {
        const nodeA = getNode(comp.id, 'a');
        const nodeB = getNode(comp.id, 'b');
        const R = Number(comp.properties.resistance ?? 220);
        stampConductance(G, nodeA, nodeB, 1 / Math.max(R, 0.01));
      }
    }

    // --- Stamp potentiometers (two resistors from position) ---
    for (const comp of components) {
      if (comp.type === 'potentiometer') {
        const node1 = getNode(comp.id, 'pin1');
        const nodeW = getNode(comp.id, 'wiper');
        const node2 = getNode(comp.id, 'pin2');
        const R = Number(comp.properties.resistance ?? 10000);
        const pos = Number(comp.properties.position ?? 50) / 100; // 0-1
        const R1 = Math.max(R * pos, 0.01);       // pin1 to wiper
        const R2 = Math.max(R * (1 - pos), 0.01); // wiper to pin2
        stampConductance(G, node1, nodeW, 1 / R1);
        stampConductance(G, nodeW, node2, 1 / R2);
      }
    }

    // --- Stamp multimeters (very high impedance — just measures, doesn't affect circuit) ---
    for (const comp of components) {
      if (comp.type === 'multimeter') {
        const nodePos = getNode(comp.id, 'pos');
        const nodeNeg = getNode(comp.id, 'neg');
        // Voltmeter: very high resistance (10M ohm) so it doesn't draw current
        stampConductance(G, nodePos, nodeNeg, 1 / 10e6);
      }
    }

    // --- Stamp capacitors (backward Euler companion model) ---
    for (const comp of components) {
      if (comp.type === 'capacitor') {
        const nodePos = getNode(comp.id, 'pos');
        const nodeNeg = getNode(comp.id, 'neg');
        const C = Number(comp.properties.capacitance ?? 100) * 1e-6; // μF to F
        const vPrev = this.state.capVoltages.get(comp.id) ?? 0;

        const gEq = C / dt;
        stampConductance(G, nodePos, nodeNeg, gEq);
        // Current source for previous state: I = gEq * vPrev
        stampCurrentSource(b, nodeNeg, nodePos, gEq * vPrev);
      }
    }

    // --- Stamp LEDs (piecewise linear) ---
    // First pass: model as high resistance (off)
    // We'll check after solving and re-stamp if needed
    const ledNodes: { comp: PlacedComponent; nodeA: number; nodeC: number }[] = [];
    for (const comp of components) {
      if (comp.type === 'led') {
        const nodeA = getNode(comp.id, 'anode');
        const nodeC = getNode(comp.id, 'cathode');
        ledNodes.push({ comp, nodeA, nodeC });
        // Model as very high resistance (off state)
        stampConductance(G, nodeA, nodeC, 1e-9);
      }
    }

    // --- 555 Timer: behavioral model ---
    // First pass: stamp VCC/GND connections, then after solve update state
    const timerInfos: {
      comp: PlacedComponent;
      nodeVcc: number;
      nodeGnd: number;
      nodeOut: number;
      nodeTrig: number;
      nodeThr: number;
      nodeDis: number;
    }[] = [];

    for (const comp of components) {
      if (comp.type === 'timer') {
        const info = {
          comp,
          nodeVcc: getNode(comp.id, 'vcc'),
          nodeGnd: getNode(comp.id, 'gnd'),
          nodeOut: getNode(comp.id, 'out'),
          nodeTrig: getNode(comp.id, 'trig'),
          nodeThr: getNode(comp.id, 'thr'),
          nodeDis: getNode(comp.id, 'dis'),
        };
        timerInfos.push(info);

        // Get or init flip-flop state
        if (!this.state.timer555.has(comp.id)) {
          this.state.timer555.set(comp.id, false);
        }
        const outputHigh = this.state.timer555.get(comp.id)!;

        // OUT pin: model as conductance to VCC (high) or GND (low)
        if (outputHigh) {
          // OUT ≈ VCC: strong pull to VCC node
          stampConductance(G, info.nodeOut, info.nodeVcc, 1 / 10); // 10 ohm to VCC
        } else {
          // OUT ≈ GND: strong pull to ground
          stampConductance(G, info.nodeOut, 0, 1 / 10); // 10 ohm to ground
        }

        // DIS pin: when output LOW, DIS shorts to ground (internal transistor)
        if (!outputHigh) {
          stampConductance(G, info.nodeDis, 0, 1 / 1); // 1 ohm to ground
        } else {
          // DIS is open (high impedance) — tiny leakage
          stampConductance(G, info.nodeDis, 0, 1e-9);
        }
      }
    }

    // Switches already handled by union-find merge above
    // (closed switch = nodes merged, open = separate)

    // --- CD4026 decade counter: outputs based on current count ---
    // 7-segment patterns for digits 0-9: which segments are ON
    const seg7Patterns: Record<string, boolean>[] = [
      { a: true, b: true, c: true, d: true, e: true, f: true, g: false },       // 0
      { a: false, b: true, c: true, d: false, e: false, f: false, g: false },    // 1
      { a: true, b: true, c: false, d: true, e: true, f: false, g: true },       // 2
      { a: true, b: true, c: true, d: true, e: false, f: false, g: true },       // 3
      { a: false, b: true, c: true, d: false, e: false, f: true, g: true },      // 4
      { a: true, b: false, c: true, d: true, e: false, f: true, g: true },       // 5
      { a: true, b: false, c: true, d: true, e: true, f: true, g: true },        // 6
      { a: true, b: true, c: true, d: false, e: false, f: false, g: false },     // 7
      { a: true, b: true, c: true, d: true, e: true, f: true, g: true },         // 8
      { a: true, b: true, c: true, d: true, e: false, f: true, g: true },        // 9
    ];

    for (const comp of components) {
      if (comp.type === 'cd4026') {
        if (!this.state.cd4026.has(comp.id)) {
          this.state.cd4026.set(comp.id, { count: 0, prevClk: false });
        }

        const nodeVcc = getNode(comp.id, 'vcc');
        const segPins = ['out_a', 'out_b', 'out_c', 'out_d', 'out_e', 'out_f', 'out_g'];
        const segNames = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

        const counterState = this.state.cd4026.get(comp.id)!;
        const pattern = seg7Patterns[counterState.count % 10];

        // Stamp each segment output: low impedance to VCC (high) or GND (low)
        for (let i = 0; i < segPins.length; i++) {
          const segNode = getNode(comp.id, segPins[i]);
          const isOn = pattern[segNames[i]];
          if (isOn) {
            // Output HIGH: connect to VCC through low resistance
            stampConductance(G, segNode, nodeVcc, 1 / 10);
          } else {
            // Output LOW: connect to GND through low resistance
            stampConductance(G, segNode, 0, 1 / 10);
          }
        }

        // Carry out: high when count >= 5 (for cascading — goes high at 5, low at 0)
        const coNode = getNode(comp.id, 'co');
        if (counterState.count >= 5) {
          stampConductance(G, coNode, nodeVcc, 1 / 10);
        } else {
          stampConductance(G, coNode, 0, 1 / 10);
        }
      }
    }

    // --- Logic gates (quad 2-input and hex inverter): stamp outputs from previous tick ---
    for (const comp of components) {
      const gateFn = GATE_FUNCTIONS[comp.type] as ((a: boolean, b: boolean) => boolean) | undefined;
      if (gateFn !== undefined) {
        // Quad 2-input gate: 4 gates, each with inputs nA, nB and output nY
        const nodeVcc = getNode(comp.id, 'vcc');
        if (!this.state.gateOutputs.has(comp.id)) {
          this.state.gateOutputs.set(comp.id, {});
        }
        const prev = this.state.gateOutputs.get(comp.id)!;
        for (const n of ['1', '2', '3', '4']) {
          const outPin = `${n}y`;
          const outNode = getNode(comp.id, outPin);
          const isHigh = prev[outPin] ?? false;
          if (isHigh) {
            stampConductance(G, outNode, nodeVcc, 1 / 10);
          } else {
            stampConductance(G, outNode, 0, 1 / 10);
          }
        }
      }
      if (comp.type === 'gate_not') {
        // Hex inverter: 6 inverters, each with input nA and output nY
        const nodeVcc = getNode(comp.id, 'vcc');
        if (!this.state.gateOutputs.has(comp.id)) {
          this.state.gateOutputs.set(comp.id, {});
        }
        const prev = this.state.gateOutputs.get(comp.id)!;
        for (const n of ['1', '2', '3', '4', '5', '6']) {
          const outPin = `${n}y`;
          const outNode = getNode(comp.id, outPin);
          const isHigh = prev[outPin] ?? true; // NOT gate defaults high (input low → output high)
          if (isHigh) {
            stampConductance(G, outNode, nodeVcc, 1 / 10);
          } else {
            stampConductance(G, outNode, 0, 1 / 10);
          }
        }
      }
    }

    // --- Op-amp (LM741): voltage-controlled source ---
    // Model: output = clamp(gain * (V+ - V-), V-, V+)
    // Stamp as conductance from output to the computed voltage level
    for (const comp of components) {
      if (comp.type === 'opamp') {
        const nodeOut = getNode(comp.id, 'out');
        const nodeVPos = getNode(comp.id, 'v_pos');
        const nodeVNeg = getNode(comp.id, 'v_neg');
        const prevOut = this.state.opampOut.get(comp.id) ?? 0;
        // Strong drive to previous output voltage — will be updated after solve
        // Model as low-impedance source at previous output level
        if (Math.abs(prevOut) > 0.01) {
          // Drive toward prevOut: conductance to ground + current source
          const gDrive = 1 / 1; // 1 ohm output impedance
          stampConductance(G, nodeOut, 0, gDrive);
          stampCurrentSource(b, 0, nodeOut, prevOut * gDrive);
        } else {
          stampConductance(G, nodeOut, 0, 1 / 1);
        }
        // Input pins: very high impedance
        stampConductance(G, getNode(comp.id, 'in_pos'), 0, 1e-12);
        stampConductance(G, getNode(comp.id, 'in_neg'), 0, 1e-12);
      }
    }

    // --- LED Matrix (5x7): stamp each LED based on column/row voltages ---
    // Each LED: anode = column pin, cathode = row pin
    // Model same as regular LED but simpler: just high-impedance initially
    const matrixLeds: { comp: PlacedComponent; col: number; row: number; nodeCol: number; nodeRow: number }[] = [];
    for (const comp of components) {
      if (comp.type === 'ledmatrix') {
        for (let c = 0; c < 5; c++) {
          const colPin = `c${c + 1}`;
          const nodeCol = getNode(comp.id, colPin);
          for (let r = 0; r < 7; r++) {
            const rowPin = `r${r + 1}`;
            const nodeRow = getNode(comp.id, rowPin);
            matrixLeds.push({ comp, col: c, row: r, nodeCol, nodeRow });
            // Initially high impedance
            stampConductance(G, nodeCol, nodeRow, 1e-9);
          }
        }
      }
    }

    // --- Function Generator: voltage source with waveform ---
    for (const comp of components) {
      if (comp.type === 'funcgen') {
        const nodeOut = getNode(comp.id, 'out');
        const nodeGnd = getNode(comp.id, 'gnd');
        const amp = Number(comp.properties.amplitude ?? 5);
        const freq = Number(comp.properties.frequency ?? 1);
        const waveform = String(comp.properties.waveform ?? 'sine');
        const dcOffset = Number(comp.properties.offset ?? 0);
        const t = time / 1000; // ms to seconds
        const phase = (freq * t) % 1; // 0-1

        let value = 0;
        switch (waveform) {
          case 'sine':
            value = amp * Math.sin(2 * Math.PI * phase) + dcOffset;
            break;
          case 'square':
            value = amp * (phase < 0.5 ? 1 : -1) + dcOffset;
            break;
          case 'triangle':
            value = amp * (phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase) + dcOffset;
            break;
          case 'sawtooth':
            value = amp * (2 * phase - 1) + dcOffset;
            break;
        }

        // Stamp as conductance + current source to produce desired voltage
        const gDrive = 1 / 0.1; // 0.1 ohm output impedance
        stampConductance(G, nodeOut, nodeGnd, gDrive);
        stampCurrentSource(b, nodeGnd, nodeOut, value * gDrive);
      }
    }

    // --- Voltage Regulator (7805 style): clamp output ---
    for (const comp of components) {
      if (comp.type === 'vreg') {
        const nodeIn = getNode(comp.id, 'vin');
        const nodeOut = getNode(comp.id, 'vout');
        const nodeGnd = getNode(comp.id, 'gnd');
        // Model: output = min(Vin - dropout, Vout_target)
        // For stamping, use previous tick approximation
        const vOutTarget = Number(comp.properties.outputVoltage ?? 5);
        // Low impedance output at target voltage (relative to GND pin)
        const gDrive = 1 / 0.5; // 0.5 ohm output impedance
        stampConductance(G, nodeOut, nodeGnd, gDrive);
        stampCurrentSource(b, nodeGnd, nodeOut, vOutTarget * gDrive);
        // Input draws current: model as moderate resistance
        stampConductance(G, nodeIn, nodeGnd, 1 / 100);
      }
    }

    // --- 74HC595 Shift Register: stamp outputs from previous tick ---
    for (const comp of components) {
      if (comp.type === 'shift_register') {
        const nodeVcc = getNode(comp.id, 'vcc');
        if (!this.state.shiftReg.has(comp.id)) {
          this.state.shiftReg.set(comp.id, { bits: 0, output: 0, prevSrclk: false, prevRclk: false, prevSer: false, prevSrclr: true, outputHistory: [] });
        }
        const sr = this.state.shiftReg.get(comp.id)!;
        const outputPins = ['qa', 'qb', 'qc', 'qd', 'qe', 'qf', 'qg', 'qh'];
        for (let i = 0; i < 8; i++) {
          const node = getNode(comp.id, outputPins[i]);
          const isHigh = (sr.output >> i) & 1;
          if (isHigh) {
            stampConductance(G, node, nodeVcc, 1 / 10);
          } else {
            stampConductance(G, node, 0, 1 / 10);
          }
        }
        // QH' (serial out) = bit 7 of shift register
        const qhpNode = getNode(comp.id, 'qh_p');
        if ((sr.bits >> 7) & 1) {
          stampConductance(G, qhpNode, nodeVcc, 1 / 10);
        } else {
          stampConductance(G, qhpNode, 0, 1 / 10);
        }
      }
    }

    // --- 74HC74 D Flip-Flop: stamp Q outputs from previous tick ---
    for (const comp of components) {
      if (comp.type === 'flipflop_d') {
        const nodeVcc = getNode(comp.id, 'vcc');
        if (!this.state.flipflop.has(comp.id)) {
          this.state.flipflop.set(comp.id, { q1: false, q2: false, prevClk1: false, prevClk2: false });
        }
        const ff = this.state.flipflop.get(comp.id)!;
        // FF1 outputs
        const node1q = getNode(comp.id, '1q');
        const node1qn = getNode(comp.id, '1qn');
        stampConductance(G, node1q, ff.q1 ? nodeVcc : 0, 1 / 10);
        stampConductance(G, node1qn, ff.q1 ? 0 : nodeVcc, 1 / 10);
        // FF2 outputs
        const node2q = getNode(comp.id, '2q');
        const node2qn = getNode(comp.id, '2qn');
        stampConductance(G, node2q, ff.q2 ? nodeVcc : 0, 1 / 10);
        stampConductance(G, node2qn, ff.q2 ? 0 : nodeVcc, 1 / 10);
      }
    }

    // --- ATmega328: stamp GPIO pins from the pre-pass (Step 2.5) results ---
    // The CPUs were already run there so the per-tick transition log was
    // available for sequential digital components to replay before stamping.
    for (const comp of components) {
      if (comp.type === 'atmega328') {
        const finalPins = avrFinalPins.get(comp.id);
        if (!finalPins) {
          // No program loaded — all GPIO pins are high-impedance
          for (const pinId of avrGpioPins) {
            const node = getNode(comp.id, pinId);
            stampConductance(G, node, 0, 1e-9);
          }
          continue;
        }

        const nodeVcc = getNode(comp.id, 'vcc');

        for (const pinId of avrGpioPins) {
          const node = getNode(comp.id, pinId);
          const pinState = finalPins.get(pinId);

          if (pinState === 'high') {
            stampConductance(G, node, nodeVcc, 1 / 40); // ~40Ω output impedance
          } else if (pinState === 'low') {
            stampConductance(G, node, 0, 1 / 40);
          } else if (pinState === 'input_pullup') {
            stampConductance(G, node, nodeVcc, 1 / 20000);
          } else {
            stampConductance(G, node, 0, 1e-9);
          }
        }
      }
    }

    // === Step 5: Solve ===
    let x = solve(G, b);
    if (!x) {
      // Singular — return default states
      return results;
    }

    // Helper: get voltage at a node from solution
    function nodeVoltage(nodeId: number): number {
      if (nodeId === 0) return 0; // ground
      return x![nodeId - 1];
    }

    // === Step 6: LED second pass ===
    // Check if any LED should be on, and if so, re-solve with it conducting
    let needResolve = false;
    for (const led of ledNodes) {
      const vAnode = nodeVoltage(led.nodeA);
      const vCathode = nodeVoltage(led.nodeC);
      const vf = Number(led.comp.properties.forwardVoltage ?? 2.0);
      const vAcross = vAnode - vCathode;

      if (vAcross > vf) {
        // LED should be on — re-stamp as conducting
        // Model: resistor R_series with voltage source Vf opposing current
        // I = (V_anode - V_cathode - Vf) / R_series
        // Equivalent: conductance g + current source Vf*g from cathode to anode
        const rSeries = 50;
        const gOn = 1 / rSeries;
        stampConductance(G, led.nodeA, led.nodeC, gOn);
        // Current source: Vf*g flowing cathode→anode (opposing forward bias)
        stampCurrentSource(b, led.nodeC, led.nodeA, vf * gOn);
        needResolve = true;
      }
    }

    // Save pre-LED voltages for Step 7 and cap storage
    // The LED second-pass re-solve changes the matrix, corrupting these values
    const preLedVoltages = new Map<string, { vTrig: number; vThr: number; vcc: number }>();
    for (const info of timerInfos) {
      preLedVoltages.set(info.comp.id, {
        vTrig: nodeVoltage(info.nodeTrig),
        vThr: nodeVoltage(info.nodeThr),
        vcc: nodeVoltage(info.nodeVcc),
      });
    }
    const preLedCapVoltages = new Map<string, number>();
    for (const comp of components) {
      if (comp.type === 'capacitor') {
        const vP = nodeVoltage(getNode(comp.id, 'pos'));
        const vN = nodeVoltage(getNode(comp.id, 'neg'));
        preLedCapVoltages.set(comp.id, vP - vN);
      }
    }

    if (needResolve) {
      x = solve(G, b);
      if (!x) return results;
    }

    // === Step 7: Update 555 Timer flip-flop state ===
    // Use pre-LED-resolve voltages so the LED re-solve doesn't corrupt timer thresholds
    for (const info of timerInfos) {
      const saved = preLedVoltages.get(info.comp.id)!;
      const vcc = saved.vcc;
      const vTrig = saved.vTrig;
      const vThr = saved.vThr;

      let ff = this.state.timer555.get(info.comp.id)!;

      if (vcc > 0.1) {
        // Standard 555 comparator thresholds
        if (vTrig < vcc / 3) {
          ff = true; // SET
        }
        if (vThr > 2 * vcc / 3) {
          ff = false; // RESET
        }
      }


      this.state.timer555.set(info.comp.id, ff);

      const state = results.get(info.comp.id) ?? {};
      state.outputHigh = ff ? 1 : 0;
      results.set(info.comp.id, state);
    }

    // === Step 8: Extract results ===

    // Power sources: store current
    for (const comp of components) {
      if (comp.type === 'power') {
        const branchIdx = vsourceIndex.get(comp.id)!;
        const current = x[N + branchIdx];
        const state = results.get(comp.id) ?? {};
        state.current = current;
        state.voltage = Number(comp.properties.voltage ?? 5);
        results.set(comp.id, state);
      }
    }

    // Resistors: voltage and current
    for (const comp of components) {
      if (comp.type === 'resistor') {
        const vA = nodeVoltage(getNode(comp.id, 'a'));
        const vB = nodeVoltage(getNode(comp.id, 'b'));
        const R = Number(comp.properties.resistance ?? 220);
        const current = (vA - vB) / Math.max(R, 0.01);
        const state = results.get(comp.id) ?? {};
        state.voltage = Math.abs(vA - vB);
        state.current = current;
        results.set(comp.id, state);
      }
    }

    // Capacitors: update stored voltage (use pre-LED values for accuracy)
    for (const comp of components) {
      if (comp.type === 'capacitor') {
        const vCap = preLedCapVoltages.get(comp.id) ?? 0;
        const vPrevCap = this.state.capVoltages.get(comp.id) ?? 0;
        this.state.capVoltages.set(comp.id, vCap);

        const C = Number(comp.properties.capacitance ?? 100) * 1e-6;
        const vPrev = vPrevCap;
        const current = C * (vCap - vPrev) / dt;

        const state = results.get(comp.id) ?? {};
        state.voltage = vCap;
        state.current = current;
        results.set(comp.id, state);
      }
    }

    // LEDs: current and brightness
    for (const led of ledNodes) {
      const vAnode = nodeVoltage(led.nodeA);
      const vCathode = nodeVoltage(led.nodeC);
      const vf = Number(led.comp.properties.forwardVoltage ?? 2.0);
      const vAcross = vAnode - vCathode;

      let current = 0;
      if (vAcross > vf) {
        current = (vAcross - vf) / 50; // 50 ohm series model
      }

      // Brightness: 0-1, threshold at 2mA, full at 20mA
      const brightness = Math.max(0, Math.min(1, (current - 0.002) / 0.018));
      const isOn = current > 0.002;

      const state = results.get(led.comp.id) ?? {};
      state.on = isOn ? 1 : 0;
      state.brightness = brightness;
      state.current = current;
      state.voltage = vAcross;
      results.set(led.comp.id, state);
    }

    // Switches: just preserve closed state
    for (const comp of components) {
      if (comp.type === 'switch') {
        const state = results.get(comp.id) ?? {};
        state.closed = comp.state?.closed ?? 0;
        results.set(comp.id, state);
      }
    }

    // CD4026: update counter based on clock edge
    for (const comp of components) {
      if (comp.type === 'cd4026') {
        const counterState = this.state.cd4026.get(comp.id)!;
        const vClk = nodeVoltage(getNode(comp.id, 'clk'));
        const vRst = nodeVoltage(getNode(comp.id, 'rst'));
        const vInh = nodeVoltage(getNode(comp.id, 'inh'));
        const vVcc = nodeVoltage(getNode(comp.id, 'vcc'));

        const clkHigh = vClk > vVcc * 0.5;
        const rstHigh = vRst > vVcc * 0.5;
        const inhHigh = vInh > vVcc * 0.5;

        // Reset overrides everything
        if (rstHigh) {
          counterState.count = 0;
        }
        // Count on rising edge of CLK (if not inhibited)
        else if (clkHigh && !counterState.prevClk && !inhHigh) {
          counterState.count = (counterState.count + 1) % 10;
        }

        counterState.prevClk = clkHigh;

        const state = results.get(comp.id) ?? {};
        state.count = counterState.count;
        results.set(comp.id, state);
      }
    }

    // Potentiometers: voltage and current
    for (const comp of components) {
      if (comp.type === 'potentiometer') {
        const v1 = nodeVoltage(getNode(comp.id, 'pin1'));
        const vW = nodeVoltage(getNode(comp.id, 'wiper'));
        const v2 = nodeVoltage(getNode(comp.id, 'pin2'));
        const state = results.get(comp.id) ?? {};
        state.voltage = Math.abs(v1 - v2);
        state.wiperVoltage = vW;
        results.set(comp.id, state);
      }
    }

    // Multimeters: read voltage/current
    for (const comp of components) {
      if (comp.type === 'multimeter') {
        const vPos = nodeVoltage(getNode(comp.id, 'pos'));
        const vNeg = nodeVoltage(getNode(comp.id, 'neg'));
        const voltage = vPos - vNeg;
        const current = voltage / 10e6; // through internal 10M resistance
        const state = results.get(comp.id) ?? {};
        state.voltage = voltage;
        state.current = current;
        state.displayValue = comp.properties.mode === 'current'
          ? current
          : voltage;
        state.displayUnit = comp.properties.mode === 'current' ? 'A' : 'V';
        results.set(comp.id, state);
      }
    }

    // 7-segment display: check which segments have voltage
    for (const comp of components) {
      if (comp.type === 'display7seg') {
        const gndNode = getNode(comp.id, 'gnd');
        const gndV = nodeVoltage(gndNode);
        const state = results.get(comp.id) ?? {};
        // Each segment lights if its pin voltage is > 1.5V above GND
        for (const seg of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
          const segV = nodeVoltage(getNode(comp.id, seg));
          state[`seg_${seg}`] = (segV - gndV) > 1.5 ? 1 : 0;
        }
        results.set(comp.id, state);
      }
    }

    // Logic gates: update output state based on solved input voltages
    for (const comp of components) {
      const gateFn = GATE_FUNCTIONS[comp.type] as ((a: boolean, b: boolean) => boolean) | undefined;
      if (gateFn !== undefined) {
        const vVcc = nodeVoltage(getNode(comp.id, 'vcc'));
        const threshold = vVcc * 0.5;
        const outputs: Record<string, boolean> = {};
        for (const n of ['1', '2', '3', '4']) {
          const vA = nodeVoltage(getNode(comp.id, `${n}a`));
          const vB = nodeVoltage(getNode(comp.id, `${n}b`));
          outputs[`${n}y`] = gateFn(vA > threshold, vB > threshold);
        }
        this.state.gateOutputs.set(comp.id, outputs);
        const state = results.get(comp.id) ?? {};
        Object.assign(state, outputs);
        results.set(comp.id, state);
      }
      if (comp.type === 'gate_not') {
        const vVcc = nodeVoltage(getNode(comp.id, 'vcc'));
        const threshold = vVcc * 0.5;
        const outputs: Record<string, boolean> = {};
        for (const n of ['1', '2', '3', '4', '5', '6']) {
          const vA = nodeVoltage(getNode(comp.id, `${n}a`));
          outputs[`${n}y`] = !(vA > threshold);
        }
        this.state.gateOutputs.set(comp.id, outputs);
        const state = results.get(comp.id) ?? {};
        Object.assign(state, outputs);
        results.set(comp.id, state);
      }
    }

    // Op-amp: update output voltage
    for (const comp of components) {
      if (comp.type === 'opamp') {
        const vInPos = nodeVoltage(getNode(comp.id, 'in_pos'));
        const vInNeg = nodeVoltage(getNode(comp.id, 'in_neg'));
        const vSupplyPos = nodeVoltage(getNode(comp.id, 'v_pos'));
        const vSupplyNeg = nodeVoltage(getNode(comp.id, 'v_neg'));
        const gain = Number(comp.properties.gain ?? 100000);
        const diff = vInPos - vInNeg;
        // Output = clamped(gain * diff, V-, V+)
        const rawOut = gain * diff;
        const vOut = Math.max(vSupplyNeg + 0.5, Math.min(vSupplyPos - 0.5, rawOut));
        this.state.opampOut.set(comp.id, vOut);
        const state = results.get(comp.id) ?? {};
        state.voltage = vOut;
        state.inputDiff = diff;
        results.set(comp.id, state);
      }
    }

    // LED Matrix: build the per-tick lit-LED bitmap.
    //
    // The naive approach (sample voltages once at end-of-tick) only catches
    // whichever single row was active at the very end of the 100 ms tick, so
    // a multiplexed display only ever shows 1/7 of its pattern. Instead we
    // replay per-cycle pin activity across the whole tick and compute, for
    // every (col, row) pair, whether the col anode was HIGH while the row
    // cathode was LOW at any moment — the OR of those coincidences is the
    // image the firmware intended to display, with no aliasing.
    //
    // Column anodes can be driven two ways:
    //   - directly by an AVR output pin (e.g. necklace.ino)
    //   - by a 74HC595 Q output (e.g. matrix_demo.ino, test_led.ino), using
    //     the per-tick outputHistory recorded by the shift register pre-pass
    // Row cathodes are driven by AVR output pins in both cases.
    //
    // If a matrix has neither AVR nor shift-register drivers on any pin we
    // fall back to a voltage sample — that covers static/test circuits where
    // rails connect directly to the matrix without any active driver.
    const colBitOf: Record<string, number> = { qa: 0, qb: 1, qc: 2, qd: 3, qe: 4, qf: 5, qg: 6, qh: 7 };

    // Build [start, end) intervals across this tick where an AVR pin is at
    // the requested level (activeHigh=true for HIGH intervals, false for
    // LOW). A pin with no transitions this tick produces a single infinite
    // interval if its final state matches, else none.
    const avrPinIntervals = (drv: AvrDriver | undefined, activeHigh: boolean): [number, number][] => {
      if (!drv) return [];
      const trans: { cycle: number; high: boolean }[] = [];
      for (const t of drv.bridge.transitions) {
        if (t.pinId === drv.pinId) trans.push({ cycle: t.cycle, high: t.high });
      }
      const finalIsHigh = avrFinalPins.get(drv.avrId)?.get(drv.pinId) === 'high';
      // Level at the START of this tick: inverse of the first transition's
      // target (since a transition reports the NEW level), or the final
      // level if there were no transitions.
      const startHigh = trans.length > 0 ? !trans[0].high : finalIsHigh;
      let isActive = activeHigh ? startHigh : !startHigh;
      const intervals: [number, number][] = [];
      let start = 0;
      for (const t of trans) {
        const nowActive = activeHigh ? t.high : !t.high;
        if (isActive && !nowActive) {
          intervals.push([start, t.cycle]);
          isActive = false;
        } else if (!isActive && nowActive) {
          start = t.cycle;
          isActive = true;
        }
      }
      if (isActive) intervals.push([start, Number.POSITIVE_INFINITY]);
      return intervals;
    };

    const intervalsOverlap = (a: [number, number][], b: [number, number][]): boolean => {
      for (const [as, ae] of a) {
        for (const [bs, be] of b) {
          if (ae > bs && as < be) return true;
        }
      }
      return false;
    };

    for (const comp of components) {
      if (comp.type === 'ledmatrix') {
        const leds: boolean[] = new Array(35).fill(false);
        const state = results.get(comp.id) ?? {};

        // HIGH intervals for each column anode (5 cols).
        const colHigh: [number, number][][] = [];
        let anyColDriver = false;
        for (let c = 0; c < 5; c++) {
          const cNode = getNode(comp.id, `c${c + 1}`);
          // Shift-register-driven column?
          let srMatch: { srId: string; bit: number } | null = null;
          for (const sr of components) {
            if (sr.type !== 'shift_register') continue;
            for (const qPin of Object.keys(colBitOf)) {
              if (getNode(sr.id, qPin) === cNode) {
                srMatch = { srId: sr.id, bit: colBitOf[qPin] };
                break;
              }
            }
            if (srMatch) break;
          }
          if (srMatch) {
            anyColDriver = true;
            const sr = this.state.shiftReg.get(srMatch.srId);
            const ivs: [number, number][] = [];
            if (sr && sr.outputHistory && sr.outputHistory.length > 0) {
              for (let i = 0; i < sr.outputHistory.length; i++) {
                const seg = sr.outputHistory[i];
                if (((seg.output >> srMatch.bit) & 1) === 0) continue;
                const segEnd = i + 1 < sr.outputHistory.length
                  ? sr.outputHistory[i + 1].cycle
                  : Number.POSITIVE_INFINITY;
                ivs.push([seg.cycle, segEnd]);
              }
            }
            colHigh.push(ivs);
            continue;
          }
          // AVR-direct column?
          const drv = nodeToAvrDriver.get(cNode);
          if (drv) {
            anyColDriver = true;
            colHigh.push(avrPinIntervals(drv, true));
          } else {
            colHigh.push([]);
          }
        }

        // LOW intervals for each row cathode (7 rows).
        const rowLow: [number, number][][] = [];
        let anyRowDriver = false;
        for (let r = 0; r < 7; r++) {
          const rNode = getNode(comp.id, `r${r + 1}`);
          const drv = nodeToAvrDriver.get(rNode);
          if (drv) anyRowDriver = true;
          rowLow.push(avrPinIntervals(drv, false));
        }

        if (anyColDriver || anyRowDriver) {
          // Replay path: works for both multiplexed and static drives.
          for (let c = 0; c < 5; c++) {
            if (colHigh[c].length === 0) continue;
            for (let r = 0; r < 7; r++) {
              if (rowLow[r].length === 0) continue;
              if (intervalsOverlap(colHigh[c], rowLow[r])) {
                leds[c * 7 + r] = true;
              }
            }
          }
        } else {
          // Voltage-sample fallback: no AVR/SR drivers on this matrix, so
          // just take an end-of-tick snapshot (static test circuits).
          for (let c = 0; c < 5; c++) {
            const vCol = nodeVoltage(getNode(comp.id, `c${c + 1}`));
            for (let r = 0; r < 7; r++) {
              const vRow = nodeVoltage(getNode(comp.id, `r${r + 1}`));
              if ((vCol - vRow) > 1.5) leds[c * 7 + r] = true;
            }
          }
        }

        this.state.ledMatrix.set(comp.id, leds);
        for (let c = 0; c < 5; c++) {
          for (let r = 0; r < 7; r++) {
            state[`led_${c}_${r}`] = leds[c * 7 + r] ? 1 : 0;
          }
        }
        results.set(comp.id, state);
      }
    }

    // Function generator: store output voltage
    for (const comp of components) {
      if (comp.type === 'funcgen') {
        const vOut = nodeVoltage(getNode(comp.id, 'out'));
        const state = results.get(comp.id) ?? {};
        state.voltage = vOut;
        results.set(comp.id, state);
      }
    }

    // Voltage regulator: clamp output and report
    for (const comp of components) {
      if (comp.type === 'vreg') {
        const vIn = nodeVoltage(getNode(comp.id, 'vin'));
        const vOut = nodeVoltage(getNode(comp.id, 'vout'));
        const state = results.get(comp.id) ?? {};
        state.voltage = vOut;
        state.inputVoltage = vIn;
        results.set(comp.id, state);
      }
    }

    // 74HC595 Shift Register: update shift/latch on clock edges
    //
    // For inputs driven by an AVR, we replay the AVR's per-tick transition log
    // in cycle order so the shift register sees every edge that happened inside
    // the simulator tick — not just the final pin state. This is critical when
    // the AVR is bit-banging the shift register at microsecond timescales while
    // the outer simulator runs at 100ms ticks.
    for (const comp of components) {
      if (comp.type === 'shift_register') {
        // Skip components already processed in the pre-pass (those driven by
        // an AVR), to avoid double-updating their state.
        if (shiftRegHandledEarly.has(comp.id)) {
          const sr = this.state.shiftReg.get(comp.id)!;
          const state = results.get(comp.id) ?? {};
          state.shiftBits = sr.bits;
          state.outputBits = sr.output;
          results.set(comp.id, state);
          continue;
        }
        const sr = this.state.shiftReg.get(comp.id)!;
        const vVcc = nodeVoltage(getNode(comp.id, 'vcc'));
        const threshold = vVcc * 0.5;

        const srclkNode = getNode(comp.id, 'srclk');
        const rclkNode = getNode(comp.id, 'rclk');
        const serNode = getNode(comp.id, 'ser');
        const srclrNode = getNode(comp.id, 'srclr');
        const oeNode = getNode(comp.id, 'oe');

        // Final analog snapshot values (used as fallback when no AVR drives the node)
        const finalSrclk = nodeVoltage(srclkNode) > threshold;
        const finalRclk = nodeVoltage(rclkNode) > threshold;
        const finalSer = nodeVoltage(serNode) > threshold;
        const finalSrclr = nodeVoltage(srclrNode) > threshold; // active low
        const finalOe = nodeVoltage(oeNode) > threshold; // active low

        // For each control node, find the AVR pin that drives it (if any).
        const srclkDrv = nodeToAvrDriver.get(srclkNode);
        const rclkDrv = nodeToAvrDriver.get(rclkNode);
        const serDrv = nodeToAvrDriver.get(serNode);
        const srclrDrv = nodeToAvrDriver.get(srclrNode);

        // Build a merged, cycle-ordered event stream of relevant transitions
        // from every AVR that drives a control input on this shift register.
        type Evt = { cycle: number; which: 'srclk' | 'rclk' | 'ser' | 'srclr'; high: boolean };
        const events: Evt[] = [];
        const collect = (drv: AvrDriver | undefined, which: Evt['which']) => {
          if (!drv) return;
          for (const t of drv.bridge.transitions) {
            if (t.pinId === drv.pinId) events.push({ cycle: t.cycle, which, high: t.high });
          }
        };
        collect(srclkDrv, 'srclk');
        collect(rclkDrv, 'rclk');
        collect(serDrv, 'ser');
        collect(srclrDrv, 'srclr');
        events.sort((a, b) => a.cycle - b.cycle);

        // Running state — initialised from previous tick's level so the first
        // edge in the new tick is detected correctly. SER/SRCLR are not edge-
        // triggered, but we still track their current value so the SRCLK rising
        // edge samples the right SER and so SRCLR-low can clear at any cycle.
        let curSrclk = sr.prevSrclk;
        let curRclk = sr.prevRclk;
        let curSer = sr.prevSer;
        let curSrclr = sr.prevSrclr;
        // OE is rarely AVR-driven and isn't edge-sensitive — use the final value.
        const curOe = finalOe;

        // Helper to apply edge logic at the current state
        const applyEdge = (next: { srclk: boolean; rclk: boolean; ser: boolean; srclr: boolean }) => {
          // SRCLR is active low — clearing latches immediately whenever low
          if (!next.srclr) {
            sr.bits = 0;
          } else if (next.srclk && !curSrclk) {
            // Rising edge of SRCLK: shift in current SER bit (LSB-first per
            // 74HC595 datasheet — bit shifts into Q0/QA, others propagate up)
            sr.bits = ((sr.bits << 1) | (next.ser ? 1 : 0)) & 0xFF;
          }
          if (next.rclk && !curRclk) {
            sr.output = curOe ? 0 : sr.bits;
          }
          curSrclk = next.srclk;
          curRclk = next.rclk;
          curSer = next.ser;
          curSrclr = next.srclr;
        };

        // Replay every AVR-sourced transition in cycle order
        for (const ev of events) {
          const next = { srclk: curSrclk, rclk: curRclk, ser: curSer, srclr: curSrclr };
          next[ev.which] = ev.high;
          applyEdge(next);
        }

        // After replaying, settle on the final analog snapshot for any nodes
        // that aren't AVR-driven (so non-AVR shift register sources still work).
        const settled = {
          srclk: srclkDrv ? curSrclk : finalSrclk,
          rclk: rclkDrv ? curRclk : finalRclk,
          ser: serDrv ? curSer : finalSer,
          srclr: srclrDrv ? curSrclr : finalSrclr,
        };
        applyEdge(settled);

        // Persist final levels for next tick's edge detection
        sr.prevSrclk = settled.srclk;
        sr.prevRclk = settled.rclk;
        sr.prevSer = settled.ser;
        sr.prevSrclr = settled.srclr;

        const state = results.get(comp.id) ?? {};
        state.shiftBits = sr.bits;
        state.outputBits = sr.output;
        results.set(comp.id, state);
      }
    }

    // 74HC74 D Flip-Flop: update on clock edges
    //
    // As with the shift register, we replay AVR transitions on CLK/D/PRE/CLR
    // in cycle order so AVR-driven flip-flops see every edge inside the tick.
    for (const comp of components) {
      if (comp.type === 'flipflop_d') {
        if (flipflopHandledEarly.has(comp.id)) {
          const ff = this.state.flipflop.get(comp.id)!;
          const state = results.get(comp.id) ?? {};
          state['1q'] = ff.q1 ? 1 : 0;
          state['2q'] = ff.q2 ? 1 : 0;
          results.set(comp.id, state);
          continue;
        }
        const ff = this.state.flipflop.get(comp.id)!;
        const vVcc = nodeVoltage(getNode(comp.id, 'vcc'));
        const threshold = vVcc * 0.5;

        for (const n of ['1', '2'] as const) {
          const clkNode = getNode(comp.id, `${n}clk`);
          const dNode = getNode(comp.id, `${n}d`);
          const preNode = getNode(comp.id, `${n}pre`);
          const clrNode = getNode(comp.id, `${n}clr`);

          const finalClk = nodeVoltage(clkNode) > threshold;
          const finalD = nodeVoltage(dNode) > threshold;
          const finalPre = nodeVoltage(preNode) > threshold;
          const finalClr = nodeVoltage(clrNode) > threshold;

          const clkDrv = nodeToAvrDriver.get(clkNode);
          const dDrv = nodeToAvrDriver.get(dNode);
          const preDrv = nodeToAvrDriver.get(preNode);
          const clrDrv = nodeToAvrDriver.get(clrNode);

          type FfEvt = { cycle: number; which: 'clk' | 'd' | 'pre' | 'clr'; high: boolean };
          const events: FfEvt[] = [];
          const collect = (drv: AvrDriver | undefined, which: FfEvt['which']) => {
            if (!drv) return;
            for (const t of drv.bridge.transitions) {
              if (t.pinId === drv.pinId) events.push({ cycle: t.cycle, which, high: t.high });
            }
          };
          collect(clkDrv, 'clk');
          collect(dDrv, 'd');
          collect(preDrv, 'pre');
          collect(clrDrv, 'clr');
          events.sort((a, b) => a.cycle - b.cycle);

          let curClk = n === '1' ? ff.prevClk1 : ff.prevClk2;
          // D/PRE/CLR aren't tracked across ticks today; seed from final analog
          // value (good enough — D and async controls are level-sensitive only).
          let curD = finalD;
          let curPre = finalPre;
          let curClr = finalClr;
          let q = n === '1' ? ff.q1 : ff.q2;

          const step = (next: { clk: boolean; d: boolean; pre: boolean; clr: boolean }) => {
            if (!next.clr) {
              q = false;
            } else if (!next.pre) {
              q = true;
            } else if (next.clk && !curClk) {
              q = next.d;
            }
            curClk = next.clk;
            curD = next.d;
            curPre = next.pre;
            curClr = next.clr;
          };

          for (const ev of events) {
            const next = { clk: curClk, d: curD, pre: curPre, clr: curClr };
            next[ev.which] = ev.high;
            step(next);
          }

          // Settle on final analog snapshot for non-AVR-driven nodes
          step({
            clk: clkDrv ? curClk : finalClk,
            d: dDrv ? curD : finalD,
            pre: preDrv ? curPre : finalPre,
            clr: clrDrv ? curClr : finalClr,
          });

          if (n === '1') { ff.q1 = q; ff.prevClk1 = curClk; }
          else { ff.q2 = q; ff.prevClk2 = curClk; }
        }

        const state = results.get(comp.id) ?? {};
        state['1q'] = ff.q1 ? 1 : 0;
        state['2q'] = ff.q2 ? 1 : 0;
        results.set(comp.id, state);
      }
    }

    // ATmega328: feed solved voltages back into AVR input pins and expose state
    for (const comp of components) {
      if (comp.type === 'atmega328') {
        const bridge = this.state.avrBridges.get(comp.id);
        if (!bridge?.isLoaded()) continue;

        const vcc = nodeVoltage(getNode(comp.id, 'vcc'));
        const state = results.get(comp.id) ?? {};
        state.programLoaded = 1;

        // Feed external voltages into digital input pins
        for (const pinId of avrGpioPins) {
          const pinState = bridge.pinStates.get(pinId);
          if (pinState === 'input' || pinState === 'input_pullup') {
            const v = nodeVoltage(getNode(comp.id, pinId));
            bridge.setExternalPin(pinId, v, vcc);
          }
          // Store pin states for display
          const ps = bridge.pinStates.get(pinId);
          state[`pin_${pinId}`] = ps === 'high' ? 1 : ps === 'low' ? 0 : ps === 'input_pullup' ? 'pullup' : 'z';
        }

        // Feed analog voltages into ADC channels (A0-A5 = pc0-pc5)
        const vRef = nodeVoltage(getNode(comp.id, 'avcc'));
        for (let ch = 0; ch < 6; ch++) {
          const pinId = `pc${ch}`;
          const v = nodeVoltage(getNode(comp.id, pinId));
          bridge.setAnalogInput(ch, v, vRef > 0.1 ? vRef : vcc);
        }

        // Expose serial output
        state.serialOutput = bridge.serialOutput.join('');
        state.serialLength = bridge.serialOutput.length;

        results.set(comp.id, state);
      }
    }

    // === Step 9: Wire current directions ===
    this.wireCurrents.clear();
    for (const wire of wires) {
      let vFrom = 0, vTo = 0;
      // Get voltage at each endpoint
      if (wire.from.componentId === 'board') {
        const [c, r] = wire.from.pinId.split(',').map(Number);
        const groupId = boardPinLookup.get(`${c},${r}`);
        // Find any pin in this group that has a node
        if (groupId) {
          const root = find(pinKey('board', wire.from.pinId));
          if (rootToNode.has(root)) vFrom = nodeVoltage(rootToNode.get(root)!);
        }
      } else {
        const node = getNode(wire.from.componentId, wire.from.pinId);
        vFrom = nodeVoltage(node);
      }
      if (wire.to.componentId === 'board') {
        const [c, r] = wire.to.pinId.split(',').map(Number);
        const groupId = boardPinLookup.get(`${c},${r}`);
        if (groupId) {
          const root = find(pinKey('board', wire.to.pinId));
          if (rootToNode.has(root)) vTo = nodeVoltage(rootToNode.get(root)!);
        }
      } else {
        const node = getNode(wire.to.componentId, wire.to.pinId);
        vTo = nodeVoltage(node);
      }
      this.wireCurrents.set(wire.id, vFrom - vTo);
    }

    // === Step 10: Pin hole voltages for strip highlighting ===
    this.pinHoleVoltages.clear();
    // For each breadboard pin group, find if any member has a known node and get its voltage
    for (const group of boardPinGroups) {
      let groupVoltage: number | null = null;
      for (const pin of group.pins) {
        const pk = pinKey('board', `${pin.col},${pin.row}`);
        const root = find(pk);
        if (rootToNode.has(root)) {
          groupVoltage = nodeVoltage(rootToNode.get(root)!);
          break;
        }
      }
      // Also check component pins sitting on these holes
      if (groupVoltage === null) {
        for (const comp of components) {
          if (comp.type === 'power') continue;
          const def = COMPONENT_DEFINITIONS[comp.type];
          if (!def) continue;
          for (const cpin of def.pins) {
            const pos = getComponentPinPixel(comp, cpin.id);
            if (!pos) continue;
            const grid = pixelToBoardGrid(pos.x, pos.y);
            const holeKey = `${grid.col},${grid.row}`;
            const groupId = boardPinLookup.get(holeKey);
            if (groupId === group.id) {
              const cpk = pinKey(comp.id, cpin.id);
              const root = find(cpk);
              if (rootToNode.has(root)) {
                groupVoltage = nodeVoltage(rootToNode.get(root)!);
                break;
              }
            }
          }
          if (groupVoltage !== null) break;
        }
      }
      if (groupVoltage !== null && Math.abs(groupVoltage) > 0.01) {
        for (const pin of group.pins) {
          this.pinHoleVoltages.set(`${pin.col},${pin.row}`, groupVoltage);
        }
      }
    }

    return results;
  }
}
