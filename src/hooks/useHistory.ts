import { useRef, useCallback } from 'react';
import { PlacedComponent, Wire } from '../types';

interface Snapshot {
  components: PlacedComponent[];
  wires: Wire[];
}

const MAX_HISTORY = 50;

/**
 * Manages undo/redo history for circuit state.
 * Call push() after every user action that changes the circuit.
 * Call undo()/redo() to navigate history.
 */
export function useHistory() {
  const stack = useRef<Snapshot[]>([]);
  const pointer = useRef(-1);

  /** Save the current state as a new snapshot, discarding any redo history. */
  const push = useCallback((components: PlacedComponent[], wires: Wire[]) => {
    const snapshot: Snapshot = {
      components: components.map((c) => ({ ...c, properties: { ...c.properties }, state: { ...c.state } })),
      wires: wires.map((w) => ({ ...w, from: { ...w.from }, to: { ...w.to }, waypoints: [...w.waypoints] })),
    };
    // Discard anything after current pointer (redo stack)
    stack.current = stack.current.slice(0, pointer.current + 1);
    stack.current.push(snapshot);
    // Trim oldest entries if over limit
    if (stack.current.length > MAX_HISTORY) {
      stack.current = stack.current.slice(stack.current.length - MAX_HISTORY);
    }
    pointer.current = stack.current.length - 1;
  }, []);

  /** Undo: returns the previous snapshot, or null if nothing to undo. */
  const undo = useCallback((): Snapshot | null => {
    if (pointer.current <= 0) return null;
    pointer.current -= 1;
    const snap = stack.current[pointer.current];
    return {
      components: snap.components.map((c) => ({ ...c, properties: { ...c.properties }, state: { ...c.state } })),
      wires: snap.wires.map((w) => ({ ...w, from: { ...w.from }, to: { ...w.to }, waypoints: [...w.waypoints] })),
    };
  }, []);

  /** Redo: returns the next snapshot, or null if nothing to redo. */
  const redo = useCallback((): Snapshot | null => {
    if (pointer.current >= stack.current.length - 1) return null;
    pointer.current += 1;
    const snap = stack.current[pointer.current];
    return {
      components: snap.components.map((c) => ({ ...c, properties: { ...c.properties }, state: { ...c.state } })),
      wires: snap.wires.map((w) => ({ ...w, from: { ...w.from }, to: { ...w.to }, waypoints: [...w.waypoints] })),
    };
  }, []);

  /** Reset history (e.g. on clear or load). */
  const reset = useCallback((components: PlacedComponent[], wires: Wire[]) => {
    stack.current = [];
    pointer.current = -1;
    push(components, wires);
  }, [push]);

  const canUndo = useCallback(() => pointer.current > 0, []);
  const canRedo = useCallback(() => pointer.current < stack.current.length - 1, []);

  return { push, undo, redo, reset, canUndo, canRedo };
}
