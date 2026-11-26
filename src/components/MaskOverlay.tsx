import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useEditor } from '../store/editor';
import { player } from '../lib/player';
import { valueAt } from '../lib/keyframes';
import { clamp } from '../lib/util';
import type { HitBox } from '../lib/render';
import type { MediaClip } from '../types';

/**
 * Editing a mask right on the viewer (like CapCut): while the "Máscara" panel is open, the mask's
 * outline is drawn over the clip. Drag anywhere to move it, the white handles to resize it, the round
 * handle on top to turn it and the one below to soften (feather) its edge.
 */
export const useMaskEdit = create<{ clipId: string | null }>(() => ({ clipId: null }));
export const setMaskEdit = (clipId: string | null) => {
  useMaskEdit.setState({ clipId });
  player.maskClip = clipId; // its own blue frame is hidden meanwhile
  player.invalidate();
};

type Pt = { x: number; y: number };
type Drag =
  | { kind: 'move'; start: Pt; x0: number; y0: number }
  | { kind: 'size'; sx: number; sy: number; keepRatio: number }
  | { kind: 'rotate' }
  | { kind: 'feather' };

const ROT_GAP = 26; // css px between the shape and its rotation handle
const FEATHER_GAP = 18;

/** Everything needed to place the mask on screen (in canvas pixels). */
function geometry(hit: HitBox, clip: MediaClip, time: number) {
  const v = (p: string) => valueAt(clip, p, time);
  const fx = clip.flipX ? -1 : 1;
  const fy = clip.flipY ? -1 : 1;
  const a = (hit.rotation * Math.PI) / 180;
  const lx = fx * v('mask.x') * hit.w;
  const ly = fy * v('mask.y') * hit.h;
  return {
    a,
    fx,
    fy,
    cx: hit.cx + lx * Math.cos(a) - ly * Math.sin(a),
    cy: hit.cy + lx * Math.sin(a) + ly * Math.cos(a),
    hw: (v('mask.w') * hit.w) / 2,
    hh: (v('mask.h') * hit.h) / 2,
    // the shader turns the picture point by +rotation, so the shape turns the other way on screen
    rot: hit.rotation - v('mask.rotation') * fx * fy,
    round: v('mask.round') / 100,
    feather: v('mask.feather'),
  };
}

function starPath(hw: number, hh: number) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.38 : 1;
    const t = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${(Math.cos(t) * r * hw).toFixed(1)},${(Math.sin(t) * r * hh).toFixed(1)}`);
  }
  return `M${pts.join('L')}Z`;
}

function heartPath(hw: number, hh: number) {
  const x = (u: number) => (u * hw).toFixed(1);
  const y = (u: number) => (u * hh).toFixed(1);
  return `M0,${y(0.95)} C${x(-0.15)},${y(0.75)} ${x(-1)},${y(0.25)} ${x(-1)},${y(-0.3)} C${x(-1)},${y(-0.85)} ${x(-0.35)},${y(-1.05)} 0,${y(-0.55)} C${x(0.35)},${y(-1.05)} ${x(1)},${y(-0.85)} ${x(1)},${y(-0.3)} C${x(1)},${y(0.25)} ${x(0.15)},${y(0.75)} 0,${y(0.95)}Z`;
}

/** Drawn over the preview canvas (same size, CSS pixels). k = canvas pixels per CSS pixel. */
export default function MaskOverlay({ k }: { k: number }) {
  const clipId = useMaskEdit((s) => s.clipId);
  const clip = useEditor((s) => (clipId ? (s.clips.find((c) => c.id === clipId) as MediaClip | undefined) : undefined));
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const [hit, setHit] = useState<HitBox | null>(null);
  const drag = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // follow the clip's box as the player redraws (zoom, moves, keyframes…)
  useEffect(() => {
    if (!clipId) return;
    let raf = 0;
    let last = '';
    const tick = () => {
      const h = player.hits.find((x) => x.clipId === clipId) ?? null;
      const key = h ? `${h.cx}|${h.cy}|${h.w}|${h.h}|${h.rotation}` : '';
      if (key !== last) {
        last = key;
        setHit(h ? { ...h } : null);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [clipId]);

  if (!clipId || !clip?.mask || playing) return null;
  if (!hit) {
    return (
      <div className="mask-overlay-hint">
        <span>Pon la aguja sobre el clip para ver la máscara</span>
      </div>
    );
  }

  const m = clip.mask;
  const g = geometry(hit, clip, time);
  const s = 1 / k; // canvas px → css px
  const cx = g.cx * s;
  const cy = g.cy * s;
  const hw = g.hw * s;
  const hh = g.hh * s;
  const box = m.shape !== 'linear' && m.shape !== 'mirror';

  /** Pointer in canvas px. */
  const at = (e: React.PointerEvent): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };
  /** Canvas-space vector → the mask's own axes (rotated with it). */
  const toMask = (p: Pt) => {
    const a = (g.rot * Math.PI) / 180;
    const dx = p.x - g.cx;
    const dy = p.y - g.cy;
    return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a) };
  };
  const set = (values: Record<string, number>) => useEditor.getState().setValues(clip.id, values, false);

  const begin = (e: React.PointerEvent, d: Drag) => {
    e.stopPropagation();
    e.preventDefault();
    svgRef.current!.setPointerCapture(e.pointerId);
    useEditor.getState().checkpoint(); // one undo step per drag
    drag.current = d;
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = at(e);
    if (d.kind === 'move') {
      // canvas delta → the clip's own axes → fraction of the clip box
      const a = -g.a;
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      set({ 'mask.x': clamp(d.x0 + (lx / hit.w) * g.fx, -1, 1), 'mask.y': clamp(d.y0 + (ly / hit.h) * g.fy, -1, 1) });
    } else if (d.kind === 'size') {
      const q = toMask(p);
      const values: Record<string, number> = {};
      let w = d.sx ? Math.abs(q.x) * 2 : null;
      let h = d.sy ? Math.abs(q.y) * 2 : null;
      if (w !== null && h !== null && (e.shiftKey || d.keepRatio)) {
        // ⇧ (or a circle / star / heart corner): keep the shape's proportions
        const f = Math.max(w / (g.hw * 2 || 1), h / (g.hh * 2 || 1));
        w = g.hw * 2 * f;
        h = g.hh * 2 * f;
      }
      if (w !== null) values['mask.w'] = clamp(w / hit.w, 0.01, 2);
      if (h !== null) values['mask.h'] = clamp(h / hit.h, 0.01, 2);
      set(values);
    } else if (d.kind === 'rotate') {
      let ang = (Math.atan2(p.y - g.cy, p.x - g.cx) * 180) / Math.PI + 90; // handle sits on top
      if (e.shiftKey) ang = Math.round(ang / 15) * 15;
      let r = (hit.rotation - ang) * g.fx * g.fy;
      r = ((((r + 180) % 360) + 360) % 360) - 180;
      if (!e.shiftKey) for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(r - snap) < 3) r = snap;
      set({ 'mask.rotation': r });
    } else {
      const q = toMask(p);
      const below = q.y - (box || m.shape === 'mirror' ? g.hh : 0) - FEATHER_GAP * k;
      set({ 'mask.feather': clamp(Math.round(below / (1.5 * k)), 0, 100) });
    }
  };
  const end = () => (drag.current = null);

  const handle = (x: number, y: number, cursor: string, d: () => Drag, key: string) => (
    <rect
      key={key}
      className="mask-handle"
      x={x - 5}
      y={y - 5}
      width={10}
      height={10}
      rx={2}
      style={{ cursor }}
      onPointerDown={(e) => begin(e, d())}
    />
  );
  const keepRatio = m.shape === 'circle' || m.shape === 'star' || m.shape === 'heart' ? 1 : 0;
  const featherY = (box || m.shape === 'mirror' ? hh : 0) + FEATHER_GAP + (g.feather * 1.5) / 1;
  const len = Math.hypot(hit.w, hit.h) * s; // long enough to cross the whole clip

  return (
    <svg
      ref={svgRef}
      className="mask-overlay"
      onPointerDown={(e) => {
        const p = at(e);
        begin(e, { kind: 'move', start: p, x0: valueAt(clip, 'mask.x', time), y0: valueAt(clip, 'mask.y', time) });
      }}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <title>Arrastra para mover la máscara</title>
      <g transform={`translate(${cx} ${cy}) rotate(${g.rot})`}>
        {m.shape === 'rect' && <rect className="mask-shape" x={-hw} y={-hh} width={hw * 2} height={hh * 2} rx={g.round * Math.min(hw, hh)} />}
        {m.shape === 'circle' && <ellipse className="mask-shape" rx={hw} ry={hh} />}
        {m.shape === 'star' && <path className="mask-shape" d={starPath(hw, hh)} />}
        {m.shape === 'heart' && <path className="mask-shape" d={heartPath(hw, hh)} />}
        {(m.shape === 'star' || m.shape === 'heart' || m.shape === 'circle') && <rect className="mask-bounds" x={-hw} y={-hh} width={hw * 2} height={hh * 2} />}
        {m.shape === 'linear' && (
          <>
            <line className="mask-shape" x1={-len} x2={len} y1={0} y2={0} />
            <path className="mask-side" d={`M-8,-10 L0,-20 L8,-10`} />
          </>
        )}
        {m.shape === 'mirror' && (
          <>
            <line className="mask-shape" x1={-len} x2={len} y1={-hh} y2={-hh} />
            <line className="mask-shape" x1={-len} x2={len} y1={hh} y2={hh} />
          </>
        )}
        {/* center */}
        <circle className="mask-center" r={4} />
        {/* turn */}
        <line className="mask-stem" x1={0} y1={box || m.shape === 'mirror' ? -hh : -12} x2={0} y2={(box || m.shape === 'mirror' ? -hh : -12) - ROT_GAP + 7} />
        <circle
          className="mask-rot"
          cy={(box || m.shape === 'mirror' ? -hh : -12) - ROT_GAP}
          r={7}
          onPointerDown={(e) => begin(e, { kind: 'rotate' })}
        >
          <title>Girar la máscara (⇧ = de 15 en 15°)</title>
        </circle>
        {/* soften the edge */}
        <g className="mask-feather" transform={`translate(0 ${featherY})`} onPointerDown={(e) => begin(e, { kind: 'feather' })}>
          <title>Arrastra hacia abajo para difuminar el borde</title>
          <circle r={9} className="hit" />
          <path d="M0,-4.5 L0,4.5 M-3,1.5 L0,4.5 L3,1.5" />
        </g>
        {/* size */}
        {box &&
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
          ].map(([sx, sy]) => handle(sx * hw, sy * hh, sx * sy > 0 ? 'nwse-resize' : 'nesw-resize', () => ({ kind: 'size', sx: 1, sy: 1, keepRatio }), `c${sx}${sy}`))}
        {box && handle(hw, 0, 'ew-resize', () => ({ kind: 'size', sx: 1, sy: 0, keepRatio: 0 }), 'r')}
        {box && handle(-hw, 0, 'ew-resize', () => ({ kind: 'size', sx: 1, sy: 0, keepRatio: 0 }), 'l')}
        {box && handle(0, hh, 'ns-resize', () => ({ kind: 'size', sx: 0, sy: 1, keepRatio: 0 }), 'b')}
        {m.shape === 'mirror' && handle(0, hh, 'ns-resize', () => ({ kind: 'size', sx: 0, sy: 1, keepRatio: 0 }), 'mb')}
      </g>
    </svg>
  );
}
