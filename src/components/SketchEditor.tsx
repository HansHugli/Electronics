import { useState, useEffect } from 'react';

const DEFAULT_SKETCH = `// Blink LED on pin 13
void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(1000);
  digitalWrite(13, LOW);
  delay(1000);
}
`;

interface SketchEditorProps {
  onCompiled: (hex: string) => void;
  onClose: () => void;
}

export default function SketchEditor({ onCompiled, onClose }: SketchEditorProps) {
  const [code, setCode] = useState(DEFAULT_SKETCH);
  const [status, setStatus] = useState<'idle' | 'setting-up' | 'compiling' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [cliReady, setCliReady] = useState(false);

  // Check arduino-cli status on mount
  useEffect(() => {
    if (!window.electronApi?.arduinoStatus) {
      setMessage('Arduino compilation requires the desktop app');
      return;
    }
    window.electronApi.arduinoStatus().then((s) => {
      if (s.cliInstalled && s.coreInstalled) {
        setCliReady(true);
      }
    });
  }, []);

  const handleSetup = async () => {
    if (!window.electronApi?.arduinoSetup) return;
    setStatus('setting-up');
    setMessage('Downloading arduino-cli and AVR core... This may take a few minutes on first run.');
    try {
      const result = await window.electronApi.arduinoSetup();
      if (result.success) {
        setCliReady(true);
        setStatus('idle');
        setMessage('Setup complete');
      } else {
        setStatus('error');
        setMessage('Setup failed');
      }
    } catch (e) {
      setStatus('error');
      setMessage(`Setup failed: ${(e as Error).message}`);
    }
  };

  const handleCompile = async () => {
    if (!window.electronApi?.arduinoCompile) return;
    setStatus('compiling');
    setMessage('Compiling...');
    try {
      const result = await window.electronApi.arduinoCompile(code);
      if (result.success && result.hex) {
        setStatus('done');
        setMessage('Compilation successful');
        onCompiled(result.hex);
      } else {
        setStatus('error');
        setMessage(result.error || 'Compilation failed');
      }
    } catch (e) {
      setStatus('error');
      setMessage(`Error: ${(e as Error).message}`);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal sketch-modal">
        <h2 className="modal-title">Arduino Sketch Editor</h2>
        <textarea
          className="sketch-textarea"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          placeholder="Paste your Arduino sketch here..."
        />
        {message && (
          <div className={`sketch-message ${status === 'error' ? 'error' : status === 'done' ? 'success' : ''}`}>
            {message}
          </div>
        )}
        <div className="modal-actions">
          {!cliReady && window.electronApi?.arduinoSetup && (
            <button
              type="button"
              className="modal-btn primary"
              onClick={handleSetup}
              disabled={status === 'setting-up'}
            >
              {status === 'setting-up' ? 'Setting up...' : 'Install Arduino Tools'}
            </button>
          )}
          {cliReady && (
            <button
              type="button"
              className="modal-btn primary"
              onClick={handleCompile}
              disabled={status === 'compiling' || !code.trim()}
            >
              {status === 'compiling' ? 'Compiling...' : 'Compile & Load'}
            </button>
          )}
          <button type="button" className="modal-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
