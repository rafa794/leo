import { Captions, ChevronDown, Film, Music, SlidersHorizontal, Sticker, Type } from 'lucide-react';
import { useEditor } from '../store/editor';
import { useLayout, type LeftTab } from '../store/layout';
import LeftPanel from './LeftPanel';
import Inspector from './Inspector';

const ITEMS: [LeftTab, string, typeof Film][] = [
  ['media', 'Multimedia', Film],
  ['audio', 'Audio', Music],
  ['text', 'Texto', Type],
  ['stickers', 'Stickers', Sticker],
  ['captions', 'Subtítulos', Captions],
];

/** Phone / narrow window: bottom bar (like CapCut mobile) that opens the panels as sheets. */
export default function MobileNav() {
  const sheet = useLayout((s) => s.sheet);
  const tab = useLayout((s) => s.leftTab);
  const set = useLayout((s) => s.set);
  const hasSel = useEditor((s) => s.selectedIds.length > 0);
  const openLeft = (t: LeftTab) => set(sheet === 'left' && tab === t ? { sheet: null } : { sheet: 'left', leftTab: t });
  return (
    <>
      {sheet && (
        <div className="sheet">
          <div className="sheet-grip" onClick={() => set({ sheet: null })} title="Cerrar">
            <ChevronDown size={18} />
          </div>
          {sheet === 'left' ? <LeftPanel sheet /> : <Inspector />}
        </div>
      )}
      <nav className="mobile-nav">
        {ITEMS.map(([id, label, Icon]) => (
          <button key={id} className={sheet === 'left' && tab === id ? 'active' : ''} onClick={() => openLeft(id)}>
            <Icon size={20} />
            {label}
          </button>
        ))}
        <button className={`${sheet === 'props' ? 'active' : ''} ${hasSel ? 'ready' : ''}`} onClick={() => set({ sheet: sheet === 'props' ? null : 'props' })}>
          <SlidersHorizontal size={20} />
          Editar
        </button>
      </nav>
    </>
  );
}
