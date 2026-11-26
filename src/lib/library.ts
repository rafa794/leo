/**
 * Free music, sound effects and stickers.
 *  - Music & sound effects: Openverse (openverse.org, by WordPress), which indexes Creative Commons audio
 *    from Jamendo (music) and Freesound (effects). We only ask for licenses that allow monetized videos:
 *    CC0 (no attribution needed) and CC BY (mention the author in the description).
 *  - Stickers: Microsoft Fluent Emoji 3D (MIT), bundled in public/stickers.
 */
import { useEditor, type AddMediaOptions } from '../store/editor';
import { fetchLibraryFile } from './platform';
import { importFile, loadWaveform } from './media';
import { stickerUrl, type Sticker } from './stickers';
import { isMediaClip, type Clip } from '../types';

export const LIBRARY_DRAG_TYPE = 'application/x-orion-library';

export interface AudioResult {
  id: string;
  title: string;
  creator: string;
  url: string;
  duration: number; // seconds
  license: 'cc0' | 'by';
  attribution: string;
  source: string;
  page: string;
  filetype: string;
}

export type LibraryDragPayload = { kind: 'sticker'; sticker: Sticker } | { kind: 'audio'; item: AudioResult };

const API = 'https://api.openverse.org/v1/audio/';
const cache = new Map<string, { results: AudioResult[]; pages: number }>();

/** Searches free (CC0 / CC BY) music or sound effects. */
export async function searchAudio(query: string, type: 'music' | 'sfx', page = 1): Promise<{ results: AudioResult[]; pages: number }> {
  const params = new URLSearchParams({ q: query, license: 'cc0,by', page_size: '20', page: String(page) });
  if (type === 'music') params.set('category', 'music');
  else params.set('source', 'freesound');
  const key = params.toString();
  const hit = cache.get(key);
  if (hit) return hit;
  const res = await fetch(`${API}?${key}`);
  if (res.status === 429) throw new Error('Has hecho muchas búsquedas seguidas. Espera un minuto y vuelve a probar.');
  if (!res.ok) throw new Error(`No se pudo buscar (${res.status})`);
  const data = await res.json();
  const results: AudioResult[] = (data.results ?? [])
    .filter((r: { url?: string; duration?: number }) => r.url && (r.duration ?? 1) > 0)
    .map((r: Record<string, unknown>) => ({
      id: String(r.id),
      title: String(r.title ?? 'Sin título').replace(/\.(wav|mp3|flac|aiff?|ogg)$/i, ''),
      creator: String(r.creator ?? ''),
      url: String(r.url),
      duration: Number(r.duration ?? 0) / 1000,
      license: r.license === 'cc0' ? 'cc0' : 'by',
      attribution: String(r.attribution ?? ''),
      source: String(r.source ?? ''),
      page: String(r.foreign_landing_url ?? ''),
      filetype: String(r.filetype ?? 'mp3'),
    }));
  // the same track is sometimes listed twice
  const seen = new Set<string>();
  const unique = results.filter((r) => {
    const k = `${r.title}|${r.creator}|${Math.round(r.duration)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const out = { results: unique, pages: Number(data.page_count ?? 1) };
  cache.set(key, out);
  return out;
}

/** Finds an already-imported media item that came from this url. */
const fromOrigin = (origin: string) => useEditor.getState().media.find((m) => m.origin === origin);

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'audio';

/** Downloads an audio file into the media bin (or reuses it if it's already there). */
export async function importAudio(item: AudioResult, onProgress?: (p: number) => void): Promise<string> {
  const existing = fromOrigin(item.url);
  if (existing) return existing.id;
  const blob = await fetchLibraryFile(item.url, onProgress);
  const ext = item.filetype.startsWith('mp3') ? 'mp3' : item.filetype || 'mp3';
  const file = new File([blob], `${safeName(item.title)}.${ext}`, { type: blob.type || 'audio/mpeg' });
  const media = await importFile(file);
  media.origin = item.url;
  if (item.license === 'by') media.credit = item.attribution || `"${item.title}" de ${item.creator} (CC BY)`;
  useEditor.getState().addMedia(media);
  loadWaveform(media).then((waveform) => waveform && useEditor.getState().updateMedia(media.id, { waveform }));
  return media.id;
}

/** Imports a sticker PNG into the media bin (or reuses it). */
export async function importSticker(sticker: Sticker): Promise<string> {
  const url = stickerUrl(sticker);
  const existing = fromOrigin(url);
  if (existing) return existing.id;
  const blob = await (await fetch(url)).blob();
  const media = await importFile(new File([blob], `${sticker.name}.png`, { type: 'image/png' }));
  media.origin = url;
  useEditor.getState().addMedia(media);
  return media.id;
}

export const STICKER_PATCH = { duration: 3, transform: { x: 0, y: 0, scale: 0.3, rotation: 0 } };

/** Adds a library item to the timeline (at the playhead unless a position is given). */
export async function addFromLibrary(payload: LibraryDragPayload, opts: AddMediaOptions = {}) {
  const st = useEditor.getState();
  try {
    if (payload.kind === 'sticker') {
      const id = await importSticker(payload.sticker);
      useEditor.getState().addMediaClips([id], { ...opts, overlay: true, patch: STICKER_PATCH });
    } else {
      st.setStatus(`Descargando «${payload.item.title}»…`);
      const id = await importAudio(payload.item);
      useEditor.getState().addMediaClips([id], { start: opts.start ?? useEditor.getState().time, trackId: opts.trackId });
      useEditor.getState().setStatus(null);
    }
  } catch (e) {
    useEditor.getState().setStatus(e instanceof Error ? e.message : 'No se pudo añadir');
  }
}

/** Credits (CC BY) of the downloaded music/sounds used in the project, ready to paste in the description. */
export function projectCredits(): string[] {
  const { media, clips } = useEditor.getState();
  const used = new Set<string>();
  const walk = (list: Clip[]) =>
    list.forEach((c) => {
      if (c.type === 'compound' && c.compound) walk(c.compound.clips);
      else if (isMediaClip(c)) used.add(c.mediaId);
    });
  walk(clips);
  return media.filter((m) => m.credit && used.has(m.id)).map((m) => m.credit!);
}
