import type { ClipEffect, Lut, MediaClip } from '../types';
import { defaultAdjust } from '../store/editor';
import { colorPass } from './gl';

/**
 * Small previews for the "Filtros" and "Efectos" galleries: a frame of the clip run through the same WebGL
 * pass as the editor, so each tile shows exactly what the filter / effect will do to this video.
 */

const W = 160;
const H = 100;

/** A neutral picture (sky, sun, grass) for when the clip has no thumbnail. */
function sample(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, H * 0.6);
  sky.addColorStop(0, '#3b82c4');
  sky.addColorStop(1, '#f2b880');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffe08a';
  g.beginPath();
  g.arc(W * 0.72, H * 0.42, 13, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#3f7d3a';
  g.fillRect(0, H * 0.6, W, H * 0.4);
  g.fillStyle = '#2b2b2b';
  g.fillRect(W * 0.2, H * 0.32, 10, 34);
  g.fillStyle = '#d9473f';
  g.beginPath();
  g.arc(W * 0.2 + 5, H * 0.3, 7, 0, Math.PI * 2);
  g.fill();
  return c;
}

/** The base picture of the tiles, cropped to the tile shape. */
export function loadBase(src: string | undefined): Promise<HTMLCanvasElement> {
  if (!src) return Promise.resolve(sample());
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const k = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      const w = img.naturalWidth * k;
      const h = img.naturalHeight * k;
      c.getContext('2d')!.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      resolve(c);
    };
    img.onerror = () => resolve(sample());
    img.src = src;
  });
}

const cache = new Map<string, string>();

/** Data URL of the base picture with a filter and / or effect applied ('' if WebGL isn't available). */
export function lookThumb(base: HTMLCanvasElement, baseKey: string, look: { lut?: Lut; effect?: ClipEffect }): string {
  const key = `${baseKey}|${look.lut?.id ?? ''}|${look.effect?.id ?? ''}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const fake = { adjust: defaultAdjust(), lut: look.lut, effect: look.effect } as MediaClip;
  const out = colorPass.run(fake, base, base.width, base.height, base.width, base.height, 0.6);
  const url = out ? out.toDataURL('image/jpeg', 0.8) : '';
  if (cache.size > 600) cache.clear();
  cache.set(key, url);
  return url;
}
