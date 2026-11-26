export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function formatTime(t: number, withFrames = false, fps = 30) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const base = `${h ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  if (!withFrames) return base;
  const f = Math.floor((t % 1) * fps);
  return `${base}:${String(f).padStart(2, '0')}`;
}

/** Rejects if the promise takes longer than ms (some phones' video decoders never answer). */
export function withTimeout<T>(p: Promise<T>, ms: number, message = 'timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
