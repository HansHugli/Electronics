import { PlacedComponent, Wire } from '../types';

// Re-export the simulator for backward compat
export { CircuitSimulator } from './CircuitSimulator';

/** Board pin hole shorthand */
const bh = (col: number, row: number) => ({ componentId: 'board', pinId: `${col},${row}` });

/**
 * Create rail jumper wires linking adjacent 5-row rail groups.
 * On a real breadboard, users run a wire along the entire rail.
 * This connects groups 0-1, 1-2, 2-3, etc. for both + and - rails.
 */
function railJumpers(posCol: number, negCol: number, fromGroup: number, toGroup: number, idPrefix: string): Wire[] {
  const wires: Wire[] = [];
  for (let g = fromGroup; g < toGroup; g++) {
    const row1 = g * 5 + 4;       // last row of group g
    const row2 = (g + 1) * 5;     // first row of group g+1
    wires.push(
      { id: `${idPrefix}rj+${g}`, from: bh(posCol, row1), to: bh(posCol, row2), waypoints: [], color: '#ef4444' },
      { id: `${idPrefix}rj-${g}`, from: bh(negCol, row1), to: bh(negCol, row2), waypoints: [], color: '#60a5fa' },
    );
  }
  return wires;
}

/**
 * LED blink demo: 555 astable → resistor → LED
 * Power distributed via board 0 left rail.
 *
 * Standard 555 astable topology:
 *   VCC → Ra → nodeA (DIS) → Rb → nodeB (THR=TRIG=Cap+) → Cap → GND
 *
 * Physical layout (board 0):
 *   Timer at cols 6-8, rows 5-8.  Pin grid positions:
 *     Left:  RST(6,5)  OUT(6,6)  TRIG(6,7)  GND(6,8)
 *     Right: VCC(8,5)  DIS(8,6)  THR(8,7)   CTRL(8,8)
 *
 *   Ra at col 10, rows 4→6:  pin A right-row 4, pin B right-row 6 (=DIS strip → nodeA)
 *   Rb at col 11, rows 6→8:  pin A right-row 6 (nodeA),  pin B right-row 8
 *   Wire Rb-B → THR to form nodeB (right-row 7 + left-row 7 via THR↔TRIG)
 *   C1 at col 4, rows 7-8:   pos left-row 7 (=TRIG strip → nodeB), neg left-row 8 (=GND strip)
 */
export function createBlinkDemoCircuit(): { components: PlacedComponent[]; wires: Wire[] } {
  function vPos(col: number, row: number): { x: number; y: number } {
    return { x: 96 + col * 24, y: row * 17 + 8.5 };
  }
  function timerPos(col: number, gndRow: number): { x: number; y: number } {
    return { x: 96 + col * 24 + 12, y: gndRow * 17 + 8.5 - 4 * 17 * 7 / 8 };
  }

  const components: PlacedComponent[] = [
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
    // Ra (47k): col 10, rows 4→6 — VCC → nodeA (DIS strip, right row 6)
    {
      id: 'ra', type: 'resistor',
      position: vPos(10, 4), rotation: 0,
      properties: { resistance: 47000 },
      state: {},
    },
    // Rb (68k): col 11, rows 6→8 — nodeA (right row 6) → right row 8, wired to THR (nodeB)
    {
      id: 'rb', type: 'resistor',
      position: vPos(11, 6), rotation: 0,
      properties: { resistance: 68000 },
      state: {},
    },
    // C1 (47μF): col 4, rows 7-8 — pos at left row 7 (TRIG strip = nodeB), neg at left row 8 (GND strip)
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
    // === Power → left rail (row 5, group 1) ===
    { id: 'w1', from: { componentId: 'power1', pinId: 'pos' }, to: bh(0, 5), waypoints: [], color: '#ef4444' },
    { id: 'w2', from: { componentId: 'power1', pinId: 'neg' }, to: bh(1, 5), waypoints: [], color: '#60a5fa' },

    // === VCC to 555: + rail → right comp strip row 5 ===
    { id: 'w3', from: bh(0, 5), to: bh(9, 5), waypoints: [], color: '#ef4444' },
    // === GND to 555: - rail → left comp strip row 8 (GND pin + C1 neg share this strip) ===
    { id: 'w4', from: bh(1, 8), to: bh(3, 8), waypoints: [], color: '#60a5fa' },

    // RST → VCC (across gap, both row 5)
    { id: 'w5', from: { componentId: 'timer1', pinId: 'reset' }, to: { componentId: 'timer1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },

    // === Timing network (correct 555 astable: VCC→Ra→DIS→Rb→THR/TRIG/Cap→GND) ===
    // Ra top → VCC rail (Ra-A at right row 4 → +rail)
    { id: 'w6', from: { componentId: 'ra', pinId: 'a' }, to: bh(0, 5), waypoints: [], color: '#ef4444' },
    // Rb bottom → THR (connects nodeA→Rb→nodeB where THR/TRIG/Cap live)
    { id: 'w7', from: { componentId: 'rb', pinId: 'b' }, to: { componentId: 'timer1', pinId: 'thr' }, waypoints: [], color: '#4ade80' },
    // THR → TRIG (across gap — nodeB spans both comp strips at row 7)
    { id: 'w8', from: { componentId: 'timer1', pinId: 'thr' }, to: { componentId: 'timer1', pinId: 'trig' }, waypoints: [], color: '#4ade80' },
    // (Ra-B and Rb-A share right strip row 6 with DIS → nodeA is automatic via breadboard)
    // (C1 pos shares left strip row 7 with TRIG → nodeB is automatic via breadboard)
    // (C1 neg shares left strip row 8 with GND → ground is automatic via breadboard)

    // Link rail group 1 (rows 5-9) to group 2 (rows 10-14) for LED GND
    ...railJumpers(0, 1, 1, 2, 'b0'),
    // OUT → R_led A
    { id: 'w10', from: { componentId: 'timer1', pinId: 'out' }, to: { componentId: 'rled', pinId: 'a' }, waypoints: [], color: '#fbbf24' },
    // R_led B → LED anode
    { id: 'w11', from: { componentId: 'rled', pinId: 'b' }, to: { componentId: 'led1', pinId: 'anode' }, waypoints: [], color: '#fbbf24' },
    // LED cathode → GND rail (group 2)
    { id: 'w12', from: { componentId: 'led1', pinId: 'cathode' }, to: bh(1, 14), waypoints: [], color: '#60a5fa' },
  ];

  return { components, wires };
}

/**
 * 7-segment counter demo: 555 astable → CD4026 → 7-seg display
 * Power via board 0 left rail, jumpered to board 1 left rail.
 *
 * Same corrected 555 astable topology as blink demo:
 *   VCC → Ra → nodeA (DIS, right row 6) → Rb → nodeB (THR=TRIG=Cap+) → Cap → GND
 */
export function createCounterDemoCircuit(): { components: PlacedComponent[]; wires: Wire[] } {
  function vPos(col: number, row: number): { x: number; y: number } {
    return { x: 96 + col * 24, y: row * 17 + 8.5 };
  }
  function chipPos(col: number, lastRow: number, height: number): { x: number; y: number } {
    const h = height * 17;
    const maxOffset = (height * 2 - 1) / (height * 2);
    return { x: 96 + col * 24 + 12, y: lastRow * 17 + 8.5 - h * maxOffset };
  }

  const components: PlacedComponent[] = [
    {
      id: 'power1', type: 'power',
      position: { x: 0, y: 85 }, rotation: 0,
      properties: { voltage: 5, mode: 'DC', waveform: 'square' },
      state: {},
    },
    // 555 Timer: board 0, cols 6-8, rows 5-8
    {
      id: 'timer1', type: 'timer',
      position: { x: 96 + 6 * 24 + 12, y: 8 * 17 + 8.5 - 4 * 17 * 7 / 8 },
      rotation: 0, properties: {}, state: { outputHigh: 0 },
    },
    // Ra (10k): col 10, rows 4→6 — VCC → nodeA (DIS strip, right row 6)
    {
      id: 'ra', type: 'resistor',
      position: vPos(10, 4), rotation: 0,
      properties: { resistance: 10000 }, state: {},
    },
    // Rb (68k): col 11, rows 6→8 — nodeA (right row 6) → right row 8, wired to THR (nodeB)
    {
      id: 'rb', type: 'resistor',
      position: vPos(11, 6), rotation: 0,
      properties: { resistance: 68000 }, state: {},
    },
    // C1 (47μF): col 4, rows 7-8 — pos at left row 7 (TRIG strip = nodeB), neg at left row 8 (GND strip)
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
    // === Power → board 0 left rail ===
    { id: 'w1', from: { componentId: 'power1', pinId: 'pos' }, to: bh(0, 5), waypoints: [], color: '#ef4444' },
    { id: 'w2', from: { componentId: 'power1', pinId: 'neg' }, to: bh(1, 5), waypoints: [], color: '#60a5fa' },

    // Link board 0 rail groups so all rows have power
    ...railJumpers(0, 1, 1, 3, 'b0'),

    // === 555 power via rail ===
    { id: 'w3', from: bh(0, 5), to: bh(9, 5), waypoints: [], color: '#ef4444' },
    { id: 'w4', from: bh(1, 8), to: bh(3, 8), waypoints: [], color: '#60a5fa' },

    // === 555 timing (correct astable: VCC→Ra→DIS→Rb→THR/TRIG/Cap→GND) ===
    { id: 'w5', from: { componentId: 'timer1', pinId: 'reset' }, to: { componentId: 'timer1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    // Ra top → VCC rail
    { id: 'w6', from: { componentId: 'ra', pinId: 'a' }, to: bh(0, 5), waypoints: [], color: '#ef4444' },
    // Rb bottom → THR (nodeB)
    { id: 'w7', from: { componentId: 'rb', pinId: 'b' }, to: { componentId: 'timer1', pinId: 'thr' }, waypoints: [], color: '#4ade80' },
    // THR → TRIG (across gap — nodeB)
    { id: 'w8', from: { componentId: 'timer1', pinId: 'thr' }, to: { componentId: 'timer1', pinId: 'trig' }, waypoints: [], color: '#4ade80' },
    // (Ra-B + Rb-A + DIS share right strip row 6 → nodeA automatic)
    // (C1 pos + TRIG share left strip row 7 → nodeB automatic)
    // (C1 neg + GND share left strip row 8 → ground automatic)

    // === Bridge board 0 rail → board 1 rail ===
    // Board 1 left rail: col 16 (+), col 17 (-)
    { id: 'w15', from: bh(0, 14), to: bh(16, 14), waypoints: [], color: '#ef4444' },
    { id: 'w16', from: bh(1, 14), to: bh(17, 14), waypoints: [], color: '#60a5fa' },

    // Link board 1 rail groups so CD4026 and 7-seg can reach power
    ...railJumpers(16, 17, 2, 6, 'b1'),

    // === CD4026 power ===
    // VCC: board 1 + rail → right comp strip (where VCC pin sits)
    { id: 'w20', from: bh(16, 14), to: bh(25, 14), waypoints: [], color: '#ef4444' },
    // GND: board 1 - rail → left comp strip row 14 (where GND pin at col 22 sits)
    { id: 'w21', from: bh(17, 14), to: bh(19, 14), waypoints: [], color: '#60a5fa' },
    // RST (right side, offset 9/16 → row 18) → GND rail
    { id: 'w22', from: { componentId: 'counter1', pinId: 'rst' }, to: bh(17, 18), waypoints: [], color: '#60a5fa' },
    // INH (left side, offset 13/16 → row 20) → GND rail
    { id: 'w23', from: { componentId: 'counter1', pinId: 'inh' }, to: bh(17, 20), waypoints: [], color: '#60a5fa' },
    // EN (left side, offset 11/16 → row 19) → VCC rail
    { id: 'w24', from: { componentId: 'counter1', pinId: 'en' }, to: bh(16, 19), waypoints: [], color: '#ef4444' },

    // === 555 OUT → CD4026 CLK ===
    { id: 'w30', from: { componentId: 'timer1', pinId: 'out' }, to: { componentId: 'counter1', pinId: 'clk' }, waypoints: [], color: '#fbbf24' },

    // === CD4026 → 7-Seg ===
    { id: 'w40', from: { componentId: 'counter1', pinId: 'out_a' }, to: { componentId: 'display1', pinId: 'a' }, waypoints: [], color: '#fb923c' },
    { id: 'w41', from: { componentId: 'counter1', pinId: 'out_b' }, to: { componentId: 'display1', pinId: 'b' }, waypoints: [], color: '#fb923c' },
    { id: 'w42', from: { componentId: 'counter1', pinId: 'out_c' }, to: { componentId: 'display1', pinId: 'c' }, waypoints: [], color: '#fb923c' },
    { id: 'w43', from: { componentId: 'counter1', pinId: 'out_d' }, to: { componentId: 'display1', pinId: 'd' }, waypoints: [], color: '#fb923c' },
    { id: 'w44', from: { componentId: 'counter1', pinId: 'out_e' }, to: { componentId: 'display1', pinId: 'e' }, waypoints: [], color: '#fb923c' },
    { id: 'w45', from: { componentId: 'counter1', pinId: 'out_f' }, to: { componentId: 'display1', pinId: 'f' }, waypoints: [], color: '#fb923c' },
    { id: 'w46', from: { componentId: 'counter1', pinId: 'out_g' }, to: { componentId: 'display1', pinId: 'g' }, waypoints: [], color: '#fb923c' },

    // === 7-Seg power ===
    { id: 'w50', from: bh(16, 27), to: bh(25, 27), waypoints: [], color: '#ef4444' },
    { id: 'w51', from: bh(17, 27), to: bh(19, 27), waypoints: [], color: '#60a5fa' },
  ];

  return { components, wires };
}

/**
 * Hand-assembled AVR machine code for the classic Arduino Blink sketch:
 *
 *   void setup() { pinMode(13, OUTPUT); }
 *   void loop()  { digitalWrite(13, HIGH); delay(1000);
 *                   digitalWrite(13, LOW);  delay(1000); }
 *
 * Assembled for ATmega328P @ 16 MHz.  Sets DDRB bit 5,
 * then toggles PORTB bit 5 with a ~1 s busy-wait delay loop.
 *
 * Program layout (word addresses):
 *   0x00  RJMP main
 *   0x01  NOP / 0x02 NOP
 *   0x03  LDI R16,0xFF / OUT SPL,R16       (init stack)
 *   0x05  LDI R16,0x08 / OUT SPH,R16
 *   0x07  SBI DDRB,5                        (PB5 = output)
 *   0x08  loop: SBI PORTB,5                 (LED on)
 *   0x09  RCALL delay
 *   0x0A  CBI PORTB,5                       (LED off)
 *   0x0B  RCALL delay
 *   0x0C  RJMP loop
 *   0x0D  delay: LDI R18,82
 *   0x0E  outer: LDI R17,0
 *   0x0F  middle: LDI R16,0
 *   0x10  inner: DEC R16
 *   0x11  BRNE inner
 *   0x12  DEC R17 / 0x13 BRNE middle
 *   0x14  DEC R18 / 0x15 BRNE outer
 *   0x16  RET
 */
export const AVR_BLINK_HEX = [
  ':1000000002C0000000000FEF0DBF08E00EBF259AF0',
  ':100010002D9A03D02D9801D0FBCF22E510E000E00F',
  ':0E0020000A95F1F71A95D9F72A95C1F70895B8',
  ':00000001FF',
].join('\n');

/**
 * Pre-compiled AVR hex for the 5x7 matrix demo.
 * This firmware uses ATmega328P port lines and a 74HC595 shift register
 * to drive the LED matrix and animate a pair of patterns.
 */
export const AVR_MATRIX_HEX = [
  ':100000000C9434000C9449000C9449000C94490061',
  ':100010000C9449000C9449000C9449000C9449003C',
  ':100020000C9449000C9449000C9449000C9449002C',
  ':100030000C9449000C9449000C9449000C9449001C',
  ':100040000C9449000C9449000C9449000C9449000C',
  ':100050000C9449000C9449000C9449000C944900FC',
  ':100060000C9449000C94490011241FBECFEFD8E036',
  ':10007000DEBFCDBF11E0A0E0B1E0EAE9F1E002C0EF',
  ':1000800005900D92AC31B107D9F70E944B000C944A',
  ':10009000CB000C940000CF92DF92EF92FF920F936F',
  ':1000A0001F93CF93DF9384B18B6184B98AB18C6F36',
  ':1000B0008AB98BB18C6F8BB9299860E070E0C0EE83',
  ':1000C000DEE220EEC22E2EE2D22E91E0E92EF12CBD',
  ':1000D00000E911E053C08BB18C6F8BB9299A8C91D8',
  ':1000E000289820E030E0E82FF0E0CF01022E02C097',
  ':1000F000959587950A94E2F780FF02C02B9A01C07C',
  ':100100002B98CE010197F1F72C9ACE010197F1F7C8',
  ':100110002C98CE010197F1F72F5F3F4F2830310522',
  ':1001200021F7289AC6010197F1F728984630510522',
  ':1001300079F02BB1FA01E050FF4FC701008002C0F7',
  ':10014000880F991F0A94E2F7809582238BB901C02A',
  ':10015000299880E293E0F8013197F1F70197D9F7F8',
  ':100160004F5F5F4F11964730510509F0B4CF6F5F75',
  ':100170007F4F6330710514F060E070E0DB0183E0D5',
  ':10018000AA0FBB1F8A95E1F7A61BB70BA95FBE4F4D',
  ':0A01900040E050E0A0CFF894FFCF4C',
  ':10019A0002030405060701040A1F1F0E04001F11AB',
  ':0C01AA001111111F00110A040A110000BD',
  ':00000001FF',
].join('\n');

/**
 * ATmega328P blink demo: Arduino-style LED blink on pin D13 (PB5).
 * Pre-loaded with hand-assembled AVR machine code (no compilation needed).
 *
 * Physical layout (board 0):
 *   ATmega328P at cols 6-8, rows 7-20 (DIP-28 straddling center gap)
 *   Pin grid positions (lastRow = 20):
 *     Left:  RST(6,20) D0(6,19) … VCC(6,14) GND(6,13) … D8(6,7)
 *     Right: D9(8,20)  D10(8,19) … D13(8,16) AVCC(8,15) AREF(8,14) GND(8,13) … A5(8,7)
 *
 *   Resistor (220 Ω) at col 10, rows 16→18:  pin A right-row 16 (=D13 strip)
 *   LED at col 10, rows 18-19:  anode right-row 18 (=R.b strip), cathode right-row 19
 */
export function createAVRBlinkDemoCircuit(): { components: PlacedComponent[]; wires: Wire[] } {
  function vPos(col: number, row: number): { x: number; y: number } {
    return { x: 96 + col * 24, y: row * 17 + 8.5 };
  }
  function chipPos(col: number, lastRow: number, height: number): { x: number; y: number } {
    const h = height * 17;
    const maxOffset = (height * 2 - 1) / (height * 2);
    return { x: 96 + col * 24 + 12, y: lastRow * 17 + 8.5 - h * maxOffset };
  }

  const components: PlacedComponent[] = [
    {
      id: 'power1', type: 'power',
      position: { x: 0, y: 200 }, rotation: 0,
      properties: { voltage: 5, mode: 'DC', waveform: 'square' },
      state: {},
    },
    // ATmega328P: cols 6-8, rows 7-20
    {
      id: 'avr1', type: 'atmega328',
      position: chipPos(6, 20, 14), rotation: 0,
      properties: { clockSpeed: 16000000 },
      state: {},
    },
    // R1 (220 Ω): col 10, rows 16→18 — D13 strip (right row 16) to LED
    {
      id: 'r1', type: 'resistor',
      position: vPos(10, 16), rotation: 0,
      properties: { resistance: 220 },
      state: {},
    },
    // LED: col 10, row 18 — anode right-row 18, cathode right-row 19
    {
      id: 'led1', type: 'led',
      position: vPos(10, 18), rotation: 0,
      properties: { forwardVoltage: 2.0, color: 'red' },
      state: { on: 0 },
    },
  ];

  const wires: Wire[] = [
    // === Power → left rail (group 2, rows 10-14) ===
    { id: 'w1', from: { componentId: 'power1', pinId: 'pos' }, to: bh(0, 14), waypoints: [], color: '#ef4444' },
    { id: 'w2', from: { componentId: 'power1', pinId: 'neg' }, to: bh(1, 14), waypoints: [], color: '#60a5fa' },

    // === VCC (left strip row 14): + rail → left comp strip ===
    { id: 'w3', from: bh(0, 14), to: bh(3, 14), waypoints: [], color: '#ef4444' },
    // === GND (left strip row 13): - rail → left comp strip ===
    { id: 'w4', from: bh(1, 13), to: bh(3, 13), waypoints: [], color: '#60a5fa' },

    // === AVCC (right strip row 15): + rail → right comp strip ===
    { id: 'w5', from: bh(0, 15), to: bh(9, 15), waypoints: [], color: '#ef4444' },
    // === AGND (right strip row 13): - rail → right comp strip ===
    { id: 'w6', from: bh(1, 13), to: bh(9, 13), waypoints: [], color: '#60a5fa' },

    // === RST → VCC (keep chip out of reset) ===
    { id: 'w7', from: { componentId: 'avr1', pinId: 'pc6' }, to: { componentId: 'avr1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },

    // Rail jumpers: link group 2 (rows 10-14) → group 3 (rows 15-19) for AVCC + LED GND
    ...railJumpers(0, 1, 2, 3, 'b0'),

    // === LED circuit ===
    // D13 (right row 16) → R1 A (right row 16): automatic via breadboard strip
    // R1 B (right row 18) → LED anode (right row 18): automatic via breadboard strip
    // LED cathode (right row 19) → GND rail
    { id: 'w10', from: { componentId: 'led1', pinId: 'cathode' }, to: bh(1, 19), waypoints: [], color: '#60a5fa' },
  ];

  return { components, wires };
}

/**
 * 5x7 LED Matrix demo: ATmega328P + 74HC595 shift register driving LED matrix
 * Shows animated patterns on the 5x7 LED matrix display.
 *
 * Layout:
 * - ATmega328P at cols 6-8, rows 7-20
 * - 74HC595 at cols 12-14, rows 10-17 (for column anodes)
 * - 5x7 Matrix at cols 18-20, rows 12-18
 */
export function createMatrixDemoCircuit(): { components: PlacedComponent[]; wires: Wire[] } {
  function vPos(col: number, row: number): { x: number; y: number } {
    return { x: 96 + col * 24, y: row * 17 + 8.5 };
  }
  function chipPos(col: number, lastRow: number, height: number): { x: number; y: number } {
    const h = height * 17;
    const maxOffset = (height * 2 - 1) / (height * 2);
    return { x: 96 + col * 24 + 12, y: lastRow * 17 + 8.5 - h * maxOffset };
  }

  const components: PlacedComponent[] = [
    {
      id: 'power1', type: 'power',
      position: { x: 0, y: 200 }, rotation: 0,
      properties: { voltage: 5, mode: 'DC', waveform: 'square' },
      state: {},
    },
    // ATmega328P: cols 6-8, rows 7-20
    {
      id: 'avr1', type: 'atmega328',
      position: chipPos(6, 20, 14), rotation: 0,
      properties: { clockSpeed: 16000000 },
      state: {},
    },
    // 74HC595 Shift Register: board 1, straddles gap col 23, rows 7-14.
    // Both pin rows must be in component areas (NOT power rails) and in
    // different left/right component groups, otherwise the breadboard's per-
    // row strip wiring shorts them together. chipPos col=22 puts left pins on
    // col 22 (board 1 left-comp) and right pins on col 24 (board 1 right-comp).
    {
      id: 'shift1', type: 'shift_register',
      position: chipPos(22, 14, 8), rotation: 0,
      properties: {},
      state: {},
    },
    // 5x7 LED Matrix: board 1, straddles gap col 23, rows 16-22.
    // Stacked below shift1 (rows 7-14) to avoid sharing any horizontal strips.
    {
      id: 'matrix1', type: 'ledmatrix',
      position: chipPos(22, 22, 7), rotation: 0,
      properties: { color: 'red' },
      state: {},
    },
  ];

  const wires: Wire[] = [
    // === Power → left rail (group 2, rows 10-14) ===
    { id: 'm1', from: { componentId: 'power1', pinId: 'pos' }, to: bh(0, 14), waypoints: [], color: '#ef4444' },
    { id: 'm2', from: { componentId: 'power1', pinId: 'neg' }, to: bh(1, 14), waypoints: [], color: '#60a5fa' },

    // === VCC (left strip row 14): + rail → left comp strip ===
    { id: 'm3', from: bh(0, 14), to: bh(3, 14), waypoints: [], color: '#ef4444' },
    // === GND (left strip row 13): - rail → left comp strip ===
    { id: 'm4', from: bh(1, 13), to: bh(3, 13), waypoints: [], color: '#60a5fa' },

    // === AVCC (right strip row 15): + rail → right comp strip ===
    { id: 'm5', from: bh(0, 15), to: bh(9, 15), waypoints: [], color: '#ef4444' },
    // === AGND (right strip row 13): - rail → right comp strip ===
    { id: 'm6', from: bh(1, 13), to: bh(9, 13), waypoints: [], color: '#60a5fa' },

    // === AVR power rails ===
    { id: 'm7', from: { componentId: 'avr1', pinId: 'vcc' }, to: bh(9, 15), waypoints: [], color: '#ef4444' },
    { id: 'm8', from: { componentId: 'avr1', pinId: 'gnd' }, to: bh(9, 13), waypoints: [], color: '#60a5fa' },
    { id: 'm9', from: { componentId: 'avr1', pinId: 'avcc' }, to: bh(9, 15), waypoints: [], color: '#ef4444' },
    { id: 'm10', from: { componentId: 'avr1', pinId: 'agnd' }, to: bh(9, 13), waypoints: [], color: '#60a5fa' },

    // === RST → VCC (keep chip out of reset) ===
    { id: 'm11', from: { componentId: 'avr1', pinId: 'pc6' }, to: { componentId: 'avr1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },

    // Rail jumpers: link group 2 (rows 10-14) → group 3 (rows 15-19) for AVCC + matrix power
    ...railJumpers(0, 1, 2, 3, 'b0'),

    // === ATmega328P → 74HC595 ===
    // D11 (PB3) → SER (serial data)
    { id: 'm12', from: { componentId: 'avr1', pinId: 'pb3' }, to: { componentId: 'shift1', pinId: 'ser' }, waypoints: [], color: '#fbbf24' },
    // D12 (PB4) → SRCLK (shift clock)
    { id: 'm13', from: { componentId: 'avr1', pinId: 'pb4' }, to: { componentId: 'shift1', pinId: 'srclk' }, waypoints: [], color: '#fbbf24' },
    // D8 (PB0) → RCLK (latch clock)
    { id: 'm14', from: { componentId: 'avr1', pinId: 'pb0' }, to: { componentId: 'shift1', pinId: 'rclk' }, waypoints: [], color: '#fbbf24' },
    // OE → GND (always enabled)
    { id: 'm15', from: { componentId: 'shift1', pinId: 'oe' }, to: bh(1, 13), waypoints: [], color: '#60a5fa' },
    // SRCLR → VCC (never clear)
    { id: 'm16', from: { componentId: 'shift1', pinId: 'srclr' }, to: bh(0, 14), waypoints: [], color: '#ef4444' },

    // === 74HC595 → Matrix Columns (Anodes) ===
    // The firmware shifts data LSB-first through all 8 bits, so a 5-bit
    // pattern ends up in Q3..Q7 (= QD..QH), not Q0..Q4. Wire columns to
    // those upper outputs to match.
    { id: 'm20', from: { componentId: 'shift1', pinId: 'qd' }, to: { componentId: 'matrix1', pinId: 'c1' }, waypoints: [], color: '#22c55e' },
    { id: 'm21', from: { componentId: 'shift1', pinId: 'qe' }, to: { componentId: 'matrix1', pinId: 'c2' }, waypoints: [], color: '#22c55e' },
    { id: 'm22', from: { componentId: 'shift1', pinId: 'qf' }, to: { componentId: 'matrix1', pinId: 'c3' }, waypoints: [], color: '#22c55e' },
    { id: 'm23', from: { componentId: 'shift1', pinId: 'qg' }, to: { componentId: 'matrix1', pinId: 'c4' }, waypoints: [], color: '#22c55e' },
    { id: 'm24', from: { componentId: 'shift1', pinId: 'qh' }, to: { componentId: 'matrix1', pinId: 'c5' }, waypoints: [], color: '#22c55e' },

    // === ATmega328P → Matrix Rows (Cathodes) ===
    // D2 (PD2) → R1, D3 (PD3) → R2, D4 (PD4) → R3, D5 (PD5) → R4
    { id: 'm30', from: { componentId: 'avr1', pinId: 'pd2' }, to: { componentId: 'matrix1', pinId: 'r1' }, waypoints: [], color: '#8b5cf6' },
    { id: 'm31', from: { componentId: 'avr1', pinId: 'pd3' }, to: { componentId: 'matrix1', pinId: 'r2' }, waypoints: [], color: '#8b5cf6' },
    { id: 'm32', from: { componentId: 'avr1', pinId: 'pd4' }, to: { componentId: 'matrix1', pinId: 'r3' }, waypoints: [], color: '#8b5cf6' },
    { id: 'm33', from: { componentId: 'avr1', pinId: 'pd5' }, to: { componentId: 'matrix1', pinId: 'r4' }, waypoints: [], color: '#8b5cf6' },
    // D6 (PD6) → R5, D7 (PD7) → R6, D9 (PB1) → R7
    { id: 'm34', from: { componentId: 'avr1', pinId: 'pd6' }, to: { componentId: 'matrix1', pinId: 'r5' }, waypoints: [], color: '#8b5cf6' },
    { id: 'm35', from: { componentId: 'avr1', pinId: 'pd7' }, to: { componentId: 'matrix1', pinId: 'r6' }, waypoints: [], color: '#8b5cf6' },
    { id: 'm36', from: { componentId: 'avr1', pinId: 'pb1' }, to: { componentId: 'matrix1', pinId: 'r7' }, waypoints: [], color: '#8b5cf6' },

    // === Matrix Power ===
    { id: 'm40', from: bh(0, 15), to: { componentId: 'matrix1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    { id: 'm41', from: bh(1, 15), to: { componentId: 'matrix1', pinId: 'gnd' }, waypoints: [], color: '#60a5fa' },
  ];

  return { components, wires };
}
