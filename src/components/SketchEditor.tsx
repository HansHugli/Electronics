import { useState, useEffect, useRef } from 'react';

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

/** Parse arduino-cli compile errors into structured format. */
function parseCompileErrors(raw: string): { line: number; col: number; level: string; text: string }[] {
  const errors: { line: number; col: number; level: string; text: string }[] = [];
  // Match patterns like: sketch.ino:5:3: error: expected ';' before '}' token
  const regex = /sketch\.ino:(\d+):(\d+):\s*(error|warning|note):\s*(.+)/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    errors.push({
      line: parseInt(match[1], 10),
      col: parseInt(match[2], 10),
      level: match[3],
      text: match[4].trim(),
    });
  }
  return errors;
}

export default function SketchEditor({ onCompiled, onClose }: SketchEditorProps) {
  const [code, setCode] = useState(DEFAULT_SKETCH);
  const [status, setStatus] = useState<'idle' | 'setting-up' | 'compiling' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [compileErrors, setCompileErrors] = useState<{ line: number; col: number; level: string; text: string }[]>([]);
  const [cliReady, setCliReady] = useState(false);
  const [setupProgress, setSetupProgress] = useState('');
  /** Absolute path of the .ino file the user opened (if any). When set, a
   *  successful compile will write the .hex next to it on disk. */
  const [sketchFilePath, setSketchFilePath] = useState<string | null>(null);
  const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const sketchInputRef = useRef<HTMLInputElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const lineNumbersRef = useRef<HTMLDivElement | null>(null);

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

  // Cleanup progress timer
  useEffect(() => {
    return () => {
      if (progressTimer.current) clearInterval(progressTimer.current);
    };
  }, []);

  const handleSetup = async () => {
    if (!window.electronApi?.arduinoSetup) return;
    setStatus('setting-up');
    setCompileErrors([]);

    // Animated progress messages
    const steps = [
      'Downloading arduino-cli...',
      'Extracting archive...',
      'Installing AVR core (this may take a few minutes)...',
      'Downloading toolchain packages...',
      'Still working...',
    ];
    let stepIdx = 0;
    setSetupProgress(steps[0]);
    progressTimer.current = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, steps.length - 1);
      setSetupProgress(steps[stepIdx]);
    }, 8000);

    try {
      const result = await window.electronApi.arduinoSetup();
      if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null; }
      if (result.success) {
        setCliReady(true);
        setStatus('idle');
        setMessage('Setup complete — ready to compile!');
        setSetupProgress('');
      } else {
        setStatus('error');
        setMessage((result as { error?: string }).error || 'Setup failed');
        setSetupProgress('');
      }
    } catch (e) {
      if (progressTimer.current) { clearInterval(progressTimer.current); progressTimer.current = null; }
      setStatus('error');
      setMessage(`Setup failed: ${(e as Error).message}`);
      setSetupProgress('');
    }
  };

  const handleCompile = async () => {
    if (!window.electronApi?.arduinoCompile) return;
    setStatus('compiling');
    setMessage('Compiling sketch...');
    setCompileErrors([]);
    try {
      const result = await window.electronApi.arduinoCompile(code);
      if (result.success && result.hex) {
        setStatus('done');
        let msg = 'Compilation successful — hex loaded into simulator';
        // If we know the source .ino path, also dump the hex next to it so
        // the user can re-load it later via "Load .hex" without re-compiling.
        if (sketchFilePath && window.electronApi.arduinoSaveHex) {
          const saved = await window.electronApi.arduinoSaveHex(sketchFilePath, result.hex);
          if (saved.success && saved.hexPath) {
            msg = `Compilation successful — hex loaded and saved to ${saved.hexPath}`;
          } else if (saved.error) {
            msg = `Compiled and loaded, but couldn't save .hex: ${saved.error}`;
          }
        }
        setMessage(msg);
        onCompiled(result.hex);
      } else {
        setStatus('error');
        const errText = result.error || 'Compilation failed';
        const parsed = parseCompileErrors(errText);
        if (parsed.length > 0) {
          setCompileErrors(parsed);
          const errCount = parsed.filter((e) => e.level === 'error').length;
          const warnCount = parsed.filter((e) => e.level === 'warning').length;
          const parts = [];
          if (errCount) parts.push(`${errCount} error${errCount > 1 ? 's' : ''}`);
          if (warnCount) parts.push(`${warnCount} warning${warnCount > 1 ? 's' : ''}`);
          setMessage(`Compilation failed: ${parts.join(', ')}`);
        } else {
          setMessage(errText);
        }
      }
    } catch (e) {
      setStatus('error');
      setMessage(`Error: ${(e as Error).message}`);
    }
  };

  const handleLoadSketchFile = async () => {
    // Prefer the native Electron open dialog so we get the absolute file
    // path (the browser <input type="file"> doesn't expose paths). The path
    // lets us write the compiled .hex back next to the source .ino.
    if (window.electronApi?.arduinoOpenSketch) {
      const result = await window.electronApi.arduinoOpenSketch();
      if (!result) return;
      setCode(result.data);
      setSketchFilePath(result.filePath);
      setStatus('idle');
      setMessage(`Loaded sketch "${result.name}"`);
      setCompileErrors([]);
      return;
    }
    // Browser fallback (no path tracking).
    sketchInputRef.current?.click();
  };

  const handleSketchFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCode(text);
    setSketchFilePath(null);
    setStatus('idle');
    setMessage(`Loaded sketch "${file.name}"`);
    setCompileErrors([]);
    event.target.value = '';
  };

  const handleTextareaScroll = () => {
    if (!lineNumbersRef.current || !textAreaRef.current) return;
    lineNumbersRef.current.scrollTop = textAreaRef.current.scrollTop;
  };

  const lineCount = code.split('\n').length;

  return (
    <div className="modal-overlay">
      <div className="modal sketch-modal">
        <h2 className="modal-title">Arduino Sketch Editor</h2>
        <div className="sketch-editor-wrap">
          {/* Line numbers */}
          <div ref={lineNumbersRef} className="sketch-line-numbers">
            {Array.from({ length: lineCount }, (_, i) => (
              <div
                key={i + 1}
                className={`sketch-line-num ${compileErrors.some((e) => e.line === i + 1) ? 'error' : ''}`}
              >
                {i + 1}
              </div>
            ))}
          </div>
          <textarea
            ref={textAreaRef}
            className="sketch-textarea"
            value={code}
            onChange={(e) => { setCode(e.target.value); setCompileErrors([]); setSketchFilePath(null); }}
            onScroll={handleTextareaScroll}
            spellCheck={false}
            placeholder="Write your Arduino sketch here..."
          />
        </div>
        <input
          ref={sketchInputRef}
          type="file"
          accept=".ino"
          style={{ display: 'none' }}
          onChange={handleSketchFileChange}
        />
        {/* Compile errors list */}
        {compileErrors.length > 0 && (
          <div className="sketch-errors">
            {compileErrors.map((err, i) => (
              <div key={i} className={`sketch-error-item ${err.level}`}>
                <span className="sketch-error-loc">Line {err.line}:{err.col}</span>
                <span className="sketch-error-level">{err.level}</span>
                <span className="sketch-error-text">{err.text}</span>
              </div>
            ))}
          </div>
        )}
        {/* Status message */}
        {message && !compileErrors.length && (
          <div className={`sketch-message ${status === 'error' ? 'error' : status === 'done' ? 'success' : ''}`}>
            {message}
          </div>
        )}
        {/* Setup progress */}
        {status === 'setting-up' && setupProgress && (
          <div className="sketch-message">
            <span className="sketch-spinner" /> {setupProgress}
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
            <>
              <button
                type="button"
                className="modal-btn primary"
                onClick={handleCompile}
                disabled={status === 'compiling' || !code.trim()}
              >
                {status === 'compiling' ? 'Compiling...' : 'Compile & Load'}
              </button>
              <button
                type="button"
                className="modal-btn"
                onClick={handleLoadSketchFile}
              >
                Load .ino
              </button>
            </>
          )}
          <button type="button" className="modal-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
