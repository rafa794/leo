import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  Loader2,
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical,
  ChevronLeft, ChevronRight, Diamond, Download, Combine, FolderInput, Waves, Snowflake, Rewind, FlipHorizontal2, FlipVertical2, Pipette, RotateCcw, RotateCw, Undo2, Ungroup, Upload,
} from 'lucide-react';
import { useEditor, MIN_CLIP, defaultAdjust } from '../store/editor';
import type { AnimName, BlendMode, ClipAnimation, Mask, MaskShape, MediaClip, Stabilization } from '../types';
import { cancelReverse, freezeFrame, onReverseJobs, reverseClip, reverseJob } from '../lib/clipTools';
import { STAB_DEFAULT, analyzeClip, cancelAnalysis, onStabJobs, stabCovers, stabJob, stabPath } from '../lib/stabilize';
import { onSegmenterChange, segmenterState, ensureSegmenter } from '../ai/segmenter';
import { clipHasAudio, sourceDuration } from '../lib/timeline';
import { useFxStatus } from '../ai/voice';
import type { AudioFx } from '../types';
import { TRANSFORM_KEYS, hasKeyAt, keyTimes, srcTime, timelineTime, valueAt } from '../lib/keyframes';
import { BUILTIN_LUTS, importCube, importedLuts, onLutsChange } from '../lib/gl';
import { player } from '../lib/player';
import { clamp } from '../lib/util';
import { isPickingColor, onColorPickChange, startColorPick } from './Preview';
import Range from './Range';
import { setMaskEdit } from './MaskOverlay';

/* =================== small building blocks =================== */

/** ‹ ◆ › — keyframes of one or more properties (CapCut style). */
function KeyBtns({ clip, paths }: { clip: MediaClip; paths: string[] }) {
  const time = useEditor((s) => s.time);
  const store = useEditor.getState();
  const inside = time >= clip.start && time < clip.start + clip.duration;
  const times = keyTimes(clip, paths).map((t) => timelineTime(clip, t));
  const s = srcTime(clip, time);
  const on = inside && paths.every((p) => hasKeyAt(clip, p, s));
  const some = inside && !on && paths.some((p) => hasKeyAt(clip, p, s));
  const prev = [...times].reverse().find((t) => t < time - 1e-3);
  const next = times.find((t) => t > time + 1e-3);
  const go = (t?: number) => t !== undefined && player.seek(t + 1e-4);
  return (
    <span className="kbtns">
      <button className="kb-nav" disabled={prev === undefined} title="Fotograma clave anterior" onClick={() => go(prev)}>
        <ChevronLeft size={13} />
      </button>
      <button
        className={`kb ${on ? 'on' : some ? 'some' : ''} ${times.length ? 'has' : ''}`}
        disabled={!inside}
        title={!inside ? 'Pon la aguja sobre este clip' : on ? 'Quitar fotograma clave' : 'Añadir fotograma clave aquí'}
        onClick={() => store.toggleKeys(clip.id, paths)}
      >
        <Diamond size={12} fill={on ? 'currentColor' : 'none'} />
      </button>
      <button className="kb-nav" disabled={next === undefined} title="Fotograma clave siguiente" onClick={() => go(next)}>
        <ChevronRight size={13} />
      </button>
    </span>
  );
}

/** Value of a (possibly keyframed) property, re-rendering while the playhead moves only if needed. */
function useValue(clip: MediaClip, path: string) {
  const time = useEditor((s) => (clip.keyframes?.[path]?.length ? s.time : 0));
  return valueAt(clip, path, time);
}

interface PropProps {
  clip: MediaClip;
  path: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  /** shown number = value * scale (e.g. 100 for %) */
  scale?: number;
  unit?: string;
  decimals?: number;
  keys?: boolean;
  /** slider uses a log scale (speed, scale) */
  log?: boolean;
}

/** Label · slider · number box · ‹◆›. Changes at the playhead become keyframes when the property is animated. */
function Prop({ clip, path, label, min, max, step, scale = 1, unit = '', decimals = 0, keys = true, log }: PropProps) {
  const v = useValue(clip, path);
  const store = useEditor.getState();
  const shown = v * scale;
  // min / max come in the value's own units (volume 0–2, mask −1…1); the slider and the box work in shown units (%)
  const lo = min * scale;
  const hi = max * scale;
  const set = (n: number, commit = false) => store.setValues(clip.id, { [path]: clamp(n, lo, hi) / scale }, commit);
  const toSlider = (x: number) => (log ? Math.log(Math.max(x, 1e-6)) : x);
  const fromSlider = (x: number) => (log ? Math.exp(x) : x);
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="prop">
      <div className="prop-head">
        <span>{label}</span>
        {keys && <KeyBtns clip={clip} paths={[path]} />}
      </div>
      <div className="prop-body">
        <Range
          tone={path === 'adjust.temp' ? 'temp' : path === 'adjust.tint' ? 'tint' : path === 'adjust.saturation' ? 'saturation' : undefined} min={toSlider(lo)}
          max={toSlider(hi)}
          step={log ? 0.001 : (step ?? 1)}
          value={toSlider(shown)}
          onPointerDown={() => store.checkpoint()}
          onKeyDown={() => store.checkpoint()}
          onChange={(e) => set(fromSlider(Number(e.target.value)))}
          onDoubleClick={() => set(path.startsWith('adjust.') ? 0 : shown, true)}
        />
        <span className="num">
          <input
            value={text ?? shown.toFixed(decimals)}
            onFocus={(e) => {
              setText(shown.toFixed(decimals));
              e.target.select();
            }}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              const n = Number(String(text).replace(',', '.'));
              if (text !== null && isFinite(n)) set(n, true);
              setText(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                e.preventDefault();
                const d = (step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
                set(shown + d, true);
                setText(null);
              }
            }}
          />
          {unit && <i>{unit}</i>}
        </span>
      </div>
    </div>
  );
}

function Group({ title, clip, paths, onReset, children, right }: { title: string; clip?: MediaClip; paths?: string[]; onReset?: () => void; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="group">
      <div className="group-head">
        <b>{title}</b>
        <span className="spacer" />
        {right}
        {onReset && (
          <button className="kb-nav" title="Restablecer" onClick={onReset}>
            <Undo2 size={13} />
          </button>
        )}
        {clip && paths && <KeyBtns clip={clip} paths={paths} />}
      </div>
      {children}
    </div>
  );
}

function Toggle({ on, title, hint, onClick, badge }: { on: boolean; title: string; hint?: string; onClick: () => void; badge?: string }) {
  return (
    <div className={`toggle ${on ? 'on' : ''}`} style={{ marginBottom: 10 }} onClick={onClick}>
      <div>
        <div style={{ fontWeight: 600 }}>
          {title} {badge && <span className="badge">{badge}</span>}
        </div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <div className="switch" />
    </div>
  );
}

function SubTabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="subtabs">
      {tabs.map(([id, label]) => (
        <button key={id} className={value === id ? 'active' : ''} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/* =================== Vídeo =================== */

const BLENDS: [BlendMode, string][] = [
  ['source-over', 'Normal'],
  ['multiply', 'Multiplicar'],
  ['screen', 'Trama'],
  ['overlay', 'Superponer'],
  ['soft-light', 'Luz suave'],
  ['hard-light', 'Luz fuerte'],
  ['darken', 'Oscurecer'],
  ['lighten', 'Aclarar'],
  ['color-dodge', 'Sobreexponer color'],
  ['color-burn', 'Subexponer color'],
  ['difference', 'Diferencia'],
  ['exclusion', 'Exclusión'],
  ['luminosity', 'Luminosidad'],
];

/** Size of the clip's picture relative to the canvas when scale = 1 (contain fit). */
function baseBox(clip: MediaClip) {
  const st = useEditor.getState();
  const m = st.media.find((x) => x.id === clip.mediaId);
  const W = st.settings.width;
  const H = st.settings.height;
  if (!m?.width || !m?.height) return { w: 1, h: 1, mw: W, mh: H };
  const fit = Math.min(W / m.width, H / m.height);
  return { w: (m.width * fit) / W, h: (m.height * fit) / H, mw: m.width, mh: m.height };
}

function VideoBasic({ clip, multi = false }: { clip: MediaClip; multi?: boolean }) {
  const store = useEditor.getState();
  const time = useEditor((s) => s.time);
  const rot = valueAt(clip, 'transform.rotation', time);
  const scale = valueAt(clip, 'transform.scale', time);
  const turn = (d: number) => {
    let r = Math.round(rot / 90) * 90 + d;
    r = ((((r + 180) % 360) + 360) % 360) - 180;
    store.setTransform(clip.id, { rotation: r });
  };
  // align the picture's edge with the frame's edge
  const align = (axis: 'x' | 'y', side: -1 | 0 | 1) => {
    const b = baseBox(clip);
    const rad = (rot * Math.PI) / 180;
    // size of the rotated picture
    const ww = Math.abs(b.w * Math.cos(rad)) * 1 + Math.abs(b.h * Math.sin(rad)) * (useEditor.getState().settings.height / useEditor.getState().settings.width);
    const hh = Math.abs(b.h * Math.cos(rad)) + Math.abs(b.w * Math.sin(rad)) * (useEditor.getState().settings.width / useEditor.getState().settings.height);
    const half = ((axis === 'x' ? ww : hh) * scale) / 2;
    store.setTransform(clip.id, { [axis]: side === 0 ? 0 : side * (0.5 - half) });
  };
  const cover = () => {
    const b = baseBox(clip);
    store.setTransform(clip.id, { scale: Math.max(1 / b.w, 1 / b.h), x: 0, y: 0 });
  };

  return (
    <>
      <Group
        title="Transformación"
        clip={clip}
        paths={TRANSFORM_KEYS}
        onReset={() => {
          store.checkpoint();
          store.editMedia(clip.id, (c) => ({ ...c, transform: { x: 0, y: 0, scale: 1, rotation: 0 }, flipX: false, flipY: false, keyframes: stripKeys(c, TRANSFORM_KEYS) }), false);
        }}
      >
        <Prop clip={clip} path="transform.scale" label="Escala" min={0.05} max={10} scale={100} unit="%" log />
        <Prop clip={clip} path="transform.x" label="Posición X" min={-2} max={2} step={0.5} scale={100} decimals={1} />
        <Prop clip={clip} path="transform.y" label="Posición Y" min={-2} max={2} step={0.5} scale={100} decimals={1} />
        <Prop clip={clip} path="transform.rotation" label="Girar" min={-180} max={180} unit="°" decimals={1} />
        <div className="btn-row">
          <button className="icon-btn" title="Girar 90° a la izquierda" onClick={() => turn(-90)}>
            <RotateCcw size={16} />
          </button>
          <button className="icon-btn" title="Girar 90° a la derecha" onClick={() => turn(90)}>
            <RotateCw size={16} />
          </button>
          <button className={`icon-btn ${clip.flipX ? 'active' : ''}`} title="Voltear en horizontal (espejo)" onClick={() => store.updateClip(clip.id, { flipX: !clip.flipX })}>
            <FlipHorizontal2 size={16} />
          </button>
          <button className={`icon-btn ${clip.flipY ? 'active' : ''}`} title="Voltear en vertical" onClick={() => store.updateClip(clip.id, { flipY: !clip.flipY })}>
            <FlipVertical2 size={16} />
          </button>
          <span className="spacer" />
          {clip.type !== 'compound' && (
            <button className="btn small" title="Rellenar toda la pantalla (horizontal → vertical)" onClick={cover}>
              Rellenar
            </button>
          )}
        </div>
        <div className="btn-row align">
          <button className="icon-btn" title="Alinear a la izquierda" onClick={() => align('x', -1)}>
            <AlignStartVertical size={16} />
          </button>
          <button className="icon-btn" title="Centrar en horizontal" onClick={() => align('x', 0)}>
            <AlignCenterVertical size={16} />
          </button>
          <button className="icon-btn" title="Alinear a la derecha" onClick={() => align('x', 1)}>
            <AlignEndVertical size={16} />
          </button>
          <button className="icon-btn" title="Alinear arriba" onClick={() => align('y', -1)}>
            <AlignStartHorizontal size={16} />
          </button>
          <button className="icon-btn" title="Centrar en vertical" onClick={() => align('y', 0)}>
            <AlignCenterHorizontal size={16} />
          </button>
          <button className="icon-btn" title="Alinear abajo" onClick={() => align('y', 1)}>
            <AlignEndHorizontal size={16} />
          </button>
        </div>
        <p className="hint" style={{ margin: '4px 0 0' }}>
          En el visor: arrastra para mover, esquinas para el tamaño y el círculo de arriba para girar. Dale a ▶ y arrastra para grabar el movimiento (seguir a un jugador).
        </p>
      </Group>

      <CropGroup clip={clip} />
      {clip.type === 'video' && !multi && <ClipToolsGroup clip={clip} />}
      {clip.type === 'video' && <StabilizeGroup clip={clip} />}

      <Group title="Mezcla" clip={clip} paths={['opacity']} onReset={() => store.updateClip(clip.id, { opacity: 1, blend: undefined, keyframes: stripKeys(clip, ['opacity']) })}>
        <Prop clip={clip} path="opacity" label="Opacidad" min={0} max={1} scale={100} unit="%" keys={false} />
        <div className="prop">
          <div className="prop-head">
            <span>Modo</span>
          </div>
          <select className="input" style={{ width: '100%' }} value={clip.blend ?? 'source-over'} onChange={(e) => store.updateClip(clip.id, { blend: e.target.value as BlendMode })}>
            {BLENDS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </Group>
    </>
  );
}

/** Recortar (crop): keep part of the picture. */
function CropGroup({ clip }: { clip: MediaClip }) {
  const store = useEditor.getState();
  const media = useEditor((s) => s.media.find((m) => m.id === clip.mediaId));
  const cr = clip.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const set = (patch: Partial<typeof cr>, commit = false) => {
    const next = { ...cr, ...patch };
    // never cut more than 90% in total on one axis
    next.l = clamp(next.l, 0, 0.9 - next.r);
    next.r = clamp(next.r, 0, 0.9 - next.l);
    next.t = clamp(next.t, 0, 0.9 - next.b);
    next.b = clamp(next.b, 0, 0.9 - next.t);
    const none = !next.l && !next.r && !next.t && !next.b;
    store.updateClip(clip.id, { crop: none ? undefined : next }, commit);
  };
  // centered crop to an aspect ratio
  const ratio = (rw: number, rh: number) => {
    const A = media?.width && media?.height ? media.width / media.height : 16 / 9;
    const R = rw / rh;
    if (R < A) {
      const cut = (1 - R / A) / 2;
      set({ l: cut, r: cut, t: 0, b: 0 }, true);
    } else {
      const cut = (1 - A / R) / 2;
      set({ l: 0, r: 0, t: cut, b: cut }, true);
    }
  };
  const side = (key: 'l' | 'r' | 't' | 'b', label: string) => (
    <div className="prop">
      <div className="prop-head">
        <span>{label}</span>
        <b>{Math.round(cr[key] * 100)}%</b>
      </div>
      <Range min={0} max={90} value={Math.round(cr[key] * 100)} onPointerDown={() => store.checkpoint()} onChange={(e) => set({ [key]: Number(e.target.value) / 100 })} />
    </div>
  );
  return (
    <Group title="Recortar" onReset={clip.crop ? () => store.updateClip(clip.id, { crop: undefined }) : undefined}>
      <div className="chips" style={{ marginBottom: 10 }}>
        {(
          [
            ['16:9', 16, 9],
            ['9:16', 9, 16],
            ['1:1', 1, 1],
            ['4:5', 4, 5],
            ['4:3', 4, 3],
          ] as const
        ).map(([label, a, b]) => (
          <button key={label} className="chip" onClick={() => ratio(a, b)} title={`Recortar al centro en ${label}`}>
            {label}
          </button>
        ))}
      </div>
      <div className="row">
        {side('l', 'Izquierda')}
        {side('r', 'Derecha')}
      </div>
      <div className="row">
        {side('t', 'Arriba')}
        {side('b', 'Abajo')}
      </div>
    </Group>
  );
}

/** Congelar fotograma / Revertir. */
function ClipToolsGroup({ clip }: { clip: MediaClip }) {
  const [, force] = useState(0);
  useEffect(() => onReverseJobs(() => force((n) => n + 1)), []);
  const job = reverseJob(clip.id);
  const inside = useEditor((s) => s.time >= clip.start && s.time < clip.start + clip.duration);
  return (
    <Group title="Herramientas">
      <div className="btn-row" style={{ marginBottom: job ? 8 : 0 }}>
        <button className="btn small" disabled={!inside} title={inside ? 'Congela la imagen de la aguja 3 segundos' : 'Pon la aguja sobre este clip'} onClick={() => void freezeFrame(3)}>
          <Snowflake size={13} /> Congelar fotograma
        </button>
        <button
          className={`btn small ${clip.reversedFrom ? 'primary' : ''}`}
          disabled={!!job}
          title={clip.reversedFrom ? 'Volver a reproducirlo hacia delante' : 'Reproducir el clip hacia atrás'}
          onClick={() => void reverseClip(clip.id)}
        >
          <Rewind size={13} /> {clip.reversedFrom ? 'Revertido · deshacer' : 'Revertir'}
        </button>
      </div>
      {job && (
        <>
          <div className="prop-head">
            <span>{job.label}</span>
            <button className="btn small" onClick={() => cancelReverse(clip.id)}>
              Cancelar
            </button>
          </div>
          <div className="progress">
            <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
        </>
      )}
    </Group>
  );
}

/** Estabilización: analyze the camera shake once, then smooth / lock the camera. */
function StabilizeGroup({ clip }: { clip: MediaClip }) {
  const store = useEditor.getState();
  const [, force] = useState(0);
  useEffect(() => onStabJobs(() => force((n) => n + 1)), []);
  const job = stabJob(clip.id);
  const st = clip.stab;
  const path = st?.data ? stabPath(st) : null;
  const set = (patch: Partial<Stabilization>, commit = true) => store.updateClip(clip.id, { stab: { ...(st ?? STAB_DEFAULT), ...patch } }, commit);
  const start = () => {
    if (!st) set({ ...STAB_DEFAULT });
    void analyzeClip(clip.id);
  };
  const MODES: [string, string, Partial<Stabilization>][] = [
    ['Suave', 'Quita el temblor y sigue los movimientos de la cámara', { mode: 'smooth', strength: 35 }],
    ['Fuerte', 'Movimientos de cámara muy suaves', { mode: 'smooth', strength: 80 }],
    ['Cámara fija', 'Como si estuviera en un trípode (ideal para la cámara fija del campo)', { mode: 'tripod' }],
  ];
  const active = (m: Partial<Stabilization>) => st?.mode === m.mode && (m.mode === 'tripod' || Math.abs((st?.strength ?? 0) - (m.strength ?? 0)) < 1);

  return (
    <Group
      title="Estabilización"
      right={
        st?.data && !job ? (
          <label className="check" title="Desactívalo un momento para comparar">
            <input type="checkbox" checked={st.on} onChange={() => set({ on: !st.on })} /> Activada
          </label>
        ) : undefined
      }
    >
      {job && !job.error ? (
        <>
          <div className="prop-head">
            <span>Analizando el movimiento de la cámara…</span>
            <b>{Math.round(job.progress * 100)}%</b>
          </div>
          <div className="progress" style={{ marginBottom: 8 }}>
            <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <div className="btn-row">
            <button className="btn small" onClick={() => cancelAnalysis(clip.id)}>
              Cancelar
            </button>
            <span className="hint">Solo se hace una vez por clip. Puedes seguir editando mientras tanto.</span>
          </div>
        </>
      ) : !st?.data ? (
        <>
          {job?.error && <p className="hint" style={{ color: 'var(--danger)', marginTop: 0 }}>{job.error}</p>}
          <button className="btn small primary" onClick={start}>
            <Waves size={14} /> {job?.error ? 'Reintentar' : 'Estabilizar'}
          </button>
          <p className="hint" style={{ marginBottom: 0 }}>
            Quita el temblor de la cámara (viento, manos, golpes en el soporte). Sigue los puntos del fondo y no se deja engañar por los jugadores ni el balón.
          </p>
        </>
      ) : (
        <>
          <div className="chips" style={{ marginBottom: 10 }}>
            {MODES.map(([label, hint, m]) => (
              <button key={label} title={hint} className={`chip ${active(m) ? 'active' : ''}`} onClick={() => set({ ...m, on: true })}>
                {label}
              </button>
            ))}
          </div>
          {st.mode === 'smooth' && (
            <div className="prop">
              <div className="prop-head">
                <span>Suavidad</span>
                <b>{st.strength}</b>
              </div>
              <Range min={0} max={100} value={st.strength} onPointerDown={() => store.checkpoint()} onChange={(e) => set({ strength: Number(e.target.value) }, false)} />
            </div>
          )}
          <div className="prop">
            <div className="prop-head">
              <span title="Zoom para que no se vean los bordes al corregir. Más recorte = puede corregir temblores más grandes">Recorte (zoom)</span>
              <b>{st.crop}%</b>
            </div>
            <Range min={0} max={30} value={st.crop} onPointerDown={() => store.checkpoint()} onChange={(e) => set({ crop: Number(e.target.value) }, false)} />
          </div>
          {path && (
            <p className="hint" style={{ margin: '0 0 8px' }}>
              Elimina ~{Math.round(path.removed * 100)}% del temblor medido.{path.removed < 0.5 && st.crop < 15 ? ' Sube el recorte para corregir más.' : ''}
            </p>
          )}
          {!stabCovers(clip) && (
            <p className="hint" style={{ color: '#fbbf24', margin: '0 0 8px' }}>
              Has alargado el clip más allá de lo analizado: vuelve a analizarlo.
            </p>
          )}
          <div className="btn-row" style={{ marginBottom: 0 }}>
            <button className="btn small" onClick={() => void analyzeClip(clip.id)} title="Volver a medir el movimiento (por ejemplo, tras alargar el clip)">
              Volver a analizar
            </button>
            <button className="btn small" onClick={() => store.updateClip(clip.id, { stab: undefined })}>
              Quitar
            </button>
          </div>
        </>
      )}
    </Group>
  );
}

function stripKeys(c: MediaClip, paths: string[]) {
  if (!c.keyframes) return undefined;
  const kf = { ...c.keyframes };
  paths.forEach((p) => delete kf[p]);
  return Object.keys(kf).length ? kf : undefined;
}
const prefixed = (c: MediaClip, prefix: string) => Object.keys(c.keyframes ?? {}).filter((p) => p.startsWith(prefix));

function VideoBackground({ clip }: { clip: MediaClip }) {
  const store = useEditor.getState();
  const [segState, setSegState] = useState(segmenterState());
  useEffect(() => onSegmenterChange(() => setSegState(segmenterState())), []);
  const [picking, setPicking] = useState(isPickingColor());
  useEffect(() => onColorPickChange(() => setPicking(isPickingColor())), []);
  useEffect(() => () => startColorPick(null), []);
  const ch = clip.chroma ?? { on: false, color: '#00b140', intensity: 30, shadow: 20 };
  const setCh = (patch: Partial<typeof ch>) => store.updateClip(clip.id, { chroma: { ...ch, ...patch } });
  const chromaPaths = ['chroma.intensity', 'chroma.shadow'];
  return (
    <>
      <Toggle
        on={clip.removeBg}
        title="Quitar fondo automático"
        badge="IA"
        hint="Detecta a las personas y elimina lo que hay detrás (gratis, en tu equipo)"
        onClick={() => {
          if (!clip.removeBg) ensureSegmenter().catch(() => {});
          store.updateClip(clip.id, { removeBg: !clip.removeBg });
        }}
      />
      {clip.removeBg && segState === 'loading' && <p className="hint">Cargando modelo de IA…</p>}
      {clip.removeBg && segState === 'error' && <p className="hint" style={{ color: 'var(--danger)' }}>No se pudo cargar el modelo (¿sin conexión?).</p>}

      <Group
        title="Chroma key"
        clip={ch.on ? clip : undefined}
        paths={chromaPaths}
        right={
          <label className="check">
            <input type="checkbox" checked={ch.on} onChange={() => setCh({ on: !ch.on })} /> Activar
          </label>
        }
      >
        <p className="hint" style={{ marginTop: 0 }}>
          Quita un color de fondo (pantalla verde o azul) para poner otra cosa debajo.
        </p>
        <div className="btn-row">
          <input type="color" value={ch.color} style={{ width: 44, flex: 'none' }} onChange={(e) => setCh({ color: e.target.value, on: true })} />
          <button
            className={`btn small ${picking ? 'primary' : ''}`}
            onClick={() => startColorPick(picking ? null : (hex) => store.updateClip(clip.id, { chroma: { ...(useEditorClip(clip.id)?.chroma ?? ch), color: hex, on: true } }))}
          >
            <Pipette size={13} /> {picking ? 'Haz clic en el visor…' : 'Elegir color del visor'}
          </button>
        </div>
        {ch.on && (
          <>
            <Prop clip={clip} path="chroma.intensity" label="Intensidad" min={0} max={100} keys={false} />
            <Prop clip={clip} path="chroma.shadow" label="Suavizar bordes" min={0} max={100} keys={false} />
          </>
        )}
      </Group>
    </>
  );
}

const useEditorClip = (id: string) => useEditor.getState().clips.find((c) => c.id === id) as MediaClip | undefined;

const MASKS: [MaskShape | 'none', string, string][] = [
  ['none', 'Ninguna', '∅'],
  ['linear', 'Dividir', '◧'],
  ['mirror', 'Franja', '▤'],
  ['circle', 'Círculo', '●'],
  ['rect', 'Rectángulo', '■'],
  ['star', 'Estrella', '★'],
  ['heart', 'Corazón', '♥'],
];
const MASK_PATHS = ['mask.x', 'mask.y', 'mask.w', 'mask.h', 'mask.rotation', 'mask.feather', 'mask.round'];

function VideoMask({ clip }: { clip: MediaClip }) {
  const store = useEditor.getState();
  const m = clip.mask;
  // while this panel is open, the viewer edits the mask (drag, resize, turn) instead of the clip
  useEffect(() => {
    setMaskEdit(clip.id);
    return () => setMaskEdit(null);
  }, [clip.id]);
  const choose = (shape: MaskShape | 'none') => {
    if (shape === 'none') {
      store.updateClip(clip.id, { mask: undefined, keyframes: stripKeys(clip, MASK_PATHS) });
      return;
    }
    const b = baseBox(clip);
    const ar = b.mw / b.mh; // picture aspect: make round shapes round
    const h = shape === 'mirror' ? 0.4 : 0.6;
    const w = shape === 'linear' || shape === 'mirror' ? 1 : Math.min(1, h / ar);
    const next: Mask = { shape, x: m?.x ?? 0, y: m?.y ?? 0, w, h, rotation: m?.rotation ?? 0, feather: m?.feather ?? 5, round: m?.round ?? 20, invert: m?.invert ?? false };
    store.updateClip(clip.id, { mask: next });
  };
  return (
    <>
      <div className="shape-grid">
        {MASKS.map(([id, label, glyph]) => (
          <button key={id} className={`shape ${(m?.shape ?? 'none') === id ? 'active' : ''}`} onClick={() => choose(id)}>
            <span>{glyph}</span>
            {label}
          </button>
        ))}
      </div>
      {m && (
        <Group
          title="Máscara"
          clip={clip}
          paths={MASK_PATHS}
          right={
            <label className="check">
              <input type="checkbox" checked={m.invert} onChange={() => store.updateClip(clip.id, { mask: { ...m, invert: !m.invert } })} /> Invertir
            </label>
          }
        >
          <Prop clip={clip} path="mask.x" label="Posición X" min={-1} max={1} scale={100} keys={false} />
          <Prop clip={clip} path="mask.y" label="Posición Y" min={-1} max={1} scale={100} keys={false} />
          {m.shape !== 'linear' && m.shape !== 'mirror' && <Prop clip={clip} path="mask.w" label="Ancho" min={0.01} max={2} scale={100} unit="%" keys={false} />}
          {m.shape !== 'linear' && <Prop clip={clip} path="mask.h" label={m.shape === 'mirror' ? 'Grosor' : 'Alto'} min={0.01} max={2} scale={100} unit="%" keys={false} />}
          <Prop clip={clip} path="mask.rotation" label="Girar" min={-180} max={180} unit="°" keys={false} />
          <Prop clip={clip} path="mask.feather" label="Difuminar borde" min={0} max={100} keys={false} />
          {m.shape === 'rect' && <Prop clip={clip} path="mask.round" label="Esquinas redondeadas" min={0} max={100} keys={false} />}
          <p className="hint" style={{ margin: 0 }}>
            Truco: un círculo con borde difuminado sobre el jugador y ◆ para que le siga.
          </p>
        </Group>
      )}
    </>
  );
}

/* =================== Audio =================== */

const FX_OPTIONS: [AudioFx, string, string][] = [
  ['none', 'Original', 'Audio tal cual'],
  ['isolate', 'Aislar voz', 'Quita el ruido de fondo y deja la voz'],
  ['remove-voice', 'Quitar voz', 'Quita la voz y deja el ambiente (beta)'],
];

/** Real progress of "Aislar voz" / "Quitar voz" (the AI goes through the audio once, then it's instant). */
function VoiceFxStatus({ status, hasAudio, hint }: { status: ReturnType<typeof useFxStatus>; hasAudio: boolean; hint: string }) {
  if (!hasAudio) return <p className="hint">Este clip no tiene audio.</p>;
  if (status?.status === 'ready')
    return (
      <p className="hint fx-done">
        <Check size={13} /> Listo. {hint}
      </p>
    );
  if (status?.status === 'error') return <p className="hint" style={{ color: 'var(--danger)' }}>No se pudo procesar el audio (máximo 30 min por clip).</p>;
  const pct = status ? Math.round(status.progress * 100) : null;
  return (
    <div className="fx-progress-box" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      <div className="fx-progress-head">
        <Loader2 size={13} className="spin" />
        <span>{pct === null ? 'Preparando…' : 'Procesando el audio con IA…'}</span>
        <span className="spacer" />
        {pct !== null && <b className="pct">{pct} %</b>}
      </div>
      <div className={`progress ${pct === null ? 'indeterminate' : ''}`}>
        <div style={{ width: `${pct ?? 30}%` }} />
      </div>
      <p className="hint" style={{ margin: 0 }}>
        Mientras tanto suena el audio original.
      </p>
    </div>
  );
}

function AudioTab({ clip }: { clip: MediaClip }) {
  const store = useEditor.getState();
  const fx = clip.audioFx ?? 'none';
  const hasAudio = useEditor((s) => !!s.media.find((m) => m.id === clip.mediaId)?.hasAudio);
  const vfx = useFxStatus(clip.mediaId, fx);
  return (
    <>
      <Group title="Básico" clip={clip} paths={['volume']} onReset={() => store.updateClip(clip.id, { volume: 1, fadeIn: 0, fadeOut: 0, keyframes: stripKeys(clip, ['volume']) })}>
        <Toggle on={!!clip.muted} title="Quitar audio" hint="Silencia este clip (M)" onClick={() => store.toggleMute([clip.id])} />
        <Prop clip={clip} path="volume" label="Volumen" min={0} max={2} scale={100} unit="%" keys={false} />
        <Prop clip={clip} path="fadeIn" label="Aparición progresiva" min={0} max={Math.min(10, clip.duration / 2)} step={0.1} decimals={1} unit="s" keys={false} />
        <Prop clip={clip} path="fadeOut" label="Desaparición progresiva" min={0} max={Math.min(10, clip.duration / 2)} step={0.1} decimals={1} unit="s" keys={false} />
        <p className="hint" style={{ margin: 0 }}>
          Con ◆ puedes bajar la música en un momento (cuando habla alguien) y volver a subirla.
        </p>
      </Group>
      <Group title="Voz">
        <div className="chips">
          {FX_OPTIONS.map(([id, label, hint]) => (
            <button key={id} title={hint} className={`chip ${fx === id ? 'active' : ''}`} onClick={() => store.setAudioFx([clip.id], id)}>
              {label} {id !== 'none' && <span className="badge">IA</span>}
            </button>
          ))}
        </div>
        {fx !== 'none' && <VoiceFxStatus status={vfx} hasAudio={hasAudio || clip.type === 'compound'} hint={FX_OPTIONS.find((f) => f[0] === fx)?.[2] ?? ''} />}
      </Group>
    </>
  );
}

/* =================== Velocidad =================== */

const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 10];

function SpeedTab({ clip }: { clip: MediaClip }) {
  const store = useEditor.getState();
  const media = useEditor((s) => s.media.find((m) => m.id === clip.mediaId));
  const setSpeed = (speed: number, commit = true) => {
    speed = clamp(Math.round(speed * 100) / 100, 0.1, 10);
    // keep the same piece of the source; clamp to the source length
    const srcLen = clip.duration * clip.speed;
    let duration = srcLen / speed;
    const max = sourceDuration(clip, media);
    if (isFinite(max)) duration = Math.min(duration, (max - clip.trimStart) / speed);
    store.updateClip(clip.id, { speed, duration: Math.max(MIN_CLIP, duration) }, commit);
  };
  return (
    <>
      <Group title="Estándar" onReset={() => setSpeed(1)}>
        <div className="prop">
          <div className="prop-head">
            <span>Velocidad</span>
            <b>{clip.speed.toFixed(2)}x</b>
          </div>
          <Range min={Math.log(0.1)}
            max={Math.log(10)}
            step={0.001}
            value={Math.log(clip.speed)}
            onPointerDown={() => store.checkpoint()}
            onChange={(e) => setSpeed(Math.exp(Number(e.target.value)), false)}
          />
        </div>
        <div className="chips" style={{ marginBottom: 10 }}>
          {SPEEDS.map((s) => (
            <button key={s} className={`chip ${Math.abs(clip.speed - s) < 0.001 ? 'active' : ''}`} onClick={() => setSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
        <div className="prop-head">
          <span>Duración</span>
          <b>
            {(clip.duration * clip.speed).toFixed(1)}s → {clip.duration.toFixed(1)}s
          </b>
        </div>
        <p className="hint">0.5x o 0.25x = cámara lenta para repetir el gol. 2x–10x para resumir jugadas largas.</p>
      </Group>
    </>
  );
}

/* =================== Animación =================== */

const IN_OUT: [AnimName, string, string][] = [
  ['fade', 'Fundido', '◐'],
  ['zoom-in', 'Acercar', '⊕'],
  ['zoom-out', 'Alejar', '⊖'],
  ['zoom-blur', 'Zoom borroso', '◎'],
  ['shrink', 'Encoger', '⤡'],
  ['pop', 'Rebote', '✦'],
  ['elastic', 'Elástico', '❋'],
  ['slide-left', 'Deslizar ←', '←'],
  ['slide-right', 'Deslizar →', '→'],
  ['slide-up', 'Deslizar ↑', '↑'],
  ['slide-down', 'Deslizar ↓', '↓'],
  ['rise', 'Subir suave', '⇡'],
  ['drop', 'Caída', '⤓'],
  ['wipe-left', 'Barrido ←', '◧'],
  ['wipe-right', 'Barrido →', '◨'],
  ['wipe-up', 'Barrido ↑', '⬒'],
  ['wipe-down', 'Barrido ↓', '⬓'],
  ['iris', 'Círculo', '◯'],
  ['flip-x', 'Voltear', '⇋'],
  ['flip-y', 'Voltear vertical', '⇵'],
  ['squeeze', 'Aplastar', '⇔'],
  ['spin', 'Girar', '↻'],
  ['rotate-in', 'Rotar 90°', '⟲'],
  ['tilt', 'Inclinar', '⟋'],
  ['swing', 'Balanceo', '〰'],
  ['blur', 'Desenfoque', '◌'],
  ['flash', 'Destello', '✸'],
  ['glitch', 'Glitch', '▚'],
];
const LOOPS: [AnimName, string, string][] = [
  ['ken-burns', 'Zoom lento', '⊕'],
  ['zoom-out', 'Alejar lento', '⊖'],
  ['pan-lr', 'Paneo', '⇄'],
  ['shake', 'Temblor', '≋'],
  ['pulse', 'Latido suave', '◉'],
  ['heartbeat', 'Corazón', '♥'],
  ['float', 'Flotar', '☁'],
  ['sway', 'Vaivén', '〰'],
  ['wiggle', 'Bailar', '♪'],
  ['jelly', 'Gelatina', '◍'],
  ['spin', 'Girar', '↻'],
  ['spin3d', 'Giro 3D', '⟳'],
  ['blink', 'Parpadeo', '◑'],
  ['glitch-loop', 'Glitch', '▚'],
];

let lastAnimTab: 'in' | 'out' | 'loop' = 'in';

function AnimTab({ clip }: { clip: MediaClip }) {
  const store = useEditor.getState();
  const [tab, setTab] = useState(lastAnimTab);
  lastAnimTab = tab;
  const key = tab === 'in' ? 'animIn' : tab === 'out' ? 'animOut' : 'animLoop';
  const cur = clip[key] as ClipAnimation | undefined;
  const list = tab === 'loop' ? LOOPS : IN_OUT;
  const maxDur = Math.max(0.1, Math.min(5, clip.duration));
  const preview = (a: ClipAnimation | undefined) => {
    if (!a) return;
    const from = tab === 'out' ? Math.max(clip.start, clip.start + clip.duration - a.duration - 0.4) : clip.start;
    const len = tab === 'loop' ? Math.min(clip.duration, 3) : a.duration + 0.4;
    player.seek(from);
    player.play();
    setTimeout(() => useEditor.getState().playing && player.pause(), len * 1000);
  };
  const choose = (name: AnimName | null) => {
    const a = name ? { name, duration: cur?.duration ?? (tab === 'loop' ? 1 : Math.min(0.6, maxDur)) } : undefined;
    store.updateClip(clip.id, { [key]: a } as Partial<MediaClip>);
    preview(a);
  };
  return (
    <>
      <SubTabs
        tabs={[
          ['in', 'Entrada'],
          ['out', 'Salida'],
          ['loop', 'Combinado'],
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="shape-grid">
        <button className={`shape ${!cur ? 'active' : ''}`} onClick={() => choose(null)}>
          <span>∅</span>
          Ninguna
        </button>
        {list.map(([id, label, glyph]) => (
          <button key={id} className={`shape ${cur?.name === id ? 'active' : ''}`} onClick={() => choose(id)}>
            <span>{glyph}</span>
            {label}
          </button>
        ))}
      </div>
      {cur && (
        <div className="prop">
          <div className="prop-head">
            <span>{tab === 'loop' ? 'Ritmo (segundos por ciclo)' : 'Duración'}</span>
            <b>{cur.duration.toFixed(1)}s</b>
          </div>
          <Range min={0.1}
            max={tab === 'loop' ? 5 : maxDur}
            step={0.1}
            value={cur.duration}
            onPointerDown={() => store.checkpoint()}
            onChange={(e) => store.updateClip(clip.id, { [key]: { ...cur, duration: Number(e.target.value) } } as Partial<MediaClip>, false)}
            onPointerUp={() => preview(useEditorClip(clip.id)?.[key] as ClipAnimation | undefined)}
          />
        </div>
      )}
      <p className="hint">Al elegir una animación se reproduce para que la veas. «Combinado» dura todo el clip.</p>
    </>
  );
}

/* =================== Ajustar =================== */

const ADJ: [keyof MediaClip['adjust'], string, number, number][] = [
  ['temp', 'Temperatura', -100, 100],
  ['tint', 'Tinte', -100, 100],
  ['saturation', 'Saturación', -100, 100],
  ['vibrance', 'Intensidad', -100, 100],
  ['brightness', 'Brillo', -100, 100],
  ['contrast', 'Contraste', -100, 100],
  ['highlights', 'Resaltados', -100, 100],
  ['shadows', 'Sombras', -100, 100],
  ['whites', 'Blancos', -100, 100],
  ['blacks', 'Negros', -100, 100],
  ['fade', 'Atenuar', 0, 100],
  ['vignette', 'Viñeta', 0, 100],
  ['sharpen', 'Nitidez', 0, 100],
  ['blur', 'Desenfoque', 0, 30],
];
const ADJ_PATHS = ADJ.map(([k]) => `adjust.${k}`);

function AdjustTab({ clip }: { clip: MediaClip }) {
  const store = useEditor.getState();
  const [, force] = useState(0);
  useEffect(() => onLutsChange(() => force((n) => n + 1)), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const lut = clip.lut;
  const setLut = (id: string) => {
    if (!id) return store.updateClip(clip.id, { lut: undefined, keyframes: stripKeys(clip, ['lut.intensity']) });
    const name = BUILTIN_LUTS.find((l) => l[0] === id)?.[1] ?? importedLuts.get(id) ?? id;
    store.updateClip(clip.id, { lut: { id, name, intensity: lut?.intensity ?? 100 } });
  };
  const applyToAll = () => {
    const st = useEditor.getState();
    st.checkpoint();
    const tracksVisual = new Set(st.tracks.filter((t) => t.kind === 'video').map((t) => t.id));
    st.clips.forEach((c) => {
      if (c.id === clip.id || c.type === 'text' || c.type === 'audio' || !tracksVisual.has(c.trackId)) return;
      st.updateClip(c.id, { adjust: { ...clip.adjust }, lut: clip.lut ? { ...clip.lut } : undefined }, false);
    });
    st.setStatus('Color aplicado a todos los clips de vídeo');
  };
  return (
    <>
      <Group
        title="LUT (estilo de color)"
        clip={lut ? clip : undefined}
        paths={['lut.intensity']}
        onReset={lut ? () => setLut('') : undefined}
      >
        <div className="btn-row">
          <select className="input" style={{ flex: 1, minWidth: 0 }} value={lut?.id ?? ''} onChange={(e) => setLut(e.target.value)}>
            <option value="">Ninguno</option>
            <optgroup label="Incluidos">
              {BUILTIN_LUTS.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </optgroup>
            {importedLuts.size > 0 && (
              <optgroup label="Importados">
                {[...importedLuts].map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="btn small" title="Importar un LUT .cube (hay muchos gratis en internet)" onClick={() => fileRef.current?.click()}>
            <Upload size={13} /> .cube
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".cube"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                setLut(await importCube(f));
              } catch (err) {
                store.setStatus(err instanceof Error ? err.message : 'LUT no válido');
              }
            }}
          />
        </div>
        {lut && <Prop clip={clip} path="lut.intensity" label="Intensidad" min={0} max={100} keys={false} />}
      </Group>

      <Group title="Ajustar" clip={clip} paths={ADJ_PATHS} onReset={() => store.updateClip(clip.id, { adjust: defaultAdjust(), keyframes: stripKeys(clip, prefixed(clip, 'adjust.')) })}>
        {ADJ.map(([k, label, min, max]) => (
          <Prop key={k} clip={clip} path={`adjust.${k}`} label={label} min={min} max={max} />
        ))}
        <p className="hint" style={{ margin: 0 }}>
          Doble clic en un control lo devuelve a 0. Cada uno tiene su ◆ para cambiar el color a lo largo del clip (por ejemplo, cuando se pone el sol).
        </p>
      </Group>
      <div className="btn-row">
        <button className="btn small" onClick={applyToAll} title="Copia este color (ajustes y LUT) a todos los clips de vídeo">
          Aplicar a todo
        </button>
      </div>
    </>
  );
}

/* =================== shell =================== */

export type MainTab = 'video' | 'audio' | 'speed' | 'anim' | 'adjust';
export type VideoTab = 'basic' | 'bg' | 'mask';
let lastMain: MainTab = 'video';
let lastVideo: VideoTab = 'basic';

/**
 * Properties of a video / photo / audio clip. On phones a tool can open just one part of it:
 * `only` shows a single tab (no tab bar) and `videoSub` picks Básico / Quitar fondo / Máscara.
 */
export default function MediaInspector({ clip, multi, only, videoSub }: { clip: MediaClip; multi?: number; only?: MainTab; videoSub?: VideoTab }) {
  const hasAudio = useEditor((s) => clipHasAudio(clip, s.media));
  const media = useEditor((s) => s.media.find((m) => m.id === clip.mediaId));
  const visual = clip.type !== 'audio';
  const tabs: [MainTab, string][] = [];
  if (visual) tabs.push(['video', clip.type === 'image' ? 'Imagen' : 'Vídeo']);
  if (hasAudio || clip.type === 'audio') tabs.push(['audio', 'Audio']);
  if (clip.type !== 'image') tabs.push(['speed', 'Velocidad']);
  if (visual) tabs.push(['anim', 'Animación'], ['adjust', 'Ajustar']);
  const [main, setMain] = useState<MainTab>(tabs.some((t) => t[0] === lastMain) ? lastMain : tabs[0][0]);
  const [vt0, setVt] = useState<VideoTab>(lastVideo);
  // several clips: only what makes sense for all of them (no background removal, mask or tools)
  const vt: VideoTab = multi ? 'basic' : (videoSub ?? vt0);
  const active = only ?? (tabs.some((t) => t[0] === main) ? main : tabs[0][0]);
  if (!only) lastMain = active;
  if (!multi && !videoSub) lastVideo = vt;
  const store = useEditor.getState();
  const keyCount = keyTimes(clip).length;

  return (
    <>
      <div className="main-tabs" hidden={!!only}>
        {tabs.map(([id, label]) => (
          <button key={id} className={active === id ? 'active' : ''} onClick={() => setMain(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className={`panel-body insp-body ${multi ? 'multi' : ''}`}>
        {multi ? (
          <div className="multi-note">
            <b>{multi} clips seleccionados</b>
            <span className="hint">Lo que cambies aquí se aplica a todos. Se muestran los valores del primero.</span>
          </div>
        ) : clip.type !== 'compound' && keyCount === 0 ? null : (
        // the clip's name is already in the header above: here only what adds something
        <div className="hint insp-name">
          {clip.type === 'compound' ? `${clip.compound?.clips.length ?? 0} clips dentro` : `${keyCount} fotogramas clave`}
          {keyCount > 0 && (
            <button className="link" title="Quitar todos los fotogramas clave de este clip" onClick={() => store.clearKeys(clip.id)}>
              <Diamond size={11} /> quitar todos
            </button>
          )}
        </div>
        )}
        {clip.type === 'compound' && !multi && (
          <div className="btn-row" style={{ marginBottom: 10 }}>
            <button className="btn small primary" onClick={() => store.enterCompound(clip.id)} title="Abre su propia línea de tiempo (también con doble clic en el clip)">
              <FolderInput size={13} /> Editar contenido
            </button>
            <button className="btn small" onClick={() => store.ungroupCompound(clip.id)} title="Separar de nuevo en los clips originales">
              <Ungroup size={13} /> Deshacer combinado
            </button>
          </div>
        )}

        {active === 'video' && (
          <>
            {!multi && !videoSub && (
              <SubTabs
                tabs={[
                  ['basic', 'Básico'],
                  ['bg', 'Quitar fondo'],
                  ['mask', 'Máscara'],
                ]}
                value={vt}
                onChange={setVt}
              />
            )}
            {vt === 'basic' && <VideoBasic clip={clip} multi={!!multi} />}
            {vt === 'bg' && <VideoBackground clip={clip} />}
            {vt === 'mask' && <VideoMask clip={clip} />}
          </>
        )}
        {active === 'audio' && <AudioTab clip={clip} />}
        {active === 'speed' && <SpeedTab clip={clip} />}
        {active === 'anim' && <AnimTab clip={clip} />}
        {active === 'adjust' && <AdjustTab clip={clip} />}

        <div className="section" hidden={!!only}>
          {multi ? (
            <div className="btn-row">
              <button className="btn small" onClick={() => store.createCompound()} title="Juntarlos en un solo clip">
                <Combine size={13} /> Crear clip combinado
              </button>
              <button className="btn small" onClick={() => store.requestExport({ clipIds: store.selectedIds })}>
                <Download size={13} /> Exportar los {multi}
              </button>
            </div>
          ) : (
            <button className="btn small block" onClick={() => store.requestExport({ clipId: clip.id })}>
              <Download size={13} /> Exportar solo este clip
            </button>
          )}
        </div>
      </div>
    </>
  );
}

