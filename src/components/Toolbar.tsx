import { useState, useRef, useEffect, ReactNode } from 'react';

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 5, 10];

export const DEMOS: { key: string; label: string; title: string }[] = [
  { key: 'blink', label: 'LED Blink (555 timer)', title: 'A 555 timer blinking an LED' },
  { key: 'counter', label: '7-segment counter', title: '555 clock into a CD4026 counting on a 7-segment display' },
  { key: 'avr-blink', label: 'AVR Blink (ATmega328P)', title: 'An ATmega328P running a pre-loaded Blink program' },
  { key: 'matrix', label: '5×7 LED matrix', title: 'ATmega328P and a 74HC595 driving a 5×7 LED matrix' },
  { key: 'necklace', label: 'Necklace (scrolling text)', title: 'Direct-driven 5×7 matrix scrolling text' },
];

/** "t = 12.3 s" from sim time in milliseconds. */
export function formatSimClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `t = ${s.toFixed(1)} s`;
  const min = Math.floor(s / 60);
  const rest = s - min * 60;
  return `t = ${min} min ${rest.toFixed(1).padStart(4, '0')} s`;
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
  onShowPCB: () => void;
  onExportNetlist: () => void;
  onExportBOM: () => void;
  onNew?: () => void;
  onOpen?: () => void;
  onSave?: () => void;
  onSaveAs?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  circuitName?: string;
  dirty?: boolean;
  /** Sim time in milliseconds (from the simulation loop). */
  simTime?: number;
  /** The loop can't keep up with the chosen speed. */
  lagging?: boolean;
  /** The speed actually reached, as a multiple of real time. */
  effectiveSpeed?: number;
}

/** A toolbar button that opens a small menu below it. Escape or a click elsewhere closes it. */
function MenuButton({ label, title, children }: { label: ReactNode; title: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div className="toolbar-menu" ref={ref}>
      <button
        type="button"
        className={`toolbar-btn ${open ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="toolbar-btn-label">{label}</span>
        <span className="toolbar-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="toolbar-menu-list" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button type="button" role="menuitem" className="toolbar-menu-item" title={title} onClick={onClick}>
      {children}
    </button>
  );
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
  onShowPCB,
  onExportNetlist,
  onExportBOM,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  circuitName,
  dirty,
  simTime,
  lagging,
  effectiveSpeed,
}: ToolbarProps) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Main toolbar">
      {/* Simulation: always first so it's never pushed out of reach. */}
      <div className="toolbar-group">
        <button
          type="button"
          className={`toolbar-btn sim-btn ${simRunning ? 'running' : ''}`}
          onClick={onToggleSimulation}
          title={simRunning ? 'Stop the simulation (resets readings)' : 'Run the simulation'}
        >
          <span className="toolbar-btn-icon" aria-hidden="true">{simRunning ? '■' : '▶'}</span>
          <span className="toolbar-btn-label">{simRunning ? 'Stop' : 'Run'}</span>
        </button>
        {simTime !== undefined && (simRunning || simTime > 0) && (
          <span className="toolbar-clock" title="Simulated time since Run">{formatSimClock(simTime)}</span>
        )}
        {lagging && simRunning && (
          <span className="toolbar-lag" role="status">
            running at {(effectiveSpeed ?? 0).toFixed(1)}× — this PC can't keep up
          </span>
        )}
        <select
          className="toolbar-speed-select"
          value={simSpeed}
          onChange={(e) => onSimSpeedChange(Number(e.target.value))}
          title="Simulation speed"
          aria-label="Simulation speed"
        >
          {SPEED_OPTIONS.map((s) => (
            <option key={s} value={s}>{`${s}×`}</option>
          ))}
        </select>
        <select
          className="toolbar-speed-select"
          value={simAccuracy}
          onChange={(e) => onSimAccuracyChange(Number(e.target.value))}
          title="Simulation accuracy (sub-steps per tick)"
          aria-label="Simulation accuracy"
        >
          {[1, 2, 5, 10].map((a) => (
            <option key={a} value={a}>{a === 1 ? 'Normal' : `${a}× accuracy`}</option>
          ))}
        </select>
      </div>

      <div className="toolbar-group">
        <button type="button" className="toolbar-btn" onClick={onUndo} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
          <span className="toolbar-btn-icon" aria-hidden="true">↶</span>
        </button>
        <button type="button" className="toolbar-btn" onClick={onRedo} disabled={!canRedo} title="Redo (Ctrl+Y)" aria-label="Redo">
          <span className="toolbar-btn-icon" aria-hidden="true">↷</span>
        </button>
      </div>

      <div className="toolbar-group">
        {onNew && (
          <button type="button" className="toolbar-btn" onClick={onNew} title="New empty circuit">
            <span className="toolbar-btn-label">New</span>
          </button>
        )}
        {onOpen && (
          <button type="button" className="toolbar-btn" onClick={onOpen} title="Open a circuit (Ctrl+O)">
            <span className="toolbar-btn-label">Open</span>
          </button>
        )}
        {onSave && (
          <button type="button" className="toolbar-btn" onClick={onSave} title="Save (Ctrl+S)">
            <span className="toolbar-btn-label">Save</span>
          </button>
        )}
        {onSaveAs && (
          <button type="button" className="toolbar-btn" onClick={onSaveAs} title="Save under a new name (Ctrl+Shift+S)">
            <span className="toolbar-btn-label">Save As…</span>
          </button>
        )}
      </div>

      <div className="toolbar-group">
        <MenuButton label="Examples" title="Load an example circuit">
          {(close) => DEMOS.map((d) => (
            <MenuItem key={d.key} title={d.title} onClick={() => { close(); onLoadDemo(d.key); }}>
              {d.label}
            </MenuItem>
          ))}
        </MenuButton>
        <MenuButton label="Export" title="PCB preview and exports">
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); onShowPCB(); }}>PCB layout preview…</MenuItem>
              <MenuItem onClick={() => { close(); onExportNetlist(); }}>KiCad netlist (.net)</MenuItem>
              <MenuItem onClick={() => { close(); onExportBOM(); }}>Bill of materials (.csv)</MenuItem>
            </>
          )}
        </MenuButton>
        <button type="button" className="toolbar-btn" onClick={onClearCircuit} title="Remove every part and wire (undoable)">
          <span className="toolbar-btn-label">Clear</span>
        </button>
      </div>

      {circuitName !== undefined && (
        <div className="toolbar-title" title={dirty ? `${circuitName} — unsaved changes` : circuitName}>
          <span className="toolbar-circuit-name">{circuitName}</span>
          {dirty && <span className="toolbar-dirty" aria-label="unsaved changes">●</span>}
        </div>
      )}
    </div>
  );
}
