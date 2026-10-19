import { ComponentDefinition, Pin } from '../types';

type DipPin = Omit<Pin, 'side' | 'offset' | 'number'>;

/**
 * Lay out a DIP package from its pins in datasheet order (pin 1 first).
 *
 * Real DIP chips are numbered counter-clockwise seen from above with the notch
 * at the top: pin 1 is top-left, pins 1..N/2 run DOWN the left side, and pins
 * N/2+1..N run back UP the right side, so pin N sits top-right across from
 * pin 1 (e.g. on a 7400, VCC pin 14 is across from pin 1 and GND pin 7 is
 * across from pin 8).
 */
export function dipPins(pins: DipPin[]): Pin[] {
  const half = pins.length / 2;
  return pins.map((p, i) => {
    const number = i + 1;
    if (i < half) {
      return { ...p, number, side: 'left' as const, offset: (2 * i + 1) / (2 * half) };
    }
    const j = i - half; // 0 = bottom of the right side
    return { ...p, number, side: 'right' as const, offset: 1 - (2 * j + 1) / (2 * half) };
  });
}

/** Pins of a quad 2-input gate (74HC00/08/32/02/86 share this layout). */
function quad2Pins(): Pin[] {
  return dipPins([
    { id: '1a', label: '1A', type: 'input' },
    { id: '1b', label: '1B', type: 'input' },
    { id: '1y', label: '1Y', type: 'output' },
    { id: '2a', label: '2A', type: 'input' },
    { id: '2b', label: '2B', type: 'input' },
    { id: '2y', label: '2Y', type: 'output' },
    { id: 'gnd', label: 'GND', type: 'ground' },
    { id: '3y', label: '3Y', type: 'output' },
    { id: '3a', label: '3A', type: 'input' },
    { id: '3b', label: '3B', type: 'input' },
    { id: '4y', label: '4Y', type: 'output' },
    { id: '4a', label: '4A', type: 'input' },
    { id: '4b', label: '4B', type: 'input' },
    { id: 'vcc', label: 'VCC', type: 'power' },
  ]);
}

/**
 * Typical LED forward voltage at 20 mA by colour (5 mm through-hole parts).
 * Used when the LED's Forward Voltage property is 0 ("from colour").
 */
export const LED_FORWARD_VOLTAGE: Record<string, number> = {
  red: 2.0,
  orange: 2.05,
  yellow: 2.1,
  green: 2.2,
  blue: 3.2,
  white: 3.2,
  purple: 3.3,
  pink: 3.2,
  uv: 3.4,
  ir: 1.3,
};

export const COMPONENT_DEFINITIONS: Record<string, ComponentDefinition> = {
  resistor: {
    type: 'resistor',
    label: 'Resistor',
    description: 'Limits current flow. Higher ohms = less current.',
    icon: 'R',
    category: 'passive',
    width: 1,
    height: 2,
    color: '#8B6914',
    pins: [
      { id: 'a', label: 'A', side: 'top', offset: 0.5, type: 'bidirectional' },
      { id: 'b', label: 'B', side: 'bottom', offset: 0.5, type: 'bidirectional' },
    ],
    properties: {
      resistance: { label: 'Resistance', default: 220, unit: 'Ω' },
    },
  },
  capacitor: {
    type: 'capacitor',
    label: 'Capacitor',
    description: 'Stores and releases electrical charge. Used for timing and filtering.',
    icon: 'C',
    category: 'passive',
    width: 1,
    height: 1,
    color: '#3b82f6',
    pins: [
      { id: 'pos', label: '+', side: 'top', offset: 0.5, type: 'bidirectional' },
      { id: 'neg', label: '-', side: 'bottom', offset: 0.5, type: 'bidirectional' },
    ],
    properties: {
      capacitance: { label: 'Capacitance', default: 100, unit: 'μF' },
    },
  },
  led: {
    type: 'led',
    label: 'LED',
    description: 'Light-emitting diode. Glows when current flows through it. Needs a resistor in series.',
    icon: '💡',
    category: 'output',
    width: 1,
    height: 1,
    color: '#f87171',
    pins: [
      { id: 'anode', label: '+', side: 'top', offset: 0.5, type: 'input' },
      { id: 'cathode', label: '-', side: 'bottom', offset: 0.5, type: 'output' },
    ],
    properties: {
      // 0 = take the typical value for the colour (red 2.0 V ... blue 3.2 V)
      forwardVoltage: { label: 'Forward Voltage (0 = from colour)', default: 0, unit: 'V' },
      color: { label: 'Color', default: 'red' },
    },
  },
  switch: {
    type: 'switch',
    label: 'Switch',
    description: 'Click to toggle on/off. Connects or breaks a circuit. Set Momentary to 1 for a pushbutton (closed only while held).',
    icon: '/',
    category: 'input',
    width: 1,
    height: 1,
    color: '#2d2d2d',
    pins: [
      { id: 'a', label: 'A', side: 'top', offset: 0.5, type: 'bidirectional' },
      { id: 'b', label: 'B', side: 'bottom', offset: 0.5, type: 'bidirectional' },
    ],
    properties: {
      momentary: { label: 'Momentary', default: 0 },
    },
  },
  timer: {
    type: 'timer',
    label: '555 Timer',
    description: 'Generates clock pulses. Used for blinking, timing, and oscillation.',
    icon: '~',
    chipLabel: '555',
    category: 'active',
    width: 2,
    height: 4,
    color: '#4a4a4a',
    // NE555: 1 GND, 2 TRIG, 3 OUT, 4 RESET, 5 CTRL, 6 THR, 7 DIS, 8 VCC
    pins: dipPins([
      { id: 'gnd',   label: 'GND',  type: 'ground' },
      { id: 'trig',  label: 'TRIG', type: 'input' },
      { id: 'out',   label: 'OUT',  type: 'output' },
      { id: 'reset', label: 'RST',  type: 'input' },
      { id: 'ctrl',  label: 'CTRL', type: 'input' },
      { id: 'thr',   label: 'THR',  type: 'input' },
      { id: 'dis',   label: 'DIS',  type: 'output' },
      { id: 'vcc',   label: 'VCC',  type: 'power' },
    ]),
    properties: {},
  },
  power: {
    type: 'power',
    label: 'Power Supply',
    description: 'DC or AC voltage source. Powers your circuit.',
    icon: '⚡',
    category: 'power',
    width: 2,
    height: 4,
    color: '#4ade80',
    pins: [
      { id: 'pos', label: '+', side: 'right', offset: 0.25, type: 'power' },
      { id: 'neg', label: '-', side: 'right', offset: 0.75, type: 'ground' },
    ],
    properties: {
      voltage: { label: 'Voltage', default: 5, unit: 'V' },
      mode: { label: 'Mode', default: 'DC' },
      waveform: { label: 'Waveform', default: 'square' },
      frequency: { label: 'Frequency (AC)', default: 1, unit: 'Hz' },
    },
  },
  potentiometer: {
    type: 'potentiometer',
    label: 'Potentiometer',
    description: 'Variable resistor with a dial. Adjusts voltage or signal level.',
    icon: '🎛',
    category: 'passive',
    width: 1,
    height: 2,
    color: '#0ea5e9',
    pins: [
      { id: 'pin1', label: '1', side: 'top', offset: 0.5, type: 'bidirectional' },
      { id: 'wiper', label: 'W', side: 'right', offset: 0.5, type: 'bidirectional' },
      { id: 'pin2', label: '2', side: 'bottom', offset: 0.5, type: 'bidirectional' },
    ],
    properties: {
      resistance: { label: 'Resistance', default: 10000, unit: 'Ω' },
      position: { label: 'Position', default: 50, unit: '%' },
    },
  },
  display7seg: {
    type: 'display7seg',
    label: '7-Segment Display',
    description: 'Shows digits 0-9. Each segment is an LED (common cathode): it needs current, so drive it from a chip or through a resistor.',
    icon: '8.',
    chipLabel: '7-Seg',
    category: 'active',
    width: 2,
    height: 5,
    color: '#1a1a1a',
    // Common-cathode 10-pin display (e.g. 5161AS): 1 e, 2 d, 3 COM, 4 c, 5 DP,
    // 6 b, 7 a, 8 COM, 9 f, 10 g. Both COM pins are connected inside the part.
    // (Pin 8 keeps the id 'vcc' so saved circuits still load; it is a COM pin.)
    pins: dipPins([
      { id: 'e',   label: 'e',   type: 'input' },
      { id: 'd',   label: 'd',   type: 'input' },
      { id: 'gnd', label: 'COM', type: 'ground' },
      { id: 'c',   label: 'c',   type: 'input' },
      { id: 'dp',  label: 'DP',  type: 'input' },
      { id: 'b',   label: 'b',   type: 'input' },
      { id: 'a',   label: 'a',   type: 'input' },
      { id: 'vcc', label: 'COM', type: 'ground' },
      { id: 'f',   label: 'f',   type: 'input' },
      { id: 'g',   label: 'g',   type: 'input' },
    ]),
    properties: {
      color: { label: 'Color', default: 'red' },
    },
  },
  cd4026: {
    type: 'cd4026',
    label: 'CD4026 Counter',
    description: 'Counts 0-9 on clock pulses. Drives a 7-segment display directly.',
    icon: '#',
    chipLabel: '4026',
    category: 'active',
    width: 2,
    height: 8,
    color: '#4a4a4a',
    // CD4026B (TI SCHS031): 1 CLK, 2 CLK INH, 3 DEI, 4 DEO, 5 CO, 6 f, 7 g,
    // 8 VSS, 9 d, 10 a, 11 e, 12 b, 13 c, 14 ungated C, 15 RESET, 16 VDD.
    pins: dipPins([
      { id: 'clk',   label: 'CLK',  type: 'input' },
      { id: 'inh',   label: 'INH',  type: 'input' },
      { id: 'en',    label: 'DEI',  type: 'input' },
      { id: 'deo',   label: 'DEO',  type: 'output' },
      { id: 'co',    label: 'CO',   type: 'output' },
      { id: 'out_f', label: 'f',    type: 'output' },
      { id: 'out_g', label: 'g',    type: 'output' },
      { id: 'gnd',   label: 'VSS',  type: 'ground' },
      { id: 'out_d', label: 'd',    type: 'output' },
      { id: 'out_a', label: 'a',    type: 'output' },
      { id: 'out_e', label: 'e',    type: 'output' },
      { id: 'out_b', label: 'b',    type: 'output' },
      { id: 'out_c', label: 'c',    type: 'output' },
      { id: 'ung',   label: 'C̄',    type: 'output' },
      { id: 'rst',   label: 'RST',  type: 'input' },
      { id: 'vcc',   label: 'VDD',  type: 'power' },
    ]),
    properties: {},
  },
  multimeter: {
    type: 'multimeter',
    label: 'Multimeter',
    description: 'Measures voltage (connect across a part) or current (connect in series, like a wire in the path).',
    icon: 'V',
    category: 'measurement',
    width: 2,
    height: 2,
    color: '#1e293b',
    pins: [
      { id: 'pos', label: '+', side: 'top', offset: 0.25, type: 'input' },
      { id: 'neg', label: '-', side: 'top', offset: 0.75, type: 'input' },
    ],
    properties: {
      mode: { label: 'Mode', default: 'voltage' },
    },
  },

  // --- Logic gates (74HC CMOS, DIP-14) ---
  gate_and: {
    type: 'gate_and',
    label: 'AND Gate (74HC08)',
    description: 'Output is HIGH only when both inputs are HIGH. 4 gates in one chip.',
    icon: '&',
    chipLabel: 'HC08',
    category: 'active',
    width: 2,
    height: 7,
    color: '#4a4a4a',
    pins: quad2Pins(),
    properties: {},
  },
  gate_or: {
    type: 'gate_or',
    label: 'OR Gate (74HC32)',
    description: 'Output is HIGH when either input is HIGH. 4 gates in one chip.',
    icon: '|',
    chipLabel: 'HC32',
    category: 'active',
    width: 2,
    height: 7,
    color: '#4a4a4a',
    pins: quad2Pins(),
    properties: {},
  },
  gate_nand: {
    type: 'gate_nand',
    label: 'NAND Gate (74HC00)',
    description: 'Opposite of AND. Output is LOW only when both inputs are HIGH.',
    icon: '!&',
    chipLabel: 'HC00',
    category: 'active',
    width: 2,
    height: 7,
    color: '#4a4a4a',
    pins: quad2Pins(),
    properties: {},
  },
  gate_not: {
    type: 'gate_not',
    label: 'NOT Gate (74HC04)',
    description: 'Inverts the input. HIGH becomes LOW and vice versa. 6 inverters.',
    icon: '!',
    chipLabel: 'HC04',
    category: 'active',
    width: 2,
    height: 7,
    color: '#4a4a4a',
    // SN74HC04: 1 1A, 2 1Y, 3 2A, 4 2Y, 5 3A, 6 3Y, 7 GND, 8 4Y, 9 4A,
    // 10 5Y, 11 5A, 12 6Y, 13 6A, 14 VCC
    pins: dipPins([
      { id: '1a', label: '1A', type: 'input' },
      { id: '1y', label: '1Y', type: 'output' },
      { id: '2a', label: '2A', type: 'input' },
      { id: '2y', label: '2Y', type: 'output' },
      { id: '3a', label: '3A', type: 'input' },
      { id: '3y', label: '3Y', type: 'output' },
      { id: 'gnd', label: 'GND', type: 'ground' },
      { id: '4y', label: '4Y', type: 'output' },
      { id: '4a', label: '4A', type: 'input' },
      { id: '5y', label: '5Y', type: 'output' },
      { id: '5a', label: '5A', type: 'input' },
      { id: '6y', label: '6Y', type: 'output' },
      { id: '6a', label: '6A', type: 'input' },
      { id: 'vcc', label: 'VCC', type: 'power' },
    ]),
    properties: {},
  },

  // --- Op-Amp (LM741, DIP-8) ---
  opamp: {
    type: 'opamp',
    label: 'Op-Amp (LM741)',
    description: 'Amplifies the difference between two inputs. Used for audio, filters, comparators.',
    icon: '△',
    chipLabel: 'LM741',
    category: 'active',
    width: 2,
    height: 4,
    color: '#4a4a4a',
    // LM741: 1 OFFSET N1, 2 IN-, 3 IN+, 4 V-, 5 OFFSET N2, 6 OUT, 7 V+, 8 NC
    pins: dipPins([
      { id: 'ofs1',   label: 'OFS1', type: 'input' },
      { id: 'in_neg', label: 'IN-',  type: 'input' },
      { id: 'in_pos', label: 'IN+',  type: 'input' },
      { id: 'v_neg',  label: 'V-',   type: 'ground' },
      { id: 'ofs2',   label: 'OFS2', type: 'input' },
      { id: 'out',    label: 'OUT',  type: 'output' },
      { id: 'v_pos',  label: 'V+',   type: 'power' },
      { id: 'nc',     label: 'NC',   type: 'input' },
    ]),
    properties: {
      gain: { label: 'Open-loop gain', default: 100000 },
    },
  },

  // --- ATmega328P (Arduino Uno MCU, DIP-28) ---
  atmega328: {
    type: 'atmega328',
    label: 'ATmega328P',
    description: 'Arduino Uno brain. Load a .hex program to control pins with code.',
    icon: 'Av',
    chipLabel: '328P',
    category: 'active',
    width: 2,
    height: 14,
    color: '#2d2d2d',
    pins: dipPins([
      { id: 'pc6',  label: 'RST',  type: 'input' },
      { id: 'pd0',  label: 'D0',   type: 'bidirectional' },
      { id: 'pd1',  label: 'D1',   type: 'bidirectional' },
      { id: 'pd2',  label: 'D2',   type: 'bidirectional' },
      { id: 'pd3',  label: 'D3',   type: 'bidirectional' },
      { id: 'pd4',  label: 'D4',   type: 'bidirectional' },
      { id: 'vcc',  label: 'VCC',  type: 'power' },
      { id: 'gnd',  label: 'GND',  type: 'ground' },
      { id: 'pb6',  label: 'XTAL1', type: 'input' },
      { id: 'pb7',  label: 'XTAL2', type: 'output' },
      { id: 'pd5',  label: 'D5',   type: 'bidirectional' },
      { id: 'pd6',  label: 'D6',   type: 'bidirectional' },
      { id: 'pd7',  label: 'D7',   type: 'bidirectional' },
      { id: 'pb0',  label: 'D8',   type: 'bidirectional' },
      { id: 'pb1',  label: 'D9',   type: 'bidirectional' },
      { id: 'pb2',  label: 'D10',  type: 'bidirectional' },
      { id: 'pb3',  label: 'D11',  type: 'bidirectional' },
      { id: 'pb4',  label: 'D12',  type: 'bidirectional' },
      { id: 'pb5',  label: 'D13',  type: 'bidirectional' },
      { id: 'avcc', label: 'AVCC', type: 'power' },
      { id: 'aref', label: 'AREF', type: 'input' },
      { id: 'agnd', label: 'GND',  type: 'ground' },
      { id: 'pc0',  label: 'A0',   type: 'bidirectional' },
      { id: 'pc1',  label: 'A1',   type: 'bidirectional' },
      { id: 'pc2',  label: 'A2',   type: 'bidirectional' },
      { id: 'pc3',  label: 'A3',   type: 'bidirectional' },
      { id: 'pc4',  label: 'A4',   type: 'bidirectional' },
      { id: 'pc5',  label: 'A5',   type: 'bidirectional' },
    ]),
    properties: {
      clockSpeed: { label: 'Clock', default: 16000000, unit: 'Hz' },
    },
  },

  // --- 5x7 LED Matrix (DIP-14) ---
  ledmatrix: {
    type: 'ledmatrix',
    label: '5x7 LED Matrix',
    description: '35 tiny LEDs in a grid. Columns are anodes (+), rows are cathodes (-). Display patterns, letters, or animations.',
    icon: ':::',
    chipLabel: 'LTP747C-01',
    category: 'active',
    width: 2,
    height: 7,
    color: '#1a1a1a',
    pins: dipPins([
      { id: 'r5', label: 'R5', type: 'input' },
      { id: 'r7', label: 'R7', type: 'input' },
      { id: 'c2', label: 'C2', type: 'input' },
      { id: 'c3', label: 'C3', type: 'input' },
      { id: 'r6', label: 'R6', type: 'input' },
      { id: 'c4', label: 'C4', type: 'input' },
      { id: 'r1', label: 'R1', type: 'input' },
      { id: 'c5', label: 'C5', type: 'input' },
      { id: 'r4', label: 'R4', type: 'input' },
      { id: 'c1', label: 'C1', type: 'input' },
      { id: 'r2', label: 'R2', type: 'input' },
      { id: 'r3', label: 'R3', type: 'input' },
      { id: 'nc', label: 'NC', type: 'input' },
      { id: 'nc2', label: 'NC', type: 'input' },
    ]),
    properties: {
      color: { label: 'Color', default: 'red' },
    },
  },

  // --- Function Generator ---
  funcgen: {
    type: 'funcgen',
    label: 'Function Generator',
    description: 'Outputs sine, square, triangle, or sawtooth waves at adjustable frequency. Its GND terminal is the circuit ground when there is no Power Supply.',
    icon: '∿',
    category: 'power',
    width: 2,
    height: 4,
    color: '#8b5cf6',
    pins: [
      { id: 'out', label: 'OUT', side: 'right', offset: 0.25, type: 'output' },
      { id: 'gnd', label: 'GND', side: 'right', offset: 0.75, type: 'ground' },
    ],
    properties: {
      amplitude: { label: 'Amplitude', default: 5, unit: 'V' },
      frequency: { label: 'Frequency', default: 1, unit: 'Hz' },
      waveform: { label: 'Waveform', default: 'sine' },
      offset: { label: 'DC Offset', default: 0, unit: 'V' },
    },
  },

  // --- 74HC595 Shift Register (DIP-16) ---
  shift_register: {
    type: 'shift_register',
    label: 'Shift Register (74HC595)',
    description: '8-bit serial-in, parallel-out. Converts 3 wires into 8 outputs.',
    icon: '>>',
    chipLabel: 'HC595',
    category: 'active',
    width: 2,
    height: 8,
    color: '#4a4a4a',
    // SN74HC595: 1 QB, 2 QC, 3 QD, 4 QE, 5 QF, 6 QG, 7 QH, 8 GND, 9 QH',
    // 10 SRCLR, 11 SRCLK, 12 RCLK, 13 OE, 14 SER, 15 QA, 16 VCC
    pins: dipPins([
      { id: 'qb',    label: 'QB',    type: 'output' },
      { id: 'qc',    label: 'QC',    type: 'output' },
      { id: 'qd',    label: 'QD',    type: 'output' },
      { id: 'qe',    label: 'QE',    type: 'output' },
      { id: 'qf',    label: 'QF',    type: 'output' },
      { id: 'qg',    label: 'QG',    type: 'output' },
      { id: 'qh',    label: 'QH',    type: 'output' },
      { id: 'gnd',   label: 'GND',   type: 'ground' },
      { id: 'qh_p',  label: "QH'",   type: 'output' },
      { id: 'srclr', label: 'SRCLR', type: 'input' },
      { id: 'srclk', label: 'SRCLK', type: 'input' },
      { id: 'rclk',  label: 'RCLK',  type: 'input' },
      { id: 'oe',    label: 'OE',    type: 'input' },
      { id: 'ser',   label: 'SER',   type: 'input' },
      { id: 'qa',    label: 'QA',    type: 'output' },
      { id: 'vcc',   label: 'VCC',   type: 'power' },
    ]),
    properties: {},
  },

  // --- 74HC74 D Flip-Flop (DIP-14, dual) ---
  flipflop_d: {
    type: 'flipflop_d',
    label: 'D Flip-Flop (74HC74)',
    description: 'Stores one bit. Output follows D input on clock rising edge. Dual in one chip.',
    icon: 'D>',
    chipLabel: 'HC74',
    category: 'active',
    width: 2,
    height: 7,
    color: '#4a4a4a',
    // SN74HC74: 1 1CLR, 2 1D, 3 1CLK, 4 1PRE, 5 1Q, 6 1Q̄, 7 GND, 8 2Q̄,
    // 9 2Q, 10 2PRE, 11 2CLK, 12 2D, 13 2CLR, 14 VCC
    pins: dipPins([
      { id: '1clr', label: '1CLR', type: 'input' },
      { id: '1d',   label: '1D',   type: 'input' },
      { id: '1clk', label: '1CLK', type: 'input' },
      { id: '1pre', label: '1PRE', type: 'input' },
      { id: '1q',   label: '1Q',   type: 'output' },
      { id: '1qn',  label: '1Q!',  type: 'output' },
      { id: 'gnd',  label: 'GND',  type: 'ground' },
      { id: '2qn',  label: '2Q!',  type: 'output' },
      { id: '2q',   label: '2Q',   type: 'output' },
      { id: '2pre', label: '2PRE', type: 'input' },
      { id: '2clk', label: '2CLK', type: 'input' },
      { id: '2d',   label: '2D',   type: 'input' },
      { id: '2clr', label: '2CLR', type: 'input' },
      { id: 'vcc',  label: 'VCC',  type: 'power' },
    ]),
    properties: {},
  },

  // --- 7805 Voltage Regulator (TO-220, 3 pins) ---
  vreg: {
    type: 'vreg',
    label: 'Voltage Regulator',
    description: 'Outputs a steady voltage as long as the input is at least 2 V higher. 7805 outputs 5V.',
    icon: '5V',
    category: 'passive',
    width: 1,
    height: 2,
    color: '#0891b2',
    pins: [
      { id: 'vin',  label: 'IN',  side: 'top',    offset: 0.5, type: 'input' },
      { id: 'gnd',  label: 'GND', side: 'right',  offset: 0.5, type: 'ground' },
      { id: 'vout', label: 'OUT', side: 'bottom', offset: 0.5, type: 'output' },
    ],
    properties: {
      outputVoltage: { label: 'Output Voltage', default: 5, unit: 'V' },
      dropout: { label: 'Dropout', default: 2, unit: 'V' },
    },
  },
};

export const COMPONENT_CATEGORIES = [
  { id: 'power', label: 'Power' },
  { id: 'passive', label: 'Passive' },
  { id: 'input', label: 'Input' },
  { id: 'output', label: 'Output' },
  { id: 'active', label: 'Chips' },
  { id: 'measurement', label: 'Measurement' },
] as const;
