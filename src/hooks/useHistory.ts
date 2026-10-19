import { useRef, useCallback, useState, useMemo } from 'react';
import { PlacedComponent, Wire } from '../types';

export interface Snapshot {
  components: PlacedComponent[];
  wires: Wire[];
}

interface Entry extends Snapshot {
  /** Unique per entry; the dirty marker compares it with the saved entry. */
  id: number;
}

export const MAX_HISTORY = 50;

function cloneSnapshot(components: PlacedComponent[], wires: Wire[]): Snapshot {
  return {
    components: components.map((c) => ({ ...c, position: { ...c.position }, properties: { ...c.properties }, state: { ...c.state } })),
    wires: wires.map((w) => ({ ...w, from: { ...w.from }, to: { ...w.to }, waypoints: [...(w.waypoints ?? [])] })),
  };
}

/**
 * The undo stack as plain logic (no React), so it can be tested directly.
 * Every entry is the circuit *after* an action; the first entry is the state
 * that was loaded or reset to.
 */
export class HistoryStack {
  private stack: Entry[] = [];
  private pointer = -1;
  private nextId = 1;
  /** Entry id that matches the file on disk; null = never saved. */
  private savedId: number | null = null;

  push(components: PlacedComponent[], wires: Wire[]): void {
    const entry: Entry = { ...cloneSnapshot(components, wires), id: this.nextId++ };
    this.stack = this.stack.slice(0, this.pointer + 1);
    this.stack.push(entry);
    if (this.stack.length > MAX_HISTORY) {
      this.stack = this.stack.slice(this.stack.length - MAX_HISTORY);
    }
    this.pointer = this.stack.length - 1;
  }

  undo(): Snapshot | null {
    if (this.pointer <= 0) return null;
    this.pointer -= 1;
    const e = this.stack[this.pointer];
    return cloneSnapshot(e.components, e.wires);
  }

  redo(): Snapshot | null {
    if (this.pointer >= this.stack.length - 1) return null;
    this.pointer += 1;
    const e = this.stack[this.pointer];
    return cloneSnapshot(e.components, e.wires);
  }

  /** Start a fresh history at this state (load, restore). */
  reset(components: PlacedComponent[], wires: Wire[]): void {
    this.stack = [];
    this.pointer = -1;
    this.push(components, wires);
  }

  canUndo(): boolean { return this.pointer > 0; }
  canRedo(): boolean { return this.pointer < this.stack.length - 1; }

  /** The current entry matches what's on disk now. */
  markSaved(): void {
    this.savedId = this.stack[this.pointer]?.id ?? null;
  }

  /** Forget the saved marker (e.g. restored from an autosave that was dirty). */
  markUnsaved(): void {
    this.savedId = null;
  }

  isDirty(): boolean {
    const current = this.stack[this.pointer];
    if (!current) return false;
    return current.id !== this.savedId;
  }

  /** A copy of the current entry. */
  current(): Snapshot | null {
    const e = this.stack[this.pointer];
    return e ? cloneSnapshot(e.components, e.wires) : null;
  }
}

/**
 * Manages undo/redo history for circuit state.
 * Call push() after every user action that changes the circuit.
 * Call undo()/redo() to navigate history.
 *
 * Every call that changes the stack re-renders the owner, so canUndo(),
 * canRedo() and isDirty() read during render are always current.
 */
export function useHistory() {
  const h = useRef<HistoryStack | null>(null);
  if (!h.current) h.current = new HistoryStack();
  const [, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((r) => r + 1), []);

  const push = useCallback((components: PlacedComponent[], wires: Wire[]) => {
    h.current!.push(components, wires);
    bump();
  }, [bump]);

  const undo = useCallback((): Snapshot | null => {
    const s = h.current!.undo();
    if (s) bump();
    return s;
  }, [bump]);

  const redo = useCallback((): Snapshot | null => {
    const s = h.current!.redo();
    if (s) bump();
    return s;
  }, [bump]);

  const reset = useCallback((components: PlacedComponent[], wires: Wire[]) => {
    h.current!.reset(components, wires);
    bump();
  }, [bump]);

  const markSaved = useCallback(() => { h.current!.markSaved(); bump(); }, [bump]);
  const markUnsaved = useCallback(() => { h.current!.markUnsaved(); bump(); }, [bump]);
  const canUndo = useCallback(() => h.current!.canUndo(), []);
  const canRedo = useCallback(() => h.current!.canRedo(), []);
  const isDirty = useCallback(() => h.current!.isDirty(), []);

  // Stable object: callbacks that depend on `history` don't change per push.
  return useMemo(
    () => ({ push, undo, redo, reset, canUndo, canRedo, markSaved, markUnsaved, isDirty }),
    [push, undo, redo, reset, canUndo, canRedo, markSaved, markUnsaved, isDirty],
  );
}
