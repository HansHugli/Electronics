import Anthropic from '@anthropic-ai/sdk';
import type { WebContents } from 'electron';

/**
 * Claude chat IPC module.
 *
 * The renderer never holds the Anthropic API key. Chat messages flow:
 *   renderer → IPC → streamChat() → Anthropic API
 *                                       ↓ token deltas
 *   renderer ← IPC events ← streamChat()
 *
 * This way the key stays in the main process and can't leak via the
 * renderer's React DevTools, error reporters, etc.
 */

export type CircuitContextMode = 'always' | 'on-change' | 'never';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamChatRequest {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  /** Pre-rendered circuit JSON to include as a system reminder. Sent only
   *  when the renderer determines the circuit has changed (or always/never,
   *  per the user's setting). Empty string means "no circuit context this
   *  turn." */
  circuitContext: string;
  /** Stable component-catalog string that lists every component the
   *  simulator knows about. This is cached via prompt caching since it
   *  changes only across app versions, not per request. */
  componentCatalog: string;
  /** Renderer-side request ID, echoed in stream events so the renderer can
   *  route concurrent streams (we only ever expect one at a time, but the
   *  ID also lets the UI ignore tokens from a cancelled prior request). */
  requestId: string;
}

const SYSTEM_PROMPT = `You are an electronics tutor and assistant embedded in the e101 visual circuit simulator. The user is building circuits by placing components on a virtual breadboard and wiring them together, then running a simulation to see what happens.

Your job is to help them:
- Understand how their current circuit works (or doesn't)
- Debug problems ("why isn't my LED lighting up?")
- Suggest components and wiring for what they're trying to build
- Explain electronics concepts at the level the user seems to be at

Guidelines:
- Be concise. Most answers should fit in 1–4 short paragraphs. The chat panel is narrow.
- When the user shares their circuit, refer to specific component IDs and pin names from the JSON.
- Only suggest components from the catalog below. Do NOT invent component types — if the simulator doesn't have something, say so and suggest the closest available alternative.
- For wiring suggestions, name the exact pins to connect (e.g., "wire avr1.pd2 to led1.anode").
- If you don't have enough information, ask one focused question rather than guessing.
- For Arduino/AVR sketches, the user can edit and recompile via the Sketch Editor — you can suggest sketch changes as code blocks.

Available component catalog (id → label):
{COMPONENT_CATALOG}`;

/**
 * Run a streaming chat request and pump events back to the renderer over
 * IPC. Resolves when the stream completes (success or error). The renderer
 * subscribes to `chat-stream-token`, `chat-stream-done`, `chat-stream-error`.
 */
export async function streamChat(
  webContents: WebContents,
  req: StreamChatRequest,
): Promise<void> {
  const { apiKey, model, messages, circuitContext, componentCatalog, requestId } = req;

  // Build the system prompt with the (stable) catalog interpolated. The
  // entire system block is marked cacheable — across a chat session this is
  // identical every turn, so after the first request it costs ~10% of input
  // price.
  const systemText = SYSTEM_PROMPT.replace('{COMPONENT_CATALOG}', componentCatalog);

  // Map our flat ChatMessage history into the SDK's MessageParam shape. The
  // current circuit (if any) is appended as a system-reminder block tacked
  // onto the LATEST user message — never interpolated into the system
  // prompt itself, which would invalidate the cache prefix every turn.
  const apiMessages: Anthropic.MessageParam[] = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === 'user' && circuitContext) {
      return {
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          {
            type: 'text',
            text: `<current_circuit>\nThe user's current circuit (JSON):\n${circuitContext}\n</current_circuit>`,
          },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  const client = new Anthropic({ apiKey });

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: systemText,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: apiMessages,
    });

    // Use the high-level "text" event for delta strings — simpler than
    // filtering content_block_delta events manually, and we don't need
    // thinking blocks for chat (we're not enabling adaptive thinking on
    // chat-only turns to keep latency down).
    stream.on('text', (delta) => {
      if (webContents.isDestroyed()) return;
      webContents.send('chat-stream-token', { requestId, delta });
    });

    const finalMessage = await stream.finalMessage();
    if (webContents.isDestroyed()) return;
    webContents.send('chat-stream-done', {
      requestId,
      stopReason: finalMessage.stop_reason,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
        cacheReadTokens: finalMessage.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: finalMessage.usage.cache_creation_input_tokens ?? 0,
      },
    });
  } catch (err: unknown) {
    if (webContents.isDestroyed()) return;
    let message = 'Unknown error';
    let kind = 'unknown';
    if (err instanceof Anthropic.AuthenticationError) {
      kind = 'auth';
      message = 'Invalid API key. Update it in Settings.';
    } else if (err instanceof Anthropic.RateLimitError) {
      kind = 'rate_limit';
      message = 'Rate limited by the Anthropic API. Try again in a moment.';
    } else if (err instanceof Anthropic.BadRequestError) {
      kind = 'bad_request';
      message = `Bad request: ${err.message}`;
    } else if (err instanceof Anthropic.APIError) {
      kind = 'api_error';
      message = `API error ${err.status}: ${err.message}`;
    } else if (err instanceof Error) {
      message = err.message;
    }
    webContents.send('chat-stream-error', { requestId, kind, message });
  }
}
