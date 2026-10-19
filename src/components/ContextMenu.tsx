interface MenuItem {
  label: string;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  // Keep the menu inside the window.
  const left = Math.max(4, Math.min(x, window.innerWidth - 210));
  const top = Math.max(4, Math.min(y, window.innerHeight - items.length * 34 - 12));
  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="context-menu" role="menu" style={{ left, top }}>
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
            role="menuitem"
            autoFocus={i === 0}
            className={`context-menu-item ${item.danger ? 'danger' : ''}`}
            onClick={() => { item.onClick(); onClose(); }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
          </button>
        ))}
      </div>
    </>
  );
}
