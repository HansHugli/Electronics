// Pinout checks against datasheet pin numbers.
// Each table maps the app's pin id -> the datasheet pin number of the pin
// with that function. Two properties are checked:
//   (1) one side carries datasheet pins 1..N/2 in order and the other side
//       N/2+1..N, i.e. the part can physically exist;
//   (2) the pin directly across from datasheet pin k is pin N+1-k (DIP rule),
//       so e.g. VCC (14) sits across from pin 1, not across from GND (7).
import { describe, it, expect } from 'vitest';
import { COMPONENT_DEFINITIONS } from '../../src/data/components';

const QUAD2 = { '1a': 1, '1b': 2, '1y': 3, '2a': 4, '2b': 5, '2y': 6, gnd: 7, '3y': 8, '3a': 9, '3b': 10, '4y': 11, '4a': 12, '4b': 13, vcc: 14 };
export const DATASHEET: Record<string, Record<string, number>> = {
  gate_nand: QUAD2, // SN74HC00 / SN7400
  gate_and: QUAD2,  // SN74HC08
  gate_or: QUAD2,   // SN74HC32
  gate_not: { '1a': 1, '1y': 2, '2a': 3, '2y': 4, '3a': 5, '3y': 6, gnd: 7, '4y': 8, '4a': 9, '5y': 10, '5a': 11, '6y': 12, '6a': 13, vcc: 14 }, // SN74HC04
  flipflop_d: { '1clr': 1, '1d': 2, '1clk': 3, '1pre': 4, '1q': 5, '1qn': 6, gnd: 7, '2qn': 8, '2q': 9, '2pre': 10, '2clk': 11, '2d': 12, '2clr': 13, vcc: 14 }, // SN74HC74
  timer: { gnd: 1, trig: 2, out: 3, reset: 4, ctrl: 5, thr: 6, dis: 7, vcc: 8 }, // NE555
  opamp: { ofs1: 1, in_neg: 2, in_pos: 3, v_neg: 4, ofs2: 5, out: 6, v_pos: 7, nc: 8 }, // LM741
  shift_register: { qb: 1, qc: 2, qd: 3, qe: 4, qf: 5, qg: 6, qh: 7, gnd: 8, qh_p: 9, srclr: 10, srclk: 11, rclk: 12, oe: 13, ser: 14, qa: 15, vcc: 16 }, // SN74HC595
  // CD4026B (TI SCHS031): 1 CLK, 2 CLK INH, 3 DEI, 4 DEO, 5 CO, 6 f, 7 g, 8 VSS,
  // 9 d, 10 a, 11 e, 12 b, 13 c, 14 ungated C, 15 RESET, 16 VDD.
  cd4026: { clk: 1, inh: 2, en: 3, deo: 4, co: 5, out_f: 6, out_g: 7, gnd: 8, out_d: 9, out_a: 10, out_e: 11, out_b: 12, out_c: 13, ung: 14, rst: 15, vcc: 16 },
  atmega328: { pc6: 1, pd0: 2, pd1: 3, pd2: 4, pd3: 5, pd4: 6, vcc: 7, gnd: 8, pb6: 9, pb7: 10, pd5: 11, pd6: 12, pd7: 13, pb0: 14, pb1: 15, pb2: 16, pb3: 17, pb4: 18, pb5: 19, avcc: 20, aref: 21, agnd: 22, pc0: 23, pc1: 24, pc2: 25, pc3: 26, pc4: 27, pc5: 28 },
  // Common-cathode 10-pin 0.56" display (e.g. 5161AS): 1 e, 2 d, 3 COM, 4 c,
  // 5 DP, 6 b, 7 a, 8 COM, 9 f, 10 g.  Pin 8 is the second COMMON, not VCC.
  display7seg: { e: 1, d: 2, gnd: 3, c: 4, dp: 5, b: 6, a: 7, vcc: 8, f: 9, g: 10 },
};

function sides(type: string) {
  const def = COMPONENT_DEFINITIONS[type];
  const left = def.pins.filter((p) => p.side === 'left').sort((a, b) => a.offset - b.offset);
  const right = def.pins.filter((p) => p.side === 'right').sort((a, b) => a.offset - b.offset);
  return { def, left, right };
}

describe('DIP pinouts vs datasheet', () => {
  for (const [type, table] of Object.entries(DATASHEET)) {
    it(`${type}: every datasheet pin exists in the app`, () => {
      const ids = COMPONENT_DEFINITIONS[type].pins.map((p) => p.id);
      const missing = Object.keys(table).filter((id) => !ids.includes(id));
      expect(missing).toEqual([]);
    });

    it(`${type}: each side is a run of consecutive datasheet pins`, () => {
      const { left, right } = sides(type);
      const nums = (ps: typeof left) => ps.map((p) => table[p.id] ?? -1);
      const consecutive = (a: number[]) => {
        const s = [...a].sort((x, y) => x - y);
        const asc = a.every((v, i) => i === 0 || v === a[i - 1] + 1);
        const desc = a.every((v, i) => i === 0 || v === a[i - 1] - 1);
        return (asc || desc) && s[s.length - 1] - s[0] === a.length - 1;
      };
      const msg = `left(top->bottom)=${nums(left)} right(top->bottom)=${nums(right)}`;
      expect({ ok: consecutive(nums(left)) && consecutive(nums(right)), msg }).toEqual({ ok: true, msg });
    });

    it(`${type}: pin across from k is N+1-k (VCC across from pin 1)`, () => {
      const { left, right } = sides(type);
      const N = left.length + right.length;
      const bad: string[] = [];
      for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const a = table[left[i].id], b = table[right[i].id];
        if (a + b !== N + 1) bad.push(`${left[i].id}(${a}) across ${right[i].id}(${b})`);
      }
      expect(bad).toEqual([]);
    });
  }

  it('7805 TO-220 order is IN, GND, OUT', () => {
    expect(COMPONENT_DEFINITIONS.vreg.pins.map((p) => p.id)).toEqual(['vin', 'gnd', 'vout']);
  });

  it('7-seg pin 8 is a common (cathode) pin, not a VCC pin', () => {
    const p = COMPONENT_DEFINITIONS.display7seg.pins.find((x) => x.id === 'vcc')!;
    expect(p.type).toBe('ground');
  });
});
