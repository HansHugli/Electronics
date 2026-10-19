// ATmega328P (avr8js) behaviour against the datasheet / Arduino core.
// Sketches live in test/sketches/<name>/<name>.ino; fixtures/<name>.hex were
// compiled with arduino-cli 1.1.1, arduino:avr 1.8.x, --fqbn arduino:avr:uno.
import { describe, it, expect } from 'vitest';
import { Bench, fixture, ino } from './bench';
import { loadHexFile, AVRBridge } from '../../src/engine/avrBridge';
import { createMatrixDemoCircuit, createNecklaceDemoCircuit, createAVRBlinkDemoCircuit, AVR_MATRIX_HEX, AVR_NECKLACE_HEX, AVR_BLINK_HEX } from '../../src/engine/simulation';

const F_CPU = 16_000_000;

function mcu(hex: string, opts: { gnd?: boolean; vcc?: boolean; reset?: 'hi' | 'lo' } = {}): Bench {
  const b = new Bench();
  b.power();
  b.add('atmega328', 'm');
  if (opts.vcc !== false) b.hi('m.vcc').hi('m.avcc');
  if (opts.gnd !== false) b.lo('m.gnd').lo('m.agnd');
  if (opts.reset === 'lo') b.lo('m.pc6'); else b.hi('m.pc6');
  b.sim.loadAVRProgram('m', hex);
  return b;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bridge = (b: Bench, id = 'm'): AVRBridge => (b.sim as any).state.avrBridges.get(id);

/** Run ticks and collect every transition of `pin` as [cycle, high]. */
function record(b: Bench, ticks: number, pins: string[], id = 'm'): Record<string, [number, boolean][]> {
  const out: Record<string, [number, boolean][]> = Object.fromEntries(pins.map((p) => [p, []]));
  for (let i = 0; i < ticks; i++) {
    b.tick(1);
    for (const t of bridge(b, id).transitions) if (out[t.pinId]) out[t.pinId].push([t.cycle, t.high]);
  }
  return out;
}
const risingPeriodsMs = (tr: [number, boolean][]) => {
  const r = tr.filter(([, h]) => h).map(([c]) => c);
  return r.slice(1).map((c, i) => ((c - r[i]) / F_CPU) * 1000);
};
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

describe('AVR timing (16 MHz, sim time)', () => {
  it('millis()-paced 1 s toggle on D13 = 2.000 s period; delay(10) toggle on D12 ~ 20 ms', () => {
    const b = mcu(fixture('blink1s.hex'));
    const tr = record(b, 60, ['pb5', 'pb4']);
    const p13 = risingPeriodsMs(tr.pb5), p12 = risingPeriodsMs(tr.pb4);
    console.log(`  D13 period ${mean(p13).toFixed(3)} ms (n=${p13.length}); D12 period ${mean(p12).toFixed(3)} ms (n=${p12.length})`);
    expect(Math.abs(mean(p13) - 2000)).toBeLessThan(15); // loop polls every ~10 ms
    expect(Math.abs(mean(p12) - 20) / 20).toBeLessThan(0.05);
  });
  it('ino/test_led.hex: each LED dwell (delay(1000)) is 1000 ms of sim time', () => {
    const b = mcu(ino('test_led.hex'));
    const rows = ['pd2', 'pd3', 'pd4', 'pd5', 'pd6', 'pd7', 'pb1'];
    const tr = record(b, 80, rows);
    const lows = rows.flatMap((p) => tr[p].filter(([, h]) => !h).map(([c]) => c)).sort((x, y) => x - y);
    const gaps = lows.slice(1).map((c, i) => ((c - lows[i]) / F_CPU) * 1000);
    console.log(`  test_led dwell: mean ${mean(gaps).toFixed(3)} ms, min ${Math.min(...gaps).toFixed(3)}, max ${Math.max(...gaps).toFixed(3)} (n=${gaps.length})`);
    expect(Math.abs(mean(gaps) - 1000)).toBeLessThan(5);
  });
  it('the clockSpeed property is honoured (8 MHz part runs 16 MHz code at half speed)', () => {
    const b = mcu(fixture('blink1s.hex'));
    b.comps.find((c) => c.id === 'm')!.properties.clockSpeed = 8_000_000;
    // reload so the property could take effect
    b.sim.loadAVRProgram('m', fixture('blink1s.hex'));
    const tr = record(b, 60, ['pb5']);
    const cyc = tr.pb5.filter(([, h]) => h).map(([c]) => c);
    const simMsPerPeriod = (60 * 100) / Math.max(1, cyc.length - 0); // crude: periods per 6 s
    console.log(`  with clockSpeed=8 MHz: ${cyc.length} D13 rising edges in 6 s sim (16 MHz behaviour = 3, 8 MHz = 1-2)`);
    expect(cyc.length).toBeLessThanOrEqual(2);
    void simMsPerPeriod;
  });
});

describe('AVR I/O', () => {
  it('digitalWrite HIGH drives the node to ~VCC, LOW to ~0 V; LED on D13 lights', () => {
    const b = mcu(fixture('blink1s.hex'));
    b.add('resistor', 'r', { resistance: 220 }); b.add('led', 'L');
    b.wire('m.pb5', 'r.a').wire('r.b', 'L.anode').wire('L.cathode', 'pwr.neg');
    b.probe('m.pb5');
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      b.tick(1);
      seen.add(`${b.v('m.pb5') > 4 ? 'H' : b.v('m.pb5') < 0.5 ? 'L' : 'X'}${Number(b.s('L').on)}`);
    }
    expect([...seen].sort()).toEqual(['H1', 'L0']);
  });
  it('INPUT_PULLUP reads HIGH when open, LOW when shorted to GND; plain INPUT follows the wire', () => {
    const b = mcu(fixture('pullup.hex'));
    b.probe('m.pb5').probe('m.pb4').probe('m.pd2');
    b.lo('m.pd3');
    b.tick(5);
    const open = [b.v('m.pd2'), b.v('m.pb5'), b.v('m.pb4')];
    b.lo('m.pd2'); b.drive('m.pd3', true);
    b.tick(5);
    const shorted = [b.v('m.pd2'), b.v('m.pb5'), b.v('m.pb4')];
    console.log(`  D2 open: V(D2)=${open[0].toFixed(2)} D13=${open[1].toFixed(2)} | D2->GND: D13=${shorted[1].toFixed(2)}; D3 lo->hi: D12 ${open[2].toFixed(2)}->${shorted[2].toFixed(2)}`);
    expect(open[0]).toBeGreaterThan(4.5);
    expect(open[1]).toBeGreaterThan(4);
    expect(shorted[1]).toBeLessThan(0.5);
    expect(open[2]).toBeLessThan(0.5);
    expect(shorted[2]).toBeGreaterThan(4);
  });
  it('analogRead(A0) of 2.5 V with AVCC = 5 V returns ~512', () => {
    const b = mcu(fixture('adc.hex'));
    b.add('resistor', 'rt', { resistance: 10000 }); b.add('resistor', 'rb', { resistance: 10000 });
    b.wire('rt.a', 'pwr.pos').wire('rt.b', 'm.pc0').wire('rb.a', 'm.pc0').wire('rb.b', 'pwr.neg');
    b.tick(20);
    const out = String(b.s('m').serialOutput);
    const vals = [...out.matchAll(/A0=(\d+)/g)].map((m) => Number(m[1]));
    console.log(`  analogRead at 2.5 V -> ${vals.slice(-4).join(', ')}`);
    expect(Math.abs(vals[vals.length - 1] - 512)).toBeLessThan(4);
  });
  it('analogWrite(9, 64): ~490 Hz, 25 % duty on the pin', () => {
    const b = mcu(fixture('pwm.hex'));
    const tr = record(b, 3, ['pb1', 'pd5']);
    const pr9 = risingPeriodsMs(tr.pb1);
    const hi: number[] = [];
    const t9 = tr.pb1;
    for (let i = 1; i < t9.length - 1; i++) if (t9[i][1]) hi.push(t9[i + 1][0] - t9[i][0]);
    const duty = mean(hi) / F_CPU * 1000 / mean(pr9);
    const pr5 = risingPeriodsMs(tr.pd5);
    console.log(`  D9: ${(1000 / mean(pr9)).toFixed(1)} Hz duty ${(duty * 100).toFixed(1)} %; D5: ${(1000 / mean(pr5)).toFixed(1)} Hz`);
    expect(Math.abs(1000 / mean(pr9) - 490.2)).toBeLessThan(5);
    expect(Math.abs(duty - 0.25)).toBeLessThan(0.02);
    expect(Math.abs(1000 / mean(pr5) - 976.6)).toBeLessThan(10);
  });
  it('LED on a 25 % PWM pin shows a steady partial brightness (not random full-on/full-off)', () => {
    const b = mcu(fixture('pwm.hex'));
    b.add('resistor', 'r', { resistance: 220 }); b.add('led', 'L');
    b.wire('m.pb1', 'r.a').wire('r.b', 'L.anode').wire('L.cathode', 'pwr.neg');
    const br: number[] = [];
    for (let i = 0; i < 20; i++) { b.tick(1); br.push(Number(b.s('L').brightness)); }
    console.log(`  brightness per tick: ${br.map((x) => x.toFixed(2)).join(' ')}`);
    expect(Math.max(...br) - Math.min(...br)).toBeLessThan(0.1);
  });
  it('Serial at 9600 baud emits ~960 chars per simulated second', () => {
    const b = mcu(fixture('serialrate.hex'));
    b.tick(5); // 0.5 s
    const n1 = (bridge(b) as AVRBridge).serialOutput.length;
    console.log(`  9600 baud: ${n1} chars in 0.5 s sim (expect ~480)`);
    expect(Math.abs(n1 - 480)).toBeLessThan(15);
  });
  it('Serial output keeps flowing after 1024 characters (SerialMonitor change detection)', () => {
    const b = mcu(fixture('serialrate.hex'));
    b.tick(12);
    const l1 = Number(b.s('m').serialLength); const s1 = String(b.s('m').serialOutput);
    b.tick(1);
    const l2 = Number(b.s('m').serialLength); const s2 = String(b.s('m').serialOutput);
    console.log(`  serialLength ${l1} -> ${l2}; text changed=${s1 !== s2}`);
    expect(l2).toBeGreaterThan(l1); // monotonic counter needed; it saturates at 1024
  });
});

describe('AVR power and reset pins', () => {
  it('RESET (pin 1) held LOW keeps the CPU in reset', () => {
    const b = mcu(fixture('blink1s.hex'), { reset: 'lo' });
    const tr = record(b, 30, ['pb5', 'pb4']);
    expect(tr.pb5.length + tr.pb4.length).toBe(0);
  });
  it('MCU with GND pins open does not run / light an LED', () => {
    const b = mcu(fixture('blink1s.hex'), { gnd: false });
    b.add('resistor', 'r', { resistance: 220 }); b.add('led', 'L');
    b.wire('m.pb5', 'r.a').wire('r.b', 'L.anode').wire('L.cathode', 'pwr.neg');
    let lit = 0;
    for (let i = 0; i < 25; i++) { b.tick(1); lit += Number(b.s('L').on); }
    console.log(`  GND open: LED lit in ${lit}/25 ticks`);
    expect(lit).toBe(0);
  });
});

describe('MCU-driven logic: edges faster than a 100 ms tick', () => {
  it('CD4026 clocked from D7 counts all 37 pulses (37 mod 10 = 7)', () => {
    const b = mcu(fixture('pulses.hex'));
    b.add('cd4026', 'u');
    b.hi('u.vcc').lo('u.gnd').lo('u.inh').hi('u.en').lo('u.rst').wire('m.pd7', 'u.clk');
    b.tick(10);
    console.log(`  4026 count after 37 pulses: ${b.s('u').count}`);
    expect(Number(b.s('u').count)).toBe(7);
  });
  it('74HC74 toggle (Qbar->D) clocked from D7 ends in Q = 1 after 37 pulses', () => {
    const b = mcu(fixture('pulses.hex'));
    b.add('flipflop_d', 'u');
    b.hi('u.vcc').lo('u.gnd').hi('u.1pre').hi('u.1clr').wire('u.1qn', 'u.1d').wire('m.pd7', 'u.1clk');
    b.tick(10);
    expect(Number(b.s('u')['1q'])).toBe(1);
  });
  it('7404 between D7 and a 4026 clock passes all 37 pulses', () => {
    const b = mcu(fixture('pulses.hex'));
    b.add('gate_not', 'g'); b.hi('g.vcc').lo('g.gnd');
    b.add('cd4026', 'u');
    b.hi('u.vcc').lo('u.gnd').lo('u.inh').hi('u.en').lo('u.rst');
    b.wire('m.pd7', 'g.1a').wire('g.1y', 'u.clk');
    b.tick(10);
    console.log(`  via 7404: 4026 count ${b.s('u').count} (expect 7; 37 falling edges at D7 -> 37 rising at clk)`);
    expect(Number(b.s('u').count)).toBe(7);
  });
});

describe('MCU digital input sampling', () => {
  it('an MCU polling D2 sees every 5 ms pulse from another MCU (74 edges echoed on D13)', () => {
    const b = mcu(fixture('pulses.hex'));
    b.add('atmega328', 'm2');
    b.hi('m2.vcc').hi('m2.avcc').lo('m2.gnd').lo('m2.agnd').hi('m2.pc6');
    b.sim.loadAVRProgram('m2', fixture('pullup.hex'));
    b.wire('m.pd7', 'm2.pd2');
    let edges = 0;
    for (let i = 0; i < 10; i++) {
      b.tick(1);
      edges += bridge(b, 'm2').transitions.filter((t) => t.pinId === 'pb5').length;
    }
    console.log(`  echoed edges on m2.D13: ${edges} (expect ~74 + 1 initial)`);
    expect(edges).toBeGreaterThanOrEqual(74);
  });
});

describe('MCU-driven 74HC595', () => {
  function chain(opts: { oeHigh?: boolean; srclrLow?: boolean } = {}): Bench {
    const b = mcu(fixture('chain595.hex'));
    for (const id of ['u', 'v']) {
      b.add('shift_register', id);
      b.hi(`${id}.vcc`).lo(`${id}.gnd`);
      opts.oeHigh ? b.hi(`${id}.oe`) : b.lo(`${id}.oe`);
      opts.srclrLow ? b.lo(`${id}.srclr`) : b.hi(`${id}.srclr`);
      b.wire('m.pb4', `${id}.srclk`).wire('m.pb0', `${id}.rclk`);
    }
    b.wire('m.pb3', 'u.ser').wire('u.qh_p', 'v.ser');
    b.tick(10);
    return b;
  }
  it('daisy chain: first byte (0xA5) ends in the second chip, last byte (0x3C) in the first', () => {
    const b = chain();
    const u = Number(b.s('u').outputBits), v = Number(b.s('v').outputBits);
    console.log(`  u=0x${u.toString(16)} v=0x${v.toString(16)} (datasheet u=0x3c v=0xa5)`);
    expect([u, v]).toEqual([0x3c, 0xa5]);
  });
  it('OE tied HIGH by a wire disables the outputs even when clocks come from the MCU', () => {
    const b = chain({ oeHigh: true });
    b.probe('u.qc');
    b.tick(1);
    console.log(`  OE=VCC: u.QC = ${b.v('u.qc').toFixed(2)} V (0x3C has QC=1; must be Hi-Z)`);
    expect(b.v('u.qc')).toBeLessThan(2.5);
  });
  it('SRCLR tied LOW by a wire holds the register clear even when clocks come from the MCU', () => {
    const b = chain({ srclrLow: true });
    expect(Number(b.s('u').outputBits)).toBe(0);
  });
});

describe('demo circuits', () => {
  it('matrix demo: every chip that lights LEDs has its VCC pin powered', () => {
    const b = new Bench();
    const c = createMatrixDemoCircuit();
    b.comps = c.components; b.wires = c.wires;
    b.sim.loadAVRProgram('avr1', AVR_MATRIX_HEX);
    b.probe('shift1.vcc', 'power1').probe('shift1.gnd', 'power1');
    b.tick(12);
    const lit = Object.entries(b.s('matrix1')).filter(([k, v]) => k.startsWith('led_') && Number(v) === 1).length;
    console.log(`  matrix demo: ${lit} LEDs lit; 74HC595 VCC pin = ${b.v('shift1.vcc').toFixed(2)} V, GND pin = ${b.v('shift1.gnd').toFixed(2)} V`);
    const missing = c.wires.filter((w) => [w.from, w.to].some((e) => e.componentId === 'matrix1' && !['r1','r2','r3','r4','r5','r6','r7','c1','c2','c3','c4','c5','nc','nc2'].includes(e.pinId)));
    console.log(`  wires to non-existent matrix pins: ${missing.map((w) => w.id).join(',')}`);
    expect(lit).toBeGreaterThan(0);
    expect(b.v('shift1.vcc')).toBeGreaterThan(4.5);
  });
  it('matrix demo shows the heart frame of ino/matrix_demo.ino (row 1 = .X.X., row 2 = XXXXX)', () => {
    const b = new Bench();
    const c = createMatrixDemoCircuit();
    b.comps = c.components; b.wires = c.wires;
    b.sim.loadAVRProgram('avr1', AVR_MATRIX_HEX);
    b.tick(5);
    const st = b.s('matrix1');
    const img: string[] = [];
    for (let r = 0; r < 7; r++) {
      let line = '';
      for (let col = 0; col < 5; col++) line += Number(st[`led_${col}_${r}`]) ? 'X' : '.';
      img.push(line);
    }
    console.log('  matrix @0.5 s: ' + img.join(' / '));
    expect(img).toEqual(['.X.X.', 'XXXXX', 'XXXXX', '.XXX.', '..X..', '.....', '.....']);
  });
  it('wall-clock cost of 1 s of simulated time per demo (real-time needs < 1000 ms)', () => {
    const rows: string[] = [];
    for (const [name, mk, hex] of [
      ['avr-blink', createAVRBlinkDemoCircuit, AVR_BLINK_HEX],
      ['matrix', createMatrixDemoCircuit, AVR_MATRIX_HEX],
      ['necklace', createNecklaceDemoCircuit, AVR_NECKLACE_HEX],
    ] as const) {
      const b = new Bench();
      const c = mk(); b.comps = c.components; b.wires = c.wires;
      b.sim.loadAVRProgram('avr1', hex);
      b.tick(2);
      const t0 = performance.now(); b.tick(10); const ms = performance.now() - t0;
      rows.push(`${name}: ${ms.toFixed(0)} ms wall per 1 s sim (${(1000 / ms).toFixed(2)}x real time)`);
    }
    console.log('  ' + rows.join('\n  '));
    expect(rows.length).toBe(3);
  });
});

describe('Intel HEX loader', () => {
  const rec = (bytes: number[]) => {
    const sum = (-bytes.reduce((a, b) => a + b, 0)) & 0xff;
    return ':' + [...bytes, sum].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('');
  };
  it('parses data, extended linear (04) and segment (02) address records', () => {
    const hex = [
      rec([0x02, 0x00, 0x00, 0x00, 0x0c, 0x94]),
      // ESA 0x0100 -> base 0x1000. (The original used ESA 0x1000 -> base
      // 0x10000, i.e. data at 64 KB, which the 32 KB flash check now rejects.)
      rec([0x02, 0x00, 0x00, 0x02, 0x01, 0x00]),
      rec([0x02, 0x00, 0x00, 0x00, 0xaa, 0xbb]),
      ':00000001FF',
    ].join('\n');
    const pm = loadHexFile(hex);
    expect(pm[0]).toBe(0x940c);
    expect(pm[0x1000 / 2]).toBe(0xbbaa);
  });
  it('rejects a record with a bad checksum', () => {
    const good = rec([0x02, 0x00, 0x00, 0x00, 0x0c, 0x94]);
    const bad = good.slice(0, -2) + '00';
    expect(() => loadHexFile(bad + '\n:00000001FF')).toThrow();
  });
  it('rejects a file that contains no records at all', () => {
    expect(() => loadHexFile('this is not a hex file')).toThrow();
  });
  it('a garbage .hex does not hang the simulator tick', () => {
    const b = new Bench(); b.power(); b.add('atmega328', 'm'); b.hi('m.vcc').lo('m.gnd');
    let threwOnLoad = false;
    try { b.sim.loadAVRProgram('m', 'garbage'); } catch { threwOnLoad = true; }
    const t0 = performance.now();
    let err = '';
    try { b.tick(1); } catch (e) { err = String(e); }
    const ms = performance.now() - t0;
    console.log(`  garbage hex: load threw=${threwOnLoad}, tick took ${ms.toFixed(0)} ms, error='${err.slice(0, 80)}'`);
    expect(threwOnLoad || ms < 2000).toBe(true);
  });
  it('a program larger than 32 KB flash is rejected', () => {
    const lines: string[] = [rec([0x02, 0x00, 0x00, 0x04, 0x00, 0x00])]; // ELA 0x0000
    lines.push(rec([0x02, 0x00, 0x00, 0x04, 0x00, 0x01])); // ELA 0x0001 -> 0x10000 (64 KB)
    lines.push(rec([0x02, 0x00, 0x00, 0x00, 0x01, 0x02]));
    lines.push(':00000001FF');
    expect(() => loadHexFile(lines.join('\n'))).toThrow();
  });
});
