import { describe, expect, it } from 'vitest';
import type { ComponentDefinition } from '../types';
import {
  LIMITS,
  parseBoardPin,
  RequestBudget,
  validateAddComponent,
  validateAddWire,
  validateClearCircuit,
  validateCreateComponentType,
  validateDeleteComponentType,
  validateId,
  validateListComponentTypes,
} from './toolValidation';

const defs: Record<string, ComponentDefinition> = {
  resistor: {
    type: 'resistor', label: 'Resistor', category: 'passive', width: 1, height: 2, color: '#000',
    pins: [{ id: 'a', label: 'A', side: 'top', offset: 0.5, type: 'bidirectional' }, { id: 'b', label: 'B', side: 'bottom', offset: 0.5, type: 'bidirectional' }],
    properties: { resistance: { label: 'R', default: 220, unit: 'Ω' } },
  },
  led: {
    type: 'led', label: 'LED', category: 'output', width: 1, height: 1, color: '#f00',
    pins: [{ id: 'anode', label: '+', side: 'top', offset: 0.5, type: 'input' }, { id: 'cathode', label: '-', side: 'bottom', offset: 0.5, type: 'output' }],
    properties: { color: { label: 'Color', default: 'red' } },
  },
  timer: {
    type: 'timer', label: '555', category: 'active', width: 2, height: 4, color: '#333',
    pins: [{ id: 'gnd', label: 'GND', side: 'left', offset: 0.1, type: 'ground' }],
  },
  power: {
    type: 'power', label: 'Power', category: 'power', width: 2, height: 4, color: '#333',
    pins: [{ id: 'pos', label: '+', side: 'right', offset: 0.2, type: 'power' }],
  },
  my_relay: {
    type: 'my_relay', label: 'Relay', category: 'active', width: 2, height: 2, color: '#333',
    pins: [{ id: 'coil', label: 'C', side: 'left', offset: 0.5, type: 'input' }],
  },
};
const builtins = new Set(['resistor', 'led', 'timer', 'power']);
const board = [{ id: 'comp_1', type: 'resistor' }, { id: 'comp_2', type: 'led' }];

describe('add_component', () => {
  it('accepts a valid placement and fills nothing it should not', () => {
    const r = validateAddComponent({ type: 'resistor', col: 3, row: 10, properties: { resistance: 470 } }, defs);
    expect(r).toEqual({ ok: true, value: { type: 'resistor', col: 3, row: 10, properties: { resistance: 470 } } });
  });

  it.each([
    [{ type: 'resistor', col: NaN, row: 1 }, /whole numbers/],
    [{ type: 'resistor', col: Infinity, row: 1 }, /whole numbers/],
    [{ type: 'resistor', col: 2.5, row: 1 }, /whole numbers/],
    [{ type: 'resistor', col: '3', row: 1 }, /whole numbers/],
    [{ type: 'resistor', col: 3, row: -1 }, /off the board/],
    [{ type: 'resistor', col: 3, row: 49 }, /off the board/],
    [{ type: 'resistor', col: 31, row: 1 }, /off the board/],
    [{ type: 'resistor', col: -2, row: 1 }, /off the board/],
    [{ type: 'resistor', col: 7, row: 1 }, /gap/],
    [{ type: 'flux_capacitor', col: 3, row: 1 }, /Unknown component type/],
    [{ type: 'timer', col: 14, row: 1 }, /straddle/],
    [{ type: 'power', col: 3, row: 1 }, /col -4/],
    [{ type: 'resistor', col: 3, row: 1, properties: { ohms: 5 } }, /no property "ohms".*resistance/],
    [{ type: 'resistor', col: 3, row: 1, properties: { resistance: 'big' } }, /finite number/],
    [{ type: 'resistor', col: 3, row: 1, properties: { resistance: NaN } }, /finite number/],
    [{ type: 'resistor', col: 3, row: 1, properties: { resistance: -100 } }, /greater than zero/],
    [{ type: 'resistor', col: 3, row: 1, properties: { resistance: 1e20 } }, /out of range/],
    [{ type: 'resistor', col: 3, row: 1, properties: [1] }, /object/],
    [null, /object input/],
  ])('rejects %j', (input, re) => {
    const r = validateAddComponent(input, defs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });

  it('snaps DIP chips to the gap like the editor does', () => {
    const r = validateAddComponent({ type: 'timer', col: 4, row: 2 }, defs);
    expect(r.ok && r.value.col).toBe(6);
    const r2 = validateAddComponent({ type: 'timer', col: 20, row: 2 }, defs);
    expect(r2.ok && r2.value.col).toBe(22);
  });

  it('accepts string properties for string defaults', () => {
    const r = validateAddComponent({ type: 'led', col: 3, row: 1, properties: { color: 'blue' } }, defs);
    expect(r.ok).toBe(true);
  });
});

describe('board pins', () => {
  it.each([
    ['3,12', { col: 3, row: 12 }],
    [' 0 , 0 ', { col: 0, row: 0 }],
    ['30,49', { col: 30, row: 49 }],
  ])('parses %s', (pin, want) => expect(parseBoardPin(pin)).toEqual(want));

  it.each(['7,3', '15,0', '23,10', '31,0', '-1,0', '3,50', '3', '3,4,5', 'a,b', '3.5,2', '', '1e1,2'])('rejects %s', (pin) =>
    expect(parseBoardPin(pin)).toBeNull());
});

describe('add_wire', () => {
  it('accepts pins and holes', () => {
    const r = validateAddWire({ from: { componentId: 'comp_1', pinId: 'a' }, to: { componentId: 'board', pinId: '3, 12' }, color: '#e74c3c' }, board, defs);
    expect(r).toEqual({ ok: true, value: { from: { componentId: 'comp_1', pinId: 'a' }, to: { componentId: 'board', pinId: '3,12' }, color: '#e74c3c' } });
  });

  it.each([
    [{ from: { componentId: 'comp_9', pinId: 'a' }, to: { componentId: 'board', pinId: '3,3' } }, /not on the board/],
    [{ from: { componentId: 'comp_1', pinId: 'lead1' }, to: { componentId: 'board', pinId: '3,3' } }, /no pin "lead1".*a, b/],
    [{ from: { componentId: 'board', pinId: '7,3' }, to: { componentId: 'comp_2', pinId: 'anode' } }, /not a board hole/],
    [{ from: { componentId: 'board', pinId: '99,99' }, to: { componentId: 'comp_2', pinId: 'anode' } }, /not a board hole/],
    [{ from: { componentId: 'comp_1', pinId: 'a' }, to: { componentId: 'comp_1', pinId: 'a' } }, /two different ends/],
    [{ from: { componentId: 'comp_1', pinId: 'a' }, to: { componentId: 'comp_2', pinId: 'anode' }, color: 'red;background:url(x)' }, /hex colour/],
    [{ from: 'comp_1.a', to: { componentId: 'comp_2', pinId: 'anode' } }, /componentId, pinId/],
    [{ from: { componentId: 'comp_1' }, to: { componentId: 'comp_2', pinId: 'anode' } }, /needs a componentId and a pinId/],
  ])('rejects %j', (input, re) => {
    const r = validateAddWire(input, board, defs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });
});

describe('ids, types and clear', () => {
  it('validates IDs', () => {
    expect(validateId({ componentId: 'comp_1' }, 'componentId').ok).toBe(true);
    expect(validateId({ componentId: '../x' }, 'componentId').ok).toBe(false);
    expect(validateId({ componentId: 5 }, 'componentId').ok).toBe(false);
  });

  it('refuses to delete built-in types', () => {
    const r = validateDeleteComponentType({ type: 'resistor' }, defs, builtins);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/built-in/);
    expect(validateDeleteComponentType({ type: 'my_relay' }, defs, builtins)).toEqual({ ok: true, value: 'my_relay' });
    expect(validateDeleteComponentType({ type: 'nope' }, defs, builtins).ok).toBe(false);
    expect(validateDeleteComponentType({ type: '../e101-config' }, defs, builtins).ok).toBe(false);
  });

  it('validates new component types, including path-like IDs', () => {
    const good = {
      type: 'relay_spdt', label: 'Relay',
      pins: [{ id: 'coil_a', label: 'C1', side: 'left', type: 'input' }, { id: 'com', label: 'COM', side: 'right', type: 'bidirectional' }],
      properties: { coilVoltage: { label: 'Coil', default: 5, unit: 'V' } },
    };
    const r = validateCreateComponentType(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.category).toBe('active');
    for (const type of ['../../e101-config', 'e101-config.json', 'Relay', '']) {
      expect(validateCreateComponentType({ ...good, type }).ok).toBe(false);
    }
    expect(validateCreateComponentType({ ...good, pins: [] }).ok).toBe(false);
    expect(validateCreateComponentType({ ...good, pins: [good.pins[0], good.pins[0]] }).ok).toBe(false);
    expect(validateCreateComponentType({ ...good, pins: Array.from({ length: 41 }, (_, i) => ({ ...good.pins[0], id: `p${i}` })) }).ok).toBe(false);
    expect(validateCreateComponentType({ ...good, pins: [{ ...good.pins[0], side: 'top' }] }).ok).toBe(false);
    expect(validateCreateComponentType({ ...good, color: 'javascript:x' }).ok).toBe(false);
    expect(validateCreateComponentType({ ...good, properties: { 'bad key': { label: 'x', default: 1 } } }).ok).toBe(false);
    expect(validateCreateComponentType({ ...good, properties: { v: { label: 'x', default: NaN } } }).ok).toBe(false);
  });

  it('clearing a non-empty board needs the user to ask', () => {
    expect(validateClearCircuit({}, 0, 0, 'build a blinker').ok).toBe(true);
    const refused = validateClearCircuit({}, 5, 3, 'build a blinker');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/Ask the user first/);
    expect(validateClearCircuit({}, 5, 3, "let's start over with a traffic light").ok).toBe(true);
    expect(validateClearCircuit({}, 5, 3, 'clear the board and build a counter').ok).toBe(true);
    expect(validateClearCircuit({ confirmed_by_user: true }, 5, 3, 'yes please').ok).toBe(true);
    expect(validateClearCircuit({ confirmed_by_user: true }, 5, 3, 'add an LED').ok).toBe(false);
    expect(validateClearCircuit({}, 5, 3, 'yes').ok).toBe(false);
  });

  it('validates list_component_types input', () => {
    expect(validateListComponentTypes({})).toEqual({ ok: true, value: null });
    expect(validateListComponentTypes({ types: ['led'] })).toEqual({ ok: true, value: ['led'] });
    expect(validateListComponentTypes({ types: 'led' }).ok).toBe(false);
  });
});

describe('caps', () => {
  it('stops a request after its per-tool cap', () => {
    const b = new RequestBudget('x');
    for (let i = 0; i < LIMITS.perRequest.add_component; i++) expect(b.take('add_component')).toBeNull();
    expect(b.take('add_component')).toMatch(/Limit reached/);
    expect(b.take('list_components')).toBeNull();
    expect(new RequestBudget().take('clear_circuit')).toBeNull();
    const c = new RequestBudget();
    c.take('clear_circuit');
    expect(c.take('clear_circuit')).toMatch(/Limit/);
  });
});
