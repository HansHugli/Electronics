import { COMPONENT_DEFINITIONS, COMPONENT_CATEGORIES } from '../data/components';
import { ComponentDefinition } from '../types';

interface SidebarProps {
  onDragStart: (componentType: string) => void;
}

const DARK_COLORS = new Set(['#1a1a1a', '#2d2d2d', '#4a4a4a', '#1e293b']);

function ComponentCard({ def, onDragStart }: { def: ComponentDefinition; onDragStart: () => void }) {
  const isDark = DARK_COLORS.has(def.color);
  const iconText = def.icon ?? def.label[0];

  return (
    <div
      className="component-card"
      draggable
      title={def.description ? `${def.label} — ${def.description}\nDrag onto the breadboard to place.` : `${def.label}\nDrag onto the breadboard to place.`}
      onDragStart={(e) => {
        e.dataTransfer.setData('componentType', def.type);
        onDragStart();
      }}
    >
      <div className="component-card-icon" style={{
        backgroundColor: def.color + '22',
        borderColor: isDark ? '#64748b' : def.color,
      }}>
        <span style={{ color: isDark ? '#94a3b8' : def.color }}>{iconText}</span>
      </div>
      <div className="component-card-info">
        <span className="component-card-name">{def.label}</span>
        {def.description && <span className="component-card-detail">{def.description}</span>}
      </div>
    </div>
  );
}

export default function Sidebar({ onDragStart }: SidebarProps) {
  const definitions = Object.values(COMPONENT_DEFINITIONS);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>Components</h2>
      </div>
      <div className="sidebar-content">
        {COMPONENT_CATEGORIES.map((cat) => {
          const items = definitions.filter((d) => d.category === cat.id);
          if (items.length === 0) return null;
          return (
            <div key={cat.id} className="component-group">
              <h3 className="component-group-label">{cat.label}</h3>
              {items.map((def) => (
                <ComponentCard key={def.type} def={def} onDragStart={() => onDragStart(def.type)} />
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
