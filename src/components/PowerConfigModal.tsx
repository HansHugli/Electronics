import { useState, useRef, useEffect } from 'react';
import Modal from './Modal';
import { parseValueInput } from './valueInput';

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
  const [voltageText, setVoltageText] = useState('5');
  const [error, setError] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<'square' | 'sine'>('square');
  const voltageRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    voltageRef.current?.focus();
    voltageRef.current?.select();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = parseValueInput(voltageText, 'V');
    if (!parsed.ok) { setError(parsed.error); voltageRef.current?.focus(); return; }
    if (parsed.value < 0 || parsed.value > 240) { setError('Use a voltage from 0 to 240 V.'); return; }
    onConfirm({ mode, voltage: parsed.value, waveform });
  };

  return (
    <Modal title="Configure Power Supply" onClose={onCancel}>
      <form onSubmit={handleSubmit} noValidate>
        <div className="modal-field">
          <label id="power-mode-label">Mode</label>
          <div className="toggle-group" role="group" aria-labelledby="power-mode-label">
            <button
              type="button"
              className={`toggle-btn ${mode === 'DC' ? 'active' : ''}`}
              aria-pressed={mode === 'DC'}
              onClick={() => setMode('DC')}
            >
              DC
            </button>
            <button
              type="button"
              className={`toggle-btn ${mode === 'AC' ? 'active' : ''}`}
              aria-pressed={mode === 'AC'}
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
              type="text"
              inputMode="decimal"
              value={voltageText}
              aria-invalid={!!error}
              className={error ? 'invalid' : ''}
              onChange={(e) => { setVoltageText(e.target.value); setError(null); }}
            />
            <span className="modal-unit">V</span>
          </div>
          {error && <div className="property-error" role="alert">{error}</div>}
        </div>

        {mode === 'AC' && (
          <div className="modal-field">
            <label id="power-wave-label">Waveform</label>
            <div className="toggle-group" role="group" aria-labelledby="power-wave-label">
              <button
                type="button"
                className={`toggle-btn ${waveform === 'square' ? 'active' : ''}`}
                aria-pressed={waveform === 'square'}
                onClick={() => setWaveform('square')}
              >
                <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden="true">
                  <path d="M 0 12 h 7 v -10 h 7 v 10 h 7 v -10 h 7" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
                Square
              </button>
              <button
                type="button"
                className={`toggle-btn ${waveform === 'sine' ? 'active' : ''}`}
                aria-pressed={waveform === 'sine'}
                onClick={() => setWaveform('sine')}
              >
                <svg width="28" height="14" viewBox="0 0 28 14" aria-hidden="true">
                  <path d="M 0 7 Q 3.5 -3 7 7 Q 10.5 17 14 7 Q 17.5 -3 21 7 Q 24.5 17 28 7" stroke="currentColor" strokeWidth="1.5" fill="none" />
                </svg>
                Sine
              </button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="modal-btn secondary" onClick={onCancel}>Cancel</button>
          <button type="submit" className="modal-btn primary">Add</button>
        </div>
      </form>
    </Modal>
  );
}
