import { useRef, useState, type ReactNode } from 'react';
import {
  AudioLines, Captions, ChevronDown, ChevronLeft, Copy, Diamond, Download, Eraser, Film, Gauge, Layers, Maximize2, Minimize2, Move, Music,
  Pause, Pencil, Play, Redo2, Rewind, Scissors, SlidersHorizontal, Snowflake, Sparkles, Sticker, Trash2, Type, Undo2, Volume2, X,
  CircleDashed, RectangleHorizontal,
} from 'lucide-react';
import { MAIN_TRACK, projectDuration, useEditor } from '../store/editor';
import { useLayout, type LeftTab } from '../store/layout';
import { player } from '../lib/player';
import { importFiles } from '../lib/importFiles';
import { newProject, openProject } from '../lib/project';
import { freezeFrame, reverseClip } from '../lib/clipTools';
import { hasKeyAt, srcTime, TRANSFORM_KEYS } from '../lib/keyframes';
import { markFormatChosen, originalSize } from '../lib/autoFormat';
import { clipHasAudio } from '../lib/timeline';
import { isMediaClip, type MediaClip } from '../types';
import Preview from '../components/Preview';
import ProjectBar from '../components/ProjectBar';
import LeftPanel from '../components/LeftPanel';
import Inspector from '../components/Inspector';
import MediaInspector, { type MainTab, type VideoTab } from '../components/MediaInspector';
import { FORMATS } from '../components/TopBar';
import MobileTimeline from './MobileTimeline';
import MobileHome from './MobileHome';
import './mobile.css';

/**
 * The phone editor (Android app and narrow screens). Same engine as the desktop app, laid out the way
 * mobile editors work: preview on top, a timeline with the playhead in the middle, and a bottom bar
 * whose tools change with what's selected. Each tool opens its panel as a sheet.
 */

type Sheet =
  | { kind: 'left'; tab: LeftTab; title: string }
  | { kind: 'clip'; only: MainTab; sub?: VideoTab; title: string }
  | { kind: 'text'; title: string }
  | { kind: 'format'; title: string };

type Tool = { id: string; label: string; icon: ReactNode; run: () => void; disabled?: boolean };

const pick = (input: HTMLInputElement | null) => {
  if (!input) return;
  input.value = '';
  input.click();
};

export default function MobileApp({ dialogs }: { dialogs: ReactNode }) {
  const [home, setHome] = useState(true);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [full, setFull] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickMode = useRef<'new' | 'end' | 'overlay'>('end');

  const st = useEditor.getState();
  const sel = useEditor((s) => (s.selectedIds.length === 1 ? s.clips.find((c) => c.id === s.selectedIds[0]) : undefined));
  const playing = useEditor((s) => s.playing);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const time = useEditor((s) => s.time);
  const settings = useEditor((s) => s.settings);
  const hasAudio = useEditor((s) => (sel && isMediaClip(sel) ? clipHasAudio(sel, s.media) : false));
  useEditor((s) => s.clips); // original size depends on the first clip

  /* ---- adding files ---- */
  const onFiles = async (files: File[]) => {
    if (!files.length) return;
    const mode = pickMode.current;
    if (mode === 'new') {
      await newProject();
      setHome(false);
      await importFiles(files, { trackId: MAIN_TRACK, start: 0 });
      useEditor.getState().select([]); // land on the general tools, at the start
      player.seek(0);
      return;
    }
    const s = useEditor.getState();
    if (mode === 'end') {
      await importFiles(files, { trackId: MAIN_TRACK, start: projectDuration(s.clips.filter((c) => c.trackId === MAIN_TRACK)) });
      useEditor.getState().select([]);
      return;
    }
    // overlay ("superposición"): on top of the video, from the playhead
    const ids = await importFiles(files);
    if (ids.length) useEditor.getState().addMediaClips(ids, { overlay: true, start: s.time });
  };
  const add = (mode: 'new' | 'end' | 'overlay') => {
    pickMode.current = mode;
    pick(fileInput.current);
  };

  const openLeft = (tab: LeftTab, title: string) => {
    useLayout.getState().set({ leftTab: tab });
    setSheet({ kind: 'left', tab, title });
  };

  /* ---- tools ---- */
  const media = sel && isMediaClip(sel) ? (sel as MediaClip) : undefined;
  const visual = media && media.type !== 'audio';
  const inside = !!sel && time >= sel.start && time < sel.start + sel.duration;
  const clipTool = (only: MainTab, title: string, sub?: VideoTab) => () => setSheet({ kind: 'clip', only, sub, title });

  const rootTools: Tool[] = [
    {
      id: 'edit',
      label: 'Editar',
      icon: <Scissors size={22} />,
      run: () => {
        const s = useEditor.getState();
        const under = s.clips.find((c) => c.trackId === MAIN_TRACK && s.time >= c.start && s.time < c.start + c.duration) ?? s.clips.find((c) => c.trackId === MAIN_TRACK);
        if (under) s.select([under.id]);
      },
    },
    { id: 'audio', label: 'Audio', icon: <Music size={22} />, run: () => openLeft('audio', 'Audio') },
    { id: 'text', label: 'Texto', icon: <Type size={22} />, run: () => openLeft('text', 'Texto') },
    { id: 'overlay', label: 'Superposición', icon: <Layers size={22} />, run: () => add('overlay') },
    { id: 'stickers', label: 'Stickers', icon: <Sticker size={22} />, run: () => openLeft('stickers', 'Stickers') },
    { id: 'captions', label: 'Subtítulos', icon: <Captions size={22} />, run: () => openLeft('captions', 'Subtítulos') },
    { id: 'format', label: 'Formato', icon: <RectangleHorizontal size={22} />, run: () => setSheet({ kind: 'format', title: 'Formato' }) },
    { id: 'media', label: 'Multimedia', icon: <Film size={22} />, run: () => openLeft('media', 'Multimedia') },
  ];

  const common: Tool[] = [
    { id: 'split', label: 'Dividir', icon: <Scissors size={22} />, run: () => st.splitAtPlayhead(), disabled: !inside },
    { id: 'dup', label: 'Duplicar', icon: <Copy size={22} />, run: () => st.duplicateSelected() },
    { id: 'del', label: 'Eliminar', icon: <Trash2 size={22} />, run: () => st.deleteSelected() },
  ];
  const clipTools: Tool[] = !sel
    ? []
    : sel.type === 'text'
      ? [{ id: 'edit-text', label: 'Editar', icon: <Pencil size={22} />, run: () => setSheet({ kind: 'text', title: 'Texto' }) }, ...common]
      : [
          common[0],
          ...(visual ? [{ id: 'basic', label: 'Transformar', icon: <Move size={22} />, run: clipTool('video', 'Transformar', 'basic') }] : []),
          ...(media?.type !== 'image' ? [{ id: 'speed', label: 'Velocidad', icon: <Gauge size={22} />, run: clipTool('speed', 'Velocidad') }] : []),
          ...(hasAudio || media?.type === 'audio' ? [{ id: 'vol', label: 'Volumen', icon: <Volume2 size={22} />, run: clipTool('audio', 'Audio') }] : []),
          ...(visual
            ? [
                { id: 'anim', label: 'Animación', icon: <Sparkles size={22} />, run: clipTool('anim', 'Animación') },
                { id: 'adjust', label: 'Ajustar', icon: <SlidersHorizontal size={22} />, run: clipTool('adjust', 'Ajustar') },
                { id: 'bg', label: 'Quitar fondo', icon: <Eraser size={22} />, run: clipTool('video', 'Quitar fondo', 'bg') },
                { id: 'mask', label: 'Máscara', icon: <CircleDashed size={22} />, run: clipTool('video', 'Máscara', 'mask') },
              ]
            : []),
          ...(media?.type === 'video'
            ? [
                { id: 'freeze', label: 'Congelar', icon: <Snowflake size={22} />, run: () => void freezeFrame(), disabled: !inside },
                { id: 'reverse', label: 'Revertir', icon: <Rewind size={22} />, run: () => void reverseClip(sel.id) },
              ]
            : []),
          ...(hasAudio && media?.type !== 'audio' ? [{ id: 'extract', label: 'Extraer audio', icon: <AudioLines size={22} />, run: () => st.extractAudio([sel.id]) }] : []),
          common[1],
          common[2],
        ];

  /* ---- keyframe button (position / size / rotation of the selected clip at the playhead) ---- */
  const keyOn = !!media && inside && TRANSFORM_KEYS.every((p) => hasKeyAt(media, p, srcTime(media, time)));

  /* ---- format ---- */
  const orig = originalSize();
  const isOrig = !!orig && orig.width === settings.width && orig.height === settings.height;
  const formatLabel = isOrig ? 'Original' : (FORMATS.find((f) => f.w === settings.width && f.h === settings.height)?.label.split(' · ')[0] ?? `${settings.width}×${settings.height}`);

  if (home)
    return (
      <div className="m-app home">
        <MobileHome
          onNew={() => add('new')}
          onOpen={async (id) => {
            await openProject(id);
            setHome(false);
          }}
        />
        <input ref={fileInput} type="file" multiple accept="video/*,image/*,audio/*" hidden onChange={(e) => void onFiles(Array.from(e.target.files ?? []))} />
        {dialogs}
      </div>
    );

  return (
    <div className={`m-app ${full ? 'full' : ''}`}>
      <header className="m-top">
        <button className="icon-btn" title="Volver a tus proyectos" onClick={() => (player.pause(), setHome(true), setSheet(null))}>
          <X size={22} />
        </button>
        <span className="spacer" />
        <button className="m-chip" onClick={() => setSheet({ kind: 'format', title: 'Formato' })}>
          {formatLabel} <ChevronDown size={14} />
        </button>
        <button className="btn primary m-export" onClick={() => st.requestExport({})} disabled={!useEditor.getState().clips.length}>
          <Download size={16} /> Exportar
        </button>
      </header>
      <ProjectBar />
      <div className="m-preview">
        <Preview bare />
      </div>
      <div className="m-controls">
        <button className="icon-btn" title={full ? 'Salir de pantalla completa' : 'Pantalla completa'} onClick={() => setFull(!full)}>
          {full ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
        </button>
        <span className="spacer" />
        <button className="m-play" title="Reproducir / pausa" onClick={() => player.toggle()}>
          {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
        </button>
        <span className="spacer" />
        <button className={`icon-btn ${keyOn ? 'active' : ''}`} title="Fotograma clave (posición, tamaño y giro)" disabled={!media || !inside} onClick={() => media && st.toggleKeys(media.id, TRANSFORM_KEYS)}>
          <Diamond size={19} fill={keyOn ? 'currentColor' : 'none'} />
        </button>
        <button className="icon-btn" title="Deshacer" disabled={!canUndo} onClick={() => st.undo()}>
          <Undo2 size={20} />
        </button>
        <button className="icon-btn" title="Rehacer" disabled={!canRedo} onClick={() => st.redo()}>
          <Redo2 size={20} />
        </button>
      </div>
      <MobileTimeline onAdd={() => add('end')} onAddAudio={() => openLeft('audio', 'Audio')} onAddText={() => openLeft('text', 'Texto')} />
      <nav className="m-tools">
        {sel ? (
          <>
            <button className="m-back" title="Volver" onClick={() => (st.select([]), setSheet(null))}>
              <ChevronLeft size={24} />
            </button>
            {clipTools.map((t) => (
              <button key={t.id} className="m-tool" data-tool={t.id} disabled={t.disabled} onClick={t.run}>
                {t.icon}
                <span>{t.label}</span>
              </button>
            ))}
          </>
        ) : (
          rootTools.map((t) => (
            <button key={t.id} className="m-tool" data-tool={t.id} onClick={t.run}>
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))
        )}
      </nav>

      {sheet && (
        <div className="m-sheet">
          <div className="m-sheet-head">
            <b>{sheet.title}</b>
            <span className="spacer" />
            <button className="icon-btn" title="Cerrar" onClick={() => setSheet(null)}>
              <ChevronDown size={22} />
            </button>
          </div>
          <div className="m-sheet-body">
            {sheet.kind === 'left' && <LeftPanel sheet />}
            {sheet.kind === 'clip' && (media ? <MediaInspector key={`${media.id}-${sheet.only}-${sheet.sub}`} clip={media} only={sheet.only} videoSub={sheet.sub} /> : <p className="hint">Selecciona un clip.</p>)}
            {sheet.kind === 'text' && <Inspector />}
            {sheet.kind === 'format' && (
              <div className="m-formats">
                {orig && (
                  <button className={isOrig ? 'active' : ''} onClick={() => (markFormatChosen(), st.setSettings({ width: orig.width, height: orig.height }))}>
                    <b>Original</b>
                    <span className="hint">
                      {orig.width}×{orig.height}
                    </span>
                  </button>
                )}
                {FORMATS.map((f) => (
                  <button key={f.label} className={!isOrig && f.w === settings.width && f.h === settings.height ? 'active' : ''} onClick={() => (markFormatChosen(), st.setSettings({ width: f.w, height: f.h }))}>
                    <b>{f.label.split(' · ')[0]}</b>
                    <span className="hint">{f.label.split(' · ').slice(1).join(' · ')}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {/* tools that add files keep this hidden picker */}
      <input ref={fileInput} type="file" multiple accept="video/*,image/*,audio/*" hidden onChange={(e) => void onFiles(Array.from(e.target.files ?? []))} />
      {dialogs}
    </div>
  );
}
