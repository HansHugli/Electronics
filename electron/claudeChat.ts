import Anthropic from '@anthropic-ai/sdk';
import type { WebContents } from 'electron';
import { ipcMain } from 'electron';

/**
 * Claude chat IPC module.
 *
 * The renderer never holds the Anthropic API key. Chat messages flow:
 *   renderer → IPC → streamChat() → Anthropic API
 *                                       ↓ token deltas + tool_use
 *   renderer ← IPC events ← streamChat()
 *
 * Tool-use loop:
 *   Claude returns tool_use blocks → main sends them to the renderer via
 *   'chat-stream-tool-call' → renderer executes them on circuit state and
 *   replies via 'chat-tool-result' → main feeds tool results back to
 *   Claude → Claude continues (may stream more text or more tool calls).
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
  circuitContext: string;
  componentCatalog: string;
  requestId: string;
}

/** A single circuit-manipulation action for the renderer to execute. */
export interface CircuitAction {
  tool: string;
  input: Record<string, unknown>;
}

/** Result from the renderer after executing a circuit action. */
export interface CircuitActionResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

// ---- Tool Definitions ---- //

const CIRCUIT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'add_component',
    description: `Add a component to the breadboard at a specific grid position.

Grid coordinates:
- col: 0-30 (breadboard column). Board 1 spans cols 0-14, board 2 spans cols 16-30. Col 15 is the gap between boards.
  Within each board: cols 0-1 are power rails, cols 2-6 are left component area, col 7 is the center gap, cols 8-12 are right component area, cols 13-14 are power rails.
  For board 2, add 16 to these values.
- row: 0-49 (breadboard row, top to bottom)

The "col" value is where the component's LEFT pins land. For width-1 components (resistors, LEDs, etc.), place them anywhere in the component area (cols 2-6 or 8-12).

DIP chips (width=2) are automatically positioned to straddle the center gap. Just specify col=6 for board 1 or col=22 for board 2 — the system will place left pins on that column and right pins two columns over (skipping the gap). You MUST use col=6 for DIP chips on board 1 (not col=5 or col=7).

Power supplies are special — use col=-4 and a row in the 0-10 range.

Returns the component ID assigned to the new component.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'Component type ID from the catalog (e.g. "resistor", "led", "timer", "atmega328")',
        },
        col: {
          type: 'number',
          description: 'Grid column (0-30)',
        },
        row: {
          type: 'number',
          description: 'Grid row (0-49)',
        },
        properties: {
          type: 'object',
          description: 'Optional component properties (e.g. {"resistance": 1000} for a resistor, {"voltage": 5, "mode": "dc", "waveform": "square"} for power)',
          additionalProperties: true,
        },
      },
      required: ['type', 'col', 'row'],
    },
  },
  {
    name: 'add_wire',
    description: `Connect two pins with a wire. Each endpoint is specified as either:
- A component pin: { componentId: "comp_1", pinId: "anode" }
- A bare breadboard hole: { componentId: "board", pinId: "col,row" } where col and row are grid coordinates

Pin IDs vary by component type. Common examples:
- Resistor: "lead1", "lead2"
- LED: "anode", "cathode"
- Capacitor: "pos", "neg"
- Switch: "a", "b"
- 555 Timer: "gnd", "trigger", "output", "reset", "control", "threshold", "discharge", "vcc"
- Power supply: "pos", "neg"
- ATmega328P: pin names like "pd0" through "pd7", "pb0" through "pb5", "pc0" through "pc5", "vcc", "gnd", etc.

Use bare board holes to connect to power rails or to route through the breadboard's internal wiring.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        from: {
          type: 'object',
          properties: {
            componentId: { type: 'string' },
            pinId: { type: 'string' },
          },
          required: ['componentId', 'pinId'],
        },
        to: {
          type: 'object',
          properties: {
            componentId: { type: 'string' },
            pinId: { type: 'string' },
          },
          required: ['componentId', 'pinId'],
        },
        color: {
          type: 'string',
          description: 'Optional wire color (e.g. "#e74c3c" for red, "#2ecc71" for green). Defaults to auto-cycling colors.',
        },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'remove_component',
    description: 'Remove a component from the breadboard by its ID. Also removes all wires connected to it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        componentId: {
          type: 'string',
          description: 'The component ID to remove (e.g. "comp_1")',
        },
      },
      required: ['componentId'],
    },
  },
  {
    name: 'remove_wire',
    description: 'Remove a wire by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        wireId: {
          type: 'string',
          description: 'The wire ID to remove (e.g. "wire_1")',
        },
      },
      required: ['wireId'],
    },
  },
  {
    name: 'clear_circuit',
    description: 'Remove all components and wires from the breadboard. Use this before building a new circuit from scratch.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_components',
    description: 'List all components currently on the breadboard with their IDs, types, positions, and properties. Useful to check the current state before making changes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_component_type',
    description: `Create a new component type that doesn't exist in the catalog. Use this when the user asks for a component not in the catalog (e.g. a Geiger-Müller tube, a relay, a sensor, etc.). The new type is registered immediately and can then be placed with add_component.

IMPORTANT: If the type ID already exists, this tool returns success with the existing type info — it does NOT create a duplicate. Always reuse existing type IDs when the same component is needed again. Use list_components first to check what custom types already exist on the board.

The component is rendered as a DIP-style chip on the breadboard with labeled pins. It uses "passthrough" behavior (visual only — no simulation model), but the circuit can still be wired and demonstrated structurally.

After creating a new type, immediately use add_component to place it on the board.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'Unique type ID for the new component (e.g. "geiger_tube", "relay_spdt"). Use lowercase with underscores.',
        },
        label: {
          type: 'string',
          description: 'Short display label for the chip body (e.g. "GM Tube", "Relay")',
        },
        description: {
          type: 'string',
          description: 'One-line description for the sidebar (e.g. "Geiger-Müller radiation detector tube")',
        },
        category: {
          type: 'string',
          enum: ['passive', 'active', 'input', 'output', 'measurement', 'power'],
          description: 'Component category for the sidebar',
        },
        pins: {
          type: 'array',
          description: 'Pin definitions. For a DIP package, put half the pins on "left" and half on "right".',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Pin ID used in wiring (e.g. "anode", "clk", "vcc")' },
              label: { type: 'string', description: 'Display label on the pin (e.g. "ANO", "CLK", "VCC")' },
              side: { type: 'string', enum: ['left', 'right'], description: 'Which side of the chip' },
              type: { type: 'string', enum: ['power', 'ground', 'input', 'output', 'bidirectional'], description: 'Pin type' },
            },
            required: ['id', 'label', 'side', 'type'],
          },
        },
        color: {
          type: 'string',
          description: 'Chip body color as a hex string (e.g. "#4a4a4a"). Defaults to dark gray.',
        },
        properties: {
          type: 'object',
          description: 'Optional editable properties (e.g. {"voltage": {"label": "HV Output", "default": 400, "unit": "V"}})',
          additionalProperties: true,
        },
      },
      required: ['type', 'label', 'pins'],
    },
  },
  {
    name: 'delete_component_type',
    description: 'Delete a custom (AI-created) component type. Built-in component types cannot be deleted. Also removes all placed instances of this component and their wires from the board.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'The type ID of the custom component to delete (e.g. "geiger_tube")',
        },
      },
      required: ['type'],
    },
  },
];

// ---- System Prompt ---- //

const SYSTEM_PROMPT = `You are an electronics tutor and assistant embedded in the e101 visual circuit simulator. The user is building circuits by placing components on a virtual breadboard and wiring them together, then running a simulation to see what happens.

Your job is to help them:
- Understand how their current circuit works (or doesn't)
- Debug problems ("why isn't my LED lighting up?")
- Build circuits for them when they ask ("build me a 555 blink circuit")
- Modify or extend their existing circuits
- Explain electronics concepts at the level the user seems to be at

CRITICAL RULES — YOU MUST FOLLOW THESE:

1. ALWAYS USE YOUR TOOLS. When the user asks you to build, create, add, wire, set up, or modify a circuit — you MUST call add_component, add_wire, etc. to build it directly. NEVER describe wiring steps for the user to follow. NEVER say "drag", "place", or "wire X to Y" as instructions. YOU do it by calling your tools. No exceptions.

2. NEVER REFUSE TO BUILD. If the user asks for a component that isn't in the catalog, use create_component_type to invent it. You can create ANY component — sensors, tubes, relays, motors, displays, connectors, anything. Create it with appropriate pins, then place it with add_component and wire it up. The component won't simulate electrically (it uses passthrough behavior), but it will appear on the board with labeled pins and correct wiring. This is valuable for learning, prototyping, and PCB export.

3. BUILD FIRST, EXPLAIN AFTER. When asked to build a circuit, immediately start calling tools. After the circuit is built, write a brief summary of what you placed and how it works. Do not ask permission or present options before building — just build it. If the user doesn't like it, they'll tell you.

Guidelines:
- Be concise. Most answers should fit in 1–4 short paragraphs. The chat panel is narrow.
- When the user shares their circuit, refer to specific component IDs and pin names from the JSON.
- Use components from the catalog below when available. When a component doesn't exist, create it with create_component_type.
- After placing components and wiring them, give a brief summary of what you built and suggest the user click Run to test it.
- If you don't have enough information, ask one focused question rather than guessing.
- For Arduino/AVR sketches, the user can edit and recompile via the Sketch Editor — you can suggest sketch changes as code blocks.

Placement rules:
- ALL DIP chips (width=2) MUST be placed at col=6 on board 1 (or col=22 on board 2). This is automatically enforced — the system will correct other values. The chip's left pins land on col 6, right pins on col 8, straddling the center gap at col 7.
- Width-1 components (resistors, LEDs, capacitors, switches) go in the component area: cols 2-6 (left side) or cols 8-12 (right side).
- Space components vertically — each chip occupies several rows (e.g. a 555 timer is 4 rows tall). Leave at least 1-2 rows between components.
- Power supplies use col=-4, row in the 0-10 range.

Wiring rules:
- Wire component pins directly to other component pins when they should connect.
- To connect through the breadboard's internal wiring, wire a component pin to a bare board hole: { componentId: "board", pinId: "col,row" }. Pins in the same 5-pin strip (cols 2-6 same row, or cols 8-12 same row) are internally connected.
- Power rails are cols 0-1 (positive) and cols 13-14 (negative) on each board. Rail pins in the same 5-row block are connected.
- To connect a chip's left pin to a component on the right side (or vice versa), wire through board holes — the breadboard's internal strip wiring handles it.

Available component catalog (id → label):
{COMPONENT_CATALOG}`;

// ---- Auto Model Selection ---- //

function autoSelectModel(
  userMessage: string,
  conversationLength: number,
  hasCircuitContext: boolean,
): string {
  const msg = userMessage.toLowerCase();
  const wordCount = userMessage.split(/\s+/).length;

  const complexPatterns = [
    /\bdesign\b/, /\bbuild\b/, /\bcreate\b/, /\bmake\s+(me\s+)?a\b/,
    /\bset\s+up\b/, /\bwire\s+up\b/, /\bput\s+together\b/,
    /\badd\s+(a|an|the|some)\b/, /\bplace\s+(a|an|the)\b/,
    /\bdebug\b/, /\btroubleshoot\b/, /\bdiagnos/,
    /\boptimi[sz]e\b/, /\brefactor\b/, /\brewrite\b/,
    /\bcompare\b.*\bvs\b/, /\btrade.?off/,
    /\bexplain\s+(in\s+detail|how|why)\b.*\b(circuit|simulation|engine)\b/,
    /\bpcb\b.*\blayout\b/, /\bschematic\b/,
    /\bwrite\s+(me\s+)?(a\s+)?(sketch|code|program)\b/,
    /\bstep.by.step\b/,
    /\bcircuit\b/, /\bcounter\b/, /\btimer\b/, /\boscillator\b/, /\bamplifier\b/,
  ];
  const isComplex = complexPatterns.some((p) => p.test(msg));
  const isLongConversation = conversationLength >= 10;
  const isLongMessage = wordCount > 60;

  if (isComplex || (isLongConversation && hasCircuitContext) || isLongMessage) {
    return 'claude-opus-4-6';
  }

  const simplePatterns = [
    /^(hi|hello|hey|thanks|thank you|ok|okay|got it|cool|nice)\b/,
    /^what\s+(is|are)\s+(a|an|the)\s+\w+\??$/,
    /^(how\s+many|which|where)\b.{0,40}\??$/,
    /^(yes|no|yep|nope|sure)\b/,
  ];
  const isSimple = simplePatterns.some((p) => p.test(msg));
  const isShort = wordCount <= 8;

  if (isSimple && isShort && !hasCircuitContext) {
    return 'claude-haiku-4-5';
  }

  return 'claude-sonnet-4-6';
}

// ---- Tool Result IPC ---- //

/**
 * Wait for the renderer to execute a batch of tool calls and return results.
 * We send the tool calls over IPC and set up a one-shot listener for the reply.
 */
function executeToolCalls(
  webContents: WebContents,
  requestId: string,
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[],
): Promise<{ id: string; result: CircuitActionResult }[]> {
  return new Promise((resolve) => {
    const channel = `chat-tool-result-${requestId}`;
    ipcMain.once(channel, (_event, results: { id: string; result: CircuitActionResult }[]) => {
      resolve(results);
    });
    webContents.send('chat-stream-tool-calls', { requestId, toolCalls });
  });
}

// ---- Main Stream Function ---- //

export async function streamChat(
  webContents: WebContents,
  req: StreamChatRequest,
): Promise<void> {
  const { apiKey, messages, circuitContext, componentCatalog, requestId } = req;

  const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
  const model =
    req.model === 'auto'
      ? autoSelectModel(lastUserMsg?.content ?? '', messages.length, !!circuitContext)
      : req.model;

  const systemText = SYSTEM_PROMPT.replace('{COMPONENT_CATALOG}', componentCatalog);

  // Build the initial message list. Circuit context is appended to the last
  // user message (not the system prompt) to preserve cache stability.
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

  if (webContents.isDestroyed()) return;
  webContents.send('chat-stream-model', { requestId, model });

  try {
    // Tool-use loop: Claude may return tool_use blocks that we need to
    // execute and feed back before it continues with a text response.
    let loopMessages = [...apiMessages];
    let iterations = 0;
    const MAX_ITERATIONS = 20; // safety cap

    while (iterations < MAX_ITERATIONS) {
      iterations++;

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
        tools: CIRCUIT_TOOLS,
        messages: loopMessages,
      });

      // Collect text deltas for the UI and the full content blocks for
      // the tool-use check after the stream ends.
      stream.on('text', (delta) => {
        if (webContents.isDestroyed()) return;
        webContents.send('chat-stream-token', { requestId, delta });
      });

      const finalMessage = await stream.finalMessage();
      if (webContents.isDestroyed()) return;

      // Check if the response contains tool_use blocks
      const toolUseBlocks = finalMessage.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUseBlocks.length === 0 || finalMessage.stop_reason !== 'tool_use') {
        // No tool calls — we're done. Send the final done event.
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
        return;
      }

      // Execute tool calls in the renderer
      const toolCalls = toolUseBlocks.map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      }));

      // Notify the UI that tool calls are being executed
      webContents.send('chat-stream-token', {
        requestId,
        delta: '',
        toolCalls: toolCalls.map((tc) => ({ name: tc.name, input: tc.input })),
      });

      const results = await executeToolCalls(webContents, requestId, toolCalls);

      // Append the assistant's full response (including tool_use blocks)
      // and the tool results to the conversation, then loop.
      loopMessages = [
        ...loopMessages,
        { role: 'assistant' as const, content: finalMessage.content },
        {
          role: 'user' as const,
          content: results.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.id,
            content: JSON.stringify(r.result),
          })),
        },
      ];
    }

    // If we hit the iteration cap, send done anyway
    if (!webContents.isDestroyed()) {
      webContents.send('chat-stream-done', {
        requestId,
        stopReason: 'max_iterations',
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });
    }
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
