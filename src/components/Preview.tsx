import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, PanelLeft, PanelRight, Pause, Play, SkipBack, StepBack, StepForward } from 'lucide-react';
import { useCompact, useLayout } from '../store/layout';
import { projectDuration, useEditor } from '../store/editor';
import { player, rotHandlePos } from '../lib/player';
import { clamp, formatTime } from '../lib/util';
import { isMediaClip, type Clip, type Transform } from '../types';
import type { HitBox } from '../lib/render';
import MaskOverlay from './MaskOverlay';
import { animated, newRecording, recordValues, valueAt, type Recording } from '../lib/keyframes';

const STAGE_PAD = 14;
const HANDLE_CSS = 12; // corner handle size in screen pixels
const MAX_BACKING = 4096;

type Pt = { x: number; y: number };

/** A tiny vibration when something snaps into place (phones; ignored elsewhere). */
export const buzz = () => {
  try {
    navigator.vibrate?.(8);
  } catch {
    /* not available */
  }
};

/** Corner positions of a (possibly rotated) box. */
function corners(h: HitBox): Pt[] {
  const a = (h.rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => {
    const dx = (sx * h.w) / 2;
    const dy = (sy * h.h) / 2;
    return { x: h.cx + dx * cos - dy * sin, y: h.cy + dx * sin + dy * cos };
  });
}

function inside(h: HitBox, p: Pt) {
  const a = (-h.rotation * Math.PI) / 180;
  const dx = p.x - h.cx;
  const dy = p.y - h.cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= h.w / 2 && Math.abs(ly) <= h.h / 2;
}

/** Current "size" of a clip at the playhead: scale for videos/photos, font size for texts. */
const getSize = (c: Clip) => (isMediaClip(c) ? valueAt(c, 'transform.scale', useEditor.getState().time) : c.style.fontSize);

function setSize(c: Clip, size: number, commit: boolean) {
  const st = useEditor.getState();
  if (isMediaClip(c)) st.setTransform(c.id, { scale: clamp(size, 0.05, 10) }, commit);
  else st.updateClip(c.id, { style: { ...c.style, fontSize: clamp(size, 0.01, 0.6) } }, commit);
}

/**
 * While the video plays, dragging a clip RECORDS its movement as keyframes
 * (e.g. to follow a player with the "camera").
 */
function recordKey(clipId: string, patch: Partial<Transform>, rec: Recording) {
  const st = useEditor.getState();
  const c = st.clips.find((x) => x.id === clipId);
  if (!c || !isMediaClip(c) || st.time < c.start || st.time >= c.start + c.duration) return;
  const values = Object.fromEntries(Object.entries(patch).map(([k, v]) => [`transform.${k}`, v as number]));
  st.updateClip(c.id, recordValues(c, st.time, values, rec), false);
}

/** Pick a color from the preview (chroma key): the next click on the viewer calls this. */
let colorPick: ((hex: string) => void) | null = null;
const pickListeners = new Set<() => void>();
export function startColorPick(cb: ((hex: string) => void) | null) {
  colorPick = cb;
  pickListeners.forEach((f) => f());
}
export const isPickingColor = () => !!colorPick;
export const onColorPickChange = (f: () => void) => (pickListeners.add(f), () => void pickListeners.delete(f));

/** The viewer. `bare` (phones) leaves out the controls row: the mobile editor has its own. */
export default function Preview({ bare = false }: { bare?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const settings = useEditor((s) => s.settings);
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const duration = useEditor((s) => projectDuration(s.clips));
  const empty = useEditor((s) => s.clips.length === 0);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [cursor, setCursor] = useState('default');
  const layout = useLayout();
  const focus = !layout.leftOpen && !layout.rightOpen;
  const touch = useCompact();

  // Fit the canvas inside the stage (never overlapping the controls or the timeline)
  useLayoutEffect(() => {
    const el = stageRef.current!;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ar = settings.width / settings.height;
  const availW = Math.max(1, stage.w - STAGE_PAD * 2);
  const availH = Math.max(1, stage.h - STAGE_PAD * 2);
  const cssW = Math.max(1, Math.floor(Math.min(availW, availH * ar)));
  const cssH = Math.max(1, Math.floor(cssW / ar));
  // Full quality: one canvas pixel per screen pixel (Retina included), no downscaled preview
  const dpr = window.devicePixelRatio || 1;
  const k = Math.min(dpr, MAX_BACKING / Math.max(cssW, cssH));
  const cw = Math.round(cssW * k);
  const ch = Math.round(cssH * k);

  useEffect(() => {
    player.attach(canvasRef.current!);
    return () => player.detach();
  }, []);
  useEffect(() => {
    player.handlePx = HANDLE_CSS * k;
    player.invalidate();
  }, [cw, ch, k]);

  const toCanvas = (ev: { clientX: number; clientY: number }): Pt => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sx };
  };

  /** Which selected box's corner (if any) is under the pointer (fingers get a bigger target). */
  const cornerAt = (p: Pt, finger = false) => {
    const sel = useEditor.getState().selectedIds;
    const r = HANDLE_CSS * k * (finger ? 2.4 : 1);
    for (const h of [...player.hits].reverse()) {
      if (!sel.includes(h.clipId)) continue;
      const i = corners(h).findIndex((c) => Math.hypot(c.x - p.x, c.y - p.y) <= r);
      if (i >= 0) return { hit: h, corner: i };
    }
    return null;
  };
  const boxAt = (p: Pt) => [...player.hits].reverse().find((h) => inside(h, p));
  /** The rotation handle of a selected video/photo under the pointer. */
  const rotAt = (p: Pt, finger = false) => {
    const s = useEditor.getState();
    const r = HANDLE_CSS * k * (finger ? 2.4 : 1);
    return [...player.hits].reverse().find((h) => {
      if (!s.selectedIds.includes(h.clipId) || !s.clips.some((c) => c.id === h.clipId && isMediaClip(c))) return false;
      const q = rotHandlePos(h, player.handlePx, canvasRef.current!.width, canvasRef.current!.height);
      return Math.hypot(q.x - p.x, q.y - p.y) <= r;
    });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.buttons) return;
    if (colorPick) {
      if (cursor !== 'crosshair') setCursor('crosshair');
      return;
    }
    const p = toCanvas(e);
    const c = cornerAt(p);
    const next = c ? (c.corner % 2 === 0 ? 'nwse-resize' : 'nesw-resize') : rotAt(p) ? 'grab' : boxAt(p) ? 'move' : 'default';
    if (next !== cursor) setCursor(next);
  };

  /* ---- two fingers on the viewer: pinch = bigger / smaller, twist = rotate (phones) ---- */
  const touches = useRef(new Map<number, Pt>());
  const cancelDrag = useRef<(() => void) | null>(null);
  const startPinch = () => {
    const canvas = canvasRef.current!;
    const s = useEditor.getState();
    const [a, b] = [...touches.current.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const id = s.selectedIds.length === 1 ? s.selectedIds[0] : [...player.hits].reverse().find((h) => inside(h, mid))?.clipId;
    const clip = id && s.clips.find((c) => c.id === id);
    if (!clip) return;
    s.select([clip.id]);
    s.checkpoint();
    const size0 = getSize(clip);
    const rot0 = isMediaClip(clip) ? valueAt(clip, 'transform.rotation', s.time) : 0;
    const d0 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const ang0 = Math.atan2(b.y - a.y, b.x - a.x);
    let snappedSize = false;
    let snappedRot = false;
    const move = (ev: PointerEvent) => {
      if (!touches.current.has(ev.pointerId)) return;
      touches.current.set(ev.pointerId, toCanvas(ev));
      if (touches.current.size < 2) return;
      const [p1, p2] = [...touches.current.values()];
      let size = (size0 * Math.hypot(p1.x - p2.x, p1.y - p2.y)) / d0;
      // a little magnet at 100 % (videos and photos), with a tap of the phone's vibration
      const atFull = isMediaClip(clip) && Math.abs(size - 1) < 0.04;
      if (atFull) size = 1;
      if (atFull && !snappedSize) buzz();
      snappedSize = atFull;
      const cur = useEditor.getState().clips.find((c) => c.id === clip.id);
      if (!cur) return;
      if (isMediaClip(cur)) {
        let r = rot0 + ((Math.atan2(p2.y - p1.y, p2.x - p1.x) - ang0) * 180) / Math.PI;
        r = ((((r + 180) % 360) + 360) % 360) - 180;
        const near = Math.round(r / 90) * 90;
        const atRight = Math.abs(r - near) < 5;
        if (atRight) r = near;
        if (atRight && !snappedRot) buzz();
        snappedRot = atRight;
        useEditor.getState().setTransform(cur.id, { scale: clamp(size, 0.05, 10), rotation: Math.round(r * 10) / 10 }, false);
      } else setSize(cur, size, false);
    };
    const end = (ev: PointerEvent) => {
      touches.current.delete(ev.pointerId);
      if (touches.current.size >= 2) return;
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', end);
      canvas.removeEventListener('pointercancel', end);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  };

  // Click to select, drag to move; drag a corner to make it bigger/smaller
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    useEditor.getState().setFocusArea('timeline');
    const canvas = canvasRef.current!;
    const p = toCanvas(e);
    const s = useEditor.getState();
    const finger = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (e.pointerType === 'touch') {
      touches.current.set(e.pointerId, p);
      const forget = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        touches.current.delete(ev.pointerId);
        canvas.removeEventListener('pointerup', forget);
        canvas.removeEventListener('pointercancel', forget);
      };
      canvas.addEventListener('pointerup', forget);
      canvas.addEventListener('pointercancel', forget);
      // second finger: stop moving the clip and pinch it instead
      if (touches.current.size === 2) {
        cancelDrag.current?.();
        cancelDrag.current = null;
        startPinch();
        return;
      }
      if (touches.current.size > 2) return;
    }
    // chroma key color picker: read the pixel under the click (3×3 average)
    if (colorPick) {
      const d = canvas.getContext('2d')!.getImageData(Math.round(p.x) - 1, Math.round(p.y) - 1, 3, 3).data;
      const avg = [0, 1, 2].map((ch) => Math.round((d[ch] + d[ch + 4] + d[ch + 8] + d[ch + 12] + d[ch + 16] + d[ch + 20] + d[ch + 24] + d[ch + 28] + d[ch + 32]) / 9));
      const cb = colorPick;
      startColorPick(null);
      setCursor('default');
      cb('#' + avg.map((v) => v.toString(16).padStart(2, '0')).join(''));
      return;
    }
    // rotation handle: turn around the center (snaps to 0/90/180°, ⇧ = steps of 15°)
    const rh = rotAt(p, finger);
    if (rh) {
      const clip = s.clips.find((c) => c.id === rh.clipId);
      if (!clip || !isMediaClip(clip)) return;
      canvas.setPointerCapture(e.pointerId);
      const a0 = Math.atan2(p.y - rh.cy, p.x - rh.cx);
      const r0 = valueAt(clip, 'transform.rotation', s.time);
      let moved = false;
      setCursor('grabbing');
      const move = (ev: PointerEvent) => {
        const q = toCanvas(ev);
        if (!moved) useEditor.getState().checkpoint();
        moved = true;
        let r = r0 + ((Math.atan2(q.y - rh.cy, q.x - rh.cx) - a0) * 180) / Math.PI;
        r = ((((r + 180) % 360) + 360) % 360) - 180;
        if (ev.shiftKey) r = Math.round(r / 15) * 15;
        else {
          const near = Math.round(r / 90) * 90;
          if (Math.abs(r - near) < 4) r = near;
        }
        useEditor.getState().setTransform(clip.id, { rotation: Math.round(r * 10) / 10 }, false);
      };
      const up = () => {
        setCursor('grab');
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
      return;
    }
    const corner = cornerAt(p, finger);
    const hit = corner?.hit ?? boxAt(p);
    if (!hit) {
      s.select([]);
      return;
    }
    if (!corner) s.select([hit.clipId]);
    const clip = s.clips.find((c) => c.id === hit.clipId)!;
    canvas.setPointerCapture(e.pointerId);
    let moved = false;
    let snapped = false;
    let last: Pt | null = null;
    let raf = 0;
    const rec = newRecording();
    const t0 = isMediaClip(clip) ? animated(clip, s.time).transform : null;

    /** new position/size for the pointer at q */
    const targetAt = (q: Pt): { media?: Partial<Transform>; text?: { x: number; y: number } } => {
      if (corner) {
        let size = (getSize0 * Math.hypot(q.x - hit.cx, q.y - hit.cy)) / d0;
        // magnet at 100 %: it sticks there until you pull a bit further
        const atFull = isMediaClip(clip) && Math.abs(size - 1) < 0.03;
        if (atFull) size = 1;
        if (atFull && !snapped) buzz();
        snapped = atFull;
        return isMediaClip(clip) ? { media: { scale: clamp(size, 0.05, 10) } } : { text: undefined };
      }
      const dx = (q.x - p.x) / canvas.width;
      const dy = (q.y - p.y) / canvas.height;
      const start = t0 ? { x: t0.x, y: t0.y } : !isMediaClip(clip) ? { x: clip.style.x, y: clip.style.y } : { x: 0, y: 0 };
      let nx = start.x + dx;
      let ny = start.y + dy;
      // snap to center (not while recording a movement: it would make it jumpy)
      if (!useEditor.getState().playing) {
        const center = isMediaClip(clip) ? 0 : 0.5;
        if (Math.abs(nx - center) < 0.01) nx = center;
        if (Math.abs(ny - center) < 0.01) ny = center;
      }
      return isMediaClip(clip) ? { media: { x: nx, y: ny } } : { text: { x: nx, y: ny } };
    };
    const getSize0 = getSize(clip);
    const d0 = Math.max(1, Math.hypot(p.x - hit.cx, p.y - hit.cy));

    const apply = (q: Pt) => {
      const st = useEditor.getState();
      const cur = st.clips.find((c) => c.id === clip.id);
      if (!cur) return;
      const v = targetAt(q);
      if (v.media) {
        if (st.playing) recordKey(cur.id, v.media, rec);
        else st.setTransform(cur.id, v.media, false);
      } else if (!isMediaClip(cur)) {
        if (corner) setSize(cur, (getSize0 * Math.hypot(q.x - hit.cx, q.y - hit.cy)) / d0, false);
        else if (v.text) st.updateClip(cur.id, { style: { ...cur.style, ...v.text } }, false);
      }
    };
    // while playing, keep recording even if the mouse stands still
    const tick = () => {
      if (last && useEditor.getState().playing) apply(last);
      raf = requestAnimationFrame(tick);
    };

    const move = (ev: PointerEvent) => {
      const q = toCanvas(ev);
      if (!moved && !corner && Math.hypot((q.x - p.x) / canvas.width, (q.y - p.y) / canvas.height) < 0.003) return;
      if (!moved) {
        useEditor.getState().checkpoint();
        if (isMediaClip(clip)) raf = requestAnimationFrame(tick);
      }
      moved = true;
      last = q;
      apply(q);
    };
    const up = () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      if (cancelDrag.current === up) cancelDrag.current = null;
    };
    cancelDrag.current = up;
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  };

  // ⌘ + mouse wheel (or pinch on the trackpad) over the preview resizes the selected clip
  useEffect(() => {
    const el = stageRef.current!;
    let lastWheel = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useEditor.getState();
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width;
      const p = { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sx };
      const under = [...player.hits].reverse().find((h) => inside(h, p));
      let id = under && s.selectedIds.includes(under.clipId) ? under.clipId : player.hits.find((h) => s.selectedIds.includes(h.clipId))?.clipId;
      if (!id && under) {
        id = under.clipId;
        s.select([id]);
      }
      const clip = id && s.clips.find((c) => c.id === id);
      if (!clip) return;
      const now = performance.now();
      if (now - lastWheel > 600) s.checkpoint(); // one undo step per gesture
      lastWheel = now;
      // trackpad pinch (arrives as ctrl+wheel) gives many small deltas; a mouse wheel notch is ~100
      const pinch = e.ctrlKey && !e.metaKey;
      const factor = pinch ? Math.exp(-clamp(e.deltaY, -30, 30) * 0.01) : Math.exp(-clamp(e.deltaY, -50, 50) * 0.004);
      setSize(clip, getSize(clip) * factor, false);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const step = (d: number) => player.seek(useEditor.getState().time + d / settings.fps);

  return (
    <section className="preview">
      <div className="stage" ref={stageRef}>
        <div className="canvas-wrap" style={{ width: cssW, height: cssH }}>
          <canvas
            ref={canvasRef}
            width={cw}
            height={ch}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setCursor('default')}
            style={{ width: cssW, height: cssH, cursor }}
          />
          <MaskOverlay k={cw / cssW} />
        </div>
        {empty && (
          <div className="empty-hint">
            <div>
              <div style={{ fontSize: 15, color: 'var(--text)', marginBottom: 6 }}>{touch ? 'Toca + para añadir tus vídeos' : 'Arrastra tus vídeos aquí para empezar'}</div>
              <div>{touch ? 'Elige tus vídeos, música o fotos' : 'Se añadirán a la biblioteca multimedia'}</div>
            </div>
          </div>
        )}
      </div>
      <div className="transport" hidden={bare}>
        <div className="left-side timecode">
          <b>{formatTime(time, true, settings.fps)}</b> / {formatTime(duration, true, settings.fps)}
        </div>
        <div className="transport-center">
          <button className="icon-btn" title="Ir al inicio (Inicio)" onClick={() => player.seek(0)}>
            <SkipBack size={16} />
          </button>
          <button className="icon-btn" title="Fotograma anterior (←)" onClick={() => step(-1)}>
            <StepBack size={16} />
          </button>
          <button className="play-btn" title="Reproducir / pausa (Espacio)" onClick={() => player.toggle()}>
            {playing ? <Pause size={16} fill="#000" /> : <Play size={16} fill="#000" style={{ marginLeft: 2 }} />}
          </button>
          <button className="icon-btn" title="Fotograma siguiente (→)" onClick={() => step(1)}>
            <StepForward size={16} />
          </button>
        </div>
        <div className="right-side">
          <span className="hint res">
            {settings.width}×{settings.height}
          </span>
          <button className={`icon-btn ${layout.leftOpen ? '' : 'dim'}`} title={layout.leftOpen ? 'Ocultar el panel de multimedia' : 'Mostrar el panel de multimedia'} onClick={() => layout.set({ leftOpen: !layout.leftOpen })}>
            <PanelLeft size={16} />
          </button>
          <button className={`icon-btn ${layout.rightOpen ? '' : 'dim'}`} title={layout.rightOpen ? 'Ocultar propiedades' : 'Mostrar propiedades'} onClick={() => layout.set({ rightOpen: !layout.rightOpen })}>
            <PanelRight size={16} />
          </button>
          <button className="icon-btn" title={focus ? 'Volver a mostrar los paneles (F)' : 'Ampliar el visor: oculta los paneles laterales (F)'} onClick={layout.toggleFocus}>
            {focus ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>
    </section>
  );
}
