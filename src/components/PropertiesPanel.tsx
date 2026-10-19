import { useState, useEffect, useRef, useId } from 'react';
import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';
import { BOARD_X_OFFSET, pixelToGrid } from '../data/breadboard';
import { formatValue } from '../utils/format';
import { getPinPosition } from './Breadboard';
import { getWarning } from './partVisuals';
import { parseValueInput, formatValueInput, unitInfo } from './valueInput';

const WIRE_COLOR_OPTIONS = [
  { color: '#ef4444', label: 'Red' },
  { color: '#fbbf24', label: 'Yellow' },
  { color: '#4ade80', label: 'Green' },
  { color: '#60a5fa', label: 'Blue' },
  { color: '#c084fc', label: 'Purple' },
  { color: '#f472b6', label: 'Pink' },
  { color: '#fb923c', label: 'Orange' },
  { color: '#e2e8f0', label: 'White' },
  { color: '#1e1e1e', label: 'Black' },
];

interface PropertiesPanelProps {
  component: PlacedComponent | null;
  /** Commit a value: one undo entry. */
  onPropertyChange: (componentId: string, key: string, value: number | string) => void;
  /** Live preview while a slider is dragged (no undo entry); the release commits. */
  onPropertyPreview?: (componentId: string, key: string, value: number | string) => void;
  onRotate: (componentId: string) => void;
  /** LEDs: swap anode and cathode (turns the part round). */
  onFlipPolarity?: (componentId: string) => void;
  selectedWire: Wire | null;
  onWireColorChange: (wireId: string, color: string) => void;
  onProbe?: () => void;
  isProbed?: boolean;
  onLoadHex?: () => void;
  isHexLoaded?: boolean;
  onWriteSketch?: () => void;
}

/** "col 6, row 3" for the hole under pin 1, as the hover label and the assistant use them. */
function positionLabel(comp: PlacedComponent): string {
  const def = COMPONENT_DEFINITIONS[comp.type];
  if (comp.type === 'power') return 'Supply area (left of the board)';
  const pin = def?.pins[0];
  const p = pin ? getPinPosition(comp, pin.id) : null;
  if (!p || p.x < BOARD_X_OFFSET) return 'Off the board';
  const { col, row } = pixelToGrid(p.x, p.y);
  return `col ${col}, row ${row}${pin ? ` (pin ${pin.label || pin.id})` : ''}`;
}

/**
 * A numeric field that accepts SI shorthand ("4.7k", "100n", "1M").
 * Typing doesn't change the circuit; Enter or leaving the field commits once
 * (one undo entry). Escape puts the old value back. Bad input shows a message
 * and is never stored.
 */
function ValueField({ label, value, unit, onCommit }: {
  label: string;
  value: number;
  unit?: string;
  onCommit: (v: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(() => formatValueInput(value, unit));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);

  // Follow outside changes (undo, another part selected) while not editing.
  useEffect(() => {
    if (!focused.current) {
      setText(formatValueInput(value, unit));
      setError(null);
    }
  }, [value, unit]);

  // If the field disappears while being edited (another part selected), still
  // commit a valid edit to the part it belonged to.
  const latest = useRef({ text, value, unit, onCommit });
  latest.current = { text, value, unit, onCommit };
  useEffect(() => () => {
    if (!focused.current) return;
    const l = latest.current;
    const parsed = parseValueInput(l.text, l.unit);
    if (parsed.ok && parsed.value !== l.value) l.onCommit(parsed.value);
  }, []);

  const commit = () => {
    const parsed = parseValueInput(text, unit);
    if (!parsed.ok) { setError(parsed.error); return false; }
    setError(null);
    if (parsed.value !== value) onCommit(parsed.value);
    setText(formatValueInput(parsed.value, unit));
    return true;
  };

  const info = unitInfo(unit);
  const hint = info ? formatValue(value, info.base, info.exp) : undefined;

  return (
    <div className="property-row property-row-wrap">
      <label htmlFor={id}>{label}</label>
      <div className="property-input-group">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          spellCheck={false}
          autoComplete="off"
          value={text}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-err` : undefined}
          className={error ? 'invalid' : ''}
          onFocus={() => { focused.current = true; }}
          onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
          onBlur={() => {
            focused.current = false;
            // Bad text stays visible with its message until fixed or Escape.
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setText(formatValueInput(value, unit));
              setError(null);
            }
          }}
        />
        {unit && <span className="property-unit">{unit}</span>}
      </div>
      {error
        ? <div id={`${id}-err`} className="property-error" role="alert">{error}</div>
        : hint && <div className="property-hint">= {hint}</div>}
    </div>
  );
}

/** A text property, committed on Enter or blur. */
function TextField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const id = useId();
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(value); }, [value]);
  return (
    <div className="property-row">
      <label htmlFor={id}>{label}</label>
      <div className="property-input-group">
        <input
          id={id}
          type="text"
          value={text}
          onFocus={() => { focused.current = true; }}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => { focused.current = false; if (text !== value) onCommit(text); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (text !== value) onCommit(text); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setText(value); }
          }}
        />
      </div>
    </div>
  );
}

/** Potentiometer wiper: moves live, one undo entry per drag. */
function SliderField({ label, value, onPreview, onCommit }: {
  label: string;
  value: number;
  onPreview?: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const id = useId();
  const [local, setLocal] = useState(value);
  const start = useRef(value);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setLocal(value); }, [value]);
  const finish = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (local !== start.current) onCommit(local);
  };
  return (
    <div className="property-row-col">
      <label htmlFor={id}>{label}: {local}%</label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        value={local}
        title={`${local}%`}
        onPointerDown={() => { dragging.current = true; start.current = value; }}
        onKeyDown={() => { if (!dragging.current) { dragging.current = true; start.current = value; } }}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          setLocal(v);
          if (!dragging.current) { onCommit(v); return; }
          onPreview?.(v);
        }}
        onPointerUp={finish}
        onKeyUp={finish}
        onBlur={finish}
        className="prop-slider"
      />
    </div>
  );
}

export default function PropertiesPanel({ component, onPropertyChange, onPropertyPreview, onRotate, onFlipPolarity, selectedWire, onWireColorChange, onProbe, isProbed, onLoadHex, isHexLoaded, onWriteSketch }: PropertiesPanelProps) {
  // Wire selected — show wire properties
  if (selectedWire) {
    const fmtEndpoint = (ep: { componentId: string; pinId: string }) => {
      if (ep.componentId !== 'board') return `${ep.componentId}.${ep.pinId}`;
      const [c, r] = ep.pinId.split(',');
      return `Board, col ${c}, row ${r}`;
    };
    return (
      <div className="properties-panel">
        <h3>Wire</h3>
        <div className="property-row">
          <label>ID</label>
          <span className="property-value">{selectedWire.id}</span>
        </div>
        <div className="property-row">
          <label>From</label>
          <span className="property-value">{fmtEndpoint(selectedWire.from)}</span>
        </div>
        <div className="property-row">
          <label>To</label>
          <span className="property-value">{fmtEndpoint(selectedWire.to)}</span>
        </div>
        <div className="property-row-col">
          <label>Color</label>
          <div className="color-picker">
            {WIRE_COLOR_OPTIONS.map((opt) => (
              <button
                key={opt.color}
                type="button"
                className={`color-swatch ${selectedWire.color === opt.color ? 'active' : ''}`}
                style={{ backgroundColor: opt.color }}
                title={opt.label}
                aria-label={`Wire colour ${opt.label}`}
                aria-pressed={selectedWire.color === opt.color}
                onClick={() => onWireColorChange(selectedWire.id, opt.color)}
              />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Component selected
  if (component) {
    const def = COMPONENT_DEFINITIONS[component.type];
    if (!def) return null;

    const isVertical = component.rotation === 0 || component.rotation === 180;
    const canRotate = component.type !== 'power';
    const warning = getWarning(component);
    const isACSupply = component.type === 'power' && component.properties.mode === 'AC';

    return (
      <div className="properties-panel" key={component.id}>
        <h3>{def.label} <span className="properties-id">{component.id}</span></h3>
        {warning && (
          <div className="property-warning" role="status">
            <span className="property-warning-icon" aria-hidden="true">!</span>
            <span>{warning.message}</span>
          </div>
        )}
        {canRotate && (
          <div className="property-row-col">
            <label>Orientation</label>
            <div className="prop-toggle-group">
              <button
                type="button"
                className={`prop-toggle-btn ${isVertical ? 'active' : ''}`}
                aria-pressed={isVertical}
                onClick={() => { if (!isVertical) onRotate(component.id); }}
              >
                Vertical
              </button>
              <button
                type="button"
                className={`prop-toggle-btn ${!isVertical ? 'active' : ''}`}
                aria-pressed={!isVertical}
                onClick={() => { if (isVertical) onRotate(component.id); }}
              >
                Horizontal
              </button>
            </div>
          </div>
        )}
        {component.type === 'led' && onFlipPolarity && (
          <div className="property-row-col">
            <label>Polarity</label>
            <button type="button" className="prop-probe-btn" onClick={() => onFlipPolarity(component.id)}
              title="Turn the LED round so anode (+) and cathode (−, flat side) swap holes">
              Flip polarity
            </button>
          </div>
        )}
        {def.properties && Object.entries(def.properties).map(([key, prop]) => {
          const value = component.properties[key] ?? prop.default;

          // LED color picker
          if (key === 'color' && component.type === 'led') {
            const ledColors = [
              { value: 'red', color: '#ef4444' },
              { value: 'green', color: '#22c55e' },
              { value: 'blue', color: '#3b82f6' },
              { value: 'yellow', color: '#eab308' },
              { value: 'orange', color: '#f97316' },
              { value: 'purple', color: '#a855f7' },
              { value: 'white', color: '#f1f5f9' },
            ];
            return (
              <div key={key} className="property-row-col">
                <label>{prop.label}</label>
                <div className="color-picker">
                  {ledColors.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`color-swatch ${value === opt.value ? 'active' : ''}`}
                      style={{ backgroundColor: opt.color }}
                      title={opt.value}
                      aria-label={`LED colour ${opt.value}`}
                      aria-pressed={value === opt.value}
                      onClick={() => onPropertyChange(component.id, key, opt.value)}
                    />
                  ))}
                </div>
              </div>
            );
          }

          // Potentiometer position slider
          if (key === 'position' && component.type === 'potentiometer') {
            return (
              <SliderField
                key={key}
                label={prop.label}
                value={Number(value)}
                onPreview={onPropertyPreview ? (v) => onPropertyPreview(component.id, key, v) : undefined}
                onCommit={(v) => onPropertyChange(component.id, key, v)}
              />
            );
          }

          // Multimeter mode toggle
          if (key === 'mode' && component.type === 'multimeter') {
            return (
              <div key={key} className="property-row-col">
                <label>{prop.label}</label>
                <div className="prop-toggle-group">
                  {['voltage', 'current'].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className={`prop-toggle-btn ${value === opt ? 'active' : ''}`}
                      aria-pressed={value === opt}
                      onClick={() => onPropertyChange(component.id, key, opt)}
                    >
                      {opt === 'voltage' ? 'Volts (V)' : 'Amps (A)'}
                    </button>
                  ))}
                </div>
              </div>
            );
          }

          if (key === 'mode') {
            return (
              <div key={key} className="property-row-col">
                <label>{prop.label}</label>
                <div className="prop-toggle-group">
                  {['DC', 'AC'].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className={`prop-toggle-btn ${value === opt ? 'active' : ''}`}
                      aria-pressed={value === opt}
                      onClick={() => onPropertyChange(component.id, key, opt)}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            );
          }

          if (key === 'waveform') {
            // A DC supply has no waveform.
            if (component.type === 'power' && !isACSupply) return null;
            const waveformOptions = component.type === 'funcgen'
              ? ['sine', 'square', 'triangle', 'sawtooth']
              : ['square', 'sine'];
            const waveformLabels: Record<string, string> = {
              sine: '∿ Sine', square: '▯ Square', triangle: '△ Triangle', sawtooth: '/ Saw',
            };
            return (
              <div key={key} className="property-row-col">
                <label>{prop.label}</label>
                <div className="prop-toggle-group">
                  {waveformOptions.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className={`prop-toggle-btn ${value === opt ? 'active' : ''}`}
                      aria-pressed={value === opt}
                      onClick={() => onPropertyChange(component.id, key, opt)}
                    >
                      {waveformLabels[opt] ?? opt}
                    </button>
                  ))}
                </div>
              </div>
            );
          }

          if (typeof prop.default === 'number') {
            return (
              <ValueField
                key={key}
                label={prop.label}
                value={Number(value)}
                unit={prop.unit}
                onCommit={(v) => onPropertyChange(component.id, key, v)}
              />
            );
          }

          return (
            <TextField
              key={key}
              label={prop.label}
              value={String(value)}
              onCommit={(v) => onPropertyChange(component.id, key, v)}
            />
          );
        })}
        <div className="property-row">
          <label>Position</label>
          <span className="property-value">{positionLabel(component)}</span>
        </div>
        {onLoadHex && (
          <>
            <div className="prop-btn-row">
              <button
                type="button"
                className="prop-probe-btn"
                onClick={onLoadHex}
              >
                Load .hex…
              </button>
              {onWriteSketch && (
                <button
                  type="button"
                  className="prop-probe-btn"
                  onClick={onWriteSketch}
                >
                  {component.properties.sketch ? 'Edit sketch…' : 'Write sketch…'}
                </button>
              )}
            </div>
            <div className="property-row">
              <label>Firmware</label>
              <span className="property-value">
                {isHexLoaded || component.properties.hex
                  ? component.properties.sketch ? 'Compiled sketch loaded' : 'Hex loaded'
                  : 'No program loaded'}
              </span>
            </div>
          </>
        )}
        {onProbe && (
          <button
            type="button"
            className={`prop-probe-btn ${isProbed ? 'active' : ''}`}
            onClick={onProbe}
            aria-pressed={!!isProbed}
          >
            {isProbed ? 'Probed on the scope' : 'Probe with the scope'}
          </button>
        )}
      </div>
    );
  }

  // Nothing selected
  return (
    <div className="properties-panel empty">
      <p>Select a part or wire to see and change its properties.</p>
    </div>
  );
}
