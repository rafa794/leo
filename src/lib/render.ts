import type { Clip, MediaClip, ProjectSettings, TextClip, Track } from '../types';
import { isMediaClip } from '../types';
import { cutout } from '../ai/segmenter';
import { animated } from './keyframes';
import { colorPass, needsColorPass } from './gl';
import { stabAt } from './stabilize';

export interface FrameSource {
  image: CanvasImageSource;
  width: number;
  height: number;
}

export interface HitBox {
  clipId: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
}

export interface RenderInput {
  time: number;
  tracks: Track[];
  clips: Clip[];
  settings: ProjectSettings;
  /** key = unique leaf path (see flattenLeaves) */
  getSource: (clip: MediaClip, key: string) => FrameSource | null;
  /** canvases reused for compound clips */
  pool: Map<string, HTMLCanvasElement>;
}

export const isActive = (c: Clip, t: number) => t >= c.start && t < c.start + c.duration;

/** Draws one frame of the composition. Used by both the preview and the exporter. */
export function renderFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  W: number,
  H: number,
  input: RenderInput,
  path = '',
): HitBox[] {
  const { time, tracks, clips, settings, getSource, pool } = input;
  const hits: HitBox[] = [];
  ctx.save();
  if (path) ctx.clearRect(0, 0, W, H);
  else {
    ctx.fillStyle = settings.background;
    ctx.fillRect(0, 0, W, H);
  }

  // bottom track first
  for (let ti = tracks.length - 1; ti >= 0; ti--) {
    const track = tracks[ti];
    if (track.hidden || track.kind === 'audio') continue;
    for (const clip of clips) {
      if (clip.trackId !== track.id || !isActive(clip, time)) continue;
      if (isMediaClip(clip)) {
        if (clip.type === 'audio') continue;
        let src: FrameSource | null;
        if (clip.type === 'compound') {
          if (!clip.compound || clip.compound.kind === 'audio') continue;
          // render the nested timeline into its own canvas, then treat it like a video frame
          const key = `${path}${clip.id}`;
          let canvas = pool.get(key);
          if (!canvas) {
            canvas = document.createElement('canvas');
            pool.set(key, canvas);
          }
          if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W;
            canvas.height = H;
          }
          const local = clip.trimStart + (time - clip.start) * clip.speed;
          renderFrame(canvas.getContext('2d')!, W, H, { ...input, time: local, tracks: clip.compound.tracks, clips: clip.compound.clips }, `${key}/`);
          src = { image: canvas, width: W, height: H };
        } else src = getSource(clip, path + clip.id);
        if (!src) continue;
        const hit = drawMedia(ctx, W, H, clip, src, time);
        if (hit) hits.push(hit);
      } else {
        hits.push(drawText(ctx, W, H, clip, time));
      }
    }
  }
  ctx.restore();
  return hits;
}

const easeOut = (p: number) => 1 - Math.pow(1 - p, 3);
const backOut = (p: number) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);
const bounceOut = (p: number) => {
  const n = 7.5625;
  const d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
};
const elasticOut = (p: number) => (p <= 0 ? 0 : p >= 1 ? 1 : Math.pow(2, -10 * p) * Math.sin(((p * 10 - 0.75) * 2 * Math.PI) / 3) + 1);

/** Entrance / exit / loop animation of a media clip at a moment (offsets on top of its transform). */
export function animState(c: MediaClip, time: number) {
  const st = { dx: 0, dy: 0, scale: 1, sx: 1, sy: 1, rot: 0, alpha: 1, blur: 0, reveal: null as null | { l: number; t: number; r: number; b: number }, iris: 1, flash: 0 };
  const local = time - c.start;
  // pseudo-random but repeatable (glitch effects look the same in preview and export)
  const rnd = (k: number) => {
    const x = Math.sin(k * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  const one = (name: string, e: number, p: number, dir: 1 | -1) => {
    const r = 1 - e; // 1 at the far end of the animation, 0 when settled
    switch (name) {
      case 'fade': st.alpha *= e; break;
      case 'zoom-in': st.scale *= 1 - 0.5 * r; st.alpha *= e; break;
      case 'zoom-out': st.scale *= 1 + 0.5 * r; st.alpha *= e; break;
      case 'slide-left': st.dx += dir * r; break;
      case 'slide-right': st.dx -= dir * r; break;
      case 'slide-up': st.dy += dir * r; break;
      case 'slide-down': st.dy -= dir * r; break;
      case 'spin': st.rot -= dir * 180 * r; st.scale *= 1 - 0.7 * r; st.alpha *= e; break;
      case 'pop': st.scale *= Math.max(0, dir === 1 ? backOut(e) : e); break;
      case 'blur': st.blur += 30 * r; st.alpha *= e; break;
      case 'swing': st.rot += 25 * r * Math.sin(r * Math.PI * 3); st.alpha *= Math.min(1, e * 2); break;
      // reveals: the picture appears / disappears from one side
      case 'wipe-left': st.reveal = { l: 0, t: 0, r: r, b: 0 }; break;
      case 'wipe-right': st.reveal = { l: r, t: 0, r: 0, b: 0 }; break;
      case 'wipe-up': st.reveal = { l: 0, t: 0, r: 0, b: r }; break;
      case 'wipe-down': st.reveal = { l: 0, t: r, r: 0, b: 0 }; break;
      case 'iris': st.iris = e; break;
      case 'flip-x': st.sx *= Math.max(0.001, Math.cos((r * Math.PI) / 2)); st.alpha *= Math.min(1, e * 3); break;
      case 'flip-y': st.sy *= Math.max(0.001, Math.cos((r * Math.PI) / 2)); st.alpha *= Math.min(1, e * 3); break;
      case 'zoom-blur': st.scale *= 1 + 0.6 * r; st.blur += 25 * r; st.alpha *= e; break;
      case 'rise': st.dy += dir * 0.25 * r; st.alpha *= e; break;
      case 'drop': st.dy -= dir * 0.6 * (1 - (dir === 1 ? bounceOut(p) : e)); break;
      case 'glitch':
        if (r > 0.02) {
          const k = Math.floor(local * 30);
          st.dx += (rnd(k) - 0.5) * 0.08 * r;
          st.dy += (rnd(k + 7) - 0.5) * 0.03 * r;
          st.alpha *= rnd(k + 3) > 0.25 * r ? 1 : 0.2;
        }
        break;
      case 'rotate-in': st.rot -= dir * 90 * r; st.alpha *= e; break;
      case 'shrink': st.scale *= 1 + 1.2 * r; st.blur += 10 * r; st.alpha *= e; break;
      case 'elastic': st.scale *= dir === 1 ? Math.max(0, elasticOut(p)) : e; break;
      case 'flash': st.alpha *= e; st.flash = Math.max(st.flash, r * 0.9); break;
      case 'squeeze': st.sx *= 1 + 0.8 * r; st.sy *= Math.max(0.05, 1 - 0.9 * r); st.alpha *= e; break;
      case 'tilt': st.rot += dir * 12 * r; st.dy += dir * 0.15 * r; st.alpha *= e; break;
    }
  };
  if (c.animIn && local < c.animIn.duration) {
    const p = Math.max(0, local / c.animIn.duration);
    one(c.animIn.name, easeOut(p), p, 1);
  }
  if (c.animOut) {
    const left = c.duration - local;
    if (left < c.animOut.duration) {
      const p = Math.max(0, left / c.animOut.duration);
      one(c.animOut.name, easeOut(p), p, -1);
    }
  }
  if (c.animLoop) {
    const u = Math.min(1, Math.max(0, local / c.duration));
    const period = Math.max(0.2, c.animLoop.duration);
    const w = (local / period) * Math.PI * 2;
    switch (c.animLoop.name) {
      case 'ken-burns': st.scale *= 1 + 0.18 * u; break;
      case 'zoom-out': st.scale *= 1.18 - 0.18 * u; break;
      case 'shake': st.dx += Math.sin(local * 41) * 0.006; st.dy += Math.cos(local * 33) * 0.006; break;
      case 'pulse': st.scale *= 1 + 0.04 * Math.sin(w); break;
      case 'sway': st.rot += 3 * Math.sin(w); break;
      case 'spin': st.rot += (local / period) * 360; break;
      case 'heartbeat': {
        const ph = (local / period) % 1;
        st.scale *= 1 + 0.07 * Math.max(Math.exp(-Math.pow((ph - 0.1) * 18, 2)), 0.7 * Math.exp(-Math.pow((ph - 0.3) * 18, 2)));
        break;
      }
      case 'float': st.dy += 0.02 * Math.sin(w); break;
      case 'wiggle': st.rot += 4 * Math.sin(w * 2.3) * Math.sin(w * 0.7); break;
      case 'blink': st.alpha *= (local / period) % 1 < 0.85 ? 1 : 0.15; break;
      case 'glitch-loop': {
        const k = Math.floor(local * 24);
        if (rnd(k) > 0.85) {
          st.dx += (rnd(k + 1) - 0.5) * 0.05;
          st.sx *= 1 + (rnd(k + 2) - 0.5) * 0.1;
        }
        break;
      }
      case 'pan-lr': st.scale *= 1.15; st.dx += 0.06 * Math.sin(w / 2); break;
      case 'spin3d': st.sx *= Math.cos(w / 2) || 0.001; break;
      case 'jelly': st.sx *= 1 + 0.05 * Math.sin(w * 2); st.sy *= 1 - 0.05 * Math.sin(w * 2); break;
    }
  }
  return st;
}

function drawMedia(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, W: number, H: number, clip0: MediaClip, src: FrameSource, time: number): HitBox | null {
  if (!src.width || !src.height) return null;
  const clip = animated(clip0, time); // keyframes evaluated at this moment
  let image: CanvasImageSource = src.image;
  if (clip.removeBg) {
    const cut = cutout(src.image as TexImageSource, src.width, src.height);
    if (cut) image = cut;
  }
  const tr = clip.transform;
  const an = animState(clip, time);
  // "Recortar": keep only part of the source picture
  const cr = clip.crop;
  const sx = cr ? cr.l * src.width : 0;
  const sy = cr ? cr.t * src.height : 0;
  const sw = cr ? Math.max(2, src.width * (1 - cr.l - cr.r)) : src.width;
  const sh = cr ? Math.max(2, src.height * (1 - cr.t - cr.b)) : src.height;
  const fit = Math.min(W / sw, H / sh) * tr.scale * an.scale;
  const w = sw * fit;
  const h = sh * fit;
  if (w < 0.5 || h < 0.5 || clip.opacity * an.alpha <= 0) return null;
  const cx = W / 2 + (tr.x + an.dx) * W;
  const cy = H / 2 + (tr.y + an.dy) * H;
  const rotation = tr.rotation + an.rot;

  // color, LUT, chroma key and mask on the GPU
  let fallbackFilter = '';
  if (needsColorPass(clip)) {
    const out = colorPass.run(clip, image, src.width, src.height, w, h);
    if (out) image = out;
    else {
      const a = clip.adjust;
      fallbackFilter = `brightness(${100 + a.brightness}%) contrast(${100 + a.contrast}%) saturate(${100 + a.saturation}%) `;
    }
  }

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, clip.opacity * an.alpha));
  if (clip.blend && clip.blend !== 'source-over') ctx.globalCompositeOperation = clip.blend;
  const blur = ((clip.adjust.blur + an.blur) * W) / 1920;
  const filter = fallbackFilter + (blur > 0 ? `blur(${blur}px)` : '');
  if (filter.trim()) ctx.filter = filter.trim();
  ctx.translate(cx, cy);
  if (rotation) ctx.rotate((rotation * Math.PI) / 180);
  if (clip.flipX || clip.flipY) ctx.scale(clip.flipX ? -1 : 1, clip.flipY ? -1 : 1);
  if (an.sx !== 1 || an.sy !== 1) ctx.scale(an.sx, an.sy);
  // reveal / iris animations: only part of the picture is shown
  if (an.reveal) {
    const rv = an.reveal;
    ctx.beginPath();
    ctx.rect(-w / 2 + rv.l * w, -h / 2 + rv.t * h, w * Math.max(0, 1 - rv.l - rv.r), h * Math.max(0, 1 - rv.t - rv.b));
    ctx.clip();
  }
  if (an.iris < 1) {
    ctx.beginPath();
    ctx.arc(0, 0, (Math.hypot(w, h) / 2) * Math.max(0.0001, an.iris), 0, Math.PI * 2);
    ctx.clip();
  }
  // estabilizador: small move / turn / zoom of the picture inside its own frame
  const sb = stabAt(clip, clip.trimStart + (time - clip.start) * clip.speed);
  if (sb) {
    ctx.beginPath();
    ctx.rect(-w / 2, -h / 2, w, h);
    ctx.clip();
    ctx.translate(sb.u * w, sb.v * h);
    ctx.rotate(sb.a);
    ctx.scale(sb.k, sb.k);
  }
  if (cr) {
    // the color pass may have made the picture smaller than the source: scale the crop to it
    const iw = (image as { width: number }).width || src.width;
    const ih = (image as { height: number }).height || src.height;
    const kx = iw / src.width;
    const ky = ih / src.height;
    ctx.drawImage(image, sx * kx, sy * ky, sw * kx, sh * ky, -w / 2, -h / 2, w, h);
  } else ctx.drawImage(image, -w / 2, -h / 2, w, h);
  if (an.flash) {
    // "Destello": a white flash over the picture
    ctx.globalAlpha = an.flash;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#fff';
    ctx.fillRect(-w / 2, -h / 2, w, h);
  }
  ctx.restore();
  return { clipId: clip.id, cx, cy, w, h, rotation };
}

export function fontString(clip: TextClip, px: number) {
  const s = clip.style;
  return `${s.italic ? 'italic ' : ''}${s.bold ? '900' : '500'} ${px}px "${s.fontFamily}", sans-serif`;
}

function wrapLines(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, text: string, maxW: number) {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/);
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        out.push(line);
        line = w;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

function drawText(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, W: number, H: number, clip: TextClip, time: number): HitBox {
  const s = clip.style;
  const px = Math.max(4, s.fontSize * H);
  const text = s.uppercase ? clip.text.toUpperCase() : clip.text;
  ctx.save();
  ctx.font = fontString(clip, px);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, text, W * 0.9);
  const lineH = px * 1.15;
  const blockW = Math.max(...lines.map((l) => ctx.measureText(l).width), 1);
  const blockH = lines.length * lineH;
  const cx = s.x * W;
  const cy = s.y * H;

  // entrance animation
  const local = time - clip.start;
  let scale = 1;
  let alpha = 1;
  let dy = 0;
  const AN = 0.2;
  if (clip.animation === 'pop' && local < AN) {
    const k = local / AN;
    scale = 0.6 + 0.4 * (1 - Math.pow(1 - k, 3)) + Math.sin(k * Math.PI) * 0.08;
  } else if (clip.animation === 'fade' && local < AN * 1.5) {
    alpha = local / (AN * 1.5);
  } else if (clip.animation === 'slide' && local < AN * 1.5) {
    const k = 1 - Math.pow(1 - local / (AN * 1.5), 3);
    dy = (1 - k) * px;
    alpha = k;
  }

  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy + dy);
  ctx.scale(scale, scale);

  if (s.background) {
    const pad = px * 0.3;
    ctx.fillStyle = s.background;
    const r = px * 0.2;
    const x = -blockW / 2 - pad;
    const y = -blockH / 2 - pad * 0.6;
    ctx.beginPath();
    ctx.roundRect(x, y, blockW + pad * 2, blockH + pad * 1.2, r);
    ctx.fill();
  }

  lines.forEach((line, i) => {
    const y = -blockH / 2 + lineH * (i + 0.5);
    let x = 0;
    if (s.align === 'left') x = -blockW / 2 + ctx.measureText(line).width / 2;
    if (s.align === 'right') x = blockW / 2 - ctx.measureText(line).width / 2;
    if (s.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = px * 0.15;
      ctx.shadowOffsetY = px * 0.05;
    }
    if (s.strokeWidth > 0) {
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.lineWidth = px * s.strokeWidth;
      ctx.strokeStyle = s.strokeColor;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, x, y);
    ctx.shadowColor = 'transparent';
  });
  ctx.restore();
  return { clipId: clip.id, cx, cy, w: blockW + px * 0.6, h: blockH + px * 0.4, rotation: 0 };
}
