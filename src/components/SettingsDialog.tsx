import { useState, useEffect } from 'react';

interface SettingsDialogProps {
  onClose: () => void;
}

export default function SettingsDialog({ onClose }: SettingsDialogProps) {
  const [dataPath, setDataPath] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (window.electronApi?.getConfig) {
      window.electronApi.getConfig().then((config) => {
        setDataPath(config.dataFilePath);
        setLoading(false);
      });
    } else {
      setDataPath('Browser mode — files download to your default folder');
      setLoading(false);
    }
  }, []);

  return (
    <div className="modal-overlay">
      <div className="modal">
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
        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
