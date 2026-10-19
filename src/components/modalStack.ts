/**
 * One stack for every modal in the app.
 *
 * Each open modal registers here. The topmost one gets Escape, and global
 * shortcuts (Delete, R, Ctrl+Z/Y/S/O…) are switched off while anything is on
 * the stack, so a key pressed in a dialog never reaches the board behind it.
 */

interface Entry {
  id: number;
  /** Called by Escape. Undefined means the modal can't be dismissed with Escape. */
  onEscape?: () => void;
}

const stack: Entry[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function notify() {
  for (const l of listeners) l();
}

/** Register a modal; returns its id. */
export function pushModal(onEscape?: () => void): number {
  const id = nextId++;
  stack.push({ id, onEscape });
  notify();
  return id;
}

/** Replace the Escape handler of an open modal (keeps its place in the stack). */
export function updateModal(id: number, onEscape?: () => void): void {
  const entry = stack.find((e) => e.id === id);
  if (entry) entry.onEscape = onEscape;
}

export function popModal(id: number): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i >= 0) {
    stack.splice(i, 1);
    notify();
  }
}

export function modalCount(): number {
  return stack.length;
}

/** True when the given modal is the topmost one. */
export function isTopModal(id: number): boolean {
  return stack.length > 0 && stack[stack.length - 1].id === id;
}

/**
 * Escape: close the topmost modal. Returns true when a modal consumed the key
 * (even one without an Escape handler: the key must not fall through to the
 * board behind it).
 */
export function escapeTopModal(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.onEscape?.();
  return true;
}

export function subscribeModals(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test helper. */
export function _resetModalStack(): void {
  stack.length = 0;
  notify();
}

interface KeyTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

/** True when the element is a place where the user types text. */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as KeyTargetLike;
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  const ce = el.getAttribute?.('contenteditable');
  return ce === '' || ce === 'true' || ce === 'plaintext-only';
}

/**
 * Global shortcuts are off while a modal is open or while focus is in an
 * editable element. `extraModalOpen` covers dialogs this stack doesn't own
 * (e.g. one that renders its own overlay).
 */
export function shortcutsBlocked(e: { target: unknown }, extraModalOpen = false): boolean {
  if (stack.length > 0 || extraModalOpen) return true;
  if (isEditableTarget(e.target)) return true;
  if (typeof document !== 'undefined' && isEditableTarget(document.activeElement)) return true;
  return false;
}
