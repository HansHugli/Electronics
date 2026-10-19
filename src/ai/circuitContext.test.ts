import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, PlacedComponent, Wire } from '../types';
import { gridOf, positionForGrid, renderCircuitContext, renderComponentCatalog } from './circuitContext';

const grid = { GRID_W: 24, GRID_H: 17, BOARD_X_OFFSET: 96 };
const timer: ComponentDefinition = {
  type: 'timer', label: '555', category: 'active', width: 2, height: 4, color: '#333',
  pins: [{ id: 'gnd', label: 'GND', side: 'left', offset: 0.125, type: 'ground' }, { id: 'vcc', label: 'VCC', side: 'right', offset: 0.125, type: 'power' }],
  properties: { x: { label: 'X', default: 1 } },
};
const defs = { timer };

describe('grid round-trip', () => {
  it('gridOf inverts positionForGrid', () => {
    for (const [col, row] of [[6, 0], [22, 30], [3, 49]]) {
      const position = positionForGrid(timer, col, row, grid);
      const comp: PlacedComponent = { id: 'c', type: 'timer', position, rotation: 0, properties: {}, state: {} };
      expect(gridOf(comp, timer, grid)).toEqual({ col, row });
    }
  });
});

describe('renderCircuitContext (U5)', () => {
  const comps = (n: number): PlacedComponent[] =>
    Array.from({ length: n }, (_, i) => ({ id: `comp_${i}`, type: 'timer', position: positionForGrid(timer, 6, i % 40, grid), rotation: 0, properties: { x: i }, state: { v: 1 } }));
  const wires = (n: number): Wire[] =>
    Array.from({ length: n }, (_, i) => ({ id: `wire_${i}`, from: { componentId: `comp_${i % 5}`, pinId: 'gnd' }, to: { componentId: 'board', pinId: `3,${i % 50}` }, waypoints: [], color: '#fff' }));

  it('is compact JSON with grid positions and no live state', () => {
    const s = renderCircuitContext(comps(2), wires(1), 'comp_1', defs, grid);
    const j = JSON.parse(s);
    expect(j.components[0]).toEqual({ id: 'comp_0', type: 'timer', col: 6, row: 0, properties: { x: 0 } });
    expect(j.wires[0]).toEqual({ id: 'wire_0', from: 'comp_0.gnd', to: 'board.3,0' });
    expect(s).not.toMatch(/"state"/);
  });

  it('summarises when large and never exceeds the cap', () => {
    const s = renderCircuitContext(comps(60), wires(400), null, defs, grid, 6000);
    expect(s.length).toBeLessThanOrEqual(6000);
    expect(JSON.parse(s).note).toMatch(/list_components/);
    const tiny = renderCircuitContext(comps(300), wires(900), null, defs, grid, 2000);
    expect(tiny.length).toBeLessThanOrEqual(2000);
    expect(JSON.parse(tiny).componentsByType.timer).toBe(300);
  });
});

describe('renderComponentCatalog (W6)', () => {
  it('lists pins and properties, sorted for a stable prompt', () => {
    const relay: ComponentDefinition = { ...timer, type: 'a_relay', label: 'Relay', properties: undefined };
    const out = renderComponentCatalog({ timer, a_relay: relay });
    expect(out.split('\n')[0]).toMatch(/^- a_relay: Relay \[gnd, vcc\]$/);
    expect(out).toMatch(/- timer: 555 \[gnd, vcc\] \{x=1\}/);
  });
});
