import { Capacitor, CapacitorHttp } from '@capacitor/core';

/** Running as the Android app (Capacitor). */
export const isNative = Capacitor.isNativePlatform();
export const isAndroid = Capacitor.getPlatform() === 'android';

const blobToBase64 = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

export interface SavedFile {
  /** where the user can find it */
  where: string;
  /** native file uri (Android), used to share it */
  uri?: string;
}

/**
 * Saves a file for the user: a normal download in the browser / Mac app,
 * or a file in Documentos/Orion on Android (written in pieces so big videos fit in memory).
 */
export async function saveFile(blob: Blob, name: string): Promise<SavedFile> {
  if (!isNative) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    return { where: 'Descargas' };
  }
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const write = async (directory: (typeof Directory)[keyof typeof Directory], path: string) => {
    const CHUNK = 3 * 1024 * 1024; // multiple of 3 → base64 pieces join cleanly
    for (let off = 0; off < Math.max(1, blob.size); off += CHUNK) {
      const data = await blobToBase64(blob.slice(off, off + CHUNK));
      if (off === 0) await Filesystem.writeFile({ path, data, directory, recursive: true });
      else await Filesystem.appendFile({ path, data, directory });
    }
    return (await Filesystem.getUri({ path, directory })).uri;
  };
  try {
    const uri = await write(Directory.Documents, `Orion/${name}`);
    return { where: 'Documentos/Orion', uri };
  } catch {
    // some phones don't let apps write to Documents: keep it in the app and offer "Compartir"
    const uri = await write(Directory.Data, `exports/${name}`);
    return { where: 'la app (usa Compartir para guardarlo)', uri };
  }
}

/** Android share sheet: TikTok, Instagram, YouTube, WhatsApp, Drive, Fotos… */
export async function shareFile(uri: string, title: string) {
  const { Share } = await import('@capacitor/share');
  await Share.share({ title, files: [uri], dialogTitle: 'Compartir vídeo' });
}

/**
 * Downloads a file from a music / sound library. In the browser it goes through the local server
 * (some sites don't allow direct downloads from a web page); the Android app downloads it natively.
 */
export async function fetchLibraryFile(url: string, onProgress?: (p: number) => void): Promise<Blob> {
  if (isNative) {
    onProgress?.(0.3);
    const r = await CapacitorHttp.request({ url, method: 'GET', responseType: 'blob' });
    if (r.status >= 400) throw new Error('No se pudo descargar');
    const bin = atob(String(r.data));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    onProgress?.(1);
    const type = (r.headers['content-type'] ?? r.headers['Content-Type'] ?? 'audio/mpeg').split(';')[0];
    return new Blob([bytes], { type });
  }
  const res = await fetch(`${import.meta.env.BASE_URL}__download?url=${encodeURIComponent(url)}`);
  if (!res.ok || !res.body) throw new Error('No se pudo descargar');
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress?.(got / total);
  }
  return new Blob(chunks as BlobPart[], { type: res.headers.get('content-type') ?? 'audio/mpeg' });
}
