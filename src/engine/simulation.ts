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
 *
 * Built from ino/matrix_demo.ino with arduino-cli (arduino:avr:uno).
 * Multiplexes 7 rows via 74HC595 shift register at ~70 Hz, cycling
 * through three patterns (heart, rectangle, X) one second each.
 *
 * To regenerate after editing the .ino:
 *   arduino-cli compile --fqbn arduino:avr:uno \
 *     --output-dir build ino/matrix_demo
 *   then copy build/sketch.ino.hex into the array below.
 */
export const AVR_MATRIX_HEX = [
  ':100000000C945C000C9479000C9479000C947900A9',
  ':100010000C9479000C9479000C9479000C9479007C',
  ':100020000C9479000C9479000C9479000C9479006C',
  ':100030000C9479000C9479000C9479000C9479005C',
  ':100040000C940B010C9479000C9479000C947900B9',
  ':100050000C9479000C9479000C9479000C9479003C',
  ':100060000C9479000C947900000000080002010053',
  ':100070000003040700000000000000000000000072',
  ':10008000250028002B0000000000240027002A0083',
  ':10009000040404040404040402020202020203032E',
  ':1000A0000303030301020408102040800102040836',
  ':1000B000102001020408102011241FBECFEFD8E049',
  ':1000C000DEBFCDBF11E0A0E0B1E0E0ECF4E002C0A3',
  ':1000D00005900D92AC31B107D9F721E0ACE1B1E068',
  ':1000E00001C01D92A532B207E1F70E9455010C94A0',
  ':1000F0005E020C94000090E0FC01EC55FF4F24914F',
  ':1001000080579F4FFC018491882399F090E0880FDD',
  ':10011000991FFC01EA57FF4FA591B491FC01E458E7',
  ':10012000FF4F859194918FB7F894EC91E22BEC936B',
  ':100130008FBF089590E0FC01E859FF4F2491FC0126',
  ':10014000EC55FF4F3491FC01E057FF4FE491EE2353',
  ':10015000C9F0222339F0233001F1A8F4213019F13C',
  ':10016000223029F1F0E0EE0FFF1FE458FF4FA59178',
  ':10017000B4918FB7F894EC91611126C030953E236D',
  ':100180003C938FBF08952730A9F02830C9F0243060',
  ':1001900049F7809180008F7D03C0809180008F7728',
  ':1001A00080938000DFCF84B58F7784BDDBCF84B5AB',
  ':1001B0008F7DFBCF8091B0008F778093B000D2CF3E',
  ':1001C0008091B0008F7DF9CF3E2BDACF3FB7F89406',
  ':1001D0008091210190912201A0912301B0912401ED',
  ':1001E00026B5A89B05C02F3F19F00196A11DB11D92',
  ':1001F0003FBFBA2FA92F982F8827BC01CD01620FCE',
  ':10020000711D811D911D42E0660F771F881F991F88',
  ':100210004A95D1F708951F920F920FB60F921124AD',
  ':100220002F933F938F939F93AF93BF9380911D0123',
  ':1002300090911E01A0911F01B091200130911C01ED',
  ':1002400023E0230F2D3758F50196A11DB11D2093F2',
  ':100250001C0180931D0190931E01A0931F01B09378',
  ':1002600020018091210190912201A0912301B09160',
  ':1002700024010196A11DB11D8093210190932201BB',
  ':10028000A0932301B0932401BF91AF919F918F91CF',
  ':100290003F912F910F900FBE0F901F90189526E859',
  ':1002A000230F0296A11DB11DD2CFCF93DF9300D0B3',
  ':1002B00000D000D0CDB7DEB7789484B5826084BD1D',
  ':1002C00084B5816084BD85B5826085BD85B581605A',
  ':1002D00085BD80916E00816080936E0010928100D8',
  ':1002E0008091810082608093810080918100816093',
  ':1002F0008093810080918000816080938000809154',
  ':10030000B10084608093B1008091B00081608093DF',
  ':10031000B00080917A00846080937A0080917A00A6',
  ':10032000826080937A0080917A00816080937A0065',
  ':1003300080917A00806880937A001092C10047E033',
  ':10034000E42E41E0F42E80E091E09E838D83ED81E8',
  ':10035000FE811191FE83ED83812F0E947B0061E07D',
  ':10036000812F0E949A008D819E81E816F90679F707',
  ':1003700088E00E947B008BE00E947B008CE00E9462',
  ':100380007B0060E088E00E949A0007E011E093E0C3',
  ':100390009A838FB7F89480901D0190901E01A090D1',
  ':1003A0001F01B09020018FBF2FB7F89480911D01DD',
  ':1003B00090911E01A0911F01B09120012FBF8819BB',
  ':1003C0009909AA09BB09883E9340A105B10508F027',
  ':1003D00066C0180180E091E09C838B8397E099834D',
  ':1003E00030E0E32E31E0F32E61E0F70181917F01EF',
  ':1003F0000E949A008D819E81E816F906A9F7F10105',
  ':10040000E1901F0128E0F22E6E2D61708BE00E94BA',
  ':100410009A00E69461E08CE00E949A0060E08CE033',
  ':100420000E949A00FA94F110EFCF61E088E00E94F8',
  ':100430009A0060E088E00E949A0060E0EB81FC8115',
  ':100440008191FC83EB830E949A000E94E6006B017D',
  ':100450007C0192E0492E512C612C712C0E94E60007',
  ':100460006C197D098E099F09683E734081059105CD',
  ':10047000A8F3F8EECF0EF3E0DF1EE11CF11C4A9466',
  ':1004800045284628472829F0412C512C3201439415',
  ':10049000E5CFF981F150F983F111A2CF85CF2A81FF',
  ':1004A00021502A83095F1F4F211173CF80E090E014',
  ':1004B000892B09F46ACF0E94000067CFF894FFCF20',
  ':1004C000020304050607090A1F1F0E0400001F117E',
  ':0C04D0001111111F00110A040A11000094',
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
