/// <reference lib="webworker" />
/**
 * Speech-to-text with OpenAI Whisper (open source) running locally via transformers.js.
 * The model is downloaded once from Hugging Face and cached by the browser. 100% free.
 */
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

type Msg = { type: 'transcribe'; audio: Float32Array; model: string; language: string | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asr: any = null;
let loadedModel = '';

async function load(model: string) {
  if (asr && loadedModel === model) return asr;
  const progress_callback = (p: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
    if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
      self.postMessage({ type: 'progress', stage: 'download', file: p.file, progress: p.progress ?? 0 });
    }
  };
  const hasWebGPU = 'gpu' in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
  try {
    if (!hasWebGPU) throw new Error('no webgpu');
    asr = await pipeline('automatic-speech-recognition', model, {
      device: 'webgpu',
      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
      progress_callback,
    });
  } catch {
    asr = await pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', progress_callback });
  }
  loadedModel = model;
  return asr;
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const { audio, model, language } = e.data;
  try {
    self.postMessage({ type: 'progress', stage: 'load', progress: 0 });
    const t = await load(model);
    self.postMessage({ type: 'progress', stage: 'transcribe', progress: 0 });
    const out = await t(audio, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(language ? { language, task: 'transcribe' } : {}),
    });
    self.postMessage({ type: 'done', chunks: out.chunks ?? [{ text: out.text, timestamp: [0, audio.length / 16000] }] });
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
