import { useState, useEffect } from 'react';

interface SettingsDialogProps {
  onClose: () => void;
}

type CircuitMode = 'always' | 'on-change' | 'never';

const MODEL_OPTIONS: { id: string; label: string; hint: string }[] = [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', hint: 'Most capable, slowest, $5/$25 per M tokens' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'Balanced, $3/$15 per M tokens' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'Fastest, cheapest, $1/$5 per M tokens' },
];

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [dataPath, setDataPath] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [model, setModel] = useState('claude-opus-4-6');
  const [circuitMode, setCircuitMode] = useState<CircuitMode>('on-change');
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(false);

  useEffect(() => {
    if (window.electronApi?.getConfig) {
      window.electronApi.getConfig().then((config) => {
        setDataPath(config.dataFilePath);
        setHasApiKey(!!config.hasApiKey);
        if (config.chatModel) setModel(config.chatModel);
        if (config.circuitContextMode) setCircuitMode(config.circuitContextMode);
        setLoading(false);
      });
    } else {
      setDataPath('Browser mode — files download to your default folder');
      setLoading(false);
    }
  }, []);

  const handleSaveKey = async () => {
    if (!window.electronApi?.chatSetApiKey) return;
    const trimmed = apiKeyInput.trim();
    if (!trimmed) return;
    setSavingKey(true);
    const result = await window.electronApi.chatSetApiKey(trimmed);
    setHasApiKey(result.hasApiKey);
    setApiKeyInput('');
    setSavingKey(false);
  };

  const handleClearKey = async () => {
    if (!window.electronApi?.chatClearApiKey) return;
    await window.electronApi.chatClearApiKey();
    setHasApiKey(false);
  };

  const handleModelChange = async (m: string) => {
    setModel(m);
    if (window.electronApi?.chatSetModel) {
      await window.electronApi.chatSetModel(m);
    }
  };

  const handleCircuitModeChange = async (mode: CircuitMode) => {
    setCircuitMode(mode);
    if (window.electronApi?.chatSetCircuitMode) {
      await window.electronApi.chatSetCircuitMode(mode);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal settings-modal-wide">
        <h2 className="modal-title">Settings</h2>

        <div className="settings-section">
          <label className="settings-label">Data File Location</label>
          {loading ? (
            <span className="settings-path">Loading...</span>
          ) : (
            <span className="settings-path">{dataPath}</span>
          )}
          <p className="settings-hint">
            Circuits are saved as .ecx files. Use Save/Open to choose specific locations.
          </p>
        </div>

        <div className="settings-section">
          <label className="settings-label" htmlFor="api-key-input">Anthropic API Key</label>
          {hasApiKey ? (
            <div className="settings-row">
              <span className="settings-path settings-key-status">✓ Key configured</span>
              <button type="button" className="modal-btn small danger" onClick={handleClearKey}>
                Clear
              </button>
            </div>
          ) : (
            <div className="settings-row-input">
              <input
                id="api-key-input"
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="sk-ant-..."
                className="settings-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveKey();
                }}
              />
              <button
                type="button"
                className="modal-btn small primary"
                onClick={handleSaveKey}
                disabled={!apiKeyInput.trim() || savingKey}
              >
                {savingKey ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}
          <p className="settings-hint">
            Powers the in-app Claude chat. Stored locally in your config file. Get one at console.anthropic.com.
          </p>
        </div>

        <div className="settings-section">
          <label className="settings-label" htmlFor="chat-model-select">Chat Model</label>
          <select
            id="chat-model-select"
            title="Chat Model"
            value={model}
            onChange={(e) => handleModelChange(e.target.value)}
            className="settings-select"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="settings-hint">
            {MODEL_OPTIONS.find((o) => o.id === model)?.hint}
          </p>
        </div>

        <div className="settings-section">
          <label className="settings-label" htmlFor="circuit-mode-select">Send Circuit to Claude</label>
          <select
            id="circuit-mode-select"
            title="Send Circuit to Claude"
            value={circuitMode}
            onChange={(e) => handleCircuitModeChange(e.target.value as CircuitMode)}
            className="settings-select"
          >
            <option value="on-change">When circuit changes (recommended)</option>
            <option value="always">Always (every message)</option>
            <option value="never">Never (general questions only)</option>
          </select>
          <p className="settings-hint">
            Controls whether Claude can see your current circuit. "On change" sends it only after edits, saving tokens.
          </p>
        </div>

        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
