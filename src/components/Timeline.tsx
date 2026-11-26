import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  MoreHorizontal,
  Plus,
  Rewind,
  Snowflake,
  ArrowLeft,
  ChevronRight,
  ClipboardCopy,
  Diamond,
  FolderInput,
  Paintbrush,
  ClipboardPaste, Combine, Copy, Download, Eye, EyeOff, Film, Magnet, Maximize2, MicOff, Music, Redo2, Scissors, Sparkles, SquareSplitHorizontal,
  Trash2, Type, Undo2, Ungroup, Volume2, VolumeX, ZoomIn, ZoomOut, AudioLines, MousePointerSquareDashed,
} from 'lucide-react';
import { MAIN_TRACK, MAX_ZOOM, MIN_CLIP, MIN_ZOOM, projectDuration, useEditor } from '../store/editor';
import { clipHasAudio, isAudioKind, sourceDuration } from '../lib/timeline';
import ContextMenu, { type MenuItem, type MenuState } from './ContextMenu';
import type { Clip, MediaClip, MediaItem, Track } from '../types';
import { animated, liveKeys, srcTime, timelineTime, valueAt, visibleKeyTimes } from '../lib/keyframes';
import { isMediaClip } from '../types';
import { player } from '../lib/player';
import { formatTime } from '../lib/util';
import { importFiles } from '../lib/importFiles';
import { MEDIA_DRAG_TYPE } from './MediaPanel';
import { openPasteAttributes } from './PasteAttributes';
import { freezeFrame, reverseClip } from '../lib/clipTools';
import { LIBRARY_DRAG_TYPE, addFromLibrary, type LibraryDragPayload } from '../lib/library';
import Range from './Range';
import { useFxStatus } from '../ai/voice';

const RULER_H = 26;
const PAD = 12;
const SNAP_PX = 8;
const trackHeight = (t: Track) => (t.id === MAIN_TRACK ? 68 : t.kind === 'video' ? 56 : t.kind === 'audio' ? 46 : 30);
const accepts = (t: Track, c: Clip | { type: string }) =>
  ('trackId' in c ? isAudioKind(c) : c.type === 'audio') ? t.kind === 'audio' : c.type === 'text' ? t.kind === 'text' : t.kind === 'video';
const zoomToSlider = (z: number) => (Math.log(z / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)) * 100;
const sliderToZoom = (v: number) => MIN_ZOOM * Math.pow(MAX_ZOOM / MIN_ZOOM, v / 100);

function useRows(tracks: Track[]) {
  return useMemo(() => {
    let top = RULER_H;
    return tracks.map((track) => {
      const h = trackHeight(track);
      const row = { track, top, h };
      top += h;
      return row;
    });
  }, [tracks]);
}

/* ---------------- clip view ---------------- */

const Waveform = memo(function Waveform({ peaks, from, to, width, height, gain }: { peaks: number[]; from: number; to: number; width: number; height: number; gain: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const w = Math.max(1, Math.min(4000, Math.round(width)));
    c.width = w;
    c.height = height;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, height);
    ctx.fillStyle = 'rgba(190, 255, 214, 0.55)';
    const n = peaks.length;
    for (let x = 0; x < w; x++) {
      const p = from + ((to - from) * x) / w;
      const v = peaks[Math.min(n - 1, Math.max(0, Math.floor(p * n)))] ?? 0;
      const bh = Math.max(1, Math.min(height, v * gain * height * 0.85));
      ctx.fillRect(x, height - bh, 1, bh);
    }
  }, [peaks, from, to, width, height, gain]);
  return <canvas ref={ref} className="wave" />;
});

const ClipView = memo(function ClipView(props: {
  clip: Clip;
  media?: MediaItem;
  zoom: number;
  height: number;
  selected: boolean;
  dragging: boolean;
  hasAudio: boolean;
  onPointerDown: (e: React.PointerEvent, clip: Clip, mode: 'move' | 'l' | 'r') => void;
  onVolumePointerDown: (e: React.PointerEvent, clip: Clip) => void;
  onContextMenu: (e: React.MouseEvent, clip: Clip) => void;
  onKeyMenu: (e: React.MouseEvent, clip: MediaClip, t: number) => void;
}) {
  const { clip, media, zoom, height, selected, dragging, hasAudio, onPointerDown, onVolumePointerDown, onContextMenu, onKeyMenu } = props;
  const width = Math.max(2, clip.duration * zoom);
  const isMedia = isMediaClip(clip);
  const cls = ['tl-clip', clip.type, clip.type === 'text' && clip.caption ? 'caption' : '', selected ? 'selected' : '', dragging ? 'dragging' : ''].join(' ');

  let thumbs: React.ReactNode = null;
  if (isMedia && media && media.thumbnails.length && clip.type !== 'audio') {
    const th = height - 6;
    const tw = Math.max(20, th * (media.width && media.height ? media.width / media.height : 16 / 9));
    const count = Math.min(200, Math.ceil(width / tw));
    const imgs = [];
    for (let i = 0; i < count; i++) {
      const srcT = clip.trimStart + ((i * tw) / zoom) * clip.speed;
      const idx = clip.type === 'image' ? 0 : Math.min(media.thumbnails.length - 1, Math.floor((srcT / media.duration) * media.thumbnails.length));
      imgs.push(<img key={i} src={media.thumbnails[idx]} style={{ width: tw }} alt="" />);
    }
    thumbs = <div className="thumbs">{imgs}</div>;
  }

  const showWave = isMedia && media?.waveform && (clip.type === 'audio' || clip.type === 'video');
  const audioKind = isMedia && isAudioKind(clip);
  const waveH = audioKind ? '75%' : '35%';
  // volume line (0 % at the bottom, 100 % in the middle, 200 % at the top), draggable up/down
  const volKeys = isMedia ? liveKeys(clip, 'volume') : undefined;
  const showVolume = isMedia && hasAudio && !clip.muted;
  const fx: string[] = [];
  if (isMedia) {
    if (clip.speed !== 1) fx.push(`${clip.speed}x`);
    if (clip.removeBg) fx.push('Sin fondo');
    if (clip.stab?.on && clip.stab.data) fx.push('Estabilizado');
    if (clip.reversedFrom) fx.push('Revertido');
    if (clip.crop) fx.push('Recortado');
    if (clip.muted || clip.volume === 0) fx.push('🔇 Sin audio');
    if (clip.audioFx === 'isolate') fx.push('Voz aislada');
    if (clip.audioFx === 'remove-voice') fx.push('Sin voz');
  }
  const name = clip.type === 'text' ? clip.text : clip.type === 'compound' ? `Clip combinado · ${clip.compound?.clips.length ?? 0} clips` : media?.name;
  // "Voz aislada 42 %" while the AI works on it
  const vfx = useFxStatus(isMedia ? clip.mediaId : undefined, isMedia ? clip.audioFx : undefined);
  const vfxPct = vfx?.status === 'processing' ? Math.round(vfx.progress * 100) : null;

  return (
    <div className={cls} style={{ left: PAD + clip.start * zoom, width }} onPointerDown={(e) => onPointerDown(e, clip, 'move')}
      onContextMenu={(e) => onContextMenu(e, clip)}
      onDoubleClick={() => clip.type === 'compound' && useEditor.getState().enterCompound(clip.id)}
      title={clip.type === 'compound' ? 'Doble clic para entrar y editar su contenido' : undefined}
    >
      {thumbs}
      {showWave && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: waveH, background: clip.type === 'video' ? 'rgba(0,0,0,0.35)' : undefined }}>
          <Waveform
            peaks={media!.waveform!}
            from={clip.trimStart / media!.duration}
            to={(clip.trimStart + clip.duration * clip.speed) / media!.duration}
            width={width}
            height={clip.type === 'audio' ? 32 : 18}
            gain={clip.muted ? 0 : clip.volume}
          />
        </div>
      )}
      {showVolume && volKeys?.length ? (
        <div className="vol-area" style={{ height: waveH }} title="Volumen animado con fotogramas clave (edítalo en Audio)">
          <svg width={width} height="100%" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
            <polyline
              fill="none"
              stroke="#fde047"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              points={[clip.trimStart, ...volKeys.map((k) => k.t), clip.trimStart + clip.duration * clip.speed]
                .map((t) => {
                  const x = Math.min(width, Math.max(0, ((t - clip.trimStart) / clip.speed) * zoom));
                  const v = valueAt(clip, 'volume', timelineTime(clip, t));
                  return `${x},${(1 - Math.min(2, v) / 2) * 100}`;
                })
                .join(' ')}
            />
          </svg>
        </div>
      ) : showVolume && (
        <div className="vol-area" style={{ height: waveH }}>
          <div
            className="vol-line"
            style={{ top: `${(1 - Math.min(2, clip.volume) / 2) * 100}%` }}
            title={`Volumen ${Math.round(clip.volume * 100)} % — arrastra arriba/abajo (doble clic = 100 %)`}
            onPointerDown={(e) => onVolumePointerDown(e, clip)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              useEditor.getState().updateClip(clip.id, { volume: 1 }); // back to 100 %
            }}
          />
        </div>
      )}
      <div className={`label ${clip.type === 'text' ? '' : 'top'}`}>
        <span translate="no">{name}</span>
        {fx.map((f) => (
          <span key={f} className="fx">
            {f}
            {vfxPct !== null && (f === 'Voz aislada' || f === 'Sin voz') && <b className="fx-pct"> {vfxPct} %</b>}
          </span>
        ))}
      </div>
      {vfxPct !== null && (
        <div className="clip-fx-progress" title="Procesando el audio con IA…">
          <div style={{ width: `${vfxPct}%` }} />
        </div>
      )}
      {isMedia && clip.keyframes ? <KeyMarks clip={clip} zoom={zoom} onMenu={onKeyMenu} /> : null}
      <div className="handle l" onPointerDown={(e) => onPointerDown(e, clip, 'l')} />
      <div className="handle r" onPointerDown={(e) => onPointerDown(e, clip, 'r')} />
    </div>
  );
});

/** Keyframes of a clip as little diamonds: click = go there, drag = move it, right click = delete. */
function KeyMarks({ clip, zoom, onMenu }: { clip: MediaClip; zoom: number; onMenu: (e: React.MouseEvent, clip: MediaClip, t: number) => void }) {
  const marks: React.ReactNode[] = [];
  const times = visibleKeyTimes(clip);
  // recorded movements have many keys: draw them smaller and skip the ones that would overlap
  const xs = times.map((t) => (timelineTime(clip, t) - clip.start) * zoom);
  const dense = xs.length > 1 && (xs[xs.length - 1] - xs[0]) / (xs.length - 1) < 12;
  let lastX = -Infinity;
  times.forEach((t, i) => {
    const x = xs[i];
    if (x - lastX < (dense ? 4 : 6)) return;
    lastX = x;
    marks.push(
      <div
        key={t}
        className={`kf ${dense ? 'dense' : ''}`}
        style={{ left: x }}
        title="Fotograma clave — clic: ir · arrastrar: mover · clic derecho: borrar"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onMenu(e, clip, t);
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          if (e.button !== 0) return;
          const st = useEditor.getState();
          st.select([clip.id]);
          st.setFocusArea('timeline');
          player.seek(timelineTime(clip, t) + 1e-4);
          const x0 = e.clientX;
          let from = t;
          let moved = false;
          const lo = clip.trimStart;
          const hi = clip.trimStart + clip.duration * clip.speed - 1e-3;
          const move = (ev: PointerEvent) => {
            if (!moved && Math.abs(ev.clientX - x0) < 3) return;
            if (!moved) useEditor.getState().checkpoint();
            moved = true;
            const cur = useEditor.getState().clips.find((c) => c.id === clip.id) as MediaClip | undefined;
            if (!cur) return;
            // snap to whole frames of the project
            const fps = useEditor.getState().settings.fps;
            let tl = timelineTime(cur, t) + (ev.clientX - x0) / zoom;
            tl = Math.round(tl * fps) / fps;
            const to = Math.min(hi, Math.max(lo, srcTime(cur, tl)));
            if (Math.abs(to - from) < 1e-6) return;
            useEditor.getState().moveKeys(clip.id, from, to, false);
            from = to;
            player.seek(timelineTime(cur, to) + 1e-4);
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />,
    );
  });
  return <>{marks}</>;
}

/* ---------------- ruler ---------------- */

function Ruler({ zoom, width, onPointerDown }: { zoom: number; width: number; onPointerDown: (e: React.PointerEvent) => void }) {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const step = steps.find((s) => s * zoom >= 80) ?? 7200;
  const minor = step * zoom >= 160 ? step / 5 : step / 2;
  const ticks = [];
  const end = width / zoom;
  for (let t = 0; t <= end; t += minor) {
    const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ticks.push(
      <div key={t.toFixed(3)} className={`tick ${isMajor ? '' : 'minor'}`} style={{ left: PAD + t * zoom }}>
        {isMajor ? (step < 1 ? `${formatTime(t)}.${Math.round((t % 1) * 10)}` : formatTime(t)) : ''}
      </div>,
    );
  }
  return (
    <div className="tl-ruler" style={{ width }} onPointerDown={onPointerDown}>
      {ticks}
    </div>
  );
}

/* ---------------- timeline ---------------- */

export default function Timeline() {
  const tracks = useEditor((s) => s.tracks);
  const clips = useEditor((s) => s.clips);
  const media = useEditor((s) => s.media);
  const zoom = useEditor((s) => s.zoom);
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const selectedIds = useEditor((s) => s.selectedIds);
  const canUndo = useEditor((s) => s.past.length > 0);
  const stack = useEditor((s) => s.compoundStack);
  const [newTrackHint, setNewTrackHint] = useState(false);
  const canRedo = useEditor((s) => s.future.length > 0);
  const { undo, redo, splitAtPlayhead, deleteSelected, duplicateSelected, setZoom, toggleTrack, select } = useEditor.getState();

  const scrollRef = useRef<HTMLDivElement>(null);
  const headsRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(800);
  const [snapOn, setSnapOn] = useState(true);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [volTip, setVolTip] = useState<{ x: number; y: number; v: number } | null>(null);

  const rows = useRows(tracks);
  const duration = projectDuration(clips);
  // while growing the first clip to the left it can go below 0 s: shift everything right to show it
  const lead = Math.max(0, -Math.min(0, ...clips.map((c) => c.start))) * zoom;
  const innerW = Math.max(viewW, PAD + lead + (duration + 30) * zoom);
  const innerH = (rows.at(-1)?.top ?? RULER_H) + (rows.at(-1)?.h ?? 0) + 60;
  const mediaById = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);

  useEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    // pinch / ctrl+wheel to zoom
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useEditor.getState();
      s.setZoom(s.zoom * Math.exp(-e.deltaY * 0.01));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', onWheel);
    };
  }, []);

  // keep playhead visible while playing
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = PAD + time * zoom;
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = x - 80;
  }, [time, playing, zoom]);

  const xToTime = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left + el.scrollLeft - PAD) / zoom);
  };
  const isAboveTracks = (clientY: number) => {
    const el = scrollRef.current!;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop;
    return y < (rows[0]?.top ?? RULER_H) + 4;
  };
  const yToRow = (clientY: number) => {
    const el = scrollRef.current!;
    const y = clientY - el.getBoundingClientRect().top + el.scrollTop;
    return rows.find((r) => y >= r.top && y < r.top + r.h);
  };

  /* ---- scrubbing ---- */
  const startScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // moving the playhead always pauses (and it stays paused where you drop it, like CapCut)
    if (useEditor.getState().playing) player.pause();
    player.beginScrub();
    player.seek(xToTime(e.clientX));
    const move = (ev: PointerEvent) => player.seek(xToTime(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      player.endScrub();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ---- click on empty space: move the playhead; click and drag: select clips with a box ---- */
  const startMarquee = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return; // on touch screens, dragging an empty area scrolls
    if (e.button !== 0) return;
    useEditor.getState().setFocusArea('timeline');
    const inner = e.currentTarget;
    const local = (ev: { clientX: number; clientY: number }) => {
      const r = inner.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };
    const p0 = local(e);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? useEditor.getState().selectedIds : [];
    const rowsNow = rows;
    let boxing = false;
    const move = (ev: PointerEvent) => {
      const p = local(ev);
      if (!boxing && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return;
      boxing = true;
      const x0 = Math.min(p0.x, p.x);
      const x1 = Math.max(p0.x, p.x);
      const y0 = Math.min(p0.y, p.y);
      const y1 = Math.max(p0.y, p.y);
      setMarquee({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      const st = useEditor.getState();
      const hit = st.clips
        .filter((c) => {
          const row = rowsNow.find((r) => r.track.id === c.trackId);
          if (!row) return false;
          const cx0 = PAD + c.start * st.zoom;
          const cx1 = cx0 + Math.max(2, c.duration * st.zoom);
          return cx0 < x1 && cx1 > x0 && row.top + 3 < y1 && row.top + row.h - 3 > y0;
        })
        .map((c) => c.id);
      const next = Array.from(new Set([...base, ...hit]));
      if (next.length !== st.selectedIds.length || next.some((id, i) => id !== st.selectedIds[i])) select(next);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setMarquee(null);
      if (!boxing) {
        if (!additive) select([]);
        player.seek(xToTime(ev.clientX));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ---- volume line ---- */
  const onVolumePointerDown = (e: React.PointerEvent, clip: Clip) => {
    e.stopPropagation();
    if (e.button !== 0 || !isMediaClip(clip)) return;
    const s = useEditor.getState();
    if (!s.selectedIds.includes(clip.id)) select([clip.id]);
    const y0 = e.clientY;
    const v0 = clip.volume;
    let moved = false;
    setVolTip({ x: e.clientX, y: e.clientY, v: v0 });
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - y0;
      if (!moved && Math.abs(dy) < 2) return;
      if (!moved) useEditor.getState().checkpoint();
      moved = true;
      // 1 px = 1 % (⇧ for fine control)
      let v = v0 - (dy / 100) * (ev.shiftKey ? 0.25 : 1);
      v = Math.min(2, Math.max(0, Math.round(v * 100) / 100));
      if (Math.abs(v - 1) < 0.03) v = 1;
      useEditor.getState().updateClip(clip.id, { volume: v }, false);
      setVolTip({ x: ev.clientX, y: ev.clientY, v });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setVolTip(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ---- clip drag / trim ---- */
  const onClipPointerDown = (e: React.PointerEvent, clip: Clip, mode: 'move' | 'l' | 'r') => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const s = useEditor.getState();
    s.setFocusArea('timeline');
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive) {
      select(s.selectedIds.includes(clip.id) ? s.selectedIds.filter((i) => i !== clip.id) : [...s.selectedIds, clip.id]);
      return;
    }
    if (!s.selectedIds.includes(clip.id) || mode !== 'move') select([clip.id]);
    const group = mode === 'move' && s.selectedIds.includes(clip.id) ? s.clips.filter((c) => s.selectedIds.includes(c.id)) : [clip];
    const orig = new Map(group.map((c) => [c.id, { ...c }]));
    const o = orig.get(clip.id)!;
    const x0 = e.clientX;
    const maxSrc = isMediaClip(clip) ? sourceDuration(clip, mediaById.get(clip.mediaId)) : Infinity;
    let moved = false;
    const others = s.clips.filter((c) => !orig.has(c.id));
    const snapPoints = [0, s.time, ...others.flatMap((c) => [c.start, c.start + c.duration])];
    let above = false;
    const snap = (t: number) => {
      if (!snapOn) return null;
      const th = SNAP_PX / zoom;
      let best: number | null = null;
      for (const p of snapPoints) if (Math.abs(p - t) < th && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
      return best;
    };

    const move = (ev: PointerEvent) => {
      let dt = (ev.clientX - x0) / zoom;
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) {
        useEditor.getState().checkpoint();
        setDragId(clip.id);
      }
      moved = true;
      let snapped: number | null = null;
      const st = useEditor.getState();

      if (mode === 'move') {
        const a = snap(o.start + dt);
        const b = snap(o.start + o.duration + dt);
        if (a !== null) dt = a - o.start;
        else if (b !== null) dt = b - o.start - o.duration;
        snapped = a ?? b;
        const minStart = Math.min(...group.map((c) => c.start));
        dt = Math.max(dt, -minStart);
        const row = yToRow(ev.clientY);
        // above the top track: a new track will be made there when you let go
        above = !row && isAboveTracks(ev.clientY);
        setNewTrackHint(above);
        const targetTrack = group.length === 1 && row && accepts(row.track, clip) ? row.track.id : null;
        useEditor.setState({
          clips: st.clips.map((c) => {
            const oc = orig.get(c.id);
            if (!oc) return c;
            return { ...c, start: oc.start + dt, trackId: targetTrack && c.id === clip.id ? targetTrack : c.trackId };
          }),
        });
      } else {
        const neighbours = others.filter((c) => c.trackId === o.trackId);
        if (mode === 'r') {
          let end = o.start + o.duration + dt;
          const sn = snap(end);
          if (sn !== null) end = sn;
          snapped = sn;
          let dur = end - o.start;
          const maxDur = isMediaClip(o) ? (maxSrc - o.trimStart) / o.speed : Infinity;
          const nextStart = o.trackId === MAIN_TRACK ? Infinity : Math.min(Infinity, ...neighbours.filter((c) => c.start >= o.start + o.duration - 1e-6).map((c) => c.start));
          dur = Math.min(Math.max(MIN_CLIP, dur), maxDur, nextStart - o.start);
          st.updateClip(o.id, { duration: dur }, false);
        } else {
          const sn = snap(o.start + dt);
          if (sn !== null) dt = sn - o.start;
          snapped = sn;
          const speed = isMediaClip(o) ? o.speed : 1;
          const trim = isMediaClip(o) ? o.trimStart : Infinity;
          const main = o.trackId === MAIN_TRACK;
          // main track: the clip before it is the limit (its end); other tracks: the nearest clip on the left
          const prevEnd = main ? -Infinity : Math.max(0, ...neighbours.filter((c) => c.start + c.duration <= o.start + 1e-6).map((c) => c.start + c.duration));
          dt = Math.max(dt, -trim / speed, prevEnd - o.start, main ? -Infinity : -o.start);
          dt = Math.min(dt, o.duration - MIN_CLIP);
          const patch: Record<string, number> = { duration: o.duration - dt, start: o.start + dt };
          if (isMediaClip(o)) patch.trimStart = o.trimStart + dt * speed;
          if (main) {
            // like CapCut: the left edge follows the mouse both ways — trimming leaves a gap, growing goes
            // over the clip before it (or below 0 s). The other clips stay put; the magnet fixes it on release.
            useEditor.setState({ clips: s.clips.map((c) => (c.id === o.id ? ({ ...c, ...patch } as Clip) : c)) });
          } else st.updateClip(o.id, patch, false);
        }
        // the preview shows the exact frame where the cut is (the playhead stays where it was)
        const cur = useEditor.getState().clips.find((c) => c.id === o.id);
        if (cur) {
          const frame = 1 / useEditor.getState().settings.fps;
          player.showAt(mode === 'l' ? cur.start + 1e-4 : cur.start + cur.duration - frame / 2);
        }
      }
      setSnapAt(snapped);
    };

    if (mode !== 'move' && useEditor.getState().playing) player.pause();
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragId(null);
      setSnapAt(null);
      setNewTrackHint(false);
      player.showAt(null);
      if (!moved) return;
      if (mode === 'move' && above) {
        // the dragged clip (or the selected group) goes to a new track on top, where you dropped it
        useEditor.getState().moveToNewTrack([...orig.keys()]);
        return;
      }
      if (mode === 'l' && o.trackId === MAIN_TRACK) {
        // back to its original slot so it keeps its order; normalize() puts it right after the previous clip
        const cur = useEditor.getState().clips;
        useEditor.setState({ clips: cur.map((c) => (c.id === o.id ? { ...c, start: o.start } : c)) });
      }
      const st = useEditor.getState();
      if (mode === 'move') {
        // reject drops that overlap another clip on a secondary track
        const bad = st.clips.some(
          (c) =>
            orig.has(c.id) &&
            c.trackId !== MAIN_TRACK &&
            st.clips.some((d) => d.id !== c.id && d.trackId === c.trackId && c.start < d.start + d.duration - 1e-6 && c.start + c.duration > d.start + 1e-6),
        );
        if (bad) {
          useEditor.setState({ clips: st.clips.map((c) => (orig.has(c.id) ? { ...c, ...orig.get(c.id)! } : c)) });
          st.setStatus('No cabe ahí: se solapa con otro clip');
        }
      }
      useEditor.getState().normalize();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* ---- drop from media bin / Finder ---- */
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (!types.includes(MEDIA_DRAG_TYPE) && !types.includes(LIBRARY_DRAG_TYPE) && !types.includes('Files')) return;
    e.preventDefault();
    setDropTrack(yToRow(e.clientY)?.track.id ?? 'new');
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropTrack(null);
    const t = xToTime(e.clientX);
    const row = yToRow(e.clientY);
    const lib = e.dataTransfer.getData(LIBRARY_DRAG_TYPE);
    const raw = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    if (lib) {
      const payload = JSON.parse(lib) as LibraryDragPayload;
      const kind = payload.kind === 'audio' ? 'audio' : 'image';
      const ok = row && accepts(row.track, { type: kind }) && row.track.id !== MAIN_TRACK;
      addFromLibrary(payload, { trackId: ok ? row!.track.id : undefined, start: t });
    } else if (raw) {
      const ids: string[] = raw.startsWith('[') ? JSON.parse(raw) : [raw];
      const m = mediaById.get(ids[0]);
      const ok = m && row && accepts(row.track, { type: m.kind });
      useEditor.getState().addMediaClips(ids, { trackId: ok ? row!.track.id : undefined, start: t });
    } else if (e.dataTransfer.files.length) {
      importFiles(Array.from(e.dataTransfer.files), { trackId: row?.track.id, start: t });
    }
  };

  const openClipMenu = (e: React.MouseEvent, clip: Clip) => {
    e.preventDefault();
    e.stopPropagation();
    const s = useEditor.getState();
    s.setFocusArea('timeline');
    let ids = s.selectedIds;
    if (!ids.includes(clip.id)) {
      ids = [clip.id];
      select(ids);
    }
    const sel = s.clips.filter((c) => ids.includes(c.id));
    const mediaSel = sel.filter(isMediaClip);
    const single = sel.length === 1 ? sel[0] : null;
    const many = sel.length > 1;
    const withAudio = mediaSel.filter((c) => clipHasAudio(c, s.media));
    const extractable = withAudio.filter((c) => !isAudioKind(c) && (c.type === 'video' || c.type === 'compound'));
    const compounds = sel.filter((c) => c.type === 'compound');
    const keyed = mediaSel.filter((c) => c.keyframes?.length);
    const allMuted = withAudio.length > 0 && withAudio.every((c) => c.muted);
    const fx = withAudio.length ? withAudio[0].audioFx ?? 'none' : 'none';
    const under = sel.some((c) => s.time > c.start && s.time < c.start + c.duration);
    const canPaste = s.clipboardKind === 'media' ? s.mediaClipboard.length > 0 : s.clipboard.length > 0;
    const items: MenuItem[] = [
      ...(many ? [{ header: `${sel.length} clips seleccionados` } as MenuItem] : []),
      { label: 'Cortar en el cursor', icon: <Scissors size={14} />, shortcut: 'S', disabled: !under, onClick: () => s.splitAtPlayhead() },
      { label: many ? `Copiar ${sel.length} clips` : 'Copiar', icon: <Copy size={14} />, shortcut: '⌘C', onClick: () => s.copySelected() },
      { label: 'Pegar', icon: <ClipboardPaste size={14} />, shortcut: '⌘V', disabled: !canPaste, onClick: () => s.paste() },
      { label: many ? `Duplicar ${sel.length} clips` : 'Duplicar', icon: <Copy size={14} />, shortcut: '⌘D', onClick: () => s.duplicateSelected() },
      { separator: true },
      {
        label: allMuted ? 'Activar audio' : many ? `Quitar audio (${withAudio.length})` : 'Quitar audio',
        icon: allMuted ? <Volume2 size={14} /> : <VolumeX size={14} />,
        shortcut: 'M',
        disabled: !withAudio.length,
        onClick: () => s.toggleMute(withAudio.map((c) => c.id)),
      },
      {
        label: extractable.length > 1 ? `Separar audio (${extractable.length})` : 'Separar audio',
        icon: <SquareSplitHorizontal size={14} />,
        disabled: !extractable.length,
        onClick: () => s.extractAudio(extractable.map((c) => c.id)),
      },
      {
        label: fx === 'isolate' ? '✓ Aislar voz (quitar ruido)' : 'Aislar voz (quitar ruido)',
        icon: <AudioLines size={14} />,
        badge: 'IA',
        disabled: !withAudio.length,
        onClick: () => s.setAudioFx(withAudio.map((c) => c.id), fx === 'isolate' ? 'none' : 'isolate'),
      },
      {
        label: fx === 'remove-voice' ? '✓ Quitar voz' : 'Quitar voz',
        icon: <MicOff size={14} />,
        badge: 'IA',
        disabled: !withAudio.length,
        onClick: () => s.setAudioFx(withAudio.map((c) => c.id), fx === 'remove-voice' ? 'none' : 'remove-voice'),
      },
      { separator: true },
      {
        label: 'Copiar atributos',
        icon: <Paintbrush size={14} />,
        shortcut: '⌥⌘C',
        disabled: !(single && isMediaClip(single)),
        onClick: () => single && s.copyAttributes(single.id),
      },
      {
        label: mediaSel.length > 1 ? `Pegar atributos en ${mediaSel.length} clips…` : 'Pegar atributos…',
        icon: <ClipboardCopy size={14} />,
        shortcut: '⌥⌘V',
        disabled: !s.attrSource || !mediaSel.some((c) => c.id !== s.attrSource?.id),
        onClick: () => openPasteAttributes(mediaSel.map((c) => c.id)),
      },
      { separator: true },
      ...(single?.type === 'video'
        ? [
            { label: 'Congelar fotograma (3 s)', icon: <Snowflake size={14} />, disabled: !under, onClick: () => void freezeFrame(3) } as MenuItem,
            { label: (single as MediaClip).reversedFrom ? 'Quitar revertir' : 'Revertir (hacia atrás)', icon: <Rewind size={14} />, onClick: () => void reverseClip(single.id) } as MenuItem,
            { separator: true } as MenuItem,
          ]
        : []),
      ...(single?.type === 'compound'
        ? [{ label: 'Abrir clip combinado (editar dentro)', icon: <FolderInput size={14} />, onClick: () => s.enterCompound(single.id) } as MenuItem]
        : []),
      { label: many ? `Crear clip combinado (${sel.length})` : 'Crear clip combinado', icon: <Combine size={14} />, shortcut: '⌥G', onClick: () => s.createCompound() },
      {
        label: compounds.length > 1 ? `Deshacer clips combinados (${compounds.length})` : 'Deshacer clip combinado',
        icon: <Ungroup size={14} />,
        shortcut: '⇧⌥G',
        disabled: !compounds.length,
        onClick: () => compounds.forEach((c) => useEditor.getState().ungroupCompound(c.id)),
      },
      ...(keyed.length
        ? [
            {
              label: keyed.length > 1 ? `Quitar fotogramas clave (${keyed.length})` : 'Quitar fotogramas clave',
              icon: <Diamond size={14} />,
              onClick: () => {
                s.checkpoint();
                keyed.forEach((c) => {
                  const st = useEditor.getState();
                  const cur = st.clips.find((x) => x.id === c.id) as MediaClip | undefined;
                  if (cur) st.updateClip(cur.id, { ...animated(cur, st.time >= cur.start && st.time < cur.start + cur.duration ? st.time : cur.start), keyframes: undefined }, false);
                });
              },
            } as MenuItem,
          ]
        : []),
      many
        ? { label: `Exportar los ${sel.length} clips…`, icon: <Download size={14} />, onClick: () => s.requestExport({ clipIds: ids }) }
        : { label: 'Exportar este clip…', icon: <Download size={14} />, onClick: () => single && s.requestExport({ clipId: single.id }) },
      { separator: true },
      { label: many ? `Eliminar ${sel.length} clips` : 'Eliminar', icon: <Trash2 size={14} />, shortcut: '⌫', danger: true, onClick: () => s.deleteSelected() },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const openTrackMenu = (e: React.MouseEvent, trackId: string) => {
    const st = useEditor.getState();
    const ids = st.clips.filter((c) => c.trackId === trackId).map((c) => c.id);
    const tr = st.tracks.find((t) => t.id === trackId);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Exportar solo esta pista…', icon: <Download size={14} />, disabled: !ids.length, onClick: () => st.requestExport({ clipIds: ids }) },
        { label: 'Seleccionar sus clips', icon: <MousePointerSquareDashed size={14} />, disabled: !ids.length, onClick: () => st.select(ids) },
        { label: tr?.hidden ? 'Mostrar pista' : 'Ocultar pista (guardarla aparte)', icon: tr?.hidden ? <Eye size={14} /> : <EyeOff size={14} />, onClick: () => st.toggleTrack(trackId, 'hidden') },
        { label: tr?.magnet ? 'Quitar imán' : 'Poner imán (clips juntos)', icon: <Magnet size={14} />, onClick: () => st.toggleTrack(trackId, 'magnet') },
        { separator: true },
        { label: ids.length ? `Eliminar pista y sus ${ids.length} clips` : 'Eliminar pista', icon: <Trash2 size={14} />, danger: true, onClick: () => st.removeTrack(trackId) },
      ],
    });
  };

  const openKeyMenu = (e: React.MouseEvent, clip: MediaClip, t: number) => {
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Ir a este fotograma clave', icon: <Diamond size={14} />, onClick: () => player.seek(timelineTime(clip, t) + 1e-4) },
        { label: 'Eliminar fotograma clave', icon: <Trash2 size={14} />, danger: true, onClick: () => useEditor.getState().deleteKeysAt(clip.id, t) },
      ],
    });
  };

  const openEmptyMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const s = useEditor.getState();
    const t = xToTime(e.clientX);
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: 'Pegar aquí',
          icon: <ClipboardPaste size={14} />,
          shortcut: '⌘V',
          disabled: s.clipboardKind === 'media' ? !s.mediaClipboard.length : !s.clipboard.length,
          onClick: () => {
            player.seek(t);
            useEditor.getState().paste();
          },
        },
        { label: 'Seleccionar todo', icon: <MousePointerSquareDashed size={14} />, shortcut: '⌘A', disabled: !s.clips.length, onClick: () => s.select(s.clips.map((c) => c.id)) },
        { label: 'Ajustar zoom a la ventana', icon: <Maximize2 size={14} />, onClick: () => fit() },
      ],
    });
  };

  const hasSel = selectedIds.length > 0;
  const fit = () => {
    const d = Math.max(5, duration);
    setZoom(Math.max(MIN_ZOOM, (viewW - PAD * 2 - 40) / d));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };

  return (
    <section className={`timeline ${stack.length ? 'inside' : ''}`}>
      <div className="tl-toolbar">
        <button className="icon-btn" title="Deshacer (⌘Z)" disabled={!canUndo} onClick={undo}>
          <Undo2 size={16} />
        </button>
        <button className="icon-btn" title="Rehacer (⇧⌘Z)" disabled={!canRedo} onClick={redo}>
          <Redo2 size={16} />
        </button>
        <div className="sep" />
        <button className="icon-btn" title="Cortar en el cursor (S o ⌘B)" disabled={!clips.length} onClick={splitAtPlayhead}>
          <Scissors size={16} />
        </button>
        <button className="icon-btn" title="Duplicar (⌘D)" disabled={!hasSel} onClick={duplicateSelected}>
          <Copy size={16} />
        </button>
        <button className="icon-btn" title="Borrar (⌫)" disabled={!hasSel} onClick={deleteSelected}>
          <Trash2 size={16} />
        </button>
        <button className="icon-btn" title="Crear clip combinado (⌥G)" disabled={!hasSel} onClick={() => useEditor.getState().createCompound()}>
          <Combine size={16} />
        </button>
        <div className="sep" />
        <button className={`icon-btn ${snapOn ? 'active' : ''}`} title="Imán: ajustar a bordes y cursor" onClick={() => setSnapOn(!snapOn)}>
          <Magnet size={16} />
        </button>
        <div className="spacer" />
        <button className="icon-btn" title="Ajustar a la ventana" onClick={fit}>
          <Maximize2 size={15} />
        </button>
        <div className="tl-zoom">
          <ZoomOut size={15} />
          <Range min={0} max={100} step={0.5} value={zoomToSlider(zoom)} onChange={(e) => setZoom(sliderToZoom(Number(e.target.value)))} />
          <ZoomIn size={15} />
        </div>
      </div>

      {stack.length > 0 && (
        <div className="tl-crumbs">
          <button className="btn small primary" onClick={() => useEditor.getState().exitCompound()} title="Guardar los cambios en el clip combinado y volver (Esc)">
            <ArrowLeft size={14} /> Volver
          </button>
          <button className="crumb" onClick={() => useEditor.getState().exitCompound(stack.length)}>
            Proyecto
          </button>
          {stack.map((lv, i) => (
            <span key={lv.id} style={{ display: 'contents' }}>
              <ChevronRight size={13} />
              {i === stack.length - 1 ? (
                <b>Clip combinado{stack.length > 1 ? ` ${i + 1}` : ''}</b>
              ) : (
                <button className="crumb" onClick={() => useEditor.getState().exitCompound(stack.length - 1 - i)}>
                  Clip combinado {i + 1}
                </button>
              )}
            </span>
          ))}
          <span className="hint" style={{ marginLeft: 8 }}>
            Estás editando dentro del clip combinado: corta, mueve o cambia lo que quieras.
          </span>
        </div>
      )}
      <div className="tl-body">
        <div className="tl-heads" ref={headsRef}>
          <div style={{ height: RULER_H, borderBottom: '1px solid var(--border)' }} />
          {rows.map(({ track, h }) => (
            <div key={track.id} className="tl-head" style={{ height: h }}>
              {track.kind === 'video' ? <Film size={14} /> : track.kind === 'audio' ? <Music size={14} /> : <Type size={14} />}
              <span className="track-name" title={track.id === MAIN_TRACK ? 'Pista principal' : undefined}>{track.id === MAIN_TRACK ? 'Principal' : track.hidden ? 'Oculta' : ''}</span>
              {track.id !== MAIN_TRACK && (
                <button
                  className={`icon-btn ${track.magnet ? 'active' : 'dim'}`}
                  title={track.magnet ? 'Imán activado: los clips de esta pista van juntos, sin huecos' : 'Imán desactivado: coloca los clips donde quieras'}
                  onClick={() => useEditor.getState().toggleTrack(track.id, 'magnet')}
                >
                  <Magnet size={13} />
                </button>
              )}
              {track.kind !== 'audio' && (
                <button className="icon-btn" title={track.hidden ? 'Mostrar pista (vuelve al vídeo)' : 'Ocultar pista: se guarda pero no sale en el vídeo ni se oye'} onClick={() => toggleTrack(track.id, 'hidden')}>
                  {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              )}
              {track.kind !== 'text' && (
                <button className="icon-btn" title={track.muted ? 'Activar sonido' : 'Silenciar pista'} onClick={() => toggleTrack(track.id, 'muted')}>
                  {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
                </button>
              )}
              {track.id !== MAIN_TRACK && (
                <button className="icon-btn" title="Más opciones de la pista" onClick={(e) => openTrackMenu(e, track.id)}>
                  <MoreHorizontal size={13} />
                </button>
              )}
            </div>
          ))}
        </div>

        <div
          className="tl-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            if (headsRef.current) headsRef.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onDragOver={onDragOver}
          onDragLeave={() => setDropTrack(null)}
          onDrop={onDrop}
        >
          <div className="tl-inner" style={{ width: innerW, height: innerH, transform: lead ? `translateX(${lead}px)` : undefined }} onContextMenu={openEmptyMenu} onPointerDown={startMarquee}>
            <Ruler zoom={zoom} width={innerW} onPointerDown={(e) => {
              e.stopPropagation();
              startScrub(e);
            }} />
            {newTrackHint && (
              <div className="new-track-hint" style={{ top: RULER_H - 2 }}>
                <Plus size={13} /> Suelta aquí: pista nueva encima
              </div>
            )}
            {rows.map(({ track, h }) => (
              <div key={track.id} className={`tl-track ${track.id === MAIN_TRACK ? 'main' : ''} ${dropTrack === track.id ? 'drop-target' : ''}`} style={{ height: h, opacity: track.hidden ? 0.45 : 1 }}>
                {clips
                  .filter((c) => c.trackId === track.id)
                  .map((c) => (
                    <ClipView
                      key={c.id}
                      clip={c}
                      media={isMediaClip(c) ? mediaById.get(c.mediaId) : undefined}
                      zoom={zoom}
                      height={h}
                      selected={selectedIds.includes(c.id)}
                      dragging={dragId === c.id}
                      hasAudio={isMediaClip(c) && clipHasAudio(c, media)}
                      onPointerDown={onClipPointerDown}
                      onVolumePointerDown={onVolumePointerDown}
                      onContextMenu={openClipMenu}
                      onKeyMenu={openKeyMenu}
                    />
                  ))}
                {track.id === MAIN_TRACK && !clips.some((c) => c.trackId === MAIN_TRACK) && (
                  <div className="hint" style={{ position: 'absolute', left: PAD + 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Sparkles size={14} /> Arrastra aquí tus clips de vídeo
                  </div>
                )}
              </div>
            ))}
            <div className={`tl-track ${dropTrack === 'new' ? 'drop-target' : ''}`} style={{ height: 60, borderBottom: 'none' }} />
            <div className="playhead" style={{ left: PAD + time * zoom }}>
              <div className="knob" onPointerDown={(e) => {
                e.stopPropagation();
                startScrub(e);
              }} />
            </div>
            {snapAt !== null && <div className="snap-line" style={{ left: PAD + snapAt * zoom }} />}
            {marquee && <div className="marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />}
          </div>
        </div>
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {volTip && (
        <div className="vol-tip" style={{ left: volTip.x + 14, top: volTip.y - 30 }}>
          Volumen {Math.round(volTip.v * 100)} %
        </div>
      )}
    </section>
  );
}
