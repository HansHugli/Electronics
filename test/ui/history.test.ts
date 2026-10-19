import { describe, it, expect } from 'vitest';
import { HistoryStack, MAX_HISTORY } from '../../src/hooks/useHistory';
import type { PlacedComponent, Wire } from '../../src/types';

const part = (id: string, x = 0): PlacedComponent => ({
  id, type: 'resistor', position: { x, y: 0 }, rotation: 0, properties: { resistance: 220 }, state: {},
});
const wire = (id: string): Wire => ({
  id, from: { componentId: 'board', pinId: '2,1' }, to: { componentId: 'board', pinId: '3,1' }, waypoints: [], color: '#f00',
});

describe('HistoryStack', () => {
  it('undoes and redoes in order', () => {
    const h = new HistoryStack();
    h.reset([], []);
    h.push([part('a')], []);
    h.push([part('a'), part('b')], [wire('w1')]);
    expect(h.undo()?.components.map((c) => c.id)).toEqual(['a']);
    expect(h.undo()?.components).toEqual([]);
    expect(h.undo()).toBeNull();
    expect(h.redo()?.components.map((c) => c.id)).toEqual(['a']);
  });

  it('brings a cleared circuit back (Clear → Undo)', () => {
    const h = new HistoryStack();
    h.reset([part('a'), part('b')], [wire('w1')]);
    h.push([], []); // Clear
    const back = h.undo();
    expect(back?.components.map((c) => c.id)).toEqual(['a', 'b']);
    expect(back?.wires.map((w) => w.id)).toEqual(['w1']);
  });

  it('keeps a restored circuit as the base of history (D1)', () => {
    const h = new HistoryStack();
    h.reset([part('restored')], []);
    h.push([], []); // e.g. an AI clear_circuit pushes one entry
    expect(h.undo()?.components.map((c) => c.id)).toEqual(['restored']);
  });

  it('a new action drops the redo branch', () => {
    const h = new HistoryStack();
    h.reset([], []);
    h.push([part('a')], []);
    h.undo();
    h.push([part('b')], []);
    expect(h.canRedo()).toBe(false);
    expect(h.undo()?.components).toEqual([]);
  });

  it('snapshots are copies, not shared with the live state', () => {
    const h = new HistoryStack();
    const live = [part('a', 10)];
    h.reset(live, []);
    h.push([part('a', 20)], []);
    live[0].position.x = 999;
    live[0].properties.resistance = 1;
    const snap = h.undo()!;
    expect(snap.components[0].position.x).toBe(10);
    expect(snap.components[0].properties.resistance).toBe(220);
  });

  it('tracks unsaved changes against the saved entry', () => {
    const h = new HistoryStack();
    h.reset([], []);
    h.markSaved();
    expect(h.isDirty()).toBe(false);
    h.push([part('a')], []);
    expect(h.isDirty()).toBe(true);
    h.undo();
    expect(h.isDirty()).toBe(false); // back at the saved state
    h.redo();
    h.markSaved();
    expect(h.isDirty()).toBe(false);
    h.markUnsaved();
    expect(h.isDirty()).toBe(true);
  });

  it('caps its length', () => {
    const h = new HistoryStack();
    h.reset([], []);
    for (let i = 0; i < MAX_HISTORY + 10; i++) h.push([part(`p${i}`)], []);
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(MAX_HISTORY - 1);
  });
});
