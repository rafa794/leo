import { useEffect, useRef, useState } from 'react';
import { CheckSquare, Copy, ListPlus, Music, Plus, Trash2, Upload } from 'lucide-react';
import { useEditor } from '../store/editor';
import { importFiles } from '../lib/importFiles';
import { formatTime } from '../lib/util';
import ContextMenu, { type MenuState } from './ContextMenu';

export const MEDIA_DRAG_TYPE = 'application/x-orion-media';

type Box = { x: number; y: number; w: number; h: number };

export default function MediaPanel() {
  const media = useEditor((s) => s.media);
  const status = useEditor((s) => s.status);
  const selection = useEditor((s) => s.mediaSelection);
  const { addMediaClips, removeMedia, setMediaSelection, setFocusArea, copyMedia } = useEditor.getState();
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const importing = status?.startsWith('Importando');
  const sel = selection.filter((id) => media.some((m) => m.id === id));
  // keep media order (= recording order) when adding several
  const ordered = (ids: string[]) => media.filter((m) => ids.includes(m.id)).map((m) => m.id);
  const setSelected = (ids: string[]) => setMediaSelection(ids);

  // forget the selection of removed files
  useEffect(() => {
    if (sel.length !== selection.length) setMediaSelection(sel);
  }, [sel.length, selection.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const onItemClick = (e: React.MouseEvent, id: string) => {
    if (e.shiftKey && anchor) {
      const a = media.findIndex((m) => m.id === anchor);
      const b = media.findIndex((m) => m.id === id);
      const range = media.slice(Math.min(a, b), Math.max(a, b) + 1).map((m) => m.id);
      setSelected(Array.from(new Set([...sel, ...range])));
    } else if (e.metaKey || e.ctrlKey) {
      setSelected(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
      setAnchor(id);
    } else {
      setSelected([id]);
      setAnchor(id);
    }
  };

  /* Click and drag on an empty area to select files with a box */
  const onBodyPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    setFocusArea('media');
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('.media-item, .dropzone, button, input, .media-actions')) return;
    const body = bodyRef.current!;
    const toLocal = (cx: number, cy: number) => {
      const r = body.getBoundingClientRect();
      return { x: cx - r.left + body.scrollLeft, y: cy - r.top + body.scrollTop };
    };
    const p0 = toLocal(e.clientX, e.clientY);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? sel : [];
    let last = { x: e.clientX, y: e.clientY };
    let boxing = false;
    let raf = 0;

    const update = () => {
      const p = toLocal(last.x, last.y);
      const b = { x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
      setBox(b);
      const r = body.getBoundingClientRect();
      const hit: string[] = [];
      body.querySelectorAll<HTMLElement>('[data-media-id]').forEach((el) => {
        const er = el.getBoundingClientRect();
        const x = er.left - r.left + body.scrollLeft;
        const y = er.top - r.top + body.scrollTop;
        if (x < b.x + b.w && x + er.width > b.x && y < b.y + b.h && y + er.height > b.y) hit.push(el.dataset.mediaId!);
      });
      setMediaSelection(Array.from(new Set([...base, ...hit])));
    };
    // scroll the list when dragging near its top/bottom edge
    const tick = () => {
      const r = body.getBoundingClientRect();
      const edge = 36;
      let dy = 0;
      if (last.y > r.bottom - edge) dy = Math.min(18, (last.y - (r.bottom - edge)) / 2);
      else if (last.y < r.top + edge) dy = -Math.min(18, (r.top + edge - last.y) / 2);
      if (dy) {
        body.scrollTop += dy;
        update();
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY };
      if (!boxing && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      if (!boxing) raf = requestAnimationFrame(tick);
      boxing = true;
      update();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      cancelAnimationFrame(raf);
      setBox(null);
      if (!boxing && !additive) setSelected([]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <>
      <div className="panel-title">Multimedia</div>
      <div className="panel-body media-body" ref={bodyRef} onPointerDown={onBodyPointerDown}>
        <div
          className={`dropzone ${over ? 'over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            importFiles(Array.from(e.dataTransfer.files));
          }}
        >
          <Upload size={22} style={{ marginBottom: 6 }} />
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>Importar</div>
          <div className="hint">Arrastra aquí vídeos, música o fotos</div>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          hidden
          onChange={(e) => {
            importFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />

        {media.length > 0 && (
          // always visible (disabled when nothing is selected) so the grid doesn't jump while box-selecting
          <div className="media-actions">
            <button className="btn small primary" disabled={!sel.length} onClick={() => addMediaClips(ordered(sel))} title="Añadir los seleccionados al final de la línea de tiempo, en orden">
              <ListPlus size={14} /> Añadir {sel.length > 1 ? `${sel.length} ` : ''}a la línea de tiempo
            </button>
            <button className="btn small" disabled={!sel.length} onClick={() => copyMedia(ordered(sel))} title="Copiar (⌘C) y pegar en la línea de tiempo con ⌘V">
              <Copy size={14} /> Copiar
            </button>
          </div>
        )}

        <div className="media-grid">
          {media.map((m) => {
            const isSel = sel.includes(m.id);
            return (
              <div
                key={m.id}
                data-media-id={m.id}
                className={`media-item ${isSel ? 'selected' : ''}`}
                draggable
                title={`${m.name} — arrástralo a la línea de tiempo`}
                onClick={(e) => onItemClick(e, m.id)}
                onDragStart={(e) => {
                  // dragging a selected item drags the whole selection
                  const ids = isSel ? ordered(sel) : [m.id];
                  if (!isSel) setSelected([m.id]);
                  e.dataTransfer.setData(MEDIA_DRAG_TYPE, JSON.stringify(ids));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onDoubleClick={() => addMediaClips([m.id])}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const ids = isSel ? ordered(sel) : [m.id];
                  if (!isSel) setSelected([m.id]);
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      ...(ids.length > 1 ? [{ header: `${ids.length} archivos seleccionados` }] : []),
                      { label: ids.length > 1 ? `Añadir ${ids.length} a la línea de tiempo` : 'Añadir a la línea de tiempo', icon: <ListPlus size={14} />, onClick: () => addMediaClips(ids) },
                      { label: 'Copiar', icon: <Copy size={14} />, shortcut: '⌘C', onClick: () => copyMedia(ids) },
                      { label: 'Seleccionar todo', icon: <CheckSquare size={14} />, shortcut: '⌘A', onClick: () => setSelected(media.map((x) => x.id)) },
                      { separator: true },
                      {
                        label: ids.length > 1 ? `Quitar ${ids.length} del proyecto` : 'Quitar del proyecto',
                        icon: <Trash2 size={14} />,
                        danger: true,
                        onClick: () => ids.forEach((id) => removeMedia(id)),
                      },
                    ],
                  });
                }}
              >
                {m.kind === 'audio' ? (
                  <div className="audio-thumb">
                    <Music size={26} />
                  </div>
                ) : (
                  <img src={m.thumbnails[Math.floor(m.thumbnails.length / 3)] ?? m.thumbnails[0]} alt="" style={m.origin ? { objectFit: 'contain', padding: 8 } : undefined} />
                )}
                {m.missing && (
                  <div className="missing-tag" title="Archivo no encontrado: elige su carpeta en el aviso de arriba">
                    Falta el archivo
                  </div>
                )}
                {isSel && sel.length > 1 && <div className="check">{ordered(sel).indexOf(m.id) + 1}</div>}
                <div className="meta">
                  <span translate="no">{m.name}</span>
                  {m.kind !== 'image' && <span>{formatTime(m.duration)}</span>}
                </div>
                <button
                  className="add"
                  title="Añadir a la línea de tiempo"
                  onClick={(e) => {
                    e.stopPropagation();
                    addMediaClips(isSel ? ordered(sel) : [m.id]);
                  }}
                >
                  <Plus size={16} />
                </button>
                <button
                  className="del"
                  title="Quitar del proyecto"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeMedia(m.id);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            );
          })}
          {importing && <div className="media-item loading-item">{status}</div>}
        </div>
        {!media.length && !importing && (
          <p className="hint" style={{ marginTop: 14 }}>
            Consejo: importa todos tus clips de golpe y luego selecciona los que quieras para añadirlos en orden, uno detrás de otro.
          </p>
        )}
        {media.length > 1 && (
          <p className="hint" style={{ marginTop: 12 }}>
            Haz clic en un hueco y arrastra para seleccionar varios con un recuadro (o ⌘+clic, ⇧+clic). Luego arrástralos a la línea de tiempo, o cópialos con ⌘C y pégalos con ⌘V.
          </p>
        )}
        {box && <div className="marquee" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />}
      </div>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </>
  );
}
