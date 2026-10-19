import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';
import { BOARD_X_OFFSET, GRID_H, GRID_W } from '../data/breadboard';
import { renderCircuitContext, renderComponentCatalog } from '../ai/circuitContext';
import { RequestBudget } from '../ai/toolValidation';

interface ToolCallResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

interface ChatPanelProps {
  components: PlacedComponent[];
  wires: Wire[];
  selectedComponent: PlacedComponent | null;
  /** Open the settings dialog (used by the empty-state CTA when no key is set). */
  onOpenSettings: () => void;
  /** Open the usage/cost panel. */
  onOpenUsage: () => void;
  /** Execute circuit tool calls from the AI (validated in App). Returns results for each tool call. */
  onExecuteToolCalls: (
    toolCalls: { id: string; name: string; input: Record<string, unknown> }[],
    budget?: RequestBudget,
  ) => { id: string; result: ToolCallResult }[];
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'notice';
  content: string;
  /** True while we're still streaming tokens into this message. */
  streaming?: boolean;
}

/**
 * Hash a circuit snapshot to a stable string. "on-change" mode only sends
 * the circuit when this changes. Live simulation state is ignored.
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

type CircuitMode = 'always' | 'on-change' | 'never';

const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
];

const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Short display name for a model ID. */
function modelShortName(modelId: string): string {
  if (modelId.includes('opus')) return 'Opus';
  if (modelId.includes('sonnet')) return 'Sonnet';
  if (modelId.includes('haiku')) return 'Haiku';
  return modelId;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined) return 'price unknown';
  if (cost < 0.0001) return '<$0.0001';
  return `~$${cost.toFixed(4)}`;
}

/** Links in Claude's answers open in the system browser (main allows https only). */
const markdownComponents = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

const noticeStyle: CSSProperties = {
  fontSize: '0.75rem',
  color: '#fbbf24',
  background: 'rgba(251, 191, 36, 0.08)',
  border: '1px solid rgba(251, 191, 36, 0.25)',
  borderRadius: 4,
  padding: '4px 8px',
  margin: '4px 0',
};

const reasonStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: '#94a3b8',
  padding: '2px 8px 6px',
};

export default function ChatPanel({
  components,
  wires,
  selectedComponent,
  onOpenSettings,
  onOpenUsage,
  onExecuteToolCalls,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [circuitMode, setCircuitMode] = useState<CircuitMode>('on-change');
  const [sending, setSending] = useState(false);
  /** Status text shown while Claude is processing (thinking, building, etc.) */
  const [processingStatus, setProcessingStatus] = useState<string | null>(null);
  /** The model answering this conversation, and why (one line). */
  const [resolvedModel, setResolvedModel] = useState<string | null>(null);
  const [modelReason, setModelReason] = useState<string | null>(null);
  const [lastCost, setLastCost] = useState<string | null>(null);
  const lastSentHash = useRef<string | null>(null);
  const activeRequestId = useRef<string | null>(null);
  const conversationId = useRef<string>(newId('conv'));
  const budgetRef = useRef<RequestBudget>(new RequestBudget(''));
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.electronApi?.getConfig) return;
    window.electronApi.getConfig().then((cfg) => {
      setHasApiKey(!!cfg.hasApiKey);
      if (cfg.chatModel) setModel(cfg.chatModel);
      if (cfg.circuitContextMode) setCircuitMode(cfg.circuitContextMode);
    }).catch(() => {});
  }, []);

  const handleModelChange = async (m: string) => {
    setModel(m);
    setModelReason(null);
    if (window.electronApi?.chatSetModel) {
      await window.electronApi.chatSetModel(m).catch(() => {});
    }
  };

  const handleCircuitModeChange = async (mode: CircuitMode) => {
    setCircuitMode(mode);
    if (window.electronApi?.chatSetCircuitMode) {
      await window.electronApi.chatSetCircuitMode(mode).catch(() => {});
    }
  };

  // Keep a ref to the tool-call executor so the stream subscription
  // (which runs in a long-lived useEffect) always calls the latest version.
  const executeToolCallsRef = useRef(onExecuteToolCalls);
  executeToolCallsRef.current = onExecuteToolCalls;

  const finishStreaming = useCallback(() => {
    setProcessingStatus(null);
    setMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === 'assistant' && last.streaming) {
        if (last.content.trim()) next[next.length - 1] = { ...last, streaming: false };
        else next.pop();
      }
      return next;
    });
    setSending(false);
    activeRequestId.current = null;
  }, []);

  /** Insert a notice above the streaming answer (or at the end). */
  const addNotice = useCallback((content: string) => {
    setMessages((prev) => {
      const next = [...prev];
      const notice: ChatMessage = { id: newId('n'), role: 'notice', content };
      const last = next[next.length - 1];
      if (last && last.role === 'assistant' && last.streaming) next.splice(next.length - 1, 0, notice);
      else next.push(notice);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!window.electronApi?.onChatStream) return;
    const unsubscribe = window.electronApi.onChatStream({
      onToken: ({ requestId, delta }) => {
        if (requestId !== activeRequestId.current || !delta) return;
        setProcessingStatus(null);
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, content: last.content + delta };
          }
          return next;
        });
      },
      onModel: ({ requestId, model: resolvedId, reason }) => {
        if (requestId !== activeRequestId.current) return;
        setResolvedModel(resolvedId);
        setModelReason(reason ?? null);
      },
      onToolCalls: ({ requestId, toolCalls }) => {
        if (requestId !== activeRequestId.current) return;
        const toolNames = toolCalls.map((tc) => tc.name);
        if (toolNames.includes('clear_circuit')) setProcessingStatus('Clearing circuit...');
        else if (toolNames.includes('create_component_type')) setProcessingStatus('Creating new component...');
        else if (toolNames.some((n) => n === 'add_component' || n === 'add_wire')) setProcessingStatus('Building circuit...');
        else if (toolNames.some((n) => n === 'remove_component' || n === 'remove_wire')) setProcessingStatus('Modifying circuit...');
        else setProcessingStatus('Working...');

        let results: { id: string; result: ToolCallResult }[];
        try {
          results = executeToolCallsRef.current(toolCalls, budgetRef.current);
        } catch (err) {
          results = toolCalls.map((tc) => ({
            id: tc.id,
            result: { success: false, message: `The app failed to run the tool: ${err instanceof Error ? err.message : String(err)}` },
          }));
        }
        // Make big changes visible: clearing the board is announced.
        toolCalls.forEach((tc) => {
          const r = results.find((x) => x.id === tc.id)?.result;
          if (tc.name === 'clear_circuit' && r?.success && !/already empty/.test(r.message)) {
            addNotice('Claude cleared the board. Undo (Ctrl+Z) brings it back.');
          }
        });
        window.electronApi?.chatSendToolResults?.(requestId, results);
      },
      onNotice: ({ requestId, message }) => {
        if (requestId !== activeRequestId.current) return;
        addNotice(message);
      },
      onDone: ({ requestId, cost, rounds }) => {
        if (requestId !== activeRequestId.current) return;
        setLastCost(`Last answer: ${formatCost(cost)}${rounds && rounds > 1 ? ` over ${rounds} steps` : ''} (estimate)`);
        finishStreaming();
      },
      onError: ({ requestId, message }) => {
        if (requestId !== activeRequestId.current) return;
        setProcessingStatus(null);
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            if (last.content.trim()) {
              next[next.length - 1] = { ...last, streaming: false };
              next.push({ id: newId('err'), role: 'error', content: message });
            } else {
              next[next.length - 1] = { id: last.id, role: 'error', content: message };
            }
          } else {
            next.push({ id: newId('err'), role: 'error', content: message });
          }
          return next;
        });
        setSending(false);
        activeRequestId.current = null;
      },
    });
    return unsubscribe;
  }, [addNotice, finishStreaming]);

  // Auto-scroll the message list to the bottom on every new token.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    if (!hasApiKey) return;
    if (!window.electronApi?.chatSend) return;

    const grid = { GRID_W, GRID_H, BOARD_X_OFFSET };
    let circuitContext = '';
    const hash = hashCircuit(components, wires);
    if (circuitMode === 'always' || (circuitMode === 'on-change' && hash !== lastSentHash.current)) {
      circuitContext = renderCircuitContext(components, wires, selectedComponent?.id ?? null, COMPONENT_DEFINITIONS, grid);
      lastSentHash.current = hash;
    }
    // Built now, so custom chips loaded or created since start are included.
    const componentCatalog = renderComponentCatalog(COMPONENT_DEFINITIONS);

    const userMsg: ChatMessage = { id: newId('u'), role: 'user', content: trimmed };
    const assistantMsg: ChatMessage = { id: newId('a'), role: 'assistant', content: '', streaming: true };
    const nextMessages = [...messages, userMsg, assistantMsg];
    setMessages(nextMessages);
    setInput('');
    setSending(true);
    setProcessingStatus('Thinking...');
    setLastCost(null);

    // Plain-text history for compatibility; main uses its own full history
    // for this conversationId.
    const apiHistory = nextMessages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.streaming)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const requestId = newId('req');
    activeRequestId.current = requestId;
    budgetRef.current = new RequestBudget(trimmed);

    try {
      await window.electronApi.chatSend({
        requestId,
        conversationId: conversationId.current,
        messages: apiHistory,
        circuitContext,
        componentCatalog,
      });
    } catch (err) {
      if (activeRequestId.current !== requestId) return;
      setMessages((prev) => {
        const next = prev.filter((m) => m.id !== assistantMsg.id);
        next.push({ id: newId('err'), role: 'error', content: err instanceof Error ? err.message : String(err) });
        return next;
      });
      setProcessingStatus(null);
      setSending(false);
      activeRequestId.current = null;
      lastSentHash.current = null;
    }
  }, [input, sending, hasApiKey, circuitMode, components, wires, selectedComponent, messages]);

  const handleStop = useCallback(async () => {
    const requestId = activeRequestId.current;
    if (!requestId) return;
    setProcessingStatus('Stopping...');
    let running = false;
    try {
      running = (await window.electronApi?.chatCancel?.(requestId)) ?? false;
    } catch {
      running = false;
    }
    // Nothing running in main any more: unstick the panel ourselves.
    if (!running && activeRequestId.current === requestId) finishStreaming();
  }, [finishStreaming]);

  const handleClear = useCallback(() => {
    if (sending) return;
    const old = conversationId.current;
    window.electronApi?.chatResetConversation?.(old).catch(() => {});
    conversationId.current = newId('conv');
    setMessages([]);
    setResolvedModel(null);
    setModelReason(null);
    setLastCost(null);
    lastSentHash.current = null;
  }, [sending]);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Claude</span>
        {messages.length > 0 && (
          <button type="button" className="chat-clear-btn" onClick={handleClear} disabled={sending} title="Start a new conversation">
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
        {messages.map((m) =>
          m.role === 'notice' ? (
            <div key={m.id} style={noticeStyle} role="status">
              {m.content}
            </div>
          ) : (
            <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
              <div className="chat-msg-role">
                {m.role === 'user' ? 'You' : m.role === 'assistant' ? 'Claude' : 'Error'}
              </div>
              <div className="chat-msg-body">
                {m.content ? (
                  <>
                    <ReactMarkdown components={markdownComponents}>{m.content}</ReactMarkdown>
                    {m.streaming && !processingStatus && <span className="chat-cursor">▋</span>}
                  </>
                ) : null}
                {m.streaming && processingStatus && (
                  <div className="chat-processing">
                    <span className="chat-processing-dot" />
                    {processingStatus}
                  </div>
                )}
                {m.streaming && !m.content && !processingStatus && (
                  <span className="chat-cursor">▋</span>
                )}
              </div>
            </div>
          ),
        )}
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
        {sending ? (
          <button type="button" className="chat-send-btn" onClick={handleStop} title="Stop Claude">
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="chat-send-btn"
            onClick={handleSend}
            disabled={!hasApiKey || !input.trim()}
            title="Send (Enter)"
          >
            Send
          </button>
        )}
      </div>

      <div className="chat-options-row">
        <select
          title="Model"
          value={model}
          onChange={(e) => handleModelChange(e.target.value)}
          className="chat-option-select"
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
        {model === 'auto' && resolvedModel && (
          <span className="chat-auto-badge" title="Model selected by Auto">
            {modelShortName(resolvedModel)}
          </span>
        )}
        <select
          title="Circuit context"
          value={circuitMode}
          onChange={(e) => handleCircuitModeChange(e.target.value as CircuitMode)}
          className="chat-option-select"
        >
          <option value="on-change">Circuit: on change</option>
          <option value="always">Circuit: always</option>
          <option value="never">Circuit: never</option>
        </select>
        <button
          type="button"
          className="chat-usage-btn"
          onClick={onOpenUsage}
          title="API usage &amp; costs"
        >
          $
        </button>
      </div>
      {(modelReason || lastCost) && (
        <div style={reasonStyle}>
          {modelReason}
          {modelReason && lastCost ? ' · ' : ''}
          {lastCost}
        </div>
      )}
    </div>
  );
}
