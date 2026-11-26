export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaItem {
  id: string;
  name: string;
  kind: MediaKind;
  file: File;
  url: string;
  duration: number; // seconds (images: default 5)
  width: number;
  height: number;
  hasAudio: boolean;
  thumbnails: string[]; // data URLs (filmstrip)
  waveform?: number[]; // normalized peaks 0..1
  /** where it was downloaded from (music/sound/sticker library), to avoid importing it twice */
  origin?: string;
  /** attribution required by the license (CC BY), to paste in the video description */
  credit?: string;
  /** reopened project whose (big) file wasn't stored: needs "Vincular carpeta" */
  missing?: boolean;
  /** original file size, to find it again when relinking */
  size?: number;
  /** made by Orion (reversed clip, frozen frame…): always saved inside the project */
  generated?: boolean;
}

export type TrackKind = 'video' | 'audio' | 'text';

export interface Track {
  id: string;
  kind: TrackKind;
  muted: boolean;
  /** hidden tracks are kept (e.g. to export them another day) but don't go into the video */
  hidden: boolean;
  /** magnetic: its clips stay together with no gaps (the main track always is) */
  magnet?: boolean;
}

export interface Transform {
  x: number; // offset from center, fraction of canvas width
  y: number; // offset from center, fraction of canvas height
  scale: number;
  rotation: number; // degrees
}

/** One keyframe of one property. `t` is the time inside the SOURCE (seconds), so keyframes stay
 * glued to the same moment of the footage when the clip is cut, trimmed or sped up. */
export interface Key {
  t: number;
  v: number;
}
/** Keyframes per property path, e.g. { x: [...], 'adjust.temp': [...] } */
export type KeyTracks = Partial<Record<string, Key[]>>;

/** Color adjustments, CapCut style: 0 = unchanged. */
export interface Adjustments {
  temp: number; // -100..100
  tint: number;
  saturation: number;
  brightness: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  vibrance: number;
  fade: number; // 0..100
  vignette: number; // 0..100
  sharpen: number; // 0..100
  blur: number; // 0..30 px at 1080p
}

export interface ChromaKey {
  on: boolean;
  color: string; // #rrggbb
  intensity: number; // 0..100 how close a color must be
  shadow: number; // 0..100 edge softness
}

export type MaskShape = 'linear' | 'mirror' | 'circle' | 'rect' | 'star' | 'heart';
export interface Mask {
  shape: MaskShape;
  x: number; // center, fraction of the clip box (-0.5..0.5)
  y: number;
  w: number; // size, fraction of the clip box
  h: number;
  rotation: number;
  feather: number; // 0..100
  round: number; // 0..100 (rectangle corners)
  invert: boolean;
}

export type AnimName =
  | 'fade' | 'zoom-in' | 'zoom-out' | 'slide-left' | 'slide-right' | 'slide-up' | 'slide-down'
  | 'spin' | 'pop' | 'blur' | 'swing' | 'ken-burns' | 'shake' | 'pulse' | 'sway'
  | 'wipe-left' | 'wipe-right' | 'wipe-up' | 'wipe-down' | 'iris' | 'flip-x' | 'flip-y' | 'zoom-blur'
  | 'rise' | 'drop' | 'glitch' | 'rotate-in' | 'shrink' | 'elastic' | 'flash' | 'squeeze' | 'tilt'
  | 'heartbeat' | 'float' | 'wiggle' | 'blink' | 'glitch-loop' | 'pan-lr' | 'spin3d' | 'jelly';
export interface ClipAnimation {
  name: AnimName;
  duration: number; // seconds (ignored by "combinado": uses the whole clip)
}

export type BlendMode = 'source-over' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'luminosity';

/** Camera motion measured by the stabilizer, per sample of the source (see lib/stabilize.ts). */
export interface StabData {
  t0: number; // source time of the first sample
  dt: number; // seconds between samples
  aspect: number; // source width / height
  /** motion between consecutive samples: dx, dy (fraction of the frame), angle (rad), log zoom */
  motion: number[];
}

/** Estabilizador: smooths the camera path and crops a little so borders never show. */
export interface Stabilization {
  on: boolean;
  mode: 'smooth' | 'tripod';
  strength: number; // 0..100 how smooth (mode "smooth")
  crop: number; // 0..30 % zoom used to hide the borders
  data?: StabData;
}

export interface Lut {
  id: string; // built-in look id or imported .cube id
  name: string;
  intensity: number; // 0..100
}

interface BaseClip {
  id: string;
  trackId: string;
  start: number; // timeline seconds
  duration: number; // timeline seconds
}

export type AudioFx = 'none' | 'isolate' | 'remove-voice';

/** A nested timeline ("clip combinado"). Its clips use local times starting at 0. */
export interface CompoundContent {
  kind: 'video' | 'audio';
  tracks: Track[];
  clips: Clip[];
  duration: number;
}

export interface MediaClip extends BaseClip {
  type: 'video' | 'image' | 'audio' | 'compound';
  mediaId: string; // '' for compound clips
  compound?: CompoundContent;
  muted?: boolean;
  audioFx?: AudioFx;
  trimStart: number; // seconds inside the source
  speed: number;
  volume: number; // 0..2
  fadeIn: number;
  fadeOut: number;
  opacity: number; // 0..1
  transform: Transform;
  flipX?: boolean;
  flipY?: boolean;
  blend?: BlendMode;
  adjust: Adjustments;
  lut?: Lut;
  chroma?: ChromaKey;
  mask?: Mask;
  animIn?: ClipAnimation;
  animOut?: ClipAnimation;
  animLoop?: ClipAnimation;
  removeBg: boolean;
  stab?: Stabilization;
  /** "Recortar": part of the picture kept, as fractions cut from each side (0..0.9) */
  crop?: { l: number; t: number; r: number; b: number };
  /** clip turned into its reversed copy ("Revertir"): what it was, to undo it */
  reversedFrom?: { mediaId: string; trimStart: number };
  /** animated properties (any numeric setting: position, scale, color, volume, mask…) */
  keyframes?: KeyTracks;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number; // fraction of canvas height
  color: string;
  bold: boolean;
  italic: boolean;
  strokeColor: string;
  strokeWidth: number; // fraction of font size
  background: string; // '' = none
  align: CanvasTextAlign;
  x: number; // 0..1 (center of text box)
  y: number; // 0..1
  shadow: boolean;
  uppercase: boolean;
}

export interface TextClip extends BaseClip {
  type: 'text';
  text: string;
  style: TextStyle;
  caption?: boolean;
  animation: 'none' | 'pop' | 'fade' | 'slide';
}

export type Clip = MediaClip | TextClip;

export interface ProjectSettings {
  width: number;
  height: number;
  fps: number;
  background: string;
}

export const isMediaClip = (c: Clip): c is MediaClip => c.type !== 'text';
export const isTextClip = (c: Clip): c is TextClip => c.type === 'text';
