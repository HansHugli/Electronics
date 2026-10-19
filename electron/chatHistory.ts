import type Anthropic from '@anthropic-ai/sdk';

/**
 * Building the message history sent to the API.
 *
 * Main keeps each conversation's FULL content blocks (thinking, tool_use,
 * tool_result), appended only, so the history stays valid and its prefix
 * stays cacheable. Nothing here talks to the network.
 */

type MessageParam = Anthropic.MessageParam;
type ContentBlockParam = Anthropic.ContentBlockParam;

export const NO_REPLY_TEXT = '(no reply)';
export const STOPPED_TEXT = '(stopped by the user)';

/** A user turn: the question, then (when sent) the circuit snapshot. */
export function userTurn(text: string, circuitContext: string): MessageParam {
  const content: ContentBlockParam[] = [{ type: 'text', text: text.trim() || '(empty message)' }];
  if (circuitContext) {
    content.push({
      type: 'text',
      text: `<current_circuit>\nThe user's current circuit (JSON):\n${circuitContext}\n</current_circuit>`,
    });
  }
  return { role: 'user', content };
}

/** Convert a response's content to history params; never empty. */
export function assistantTurn(content: readonly Anthropic.ContentBlock[] | readonly ContentBlockParam[]): MessageParam {
  const out: ContentBlockParam[] = [];
  for (const block of content as readonly (Anthropic.ContentBlock | ContentBlockParam)[]) {
    switch (block.type) {
      case 'text':
        if (block.text.trim()) out.push({ type: 'text', text: block.text });
        break;
      case 'thinking':
        out.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
        break;
      case 'redacted_thinking':
        out.push({ type: 'redacted_thinking', data: block.data });
        break;
      case 'tool_use':
        out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        break;
      default:
        out.push(block as ContentBlockParam);
    }
  }
  // A turn with only thinking (or nothing) still needs visible content.
  if (!out.some((b) => b.type === 'text' || b.type === 'tool_use')) {
    out.push({ type: 'text', text: NO_REPLY_TEXT });
  }
  return { role: 'assistant', content: out };
}

export interface ToolResultIn {
  id: string;
  result: { success: boolean; message: string; data?: Record<string, unknown> };
}

/** All tool results for one assistant turn, in ONE user message. */
export function toolResultsTurn(toolUseIds: string[], results: ToolResultIn[]): MessageParam {
  const byId = new Map(results.map((r) => [r.id, r]));
  return {
    role: 'user',
    content: toolUseIds.map((id) => {
      const r = byId.get(id);
      if (!r) {
        return { type: 'tool_result' as const, tool_use_id: id, is_error: true, content: 'No result was returned for this tool call.' };
      }
      return {
        type: 'tool_result' as const,
        tool_use_id: id,
        is_error: !r.result.success,
        content: JSON.stringify(r.result),
      };
    }),
  };
}

export function cancelledResultsTurn(toolUseIds: string[], why = 'Cancelled: the user stopped the request.'): MessageParam {
  return {
    role: 'user',
    content: toolUseIds.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, is_error: true, content: why })),
  };
}

function toolUseIds(msg: MessageParam): string[] {
  if (typeof msg.content === 'string') return [];
  return msg.content.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use').map((b) => b.id);
}

/**
 * Make a history valid before sending: starts with a user turn, no empty
 * turns, every tool_use answered by a tool_result in the next user turn.
 * Only repairs the tail (appending), so the cached prefix is untouched.
 */
export function closeOpenToolUse(messages: MessageParam[]): MessageParam[] {
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') {
    const ids = toolUseIds(last);
    if (ids.length > 0) return [...messages, cancelledResultsTurn(ids)];
  }
  return messages;
}

/** Check a history the way the API would. Returns a problem or null. */
export function validateHistory(messages: MessageParam[]): string | null {
  if (messages.length === 0) return 'empty history';
  if (messages[0].role !== 'user') return 'history must start with a user turn';
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (typeof m.content === 'string' ? !m.content.trim() : m.content.length === 0) return `turn ${i} is empty`;
    if (typeof m.content !== 'string') {
      for (const b of m.content) {
        if (b.type === 'text' && !b.text.trim()) return `turn ${i} has an empty text block`;
      }
    }
    const ids = toolUseIds(m);
    if (m.role === 'assistant' && ids.length > 0) {
      const next = messages[i + 1];
      if (!next) return `turn ${i} has unanswered tool calls`;
      const answered = typeof next.content === 'string'
        ? []
        : next.content.filter((b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result').map((b) => b.tool_use_id);
      if (next.role !== 'user' || ids.some((id) => !answered.includes(id))) return `turn ${i} has unanswered tool calls`;
    }
  }
  return null;
}

/**
 * The request copy: same blocks, with ONE cache breakpoint on the last block
 * of the last message (incremental caching). Earlier markers are not
 * carried, so the request stays within the 4-breakpoint limit.
 */
export function withCacheBreakpoint(messages: MessageParam[]): MessageParam[] {
  return messages.map((m, i) => {
    const blocks: ContentBlockParam[] = typeof m.content === 'string'
      ? [{ type: 'text', text: m.content }]
      : m.content.map((b) => {
          const copy = { ...b } as ContentBlockParam & { cache_control?: unknown };
          delete copy.cache_control;
          return copy;
        });
    if (i === messages.length - 1) {
      // Thinking blocks can't carry cache_control; mark the last other block.
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j];
        if (b.type !== 'thinking' && b.type !== 'redacted_thinking') {
          blocks[j] = { ...b, cache_control: { type: 'ephemeral' } } as ContentBlockParam;
          break;
        }
      }
    }
    return { role: m.role, content: blocks };
  });
}

/** Fallback for a renderer that doesn't send a conversation ID: plain text turns. */
export function historyFromPlain(
  messages: { role: 'user' | 'assistant'; content: string }[],
  circuitContext: string,
): MessageParam[] {
  const out: MessageParam[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      out.push(userTurn(m.content, i === messages.length - 1 ? circuitContext : ''));
    } else if (m.content.trim()) {
      out.push({ role: 'assistant', content: [{ type: 'text', text: m.content }] });
    }
  });
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export interface Conversation {
  id: string;
  messages: MessageParam[];
  updated: number;
}

/** In-memory conversations, newest kept. */
export class ConversationStore {
  private map = new Map<string, Conversation>();
  constructor(private readonly max = 8) {}

  get(id: string): Conversation {
    let c = this.map.get(id);
    if (!c) {
      c = { id, messages: [], updated: Date.now() };
      this.map.set(id, c);
      if (this.map.size > this.max) {
        const oldest = [...this.map.values()].sort((a, b) => a.updated - b.updated)[0];
        this.map.delete(oldest.id);
      }
    }
    c.updated = Date.now();
    return c;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  delete(id: string) {
    this.map.delete(id);
  }
}
