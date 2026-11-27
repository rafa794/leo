import { useEffect, useRef, useState } from 'react';
import { Brush, Eye, RotateCcw, Square, Trash2, X } from 'lucide-react';
import Range from './Range';
import { useEditor } from '../store/editor';
import type { MediaClip } from '../types';
import { cancelErase, eraseInImage, eraseInVideo, eraseJob, eraseOnCanvas, onEraseJobs, sourceFrame, warmupEraser } from '../lib/objectRemoval';

let openFn: ((clipId: string) => void) | null = null;
/** Opens "Borrar objetos" for a photo or video clip. */
export function openEraser(clipId: string) {
  openFn?.(clipId);
}

type Tool = 'brush' | 'box';

/**
 * "Borrar objetos" (beta): paint over what should disappear (brush or box) on the clip's picture, preview it, apply.
 * Photos: instant. Videos: the same area is repainted on every frame.
 */
export default function EraseDialog() {
  const [clipId, setClipId] = useState<string | null>(null);
  useEffect(() => {
    openFn = (id) => setClipId(id);
    return () => {
      openFn = null;
    };
  }, []);
  if (!clipId) return null;
  return <EraseEditor key={clipId} clipId={clipId} onClose={() => setClipId(null)} />;
}

function EraseEditor({ clipId, onClose }: { clipId: string; onClose: () => void }) {
  const clip = useEditor((s) => s.clips.find((c) => c.id === clipId)) as MediaClip | undefined;
  const media = useEditor((s) => s.media.find((m) => m.id === clip?.mediaId));
  const isVideo = media?.kind === 'video';
  const [tool, setTool] = useState<Tool>('brush');
  const [size, setSize] = useState(40);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [painted, setPainted] = useState(false);
  const [, force] = useState(0);
  useEffect(() => onEraseJobs(() => force((n) => n + 1)), []);
  const job = eraseJob(clipId);

  const frameRef = useRef<HTMLCanvasElement | null>(null); // the clip's picture, full size
  const viewRef = useRef<HTMLCanvasElement>(null); // what's shown (picture or preview)
  const maskRef = useRef<HTMLCanvasElement>(null); // red strokes, full size
  const history = useRef<ImageData[]>([]);
  const drag = useRef<{ x: number; y: number; snap: ImageData } | null>(null);

  // load the picture under the playhead and the model (in parallel)
  useEffect(() => {
    if (!clip || !media) return;
    let alive = true;
    void warmupEraser().catch(() => {});
    sourceFrame(clip, media, useEditor.getState().time)
      .then((c) => {
        if (!alive) return;
        frameRef.current = c;
        for (const el of [viewRef.current!, maskRef.current!]) {
          el.width = c.width;
          el.height = c.height;
        }
        viewRef.current!.getContext('2d')!.drawImage(c, 0, 0);
        setReady(true);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo abrir la imagen'));
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scale = () => {
    const el = maskRef.current!;
    return el.width / el.getBoundingClientRect().width;
  };
  const point = (e: React.PointerEvent) => {
    const r = maskRef.current!.getBoundingClientRect();
    const k = scale();
    return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k };
  };
  const mctx = () => maskRef.current!.getContext('2d', { willReadFrequently: true })!;

  const showPicture = () => {
    setPreview(false);
    viewRef.current!.getContext('2d')!.drawImage(frameRef.current!, 0, 0);
  };

  const down = (e: React.PointerEvent) => {
    if (!ready || busy || job) return;
    if (preview) showPicture();
    (e.target as Element).setPointerCapture(e.pointerId);
    const ctx = mctx();
    const snap = ctx.getImageData(0, 0, maskRef.current!.width, maskRef.current!.height);
    history.current.push(snap);
    if (history.current.length > 20) history.current.shift();
    const p = point(e);
    drag.current = { ...p, snap };
    if (tool === 'brush') stroke(p, p);
  };
  const stroke = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const ctx = mctx();
    ctx.strokeStyle = ctx.fillStyle = 'rgba(255, 40, 80, 1)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * scale();
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x + 0.01, b.y);
    ctx.stroke();
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    if (tool === 'brush') {
      stroke(d, p);
      d.x = p.x;
      d.y = p.y;
    } else {
      const ctx = mctx();
      ctx.putImageData(d.snap, 0, 0);
      ctx.fillStyle = 'rgba(255, 40, 80, 1)';
      ctx.fillRect(Math.min(d.x, p.x), Math.min(d.y, p.y), Math.abs(p.x - d.x), Math.abs(p.y - d.y));
    }
  };
  const up = () => {
    if (!drag.current) return;
    drag.current = null;
    setPainted(true);
  };

  /** 255 where painted, the picture's size */
  const maskBytes = () => {
    const el = maskRef.current!;
    const d = mctx().getImageData(0, 0, el.width, el.height).data;
    const m = new Uint8Array(el.width * el.height);
    let any = false;
    for (let i = 0; i < m.length; i++)
      if (d[i * 4 + 3] > 20) {
        m[i] = 255;
        any = true;
      }
    return any ? m : null;
  };

  const undo = () => {
    const prev = history.current.pop();
    if (prev) mctx().putImageData(prev, 0, 0);
    if (preview) showPicture();
    setPainted(!!maskBytes());
  };
  const clear = () => {
    history.current.push(mctx().getImageData(0, 0, maskRef.current!.width, maskRef.current!.height));
    mctx().clearRect(0, 0, maskRef.current!.width, maskRef.current!.height);
    if (preview) showPicture();
    setPainted(false);
  };

  const doPreview = async () => {
    const m = maskBytes();
    if (!m || !frameRef.current) return;
    setBusy('Borrando…');
    setError(null);
    try {
      const c = document.createElement('canvas');
      c.width = frameRef.current.width;
      c.height = frameRef.current.height;
      c.getContext('2d')!.drawImage(frameRef.current, 0, 0);
      await eraseOnCanvas(c, m);
      viewRef.current!.getContext('2d')!.drawImage(c, 0, 0);
      setPreview(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo borrar');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    const m = maskBytes();
    if (!m || !clip) return;
    setError(null);
    if (!isVideo) {
      setBusy('Borrando…');
      try {
        await eraseInImage(clip.id, m);
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo borrar');
      } finally {
        setBusy(null);
      }
      return;
    }
    // video: it runs in the background (progress in the bottom-right card) so you can keep editing
    const el = maskRef.current!;
    void eraseInVideo(clip.id, m, el.width, el.height);
    useEditor.getState().setStatus('Borrando objetos en segundo plano: puedes seguir editando');
    onClose();
  };

  if (!clip || !media) return null;
  const frames = isVideo ? Math.round(clip.duration * clip.speed * 30) : 1;

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && !job && onClose()}>
      <div className="modal erase-modal">
        <div className="row" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>
            Borrar objetos <span className="beta">beta</span>
          </h3>
          <div style={{ flex: 'none' }}>
            <button className="icon-btn" disabled={!!job} onClick={onClose} title="Cerrar">
              <X size={18} />
            </button>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          Pinta encima de lo que quieres quitar. La IA rellena el hueco con lo que debería haber detrás, en tu dispositivo.
        </p>

        <div className="erase-stage">
          <canvas ref={viewRef} className="erase-view" />
          <canvas
            ref={maskRef}
            className={`erase-mask ${preview ? 'hidden-strokes' : ''}`}
            data-testid="erase-mask"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
            style={{ cursor: tool === 'brush' ? 'crosshair' : 'cell' }}
          />
          {!ready && !error && <div className="erase-loading">Cargando imagen…</div>}
        </div>

        <div className="erase-tools">
          <div className="chips">
            <button className={`chip ${tool === 'brush' ? 'active' : ''}`} data-erase="brush" onClick={() => setTool('brush')}>
              <Brush size={13} /> Pincel
            </button>
            <button className={`chip ${tool === 'box' ? 'active' : ''}`} data-erase="box" onClick={() => setTool('box')}>
              <Square size={13} /> Recuadro
            </button>
          </div>
          {tool === 'brush' && (
            <label className="erase-size">
              <span>Tamaño</span>
              <Range min={8} max={140} value={size} onChange={(e) => setSize(Number(e.target.value))} />
            </label>
          )}
          <button className="icon-btn" title="Deshacer trazo" onClick={undo} disabled={!!job}>
            <RotateCcw size={16} />
          </button>
          <button className="icon-btn" title="Borrar todo lo pintado" onClick={clear} disabled={!!job}>
            <Trash2 size={16} />
          </button>
        </div>

        {isVideo && !job && (
          <p className="hint">
            {`En vídeo se borra la misma zona en los ${frames} fotogramas del clip (unos ${Math.max(1, Math.ceil(frames / 60))} min, en segundo plano mientras sigues editando): va mejor con la cámara quieta y cosas que no se mueven (un logo, una persona parada…).`}
          </p>
        )}
        {job && (
          <>
            <div className="prop-head">
              <span>{job.label}</span>
              <button className="btn small" onClick={() => cancelErase(clip.id)}>
                Cancelar
              </button>
            </div>
            <div className="progress">
              <div style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </div>
          </>
        )}
        {error && <p className="hint" style={{ color: 'var(--danger)' }}>{error}</p>}

        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <button className="btn block" disabled={!ready || !painted || !!busy || !!job} onClick={() => (preview ? showPicture() : void doPreview())}>
            <Eye size={15} /> {preview ? 'Ver original' : 'Vista previa'}
          </button>
          <button className="btn primary block" data-testid="erase-apply" disabled={!ready || !painted || !!busy || !!job} onClick={() => void apply()}>
            {busy ?? (isVideo ? 'Borrar en todo el clip' : 'Borrar')}
          </button>
        </div>
      </div>
    </div>
  );
}
