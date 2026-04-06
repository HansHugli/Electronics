import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';
import {
  createMNA, stampConductance, stampCurrentSource, stampVoltageSource, solve,
} from './mna';

/**
 * Analog circuit simulator using Modified Nodal Analysis.
 *
 * Supports: resistors (Ohm's law), voltage sources, capacitors (transient),
 * LEDs (piecewise linear diode), switches, and 555 Timer (behavioral).
 *
 * Persistent state is held between ticks for capacitors and 555 timers.
 */

interface PersistentState {
  capVoltages: Map<string, number>;       // componentId -> voltage across cap
  timer555: Map<string, boolean>;          // componentId -> flip-flop state (true = output high)
}

export class CircuitSimulator {
  private state: PersistentState = {
    capVoltages: new Map(),
    timer555: new Map(),
  };

  reset(): void {
    this.state.capVoltages.clear();
    this.state.timer555.clear();
  }

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

    return results;
  }
}
