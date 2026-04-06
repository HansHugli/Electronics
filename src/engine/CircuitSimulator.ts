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
  avrBridges: Map<string, AVRBridge>;     // componentId -> AVR bridge instance
}

export class CircuitSimulator {
  private state: PersistentState = {
    capVoltages: new Map(),
    timer555: new Map(),
    cd4026: new Map(),
    gateOutputs: new Map(),
    opampOut: new Map(),
    ledMatrix: new Map(),
    avrBridges: new Map(),
  };

  reset(): void {
    this.state.capVoltages.clear();
    this.state.timer555.clear();
    this.state.cd4026.clear();
    this.state.gateOutputs.clear();
    this.state.opampOut.clear();
    this.state.ledMatrix.clear();
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
    for (const wire of wires) {
      for (const endpoint of [wire.from, wire.to]) {
        if (endpoint.componentId === 'board') {
          const [colStr, rowStr] = endpoint.pinId.split(',');
          const col = parseInt(colStr, 10);
          const row = parseInt(rowStr, 10);
          const groupId = boardPinLookup.get(`${col},${row}`);
          if (!groupId) continue;
          const pk = pinKey(endpoint.componentId, endpoint.pinId);
          if (!groupToPins.has(groupId)) groupToPins.set(groupId, []);
          groupToPins.get(groupId)!.push(pk);
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

    // --- ATmega328: run AVR CPU and stamp output pins ---
    const avrGpioPins = [
      'pd0','pd1','pd2','pd3','pd4','pd5','pd6','pd7',
      'pb0','pb1','pb2','pb3','pb4','pb5',
      'pc0','pc1','pc2','pc3','pc4','pc5',
    ];
    for (const comp of components) {
      if (comp.type === 'atmega328') {
        const bridge = this.state.avrBridges.get(comp.id);
        if (!bridge?.isLoaded()) {
          // No program loaded — all GPIO pins are high-impedance
          for (const pinId of avrGpioPins) {
            const node = getNode(comp.id, pinId);
            stampConductance(G, node, 0, 1e-9);
          }
          continue;
        }

        // Run AVR CPU for this tick
        const avrResult = bridge.tick(dt);

        // Get VCC node for this chip
        const nodeVcc = getNode(comp.id, 'vcc');

        // Stamp each GPIO pin based on AVR output state
        for (const pinId of avrGpioPins) {
          const node = getNode(comp.id, pinId);
          const pinState = avrResult.pins.get(pinId);

          if (pinState === 'high') {
            // Output HIGH: low impedance to VCC
            stampConductance(G, node, nodeVcc, 1 / 40); // ~40 ohm output impedance
          } else if (pinState === 'low') {
            // Output LOW: low impedance to GND
            stampConductance(G, node, 0, 1 / 40);
          } else if (pinState === 'input_pullup') {
            // Input with pull-up: ~20k to VCC
            stampConductance(G, node, nodeVcc, 1 / 20000);
          } else {
            // Input (high impedance)
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

    if (needResolve) {
      x = solve(G, b);
      if (!x) return results;
    }

    // === Step 7: Update 555 Timer flip-flop state ===
    for (const info of timerInfos) {
      const vcc = nodeVoltage(info.nodeVcc);
      const vTrig = nodeVoltage(info.nodeTrig);
      const vThr = nodeVoltage(info.nodeThr);

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

    // Capacitors: update stored voltage
    for (const comp of components) {
      if (comp.type === 'capacitor') {
        const vPos = nodeVoltage(getNode(comp.id, 'pos'));
        const vNeg = nodeVoltage(getNode(comp.id, 'neg'));
        const vCap = vPos - vNeg;
        this.state.capVoltages.set(comp.id, vCap);

        const C = Number(comp.properties.capacitance ?? 100) * 1e-6;
        const vPrev = this.state.capVoltages.get(comp.id) ?? 0;
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

    // LED Matrix: check which LEDs are lit
    for (const comp of components) {
      if (comp.type === 'ledmatrix') {
        const leds: boolean[] = new Array(35).fill(false);
        const state = results.get(comp.id) ?? {};
        for (let c = 0; c < 5; c++) {
          const vCol = nodeVoltage(getNode(comp.id, `c${c + 1}`));
          for (let r = 0; r < 7; r++) {
            const vRow = nodeVoltage(getNode(comp.id, `r${r + 1}`));
            const vAcross = vCol - vRow;
            const isOn = vAcross > 1.5; // forward voltage threshold
            leds[c * 7 + r] = isOn;
            state[`led_${c}_${r}`] = isOn ? 1 : 0;
          }
        }
        this.state.ledMatrix.set(comp.id, leds);
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

        // Feed external voltages into input pins
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
