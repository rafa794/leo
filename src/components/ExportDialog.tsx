import { useEffect, useRef, useState } from 'react';
import { Download, Image as ImageIcon, Video, X } from 'lucide-react';
import { isNative, saveFile } from '../lib/platform';
import { enqueueExport } from '../lib/exportQueue';
import { EXPORT_FPS, nearestFps, sourceFps } from '../lib/fps';
import { getRootTimeline, useEditor } from '../store/editor';
import { exportDuration, exportImage, selectionJob, singleClipJob, type ExportOptions } from '../lib/exporter';
import { isMediaClip } from '../types';
import { formatTime } from '../lib/util';

const RESOLUTIONS = [
  { label: '720p', short: 720 },
  { label: '1080p (recomendado)', short: 1080 },
  { label: '1440p (2K)', short: 1440 },
  { label: '2160p (4K)', short: 2160 },
];

const even = (n: number) => Math.round(n / 2) * 2;

export default function ExportDialog({ onClose, clipId, clipIds }: { onClose: () => void; clipId?: string; clipIds?: string[] }) {
  const settings = useEditor((s) => s.settings);
  const clip = useEditor((s) => (clipId ? s.clips.find((c) => c.id === clipId) : undefined));
  const multi = !clipId && !!clipIds?.length;
  const clipName = useEditor((s) => {
    if (multi) return 'seleccion';
    if (!clip) return 'mi-video';
    if (clip.type === 'compound') return 'clip-combinado';
    if (!isMediaClip(clip)) return 'texto';
    return (s.media.find((m) => m.id === clip.mediaId)?.name ?? 'clip').replace(/\.[^.]+$/, '') + '-recorte';
  });
  const duration = useEditor((s) => {
    if (clip) return clip.duration;
    if (multi) {
      const sel = s.clips.filter((c) => clipIds!.includes(c.id));
      return sel.length ? Math.max(...sel.map((c) => c.start + c.duration)) - Math.min(...sel.map((c) => c.start)) : 0;
    }
    const root = s.compoundStack.length ? getRootTimeline() : { clips: s.clips, tracks: s.tracks };
    return exportDuration(root.clips, root.tracks);
  });
  const [name, setName] = useState(clipName);
  // never upscale by default: a 720p project exports at 720p (1080p is the default for bigger ones)
  const [res, setRes] = useState(() => {
    const short = Math.min(settings.width, settings.height);
    let i = 0;
    RESOLUTIONS.forEach((r, j) => {
      if (r.short <= Math.max(short, 720) && r.short <= 1080) i = j;
    });
    return i;
  });
  const [fps, setFps] = useState(30);
  const [srcFps, setSrcFps] = useState<number | null>(null);
  const [quality, setQuality] = useState<ExportOptions['quality']>('high');
  const touchedFps = useRef(false);
  // "Foto" (beta): one picture of what the viewer shows at the playhead. A project made only of pictures opens on it.
  const whole = !clipId && !multi;
  const onlyPictures = useEditor((s) => {
    const used = new Set(s.clips.flatMap((c) => (isMediaClip(c) ? [c.mediaId] : [])));
    const items = s.media.filter((m) => used.has(m.id));
    return items.length > 0 && items.every((m) => m.kind === 'image');
  });
  const [mode, setMode] = useState<'video' | 'photo'>(whole && onlyPictures ? 'photo' : 'video');
  const [photoFormat, setPhotoFormat] = useState<'jpeg' | 'png'>('jpeg');
  const [photoSize, setPhotoSize] = useState(0); // 0 = project size, else short side
  const [saving, setSaving] = useState(false);

  // what goes into the video: a snapshot taken now (you can keep editing while it exports)
  const buildJob = () => {
    const s = useEditor.getState();
    const full = { clips: s.clips, tracks: s.tracks, media: s.media, settings: s.settings };
    // the whole video is always the main project, even while editing inside a clip combinado
    const whole = { ...full, ...getRootTimeline() };
    return clipId ? singleClipJob(full, clipId) : multi ? selectionJob(full, clipIds!) : whole;
  };

  // default frame rate = the one the videos were recorded at
  useEffect(() => {
    let alive = true;
    try {
      const job = buildJob();
      sourceFps(job.clips, job.media).then((f) => {
        if (!alive || !f) return;
        setSrcFps(f);
        if (!touchedFps.current) setFps(nearestFps(f));
      });
    } catch {
      /* nothing selected */
    }
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shortSide = Math.min(settings.width, settings.height);
  const k = RESOLUTIONS[res].short / shortSide;
  const width = even(settings.width * k);
  const height = even(settings.height * k);
  const camFps = srcFps ? nearestFps(srcFps) : null;

  const start = () => {
    enqueueExport(buildJob(), { width, height, fps, quality }, name || 'video');
    onClose();
  };

  const pk = photoSize ? photoSize / shortSide : 1;
  const photoW = even(settings.width * pk);
  const photoH = even(settings.height * pk);
  const savePhoto = async () => {
    setSaving(true);
    const st = useEditor.getState();
    try {
      const job = buildJob();
      const t = Math.min(st.time, Math.max(0, exportDuration(job.clips, job.tracks) - 0.001));
      const blob = await exportImage(job, { width: photoW, height: photoH, time: t, format: photoFormat });
      const saved = await saveFile(blob, `${name || 'foto'}.${photoFormat === 'png' ? 'png' : 'jpg'}`);
      st.setStatus(`Foto guardada en ${saved.where}`);
      onClose();
    } catch (e) {
      st.setStatus(e instanceof Error ? e.message : 'No se pudo guardar la foto');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="row" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>
            {clipId ? (clip?.type === 'compound' ? 'Exportar clip combinado' : 'Exportar este clip') : multi ? `Exportar ${clipIds!.length} clips seleccionados` : mode === 'photo' ? 'Exportar foto' : 'Exportar vídeo'}
          </h3>
          <div style={{ flex: 'none' }}>
            <button className="icon-btn" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>
        {whole && (
          <div className="chips" style={{ marginBottom: 10 }}>
            <button className={`chip ${mode === 'video' ? 'active' : ''}`} data-mode="video" onClick={() => setMode('video')}>
              <Video size={13} /> Vídeo
            </button>
            <button className={`chip ${mode === 'photo' ? 'active' : ''}`} data-mode="photo" onClick={() => setMode('photo')}>
              <ImageIcon size={13} /> Foto <span className="beta">beta</span>
            </button>
          </div>
        )}
        {mode === 'photo' ? (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              Guarda lo que se ve en el visor en la posición de la aguja, con filtros, efectos, textos y stickers.
            </p>
            <div className="field">
              <label>Nombre del archivo</label>
              <input className="input" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="row">
              <div className="field">
                <label>Tamaño</label>
                <select className="input" style={{ width: '100%' }} value={photoSize} onChange={(e) => setPhotoSize(Number(e.target.value))}>
                  <option value={0}>{`Original · ${settings.width}×${settings.height}`}</option>
                  {[1080, 2160].filter((v) => v !== shortSide).map((v) => (
                    <option key={v} value={v}>
                      {`${v}p${v > shortSide ? ' · ampliado' : ''}`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Formato</label>
                <div className="chips">
                  <button className={`chip ${photoFormat === 'jpeg' ? 'active' : ''}`} onClick={() => setPhotoFormat('jpeg')}>
                    JPG
                  </button>
                  <button className={`chip ${photoFormat === 'png' ? 'active' : ''}`} onClick={() => setPhotoFormat('png')}>
                    PNG
                  </button>
                </div>
              </div>
            </div>
            <p className="hint">
              Salida: {photoW}×{photoH} · {photoFormat === 'png' ? 'PNG (sin pérdida)' : 'JPG'}
            </p>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn primary block" data-testid="save-photo" disabled={saving} onClick={() => void savePhoto()}>
                <Download size={16} /> {saving ? 'Guardando…' : 'Guardar foto'}
              </button>
            </div>
          </>
        ) : (
          <>
        <p className="hint" style={{ marginTop: 0 }}>
          {clipId && 'Solo este clip, sin el resto de la línea de tiempo · '}
          {multi && 'Solo los clips seleccionados, juntos · '}Duración {formatTime(duration)} · MP4 · {isNative ? 'se procesa en tu móvil' : 'se procesa en tu ordenador'}
        </p>

        <div className="field">
          <label>Nombre del archivo</label>
          <input className="input" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row">
          <div className="field">
            <label>Resolución</label>
            <select className="input" style={{ width: '100%' }} value={res} onChange={(e) => setRes(Number(e.target.value))}>
              {RESOLUTIONS.map((r, i) => (
                <option key={r.label} value={i}>
                  {r.label}
                  {r.short > Math.min(settings.width, settings.height) ? ' · ampliado' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Fotogramas/s</label>
            <select
              className="input"
              style={{ width: '100%' }}
              value={fps}
              onChange={(e) => {
                touchedFps.current = true;
                setFps(Number(e.target.value));
              }}
            >
              {EXPORT_FPS.map((f) => (
                <option key={f} value={f}>
                  {f} fps{f === camFps ? ' · como tus vídeos' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Calidad</label>
          <div className="chips">
            {(
              [
                ['medium', 'Normal (archivo pequeño)'],
                ['high', 'Alta'],
                ['very-high', 'Máxima'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={`chip ${quality === id ? 'active' : ''}`} onClick={() => setQuality(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="hint">
          Salida: {width}×{height} · {fps} fps
        </p>
        {camFps && fps > camFps && (
          <p className="hint" style={{ color: '#fbbf24' }}>
            {`Tus vídeos son de ${camFps} fps: a ${fps} fps cada imagen de la cámara se repite y el partido no se verá más fluido (solo los textos, zooms y animaciones). El archivo será más grande.`}
          </p>
        )}
        {camFps && fps < camFps && (
          <p className="hint" style={{ color: '#fbbf24' }}>
            {`Tus vídeos son de ${camFps} fps: a ${fps} fps se descartan imágenes y las jugadas rápidas se verán menos fluidas.`}
          </p>
        )}

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary block" onClick={start}>
            <Download size={16} /> Exportar
          </button>
        </div>
        <p className="hint" style={{ marginBottom: 0, textAlign: 'center' }}>
          Se exporta en segundo plano: puedes cerrar esto y seguir editando. Verás el progreso abajo a la derecha.
        </p>
          </>
        )}
      </div>
    </div>
  );
}
