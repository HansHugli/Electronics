import { describe, it, expect } from 'vitest';
import {
  validateCircuit, parseCircuitText, serializeCircuit, serializeAutosave, maxIdNumber, errorMessage,
} from '../../src/hooks/circuitFile';

const known = (t: string) => ['resistor', 'led', 'switch', 'atmega328'].includes(t);

const goodPart = { id: 'comp_1', type: 'resistor', position: { x: 10, y: 20 }, rotation: 0, properties: { resistance: 220 }, state: {} };

describe('validateCircuit (D6: bad files never reach React state)', () => {
  it('accepts a normal circuit and fills defaults', () => {
    const r = validateCircuit({
      components: [{ id: 'comp_1', type: 'led', position: { x: 1, y: 2 } }],
      wires: [{ id: 'wire_1', from: { componentId: 'comp_1', pinId: 'anode' }, to: { componentId: 'board', pinId: '3,4' } }],
    }, known);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.circuit.components[0]).toMatchObject({ rotation: 0, properties: {}, state: {} });
    expect(r.circuit.wires[0].waypoints).toEqual([]);
    expect(typeof r.circuit.wires[0].color).toBe('string');
  });

  it.each([
    [null, 'circuit object'],
    [[], 'circuit object'],
    [{ wires: [] }, '"components"'],
    [{ components: {} }, '"components"'],
    [{ components: [{ type: 'led', position: { x: 0, y: 0 } }] }, 'no id'],
    [{ components: [{ ...goodPart, type: 'flux_capacitor' }] }, 'unknown type "flux_capacitor"'],
    [{ components: [{ ...goodPart, position: { x: 'a', y: 0 } }] }, 'position'],
    [{ components: [{ ...goodPart, position: { x: Infinity, y: 0 } }] }, 'position'],
    [{ components: [{ ...goodPart, rotation: 45 }] }, 'rotation'],
    [{ components: [{ ...goodPart, properties: { r: { nested: true } } }] }, 'property "r"'],
    [{ components: [goodPart, goodPart] }, 'share the id'],
    [{ components: [goodPart], wires: [{ id: 'w', from: { componentId: 'comp_1' }, to: { componentId: 'board', pinId: '1,1' } }] }, 'invalid end'],
    [{ components: [goodPart], wires: 'nope' }, '"wires"'],
  ])('rejects %j', (data, expected) => {
    const r = validateCircuit(data, known);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(expected);
  });

  it('drops wires to parts that do not exist, and counts them', () => {
    const r = validateCircuit({
      components: [goodPart],
      wires: [
        { id: 'w1', from: { componentId: 'comp_1', pinId: 'a' }, to: { componentId: 'gone', pinId: 'b' } },
        { id: 'w2', from: { componentId: 'comp_1', pinId: 'a' }, to: { componentId: 'board', pinId: '1,1' } },
      ],
    }, known);
    expect(r.ok && r.circuit.wires.map((w) => w.id)).toEqual(['w2']);
    expect(r.ok && r.droppedWires).toBe(1);
  });

  it('keeps the autosave extras (name, path, dirty)', () => {
    const r = validateCircuit({ components: [], wires: [], circuitName: 'Lab 3', currentFilePath: 'C:/x/Lab 3.ecx', dirty: true }, known);
    expect(r.ok && r.circuit).toMatchObject({ circuitName: 'Lab 3', currentFilePath: 'C:/x/Lab 3.ecx', dirty: true });
  });

  it('turns broken JSON into a sentence', () => {
    const r = parseCircuitText('{"components": [', known);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });
});

describe('serialization', () => {
  it('leaves runtime readings out of files but keeps a switch position and firmware', () => {
    const text = serializeCircuit([
      { ...goodPart, state: { voltage: 3.2, current: 0.01 } },
      { id: 'comp_2', type: 'switch', position: { x: 0, y: 0 }, rotation: 0, properties: {}, state: { closed: 1, voltage: 5 } },
      { id: 'comp_3', type: 'atmega328', position: { x: 0, y: 0 }, rotation: 0, properties: { hex: ':00000001FF', sketch: 'void setup(){}' }, state: { pc: 4 } },
    ], []);
    const parsed = JSON.parse(text);
    expect(parsed.components[0].state).toEqual({});
    expect(parsed.components[1].state).toEqual({ closed: 1 });
    expect(parsed.components[2].properties).toEqual({ hex: ':00000001FF', sketch: 'void setup(){}' });
    // And it reads back.
    expect(parseCircuitText(text, known).ok).toBe(true);
  });

  it('autosave round-trips the file path and name', () => {
    const text = serializeAutosave({ components: [goodPart as never], wires: [], circuitName: 'Blinker', currentFilePath: '/c/Blinker.ecx', dirty: false });
    const r = parseCircuitText(text, known);
    expect(r.ok && r.circuit).toMatchObject({ circuitName: 'Blinker', currentFilePath: '/c/Blinker.ecx', dirty: false });
  });

  it('finds the highest id number', () => {
    expect(maxIdNumber([{ id: 'comp_3' }, { id: 'comp_12' }, { id: 'avr1' }, { id: 'x' }])).toBe(12);
  });

  it('strips Electron\'s IPC wrapper from error messages', () => {
    expect(errorMessage(new Error("Error invoking remote method 'save-circuit': Error: The disk is full."))).toBe('The disk is full.');
    expect(errorMessage('plain')).toBe('plain');
  });
});
