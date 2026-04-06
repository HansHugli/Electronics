import { useState, useRef, useEffect } from 'react';

interface PowerConfig {
  mode: 'DC' | 'AC';
  voltage: number;
  waveform: 'square' | 'sine';
}

interface PowerConfigModalProps {
  onConfirm: (config: PowerConfig) => void;
  onCancel: () => void;
}

export default function PowerConfigModal({ onConfirm, onCancel }: PowerConfigModalProps) {
  const [mode, setMode] = useState<'DC' | 'AC'>('DC');
  const [voltage, setVoltage] = useState(5);
  const [waveform, setWaveform] = useState<'square' | 'sine'>('square');
  const voltageRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    voltageRef.current?.focus();
    voltageRef.current?.select();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm({ mode, voltage, waveform });
  };

  return (
    <div className="modal-overlay">
      <form className="modal" onSubmit={handleSubmit}>
        <h2 className="modal-title">Configure Power Supply</h2>

        <div className="modal-field">
          <label>Mode</label>
          <div className="toggle-group">
            <button
              type="button"
              className={`toggle-btn ${mode === 'DC' ? 'active' : ''}`}
              onClick={() => setMode('DC')}
            >
              DC
            </button>
            <button
              type="button"
              className={`toggle-btn ${mode === 'AC' ? 'active' : ''}`}
              onClick={() => setMode('AC')}
            >
              AC
            </button>
          </div>
        </div>

        <div className="modal-field">
          <label htmlFor="power-voltage">Voltage</label>
          <div className="modal-input-row">
            <input
              ref={voltageRef}
              id="power-voltage"
              type="number"
              value={voltage}
              onChange={(e) => setVoltage(parseFloat(e.target.value) || 0)}
              min={0}
              max={240}
              step={0.1}
            />
            <span className="modal-unit">V</span>
          </div>
        </div>

        <div className="modal-field">
          <label>Waveform</label>
          <div className="toggle-group">
            <button
              type="button"
              className={`toggle-btn ${waveform === 'square' ? 'active' : ''}`}
              onClick={() => setWaveform('square')}
            >
              <svg width="28" height="14" viewBox="0 0 28 14">
                <path d="M 0 12 h 7 v -10 h 7 v 10 h 7 v -10 h 7" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
              Square
            </button>
            <button
              type="button"
              className={`toggle-btn ${waveform === 'sine' ? 'active' : ''}`}
              onClick={() => setWaveform('sine')}
            >
              <svg width="28" height="14" viewBox="0 0 28 14">
                <path d="M 0 7 Q 3.5 -3 7 7 Q 10.5 17 14 7 Q 17.5 -3 21 7 Q 24.5 17 28 7" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </svg>
              Sine
            </button>
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="modal-btn secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="modal-btn primary">Add</button>
        </div>
      </form>
    </div>
  );
}
