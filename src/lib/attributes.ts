import type { Key, KeyTracks, MediaClip, MediaItem } from '../types';
import { sourceDuration } from './timeline';

/** "Copiar / pegar atributos" (CapCut): copy settings from one clip to others, by group. */
export type AttrGroup = 'adjust' | 'audio' | 'anim' | 'transform' | 'blend' | 'mask' | 'background' | 'speed';

export const ATTR_GROUPS: [AttrGroup, string, string][] = [
  ['adjust', 'Ajustar', 'Color, LUT y nitidez'],
  ['audio', 'Audio', 'Volumen, fundidos, silencio y voz IA'],
  ['anim', 'Animación', 'Entrada, salida y combinado'],
  ['transform', 'Posición y tamaño', 'Escala, posición, giro y volteo'],
  ['blend', 'Mezcla', 'Opacidad y modo de fusión'],
  ['mask', 'Máscara', ''],
  ['background', 'Quitar fondo', 'IA y chroma key'],
  ['speed', 'Velocidad', ''],
];

/** Keyframe paths that belong to each group. */
const KEY_PREFIX: Record<AttrGroup, string[]> = {
  adjust: ['adjust.', 'lut.'],
  audio: ['volume'],
  anim: [],
  transform: ['transform.'],
  blend: ['opacity'],
  mask: ['mask.'],
  background: ['chroma.'],
  speed: [],
};

const inGroup = (path: string, g: AttrGroup) => KEY_PREFIX[g].some((p) => path === p || path.startsWith(p));

export function applyAttributes(target: MediaClip, src: MediaClip, groups: AttrGroup[], media: MediaItem[]): MediaClip {
  let c: MediaClip = { ...target };
  const has = (g: AttrGroup) => groups.includes(g);
  if (has('speed') && target.type !== 'image') {
    // same piece of the target's source, at the new speed (limited by its length)
    const srcLen = c.duration * c.speed;
    let duration = srcLen / src.speed;
    const max = sourceDuration(c, media.find((m) => m.id === c.mediaId));
    if (isFinite(max)) duration = Math.min(duration, (max - c.trimStart) / src.speed);
    c = { ...c, speed: src.speed, duration: Math.max(0.1, duration) };
  }
  if (has('adjust')) c = { ...c, adjust: { ...src.adjust }, lut: src.lut && { ...src.lut } };
  if (has('audio')) c = { ...c, volume: src.volume, fadeIn: Math.min(src.fadeIn, c.duration / 2), fadeOut: Math.min(src.fadeOut, c.duration / 2), muted: src.muted, audioFx: src.audioFx };
  if (has('anim')) c = { ...c, animIn: src.animIn && { ...src.animIn }, animOut: src.animOut && { ...src.animOut }, animLoop: src.animLoop && { ...src.animLoop } };
  if (has('transform')) c = { ...c, transform: { ...src.transform }, flipX: src.flipX, flipY: src.flipY };
  if (has('blend')) c = { ...c, opacity: src.opacity, blend: src.blend };
  if (has('mask')) c = { ...c, mask: src.mask && { ...src.mask } };
  if (has('background')) c = { ...c, removeBg: src.removeBg, chroma: src.chroma && { ...src.chroma } };

  // keyframes of the pasted groups: same moments counted from the start of each clip
  const kf: KeyTracks = { ...(c.keyframes ?? {}) };
  for (const path of Object.keys(kf)) if (groups.some((g) => inGroup(path, g))) delete kf[path];
  for (const [path, keys] of Object.entries(src.keyframes ?? {})) {
    if (!keys?.length || !groups.some((g) => inGroup(path, g))) continue;
    kf[path] = keys.map((k): Key => ({ t: c.trimStart + ((k.t - src.trimStart) / src.speed) * c.speed, v: k.v }));
  }
  c.keyframes = Object.keys(kf).length ? kf : undefined;
  return c;
}
