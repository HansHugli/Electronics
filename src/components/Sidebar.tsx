import { COMPONENT_DEFINITIONS, COMPONENT_CATEGORIES } from '../data/components';
import { ComponentDefinition } from '../types';

interface SidebarProps {
  onDragStart: (componentType: string) => void;
}

function ComponentCard({ def, onDragStart }: { def: ComponentDefinition; onDragStart: () => void }) {
  return (
    <div
      className="component-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('componentType', def.type);
        onDragStart();
      }}
    >
      <div className="component-card-icon" style={{ backgroundColor: def.color + '22', borderColor: def.color }}>
        <span style={{ color: def.color }}>{def.label[0]}</span>
      </div>
      <div className="component-card-info">
        <span className="component-card-name">{def.label}</span>
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
