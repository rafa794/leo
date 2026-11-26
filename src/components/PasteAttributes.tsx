import { useEffect, useState } from 'react';
import { ClipboardPaste, X } from 'lucide-react';
import { useEditor } from '../store/editor';
import { ATTR_GROUPS, type AttrGroup } from '../lib/attributes';

let openFn: ((ids: string[]) => void) | null = null;
/** Opens the "Pegar atributos" dialog for these clips. */
export function openPasteAttributes(ids: string[]) {
  openFn?.(ids);
}

const DEFAULT: AttrGroup[] = ['adjust', 'audio', 'anim', 'blend', 'mask', 'background'];
let remembered: AttrGroup[] = DEFAULT;

/** Choose which settings to paste (like CapCut). Remembers the last choice. */
export default function PasteAttributes() {
  const [ids, setIds] = useState<string[] | null>(null);
  const [groups, setGroups] = useState<AttrGroup[]>(remembered);
  const src = useEditor((s) => s.attrSource);
  useEffect(() => {
    openFn = (x) => {
      setGroups(remembered);
      setIds(x);
    };
    return () => {
      openFn = null;
    };
  }, []);
  if (!ids) return null;
  const close = () => setIds(null);
  const toggle = (g: AttrGroup) => setGroups((gs) => (gs.includes(g) ? gs.filter((x) => x !== g) : [...gs, g]));
  const targets = useEditor.getState().clips.filter((c) => ids.includes(c.id) && c.type !== 'text' && c.id !== src?.id);
  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" style={{ width: 'min(400px, 100%)' }}>
        <div className="modal-head">
          <b>Pegar atributos</b>
          <span className="spacer" />
          <button className="icon-btn" onClick={close}>
            <X size={16} />
          </button>
        </div>
        {!src ? (
          <p className="hint">Primero copia los atributos de un clip (clic derecho → Copiar atributos, o ⌥⌘C).</p>
        ) : (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              Elige qué copiar a {targets.length} clip{targets.length === 1 ? '' : 's'}. Los fotogramas clave de esos ajustes también se copian.
            </p>
            <div className="attr-list">
              {ATTR_GROUPS.map(([id, label, hint]) => (
                <label key={id} className="attr-item">
                  <input type="checkbox" checked={groups.includes(id)} onChange={() => toggle(id)} />
                  <span>
                    <b>{label}</b>
                    {hint && <span className="hint"> · {hint}</span>}
                  </span>
                </label>
              ))}
            </div>
            <div className="btn-row" style={{ justifyContent: 'flex-end', margin: '12px 0 0' }}>
              <button className="btn small" onClick={() => setGroups(groups.length === ATTR_GROUPS.length ? [] : ATTR_GROUPS.map((g) => g[0]))}>
                {groups.length === ATTR_GROUPS.length ? 'Ninguno' : 'Todos'}
              </button>
              <span className="spacer" />
              <button className="btn small" onClick={close}>
                Cancelar
              </button>
              <button
                className="btn small primary"
                disabled={!groups.length || !targets.length}
                onClick={() => {
                  remembered = groups;
                  useEditor.getState().pasteAttributes(ids, groups);
                  close();
                }}
              >
                <ClipboardPaste size={14} /> Pegar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
