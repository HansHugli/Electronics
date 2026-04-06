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
  return (
    <>
      <div className="context-menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="context-menu" style={{ left: x, top: y }}>
        {items.map((item, i) => (
          <button
            key={i}
            type="button"
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
