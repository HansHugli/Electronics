import { COMPONENT_DEFINITIONS, COMPONENT_CATEGORIES } from '../data/components';
import { ComponentDefinition } from '../types';

interface SidebarProps {
  onClick: (componentType: string) => void;
  onDeleteType?: (componentType: string) => void;
  /** Incremented whenever COMPONENT_DEFINITIONS is mutated, to trigger a re-render. */
  catalogVersion: number;
}

const DARK_COLORS = new Set(['#1a1a1a', '#2d2d2d', '#4a4a4a', '#1e293b']);

function ComponentCard({
  def,
  onClick,
  onDelete,
}: {
  def: ComponentDefinition;
  onClick: () => void;
  onDelete?: () => void;
}) {
  const isDark = DARK_COLORS.has(def.color);
  const iconText = def.icon ?? def.label[0];

  return (
    <div
      className="component-card"
      title={def.description ? `${def.label} — ${def.description}\nClick to place on the breadboard.` : `${def.label}\nClick to place on the breadboard.`}
      onClick={onClick}
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
      {onDelete && (
        <button
          type="button"
          className="component-card-delete"
          title={`Delete "${def.label}" component type`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export default function Sidebar({ onClick, onDeleteType, catalogVersion }: SidebarProps) {
  // Re-read definitions whenever catalogVersion changes (triggered by create/delete)
  void catalogVersion;
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
                <ComponentCard
                  key={def.type}
                  def={def}
                  onClick={() => onClick(def.type)}
                  onDelete={onDeleteType ? () => onDeleteType(def.type) : undefined}
                />
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
