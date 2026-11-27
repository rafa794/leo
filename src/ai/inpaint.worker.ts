/// <reference lib="webworker" />
/**
 * "Borrar objetos" (object removal): MI-GAN inpainting (Picsart AI Research, MIT licence), 512 Places2 model
 * converted to ONNX with the authors' own pipeline script. It runs on the CPU with onnxruntime-web (WebAssembly):
 * a few hundred ms per picture on a normal laptop, no graphics card needed.
 *
 * The model file ships with the app (public/models/migan, split in two pieces because Cloudflare Pages takes
 * files up to 25 MiB) — nothing is downloaded from anywhere else and nothing leaves the device.
 *
 * In:  RGBA pixels + a mask (255 = erase, 0 = keep), same size.
 * Out: RGBA pixels with the masked area filled in (the rest untouched).
 */
import * as ort from 'onnxruntime-web/wasm';

const PARTS = ['migan-512.onnx.partaa', 'migan-512.onnx.partab'];

let session: Promise<ort.InferenceSession> | null = null;
function load(base: string) {
  session ??= (async () => {
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    const parts = await Promise.all(
      PARTS.map(async (p) => {
        const r = await fetch(`${base}models/migan/${p}`);
        if (!r.ok) throw new Error('No se encontró el modelo para borrar objetos');
        return new Uint8Array(await r.arrayBuffer());
      }),
    );
    const model = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
      model.set(p, off);
      off += p.length;
    }
    return ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })().catch((e) => {
    session = null;
    throw e;
  });
  return session;
}

export interface InpaintRequest {
  id: number;
  base: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** 255 = erase */
  mask: Uint8Array;
}

self.onmessage = async (e: MessageEvent<InpaintRequest | { id: number; base: string; warmup: true }>) => {
  const msg = e.data;
  try {
    const s = await load(msg.base);
    if ('warmup' in msg) return self.postMessage({ id: msg.id, ok: true });
    const { width: w, height: h, rgba, mask } = msg;
    const n = w * h;
    // model input: image (1,3,H,W) uint8, mask (1,1,H,W) uint8 with 255 = keep, 0 = hole
    const img = new Uint8Array(3 * n);
    const keep = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      img[i] = rgba[i * 4];
      img[n + i] = rgba[i * 4 + 1];
      img[2 * n + i] = rgba[i * 4 + 2];
      keep[i] = mask[i] ? 0 : 255;
    }
    const out = await s.run({
      image: new ort.Tensor('uint8', img, [1, 3, h, w]),
      mask: new ort.Tensor('uint8', keep, [1, 1, h, w]),
    });
    const res = out.result.data as Uint8Array;
    const px = new Uint8ClampedArray(rgba);
    for (let i = 0; i < n; i++) {
      px[i * 4] = res[i];
      px[i * 4 + 1] = res[n + i];
      px[i * 4 + 2] = res[2 * n + i];
    }
    self.postMessage({ id: msg.id, ok: true, rgba: px }, { transfer: [px.buffer] });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
