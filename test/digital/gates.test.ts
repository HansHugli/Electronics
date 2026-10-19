// 74xx gate behaviour: truth tables, output levels, floating inputs,
// thresholds, power pins, propagation, output drive.
import { describe, it, expect } from 'vitest';
import { Bench } from './bench';

const FN: Record<string, (a: boolean, b: boolean) => boolean> = {
  gate_and: (a, b) => a && b,
  gate_or: (a, b) => a || b,
  gate_nand: (a, b) => !(a && b),
};

function powered(type: string): Bench {
  const b = new Bench();
  b.power();
  b.add(type, 'u');
  b.hi('u.vcc').lo('u.gnd');
  return b;
}

describe('quad 2-input gates: full truth table on all four gates', () => {
  for (const type of Object.keys(FN)) {
    for (const [a, bb] of [[false, false], [false, true], [true, false], [true, true]]) {
      it(`${type} A=${+a} B=${+bb}`, () => {
        const b = powered(type);
        for (const g of ['1', '2', '3', '4']) {
          a ? b.hi(`u.${g}a`) : b.lo(`u.${g}a`);
          bb ? b.hi(`u.${g}b`) : b.lo(`u.${g}b`);
          b.probe(`u.${g}y`);
        }
        b.settle(3);
        for (const g of ['1', '2', '3', '4']) {
          const want = FN[type](a, bb);
          expect(b.v(`u.${g}y`) > 2.5).toBe(want);
          // Datasheet SN74HC at 5 V, |IO| <= 20 uA: VOH >= 4.4 V, VOL <= 0.1 V.
          if (want) expect(b.v(`u.${g}y`)).toBeGreaterThan(4.4);
          else expect(b.v(`u.${g}y`)).toBeLessThan(0.1);
        }
      });
    }
  }
});

describe('7404 hex inverter', () => {
  for (const a of [false, true]) {
    it(`A=${+a} on all six inverters`, () => {
      const b = powered('gate_not');
      for (const g of ['1', '2', '3', '4', '5', '6']) {
        a ? b.hi(`u.${g}a`) : b.lo(`u.${g}a`);
        b.probe(`u.${g}y`);
      }
      b.settle(3);
      for (const g of ['1', '2', '3', '4', '5', '6']) expect(b.v(`u.${g}y`) > 2.5).toBe(!a);
    });
  }
});

describe('floating inputs', () => {
  // Hans, 2026-10-18: the parts are 74HC CMOS. A floating CMOS input is
  // undefined (the datasheet says it must not float), so the engine flags it
  // and treats it as its previous level, which is LOW at power-up.
  // (The original test expected TTL behaviour: an open input reads HIGH.)
  it('74HC00 with both inputs open: flagged as floating, read as LOW, so the NAND output is HIGH', () => {
    const b = powered('gate_nand');
    b.probe('u.1y').settle(3);
    expect(b.v('u.1y')).toBeGreaterThan(4.4);
    const w = b.s('u').warning as { code: string; message: string } | undefined;
    expect(w?.code).toBe('floating_input');
  });
});

describe('input thresholds', () => {
  // Hans, 2026-10-18: 74HC thresholds — LOW below 0.3·VCC, HIGH above 0.7·VCC,
  // and in between the input keeps its previous level (hysteresis). The
  // original test expected TTL (VIH = 2.0 V, so 2.2 V read HIGH).
  function divider(rt: number, rb: number) {
    const b = powered('gate_not');
    b.add('resistor', 'rt', { resistance: rt });
    b.add('resistor', 'rb', { resistance: rb });
    b.wire('rt.a', 'pwr.pos').wire('rt.b', 'u.1a').wire('rb.a', 'u.1a').wire('rb.b', 'pwr.neg');
    b.probe('u.1a').probe('u.1y').settle(3);
    return b;
  }
  it('74HC04 input at 2.2 V (between 0.3 and 0.7 VCC) keeps its previous level: LOW at power-up, so output HIGH', () => {
    const b = divider(2800, 2200);
    expect(b.v('u.1a')).toBeCloseTo(2.2, 1);
    expect(b.v('u.1y')).toBeGreaterThan(4.4);
  });
  it('74HC04 input at 3.6 V (> 0.7 VCC) reads HIGH; at 1.2 V (< 0.3 VCC) reads LOW', () => {
    const hi = divider(1400, 3600);
    expect(hi.v('u.1a')).toBeCloseTo(3.6, 1);
    expect(hi.v('u.1y')).toBeLessThan(0.1);
    const lo = divider(3800, 1200);
    expect(lo.v('u.1a')).toBeCloseTo(1.2, 1);
    expect(lo.v('u.1y')).toBeGreaterThan(4.4);
  });
  it('hysteresis: an input that was HIGH stays HIGH when it drops into the 0.3-0.7 VCC band', () => {
    const b = powered('gate_not');
    b.add('potentiometer', 'p', { resistance: 10000, position: 20 }); // wiper 4.0 V
    b.wire('p.pin1', 'pwr.pos').wire('p.pin2', 'pwr.neg').wire('p.wiper', 'u.1a');
    b.probe('u.1y').settle(2);
    expect(b.v('u.1y')).toBeLessThan(0.1);
    b.comps.find((c) => c.id === 'p')!.properties.position = 50; // 2.5 V
    b.settle(2);
    expect(b.v('u.1y')).toBeLessThan(0.1);
    b.comps.find((c) => c.id === 'p')!.properties.position = 80; // 1.0 V
    b.settle(2);
    expect(b.v('u.1y')).toBeGreaterThan(4.4);
  });
  it('threshold scales with the chip VCC pin (HC at 3.3 V: 1.65 V input is undefined, 2.4 V is HIGH)', () => {
    const b = new Bench();
    b.power('pwr', 3.3);
    b.add('gate_not', 'u');
    b.hi('u.vcc').lo('u.gnd');
    b.add('resistor', 'rt', { resistance: 900 });
    b.add('resistor', 'rb', { resistance: 2400 });
    b.wire('rt.a', 'pwr.pos').wire('rt.b', 'u.1a').wire('rb.a', 'u.1a').wire('rb.b', 'pwr.neg');
    b.probe('u.1a').probe('u.1y').settle(3);
    expect(b.v('u.1a')).toBeCloseTo(2.4, 1);
    expect(b.v('u.1y')).toBeLessThan(0.5);
  });
});

describe('power pins', () => {
  it('gate with GND pin open cannot sink current (output pulled up by 1k stays high)', () => {
    const b = new Bench();
    b.power();
    b.add('gate_nand', 'u');
    b.hi('u.vcc'); // GND deliberately NOT connected
    b.hi('u.1a').hi('u.1b');
    b.add('resistor', 'rp', { resistance: 1000 });
    b.wire('rp.a', 'pwr.pos').wire('rp.b', 'u.1y');
    b.probe('u.1y').settle(3);
    // Real part: no return path through pin 7, output cannot pull low.
    expect(b.v('u.1y')).toBeGreaterThan(4);
  });
  it('gate with VCC pin open does not report a driven HIGH output', () => {
    const b = new Bench();
    b.power();
    b.add('gate_not', 'u');
    b.lo('u.gnd'); // VCC deliberately NOT connected
    b.lo('u.1a');
    b.settle(3);
    expect(b.s('u')['1y']).toBe(false);
  });
});

describe('propagation delay', () => {
  // tpd of a 74HC04 is ~10 ns; a 4-inverter chain is settled long before
  // one 100 ms simulator tick ends.
  it('4 chained inverters settle within one 100 ms tick', () => {
    const b = powered('gate_not');
    b.lo('u.1a').wire('u.1y', 'u.2a').wire('u.2y', 'u.3a').wire('u.3y', 'u.4a');
    b.probe('u.4y').settle(4); // settle with input LOW -> 4y LOW... (even count)
    const before = b.v('u.4y');
    b.unwire('u.1a').hi('u.1a');
    b.tick(1);
    const after1 = b.v('u.4y');
    let ticks = 1;
    while (b.v('u.4y') < 2.5 && ticks < 10) { b.tick(1); ticks++; }
    console.log(`  inverter chain: 4y before=${before.toFixed(2)}V, after 1 tick=${after1.toFixed(2)}V, ticks to settle=${ticks}`);
    expect(ticks).toBe(1);
  });
  it('NAND SR latch holds state', () => {
    const b = powered('gate_nand');
    // Q = 1y, Qbar = 2y ; /S = 1a, /R = 2b
    b.wire('u.1y', 'u.2a').wire('u.2y', 'u.1b');
    b.lo('u.1a').hi('u.2b').probe('u.1y').probe('u.2y').settle(4);
    expect(b.v('u.1y') > 2.5).toBe(true);
    b.unwire('u.1a').hi('u.1a').settle(4); // release /S: hold
    expect(b.v('u.1y') > 2.5).toBe(true);
    b.unwire('u.2b').lo('u.2b').settle(4); // /R low: reset
    expect(b.v('u.1y') > 2.5).toBe(false);
    b.unwire('u.2b').hi('u.2b').settle(4);
    expect(b.v('u.1y') > 2.5).toBe(false);
  });
});

describe('output drive', () => {
  // SN74HC00 abs max |IO| = 25 mA; spec'd drive 4 mA (VOH >= 3.84 V @ 4 mA).
  it('LED straight from a gate output (no resistor) is limited to <= 25 mA', () => {
    const b = powered('gate_not');
    b.lo('u.1a');
    b.add('led', 'd1');
    b.wire('d1.anode', 'u.1y').wire('d1.cathode', 'pwr.neg');
    b.settle(3);
    const mA = Number(b.s('d1').current) * 1000;
    console.log(`  LED current from gate output, no resistor: ${mA.toFixed(1)} mA`);
    expect(mA).toBeLessThanOrEqual(25);
  });
});
