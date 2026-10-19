import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnthropicSdk from '@anthropic-ai/sdk';
import type Anthropic from '@anthropic-ai/sdk';
import { cancelChat, describeError, runChat } from './claudeChat';
import { userTurn, validateHistory } from './chatHistory';

// A fake ipcMain so runChat's tool round-trip can be driven from the test.
const ipc = vi.hoisted(() => new (require('events').EventEmitter)() as import('events').EventEmitter);
vi.mock('electron', () => ({ ipcMain: ipc }));

type Msg = Partial<Anthropic.Message> & { content: Anthropic.ContentBlock[]; stop_reason: Anthropic.Message['stop_reason'] };

function usage(input: number, output: number, read = 0, write = 0) {
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write } as Anthropic.Usage;
}

/** A stub client: each stream() call returns the next scripted response (no network). */
function stubClient(script: (Msg | Error)[]) {
  const requests: Anthropic.MessageStreamParams[] = [];
  const client = {
    messages: {
      stream: (params: Anthropic.MessageStreamParams) => {
        requests.push(JSON.parse(JSON.stringify(params)));
        const next = script.shift();
        const handlers: Record<string, (d: string) => void> = {};
        return {
          on(ev: string, cb: (d: string) => void) { handlers[ev] = cb; return this; },
          abort() {},
          currentMessage: next instanceof Error ? undefined : (next as Anthropic.Message),
          async finalMessage() {
            if (!next) throw new Error('script exhausted');
            if (next instanceof Error) throw next;
            for (const b of next.content) if (b.type === 'text') handlers.text?.(b.text);
            return next as Anthropic.Message;
          },
        };
      },
    },
  };
  return { client: client as unknown as Pick<Anthropic, 'messages'>, requests };
}

function fakeWebContents(onToolCalls?: (requestId: string, calls: { id: string; name: string }[]) => void) {
  const sent: { channel: string; payload: Record<string, unknown> }[] = [];
  const wc = {
    isDestroyed: () => false,
    send: (channel: string, payload: Record<string, unknown>) => {
      sent.push({ channel, payload });
      if (channel === 'chat-stream-tool-calls' && onToolCalls) {
        setTimeout(() => onToolCalls(payload.requestId as string, payload.toolCalls as { id: string; name: string }[]), 0);
      }
    },
  };
  return { wc, sent };
}

const choice = { setting: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5', effort: 'medium' as const, reason: 'test' };

function answerTools(wc: unknown) {
  return (requestId: string, calls: { id: string }[]) => {
    ipc.emit(`chat-tool-result-${requestId}`, { sender: wc }, calls.map((c) => ({ id: c.id, result: { success: true, message: 'ok' } })));
  };
}

beforeEach(() => ipc.removeAllListeners());

describe('runChat', () => {
  it('sums usage over every round of a tool loop and keeps a valid history', async () => {
    const script: Msg[] = [
      { content: [{ type: 'tool_use', id: 't1', name: 'add_component', input: {} } as Anthropic.ContentBlock], stop_reason: 'tool_use', usage: usage(100, 50, 0, 3000) },
      { content: [{ type: 'tool_use', id: 't2', name: 'add_wire', input: {} } as Anthropic.ContentBlock], stop_reason: 'tool_use', usage: usage(20, 40, 3000, 0) },
      { content: [{ type: 'text', text: 'Built it.' } as Anthropic.ContentBlock], stop_reason: 'end_turn', usage: usage(10, 30, 3100, 0) },
    ];
    const { client, requests } = stubClient(script);
    const conversation = { id: 'c', messages: [userTurn('build a blinker', '')], updated: 0 };
    let wcRef: unknown;
    const { wc, sent } = fakeWebContents((id, calls) => answerTools(wcRef)(id, calls));
    wcRef = wc;
    const onUsage = vi.fn();

    await runChat(wc as never, { apiKey: 'x', choice, conversation, componentCatalog: 'cat', requestId: 'r1', onUsage, isTrustedSender: () => true, client });

    expect(onUsage).toHaveBeenCalledTimes(1);
    const [, total, cost, rounds] = onUsage.mock.calls[0];
    expect(rounds).toBe(3);
    expect(total).toEqual({ inputTokens: 130, outputTokens: 120, cacheReadTokens: 6100, cacheWriteTokens: 3000 });
    expect(cost).toBeCloseTo((130 * 2 + 120 * 10 + 6100 * 0.2 + 3000 * 2.5) / 1e6, 10);
    const done = sent.find((s) => s.channel === 'chat-stream-done');
    expect(done?.payload.rounds).toBe(3);
    expect(validateHistory(conversation.messages)).toBeNull();
    expect(conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    // Request shape: effort set, max_tokens >= 16000, cached system + last message.
    expect(requests[0].max_tokens).toBeGreaterThanOrEqual(16000);
    expect(requests[0].output_config).toEqual({ effort: 'medium' });
    expect(JSON.stringify(requests[0].system)).toMatch(/ephemeral/);
    const last = requests[2].messages[requests[2].messages.length - 1];
    expect(JSON.stringify(last)).toMatch(/cache_control/);
    expect(requests[2].tools?.some((t) => (t as { strict?: boolean }).strict)).toBe(true);
  });

  it('records usage of finished rounds when a later round fails, and reports a clear error', async () => {
    const conn = new AnthropicSdk.APIConnectionError({ message: 'Connection error.' });
    const script: (Msg | Error)[] = [
      { content: [{ type: 'tool_use', id: 't1', name: 'list_components', input: {} } as Anthropic.ContentBlock], stop_reason: 'tool_use', usage: usage(100, 10) },
      conn,
    ];
    const { client } = stubClient(script);
    const conversation = { id: 'c', messages: [userTurn('hi', '')], updated: 0 };
    let wcRef: unknown;
    const { wc, sent } = fakeWebContents((id, calls) => answerTools(wcRef)(id, calls));
    wcRef = wc;
    const onUsage = vi.fn();
    await runChat(wc as never, { apiKey: 'x', choice, conversation, componentCatalog: '', requestId: 'r2', onUsage, isTrustedSender: () => true, client });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][1].inputTokens).toBe(100);
    const err = sent.find((s) => s.channel === 'chat-stream-error');
    expect(err?.payload.message).toMatch(/internet connection/);
    expect(validateHistory(conversation.messages)).toBeNull();
  });

  it('drops the user turn when the very first request fails, so a retry is clean', async () => {
    const { client } = stubClient([new AnthropicSdk.APIConnectionError({ message: 'x' })]);
    const conversation = { id: 'c', messages: [userTurn('hi', '')], updated: 0 };
    const { wc } = fakeWebContents();
    await runChat(wc as never, { apiKey: 'x', choice, conversation, componentCatalog: '', requestId: 'r3', onUsage: vi.fn(), isTrustedSender: () => true, client });
    expect(conversation.messages).toEqual([]);
  });

  it.each([
    ['max_tokens', /length limit/],
    ['refusal', /declined/],
  ] as const)('shows a notice for stop_reason %s', async (reason, re) => {
    const { client } = stubClient([
      { content: [{ type: 'text', text: 'partial' } as Anthropic.ContentBlock, { type: 'tool_use', id: 'tx', name: 'add_wire', input: {} } as Anthropic.ContentBlock], stop_reason: reason, usage: usage(1, 1) },
    ]);
    const conversation = { id: 'c', messages: [userTurn('hi', '')], updated: 0 };
    const { wc, sent } = fakeWebContents();
    await runChat(wc as never, { apiKey: 'x', choice, conversation, componentCatalog: '', requestId: `r-${reason}`, onUsage: vi.fn(), isTrustedSender: () => true, client });
    expect(sent.some((s) => s.channel === 'chat-stream-notice' && re.test(String(s.payload.message)))).toBe(true);
    // The unrun tool call is not left unanswered in history.
    expect(validateHistory(conversation.messages)).toBeNull();
    expect(JSON.stringify(conversation.messages)).not.toMatch(/tool_use/);
  });

  it('Stop while waiting for tool results closes the turn validly', async () => {
    const { client } = stubClient([
      { content: [{ type: 'tool_use', id: 't1', name: 'add_component', input: {} } as Anthropic.ContentBlock], stop_reason: 'tool_use', usage: usage(5, 5) },
    ]);
    const conversation = { id: 'c', messages: [userTurn('build', '')], updated: 0 };
    const { wc, sent } = fakeWebContents(() => cancelChat('r-stop'));
    const onUsage = vi.fn();
    await runChat(wc as never, { apiKey: 'x', choice, conversation, componentCatalog: '', requestId: 'r-stop', onUsage, isTrustedSender: () => true, client });
    expect(validateHistory(conversation.messages)).toBeNull();
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(sent.find((s) => s.channel === 'chat-stream-done')?.payload.stopReason).toBe('cancelled');
  });

  it('ignores tool results from an untrusted sender', async () => {
    vi.useFakeTimers();
    try {
      const { client } = stubClient([
        { content: [{ type: 'tool_use', id: 't1', name: 'add_component', input: {} } as Anthropic.ContentBlock], stop_reason: 'tool_use', usage: usage(5, 5) },
        { content: [{ type: 'text', text: 'ok' } as Anthropic.ContentBlock], stop_reason: 'end_turn', usage: usage(5, 5) },
      ]);
      const conversation = { id: 'c', messages: [userTurn('build', '')], updated: 0 };
      let wcRef: unknown;
      const { wc } = fakeWebContents((id, calls) => answerTools(wcRef)(id, calls));
      wcRef = wc;
      const p = runChat(wc as never, { apiKey: 'x', choice, conversation, componentCatalog: '', requestId: 'r-untrusted', onUsage: vi.fn(), isTrustedSender: () => false, client });
      await vi.advanceTimersByTimeAsync(31_000);
      await p;
      // The untrusted answer was ignored, so the round-trip timed out.
      expect(JSON.stringify(conversation.messages)).toMatch(/did not answer in time/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('describeError (U2)', () => {
  it('gives plain sentences', () => {
    expect(describeError(new AnthropicSdk.APIConnectionError({ message: 'x' }), 'm').message).toMatch(/internet/);
    expect(describeError(new Error('boom'), 'm').message).toBe('boom');
    const overloaded = new AnthropicSdk.APIError(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', new Headers());
    expect(describeError(overloaded, 'm').kind).toBe('overloaded');
    const auth = new AnthropicSdk.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error' } }, 'invalid x-api-key', new Headers());
    expect(describeError(auth, 'm').message).toMatch(/API key was rejected/);
    const rate = new AnthropicSdk.RateLimitError(429, {}, 'rate', new Headers());
    expect(describeError(rate, 'm').kind).toBe('rate_limit');
  });
});
