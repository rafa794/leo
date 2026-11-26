import { STICKERS, STICKER_CATEGORIES, stickerUrl } from '../lib/stickers';
import { LIBRARY_DRAG_TYPE, addFromLibrary } from '../lib/library';

export default function StickersPanel() {
  return (
    <>
      <div className="panel-title">Stickers</div>
      <div className="panel-body">
        <p className="hint" style={{ marginTop: 0 }}>
          Haz clic para ponerlo en el cursor, o arrástralo a la línea de tiempo. Muévelo y cambia su tamaño desde las esquinas en el visor.
        </p>
        {STICKER_CATEGORIES.map((cat) => (
          <div key={cat.id} style={{ marginBottom: 14 }}>
            <div className="lib-cat">{cat.label}</div>
            <div className="sticker-grid">
              {STICKERS.filter((s) => s.cat === cat.id).map((s) => (
                <button
                  key={s.file}
                  className="sticker"
                  title={s.name}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(LIBRARY_DRAG_TYPE, JSON.stringify({ kind: 'sticker', sticker: s }));
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => addFromLibrary({ kind: 'sticker', sticker: s })}
                >
                  <img src={stickerUrl(s)} alt={s.name} draggable={false} loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        ))}
        <p className="hint">Stickers Fluent Emoji de Microsoft (licencia MIT): gratis para cualquier uso, también en vídeos monetizados.</p>
      </div>
    </>
  );
}
