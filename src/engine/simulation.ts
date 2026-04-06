import { PlacedComponent, Wire } from '../types';

// Re-export the simulator for backward compat
export { CircuitSimulator } from './CircuitSimulator';

/**
 * Creates the LED blink demo circuit using a real 555 astable configuration
 * with breadboard internal wiring.
 *
 * 555 Astable circuit:
 *   VCC ──Ra──┬──Rb──┬── THR/TRIG
 *             │      │
 *            DIS    C1
 *             │      │
 *            (555)  GND
 *
 *   OUT ──R_led── LED ── GND
 *   RST ── VCC
 *
 * Breadboard layout (Board 0):
 *   Left comp: cols 2-6, Gap: col 7, Right comp: cols 8-12
 *   Pins in the same row and same half (left or right) share a strip.
 *
 *   555 Timer: straddles gap, left pins col 6, right pins col 8
 *     Left:  RST(row5) OUT(row6) TRIG(row7) GND(row8)
 *     Right: VCC(row5) DIS(row6) THR(row7)  CTRL(row8)
 *
 *   Ra (10k):   col 10, rows 5-7  — pin A at row 5 (same strip as VCC=col8,row5)
 *   Rb (68k):   col 10, rows 7-9  — pin A at row 7 (same strip as Ra B, THR=col8,row7)
 *   C1 (10μF):  col 4, rows 7-8   — pin + at row 7 (same strip as TRIG=col6,row7)
 *   R_led(220): col 4, rows 10-12 — pin A at row 10 (separate from C1)
 *   LED:        col 4, row 13     — separate row
 *
 * Strips that auto-connect (no wire needed):
 *   Right row 5: VCC(col8) ↔ Ra A(col10)       — power to timing resistor
 *   Right row 7: Ra B(col10) ↔ Rb A(col10) ↔ THR(col8) — DIS/timing junction
 *   Left row 7:  TRIG(col6) ↔ C1+(col4)        — trigger tied to capacitor
 *
 * Wires still needed:
 *   Power+ → board right rail or VCC pin
 *   Power- → board GND
 *   Ra B → DIS (row 7 to row 6 — different rows on right side)
 *   THR → TRIG (right row 7 to left row 7 — across gap)
 *   Rb B → C1+ or TRIG node (row 9 to row 7 — need jumper)
 *   OUT → R_led A (left row 6 to left row 10)
 *   R_led B → LED anode (left row 12 to row 13 — same strip if adjacent)
 *   LED cathode → GND
 *   RST → VCC (across gap, row 5)
 *   C1- → GND
 */
export function createBlinkDemoCircuit(): { components: PlacedComponent[]; wires: Wire[] } {
  // Helper: position for vertical 1-wide component (pin A = top, offset 0.5)
  // pinOffX = 12, pinOffY = 0. Position = (holeX - 12, holeY)
  function vPos(col: number, row: number): { x: number; y: number } {
    return { x: 96 + col * 24, y: row * 17 + 8.5 };
  }
  // 555 timer position from GND pin (left, offset 0.875 → pinOff = (0, 59.5))
  function timerPos(col: number, gndRow: number): { x: number; y: number } {
    return { x: 96 + col * 24 + 12, y: gndRow * 17 + 8.5 - 59.5 };
  }

  const components: PlacedComponent[] = [
    // Power supply (off-board, in supply area)
    {
      id: 'power1', type: 'power',
      position: { x: 0, y: 85 }, rotation: 0,
      properties: { voltage: 5, mode: 'DC', waveform: 'square' },
      state: {},
    },
    // 555 Timer: left pins col 6, right pins col 8, rows 5-8
    {
      id: 'timer1', type: 'timer',
      position: timerPos(6, 8), rotation: 0,
      properties: {},
      state: { outputHigh: 0 },
    },
    // Ra (10kΩ): col 10, rows 5-7
    // Strip auto-connects pin A (row 5) to VCC (col 8, row 5)
    {
      id: 'ra', type: 'resistor',
      position: vPos(10, 5), rotation: 0,
      properties: { resistance: 10000 },
      state: {},
    },
    // Rb (68kΩ): col 10, rows 7-9
    // Strip auto-connects pin A (row 7) to Ra B (col 10, row 7) and THR (col 8, row 7)
    {
      id: 'rb', type: 'resistor',
      position: vPos(10, 7), rotation: 0,
      properties: { resistance: 68000 },
      state: {},
    },
    // C1 (10μF): col 4, rows 7-8
    // Strip auto-connects pin + (row 7) to TRIG (col 6, row 7)
    {
      id: 'c1', type: 'capacitor',
      position: vPos(4, 7), rotation: 0,
      properties: { capacitance: 47 },
      state: {},
    },
    // R_led (220Ω): col 4, rows 10-12
    {
      id: 'rled', type: 'resistor',
      position: vPos(4, 10), rotation: 0,
      properties: { resistance: 220 },
      state: {},
    },
    // LED: col 4, row 13
    {
      id: 'led1', type: 'led',
      position: vPos(4, 13), rotation: 0,
      properties: { forwardVoltage: 2.0, color: 'red' },
      state: { on: 0 },
    },
  ];

  const wires: Wire[] = [
    // Power + → 555 VCC
    { id: 'w1', from: { componentId: 'power1', pinId: 'pos' }, to: { componentId: 'timer1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    // Power - → 555 GND
    { id: 'w2', from: { componentId: 'power1', pinId: 'neg' }, to: { componentId: 'timer1', pinId: 'gnd' }, waypoints: [], color: '#1e1e1e' },
    // RST → VCC (across gap, both row 5)
    { id: 'w3', from: { componentId: 'timer1', pinId: 'reset' }, to: { componentId: 'timer1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    // Ra B / Rb A node → DIS (right row 7 → right row 6, different rows — need wire)
    { id: 'w5', from: { componentId: 'ra', pinId: 'b' }, to: { componentId: 'timer1', pinId: 'dis' }, waypoints: [], color: '#fbbf24' },
    // THR → TRIG (right row 7 → left row 7, across gap — need wire)
    { id: 'w8', from: { componentId: 'timer1', pinId: 'thr' }, to: { componentId: 'timer1', pinId: 'trig' }, waypoints: [], color: '#4ade80' },
    // Rb B (row 9) → THR node (row 7) — jumper wire
    { id: 'w7', from: { componentId: 'rb', pinId: 'b' }, to: { componentId: 'timer1', pinId: 'thr' }, waypoints: [], color: '#4ade80' },
    // C1 neg → GND
    { id: 'w10', from: { componentId: 'c1', pinId: 'neg' }, to: { componentId: 'power1', pinId: 'neg' }, waypoints: [], color: '#1e1e1e' },
    // OUT → R_led A (left row 6 → left row 10 — different rows, need wire)
    { id: 'w11', from: { componentId: 'timer1', pinId: 'out' }, to: { componentId: 'rled', pinId: 'a' }, waypoints: [], color: '#fbbf24' },
    // R_led B (row 12) → LED anode (row 13) — need wire (different rows)
    { id: 'w12', from: { componentId: 'rled', pinId: 'b' }, to: { componentId: 'led1', pinId: 'anode' }, waypoints: [], color: '#fbbf24' },
    // LED cathode → GND
    { id: 'w13', from: { componentId: 'led1', pinId: 'cathode' }, to: { componentId: 'power1', pinId: 'neg' }, waypoints: [], color: '#1e1e1e' },
  ];

  return { components, wires };
}

/**
 * Creates a 7-segment counter demo circuit:
 * 555 astable → CD4026 counter → 7-segment display
 *
 * The 555 generates a ~1Hz clock signal.
 * Each pulse increments the CD4026 which drives the display 0-9.
 *
 * Layout on Board 1 (cols 16-30):
 *   555 Timer: cols 22-24, rows 5-8 (same astable config)
 *   CD4026: cols 22-24, rows 14-21 (8 tall)
 *   7-Seg: cols 22-24, rows 25-29 (5 tall)
 *   Timing components on right comp area of board 1
 */
export function createCounterDemoCircuit(): { components: PlacedComponent[]; wires: Wire[] } {
  // Board 1 starts at col 16. Left comp: 18-22, gap: 23, right comp: 24-28
  function vPos(col: number, row: number): { x: number; y: number } {
    return { x: 96 + col * 24, y: row * 17 + 8.5 };
  }
  function chipPos(col: number, lastRow: number, height: number): { x: number; y: number } {
    // First pin is bottom-left at offset (height-1)/height from top
    // For left-side pin at max offset, pinOffY = h * maxOffset
    const h = height * 17;
    const maxOffset = (height * 2 - 1) / (height * 2); // e.g. 15/16 for 8-tall
    return { x: 96 + col * 24 + 12, y: lastRow * 17 + 8.5 - h * maxOffset };
  }

  const components: PlacedComponent[] = [
    // Power supply
    {
      id: 'power1', type: 'power',
      position: { x: 0, y: 85 }, rotation: 0,
      properties: { voltage: 5, mode: 'DC', waveform: 'square' },
      state: {},
    },
    // 555 Timer: board 0, cols 6-8, rows 5-8
    {
      id: 'timer1', type: 'timer',
      position: { x: 96 + 6 * 24 + 12, y: 8 * 17 + 8.5 - 4 * 17 * 7/8 },
      rotation: 0, properties: {}, state: { outputHigh: 0 },
    },
    // Ra (10kΩ): col 10, rows 5-7
    {
      id: 'ra', type: 'resistor',
      position: vPos(10, 5), rotation: 0,
      properties: { resistance: 10000 }, state: {},
    },
    // Rb (68kΩ): col 10, rows 7-9
    {
      id: 'rb', type: 'resistor',
      position: vPos(10, 7), rotation: 0,
      properties: { resistance: 68000 }, state: {},
    },
    // C1 (10μF): col 4, rows 7-8
    {
      id: 'c1', type: 'capacitor',
      position: vPos(4, 7), rotation: 0,
      properties: { capacitance: 47 }, state: {},
    },
    // CD4026: board 1, cols 22-24, rows 14-21
    {
      id: 'counter1', type: 'cd4026',
      position: chipPos(22, 21, 8),
      rotation: 0, properties: {}, state: { count: 0 },
    },
    // 7-Seg display: board 1, cols 22-24, rows 25-29
    {
      id: 'display1', type: 'display7seg',
      position: chipPos(22, 29, 5),
      rotation: 0, properties: {}, state: {},
    },
  ];

  const wires: Wire[] = [
    // === 555 Timer power & timing (same as blink demo) ===
    { id: 'w1', from: { componentId: 'power1', pinId: 'pos' }, to: { componentId: 'timer1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    { id: 'w2', from: { componentId: 'power1', pinId: 'neg' }, to: { componentId: 'timer1', pinId: 'gnd' }, waypoints: [], color: '#1e1e1e' },
    { id: 'w3', from: { componentId: 'timer1', pinId: 'reset' }, to: { componentId: 'timer1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    { id: 'w5', from: { componentId: 'ra', pinId: 'b' }, to: { componentId: 'timer1', pinId: 'dis' }, waypoints: [], color: '#fbbf24' },
    { id: 'w8', from: { componentId: 'timer1', pinId: 'thr' }, to: { componentId: 'timer1', pinId: 'trig' }, waypoints: [], color: '#4ade80' },
    { id: 'w7', from: { componentId: 'rb', pinId: 'b' }, to: { componentId: 'timer1', pinId: 'thr' }, waypoints: [], color: '#4ade80' },
    { id: 'w10', from: { componentId: 'c1', pinId: 'neg' }, to: { componentId: 'power1', pinId: 'neg' }, waypoints: [], color: '#1e1e1e' },

    // === CD4026 power ===
    { id: 'w20', from: { componentId: 'power1', pinId: 'pos' }, to: { componentId: 'counter1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    { id: 'w21', from: { componentId: 'power1', pinId: 'neg' }, to: { componentId: 'counter1', pinId: 'gnd' }, waypoints: [], color: '#1e1e1e' },
    // RST → GND (not resetting)
    { id: 'w22', from: { componentId: 'counter1', pinId: 'rst' }, to: { componentId: 'power1', pinId: 'neg' }, waypoints: [], color: '#1e1e1e' },
    // INH → GND (not inhibited)
    { id: 'w23', from: { componentId: 'counter1', pinId: 'inh' }, to: { componentId: 'power1', pinId: 'neg' }, waypoints: [], color: '#1e1e1e' },
    // EN → VCC (display enabled)
    { id: 'w24', from: { componentId: 'counter1', pinId: 'en' }, to: { componentId: 'power1', pinId: 'pos' }, waypoints: [], color: '#ef4444' },

    // === 555 OUT → CD4026 CLK ===
    { id: 'w30', from: { componentId: 'timer1', pinId: 'out' }, to: { componentId: 'counter1', pinId: 'clk' }, waypoints: [], color: '#fbbf24' },

    // === CD4026 segment outputs → 7-Seg display inputs ===
    { id: 'w40', from: { componentId: 'counter1', pinId: 'out_a' }, to: { componentId: 'display1', pinId: 'a' }, waypoints: [], color: '#fb923c' },
    { id: 'w41', from: { componentId: 'counter1', pinId: 'out_b' }, to: { componentId: 'display1', pinId: 'b' }, waypoints: [], color: '#fb923c' },
    { id: 'w42', from: { componentId: 'counter1', pinId: 'out_c' }, to: { componentId: 'display1', pinId: 'c' }, waypoints: [], color: '#fb923c' },
    { id: 'w43', from: { componentId: 'counter1', pinId: 'out_d' }, to: { componentId: 'display1', pinId: 'd' }, waypoints: [], color: '#fb923c' },
    { id: 'w44', from: { componentId: 'counter1', pinId: 'out_e' }, to: { componentId: 'display1', pinId: 'e' }, waypoints: [], color: '#fb923c' },
    { id: 'w45', from: { componentId: 'counter1', pinId: 'out_f' }, to: { componentId: 'display1', pinId: 'f' }, waypoints: [], color: '#fb923c' },
    { id: 'w46', from: { componentId: 'counter1', pinId: 'out_g' }, to: { componentId: 'display1', pinId: 'g' }, waypoints: [], color: '#fb923c' },

    // === 7-Seg power ===
    { id: 'w50', from: { componentId: 'power1', pinId: 'pos' }, to: { componentId: 'display1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    { id: 'w51', from: { componentId: 'power1', pinId: 'neg' }, to: { componentId: 'display1', pinId: 'gnd' }, waypoints: [], color: '#1e1e1e' },
  ];

  return { components, wires };
}
