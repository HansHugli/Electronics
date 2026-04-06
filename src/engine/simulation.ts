import { PlacedComponent, Wire } from '../types';

// Re-export the simulator for backward compat
export { CircuitSimulator } from './CircuitSimulator';

/**
 * Creates the LED blink demo circuit using a real 555 astable configuration.
 *
 * Circuit:
 *   VCC ──Ra──┬──Rb──┬── THR/TRIG (555)
 *             │      │
 *            DIS    C1
 *             │      │
 *            (555)  GND
 *
 *   OUT (555) ──R_led── LED ── GND
 *   RST (555) ── VCC (keep enabled)
 *
 * With Ra=10kΩ, Rb=68kΩ, C1=10μF:
 *   Period ≈ 0.693 × (Ra + 2×Rb) × C ≈ 1.01 seconds (~1Hz blink)
 *
 * Breadboard layout (Board 0):
 *   Pin hole center at (col, row): x = 96 + col*24 + 12, y = row*17 + 8.5
 *   Left comp: cols 2-6, Gap: col 7, Right comp: cols 8-12
 *
 *   555 Timer: straddles gap, left pins col 6, right pins col 8, rows 5-8
 *     Left:  RST(row5) OUT(row6) TRIG(row7) GND(row8)
 *     Right: VCC(row5) DIS(row6) THR(row7)  CTRL(row8)
 *
 *   Ra (10k): col 10, rows 5-7  (VCC row → DIS row, via right comp area)
 *   Rb (68k): col 10, rows 7-9  (DIS row → THR/TRIG node)
 *   C1 (10μF): col 4, rows 7-9  (THR/TRIG node → GND)
 *   R_led (220): col 4, rows 5-7 (OUT row → LED)
 *   LED: col 4, row 3            (above R_led → GND)
 */
export function createBlinkDemoCircuit(): { components: PlacedComponent[]; wires: Wire[] } {
  // Helper: compute component position from target pin hole
  // For vertical components (top pin at offset 0.5): pinOffX=12, pinOffY=0
  // position = (holeX - 12, holeY)
  function vPos(col: number, row: number): { x: number; y: number } {
    return { x: 96 + col * 24, y: row * 17 + 8.5 };
  }
  // For 555 timer (first pin gnd, left side, offset 0.875): pinOffX=0, pinOffY=59.5
  // position = (holeX, holeY - 59.5)  where holeY is GND pin row
  function timerPos(col: number, gndRow: number): { x: number; y: number } {
    return { x: 96 + col * 24 + 12, y: gndRow * 17 + 8.5 - 59.5 };
  }

  const components: PlacedComponent[] = [
    // Power supply (in supply area)
    {
      id: 'power1',
      type: 'power',
      position: { x: 0, y: 85 },
      rotation: 0,
      properties: { voltage: 5, mode: 'DC', waveform: 'square' },
      state: {},
    },
    // 555 Timer: left pins col 6, right pins col 8, rows 5-8
    {
      id: 'timer1',
      type: 'timer',
      position: timerPos(6, 8),
      rotation: 0,
      properties: {},
      state: { outputHigh: 0 },
    },
    // Ra (10kΩ): VCC rail to DIS — col 10, rows 5 to 7
    {
      id: 'ra',
      type: 'resistor',
      position: vPos(10, 5),
      rotation: 0,
      properties: { resistance: 10000 },
      state: {},
    },
    // Rb (68kΩ): DIS to THR/TRIG node — col 10, rows 7 to 9
    {
      id: 'rb',
      type: 'resistor',
      position: vPos(10, 7),
      rotation: 0,
      properties: { resistance: 68000 },
      state: {},
    },
    // C1 (10μF): THR/TRIG node to GND — col 4, rows 7 to 8
    {
      id: 'c1',
      type: 'capacitor',
      position: vPos(4, 7),
      rotation: 0,
      properties: { capacitance: 10 },
      state: {},
    },
    // R_led (220Ω): OUT to LED — col 4, rows 5 to 7
    {
      id: 'rled',
      type: 'resistor',
      position: vPos(4, 5),
      rotation: 0,
      properties: { resistance: 220 },
      state: {},
    },
    // LED: col 4, row 3
    {
      id: 'led1',
      type: 'led',
      position: vPos(4, 3),
      rotation: 0,
      properties: { forwardVoltage: 2.0, color: 'red' },
      state: { on: 0 },
    },
  ];

  const wires: Wire[] = [
    // === Power connections ===
    // Power + → 555 VCC (col 8, row 5)
    { id: 'w1', from: { componentId: 'power1', pinId: 'pos' }, to: { componentId: 'timer1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    // Power - → 555 GND (col 6, row 8)
    { id: 'w2', from: { componentId: 'power1', pinId: 'neg' }, to: { componentId: 'timer1', pinId: 'gnd' }, waypoints: [], color: '#1e1e1e' },
    // RST → VCC (keep 555 enabled)
    { id: 'w3', from: { componentId: 'timer1', pinId: 'reset' }, to: { componentId: 'timer1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },

    // === Timing RC network ===
    // VCC → Ra top (col 10, row 5): wire from 555 VCC to Ra pin A
    { id: 'w4', from: { componentId: 'timer1', pinId: 'vcc' }, to: { componentId: 'ra', pinId: 'a' }, waypoints: [], color: '#ef4444' },
    // Ra bottom (col 10, row 7) → 555 DIS (col 8, row 6)
    { id: 'w5', from: { componentId: 'ra', pinId: 'b' }, to: { componentId: 'timer1', pinId: 'dis' }, waypoints: [], color: '#fbbf24' },
    // Ra bottom → Rb top (same col, row 7 — they share this node)
    { id: 'w6', from: { componentId: 'ra', pinId: 'b' }, to: { componentId: 'rb', pinId: 'a' }, waypoints: [], color: '#fbbf24' },
    // Rb bottom (col 10, row 9) → 555 THR (col 8, row 7)
    { id: 'w7', from: { componentId: 'rb', pinId: 'b' }, to: { componentId: 'timer1', pinId: 'thr' }, waypoints: [], color: '#4ade80' },
    // THR → TRIG (tied together): 555 THR (col 8, row 7) → 555 TRIG (col 6, row 7)
    { id: 'w8', from: { componentId: 'timer1', pinId: 'thr' }, to: { componentId: 'timer1', pinId: 'trig' }, waypoints: [], color: '#4ade80' },
    // Rb bottom → C1 top (col 10 row 9 → col 4 row 7): capacitor charges from this node
    { id: 'w9', from: { componentId: 'rb', pinId: 'b' }, to: { componentId: 'c1', pinId: 'pos' }, waypoints: [], color: '#4ade80' },
    // C1 bottom → GND
    { id: 'w10', from: { componentId: 'c1', pinId: 'neg' }, to: { componentId: 'power1', pinId: 'neg' }, waypoints: [], color: '#1e1e1e' },

    // === Output to LED ===
    // 555 OUT (col 6, row 6) → R_led top (col 4, row 5)
    { id: 'w11', from: { componentId: 'timer1', pinId: 'out' }, to: { componentId: 'rled', pinId: 'a' }, waypoints: [], color: '#fbbf24' },
    // R_led bottom (col 4, row 7) → LED anode (col 4, row 3... wait, LED is above)
    // Actually LED anode is at row 3 (top pin), R_led bottom is at row 7. Let's wire them:
    { id: 'w12', from: { componentId: 'rled', pinId: 'b' }, to: { componentId: 'led1', pinId: 'anode' }, waypoints: [], color: '#fbbf24' },
    // LED cathode → GND
    { id: 'w13', from: { componentId: 'led1', pinId: 'cathode' }, to: { componentId: 'power1', pinId: 'neg' }, waypoints: [], color: '#1e1e1e' },
  ];

  return { components, wires };
}
