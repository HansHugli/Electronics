import { useState, useEffect } from 'react';

interface SettingsDialogProps {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [dataPath, setDataPath] = useState('');
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(false);

  useEffect(() => {
    if (window.electronApi?.getConfig) {
      window.electronApi.getConfig().then((config) => {
        setDataPath(config.dataFilePath);
        setHasApiKey(!!config.hasApiKey);
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

        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
