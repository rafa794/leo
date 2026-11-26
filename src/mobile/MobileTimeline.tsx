import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, Volume2, VolumeX } from 'lucide-react';
import { MAIN_TRACK, projectDuration, useEditor } from '../store/editor';
import { player } from '../lib/player';
import { formatTime } from '../lib/util';
import { isMediaClip, type Clip, type MediaClip, type Track } from '../types';

/**
 * Phone timeline (like the mobile editors people know): the playhead stays in the middle and the
 * timeline slides under it. Swipe = move through the video, pinch = zoom, tap = select,
 * the white handles of the selected clip = trim.
 */

const MIN_ZOOM = 8; // px per second
const MAX_ZOOM = 600;
const MIN_CLIP = 0.1;
const ROW_H = { main: 56, other: 34 };

export default function MobileTimeline({ onAdd, onAddAudio, onAddText }: { onAdd: () => void; onAddAudio: () => void; onAddText: () => void }) {
  const clips = useEditor((s) => s.clips);
  const tracks = useEditor((s) => s.tracks);
  const media = useEditor((s) => s.media);
  const selectedIds = useEditor((s) => s.selectedIds);
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const fps = useEditor((s) => s.settings.fps);
  const [zoom, setZoom] = useState(70);
  const [width, setWidth] = useState(360);
  const scroller = useRef<HTMLDivElement>(null);
  const userScroll = useRef(false);
  const settle = useRef<number | null>(null);
  const pinch = useRef<{ d0: number; z0: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const pad = width / 2;
  const duration = projectDuration(clips);
  const total = Math.max(duration, 1);
  const mediaById = new Map(media.map((m) => [m.id, m]));
  const mainTrack = tracks.find((t) => t.id === MAIN_TRACK);

  // keep the playhead (middle of the screen) on the current time while playing / after edits
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || userScroll.current) return;
    const target = time * zoom;
    if (Math.abs(el.scrollLeft - target) > 0.5) el.scrollLeft = target;
  }, [time, zoom, width]);

  /* ---- swipe = scrub ---- */
  const onScroll = () => {
    const el = scroller.current!;
    if (!userScroll.current) return;
    const t = Math.max(0, Math.min(total, el.scrollLeft / zoom));
    player.seek(t);
    // the momentum of a fling keeps scrolling after the finger leaves: stop "owning" the scroll when it settles
    if (settle.current) clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      userScroll.current = false;
      player.endScrub();
    }, 160);
  };
  const touchStart = () => {
    if (useEditor.getState().playing) player.pause(); // touching the timeline pauses, like other editors
    if (!userScroll.current) player.beginScrub();
    userScroll.current = true;
  };

  /* ---- pinch = zoom (two fingers) · ctrl + wheel on a computer ---- */
  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d0: Math.hypot(a.x - b.x, a.y - b.y), z0: zoom };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.current.z0 * (d / Math.max(1, pinch.current.d0)))));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  useEffect(() => {
    const el = scroller.current!;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * Math.exp(-e.deltaY * 0.01))));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  /* ---- trim with the handles of the selected clip ---- */
  const startTrim = (e: React.PointerEvent, clip: Clip, side: 'l' | 'r') => {
    e.stopPropagation();
    e.preventDefault();
    const st = useEditor.getState();
    if (st.playing) player.pause();
    st.checkpoint();
    const o = { ...clip } as Clip;
    const x0 = e.clientX;
    const m = isMediaClip(o) ? mediaById.get(o.mediaId) : undefined;
    const maxSrc = isMediaClip(o) && o.type !== 'image' && m ? m.duration : Infinity;
    const main = o.trackId === MAIN_TRACK;
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / zoom;
      const s = useEditor.getState();
      const speed = isMediaClip(o) ? o.speed : 1;
      if (side === 'r') {
        const maxDur = isMediaClip(o) ? (maxSrc - o.trimStart) / speed : Infinity;
        s.updateClip(o.id, { duration: Math.min(maxDur, Math.max(MIN_CLIP, o.duration + dt)) }, false);
        player.showAt(o.start + Math.min(maxDur, Math.max(MIN_CLIP, o.duration + dt)) - 1 / fps / 2);
      } else {
        const trim = isMediaClip(o) ? o.trimStart : Infinity;
        let d = Math.max(dt, -trim / speed, main ? -Infinity : -o.start);
        d = Math.min(d, o.duration - MIN_CLIP);
        const patch: Record<string, number> = { duration: o.duration - d, start: main ? o.start : o.start + d };
        if (isMediaClip(o)) patch.trimStart = o.trimStart + d * speed;
        useEditor.setState({ clips: s.clips.map((c) => (c.id === o.id ? ({ ...c, ...patch } as Clip) : c)) });
        player.showAt(o.start + 1e-4);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      player.showAt(null);
      useEditor.getState().normalize(); // the main track closes the gap (magnet)
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const select = (e: React.MouseEvent, clip: Clip) => {
    e.stopPropagation();
    const st = useEditor.getState();
    st.select(st.selectedIds.length === 1 && st.selectedIds[0] === clip.id ? [] : [clip.id]);
  };

  /* ---- rows ---- */
  const rowsFor = (kind: 'overlay' | 'text' | 'audio'): Track[] =>
    tracks.filter((t) => t.id !== MAIN_TRACK && (kind === 'overlay' ? t.kind === 'video' : t.kind === kind) && clips.some((c) => c.trackId === t.id));
  const overlays = rowsFor('overlay');
  const texts = rowsFor('text');
  const audios = rowsFor('audio');

  const clipBox = (clip: Clip, h: number) => {
    const sel = selectedIds.includes(clip.id);
    const left = pad + clip.start * zoom;
    const w = Math.max(4, clip.duration * zoom);
    const m = isMediaClip(clip) ? mediaById.get(clip.mediaId) : undefined;
    let body: React.ReactNode = null;
    if (clip.type === 'text') body = <span className="mt-label" translate="no">{clip.text}</span>;
    else if (m && (clip.type === 'video' || clip.type === 'image') && m.thumbnails.length) {
      const tw = h * (16 / 10);
      const n = Math.max(1, Math.ceil(w / tw));
      body = (
        <div className="mt-thumbs">
          {Array.from({ length: Math.min(n, 60) }, (_, i) => {
            const c = clip as MediaClip;
            const srcT = c.trimStart + ((i * tw) / zoom) * c.speed;
            const idx = clip.type === 'image' ? 0 : Math.min(m.thumbnails.length - 1, Math.max(0, Math.floor((srcT / Math.max(0.01, m.duration)) * m.thumbnails.length)));
            return <img key={i} src={m.thumbnails[idx]} style={{ width: tw }} alt="" draggable={false} />;
          })}
        </div>
      );
    } else if (m) body = <span className="mt-label" translate="no">{m.name}</span>;
    return (
      <div key={clip.id} className={`mt-clip ${clip.type} ${sel ? 'sel' : ''}`} style={{ left, width: w, height: h }} onClick={(e) => select(e, clip)}>
        {body}
        {clip.type !== 'text' && h >= ROW_H.main && <span className="mt-dur">{clip.duration.toFixed(1)}s</span>}
        {sel && (
          <>
            <div className="mt-handle l" onPointerDown={(e) => startTrim(e, clip, 'l')} />
            <div className="mt-handle r" onPointerDown={(e) => startTrim(e, clip, 'r')} />
          </>
        )}
      </div>
    );
  };

  const ticks: number[] = [];
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * zoom >= 90) ?? 600;
  for (let t = 0; t <= total + step; t += step) ticks.push(t);
  const contentW = pad * 2 + total * zoom;

  return (
    <div className="mt-wrap">
      <div className="mt-time">
        <b>{formatTime(time)}</b> / {formatTime(duration)}
      </div>
      <div
        className="mt"
        ref={scroller}
        onScroll={onScroll}
        onTouchStart={touchStart}
        onWheel={(e) => !e.ctrlKey && touchStart()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => useEditor.getState().select([])}
      >
        <div className="mt-content" style={{ width: contentW }}>
          <div className="mt-ruler">
            {ticks.map((t) => (
              <span key={t} style={{ left: pad + t * zoom }}>
                {formatTime(t)}
              </span>
            ))}
          </div>
          {/* main track, with its mute button before 0 s */}
          <div className="mt-row main" style={{ height: ROW_H.main }}>
            <button
              className={`mt-side ${mainTrack?.muted ? 'on' : ''}`}
              style={{ left: pad - 72 }}
              onClick={(e) => {
                e.stopPropagation();
                useEditor.getState().toggleTrack(MAIN_TRACK, 'muted');
              }}
            >
              {mainTrack?.muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              <span>{mainTrack?.muted ? 'Activar sonido' : 'Silenciar'}</span>
            </button>
            {clips.filter((c) => c.trackId === MAIN_TRACK).map((c) => clipBox(c, ROW_H.main))}
            {!clips.some((c) => c.trackId === MAIN_TRACK) && (
              <button className="mt-empty" style={{ left: pad }} onClick={(e) => (e.stopPropagation(), onAdd())}>
                <Plus size={16} /> Añadir vídeos o fotos
              </button>
            )}
          </div>
          {overlays.map((t) => (
            <div key={t.id} className={`mt-row ${t.hidden ? 'hidden' : ''}`} style={{ height: ROW_H.other }}>
              {clips.filter((c) => c.trackId === t.id).map((c) => clipBox(c, ROW_H.other))}
            </div>
          ))}
          {texts.map((t) => (
            <div key={t.id} className="mt-row" style={{ height: ROW_H.other }}>
              {clips.filter((c) => c.trackId === t.id).map((c) => clipBox(c, ROW_H.other))}
            </div>
          ))}
          {audios.map((t) => (
            <div key={t.id} className="mt-row" style={{ height: ROW_H.other }}>
              {clips.filter((c) => c.trackId === t.id).map((c) => clipBox(c, ROW_H.other))}
            </div>
          ))}
          {!audios.length && (
            <div className="mt-row add" style={{ height: ROW_H.other }}>
              <button className="mt-lane" style={{ left: pad }} onClick={(e) => (e.stopPropagation(), onAddAudio())}>
                <Plus size={14} /> Añadir audio
              </button>
            </div>
          )}
          {!texts.length && (
            <div className="mt-row add" style={{ height: ROW_H.other }}>
              <button className="mt-lane" style={{ left: pad }} onClick={(e) => (e.stopPropagation(), onAddText())}>
                <Plus size={14} /> Añadir texto
              </button>
            </div>
          )}
        </div>
      </div>
      <div className={`mt-playhead ${playing ? 'playing' : ''}`} />
      <button className="mt-plus" title="Añadir vídeos o fotos al final" onClick={onAdd}>
        <Plus size={22} />
      </button>
    </div>
  );
}
