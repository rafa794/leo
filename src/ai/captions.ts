import { mixTimelineAudio } from '../lib/audioMix';
import { projectDuration, useEditor } from '../store/editor';
import type { TextClip } from '../types';

export const WHISPER_MODELS = [
  { id: 'onnx-community/whisper-base', label: 'Rápido (≈80 MB)' },
  { id: 'onnx-community/whisper-small', label: 'Preciso (≈250 MB)' },
  { id: 'onnx-community/whisper-large-v3-turbo', label: 'Máxima calidad (≈800 MB, lento)' },
];

export const LANGUAGES = [
  { id: 'spanish', label: 'Español' },
  { id: 'english', label: 'Inglés' },
  { id: 'portuguese', label: 'Portugués' },
  { id: 'catalan', label: 'Catalán' },
  { id: 'french', label: 'Francés' },
  { id: 'italian', label: 'Italiano' },
  { id: '', label: 'Detectar automáticamente' },
];

export interface CaptionProgress {
  stage: 'audio' | 'download' | 'load' | 'transcribe';
  progress: number;
  part?: string;
}

type Chunk = { text: string; timestamp: [number, number | null] };

/** Splits Whisper segments into short, punchy captions (CapCut style), distributing time by text length. */
export function splitIntoCaptions(chunks: Chunk[], maxWords: number, total: number) {
  const out: { start: number; end: number; text: string }[] = [];
  chunks.forEach((c, i) => {
    const start = c.timestamp[0];
    const end = c.timestamp[1] ?? chunks[i + 1]?.timestamp[0] ?? total;
    const words = c.text.trim().split(/\s+/).filter(Boolean);
    if (!words.length || end <= start) return;
    const groups: string[][] = [];
    for (let w = 0; w < words.length; w += maxWords) groups.push(words.slice(w, w + maxWords));
    const totalChars = words.join(' ').length;
    let t = start;
    for (const g of groups) {
      const text = g.join(' ');
      const d = ((end - start) * (text.length + 1)) / (totalChars + groups.length);
      out.push({ start: t, end: Math.min(end, t + d), text });
      t += d;
    }
  });
  return out;
}

let worker: Worker | null = null;

const WINDOW = 600; // transcribe 10 minutes at a time (keeps memory low on long projects)

function transcribe(audio: Float32Array, opts: { model: string; language: string }, onProgress: (p: CaptionProgress) => void) {
  worker ??= new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Chunk[]>((resolve, reject) => {
    worker!.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') onProgress({ stage: d.stage, progress: d.progress });
      if (d.type === 'done') resolve(d.chunks);
      if (d.type === 'error') reject(new Error(d.message));
    };
    worker!.postMessage({ type: 'transcribe', audio, model: opts.model, language: opts.language || null }, [audio.buffer]);
  });
}

export async function generateCaptions(
  opts: { model: string; language: string; maxWords: number },
  onProgress: (p: CaptionProgress) => void,
) {
  const s = useEditor.getState();
  const total = projectDuration(s.clips);
  const out: { start: number; end: number; text: string }[] = [];
  for (let from = 0; from < total; from += WINDOW) {
    const to = Math.min(total, from + WINDOW);
    const part = total > WINDOW ? ` (${Math.floor(from / 60)}–${Math.ceil(to / 60)} min)` : '';
    onProgress({ stage: 'audio', progress: (from / total) * 100, part });
    // Whisper expects 16 kHz mono audio
    const mix = await mixTimelineAudio({ clips: s.clips, tracks: s.tracks, media: s.media }, 16000, 1, { from, to });
    const audio = mix.getChannelData(0).slice();
    const chunks = await transcribe(audio, opts, (p) => onProgress({ ...p, part }));
    for (const c of splitIntoCaptions(chunks, opts.maxWords, to - from)) out.push({ start: c.start + from, end: c.end + from, text: c.text });
  }
  return out;
}

/** Builds an .srt file from the caption clips (useful to upload to YouTube). */
export function captionsToSrt(clips: TextClip[]) {
  const fmt = (t: number) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
  };
  return [...clips]
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(c.start + c.duration)}\n${c.text}\n`)
    .join('\n');
}
