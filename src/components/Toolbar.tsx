const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 5, 10];

function speedLabel(speed: number): string {
  return `${speed}x`;
}

interface ToolbarProps {
  simRunning: boolean;
  onToggleSimulation: () => void;
  onClearCircuit: () => void;
  onSave: () => void;
  onLoad: () => void;
  onLoadDemo: (demoName?: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  simSpeed: number;
  onSimSpeedChange: (speed: number) => void;
  onExportNetlist: () => void;
  onExportBOM: () => void;
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
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  simSpeed,
  onSimSpeedChange,
  onExportNetlist,
  onExportBOM,
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
        <div className="toolbar-separator" />
        <button type="button" className="toolbar-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          <span className="toolbar-btn-icon">↩</span>
          <span className="toolbar-btn-label">Undo</span>
        </button>
        <button type="button" className="toolbar-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
          <span className="toolbar-btn-icon">↪</span>
          <span className="toolbar-btn-label">Redo</span>
        </button>
        <div className="toolbar-separator" />
        <button type="button" className="toolbar-btn" onClick={() => onLoadDemo()} title="LED Blink Demo">
          <span className="toolbar-btn-icon">💡</span>
          <span className="toolbar-btn-label">Blink</span>
        </button>
        <button type="button" className="toolbar-btn" onClick={() => onLoadDemo('counter')} title="7-Seg Counter Demo">
          <span className="toolbar-btn-icon">🔢</span>
          <span className="toolbar-btn-label">Counter</span>
        </button>
        <div className="toolbar-separator" />
        <button type="button" className="toolbar-btn" onClick={onExportNetlist} title="Export KiCad netlist (.net)">
          <span className="toolbar-btn-icon">PCB</span>
        </button>
        <button type="button" className="toolbar-btn" onClick={onExportBOM} title="Export Bill of Materials (.csv)">
          <span className="toolbar-btn-icon">BOM</span>
        </button>
      </div>
      <div className="toolbar-group">
        <span className="toolbar-circuit-name">{circuitName}</span>
        {saveStatus && <span className="toolbar-status">{saveStatus}</span>}
        <div className="toolbar-separator" />
        {/* Speed control */}
        <select
          className="toolbar-speed-select"
          value={simSpeed}
          onChange={(e) => onSimSpeedChange(Number(e.target.value))}
          title="Simulation speed"
        >
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s}>{speedLabel(s)}</option>
          ))}
        </select>
        <button
          type="button"
          className={`toolbar-btn sim-btn ${simRunning ? 'running' : ''}`}
          onClick={onToggleSimulation}
        >
          <span className="toolbar-btn-icon">{simRunning ? '■' : '▶'}</span>
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
