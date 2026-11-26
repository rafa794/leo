import { importFiles } from './importFiles';
import { currentProject, missingMedia, relinkFiles } from './project';
import { isNative } from './platform';

/**
 * Remembers WHERE your videos came from (a "file handle", Chrome / Mac app), so after a reload
 * or reopening Orion they come back by themselves instead of asking you to pick the folder again.
 * Nothing is copied: only the permission to read the original file is kept.
 */

type Perm = 'granted' | 'denied' | 'prompt';
type FileHandle = FileSystemFileHandle & { queryPermission?: (o: { mode: string }) => Promise<Perm>; requestPermission?: (o: { mode: string }) => Promise<Perm> };
type DirHandle = FileSystemDirectoryHandle & {
  values: () => AsyncIterable<FileSystemHandle>;
  queryPermission?: (o: { mode: string }) => Promise<Perm>;
  requestPermission?: (o: { mode: string }) => Promise<Perm>;
};

let dbp: Promise<IDBDatabase> | null = null;
const db = () =>
  (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('orion', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const n of ['projects', 'blobs', 'handles']) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, n === 'projects' ? { keyPath: 'id' } : undefined);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
const tx = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) =>
  db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction('handles', mode);
        const r = fn(t.objectStore('handles'));
        t.oncomplete = () => resolve(r.result as T);
        t.onerror = () => reject(t.error);
      }),
  );

const fileKey = (name: string, size: number) => `file:${name.toLowerCase()}|${size}`;

async function remember(handle: FileHandle) {
  try {
    const f = await handle.getFile();
    await tx('readwrite', (s) => s.put(handle, fileKey(f.name, f.size)));
  } catch {
    /* not important */
  }
}

/* ---------- capture handles when importing ---------- */

let started = false;
export function initFileAccess() {
  if (started || isNative) return;
  started = true;
  // files dropped from Finder: ask the browser for their handles (must happen during the drop)
  window.addEventListener(
    'drop',
    (e) => {
      const items = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === 'file');
      for (const it of items) {
        const get = (it as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
        get?.call(it).then((h) => { if (h?.kind === 'file') void remember(h as FileHandle); }).catch(() => {});
      }
    },
    true,
  );
  // "Importar" button: use the system file picker that gives handles (instead of the plain one)
  const pick = (window as unknown as { showOpenFilePicker?: (o: object) => Promise<FileHandle[]> }).showOpenFilePicker;
  if (!pick) return;
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('.dropzone')) return;
      e.preventDefault();
      e.stopPropagation();
      pick({
        multiple: true,
        id: 'orion-import',
        types: [
          {
            description: 'Vídeos, música y fotos',
            accept: {
              'video/*': ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'],
              'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus'],
              'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'],
            },
          },
        ],
      })
        .then(async (handles) => {
          const files = await Promise.all(handles.map((h) => h.getFile()));
          handles.forEach((h) => void remember(h));
          await importFiles(files);
        })
        .catch(() => {}); // cancelled
    },
    true,
  );
}

/* ---------- bring missing videos back by themselves ---------- */

export interface AutoRelink {
  found: number;
  /** videos we can bring back with one click (the browser wants you to confirm) */
  needClick: number;
}

const pending: { files: FileHandle[]; dir: DirHandle | null } = { files: [], dir: null };

async function walk(dir: DirHandle, want: Set<string>, out: File[], depth = 0) {
  for await (const h of dir.values()) {
    if (h.kind === 'file') {
      if (want.has(h.name.toLowerCase())) out.push(await (h as FileSystemFileHandle).getFile());
    } else if (depth < 4) await walk(h as DirHandle, want, out, depth + 1);
  }
}

/** Tries to reopen every missing video without asking (only what's already allowed). */
export async function autoRelink(): Promise<AutoRelink> {
  pending.files = [];
  pending.dir = null;
  const missing = missingMedia();
  if (!missing.length) return { found: 0, needClick: 0 };
  const files: File[] = [];
  for (const m of missing) {
    const h = await tx<FileHandle | undefined>('readonly', (s) => s.get(fileKey(m.name, m.size ?? 0))).catch(() => undefined);
    if (!h) continue;
    const perm = (await h.queryPermission?.({ mode: 'read' }).catch(() => 'prompt' as Perm)) ?? 'granted';
    if (perm === 'granted') {
      try {
        files.push(await h.getFile());
      } catch {
        /* moved or deleted */
      }
    } else if (perm === 'prompt') pending.files.push(h);
  }
  let found = files.length ? relinkFiles(files) : 0;
  // the folder chosen with "Elegir carpeta" for this project
  const proj = currentProject();
  if (missingMedia().length && proj) {
    const dir = await tx<DirHandle | undefined>('readonly', (s) => s.get(proj.id)).catch(() => undefined);
    if (dir) {
      const perm = (await dir.queryPermission?.({ mode: 'read' }).catch(() => 'prompt' as Perm)) ?? 'granted';
      if (perm === 'granted') {
        const more: File[] = [];
        await walk(dir, new Set(missingMedia().map((m) => m.name.toLowerCase())), more).catch(() => {});
        found += relinkFiles(more);
      } else if (perm === 'prompt') pending.dir = dir;
    }
  }
  const left = missingMedia().length;
  return { found, needClick: left ? pending.files.length + (pending.dir ? 1 : 0) : 0 };
}

/** One click: the browser asks "allow access?" and the videos come back. */
export async function allowAccess(): Promise<number> {
  const files: File[] = [];
  for (const h of pending.files) {
    try {
      if ((await h.requestPermission?.({ mode: 'read' })) !== 'denied') files.push(await h.getFile());
    } catch {
      /* skipped */
    }
  }
  let found = files.length ? relinkFiles(files) : 0;
  if (pending.dir && missingMedia().length) {
    try {
      if ((await pending.dir.requestPermission?.({ mode: 'read' })) === 'granted') {
        const more: File[] = [];
        await walk(pending.dir, new Set(missingMedia().map((m) => m.name.toLowerCase())), more);
        found += relinkFiles(more);
      }
    } catch {
      /* skipped */
    }
  }
  pending.files = [];
  pending.dir = null;
  return found;
}
