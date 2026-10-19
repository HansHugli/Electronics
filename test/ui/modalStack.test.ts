import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushModal, popModal, escapeTopModal, modalCount, isTopModal, shortcutsBlocked, isEditableTarget, _resetModalStack,
} from '../../src/components/modalStack';
import { formatSimClock } from '../../src/components/Toolbar';

beforeEach(() => _resetModalStack());

describe('modal stack', () => {
  it('Escape closes only the topmost modal', () => {
    const closed: string[] = [];
    const a = pushModal(() => closed.push('a'));
    const b = pushModal(() => closed.push('b'));
    expect(isTopModal(b)).toBe(true);
    expect(escapeTopModal()).toBe(true);
    expect(closed).toEqual(['b']);
    popModal(b);
    expect(isTopModal(a)).toBe(true);
    escapeTopModal();
    expect(closed).toEqual(['b', 'a']);
  });

  it('a modal without an Escape handler still swallows Escape', () => {
    pushModal(undefined);
    expect(escapeTopModal()).toBe(true);
    expect(modalCount()).toBe(1);
  });

  it('nothing open: Escape is not consumed', () => {
    expect(escapeTopModal()).toBe(false);
  });
});

describe('shortcut gating', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra });

  it('blocks while a modal is open', () => {
    expect(shortcutsBlocked({ target: el('DIV') })).toBe(false);
    const id = pushModal(() => {});
    expect(shortcutsBlocked({ target: el('DIV') })).toBe(true);
    popModal(id);
    expect(shortcutsBlocked({ target: el('DIV') })).toBe(false);
  });

  it('blocks while an editable element has focus', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      expect(shortcutsBlocked({ target: el(tag) })).toBe(true);
    }
    expect(shortcutsBlocked({ target: el('DIV', { isContentEditable: true }) })).toBe(true);
    expect(isEditableTarget(el('DIV', { getAttribute: (n: string) => (n === 'contenteditable' ? 'true' : null) }))).toBe(true);
    expect(shortcutsBlocked({ target: el('BUTTON') })).toBe(false);
    expect(shortcutsBlocked({ target: null })).toBe(false);
  });

  it('honours an extra dialog the stack does not own', () => {
    expect(shortcutsBlocked({ target: el('DIV') }, true)).toBe(true);
  });
});

describe('sim clock', () => {
  it('formats seconds and minutes', () => {
    expect(formatSimClock(0)).toBe('t = 0.0 s');
    expect(formatSimClock(12345)).toBe('t = 12.3 s');
    expect(formatSimClock(125400)).toBe('t = 2 min 05.4 s');
  });
});
