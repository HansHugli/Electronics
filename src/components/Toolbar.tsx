const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 5, 10];

function speedLabel(speed: number): string {
  return `${speed}x`;
}

interface ToolbarProps {
  simRunning: boolean;
  onToggleSimulation: () => void;
  onClearCircuit: () => void;
  onLoadDemo: (demoName?: string) => void;
  simSpeed: number;
  onSimSpeedChange: (speed: number) => void;
  simAccuracy: number;
  onSimAccuracyChange: (accuracy: number) => void;
  onExportNetlist: () => void;
  onExportBOM: () => void;
  saveStatus: string | null;
}

export default function Toolbar({
  simRunning,
  onToggleSimulation,
  onClearCircuit,
  onLoadDemo,
  simSpeed,
  onSimSpeedChange,
  simAccuracy,
  onSimAccuracyChange,
  onExportNetlist,
  onExportBOM,
  saveStatus,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar-group">
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
        {saveStatus && <span className="toolbar-status">{saveStatus}</span>}
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
        {/* Accuracy control */}
        <select
          className="toolbar-speed-select"
          value={simAccuracy}
          onChange={(e) => onSimAccuracyChange(Number(e.target.value))}
          title="Simulation accuracy (sub-steps per tick)"
        >
          {[1, 2, 5, 10].map((a) => (
            <option key={a} value={a}>{a === 1 ? 'Normal' : `${a}x Acc`}</option>
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
