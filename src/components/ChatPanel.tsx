import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';

interface ChatPanelProps {
  components: PlacedComponent[];
  wires: Wire[];
  selectedComponent: PlacedComponent | null;
  /** Open the settings dialog (used by the empty-state CTA when no key is set). */
  onOpenSettings: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  /** True while we're still streaming tokens into this message. */
  streaming?: boolean;
}

/**
 * Hash a circuit snapshot to a stable string. We compare hashes to decide
 * whether the circuit has materially changed since we last sent it to
 * Claude — if not, "on-change" mode skips the JSON to save tokens.
 *
 * The hash is intentionally cheap and ignores live simulation state
 * (voltages, LED brightness) since those flip every tick and would defeat
 * the purpose. We hash only structure: id, type, position, rotation,
 * properties, plus wire endpoints and colors.
 */
function hashCircuit(components: PlacedComponent[], wires: Wire[]): string {
  const compStr = components
    .map((c) =>
      [c.id, c.type, c.position.x, c.position.y, c.rotation, JSON.stringify(c.properties)].join('|'),
    )
    .sort()
    .join(';');
  const wireStr = wires
    .map((w) => {
      const from = typeof w.from === 'object' ? `${w.from.componentId}.${w.from.pinId}` : String(w.from);
      const to = typeof w.to === 'object' ? `${w.to.componentId}.${w.to.pinId}` : String(w.to);
      return [w.id, from, to, w.color].join('|');
    })
    .sort()
    .join(';');
  return `${compStr}::${wireStr}`;
}

/**
 * Render the circuit as compact JSON for Claude. We strip live simulation
 * state and keep only what's structurally meaningful.
 */
function renderCircuitJson(
  components: PlacedComponent[],
  wires: Wire[],
  selectedId: string | null,
): string {
  const compact = {
    selected: selectedId,
    components: components.map((c) => ({
      id: c.id,
      type: c.type,
      position: c.position,
      rotation: c.rotation,
      properties: c.properties,
    })),
    wires: wires.map((w) => ({
      id: w.id,
      from: w.from,
      to: w.to,
      color: w.color,
    })),
  };
  return JSON.stringify(compact, null, 2);
}

/** Render the available component catalog as a brief list. */
function renderComponentCatalog(): string {
  return Object.values(COMPONENT_DEFINITIONS)
    .map((def) => `- ${def.type}: ${def.label} — ${def.description}`)
    .join('\n');
}

const COMPONENT_CATALOG = renderComponentCatalog();

export default function ChatPanel({
  components,
  wires,
  selectedComponent,
  onOpenSettings,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [circuitMode, setCircuitMode] = useState<'always' | 'on-change' | 'never'>('on-change');
  const [sending, setSending] = useState(false);
  const lastSentHash = useRef<string | null>(null);
  const activeRequestId = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Refresh config-derived state whenever the panel mounts. We re-fetch on
  // each render of the parent? No — settings rarely change. Just on mount,
  // and we'll add a refresh button if the user wants one later.
  useEffect(() => {
    if (!window.electronApi?.getConfig) return;
    window.electronApi.getConfig().then((cfg) => {
      setHasApiKey(!!cfg.hasApiKey);
      if (cfg.circuitContextMode) setCircuitMode(cfg.circuitContextMode);
    });
  }, []);

  // Wire up the streaming event subscription. The unsubscribe runs on
  // unmount so we don't double-handle events if the panel re-mounts.
  useEffect(() => {
    if (!window.electronApi?.onChatStream) return;
    const unsubscribe = window.electronApi.onChatStream({
      onToken: ({ requestId, delta }) => {
        if (requestId !== activeRequestId.current) return;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, content: last.content + delta };
          }
          return next;
        });
      },
      onDone: ({ requestId }) => {
        if (requestId !== activeRequestId.current) return;
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, streaming: false };
          }
          return next;
        });
        setSending(false);
        activeRequestId.current = null;
      },
      onError: ({ requestId, message }) => {
        if (requestId !== activeRequestId.current) return;
        setMessages((prev) => {
          // Replace the streaming placeholder with an error message.
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = {
              id: last.id,
              role: 'error',
              content: message,
            };
          } else {
            next.push({ id: `err-${Date.now()}`, role: 'error', content: message });
          }
          return next;
        });
        setSending(false);
        activeRequestId.current = null;
      },
    });
    return unsubscribe;
  }, []);

  // Auto-scroll the message list to the bottom on every new token.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const componentCatalog = useMemo(() => COMPONENT_CATALOG, []);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    if (!hasApiKey) return;
    if (!window.electronApi?.chatSend) return;

    // Decide whether to send the circuit context this turn.
    let circuitContext = '';
    if (circuitMode === 'always') {
      circuitContext = renderCircuitJson(components, wires, selectedComponent?.id ?? null);
      lastSentHash.current = hashCircuit(components, wires);
    } else if (circuitMode === 'on-change') {
      const hash = hashCircuit(components, wires);
      if (hash !== lastSentHash.current) {
        circuitContext = renderCircuitJson(components, wires, selectedComponent?.id ?? null);
        lastSentHash.current = hash;
      }
    }

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };
    const assistantMsg: ChatMessage = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '',
      streaming: true,
    };
    const nextMessages = [...messages, userMsg, assistantMsg];
    setMessages(nextMessages);
    setInput('');
    setSending(true);

    // The full history we send to Claude excludes our streaming-placeholder
    // assistant message and any error messages (which the API doesn't
    // understand). Map ChatMessage → the SDK shape.
    const apiHistory = nextMessages
      .filter((m) => m.role !== 'error' && !m.streaming)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestId.current = requestId;

    await window.electronApi.chatSend({
      requestId,
      messages: apiHistory,
      circuitContext,
      componentCatalog,
    });
  }, [
    input,
    sending,
    hasApiKey,
    circuitMode,
    components,
    wires,
    selectedComponent,
    messages,
    componentCatalog,
  ]);

  const handleClear = useCallback(() => {
    setMessages([]);
    lastSentHash.current = null;
  }, []);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Claude</span>
        {messages.length > 0 && (
          <button type="button" className="chat-clear-btn" onClick={handleClear} title="Clear conversation">
            Clear
          </button>
        )}
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            {hasApiKey ? (
              <p>
                Ask me about your circuit. Try "what does this do?" or "why isn't my LED lighting up?"
              </p>
            ) : (
              <>
                <p>Add your Anthropic API key to start chatting about your circuits.</p>
                <button type="button" className="modal-btn small primary" onClick={onOpenSettings}>
                  Open Settings
                </button>
              </>
            )}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
            <div className="chat-msg-role">
              {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Claude' : 'Error'}
            </div>
            <div className="chat-msg-body">
              {m.content || (m.streaming ? <span className="chat-cursor">▋</span> : null)}
              {m.streaming && m.content ? <span className="chat-cursor">▋</span> : null}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={hasApiKey ? 'Ask Claude...' : 'Configure API key in Settings'}
          disabled={!hasApiKey || sending}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          type="button"
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!hasApiKey || sending || !input.trim()}
          title="Send (Enter)"
        >
          {sending ? '...' : 'Send'}
        </button>
      </div>
    </div>
  );
}
