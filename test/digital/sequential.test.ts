// Sequential / mixed chips without an MCU: CD4026, 74HC595, 74HC74, 555, 7805,
// 7-segment display. Inputs are driven by re-wiring pins to the rails between
// ticks (a tick is 100 ms of simulated time, as in App.tsx).
import { describe, it, expect } from 'vitest';
import { Bench, seg7 } from './bench';

/** Drive a pin to a level by replacing its rail wire. */
function drive(b: Bench, pin: string, high: boolean): void {
  b.drive(pin, high);
}
function pulse(b: Bench, pin: string): void {
  drive(b, pin, true); b.tick(1);
  drive(b, pin, false); b.tick(1);
}

function counter(): Bench {
  const b = new Bench();
  b.power();
  b.add('cd4026', 'u');
  b.hi('u.vcc').lo('u.gnd').lo('u.clk').lo('u.inh').hi('u.en').lo('u.rst');
  b.add('display7seg', 'd');
  for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) b.wire(`u.out_${s}`, `d.${s}`);
  b.lo('d.gnd');
  b.tick(2);
  return b;
}

describe('CD4026 decade counter / 7-segment driver', () => {
  it('counts rising CLK edges and decodes to 7 segments', () => {
    const b = counter();
    const DIG = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
    for (let n = 1; n <= 12; n++) {
      pulse(b, 'u.clk');
      expect(Number(b.s('u').count)).toBe(n % 10);
      expect(seg7(b.s('d'))).toBe(DIG[n % 10]);
    }
  });
  it('RESET high forces 0; CLOCK INHIBIT high blocks counting', () => {
    const b = counter();
    pulse(b, 'u.clk'); pulse(b, 'u.clk');
    drive(b, 'u.inh', true); pulse(b, 'u.clk');
    expect(Number(b.s('u').count)).toBe(2);
    drive(b, 'u.inh', false);
    drive(b, 'u.rst', true); b.tick(1);
    expect(Number(b.s('u').count)).toBe(0);
  });
  it('DISPLAY ENABLE IN low blanks all segment outputs', () => {
    const b = counter();
    pulse(b, 'u.clk'); pulse(b, 'u.clk'); pulse(b, 'u.clk');
    drive(b, 'u.en', false); b.tick(2);
    expect(seg7(b.s('d'))).toBe('');
  });
  it('CARRY OUT rises on the 9->0 transition, so a cascaded 4026 counts tens', () => {
    const b = counter();
    b.add('cd4026', 't');
    b.hi('t.vcc').lo('t.gnd').lo('t.inh').hi('t.en').lo('t.rst').wire('u.co', 't.clk');
    b.tick(2);
    for (let i = 0; i < 5; i++) pulse(b, 'u.clk');
    const tensAt5 = Number(b.s('t').count);
    for (let i = 0; i < 7; i++) pulse(b, 'u.clk');
    const tensAt12 = Number(b.s('t').count);
    console.log(`  cascade: tens digit after 5 clocks=${tensAt5}, after 12 clocks=${tensAt12} (datasheet 0, 1)`);
    expect([tensAt5, tensAt12]).toEqual([0, 1]);
  });
  it('an unpowered 4026 (VDD open) does not count or light segments', () => {
    const b = new Bench();
    b.power();
    b.add('cd4026', 'u');
    b.lo('u.gnd').lo('u.clk').lo('u.inh').hi('u.en').lo('u.rst'); // no VDD
    b.add('led', 'L'); b.add('resistor', 'r', { resistance: 330 });
    b.wire('u.out_b', 'r.a').wire('r.b', 'L.anode').wire('L.cathode', 'pwr.neg');
    b.tick(2);
    pulse(b, 'u.clk');
    expect(Number(b.s('u').count ?? 0)).toBe(0);
  });
});

describe('7-segment display', () => {
  it('a lit segment draws current (segment wired straight to 5 V must not light "for free")', () => {
    const b = new Bench();
    b.power();
    b.add('display7seg', 'd');
    b.hi('d.a').lo('d.gnd');
    b.tick(2);
    const lit = seg7(b.s('d'));
    const amps = Math.abs(Number(b.s('pwr').current));
    console.log(`  segment a direct on 5 V: lit='${lit}', supply current=${(amps * 1000).toFixed(3)} mA`);
    expect(lit).toBe('a');
    expect(amps).toBeGreaterThan(0.001);
  });
});

function sreg(): Bench {
  const b = new Bench();
  b.power();
  b.add('shift_register', 'u');
  b.hi('u.vcc').lo('u.gnd').hi('u.srclr').lo('u.oe').lo('u.ser').lo('u.srclk').lo('u.rclk');
  for (const q of ['qa', 'qb', 'qc', 'qd', 'qe', 'qf', 'qg', 'qh', 'qh_p']) b.probe(`u.${q}`);
  b.tick(2);
  return b;
}
function shiftIn(b: Bench, bits: number[], pre = 'u'): void {
  for (const bit of bits) {
    drive(b, `${pre}.ser`, !!bit);
    pulse(b, `${pre}.srclk`);
  }
}
const outs = (b: Bench) => ['qa', 'qb', 'qc', 'qd', 'qe', 'qf', 'qg', 'qh'].map((q) => (b.v(`u.${q}`) > 2.5 ? 1 : 0)).join('');

describe('74HC595 (no MCU)', () => {
  it('first bit shifted in ends up on QH after 8 SRCLK edges; outputs only change on RCLK', () => {
    const b = sreg();
    shiftIn(b, [1, 0, 1, 1, 0, 0, 0, 1]);
    expect(outs(b)).toBe('00000000'); // storage register not yet loaded
    expect(b.v('u.qh_p') > 2.5).toBe(true); // QH' = shift stage H (first bit)
    pulse(b, 'u.rclk');
    expect(outs(b)).toBe('10001101'); // QA..QH = last..first
  });
  it('SRCLR low clears the shift register but not the storage register', () => {
    const b = sreg();
    shiftIn(b, [1, 1, 1, 1, 1, 1, 1, 1]); pulse(b, 'u.rclk');
    drive(b, 'u.srclr', false); b.tick(1); drive(b, 'u.srclr', true); b.tick(1);
    expect(outs(b)).toBe('11111111');
    expect(b.v('u.qh_p') > 2.5).toBe(false);
    pulse(b, 'u.rclk');
    expect(outs(b)).toBe('00000000');
  });
  it('OE high puts QA-QH in Hi-Z; OE low again shows the stored byte without a new RCLK', () => {
    const b = sreg();
    shiftIn(b, [0, 0, 0, 0, 0, 0, 0, 1]); pulse(b, 'u.rclk');
    expect(outs(b)).toBe('10000000');
    // 10 k pull-up on QB: Hi-Z output must float up to ~5 V while OE is high
    b.add('resistor', 'pu', { resistance: 10000 });
    b.wire('pu.a', 'pwr.pos').wire('pu.b', 'u.qb');
    drive(b, 'u.oe', true); pulse(b, 'u.rclk');
    const qbHiZ = b.v('u.qb');
    drive(b, 'u.oe', false); b.tick(2);
    console.log(`  OE high: QB with 10k pull-up = ${qbHiZ.toFixed(2)} V; after OE low: ${outs(b)}`);
    expect(qbHiZ).toBeGreaterThan(4);
    expect(outs(b)).toBe('10000000');
  });
  it('two 595s daisy-chained through QH\' -> SER (shared clocks) shift 16 bits', () => {
    const b = sreg();
    b.add('shift_register', 'v');
    b.hi('v.vcc').lo('v.gnd').hi('v.srclr').lo('v.oe');
    b.wire('u.qh_p', 'v.ser').wire('u.srclk', 'v.srclk').wire('u.rclk', 'v.rclk');
    b.tick(1);
    shiftIn(b, [1, 1, 0, 0, 0, 0, 0, 0, /* -> v */ 0, 0, 0, 0, 0, 0, 0, 1 /* -> u */]);
    pulse(b, 'u.rclk');
    expect(Number(b.s('u').outputBits)).toBe(0b00000001);
    expect(Number(b.s('v').outputBits)).toBe(0b11000000); // first two bits on v.QG,v.QH
  });
});

function dff(): Bench {
  const b = new Bench();
  b.power();
  b.add('flipflop_d', 'u');
  b.hi('u.vcc').lo('u.gnd').hi('u.1pre').hi('u.1clr').lo('u.1d').lo('u.1clk');
  b.hi('u.2pre').hi('u.2clr').lo('u.2d').lo('u.2clk');
  b.probe('u.1q').probe('u.1qn');
  b.tick(2);
  return b;
}
const q = (b: Bench) => [b.v('u.1q') > 2.5 ? 1 : 0, b.v('u.1qn') > 2.5 ? 1 : 0];

describe('74HC74 dual D flip-flop', () => {
  it('captures D on the rising edge only', () => {
    const b = dff();
    drive(b, 'u.1d', true); b.tick(1);
    expect(q(b)).toEqual([0, 1]); // D change alone does nothing
    drive(b, 'u.1clk', true); b.tick(2);
    expect(q(b)).toEqual([1, 0]);
    drive(b, 'u.1d', false); b.tick(2); // CLK still high: no change
    expect(q(b)).toEqual([1, 0]);
    drive(b, 'u.1clk', false); b.tick(2); // falling edge: no change
    expect(q(b)).toEqual([1, 0]);
    drive(b, 'u.1clk', true); b.tick(2);
    expect(q(b)).toEqual([0, 1]);
  });
  it('PRE low sets, CLR low clears, asynchronously', () => {
    const b = dff();
    drive(b, 'u.1pre', false); b.tick(2);
    expect(q(b)).toEqual([1, 0]);
    drive(b, 'u.1pre', true); drive(b, 'u.1clr', false); b.tick(2);
    expect(q(b)).toEqual([0, 1]);
  });
  it('PRE and CLR both low: Q and Q-bar both HIGH (datasheet function table)', () => {
    const b = dff();
    drive(b, 'u.1pre', false); drive(b, 'u.1clr', false); b.tick(2);
    expect(q(b)).toEqual([1, 1]);
  });
  it('Q-bar -> D makes a divide-by-two', () => {
    const b = dff();
    b.unwire('u.1d').wire('u.1qn', 'u.1d'); b.tick(2);
    const seq: number[] = [];
    for (let i = 0; i < 4; i++) { pulse(b, 'u.1clk'); b.tick(1); seq.push(q(b)[0]); }
    expect(seq).toEqual([1, 0, 1, 0]);
  });
});

describe('NE555', () => {
  function astable(): Bench {
    const b = new Bench();
    b.power();
    b.add('timer', 'u');
    b.add('resistor', 'ra', { resistance: 1000 });
    b.add('resistor', 'rb', { resistance: 10000 });
    b.add('capacitor', 'c', { capacitance: 100 });
    b.hi('u.vcc').lo('u.gnd');
    b.wire('ra.a', 'pwr.pos').wire('ra.b', 'u.dis').wire('rb.a', 'u.dis').wire('rb.b', 'u.thr')
      .wire('u.thr', 'u.trig').wire('c.pos', 'u.thr').wire('c.neg', 'pwr.neg');
    return b;
  }
  it('astable period = 0.693*(Ra+2Rb)*C within 10 %', () => {
    const b = astable(); b.hi('u.reset');
    const edges: number[] = [];
    let prev = 0;
    for (let i = 0; i < 200; i++) {
      b.tick(1);
      const o = Number(b.s('u').outputHigh);
      if (o === 1 && prev === 0) edges.push(b.timeMs);
      prev = o;
    }
    const periods = edges.slice(2).map((t, i) => t - edges[i + 1]);
    const avg = periods.reduce((x, y) => x + y, 0) / periods.length;
    console.log(`  555 period measured ${avg.toFixed(0)} ms, datasheet ${(0.693 * 21000 * 100e-6 * 1000).toFixed(0)} ms`);
    expect(Math.abs(avg - 1455) / 1455).toBeLessThan(0.1);
  });
  it('RESET (pin 4) held low forces OUT low', () => {
    const b = astable(); b.lo('u.reset');
    let highs = 0;
    for (let i = 0; i < 40; i++) { b.tick(1); highs += Number(b.s('u').outputHigh); }
    expect(highs).toBe(0);
  });
});

describe('7805 regulator', () => {
  function reg(vin: number, connectVin = true): Bench {
    const b = new Bench();
    b.power('pwr', vin);
    b.add('vreg', 'u');
    if (connectVin) b.wire('u.vin', 'pwr.pos');
    b.lo('u.gnd');
    b.add('resistor', 'load', { resistance: 1000 });
    b.wire('load.a', 'u.vout').wire('load.b', 'pwr.neg');
    b.probe('u.vout').tick(2);
    return b;
  }
  it('9 V in -> 5 V out', () => { expect(reg(9).v('u.vout')).toBeCloseTo(5, 1); });
  it('IN open -> no output', () => { expect(reg(9, false).v('u.vout')).toBeLessThan(0.5); });
  it('6 V in (below 7 V min) -> output drops out below 5 V', () => {
    const v = reg(6).v('u.vout');
    console.log(`  7805 with 6 V in: ${v.toFixed(2)} V out`);
    expect(v).toBeLessThan(4.6);
  });
  it('quiescent current at 9 V in with 5 mA load is < 15 mA total', () => {
    const b = reg(9);
    const mA = Math.abs(Number(b.s('pwr').current)) * 1000;
    console.log(`  7805 input current with 5 mA load: ${mA.toFixed(1)} mA`);
    expect(mA).toBeLessThan(15);
  });
});
