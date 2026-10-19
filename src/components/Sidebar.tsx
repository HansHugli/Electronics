import { COMPONENT_DEFINITIONS, COMPONENT_CATEGORIES } from '../data/components';
import { ComponentDefinition } from '../types';

interface SidebarProps {
  onClick: (componentType: string) => void;
  onDeleteType?: (componentType: string) => void;
  /** Incremented whenever COMPONENT_DEFINITIONS is mutated, to trigger a re-render. */
  catalogVersion: number;
}

/**
 * The parts that ship with the app, captured before any custom chip is
 * registered. Only custom chips (from chips/ or made by the assistant) can be
 * deleted.
 */
export const BUILT_IN_TYPES: ReadonlySet<string> = new Set(Object.keys(COMPONENT_DEFINITIONS));

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
      role="button"
      tabIndex={0}
      draggable
      title={`${def.label}${def.description ? ` — ${def.description}` : ''}\nClick to place it on the breadboard, or drag it to a spot.`}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('componentType', def.type);
        e.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <div className="component-card-icon" aria-hidden="true" style={{
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
          title={`Delete the custom part "${def.label}"`}
          aria-label={`Delete the custom part ${def.label}`}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          onKeyDown={(e) => e.stopPropagation()}
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
    <aside className="sidebar" aria-label="Components">
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
                  onDelete={onDeleteType && !BUILT_IN_TYPES.has(def.type) ? () => onDeleteType(def.type) : undefined}
                />
              ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
