import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Search, X } from 'lucide-react';

interface Lib {
  name: string;
  version?: string;
  license: string;
  author?: string;
  url?: string;
  note?: string;
  text?: string;
}
interface Data {
  generated: string;
  app: { name: string; version: string };
  libraries: Lib[];
  resources: Lib[];
}

let openFn: (() => void) | null = null;
/** Opens "Licencias y créditos" (also from the Mac app's Help menu). */
export function openLicenses() {
  openFn?.();
}
(window as unknown as { __orionShowLicenses?: () => void }).__orionShowLicenses = () => openLicenses();

/** Licenses of every library, model, font and sticker set Leo uses (generated at build time). */
export default function LicensesDialog() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    openFn = () => setOpen(true);
    return () => {
      openFn = null;
    };
  }, []);
  useEffect(() => {
    if (!open || data) return;
    fetch(`${import.meta.env.BASE_URL}licenses.json`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setError(true));
  }, [open, data]);
  const filter = (l: Lib) => !q.trim() || `${l.name} ${l.license} ${l.author ?? ''}`.toLowerCase().includes(q.trim().toLowerCase());
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    data?.libraries.forEach((l) => (c[l.license] = (c[l.license] ?? 0) + 1));
    return Object.entries(c).sort((a, b) => b[1] - a[1]);
  }, [data]);
  if (!open) return null;

  const row = (l: Lib, kind: string) => {
    const key = `${kind}:${l.name}`;
    const isOpen = expanded === key;
    return (
      <div key={key} className="lic-row">
        <button className="lic-head" onClick={() => setExpanded(isOpen ? null : key)}>
          {l.text ? isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span style={{ width: 14 }} />}
          <span className="lic-name">
            {l.name}
            {l.version && <span className="hint"> {l.version}</span>}
          </span>
          <span className="lic-badge">{l.license}</span>
        </button>
        {(l.author || l.note || l.url) && (
          <div className="lic-meta hint">
            {l.author && <span>{l.author}</span>}
            {l.note && <span>{l.note}</span>}
            {l.url && (
              <a href={l.url} target="_blank" rel="noreferrer">
                <ExternalLink size={11} /> {l.url.replace(/^https?:\/\//, '')}
              </a>
            )}
          </div>
        )}
        {isOpen && l.text && <pre className="lic-text">{l.text}</pre>}
      </div>
    );
  };

  return (
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal licenses">
        <div className="modal-head">
          <b>Licencias y créditos</b>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setOpen(false)}>
            <X size={16} />
          </button>
        </div>
        {error && <p className="hint">No se pudo cargar la lista de licencias.</p>}
        {data && (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              {data.app.name} {data.app.version} está hecho con software libre y gratuito. Gracias a sus autores. Pulsa cualquier librería para ver el texto completo de su licencia.
            </p>
            <div className="chips" style={{ marginBottom: 10 }}>
              {counts.map(([lic, n]) => (
                <span key={lic} className="chip" style={{ cursor: 'default' }}>
                  {lic} · {n}
                </span>
              ))}
            </div>
            <div className="search-box" style={{ marginBottom: 10 }}>
              <Search size={14} />
              <input className="input" placeholder="Buscar librería o licencia…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="lic-section">Modelos de IA, fuentes, stickers y contenido</div>
            {data.resources.filter(filter).map((l) => row(l, 'r'))}
            <div className="lic-section">Librerías ({data.libraries.length})</div>
            {data.libraries.filter(filter).map((l) => row(l, 'l'))}
            <p className="hint">La app de Mac incluye además Chromium (dentro de Electron); sus licencias completas están en el menú Ayuda → «Licencias de Chromium».</p>
          </>
        )}
      </div>
    </div>
  );
}
