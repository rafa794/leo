import { saveFile } from '../lib/platform';
import { useState } from 'react';
import { Download, Sparkles, Trash2 } from 'lucide-react';
import { useEditor } from '../store/editor';
import { captionsToSrt, generateCaptions, LANGUAGES, WHISPER_MODELS, type CaptionProgress } from '../ai/captions';
import type { TextClip, TextStyle } from '../types';
import { formatTime } from '../lib/util';
import { player } from '../lib/player';
import Range from './Range';

const CAPTION_LOOKS: { name: string; style: Partial<TextStyle> }[] = [
  { name: 'Clásico', style: { color: '#ffffff', strokeColor: '#000000', strokeWidth: 0.16, background: '', fontFamily: 'Montserrat' } },
  { name: 'Amarillo', style: { color: '#facc15', strokeColor: '#000000', strokeWidth: 0.16, background: '', fontFamily: 'Montserrat' } },
  { name: 'Caja negra', style: { color: '#ffffff', strokeWidth: 0, background: 'rgba(0,0,0,0.75)', fontFamily: 'Inter' } },
  { name: 'Deportivo', style: { color: '#ffffff', strokeColor: '#0ea5c4', strokeWidth: 0.2, background: '', fontFamily: 'Anton' } },
];

const STAGE_LABEL: Record<CaptionProgress['stage'], string> = {
  audio: 'Extrayendo el audio…',
  download: 'Descargando modelo de IA (solo la primera vez)…',
  load: 'Cargando modelo de IA…',
  transcribe: 'Transcribiendo (puede tardar un poco)…',
};

export default function CaptionsPanel() {
  const clips = useEditor((s) => s.clips);
  const addCaptions = useEditor((s) => s.addCaptions);
  const removeCaptions = useEditor((s) => s.removeCaptions);
  const updateClip = useEditor((s) => s.updateClip);
  const [model, setModel] = useState(WHISPER_MODELS[0].id);
  const [language, setLanguage] = useState('spanish');
  const [maxWords, setMaxWords] = useState(4);
  const [look, setLook] = useState(0);
  const [progress, setProgress] = useState<CaptionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const captions = clips.filter((c): c is TextClip => c.type === 'text' && !!c.caption).sort((a, b) => a.start - b.start);
  const hasAudio = clips.some((c) => c.type === 'video' || c.type === 'audio');

  const run = async () => {
    setError(null);
    try {
      const items = await generateCaptions({ model, language, maxWords }, setProgress);
      if (!items.length) setError('No se ha detectado voz en el audio.');
      addCaptions(items, CAPTION_LOOKS[look].style);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  const downloadSrt = () => {
    const blob = new Blob([captionsToSrt(captions)], { type: 'text/plain' });
    saveFile(blob, 'subtitulos.srt').then((r) => useEditor.getState().setStatus(`Subtítulos guardados en ${r.where}`));
  };

  return (
    <>
      <div className="panel-title">
        Subtítulos automáticos <span className="badge">IA</span>
      </div>
      <div className="panel-body">
        <p className="hint" style={{ marginTop: 0 }}>
          Usa Whisper (IA de código abierto) dentro de tu navegador: gratis, sin cuentas y tu vídeo no se sube a ningún sitio.
        </p>
        <div className="field">
          <label>Idioma</label>
          <select className="input" style={{ width: '100%' }} value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Modelo</label>
          <select className="input" style={{ width: '100%' }} value={model} onChange={(e) => setModel(e.target.value)}>
            {WHISPER_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>
            Palabras por subtítulo <b>{maxWords}</b>
          </label>
          <Range min={1} max={10} value={maxWords} onChange={(e) => setMaxWords(Number(e.target.value))} />
        </div>
        <div className="field">
          <label>Estilo</label>
          <div className="chips">
            {CAPTION_LOOKS.map((l, i) => (
              <button key={l.name} className={`chip ${look === i ? 'active' : ''}`} onClick={() => setLook(i)}>
                {l.name}
              </button>
            ))}
          </div>
        </div>

        {progress ? (
          <div className="field">
            <label>{STAGE_LABEL[progress.stage]}{progress.part}</label>
            <div className="progress">
              <div style={{ width: `${progress.stage === 'transcribe' || progress.stage === 'load' ? 100 : progress.progress}%`, opacity: progress.stage === 'transcribe' ? 0.6 : 1 }} />
            </div>
          </div>
        ) : (
          <button className="btn primary block" disabled={!hasAudio} onClick={run}>
            <Sparkles size={16} /> {captions.length ? 'Volver a generar' : 'Generar subtítulos'}
          </button>
        )}
        {!hasAudio && <p className="hint">Añade primero un vídeo o audio a la línea de tiempo.</p>}
        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

        {captions.length > 0 && (
          <div className="section" style={{ marginTop: 14 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <button className="btn small" onClick={downloadSrt}>
                <Download size={14} /> Descargar .srt
              </button>
              <button className="btn small danger" onClick={removeCaptions}>
                <Trash2 size={14} /> Quitar todos
              </button>
            </div>
            <p className="hint">Corrige el texto aquí. Para cambiar el estilo de todos, selecciona uno en la línea de tiempo.</p>
            <div className="caption-list">
              {captions.map((c) => (
                <div key={c.id} className="caption-row">
                  <span onClick={() => player.seek(c.start + 0.01)}>{formatTime(c.start, true)}</span>
                  <input className="input" defaultValue={c.text} onBlur={(e) => e.target.value !== c.text && updateClip(c.id, { text: e.target.value })} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
