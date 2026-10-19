/**
 * Breadboard internal connectivity, tested through the simulator with parts
 * placed on holes (no wires except where a real user would add one).
 *
 * Board 0 columns: 0 (+rail) 1 (-rail) | 2-6 left strip | 7 gap | 8-12 right strip | 13 (+rail) 14 (-rail)
 */
import { describe, it, expect } from 'vitest';
import { Circuit, record } from '../helpers/circuit';
import { buildPinGroups } from '../../src/data/breadboard';

const groups = buildPinGroups();
const groupOf = (col: number, row: number) => groups.find((g) => g.pins.some((p) => p.col === col && p.row === row))?.id;

describe('Breadboard model (static)', () => {
  it('component area: 5 holes per row-strip, centre gap splits left/right', () => {
    expect(groupOf(2, 10)).toBe(groupOf(6, 10));
    expect(groupOf(8, 10)).toBe(groupOf(12, 10));
    expect(groupOf(6, 10)).not.toBe(groupOf(8, 10));
    expect(groupOf(2, 10)).not.toBe(groupOf(2, 11));
    expect(groupOf(7, 10)).toBe(undefined); // gap has no holes
    const strip = groups.find((g) => g.id === groupOf(2, 10))!;
    expect(strip.pins.length).toBe(5);
  });
  // Hans, 2026-10-18: rails work like a real board — each rail column is one
  // strip along the whole side (this replaced the isolated 5-row groups).
  it('power rails: each polarity column runs the full length of its side; + and - separate; sides and boards separate', () => {
    const pos0 = groups.find((g) => g.id === groupOf(0, 0))!;
    expect(pos0.pins.length).toBe(50);
    expect(groupOf(0, 49)).toBe(groupOf(0, 0));
    expect(groupOf(0, 5)).toBe(groupOf(0, 4));
    expect(groupOf(1, 0)).not.toBe(groupOf(0, 0));
    expect(groupOf(13, 0)).not.toBe(groupOf(0, 0)); // right-side rail of board 0
    expect(groupOf(16, 0)).not.toBe(groupOf(0, 0)); // board 1
    expect(groups.filter((g) => g.id.startsWith('b0-left-rail-pos')).length).toBe(1);
  });
});

/** 5 V supply wired to board hole (0,r) / (1,r) like the demos do. */
function boardWithSupply(row = 0) {
  const c = new Circuit();
  c.add('power', 'v1', { voltage: 5 });
  c.wire('v1:pos', `board:0,${row}`);
  c.wire('v1:neg', `board:1,${row}`);
  return c;
}

describe('Breadboard connectivity through the solver', () => {
  it('resistor between + rail and a strip, second resistor from the same strip to - rail: divider works', () => {
    const c = boardWithSupply(0);
    // vertical resistor: pin a at (col,row), pin b two rows below
    c.place('resistor', 'r1', 3, 1, { resistance: 1000 }, 'a');  // a=(3,1) b=(3,3)
    c.place('resistor', 'r2', 5, 3, { resistance: 1000 }, 'a');  // a=(5,3) same strip as r1.b, b=(5,5)
    c.wire('board:0,1', 'board:2,1');   // + rail -> strip row 1
    c.wire('board:4,5', 'board:1,4');   // strip row 5 -> - rail (same rail group rows 0-4)
    c.run(1);
    record('board divider r1 current', 2.5e-3, c.s('r1', 'current'), 'A');
    expect(Math.abs(c.s('r1', 'current') - 2.5e-3)).toBeLessThan(1e-6);
  });

  it('parts on opposite sides of the centre gap are NOT connected', () => {
    const c = boardWithSupply(0);
    c.place('resistor', 'r1', 6, 1, { resistance: 1000 }, 'a'); // b=(6,3)
    c.place('resistor', 'r2', 8, 3, { resistance: 1000 }, 'a'); // a=(8,3) other side of gap
    c.wire('board:0,1', 'board:2,1');
    c.wire('board:9,5', 'board:1,4');
    c.run(1);
    expect(Math.abs(c.s('r1', 'current'))).toBeLessThan(1e-6);
  });

  // Hans, 2026-10-18: rails run the full length (was: isolated 5-row groups needing jumpers).
  it('a rail is one strip: supply wired at row 0 reaches a load on rows 40-42 with no jumper', () => {
    const c = boardWithSupply(0);
    c.place('resistor', 'r', 3, 40, { resistance: 1000 }, 'a'); // (3,40)-(3,42)
    c.wire('board:0,40', 'board:2,40');  // + rail, far from the supply wire
    c.wire('board:4,42', 'board:1,49');  // - rail, last hole
    c.run(1);
    expect(Math.abs(c.s('r', 'current') - 5e-3)).toBeLessThan(1e-6);
  });

  it('the left and right rails of a board are separate until jumpered', () => {
    const c = boardWithSupply(0);
    c.place('resistor', 'r', 9, 6, { resistance: 1000 }, 'a'); // right strips (9,6)-(9,8)
    c.wire('board:13,6', 'board:8,6');   // right + rail (not powered yet)
    c.wire('board:10,8', 'board:14,8');  // right - rail
    c.run(1);
    expect(Math.abs(c.s('r', 'current'))).toBeLessThan(1e-6);
    c.wire('board:0,0', 'board:13,0'); c.wire('board:1,0', 'board:14,0');
    c.run(1);
    expect(Math.abs(c.s('r', 'current') - 5e-3)).toBeLessThan(1e-6);
  });

  it('power supply terminals are not connected to any rail unless wired', () => {
    const c = new Circuit();
    c.place('power', 'v1', 0, 0, { voltage: 5 }, 'pos'); // even if its pin pixel lands on a rail hole
    c.place('resistor', 'r', 3, 0, { resistance: 1000 }, 'a');
    c.wire('board:0,1', 'board:2,0');
    c.wire('board:4,2', 'board:1,1');
    c.run(1);
    expect(Math.abs(c.s('r', 'current'))).toBeLessThan(1e-6);
  });

  it('555 DIP straddling the gap: left and right pins land on separate strips (no internal shorts)', () => {
    const c = boardWithSupply(5);
    // anchor GND pin (pin 1, top-left like a real DIP) at (6,5): pins rows 5-8, cols 6 and 8
    // Left: GND(5) TRIG(6) OUT(7) RST(8); right: VCC(5) DIS(6) THR(7) CTRL(8)
    c.place('timer', 't', 6, 5, {}, 'gnd');
    c.run(1);
    // GND (6,5) and VCC (8,5) are across from each other but on different strips
    expect(groupOf(6, 5)).not.toBe(groupOf(8, 5));
    expect(groupOf(6, 8)).not.toBe(groupOf(8, 8));
    // put 5 V on VCC's strip only and verify RST's strip stays at 0
    c.wire('board:0,5', 'board:12,5');
    c.add('multimeter', 'm1'); c.wire('m1:pos', 'board:2,8'); c.wire('m1:neg', 'v1:neg');
    c.add('multimeter', 'm2'); c.wire('m2:pos', 'board:9,5'); c.wire('m2:neg', 'v1:neg');
    c.run(1);
    record('555 straddle: VCC strip', 5, c.s('m2', 'voltage'), 'V');
    record('555 straddle: RST strip (unwired)', 0, c.s('m1', 'voltage'), 'V');
    expect(Math.abs(c.s('m2', 'voltage') - 5)).toBeLessThan(1e-3);
    expect(Math.abs(c.s('m1', 'voltage'))).toBeLessThan(1e-3);
  });
});
