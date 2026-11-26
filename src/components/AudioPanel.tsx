import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Download, Loader2, Pause, Play, Plus, Search } from 'lucide-react';
import { useEditor } from '../store/editor';
import { formatTime } from '../lib/util';
import { LIBRARY_DRAG_TYPE, addFromLibrary, importAudio, projectCredits, searchAudio, type AudioResult } from '../lib/library';

const MUSIC_TAGS: [string, string][] = [
  ['Épica', 'epic'],
  ['Motivación', 'motivational'],
  ['Hip hop', 'hip hop'],
  ['Electrónica', 'electronic'],
  ['Trap', 'trap'],
  ['Rock', 'rock'],
  ['Latina', 'latin'],
  ['Tranquila', 'chill'],
  ['Tensión', 'suspense'],
  ['Fiesta', 'dance'],
];

const SFX_TAGS: [string, string][] = [
  ['Silbato', 'referee whistle'],
  ['Afición', 'stadium crowd'],
  ['Gol', 'goal cheer'],
  ['Aplausos', 'applause'],
  ['Whoosh', 'whoosh'],
  ['Balón', 'ball kick'],
  ['Impacto', 'impact'],
  ['Redoble', 'drum roll'],
  ['Bocina', 'air horn'],
  ['Risas', 'laugh'],
  ['Fallo', 'fail'],
  ['Ding', 'ding'],
  ['Cámara', 'camera shutter'],
  ['Disco rayado', 'record scratch'],
];

type Kind = 'music' | 'sfx';
// remembered while the app is open, so switching tabs doesn't search again
const memory: Record<Kind, { tag: string; query: string }> = {
  music: { tag: 'epic', query: '' },
  sfx: { tag: 'referee whistle', query: '' },
};
let lastKind: Kind = 'music';

export default function AudioPanel() {
  const [kind, setKind] = useState<Kind>(lastKind);
  const [query, setQuery] = useState(memory[lastKind].query);
  const [tag, setTag] = useState(memory[lastKind].tag);
  const [results, setResults] = useState<AudioResult[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [copied, setCopied] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEditor((s) => s.media); // re-render credits when media changes
  useEditor((s) => s.clips);
  const credits = projectCredits();
  const term = query.trim() || tag;

  useEffect(() => {
    lastKind = kind;
    memory[kind] = { tag, query };
  }, [kind, tag, query]);

  // search (debounced while typing)
  useEffect(() => {
    if (!term) return;
    let cancelled = false;
    const t = setTimeout(
      async () => {
        setLoading(true);
        setError(null);
        try {
          const r = await searchAudio(term, kind, 1);
          if (cancelled) return;
          setResults(r.results);
          setPages(r.pages);
          setPage(1);
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Error de búsqueda');
        } finally {
          if (!cancelled) setLoading(false);
        }
      },
      query.trim() ? 450 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [term, kind, query]);

  useEffect(() => () => audioRef.current?.pause(), []);

  const loadMore = async () => {
    setLoading(true);
    try {
      const r = await searchAudio(term, kind, page + 1);
      setResults((prev) => [...prev, ...r.results.filter((x) => !prev.some((p) => p.id === x.id))]);
      setPage(page + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de búsqueda');
    } finally {
      setLoading(false);
    }
  };

  const togglePlay = (item: AudioResult) => {
    audioRef.current ??= new Audio();
    const a = audioRef.current;
    if (playingId === item.id) {
      a.pause();
      setPlayingId(null);
      return;
    }
    a.src = item.url;
    a.onended = () => setPlayingId(null);
    a.play().catch(() => setPlayingId(null));
    setPlayingId(item.id);
  };

  const run = async (item: AudioResult, addToTimeline: boolean) => {
    if (item.id in busy) return;
    setBusy((b) => ({ ...b, [item.id]: 0 }));
    try {
      if (addToTimeline) await addFromLibrary({ kind: 'audio', item });
      else {
        await importAudio(item, (p) => setBusy((b) => ({ ...b, [item.id]: p })));
        useEditor.getState().setStatus(`«${item.title}» añadido a Multimedia`);
      }
    } catch (e) {
      useEditor.getState().setStatus(e instanceof Error ? e.message : 'No se pudo descargar');
    } finally {
      setBusy(({ [item.id]: _, ...rest }) => rest);
    }
  };

  const switchKind = (k: Kind) => {
    setKind(k);
    setTag(memory[k].tag);
    setQuery(memory[k].query);
    setResults([]);
  };

  const tags = kind === 'music' ? MUSIC_TAGS : SFX_TAGS;

  return (
    <>
      <div className="panel-title">Audio</div>
      <div className="panel-body lib-panel">
        <div className="segmented">
          <button className={kind === 'music' ? 'active' : ''} onClick={() => switchKind('music')}>
            Música
          </button>
          <button className={kind === 'sfx' ? 'active' : ''} onClick={() => switchKind('sfx')}>
            Efectos de sonido
          </button>
        </div>
        <div className="search-box">
          <Search size={14} />
          <input className="input" placeholder={kind === 'music' ? 'Buscar música (en inglés va mejor)…' : 'Buscar efectos (whistle, crowd…)'} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="chips" style={{ marginBottom: 10 }}>
          {tags.map(([label, q]) => (
            <button
              key={q}
              className={`chip ${!query.trim() && tag === q ? 'active' : ''}`}
              onClick={() => {
                setQuery('');
                setTag(q);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
        <div className="lib-list">
          {results.map((item) => {
            const p = busy[item.id];
            return (
              <div
                key={item.id}
                className="lib-row"
                draggable
                title="Arrástralo a la línea de tiempo"
                onDragStart={(e) => {
                  e.dataTransfer.setData(LIBRARY_DRAG_TYPE, JSON.stringify({ kind: 'audio', item }));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <button className={`lib-play ${playingId === item.id ? 'on' : ''}`} title="Escuchar" onClick={() => togglePlay(item)}>
                  {playingId === item.id ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
                </button>
                <div className="lib-info">
                  <div className="lib-title">{item.title}</div>
                  <div className="lib-sub">
                    <span className={`lic ${item.license}`} title={item.license === 'cc0' ? 'Dominio público: úsalo sin más' : 'Gratis, pero menciona al autor en la descripción'}>
                      {item.license === 'cc0' ? 'Libre' : 'Atribución'}
                    </span>{' '}
                    {item.creator}
                  </div>
                </div>
                <span className="lib-dur">{formatTime(item.duration)}</span>
                <button className="lib-btn" title="Descargar a Multimedia" disabled={p !== undefined} onClick={() => run(item, false)}>
                  <Download size={14} />
                </button>
                <button className="lib-btn add" title="Añadir en el cursor de la línea de tiempo" disabled={p !== undefined} onClick={() => run(item, true)}>
                  {p !== undefined ? <Loader2 size={14} className="spin" /> : <Plus size={15} />}
                </button>
              </div>
            );
          })}
        </div>
        {loading && (
          <p className="hint" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Loader2 size={14} className="spin" /> Buscando…
          </p>
        )}
        {!loading && !error && results.length === 0 && term && <p className="hint">No hay resultados. Prueba otra palabra (en inglés suele encontrar más).</p>}
        {!loading && page < pages && results.length > 0 && (
          <button className="btn small block" onClick={loadMore} style={{ marginTop: 8 }}>
            Cargar más
          </button>
        )}

        <div className="credits-box">
          <p className="hint" style={{ margin: 0 }}>
            Todo es gratis y apto para vídeos monetizados. <b>Libre</b>: úsalo sin más. <b>Atribución</b>: menciona al autor en la descripción del vídeo.
          </p>
          {credits.length > 0 && (
            <button
              className="btn small block"
              style={{ marginTop: 8 }}
              onClick={async () => {
                await navigator.clipboard.writeText(credits.join('\n'));
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copiado' : `Copiar créditos para la descripción (${credits.length})`}
            </button>
          )}
          <p className="hint" style={{ margin: '8px 0 0', fontSize: 10.5 }}>
            Música de Jamendo y efectos de Freesound, buscados con Openverse.
          </p>
        </div>
      </div>
    </>
  );
}
