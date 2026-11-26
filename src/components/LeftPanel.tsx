import { Captions, Film, Music, PanelLeftClose, PanelLeftOpen, Sticker, Type } from 'lucide-react';
import { useLayout } from '../store/layout';
import MediaPanel from './MediaPanel';
import AudioPanel from './AudioPanel';
import StickersPanel from './StickersPanel';
import TextPanel from './TextPanel';
import CaptionsPanel from './CaptionsPanel';

const TABS = [
  { id: 'media', label: 'Multimedia', icon: Film },
  { id: 'audio', label: 'Audio', icon: Music },
  { id: 'text', label: 'Texto', icon: Type },
  { id: 'stickers', label: 'Stickers', icon: Sticker },
  { id: 'captions', label: 'Subtítulos', icon: Captions },
] as const;

export const LEFT_TABS = TABS;

export default function LeftPanel({ sheet = false }: { sheet?: boolean }) {
  const tab = useLayout((s) => s.leftTab);
  const setTab = (t: (typeof TABS)[number]['id']) => useLayout.getState().set({ leftTab: t });
  const open = useLayout((s) => s.leftOpen) || sheet;
  const setLayout = useLayout((s) => s.set);
  if (sheet)
    return (
      <div className="left-content sheet-content">
        {tab === 'media' && <MediaPanel />}
        {tab === 'audio' && <AudioPanel />}
        {tab === 'text' && <TextPanel />}
        {tab === 'stickers' && <StickersPanel />}
        {tab === 'captions' && <CaptionsPanel />}
      </div>
    );
  return (
    <aside className={`panel left ${open ? '' : 'collapsed'}`}>
      <nav className="left-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`left-tab ${open && tab === t.id ? 'active' : ''}`}
            title={open && tab === t.id ? 'Clic otra vez para ocultar el panel' : t.label}
            onClick={() => {
              // clicking the open tab again hides the panel, to give the preview more room
              if (open && tab === t.id) setLayout({ leftOpen: false });
              else {
                setTab(t.id);
                setLayout({ leftOpen: true });
              }
            }}
          >
            <t.icon size={20} />
            {t.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="left-tab" title={open ? 'Ocultar panel' : 'Mostrar panel'} onClick={() => setLayout({ leftOpen: !open })}>
          {open ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
        </button>
      </nav>
      <div className="left-content" hidden={!open}>
        {tab === 'media' && <MediaPanel />}
        {tab === 'audio' && <AudioPanel />}
        {tab === 'text' && <TextPanel />}
        {tab === 'stickers' && <StickersPanel />}
        {tab === 'captions' && <CaptionsPanel />}
      </div>
    </aside>
  );
}
