import Anthropic from '@anthropic-ai/sdk';
import type { WebContents } from 'electron';
import { ipcMain } from 'electron';
import {
  assistantTurn,
  cancelledResultsTurn,
  closeOpenToolUse,
  Conversation,
  STOPPED_TEXT,
  toolResultsTurn,
  ToolResultIn,
  validateHistory,
  withCacheBreakpoint,
} from './chatHistory';
import { ModelChoice } from './modelSelect';
import { addUsage, calculateCost, emptyUsage, TokenUsage, usageFromApi } from './pricing';
import { CIRCUIT_TOOLS, toolsForModel } from './chatTools';

/**
 * Claude chat in the main process. The renderer never holds the API key.
 *
 *   renderer → 'chat-send' → runChat() → Anthropic API (streamed)
 *   renderer ← token / tool-call / notice / done / error events
 *
 * Tool loop: tool_use blocks go to the renderer ('chat-stream-tool-calls'),
 * which validates and executes them on the circuit and answers on
 * 'chat-tool-result-<requestId>' (with a timeout). The full content blocks
 * of every round are kept in the conversation, so history stays valid.
 */

export type { CircuitContextMode } from './config';
export { CIRCUIT_TOOLS };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const MAX_TOKENS = 16000;
export const MAX_ROUNDS = 25;
export const TOOL_RESULT_TIMEOUT_MS = 30_000;

export interface RunChatRequest {
  apiKey: string;
  choice: ModelChoice;
  conversation: Conversation;
  componentCatalog: string;
  requestId: string;
  /** Called once per user turn with usage summed over every round. */
  onUsage: (model: string, usage: TokenUsage, cost: number | null, rounds: number) => void;
  /** Used to check that tool results come from our own window. */
  isTrustedSender: (event: Electron.IpcMainEvent) => boolean;
  /** Test hook: inject a client. */
  client?: Pick<Anthropic, 'messages'>;
}

// ---- System Prompt ---- //

const SYSTEM_PROMPT = `You are an electronics tutor and assistant embedded in the E101 visual circuit simulator. The user builds circuits by placing components on a virtual breadboard, wiring them, and running a simulation.

Help them:
- understand how their circuit works (or why it doesn't);
- debug problems ("why isn't my LED lighting up?");
- build or change circuits when they ask ("build me a 555 blink circuit");
- learn electronics concepts at their level.

Rules:
1. When the user asks you to build, add, wire or change something, do it with your tools (add_component, add_wire, ...). Don't write wiring instructions for them to follow.
2. If a part isn't in the catalog, create it with create_component_type (it is drawn with labelled pins but has no electrical model), then place and wire it.
3. Build first, explain after: a short summary of what you placed, then suggest clicking Run.
4. Never clear or replace a board that has components on it unless the user asked to start over. If a request seems to need a clean board, ask first ("Clear the current circuit and start over?"), or build beside the existing parts. clear_circuit refuses on a non-empty board otherwise.
5. Tool results report problems (unknown pin, off-board position, overlap). Read them and fix the call; don't repeat a failing call unchanged.
6. Be concise: the chat panel is narrow; 1-4 short paragraphs.
7. Refer to component IDs and pin names from the circuit snapshot. If you need details about a component type (pins, size, properties), call list_component_types. If you lack information, ask one focused question.
8. For Arduino/AVR sketches, suggest code in code blocks; the user edits and compiles them in the Sketch Editor.

Board layout (grid coordinates):
- Columns 0-30, rows 0-49. Board 1 is columns 0-14, board 2 is columns 16-30 (column 15 is the space between boards).
- On board 1: columns 0-1 are the left power rails, 2-6 the left component area, 7 the centre gap, 8-12 the right component area, 13-14 the right power rails. Board 2 is the same shifted by 16 (gap at 23).
- In the component area the 5 holes of one row on one side of the gap are connected. Rail holes connect in blocks of 5 rows.
- Board holes are written "col,row" (e.g. "3,12"); there are no holes at columns 7, 15 and 23.

Placement:
- add_component's col,row is where the component's first pin lands.
- DIP chips (width 2) straddle the gap: use col 6 on board 1 or col 22 on board 2; the left pins land on col 6 and the right pins on col 8.
- Width-1 parts (resistors, LEDs, capacitors, switches) go in the component areas (cols 2-6 or 8-12, or 18-22 / 24-28 on board 2).
- Leave a row or two between parts; a chip occupies several rows.
- Power supplies go off the board: col -4, row 0-10.

Wiring:
- Wire pins to pins, or a pin to a board hole: { componentId: "board", pinId: "col,row" }.
- Use board holes to reach the rails or to use the strips' internal connections.

Component catalog (type: label [pins] {properties}):
{COMPONENT_CATALOG}`;

// ---- Active requests (for Stop) ---- //

interface ActiveRequest {
  controller: AbortController;
  stream?: { abort(): void };
  cancelToolWait?: () => void;
}

const active = new Map<string, ActiveRequest>();

/** Stop a running request (the Stop button). Returns true if one was running. */
export function cancelChat(requestId: string): boolean {
  const req = active.get(requestId);
  if (!req) return false;
  req.controller.abort();
  req.stream?.abort();
  req.cancelToolWait?.();
  return true;
}

// ---- Tool round-trip ---- //

type ToolWaitResult = { kind: 'ok'; results: ToolResultIn[] } | { kind: 'timeout' } | { kind: 'cancelled' };

function waitForToolResults(
  webContents: WebContents,
  requestId: string,
  toolCalls: { id: string; name: string; input: unknown }[],
  entry: ActiveRequest,
  isTrustedSender: (event: Electron.IpcMainEvent) => boolean,
): Promise<ToolWaitResult> {
  return new Promise((resolve) => {
    const channel = `chat-tool-result-${requestId}`;
    let settled = false;
    const finish = (r: ToolWaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener(channel, listener);
      entry.cancelToolWait = undefined;
      resolve(r);
    };
    const listener = (event: Electron.IpcMainEvent, results: unknown) => {
      if (!isTrustedSender(event) || event.sender !== webContents) return;
      finish({ kind: 'ok', results: sanitizeResults(results) });
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), TOOL_RESULT_TIMEOUT_MS);
    entry.cancelToolWait = () => finish({ kind: 'cancelled' });
    ipcMain.on(channel, listener);
    if (webContents.isDestroyed()) {
      finish({ kind: 'cancelled' });
      return;
    }
    webContents.send('chat-stream-tool-calls', { requestId, toolCalls });
  });
}

function sanitizeResults(raw: unknown): ToolResultIn[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolResultIn[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { id, result } = r as { id?: unknown; result?: { success?: unknown; message?: unknown; data?: unknown } };
    if (typeof id !== 'string' || !result || typeof result !== 'object') continue;
    const message = typeof result.message === 'string' ? result.message.slice(0, 4000) : '';
    const data = result.data && typeof result.data === 'object' ? (result.data as Record<string, unknown>) : undefined;
    out.push({ id, result: { success: result.success === true, message, data } });
  }
  return out;
}

// ---- Errors ---- //

export function describeError(err: unknown, model: string): { kind: string; message: string } {
  const apiType = (err as { error?: { error?: { type?: string } } })?.error?.error?.type;
  if (err instanceof Anthropic.APIUserAbortError) return { kind: 'cancelled', message: 'Stopped.' };
  if (err instanceof Anthropic.AuthenticationError) {
    return { kind: 'auth', message: 'Your Anthropic API key was rejected. Check or replace it in Settings.' };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { kind: 'permission', message: `This API key isn't allowed to use ${model}. Pick another model or check the key's workspace.` };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { kind: 'not_found', message: `The model ${model} isn't available to this API key. Pick another model.` };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { kind: 'rate_limit', message: 'You have hit the API rate limit. Wait a minute, then try again.' };
  }
  if (apiType === 'overloaded_error' || (err instanceof Anthropic.APIError && err.status === 529)) {
    return { kind: 'overloaded', message: "Anthropic's servers are overloaded right now. Try again in a minute." };
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { kind: 'timeout', message: 'The request to Anthropic timed out. Check your connection and try again.' };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: 'network', message: "Couldn't reach the Anthropic API. Check your internet connection and try again." };
  }
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.message || '';
    if (/credit balance/i.test(msg)) {
      return { kind: 'billing', message: 'Your Anthropic credit balance is too low. Add credits at console.anthropic.com.' };
    }
    return { kind: 'bad_request', message: `The API rejected the request: ${msg}` };
  }
  if (err instanceof Anthropic.InternalServerError) {
    return { kind: 'server', message: 'The Anthropic API had an internal error. Try again in a moment.' };
  }
  if (err instanceof Anthropic.APIError) {
    return { kind: 'api_error', message: `The Anthropic API returned an error${err.status ? ` (${err.status})` : ''}: ${err.message || 'no details'}` };
  }
  if (err instanceof Error) return { kind: 'unknown', message: err.message || 'Something went wrong.' };
  return { kind: 'unknown', message: 'Something went wrong.' };
}

// ---- Main loop ---- //

function send(webContents: WebContents, channel: string, payload: unknown) {
  if (!webContents.isDestroyed()) webContents.send(channel, payload);
}

export function buildSystemText(componentCatalog: string): string {
  return SYSTEM_PROMPT.replace('{COMPONENT_CATALOG}', componentCatalog || '(catalog unavailable: call list_component_types)');
}

export async function runChat(webContents: WebContents, req: RunChatRequest): Promise<void> {
  const { requestId, choice, conversation } = req;
  const model = choice.model;
  const entry: ActiveRequest = { controller: new AbortController() };
  active.set(requestId, entry);
  // Index of this turn's user message (the caller appends it before calling).
  const startLen = conversation.messages.length - 1;

  const client = req.client ?? new Anthropic({ apiKey: req.apiKey, maxRetries: 2, timeout: 5 * 60 * 1000 });
  const systemText = buildSystemText(req.componentCatalog);
  const tools = toolsForModel(model);

  let total = emptyUsage();
  let cost: number | null = 0;
  let rounds = 0;
  let stopReason: string | null = null;
  const addRound = (u: TokenUsage) => {
    rounds++;
    total = addUsage(total, u);
    const c = calculateCost(model, u);
    cost = cost === null || c === null ? null : cost + c;
  };
  const notice = (kind: string, message: string) => send(webContents, 'chat-stream-notice', { requestId, kind, message });

  send(webContents, 'chat-stream-model', { requestId, model, reason: choice.reason });

  try {
    conversation.messages = closeOpenToolUse(conversation.messages);
    const problem = validateHistory(conversation.messages);
    if (problem) throw new Error(`The conversation history is invalid (${problem}). Click Clear to start a new conversation.`);

    while (true) {
      if (rounds >= MAX_ROUNDS) {
        stopReason = 'max_rounds';
        conversation.messages.push({ role: 'assistant', content: [{ type: 'text', text: `(stopped after ${MAX_ROUNDS} steps)` }] });
        notice('max_rounds', `Claude stopped after ${MAX_ROUNDS} tool steps. Ask it to continue if the job isn't finished.`);
        break;
      }

      const stream = client.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
          tools,
          messages: withCacheBreakpoint(conversation.messages),
          output_config: { effort: choice.effort },
        },
        { signal: entry.controller.signal },
      );
      entry.stream = stream;
      stream.on('text', (delta) => send(webContents, 'chat-stream-token', { requestId, delta }));

      let finalMessage: Anthropic.Message;
      try {
        finalMessage = await stream.finalMessage();
      } catch (err) {
        // Count whatever the aborted/failed round already used.
        const partial = (stream as { currentMessage?: Anthropic.Message }).currentMessage;
        if (partial?.usage) addRound(usageFromApi(partial.usage));
        throw err;
      }
      addRound(usageFromApi(finalMessage.usage));
      stopReason = finalMessage.stop_reason;

      const toolUses = finalMessage.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

      if (stopReason === 'tool_use' && toolUses.length > 0) {
        conversation.messages.push(assistantTurn(finalMessage.content));
        const toolCalls = toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }));
        send(webContents, 'chat-stream-token', { requestId, delta: '', toolCalls: toolCalls.map((t) => ({ name: t.name, input: t.input })) });
        const ids = toolUses.map((b) => b.id);
        const wait = await waitForToolResults(webContents, requestId, toolCalls, entry, req.isTrustedSender);
        if (wait.kind === 'cancelled' || entry.controller.signal.aborted) {
          conversation.messages.push(cancelledResultsTurn(ids));
          conversation.messages.push({ role: 'assistant', content: [{ type: 'text', text: STOPPED_TEXT }] });
          stopReason = 'cancelled';
          notice('cancelled', 'Stopped. Changes made so far stay on the board (Undo removes them).');
          break;
        }
        if (wait.kind === 'timeout') {
          conversation.messages.push(cancelledResultsTurn(ids, 'The app did not answer in time; the tool calls may not have run. Check the board with list_components.'));
          notice('tool_timeout', 'The circuit editor did not answer in time; Claude was told the tools may not have run.');
          continue;
        }
        conversation.messages.push(toolResultsTurn(ids, wait.results));
        continue;
      }

      if (stopReason === 'pause_turn') {
        // Long turn paused by the API: send it back so it continues.
        conversation.messages.push(assistantTurn(finalMessage.content));
        continue;
      }

      // Final answer (or a stop we must report). Unrun tool_use blocks are
      // dropped so the stored history has no unanswered calls.
      const keep = finalMessage.content.filter((b) => b.type !== 'tool_use');
      conversation.messages.push(assistantTurn(keep));
      if (stopReason === 'max_tokens') {
        notice('max_tokens', "Claude's reply hit the length limit and was cut off. Ask it to continue.");
      } else if (stopReason === 'refusal') {
        notice('refusal', 'Claude declined to answer this request. Try rephrasing it.');
      }
      break;
    }

    req.onUsage(model, total, cost, rounds);
    send(webContents, 'chat-stream-done', { requestId, stopReason, usage: total, cost, rounds, model });
  } catch (err) {
    if (rounds > 0) req.onUsage(model, total, cost, rounds);
    const aborted = entry.controller.signal.aborted || err instanceof Anthropic.APIUserAbortError;
    if (aborted) {
      // Keep the history valid: an unanswered user turn gets a stub reply.
      const last = conversation.messages[conversation.messages.length - 1];
      if (last?.role === 'user') conversation.messages.push({ role: 'assistant', content: [{ type: 'text', text: STOPPED_TEXT }] });
      notice('cancelled', 'Stopped.');
      send(webContents, 'chat-stream-done', { requestId, stopReason: 'cancelled', usage: total, cost, rounds, model });
    } else {
      const { kind, message } = describeError(err, model);
      // The API never accepted this turn's request: drop the unanswered user
      // turn so a retry doesn't send it twice. Mid-loop, close the turn instead.
      const msgs = conversation.messages;
      if (msgs.length === startLen + 1 && msgs[startLen]?.role === 'user') msgs.pop();
      else if (msgs[msgs.length - 1]?.role === 'user') msgs.push({ role: 'assistant', content: [{ type: 'text', text: `(the request failed: ${kind})` }] });
      send(webContents, 'chat-stream-error', { requestId, kind, message, usage: total, cost });
    }
  } finally {
    active.delete(requestId);
  }
}
