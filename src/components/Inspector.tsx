import { useEffect, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Bold, Combine, Italic, Move, PanelRightClose, Scissors, Type } from 'lucide-react';
import { setEditingInInspector, setLinkedEdit, useEditor } from '../store/editor';
import type { MediaClip, TextClip, TextStyle } from '../types';
import { isMediaClip } from '../types';
import { FONTS } from './TextPanel';
import { useLayout } from '../store/layout';
import MediaInspector from './MediaInspector';
import Range from './Range';

function Slider(props: { label: string; value: number; min: number; max: number; step?: number; format?: (v: number) => string; onChange: (v: number) => void; onCommit: () => void }) {
  const { label, value, min, max, step = 1, format = (v) => String(Math.round(v)), onChange, onCommit } = props;
  return (
    <div className="field">
      <label>
        {label} <b>{format(value)}</b>
      </label>
      <Range min={min} max={max} step={step} value={value} onPointerDown={onCommit} onKeyDown={onCommit} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="section">
      <h4>
        {icon} {title}
      </h4>
      {children}
    </div>
  );
}

function TextInspector({ clip }: { clip: TextClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const checkpoint = useEditor((s) => s.checkpoint);
  const st = (patch: Partial<TextStyle>, commit = false) => updateClip(clip.id, { style: { ...clip.style, ...patch } }, commit);

  return (
    <>
      {clip.caption && <p className="hint">Subtítulo automático: los cambios de estilo se aplican a todos los subtítulos.</p>}
      <div className="field">
        <textarea className="input" value={clip.text} onFocus={checkpoint} onChange={(e) => updateClip(clip.id, { text: e.target.value }, false)} />
      </div>
      <Section title="Fuente" icon={<Type size={13} />}>
        <div className="field">
          <select className="input" style={{ width: '100%', fontFamily: clip.style.fontFamily }} value={clip.style.fontFamily} onChange={(e) => st({ fontFamily: e.target.value }, true)}>
            {FONTS.map((f) => (
              <option key={f} value={f} style={{ fontFamily: f }}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="row field" style={{ gap: 4 }}>
          <button className={`icon-btn ${clip.style.bold ? 'active' : ''}`} title="Negrita" onClick={() => st({ bold: !clip.style.bold }, true)}>
            <Bold size={16} />
          </button>
          <button className={`icon-btn ${clip.style.italic ? 'active' : ''}`} title="Cursiva" onClick={() => st({ italic: !clip.style.italic }, true)}>
            <Italic size={16} />
          </button>
          <button className={`icon-btn ${clip.style.uppercase ? 'active' : ''}`} title="Mayúsculas" onClick={() => st({ uppercase: !clip.style.uppercase }, true)}>
            AA
          </button>
          <button className={`icon-btn ${clip.style.shadow ? 'active' : ''}`} title="Sombra" onClick={() => st({ shadow: !clip.style.shadow }, true)}>
            S
          </button>
        </div>
        <Slider label="Tamaño" value={clip.style.fontSize * 1000} min={15} max={250} onCommit={checkpoint} onChange={(v) => st({ fontSize: v / 1000 })} />
        <div className="row">
          <div className="field">
            <label>Color</label>
            <input type="color" value={clip.style.color} onFocus={checkpoint} onChange={(e) => st({ color: e.target.value })} />
          </div>
          <div className="field">
            <label>Borde</label>
            <input type="color" value={clip.style.strokeColor} onFocus={checkpoint} onChange={(e) => st({ strokeColor: e.target.value })} />
          </div>
        </div>
        <Slider label="Grosor del borde" value={clip.style.strokeWidth * 100} min={0} max={40} onCommit={checkpoint} onChange={(v) => st({ strokeWidth: v / 100 })} />
        <div className="field">
          <label>Fondo</label>
          <div className="row">
            <input type="color" value={clip.style.background && clip.style.background.startsWith('#') ? clip.style.background : '#000000'} onFocus={checkpoint} onChange={(e) => st({ background: e.target.value })} />
            <button className="btn small" onClick={() => st({ background: '' }, true)}>
              Sin fondo
            </button>
          </div>
        </div>
      </Section>
      <Section title="Posición y animación" icon={<Move size={13} />}>
        <div className="row">
          <Slider label="X" value={clip.style.x * 100} min={0} max={100} onCommit={checkpoint} onChange={(v) => st({ x: v / 100 })} />
          <Slider label="Y" value={clip.style.y * 100} min={0} max={100} onCommit={checkpoint} onChange={(v) => st({ y: v / 100 })} />
        </div>
        <div className="field">
          <label>Animación de entrada</label>
          <div className="chips">
            {(
              [
                ['none', 'Ninguna'],
                ['pop', 'Pop'],
                ['fade', 'Fundido'],
                ['slide', 'Deslizar'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={`chip ${clip.animation === id ? 'active' : ''}`} onClick={() => updateClip(clip.id, { animation: id })}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </Section>
    </>
  );
}

export default function Inspector() {
  const selectedIds = useEditor((s) => s.selectedIds);
  const single = useEditor((s) => (s.selectedIds.length === 1 ? s.clips.find((c) => c.id === s.selectedIds[0]) : undefined));
  // several clips: edit them together (the first one's values are shown; changes go to all)
  const mediaIds = useEditor(useShallow((s) => (s.selectedIds.length > 1 ? s.selectedIds.filter((id) => s.clips.some((c) => c.id === id && isMediaClip(c))) : [])));
  const primary = useEditor((s) => (mediaIds.length > 1 ? (s.clips.find((c) => c.id === mediaIds[0]) as MediaClip | undefined) : undefined));
  useEffect(() => {
    setLinkedEdit(mediaIds.length > 1 ? mediaIds : null);
    return () => setLinkedEdit(null);
  }, [mediaIds]);
  // only edits made in this panel are applied to all the selected clips
  useEffect(() => {
    const h = (e: Event) => setEditingInInspector(!!(e.target as HTMLElement | null)?.closest?.('.panel.right, .sheet'));
    window.addEventListener('pointerdown', h, true);
    window.addEventListener('focusin', h, true);
    return () => {
      window.removeEventListener('pointerdown', h, true);
      window.removeEventListener('focusin', h, true);
    };
  }, []);
  const clip = single ?? primary;
  const mediaName = useEditor((s) => (clip && isMediaClip(clip) && clip.mediaId ? s.media.find((m) => m.id === clip.mediaId)?.name : undefined));
  // the tabs below already say "Vídeo / Audio…": the header shows which clip it is
  const kind = primary ? '' : clip ? (isMediaClip(clip) ? (clip.type === 'audio' ? 'Audio' : clip.type === 'image' ? 'Imagen' : clip.type === 'compound' ? '' : 'Vídeo') : 'Texto') : '';
  const title = primary
    ? `${mediaIds.length} clips a la vez`
    : clip
      ? clip.type === 'text'
        ? 'Texto'
        : clip.type === 'compound'
          ? 'Clip combinado'
          : (mediaName ?? 'Clip').replace(/\.[a-z0-9]{2,4}$/i, '')
      : 'Propiedades';

  return (
    <aside className="panel right">
      <div className="panel-title">
        <span className="title-main" title={title} translate={clip && isMediaClip(clip) && !primary && clip.type !== 'compound' ? 'no' : undefined}>
          {title}
        </span>
        {kind && clip?.type !== 'text' && <span className="title-sub">{kind}</span>}
        <span className="spacer" />
        <button className="icon-btn sm" title="Ocultar propiedades (más espacio para el visor)" onClick={() => useLayout.getState().set(useLayout.getState().sheet ? { sheet: null } : { rightOpen: false })}>
          <PanelRightClose size={15} />
        </button>
      </div>
      {clip && isMediaClip(clip) && <MediaInspector key={primary ? `multi-${mediaIds.join()}` : clip.id} clip={clip} multi={primary ? mediaIds.length : undefined} />}
      <div className="panel-body" hidden={!!clip && isMediaClip(clip)}>
        {!clip && (
          <div className="empty-inspector">
            <Scissors size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
            <div>{selectedIds.length > 1 ? `${selectedIds.length} clips seleccionados` : 'Selecciona un clip para editarlo'}</div>
            {selectedIds.length > 1 && (
              <button className="btn small" style={{ marginTop: 12 }} onClick={() => useEditor.getState().createCompound()}>
                <Combine size={13} /> Crear clip combinado
              </button>
            )}
            <div className="hint" style={{ marginTop: 16, textAlign: 'left' }}>
              <b>Atajos</b>
              <br />
              Espacio — reproducir / pausa
              <br />S o ⌘B — cortar en el cursor
              <br />⌘C / ⌘V — copiar / pegar
              <br />⌘D — duplicar
              <br />⌫ — borrar
              <br />⌘Z / ⇧⌘Z — deshacer / rehacer
              <br />← → — fotograma a fotograma (⇧ = 1 s)
              <br />+ / − — zoom de la línea de tiempo
              <br />⌥G — crear clip combinado
              <br />M — quitar / activar audio
              <br />Clic derecho en un clip — más opciones
              <br />Arrastrar en un hueco — seleccionar con recuadro
              <br />Esquinas o ⌘+rueda en el visor — tamaño
              <br />K — fotograma clave de posición/tamaño en la aguja
              <br />Arrastrar en el visor mientras se reproduce — grabar movimiento
              <br />F — ampliar el visor (ocultar paneles)
              <br />⌥⌘C / ⌥⌘V — copiar / pegar atributos
              <br />Doble clic en un clip combinado — editar dentro
            </div>
          </div>
        )}
        {clip && !isMediaClip(clip) && <TextInspector key={clip.id} clip={clip} />}
      </div>
    </aside>
  );
}
