import { useEditor } from '../store/editor';
import type { TextStyle } from '../types';

export const FONTS = ['Montserrat', 'Anton', 'Bebas Neue', 'Inter', 'Permanent Marker', 'Arial', 'Impact', 'Georgia'];

export const TEXT_PRESETS: { name: string; text: string; style: Partial<TextStyle> }[] = [
  { name: 'Básico', text: 'Escribe aquí', style: {} },
  { name: 'GOLAZO', text: '¡GOLAZO!', style: { fontFamily: 'Anton', color: '#facc15', fontSize: 0.14, strokeWidth: 0.1, uppercase: true } },
  { name: 'Marcador', text: 'LOCAL 2 - 1 VISITA', style: { fontFamily: 'Bebas Neue', fontSize: 0.06, background: '#111827', strokeWidth: 0, color: '#ffffff', y: 0.1 } },
  { name: 'Caja', text: 'Jugada del día', style: { fontFamily: 'Montserrat', background: '#22d3ee', color: '#001318', strokeWidth: 0, shadow: false } },
  { name: 'Neón', text: 'SKILLS', style: { fontFamily: 'Montserrat', color: '#f0abfc', strokeColor: '#7e22ce', strokeWidth: 0.18, fontSize: 0.12 } },
  { name: 'Graffiti', text: 'Fútbol 7', style: { fontFamily: 'Permanent Marker', color: '#ffffff', strokeColor: '#e11d48', strokeWidth: 0.14, fontSize: 0.1 } },
  { name: 'Título', text: 'PARTIDO DEL DOMINGO', style: { fontFamily: 'Bebas Neue', fontSize: 0.11, strokeWidth: 0, color: '#ffffff', shadow: true } },
  { name: 'Nombre', text: '#10 Rafa', style: { fontFamily: 'Montserrat', fontSize: 0.05, background: 'rgba(0,0,0,0.6)', strokeWidth: 0, x: 0.22, y: 0.88 } },
];

export default function TextPanel() {
  const addText = useEditor((s) => s.addText);
  return (
    <>
      <div className="panel-title">Texto</div>
      <div className="panel-body">
        <button className="btn block primary" style={{ marginBottom: 14 }} onClick={() => addText()}>
          + Añadir texto
        </button>
        <div className="preset-grid">
          {TEXT_PRESETS.map((p) => (
            <button
              key={p.name}
              className="preset"
              title={`Añadir "${p.name}" en la posición del cursor`}
              onClick={() => addText(p.text, p.style)}
              style={{
                fontFamily: `"${p.style.fontFamily ?? 'Montserrat'}"`,
                color: p.style.color ?? '#fff',
                fontWeight: 900,
                background: p.style.background || undefined,
                WebkitTextStroke: p.style.strokeWidth === 0 ? undefined : `1px ${p.style.strokeColor ?? '#000'}`,
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 14 }}>
          El texto se añade donde está el cursor de reproducción. Edítalo en el panel derecho y muévelo arrastrándolo en el visor.
        </p>
      </div>
    </>
  );
}
