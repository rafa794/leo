/**
 * AI background removal ("recorte automático de persona") using Google MediaPipe's
 * free selfie_multiclass model. Runs 100% locally in the browser (GPU when available).
 */
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

let segmenter: ImageSegmenter | null = null;
let loading: Promise<ImageSegmenter> | null = null;
let failed = false;
let lastTs = 0;
const listeners = new Set<() => void>();

export const segmenterState = () => (segmenter ? 'ready' : failed ? 'error' : loading ? 'loading' : 'idle');
export const onSegmenterChange = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export function ensureSegmenter(): Promise<ImageSegmenter> {
  if (segmenter) return Promise.resolve(segmenter);
  if (loading) return loading;
  const create = async (delegate: 'GPU' | 'CPU') => {
    const fileset = await FilesetResolver.forVisionTasks(`${import.meta.env.BASE_URL}mediapipe-wasm`);
    return ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  };
  loading = create('GPU')
    .catch(() => create('CPU'))
    .then((s) => {
      // warm-up: the first inference compiles GPU shaders and is slow, do it now
      const warm = document.createElement('canvas');
      warm.width = warm.height = 64;
      warm.getContext('2d')!.fillRect(0, 0, 64, 64);
      try {
        s.segmentForVideo(warm, (lastTs = Math.round(performance.now()))).close();
      } catch {
        /* ignore */
      }
      segmenter = s;
      listeners.forEach((l) => l());
      return s;
    })
    .catch((e) => {
      failed = true;
      listeners.forEach((l) => l());
      throw e;
    });
  listeners.forEach((l) => l());
  return loading;
}

const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d')!;
const outCanvas = document.createElement('canvas');
const outCtx = outCanvas.getContext('2d')!;
let maskData: ImageData | null = null;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Returns a canvas with the person(s) kept and the background transparent.
 * If the model isn't loaded yet, starts loading and returns null (caller draws the original).
 * The returned canvas is reused: draw it before calling again.
 */
export function cutout(source: TexImageSource, width: number, height: number): HTMLCanvasElement | null {
  if (!segmenter) {
    if (!failed) ensureSegmenter().catch(() => {});
    return null;
  }
  if (!width || !height) return null;
  lastTs = Math.max(lastTs + 1, Math.round(performance.now()));
  let result;
  try {
    result = segmenter.segmentForVideo(source, lastTs);
  } catch {
    return null;
  }
  const bg = result.confidenceMasks?.[0];
  if (!bg) {
    result.close();
    return null;
  }
  const mw = bg.width;
  const mh = bg.height;
  const conf = bg.getAsFloat32Array();
  if (maskCanvas.width !== mw || maskCanvas.height !== mh || !maskData) {
    maskCanvas.width = mw;
    maskCanvas.height = mh;
    maskData = maskCtx.createImageData(mw, mh);
  }
  const d = maskData.data;
  for (let i = 0; i < conf.length; i++) {
    const a = smooth(0.25, 0.75, 1 - conf[i]);
    d[i * 4] = 255;
    d[i * 4 + 1] = 255;
    d[i * 4 + 2] = 255;
    d[i * 4 + 3] = a * 255;
  }
  result.close();
  maskCtx.putImageData(maskData, 0, 0);

  if (outCanvas.width !== width || outCanvas.height !== height) {
    outCanvas.width = width;
    outCanvas.height = height;
  }
  outCtx.globalCompositeOperation = 'source-over';
  outCtx.clearRect(0, 0, width, height);
  outCtx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  outCtx.globalCompositeOperation = 'destination-in';
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  outCtx.drawImage(maskCanvas, 0, 0, width, height);
  outCtx.globalCompositeOperation = 'source-over';
  return outCanvas;
}
