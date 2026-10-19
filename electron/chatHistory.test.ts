import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  assistantTurn,
  closeOpenToolUse,
  ConversationStore,
  historyFromPlain,
  NO_REPLY_TEXT,
  toolResultsTurn,
  userTurn,
  validateHistory,
  withCacheBreakpoint,
} from './chatHistory';

type Block = Anthropic.ContentBlockParam & { cache_control?: unknown };

const toolUse = (id: string): Anthropic.ContentBlock =>
  ({ type: 'tool_use', id, name: 'add_component', input: { type: 'led', col: 3, row: 4 } } as unknown as Anthropic.ContentBlock);
const text = (t: string): Anthropic.ContentBlock => ({ type: 'text', text: t, citations: null } as Anthropic.ContentBlock);
const thinking = (): Anthropic.ContentBlock => ({ type: 'thinking', thinking: '', signature: 'sig' } as Anthropic.ContentBlock);

describe('history building', () => {
  it('puts the circuit snapshot in the user turn', () => {
    const t = userTurn('why?', '{"components":[]}');
    expect(t.content).toHaveLength(2);
    expect(JSON.stringify(t.content)).toMatch(/current_circuit/);
    expect(userTurn('hi', '').content).toHaveLength(1);
  });

  it('never makes an empty assistant turn', () => {
    expect(assistantTurn([])).toEqual({ role: 'assistant', content: [{ type: 'text', text: NO_REPLY_TEXT }] });
    const onlyThinking = assistantTurn([thinking(), text('   ')]);
    expect((onlyThinking.content as Block[]).map((b) => b.type)).toEqual(['thinking', 'text']);
  });

  it('keeps thinking and tool_use blocks unchanged', () => {
    const t = assistantTurn([thinking(), text('Placing it.'), toolUse('tu_1')]);
    expect(t.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'Placing it.' },
      { type: 'tool_use', id: 'tu_1', name: 'add_component', input: { type: 'led', col: 3, row: 4 } },
    ]);
  });

  it('answers every tool_use in one user turn, in order, flagging failures', () => {
    const r = toolResultsTurn(['a', 'b', 'c'], [
      { id: 'b', result: { success: false, message: 'Unknown pin' } },
      { id: 'a', result: { success: true, message: 'ok' } },
    ]);
    const blocks = r.content as Anthropic.ToolResultBlockParam[];
    expect(blocks.map((b) => [b.tool_use_id, b.is_error])).toEqual([['a', false], ['b', true], ['c', true]]);
  });

  it('a full tool round validates; a dangling tool_use is closed', () => {
    const h: Anthropic.MessageParam[] = [userTurn('build', ''), assistantTurn([toolUse('t1')])];
    expect(validateHistory(h)).toMatch(/unanswered/);
    const closed = closeOpenToolUse(h);
    expect(validateHistory(closed)).toBeNull();
    expect(closed).toHaveLength(3);
    const full = [...h, toolResultsTurn(['t1'], [{ id: 't1', result: { success: true, message: 'ok' } }]), assistantTurn([text('Done.')])];
    expect(validateHistory(full)).toBeNull();
  });

  it('flags histories the API would reject', () => {
    expect(validateHistory([])).toBeTruthy();
    expect(validateHistory([{ role: 'assistant', content: 'x' }])).toMatch(/start/);
    expect(validateHistory([{ role: 'user', content: [] }])).toMatch(/empty/);
    expect(validateHistory([{ role: 'user', content: [{ type: 'text', text: ' ' }] }])).toMatch(/empty text/);
  });

  it('puts exactly one cache breakpoint on the last block and does not mutate history', () => {
    const h: Anthropic.MessageParam[] = [userTurn('a', 'ctx'), assistantTurn([text('b')]), userTurn('c', '')];
    const req = withCacheBreakpoint(h);
    const marks = req.flatMap((m) => (m.content as Block[]).filter((b) => b.cache_control));
    expect(marks).toHaveLength(1);
    expect((req[2].content as Block[])[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(h)).not.toMatch(/cache_control/);
    // A second call moves the marker; old markers are not carried over.
    const again = withCacheBreakpoint([...req, assistantTurn([text('d')])]);
    expect(again.flatMap((m) => (m.content as Block[]).filter((b) => b.cache_control))).toHaveLength(1);
  });

  it('does not put cache_control on a thinking block', () => {
    const req = withCacheBreakpoint([userTurn('a', ''), { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'thinking', thinking: '', signature: 's' }] }]);
    const last = req[1].content as Block[];
    expect(last[0].cache_control).toBeTruthy();
    expect(last[1].cache_control).toBeUndefined();
  });

  it('builds a plain fallback history without empty assistant turns', () => {
    const h = historyFromPlain(
      [
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'q2' },
      ],
      'ctx',
    );
    expect(h.map((m) => m.role)).toEqual(['user', 'user']);
    expect(JSON.stringify(h[1])).toMatch(/current_circuit/);
  });

  it('keeps a bounded number of conversations', () => {
    const s = new ConversationStore(2);
    s.get('a');
    s.get('b');
    s.get('c');
    expect([s.has('a'), s.has('b'), s.has('c')].filter(Boolean)).toHaveLength(2);
    expect(s.has('c')).toBe(true);
  });
});
