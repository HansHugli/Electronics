interface ToolbarProps {
  simRunning: boolean;
  onToggleSimulation: () => void;
  onClearCircuit: () => void;
  onSave: () => void;
  onLoad: () => void;
  onLoadDemo: () => void;
  saveStatus: string | null;
  circuitName: string;
}

export default function Toolbar({
  simRunning,
  onToggleSimulation,
  onClearCircuit,
  onSave,
  onLoad,
  onLoadDemo,
  saveStatus,
  circuitName,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button type="button" className="toolbar-btn" onClick={onSave} title="Save circuit (Ctrl+S)">
          <span className="toolbar-btn-icon">💾</span>
          <span className="toolbar-btn-label">Save</span>
        </button>
        <button type="button" className="toolbar-btn" onClick={onLoad} title="Open circuit (Ctrl+O)">
          <span className="toolbar-btn-icon">📂</span>
          <span className="toolbar-btn-label">Open</span>
        </button>
        <button type="button" className="toolbar-btn" onClick={onLoadDemo} title="Load demo circuit">
          <span className="toolbar-btn-icon">⚡</span>
          <span className="toolbar-btn-label">Demo</span>
        </button>
      </div>
      <div className="toolbar-group">
        <span className="toolbar-circuit-name">{circuitName}</span>
        {saveStatus && <span className="toolbar-status">{saveStatus}</span>}
        <div className="toolbar-separator" />
        <button
          type="button"
          className={`toolbar-btn sim-btn ${simRunning ? 'running' : ''}`}
          onClick={onToggleSimulation}
        >
          <span className="toolbar-btn-icon">{simRunning ? '■' : '���'}</span>
          <span className="toolbar-btn-label">{simRunning ? 'Stop' : 'Run'}</span>
        </button>
        <button type="button" className="toolbar-btn" onClick={onClearCircuit} title="Clear all">
          <span className="toolbar-btn-icon">⌫</span>
          <span className="toolbar-btn-label">Clear</span>
        </button>
      </div>
    </div>
  );
}
