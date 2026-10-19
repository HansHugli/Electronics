import { useRef, useEffect } from 'react';
import { PlacedComponent } from '../types';

interface SerialMonitorProps {
  components: PlacedComponent[];
  visible: boolean;
  onToggle: () => void;
  simRunning: boolean;
}

export default function SerialMonitor({ components, visible, onToggle, simRunning }: SerialMonitorProps) {
  const outputRef = useRef<HTMLPreElement>(null);

  // Find all ATmega328 components with serial output
  const serialOutputs: { id: string; label: string; text: string }[] = [];
  for (const comp of components) {
    if (comp.type === 'atmega328' && comp.state?.serialOutput) {
      const text = String(comp.state.serialOutput);
      if (text.length > 0) {
        serialOutputs.push({
          id: comp.id,
          label: comp.id,
          text,
        });
      }
    }
  }

  // Auto-scroll to bottom
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [serialOutputs.map((s) => s.text.length).join(',')]);

  if (!visible) {
    return (
      <div className="serial-toggle-bar">
        <button type="button" className="scope-toggle-btn" onClick={onToggle} title="Show serial monitor">
          Serial
        </button>
      </div>
    );
  }

  return (
    <div className="serial-panel">
      <div className="serial-header">
        <span className="scope-title">Serial Monitor</span>
        {!simRunning && <span className="serial-hint">Simulation paused</span>}
        <button type="button" className="scope-close-btn" onClick={onToggle} aria-label="Close the serial monitor" title="Close the serial monitor">×</button>
      </div>
      <pre ref={outputRef} className="serial-output">
        {serialOutputs.length === 0 ? (
          <span className="serial-empty">
            {simRunning
              ? 'No serial output yet. Use Serial.begin() and Serial.print() in your sketch.'
              : 'Run the simulation to see serial output.'}
          </span>
        ) : (
          serialOutputs.map((s) => (
            <span key={s.id}>{s.text}</span>
          ))
        )}
      </pre>
    </div>
  );
}
