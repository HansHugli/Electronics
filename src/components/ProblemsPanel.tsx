import { useState } from 'react';
import { PlacedComponent } from '../types';
import { COMPONENT_DEFINITIONS } from '../data/components';
import { getWarning } from './partVisuals';

/**
 * "Why isn't it working?": every warning the simulator reports right now
 * (reversed LED, no ground, short circuit…). Clicking one selects the part.
 */
export default function ProblemsPanel({ components, onSelect }: {
  components: PlacedComponent[];
  onSelect: (componentId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const problems = components
    .map((c) => ({ comp: c, warning: getWarning(c) }))
    .filter((p): p is { comp: PlacedComponent; warning: NonNullable<ReturnType<typeof getWarning>> } => p.warning !== null);
  if (problems.length === 0) return null;

  return (
    <div className="problems-panel" role="region" aria-label="Why isn't it working?">
      <button
        type="button"
        className="problems-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="problems-icon" aria-hidden="true">!</span>
        Why isn't it working? ({problems.length})
        <span className="toolbar-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <ul className="problems-list">
          {problems.map(({ comp, warning }) => (
            <li key={comp.id}>
              <button type="button" className="problems-item" onClick={() => onSelect(comp.id)} data-warning-code={warning.code}>
                <span className="problems-part">{COMPONENT_DEFINITIONS[comp.type]?.label ?? comp.type} {comp.id}</span>
                <span className="problems-message">{warning.message}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
