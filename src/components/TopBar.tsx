import { Coffee, Download, Globe, Redo2, Undo2 } from 'lucide-react';
import { openLanguagePicker } from './LanguagePicker';
import { useLang } from '../i18n';
import { useCompact } from '../store/layout';
import { openAbout } from './AboutDialog';
import { useEditor } from '../store/editor';
import { markFormatChosen, originalSize } from '../lib/autoFormat';

export const FORMATS = [
  { label: '16:9 · YouTube', w: 1920, h: 1080 },
  { label: '9:16 · TikTok / Reels / Shorts', w: 1080, h: 1920 },
  { label: '1:1 · Instagram', w: 1080, h: 1080 },
  { label: '4:5 · Instagram feed', w: 1080, h: 1350 },
];

export default function TopBar({ onExport }: { onExport: () => void }) {
  const lang = useLang();
  const compact = useCompact(); // phone: short format names so the bar fits
  const settings = useEditor((s) => s.settings);
  const setSettings = useEditor((s) => s.setSettings);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const hasClips = useEditor((s) => s.clips.length > 0);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  useEditor((s) => s.clips); // the original size depends on the first video
  const orig = originalSize();
  const isOrig = !!orig && orig.width === settings.width && orig.height === settings.height;
  const preset = FORMATS.findIndex((f) => f.w === settings.width && f.h === settings.height);
  const current = isOrig ? -2 : preset;

  return (
    <header className="topbar">
      <div className="logo">
        <div className="logo-dot">◆</div> Leo
      </div>
      <div className="row" style={{ flex: 'none', gap: 2, marginLeft: 12 }}>
        <button className="icon-btn" title="Deshacer (⌘Z)" disabled={!canUndo} onClick={undo}>
          <Undo2 size={17} />
        </button>
        <button className="icon-btn" title="Rehacer (⇧⌘Z)" disabled={!canRedo} onClick={redo}>
          <Redo2 size={17} />
        </button>
      </div>
      <div className="spacer" />
      <button className="icon-btn lang-btn" title="Idioma · Language" onClick={() => openLanguagePicker()}>
        <Globe size={16} />
        <span translate="no">{lang.toUpperCase()}</span>
      </button>
      <span className="hint">Formato</span>
      <select
        className="input"
        value={current}
        onChange={(e) => {
          markFormatChosen();
          const v = Number(e.target.value);
          if (v === -2 && orig) return setSettings({ width: orig.width, height: orig.height });
          const f = FORMATS[v];
          if (f) setSettings({ width: f.w, height: f.h });
        }}
      >
        {orig && <option value={-2}>{compact ? 'Original' : `Original del vídeo · ${orig.width}×${orig.height}`}</option>}
        {current === -1 && <option value={-1}>{compact ? `${settings.width}×${settings.height}` : `Personalizado · ${settings.width}×${settings.height}`}</option>}
        {FORMATS.map((f, i) => (
          <option key={f.label} value={i}>
            {compact ? f.label.split(' · ')[0] : f.label}
          </option>
        ))}
      </select>
      <button className="coffee-btn" title="Leo es gratis. Si te ayuda, invítame a un café" onClick={() => openAbout()}>
        <Coffee size={15} />
        <span>Invítame a un café</span>
      </button>
      <button className="btn primary" onClick={onExport} disabled={!hasClips}>
        <Download size={16} /> Exportar
      </button>
    </header>
  );
}
