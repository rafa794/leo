/**
 * "Efectos" (CapCut style), all drawn by the WebGL color pass in lib/gl.ts — a few texture reads per pixel,
 * so they run on any machine with WebGL2 (no dedicated GPU needed). `code` is the number the shader switches on.
 * Animated effects use the clip's own time, so preview and export look the same.
 */
export interface EffectDef {
  id: string;
  name: string;
  code: number;
  /** intensity a freshly applied effect starts with (0..100) */
  intensity: number;
  /** has a "Velocidad" setting (it moves) */
  animated?: boolean;
}

export const EFFECTS: EffectDef[] = [
  { id: 'blur', name: 'Desenfoque', code: 1, intensity: 50 },
  { id: 'zoomblur', name: 'Desenfoque de zoom', code: 2, intensity: 50 },
  { id: 'pixel', name: 'Pixelado', code: 3, intensity: 40 },
  { id: 'rgb', name: 'Separación RGB', code: 4, intensity: 50, animated: true },
  { id: 'glitch', name: 'Glitch', code: 5, intensity: 60, animated: true },
  { id: 'vhs', name: 'VHS', code: 6, intensity: 70, animated: true },
  { id: 'grain', name: 'Grano de película', code: 7, intensity: 50, animated: true },
  { id: 'shake', name: 'Temblor', code: 8, intensity: 50, animated: true },
  { id: 'pulse', name: 'Latido', code: 9, intensity: 60, animated: true },
  { id: 'wave', name: 'Onda', code: 10, intensity: 50, animated: true },
  { id: 'flash', name: 'Destellos', code: 11, intensity: 60, animated: true },
  { id: 'mirror', name: 'Espejo', code: 12, intensity: 100 },
  { id: 'kaleido', name: 'Caleidoscopio', code: 13, intensity: 100 },
  { id: 'split', name: 'Pantalla dividida', code: 14, intensity: 100 },
  { id: 'bulge', name: 'Ojo de pez', code: 15, intensity: 60 },
  { id: 'neon', name: 'Neón', code: 16, intensity: 80, animated: true },
  { id: 'comic', name: 'Cómic', code: 17, intensity: 70 },
  { id: 'duotone', name: 'Duotono', code: 18, intensity: 80 },
  { id: 'invert', name: 'Negativo', code: 19, intensity: 100 },
  { id: 'glow', name: 'Resplandor', code: 20, intensity: 50 },
  { id: 'bars', name: 'Barras de cine', code: 21, intensity: 60 },
  { id: 'rainbow', name: 'Arcoíris', code: 22, intensity: 50, animated: true },
];

export const EFFECT_GROUPS: [string, string[]][] = [
  ['Básicos', ['blur', 'zoomblur', 'pixel', 'glow', 'bars']],
  ['Retro', ['vhs', 'grain', 'rgb', 'glitch']],
  ['Movimiento', ['shake', 'pulse', 'wave', 'flash']],
  ['Divertidos', ['mirror', 'kaleido', 'split', 'bulge']],
  ['Estilo', ['neon', 'comic', 'duotone', 'invert', 'rainbow']],
];

const byId = new Map(EFFECTS.map((e) => [e.id, e]));
export const effectDef = (id: string | undefined) => (id ? byId.get(id) : undefined);
