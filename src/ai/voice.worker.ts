/// <reference lib="webworker" />
/**
 * Voice processing with RNNoise (open source, free), running in a worker.
 *  - isolate: keeps the voice and removes background noise
 *  - remove-voice: keeps everything except the voice (original minus the isolated voice)
 * Input must be 48 kHz.
 */
import { Rnnoise } from '@shiguredo/rnnoise-wasm';

type Msg = { id: number; channels: Float32Array[]; mode: 'isolate' | 'remove-voice' };

// RNNoise output lags its input by this many samples (measured)
const RNNOISE_DELAY = 960;

let rnnoise: Promise<Rnnoise> | null = null;

/** Called every few hundred frames with the share of this channel done (0..1). */
type Tick = (done: number) => void;

function denoise(r: Rnnoise, input: Float32Array, tick: Tick): Float32Array {
  const N = r.frameSize; // 480
  const state = r.createDenoiseState();
  const out = new Float32Array(input.length);
  const frame = new Float32Array(N);
  // process with a delay compensation tail
  const total = input.length + RNNOISE_DELAY;
  for (let i = 0, f = 0; i < total; i += N, f++) {
    if (f % 100 === 0) tick(i / total); // every second of audio
    for (let k = 0; k < N; k++) {
      const idx = i + k;
      frame[k] = idx < input.length ? input[idx] * 32768 : 0;
    }
    state.processFrame(frame);
    for (let k = 0; k < N; k++) {
      const o = i + k - RNNOISE_DELAY;
      if (o >= 0 && o < out.length) out[o] = frame[k] / 32768;
    }
  }
  state.destroy();
  return out;
}

self.onmessage = async (e: MessageEvent<Msg>) => {
  const { id, channels, mode } = e.data;
  try {
    rnnoise ??= Rnnoise.load();
    const r = await rnnoise;
    const result = channels.map((ch, c) => {
      // progress of the whole job, all channels together
      const voice = denoise(r, ch, (done) => self.postMessage({ id, progress: (c + done) / channels.length }));
      if (mode === 'isolate') return voice;
      const rest = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) rest[i] = ch[i] - voice[i];
      return rest;
    });
    self.postMessage({ id, channels: result }, { transfer: result.map((c) => c.buffer) });
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
