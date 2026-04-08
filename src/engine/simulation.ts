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

/**
 * Pre-compiled AVR hex for the necklace demo (ino/necklace.ino).
 *
 * Built from ino/necklace.ino with arduino-cli (arduino:avr:uno). This
 * sketch drives the 5x7 matrix DIRECTLY from AVR pins — no shift register
 * — so it needs the necklace demo circuit, not the matrix demo circuit.
 *
 * To regenerate after editing the .ino:
 *   arduino-cli compile --fqbn arduino:avr:uno \
 *     --output-dir build ino/necklace
 *   then copy build/necklace.ino.hex into the template literal below.
 */
export const AVR_NECKLACE_HEX = `:100000000C94A9010C94C6010C94C6010C94C60171
:100010000C94C6010C94C6010C94C6010C94C60144
:100020000C94C6010C94C6010C94C6010C94C60134
:100030000C94C6010C94C6010C94C6010C94C60124
:100040000C9425030C94C6010C94C6010C94C601B3
:100050000C94C6010C94C6010C94C6010C94C60104
:100060000C94C6010C94C601FF415D41FF003E2285
:100070003E000E3B173B0E0C1224120C0A005500DA
:100080000A08142A1408074971490722146B14221C
:10009000363608363606156915060F1A3E1A0F6CE5
:1000A0001A6F1A6C7D5A1E5A7D4E7B0F7B4E3D6631
:1000B0007C663D11111111110101010101020202C1
:1000C00002020404040404080808080810101010B0
:1000D0001020202020204040404040404020201060
:1000E000402010100840201008044020180402404E
:1000F000300C02014038040300F00F000000FF0044
:1001000000000000FF0000000000FF0000000000F1
:10011000FF0000000000FF000000000000005F0082
:10012000000007000700147F147F14242A7F2A127E
:10013000231308646236495522500005030000006D
:100140001C2241000041221C00082A1C2A08080821
:100150003E080800503000000808080808006060E9
:10016000000020100804023E5149453E00427F40F5
:100170000042615149462141454B311814127F100C
:1001800027454545393C4A4949300171090503363F
:1001900049494936064949291E00363600000056AD
:1001A00036000000081422411414141414412214BF
:1001B00008000201510906324979413E7E111111B0
:1001C0007E7F494949363E414141227F4141221CBF
:1001D0007F494949417F090901013E414151327F2F
:1001E0000808087F00417F41002040413F017F080F
:1001F0001422417F404040407F0204027F7F040878
:10020000107F3E4141413E7F090909063E4151218F
:100210005E7F09192946464949493101017F01019B
:100220003F4040403F1F2040201F7F2018207F6319
:100230001408146303047804036151494543000022
:100240007F4141020408102041417F000004020167
:100250000204404040404000010204002054545435
:10026000787F484444383844444400384444487F04
:100270003854545418087E090102081454543C7F21
:100280000804047800447D40002040443D00007F85
:1002900010284400417F40007C041804787C080446
:1002A000047838444444387C14141408081414188E
:1002B0007C7C080404084854545420043F444020E3
:1002C0003C4040207C1C2040201C3C4030403C44B2
:1002D000281028440C5050503C4464544C440008AE
:1002E00036410000007F0000004136080008082A5F
:1002F0001C08081C2A080800000000240027002A07
:100300000000000000250028002B00000000002352
:100310000026002900040404040404040402020268
:100320000202020303030303030102040810204036
:1003300080010204081020010204081020000000BF
:100340000800020100000304070000000000000094
:10035000000011241FBECFEFD8E0DEBFCDBF11E0FB
:10036000A0E0B1E0EAEBFEE002C005900D92A833F8
:10037000B107D9F721E0A8E3B1E001C01D92A7378A
:10038000B207E1F70E946F030C945B070C94000026
:10039000833081F028F4813099F08230A9F00895FB
:1003A0008730A9F08830C9F08430B1F480918000A2
:1003B0008F7D03C0809180008F77809380000895A7
:1003C00084B58F7784BD089584B58F7DFBCF8091F0
:1003D000B0008F778093B00008958091B0008F7D3A
:1003E000F9CFCF93DF93282F30E0F901E35CFC4F86
:1003F0008491F901E75DFC4FD491F901EB5EFC4F6C
:10040000C491CC23A1F081110E94C801EC2FF0E02F
:10041000EE0FFF1FE55FFC4FA591B491EC91ED232A
:1004200081E090E009F480E0DF91CF91089580E0D1
:1004300090E0FACF1F93CF93DF93282F30E0F9019C
:10044000E35CFC4F8491F901E75DFC4FD491F90125
:10045000EB5EFC4FC491CC23A9F0162F81110E94B2
:10046000C801EC2FF0E0EE0FFF1FEF5FFC4FA591EE
:10047000B4918FB7F894EC91111108C0D095DE2398
:10048000DC938FBFDF91CF911F910895DE2BF8CFC2
:10049000CF93DF9390E0FC01E75DFC4F24918B5EEE
:1004A0009C4FFC0184918823D1F090E0880F991F24
:1004B000FC01E950FD4FA591B491FC01EF5FFC4FA9
:1004C000C591D491623071F49FB7F8943C91822F1A
:1004D000809583238C93E8812E2B28839FBFDF9107
:1004E000CF9108958FB7F894EC912E2B2C938FBF5A
:1004F000F6CFE0E4F1E010821182128213821482BE
:1005000015821682379681E0E336F807A1F7089541
:10051000CF93DF93EC010E94790285E08C9FB001BC
:100520008D9F700D112440E451E090E080E0685907
:100530007F4FC1E0FB01E80FF91FE49130E020E0BC
:10054000AE2FB0E0E0FF04C0FA01E20FF31FC0835A
:10055000FD01F595E7952F5F3F4F2730310581F776
:100560000196495F5F4F8530910521F7DF91CF916B
:1005700008950F931F93CF93DF93C0E0D1E060E025
:1005800089910E941A0281E0C530D807C1F7C5E001
:10059000D1E00CE011E061E089910E941A020C1791
:1005A0001D07C9F7DF91CF911F910F910895CF9348
:1005B000DF93EC0170933F0160933E01FC010190D9
:1005C0000020E9F73197BF01681B790B660F771F91
:1005D00080916401909165010E942D079595879502
:1005E000C80FD91FC8810C2E000CDD0BA0970E94EC
:1005F000790285E08C9FB0018D9F700D112440E43D
:1006000051E090E080E0695E7E4FC1E0FB01E80FC1
:10061000F91FE49130E020E0AE2FB0E0E0FF04C02D
:10062000FA01E20FF31FC48FFD01F595E7952F5FE7
:100630003F4F2730310581F70196475051098530EA
:10064000910521F7DF91CF9108951F920F920FB678
:100650000F9211242F933F938F939F93AF93BF9348
:100660008091730190917401A0917501B091760110
:100670003091720123E0230F2D3758F50196A11D0B
:10068000B11D209372018093730190937401A09324
:100690007501B093760180916E0190916F01A091E8
:1006A0007001B09171010196A11DB11D80936E0181
:1006B00090936F01A0937001B0937101BF91AF91BE
:1006C0009F918F913F912F910F900FBE0F901F9090
:1006D000189526E8230F0296A11DB11DD2CF78945C
:1006E00084B5826084BD84B5816084BD85B5826037
:1006F00085BD85B5816085BD80916E0081608093E8
:100700006E00109281008091810082608093810050
:100710008091810081608093810080918000816060
:10072000809380008091B10084608093B1008091BB
:10073000B00081608093B00080917A0084608093E3
:100740007A0080917A00826080937A0080917A00AA
:10075000816080937A0080917A00806880937A002B
:100760001092C100C0E0D1E061E089910E9448028E
:1007700001E0C530D007C1F7C5E0D1E061E0899163
:100780000E94480211E0CC30D107C1F762E089E055
:100790000E94480262E08AE00E94480284E190E000
:1007A00090936701809366018FEF9FEF90936501AF
:1007B000809364018EE190E090933F0180933E012D
:1007C0000E94B902C3E04C2E512CC1E0D7E0222494
:1007D0002394312C66246A94762C3FB7F894809148
:1007E0006E0190916F01A0917001B091710126B5D9
:1007F000A89B05C02F3F19F00196A11DB11D3FBF59
:10080000BA2FA92F982F8827820F911DA11DB11DE6
:10081000F2E0880F991FAA1FBB1FFA95D1F74091EC
:100820003A0150913B0160913C0170913D018C0176
:100830009D01041B150B260B370BB901A801443091
:100840005A406105710538F180933A0190933B015C
:10085000A0933C01B0933D01C0936C018091630172
:100860008F5F853008F04EC080936301809138011E
:10087000909139019C012F5F3F4F309339012093B4
:10088000380160913E0170913F010E942D07892B34
:1008900011F4C0936D0180916D01882309F45FC04C
:1008A000E0906401F090650187010F5F1F4F109386
:1008B00065010093640110926D01E0916601F09171
:1008C00067013197E831F10508F049C0E659FB4F5F
:1008D0000C94410785044405520570059F05760672
:1008E000640579067C067F068206850688068B06E7
:1008F0008E069106940697069A069D06A406A906FA
:10090000AE06B30610926301B1CF2CE231E0309312
:100910003F0120933E018701095F1F4F60E4C62E0F
:1009200061E0D62ECE18DF0872E0A72EB12CF601BA
:10093000EE0DFF1D21E030E0C9018E0D9F1DB501B8
:100940000E942D0780832F5F3F4F37962630310559
:1009500099F73FEFE31AF30A0E151F0541F780914F
:100960006C01882309F488C00E94B90200916301D8
:10097000E02FF0E0E050FF4F61E080810E941A021A
:100980000D9F80011124F12CE12CF801EE0DFF1DCB
:10099000E05CFE4F8081882339F060E0F701EB5F77
:1009A000FE4F80810E941A02FFEFEF1AFF0A27E034
:1009B000E216F10451F710926C0189E00E94F101F6
:1009C000892B09F040C280916A0190916B010196D8
:1009D00090936B0180936A018AE00E94F101892B58
:1009E00009F036C280916801909169010196909357
:1009F00069018093680180916801909169010A976B
:100A000079F4809166019091670101979093670155
:100A1000809366017092650160926401C0936D01DC
:100A200080916A0190916B010A9779F48091660137
:100A3000909167010196909367018093660170928F
:100A4000650160926401C0936D018091660190918F
:100A50006701499724F030926701209266018091E6
:100A60006601909167011816190634F088E190E04C
:100A7000909367018093660140E050E0452B09F4B4
:100A8000ACCE0E940000A1CE8EE190E090933F0199
:100A900080933E01C80180959095817099270E94AE
:100AA00088025DCF42E350E050933F0140933E0106
:100AB000C8016AE070E00E942D078130910569F05D
:100AC00034F4892B09F04BCF83E090E0E8CF8230FB
:100AD0009105D1F3039709F042CF0E9479023FCFED
:100AE00053E1E52EF12CF0923F01E0923E010E948D
:100AF0007902C801B7010E942D078730910524F4BF
:100B0000805C9E4FDC01CC93C8016BE070E00E94DA
:100B10002D078730910524F4805C9E4FFC01C68729
:100B2000C80161E170E00E942D07873091050CF04B
:100B300016CF805C9E4FDC015C96CC9310CFE8E230
:100B4000F0E0F0933F01E0933E010E947902C8017A
:100B5000B2010E942D0726E030E0A901481B590B85
:100B6000DA01A05CBE4F6D01CC93F701329682E0B2
:100B7000882E912CCF01B4010E942D07A901481B9A
:100B8000590BDA01A05CBE4F5D011796CC93C801EA
:100B9000B4010E942D07D901A81BB90BA05CBE4F60
:100BA0001E96CC93D5015596CC93CF01B2010E94ED
:100BB0002D07D901A81BB90BA05CBE4F5C96CC9346
:100BC00095E0A92EB12CCF01B5010E942D07D901C6
:100BD000A81BB90BA05CBE4F1796CC93D6011E96EE
:100BE000CC936701B3E0CB0ED11CC601B5010E94C6
:100BF0002D07D901A81BB90BA05CBE4F5596CC930D
:100C0000C701059644E0A42EB12CB5010E942D0722
:100C1000D901A81BB90BA05CBE4FCC93CF01B50185
:100C20000E942D07F901E81BF90BE05CFE4FC7831A
:100C3000C801B5010E942D07F901E81BF90BE05C22
:100C4000FE4FC687C7010496B5010E942D07F90122
:100C5000E81BF90BE05CFE4FC58BC601B5010E9495
:100C60002D07F901E81BF90BE05CFE4FC48FC801AA
:100C700063E170E00E942D078730910534F4281B52
:100C8000390BF901E05CFE4FC08326E030E0C8017B
:100C9000B9010E942D07F901E81BF90BE05CFE4F3A
:100CA000C783C80167E070E00E942D07F901E81BC7
:100CB000F90BE05CFE4FC687C601B9010E942D0703
:100CC000F901E81BF90BE05CFE4FC58BC80161E13F
:100CD00070E00E942D07873091050CF040CE281B54
:100CE000390BF901E05CFE4FC48F39CE82E090E011
:100CF000D6CE84E090E0D3CE85E090E0D0CE86E002
:100D000090E0CDCE87E090E0CACE88E090E0C7CEFC
:100D100089E090E0C4CE8AE090E0C1CE8BE090E024
:100D2000BECE8CE090E0BBCE8DE090E0B8CE8EE001
:100D300090E0B5CE8FE090E0B2CE63EA70E08CE058
:100D400091E00E94D7020BCE64E170E084E291E072
:100D5000F8CF6CE370E089E291E0F3CF6CE370E0F0
:100D600080E391E0EECFE4E1F0E0F0933F01E09327
:100D70003E01C80163E270E00E942D0783329105B5
:100D800008F0EDCDFC01E953F94F0C944107EA0658
:100D9000ED06F006F306F606F906FC06FF06020766
:100DA000050708070B070E071107140717071A078F
:100DB0001D0720071D071A071707140711070E073D
:100DC0000B07080705070207FF06FC06F906F606EB
:100DD000F306F00680E190E062CE81E190E05FCE24
:100DE00082E190E05CCE83E190E059CE84E190E036
:100DF00056CE85E190E053CE86E190E050CE87E17B
:100E000090E04DCE88E190E04ACE89E190E047CE77
:100E10008AE190E044CE8BE190E041CE8CE190E01D
:100E20003ECE8DE190E03BCE8EE190E038CE8FE17A
:100E300090E035CE80E290E032CE81E290E02FCE9D
:100E400082E290E02CCE10926B0110926A01C4CD28
:100E50001092690110926801CECD97FB072E16F40F
:100E6000009407D077FD09D00E94470707FC05D002
:100E70003EF4909581959F4F0895709561957F4FB1
:100E80000895EE0FFF1F0590F491E02D0994AA1B21
:100E9000BB1B51E107C0AA1FBB1FA617B70710F065
:100EA000A61BB70B881F991F5A95A9F78095909597
:0A0EB000BC01CD010895F894FFCFB6
:100EBA000E0F10111202030405060708486170702C
:100ECA007920426972746864617920416C6578217D
:100EDA00202020002D5C7C2F0065646320202000E8
:080EEA004544432020200000D4
:00000001FF`;

/**
 * Necklace demo circuit: ATmega328P + 5x7 LED matrix wired directly
 * (no shift register), matching the pin map in ino/necklace.ino:
 *   ROW_PINS = {A0..A4} = PC0..PC4 (anodes, source HIGH)  → matrix C1..C5
 *   COL_PINS = {2..8}   = PD2..PD7, PB0 (cathodes, sink LOW) → matrix R1..R7
 *
 * The sketch defaults to mode 20 (text scroll). A momentary pushbutton
 * is wired to BUTTON1 (D9 / PB1, with GND on the other side) — clicking
 * it advances `mode` to the next animation. INPUT_PULLUP keeps PB1 HIGH
 * while open; pressing pulls it LOW.
 */
export function createNecklaceDemoCircuit(): { components: PlacedComponent[]; wires: Wire[] } {
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
    // 5x7 LED Matrix: board 1, straddles gap col 23, rows 16-22
    {
      id: 'matrix1', type: 'ledmatrix',
      position: chipPos(22, 22, 7), rotation: 0,
      properties: { color: 'red' },
      state: {},
    },
    // Momentary "Next mode" pushbutton: wired between PB1 (D9) and GND.
    // Placed just above the matrix on board 1 right side.
    {
      id: 'btn1', type: 'switch',
      position: { x: 96 + 20 * 24, y: 9 * 17 + 8.5 }, rotation: 0,
      properties: { momentary: 1 },
      state: { closed: 0 },
    },
  ];

  const wires: Wire[] = [
    // === Power → left rail ===
    { id: 'n1', from: { componentId: 'power1', pinId: 'pos' }, to: bh(0, 14), waypoints: [], color: '#ef4444' },
    { id: 'n2', from: { componentId: 'power1', pinId: 'neg' }, to: bh(1, 14), waypoints: [], color: '#60a5fa' },
    { id: 'n3', from: bh(0, 14), to: bh(3, 14), waypoints: [], color: '#ef4444' },
    { id: 'n4', from: bh(1, 13), to: bh(3, 13), waypoints: [], color: '#60a5fa' },
    { id: 'n5', from: bh(0, 15), to: bh(9, 15), waypoints: [], color: '#ef4444' },
    { id: 'n6', from: bh(1, 13), to: bh(9, 13), waypoints: [], color: '#60a5fa' },

    // === AVR power ===
    { id: 'n7', from: { componentId: 'avr1', pinId: 'vcc' }, to: bh(9, 15), waypoints: [], color: '#ef4444' },
    { id: 'n8', from: { componentId: 'avr1', pinId: 'gnd' }, to: bh(9, 13), waypoints: [], color: '#60a5fa' },
    { id: 'n9', from: { componentId: 'avr1', pinId: 'avcc' }, to: bh(9, 15), waypoints: [], color: '#ef4444' },
    { id: 'n10', from: { componentId: 'avr1', pinId: 'agnd' }, to: bh(9, 13), waypoints: [], color: '#60a5fa' },
    { id: 'n11', from: { componentId: 'avr1', pinId: 'pc6' }, to: { componentId: 'avr1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },

    // Rail jumpers between groups
    ...railJumpers(0, 1, 2, 3, 'n0'),

    // === ATmega328P → Matrix Columns (Anodes) ===
    // PC0..PC4 (A0..A4) → C5..C1 (reversed).
    // render_text_character in necklace.ino stores glyph column y at
    // bitmap row (ROWS-1-y), i.e. it horizontally flips the character —
    // the original hardware un-flipped this by wiring ROW_PINS[0] to the
    // rightmost physical column of the matrix. We mirror that wiring so
    // the default text-scroll mode reads left-to-right.
    { id: 'n20', from: { componentId: 'avr1', pinId: 'pc0' }, to: { componentId: 'matrix1', pinId: 'c5' }, waypoints: [], color: '#22c55e' },
    { id: 'n21', from: { componentId: 'avr1', pinId: 'pc1' }, to: { componentId: 'matrix1', pinId: 'c4' }, waypoints: [], color: '#22c55e' },
    { id: 'n22', from: { componentId: 'avr1', pinId: 'pc2' }, to: { componentId: 'matrix1', pinId: 'c3' }, waypoints: [], color: '#22c55e' },
    { id: 'n23', from: { componentId: 'avr1', pinId: 'pc3' }, to: { componentId: 'matrix1', pinId: 'c2' }, waypoints: [], color: '#22c55e' },
    { id: 'n24', from: { componentId: 'avr1', pinId: 'pc4' }, to: { componentId: 'matrix1', pinId: 'c1' }, waypoints: [], color: '#22c55e' },

    // === ATmega328P → Matrix Rows (Cathodes) ===
    // PD2..PD7 → R1..R6, PB0 (D8) → R7
    { id: 'n30', from: { componentId: 'avr1', pinId: 'pd2' }, to: { componentId: 'matrix1', pinId: 'r1' }, waypoints: [], color: '#8b5cf6' },
    { id: 'n31', from: { componentId: 'avr1', pinId: 'pd3' }, to: { componentId: 'matrix1', pinId: 'r2' }, waypoints: [], color: '#8b5cf6' },
    { id: 'n32', from: { componentId: 'avr1', pinId: 'pd4' }, to: { componentId: 'matrix1', pinId: 'r3' }, waypoints: [], color: '#8b5cf6' },
    { id: 'n33', from: { componentId: 'avr1', pinId: 'pd5' }, to: { componentId: 'matrix1', pinId: 'r4' }, waypoints: [], color: '#8b5cf6' },
    { id: 'n34', from: { componentId: 'avr1', pinId: 'pd6' }, to: { componentId: 'matrix1', pinId: 'r5' }, waypoints: [], color: '#8b5cf6' },
    { id: 'n35', from: { componentId: 'avr1', pinId: 'pd7' }, to: { componentId: 'matrix1', pinId: 'r6' }, waypoints: [], color: '#8b5cf6' },
    { id: 'n36', from: { componentId: 'avr1', pinId: 'pb0' }, to: { componentId: 'matrix1', pinId: 'r7' }, waypoints: [], color: '#8b5cf6' },

    // === Matrix Power ===
    { id: 'n40', from: bh(0, 15), to: { componentId: 'matrix1', pinId: 'vcc' }, waypoints: [], color: '#ef4444' },
    { id: 'n41', from: bh(1, 15), to: { componentId: 'matrix1', pinId: 'gnd' }, waypoints: [], color: '#60a5fa' },

    // === Next-mode pushbutton: PB1 (D9) ↔ GND ===
    { id: 'n50', from: { componentId: 'btn1', pinId: 'a' }, to: { componentId: 'avr1', pinId: 'pb1' }, waypoints: [], color: '#fbbf24' },
    { id: 'n51', from: { componentId: 'btn1', pinId: 'b' }, to: bh(1, 13), waypoints: [], color: '#60a5fa' },
  ];

  return { components, wires };
}
