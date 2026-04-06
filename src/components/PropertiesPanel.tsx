import { PlacedComponent } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';

interface PropertiesPanelProps {
  component: PlacedComponent | null;
  onPropertyChange: (componentId: string, key: string, value: number | string) => void;
}

export default function PropertiesPanel({ component, onPropertyChange }: PropertiesPanelProps) {
  if (!component) {
    return (
      <div className="properties-panel empty">
        <p>Select a component to view its properties</p>
      </div>
    );
  }

  const def = COMPONENT_DEFINITIONS[component.type];
  if (!def) return null;

  return (
    <div className="properties-panel">
      <h3>{def.label}</h3>
      {def.properties && Object.entries(def.properties).map(([key, prop]) => {
        const value = component.properties[key] ?? prop.default;

        // Mode toggle (DC/AC)
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

        // Waveform toggle
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
