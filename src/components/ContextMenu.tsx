import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export type MenuItem =
  | { separator: true }
  | { header: string }
  | { label: string; icon?: ReactNode; shortcut?: string; disabled?: boolean; danger?: boolean; badge?: string; onClick: () => void };

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** CapCut-style right-click menu. Closes on click outside, Escape, scroll or resize. */
export default function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  // keep the menu inside the window
  useLayoutEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)),
    });
  }, [menu]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="ctx-menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((it, i) =>
        'separator' in it ? (
          <div key={i} className="ctx-sep" />
        ) : 'header' in it ? (
          <div key={i} className="ctx-header">
            {it.header}
          </div>
        ) : (
          <button
            key={i}
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span className="ctx-icon">{it.icon}</span>
            <span className="ctx-label">
              {it.label}
              {it.badge && <span className="badge" style={{ marginLeft: 6 }}>{it.badge}</span>}
            </span>
            {it.shortcut && <span className="ctx-shortcut">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}
