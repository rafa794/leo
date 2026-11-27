import { getRootTimeline, useEditor } from '../store/editor';
import { saveFile } from './platform';
import type { Clip, MediaItem, ProjectSettings, Track } from '../types';
import { getLang, t } from '../i18n';

/**
 * Projects ("proyectos"): saved automatically in the browser's own database (IndexedDB),
 * so you can close Leo and continue later.
 *
 * - The timeline, settings, thumbnails and waveforms are always saved.
 * - Small files (music, effects, stickers, photos, short clips) are saved inside the project.
 * - Big camera videos are NOT copied (they can be many GB): the project remembers their name and
 *   size, and when you open it again you pick the folder once ("Vincular carpeta") to find them.
 */

export const STORE_LIMIT = 300 * 1024 * 1024; // files up to 300 MB are saved inside the project

export interface MediaRecord {
  id: string;
  name: string;
  kind: MediaItem['kind'];
  mime: string;
  size: number;
  lastModified: number;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  thumbnails: string[];
  waveform?: number[];
  origin?: string;
  credit?: string;
  generated?: boolean;
  stored: boolean;
}

export interface ProjectDoc {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  version: 1;
  settings: ProjectSettings;
  tracks: Track[];
  clips: Clip[];
  media: MediaRecord[];
  zoom?: number;
  time?: number;
  cover?: string;
  extra?: Record<string, unknown>;
}

export type ProjectSummary = Pick<ProjectDoc, 'id' | 'name' | 'createdAt' | 'updatedAt' | 'cover'> & { clips: number; missing?: number };

/* ---------------- IndexedDB ---------------- */

const DB = 'orion';
let dbp: Promise<IDBDatabase> | null = null;
function db() {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
      if (!d.objectStoreNames.contains('handles')) d.createObjectStore('handles');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
function req<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const r = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(r.result as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}
const idbGet = <T>(store: string, key: IDBValidKey) => req<T | undefined>(store, 'readonly', (s) => s.get(key));
const idbPut = (store: string, value: unknown, key?: IDBValidKey) => req<IDBValidKey>(store, 'readwrite', (s) => s.put(value, key));
const idbDel = (store: string, key: IDBValidKey | IDBKeyRange) => req<undefined>(store, 'readwrite', (s) => s.delete(key));
const idbKeys = (store: string, range?: IDBKeyRange) => req<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys(range));
const idbAll = <T>(store: string) => req<T[]>(store, 'readonly', (s) => s.getAll());

/* ---------------- current project ---------------- */

const CURRENT_KEY = 'orion.project.current';
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

type Status = { state: 'idle' | 'saving' | 'saved' | 'error'; at?: number; error?: string };
let status: Status = { state: 'idle' };
let current: { id: string; name: string; createdAt: number } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
export const onProjectChange = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const projectStatus = () => status;
export const currentProject = () => current;

const storedBlobs = new Set<string>(); // "projectId:mediaId" already written this session

function lastProjectId(): string | null {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}
function rememberCurrent(id: string | null) {
  try {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {
    /* ignore */
  }
}

const isMissing = (m: MediaItem) => !!m.missing;

function toRecord(m: MediaItem, stored: boolean): MediaRecord {
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    mime: m.file.type,
    size: isMissing(m) ? (m.size ?? 0) : m.file.size,
    lastModified: m.file.lastModified,
    duration: m.duration,
    width: m.width,
    height: m.height,
    hasAudio: m.hasAudio,
    thumbnails: m.thumbnails,
    waveform: m.waveform,
    origin: m.origin,
    credit: m.credit,
    generated: m.generated,
    stored,
  };
}

// named in the language picked in the app (it's the user's text afterwards, so it isn't translated again)
const defaultName = () =>
  `${t('Proyecto')} ${new Date().toLocaleDateString(getLang(), { day: 'numeric', month: 'short' })} ${new Date().toLocaleTimeString(getLang(), { hour: '2-digit', minute: '2-digit' })}`;

/** Saves the editor state as the current project (creating it if needed). */
export async function saveNow(): Promise<void> {
  const s = useEditor.getState();
  if (!current) {
    if (!s.clips.length && !s.media.length) return; // nothing to save yet
    // the app was updated while open: keep saving into the project that was open
    const last = lastProjectId();
    const prev = last ? await idbGet<ProjectDoc>('projects', last).catch(() => undefined) : undefined;
    if (prev && !current) current = { id: prev.id, name: prev.name, createdAt: prev.createdAt };
  }
  if (!current) {
    current = { id: uid(), name: defaultName(), createdAt: Date.now() };
    rememberCurrent(current.id);
  }
  const proj = current;
  status = { state: 'saving' };
  emit();
  try {
    const media: MediaRecord[] = [];
    for (const m of s.media) {
      const key = `${proj.id}:${m.id}`;
      let stored = storedBlobs.has(key);
      // files Leo made itself (reversed clips, frozen frames) can't be found again on disk: always keep them
      if (!stored && !isMissing(m) && (m.file.size <= STORE_LIMIT || m.generated)) {
        // only write a file once
        const exists = (await idbKeys('blobs', IDBKeyRange.only(key))).length > 0;
        if (!exists) await idbPut('blobs', m.file, key);
        storedBlobs.add(key);
        stored = true;
      } else if (!stored && isMissing(m)) {
        stored = (await idbKeys('blobs', IDBKeyRange.only(key))).length > 0;
      }
      media.push(toRecord(m, stored));
    }
    const prev = await idbGet<ProjectDoc>('projects', proj.id);
    // always the whole project, even while editing inside a clip combinado
    const root = getRootTimeline();
    const firstVisual = s.media.find((m) => m.kind !== 'audio' && m.thumbnails.length);
    const doc: ProjectDoc = {
      id: proj.id,
      name: proj.name,
      createdAt: proj.createdAt,
      updatedAt: Date.now(),
      version: 1,
      settings: s.settings,
      tracks: root.tracks,
      clips: root.clips,
      media,
      zoom: s.zoom,
      time: s.compoundStack.length ? s.compoundStack[0].time : s.time,
      cover: firstVisual?.thumbnails[Math.floor(firstVisual.thumbnails.length / 3)] ?? prev?.cover,
      extra: { ...(prev?.extra ?? {}), ...collectExtra() },
    };
    await idbPut('projects', doc);
    status = { state: 'saved', at: Date.now() };
  } catch (e) {
    console.error('Leo: no se pudo guardar el proyecto', e);
    status = { state: 'error', error: e instanceof Error ? e.message : String(e) };
  }
  emit();
}

/** Extra data other modules want saved with the project (e.g. imported LUTs). */
const extraProviders = new Map<string, { get: () => unknown; set: (v: unknown) => void }>();
export function registerProjectExtra(key: string, get: () => unknown, set: (v: unknown) => void) {
  extraProviders.set(key, { get, set });
}
function collectExtra() {
  const out: Record<string, unknown> = {};
  extraProviders.forEach((p, k) => (out[k] = p.get()));
  return out;
}

/* ---------------- autosave ---------------- */

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let suspend = false;

export const hasPendingSave = () => !!timer || status.state === 'saving';
export function flushSave() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    void saveNow();
  }
}

export function startAutosave() {
  // the Mac app calls this before closing the window
  (window as unknown as { __orionFlush?: () => Promise<void> }).__orionFlush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    await saveNow();
  };
  if (started) return;
  started = true;
  useEditor.subscribe((s, p) => {
    if (suspend) return;
    if (s.clips === p.clips && s.tracks === p.tracks && s.media === p.media && s.settings === p.settings) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void saveNow(), 800);
  });
  // also save when leaving / hiding the app
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      void saveNow();
    }
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
}

/* ---------------- projects list ---------------- */

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await idbAll<ProjectDoc>('projects');
  return all
    .map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, cover: p.cover, clips: p.clips.length, missing: p.media.filter((m) => !m.stored).length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function renameProject(id: string, name: string) {
  const p = await idbGet<ProjectDoc>('projects', id);
  if (!p) return;
  p.name = name.trim() || p.name;
  await idbPut('projects', p);
  if (current?.id === id) current = { ...current, name: p.name };
  emit();
}

export async function deleteProject(id: string) {
  await idbDel('projects', id);
  await idbDel('blobs', IDBKeyRange.bound(`${id}:`, `${id}:￿`));
  await idbDel('handles', id);
  if (current?.id === id) {
    current = null;
    rememberCurrent(null);
  }
  emit();
}

const freshState = () => ({
  compoundStack: [],
  time: 0,
  playing: false,
  selectedIds: [],
  past: [],
  future: [],
  mediaSelection: [],
  exportRequest: null,
});

/** Empty editor for a new project. */
export async function newProject() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    await saveNow();
  }
  suspend = true;
  useEditor.setState({
    ...freshState(),
    media: [],
    clips: [],
    tracks: [{ id: 'main', kind: 'video', muted: false, hidden: false }],
  });
  suspend = false;
  current = null;
  rememberCurrent(null);
  emit();
}

/** Opens a saved project. Big videos that weren't stored come back as "missing" until relinked. */
export async function openProject(id: string) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    await saveNow();
  }
  const p = await idbGet<ProjectDoc>('projects', id);
  if (!p) throw new Error('No se encontró el proyecto');
  const old = useEditor.getState().media;
  const media: MediaItem[] = [];
  for (const r of p.media) {
    const blob = r.stored ? await idbGet<Blob>('blobs', `${p.id}:${r.id}`) : undefined;
    if (blob) {
      const file = blob instanceof File ? blob : new File([blob], r.name, { type: r.mime, lastModified: r.lastModified });
      storedBlobs.add(`${p.id}:${r.id}`);
      media.push(fromRecord(r, file, URL.createObjectURL(file), false));
    } else {
      // keep using the file if it's still open in this tab (same name and size)
      const same = old.find((m) => !isMissing(m) && m.name === r.name && m.file.size === r.size);
      if (same) media.push(fromRecord(r, same.file, same.url, false));
      else media.push(fromRecord(r, new File([], r.name, { type: r.mime }), '', true));
    }
  }
  if (p.extra) for (const [k, v] of Object.entries(p.extra)) extraProviders.get(k)?.set(v);
  suspend = true;
  useEditor.setState({
    ...freshState(),
    media,
    clips: p.clips,
    tracks: p.tracks,
    settings: p.settings,
    zoom: p.zoom ?? useEditor.getState().zoom,
    time: p.time ?? 0,
  });
  suspend = false;
  current = { id: p.id, name: p.name, createdAt: p.createdAt };
  rememberCurrent(p.id);
  status = { state: 'saved', at: p.updatedAt };
  emit();
}

function fromRecord(r: MediaRecord, file: File, url: string, missing: boolean): MediaItem {
  const m = {
    id: r.id,
    name: r.name,
    kind: r.kind,
    file,
    url,
    duration: r.duration,
    width: r.width,
    height: r.height,
    hasAudio: r.hasAudio,
    thumbnails: r.thumbnails,
    waveform: r.waveform,
    origin: r.origin,
    credit: r.credit,
    generated: r.generated,
  } as MediaItem;
  if (missing) {
    m.missing = true;
    m.size = r.size;
  }
  return m;
}

/** On start: reopen the last project if the editor is empty. Returns true if something was opened. */
export async function restoreLast(): Promise<boolean> {
  const id = lastProjectId();
  const s = useEditor.getState();
  if (s.clips.length || s.media.length) return false;
  if (!id) return false;
  try {
    await openProject(id);
    return true;
  } catch {
    rememberCurrent(null);
    return false;
  }
}

/* ---------------- relink missing videos ---------------- */

export const missingMedia = () => useEditor.getState().media.filter(isMissing);

/** Give the found files to the missing media (matched by name and size). Returns how many were found. */
export function relinkFiles(files: File[]): number {
  const s = useEditor.getState();
  let found = 0;
  const media = s.media.map((m) => {
    if (!isMissing(m)) return m;
    const size = m.size;
    const f = files.find((x) => x.name.toLowerCase() === m.name.toLowerCase() && (!size || x.size === size)) ?? files.find((x) => x.name.toLowerCase() === m.name.toLowerCase());
    if (!f) return m;
    found++;
    const { missing: _m, size: _s, ...rest } = m;
    return { ...rest, file: f, url: URL.createObjectURL(f) } as MediaItem;
  });
  if (found) useEditor.setState({ media });
  return found;
}

type DirHandle = FileSystemDirectoryHandle & { values: () => AsyncIterable<FileSystemHandle>; requestPermission?: (o: { mode: string }) => Promise<string>; queryPermission?: (o: { mode: string }) => Promise<string> };

async function walk(dir: DirHandle, want: Set<string>, out: File[], depth = 0) {
  for await (const h of dir.values()) {
    if (h.kind === 'file') {
      if (want.has(h.name.toLowerCase())) out.push(await (h as FileSystemFileHandle).getFile());
    } else if (depth < 4) await walk(h as DirHandle, want, out, depth + 1);
  }
}

async function relinkFromDir(dir: DirHandle) {
  const want = new Set(missingMedia().map((m) => m.name.toLowerCase()));
  const files: File[] = [];
  await walk(dir, want, files);
  return relinkFiles(files);
}

export const canPickFolder = () => 'showDirectoryPicker' in window;

/** Asks for the folder with the videos, finds them, and remembers the folder for next time. */
export async function relinkFolder(): Promise<number> {
  const pick = (window as unknown as { showDirectoryPicker: (o?: object) => Promise<DirHandle> }).showDirectoryPicker;
  const dir = await pick({ id: 'orion-media', mode: 'read' });
  if (current) await idbPut('handles', dir, current.id).catch(() => {});
  return relinkFromDir(dir);
}

/** The folder chosen last time for this project (if any), to reopen it with one click. */
export async function savedFolder(): Promise<{ name: string; reopen: () => Promise<number> } | null> {
  if (!current) return null;
  const dir = await idbGet<DirHandle>('handles', current.id).catch(() => undefined);
  if (!dir) return null;
  return {
    name: dir.name,
    reopen: async () => {
      const perm = (await dir.queryPermission?.({ mode: 'read' })) ?? 'granted';
      if (perm !== 'granted' && (await dir.requestPermission?.({ mode: 'read' })) !== 'granted') return 0;
      return relinkFromDir(dir);
    },
  };
}

/** Project as a file you can keep or move to another computer (without the big videos). */
export async function exportProjectFile() {
  await saveNow();
  if (!current) return;
  const p = await idbGet<ProjectDoc>('projects', current.id);
  if (!p) return;
  const blob = new Blob([JSON.stringify(p)], { type: 'application/json' });
  const r = await saveFile(blob, `${p.name.replace(/[\\/:*?"<>|]/g, '-')}.orion.json`);
  useEditor.getState().setStatus(`Proyecto guardado en ${r.where}`);
}

export async function importProjectFile(file: File) {
  const p = JSON.parse(await file.text()) as ProjectDoc;
  if (p.version !== 1 || !Array.isArray(p.clips)) throw new Error('No es un proyecto de Leo');
  p.id = uid();
  p.media = p.media.map((m) => ({ ...m, stored: false }));
  p.updatedAt = Date.now();
  await idbPut('projects', p);
  await openProject(p.id);
}

export async function setCurrentName(name: string) {
  if (!current) {
    await saveNow();
    if (!current) return;
  }
  await renameProject(current.id, name);
}
