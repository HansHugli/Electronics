import { PlacedComponent, Wire } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';

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
  onPropertyChange: (componentId: string, key: string, value: number | string) => void;
  onRotate: (componentId: string) => void;
  selectedWire: Wire | null;
  onWireColorChange: (wireId: string, color: string) => void;
}

export default function PropertiesPanel({ component, onPropertyChange, onRotate, selectedWire, onWireColorChange }: PropertiesPanelProps) {
  // Wire selected — show wire properties
  if (selectedWire) {
    return (
      <div className="properties-panel">
        <h3>Wire</h3>
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

    return (
      <div className="properties-panel">
        <h3>{def.label}</h3>
        {canRotate && (
          <div className="property-row-col">
            <label>Orientation</label>
            <div className="prop-toggle-group">
              <button
                type="button"
                className={`prop-toggle-btn ${isVertical ? 'active' : ''}`}
                onClick={() => { if (!isVertical) onRotate(component.id); }}
              >
                Vertical
              </button>
              <button
                type="button"
                className={`prop-toggle-btn ${!isVertical ? 'active' : ''}`}
                onClick={() => { if (isVertical) onRotate(component.id); }}
              >
                Horizontal
              </button>
            </div>
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
                      onClick={() => onPropertyChange(component.id, key, opt.value)}
                    />
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
            return (
              <div key={key} className="property-row-col">
                <label>{prop.label}</label>
                <div className="prop-toggle-group">
                  {['square', 'sine'].map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      className={`prop-toggle-btn ${value === opt ? 'active' : ''}`}
                      onClick={() => onPropertyChange(component.id, key, opt)}
                    >
                      {opt === 'square' ? '▯ Square' : '∿ Sine'}
                    </button>
                  ))}
                </div>
              </div>
            );
          }

          return (
            <div key={key} className="property-row">
              <label>{prop.label}</label>
              <div className="property-input-group">
                <input
                  title={prop.label}
                  type={typeof prop.default === 'number' ? 'number' : 'text'}
                  value={value}
                  onChange={(e) => {
                    const val = typeof prop.default === 'number' ? parseFloat(e.target.value) || 0 : e.target.value;
                    onPropertyChange(component.id, key, val);
                  }}
                />
                {prop.unit && <span className="property-unit">{prop.unit}</span>}
              </div>
            </div>
          );
        })}
        <div className="property-row">
          <label>Position</label>
          <span className="property-value">({component.position.x}, {component.position.y})</span>
        </div>
      </div>
    );
  }

  // Nothing selected
  return (
    <div className="properties-panel empty">
      <p>Select a component or wire to view its properties</p>
    </div>
  );
}
