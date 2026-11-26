import { useEffect, useRef, useState } from 'react';
import { Check, FileDown, FileUp, FolderOpen, FolderSearch, Loader2, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import { useEditor } from '../store/editor';
import {
  canPickFolder, currentProject, deleteProject, exportProjectFile, importProjectFile, listProjects, missingMedia, newProject, onProjectChange,
  openProject, projectStatus, relinkFiles, relinkFolder, restoreLast, saveNow, savedFolder, setCurrentName, startAutosave, type ProjectSummary,
} from '../lib/project';
import { allowAccess, autoRelink, initFileAccess } from '../lib/fileAccess';
import { openLicenses } from './LicensesDialog';
import { getLang, t } from '../i18n';

/** When, for the projects list: "ahora", "hace 3 min" or the date. */
function ago(t?: number) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return new Date(t).toLocaleString(getLang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "Guardado ahora / hace 3 min / 26 nov 16:28" (whole phrases, so every language can translate them). */
function savedText(t?: number) {
  if (!t) return 'Guardado';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return 'Guardado ahora';
  if (s < 60) return `Guardado hace ${s} s`;
  if (s < 3600) return `Guardado hace ${Math.round(s / 60)} min`;
  return `Guardado ${new Date(t).toLocaleString(getLang(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

/** Project name, autosave status, projects list and "relink videos" banner. */
export default function ProjectBar() {
  const [, force] = useState(0);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ProjectSummary[]>([]);
  const [name, setName] = useState<string | null>(null);
  const [folder, setFolder] = useState<{ name: string; reopen: () => Promise<number> } | null>(null);
  const [busy, setBusy] = useState(false);
  useEditor((s) => s.media); // re-render when media changes (missing banner)
  const fileRef = useRef<HTMLInputElement>(null);
  const relinkRef = useRef<HTMLInputElement>(null);

  useEffect(() => onProjectChange(() => force((n) => n + 1)), []);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 15000);
    return () => clearInterval(t);
  }, []);
  // Start: reopen the last project (if the editor is empty), then keep saving automatically.
  // If there's already work open, save it right away.
  useEffect(() => {
    (async () => {
      await restoreLast();
      startAutosave();
      if (!currentProject()) await saveNow();
    })();
  }, []);

  const cur = currentProject();
  const st = projectStatus();
  const missing = missingMedia();
  const [needClick, setNeedClick] = useState(0);
  useEffect(() => {
    if (!missing.length) {
      setFolder(null);
      setNeedClick(0);
      return;
    }
    savedFolder().then(setFolder);
    // videos imported before keep their access: bring them back without asking
    autoRelink().then((r) => {
      setNeedClick(r.needClick);
      if (r.found) useEditor.getState().setStatus(r.found === 1 ? 'Vídeo recuperado' : `${r.found} vídeos recuperados`);
    });
  }, [missing.length, cur?.id]);
  useEffect(() => initFileAccess(), []);

  const refresh = () => listProjects().then(setList);
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') useEditor.getState().setStatus(e instanceof Error ? e.message : 'Error');
    } finally {
      setBusy(false);
    }
  };
  const report = (n: number) => {
    const left = missingMedia().length;
    useEditor.getState().setStatus(n ? `${n === 1 ? 'Encontrado 1 vídeo' : `Encontrados ${n} vídeos`}${left ? ` · faltan ${left}` : ''}` : 'No se encontró ninguno de los vídeos en esa carpeta');
  };

  return (
    <>
      <div className="project-bar">
        <input
          className="project-name"
          value={name ?? cur?.name ?? t('Proyecto sin guardar')}
          title="Nombre del proyecto (haz clic para cambiarlo)"
          onFocus={(e) => {
            setName(cur?.name ?? '');
            e.target.select();
          }}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name !== null && name.trim()) void setCurrentName(name);
            setName(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className={`save-state ${st.state}`} title={st.error ?? 'Se guarda solo en este equipo'}>
          {st.state === 'saving' ? <Loader2 size={12} className="spin" /> : st.state === 'error' ? <TriangleAlert size={12} /> : st.state === 'saved' ? <Check size={12} /> : null}
          {st.state === 'saving' ? 'Guardando…' : st.state === 'error' ? 'No se pudo guardar' : st.state === 'saved' ? savedText(st.at) : ''}
        </span>
        <button className="btn small" onClick={() => setOpen(true)} title="Tus proyectos">
          <FolderOpen size={14} /> Proyectos
        </button>
      </div>

      {missing.length > 0 && (
        <div className="missing-banner">
          <TriangleAlert size={15} />
          <span>
            {missing.length === 1 ? 'Falta' : 'Faltan'} <b>{missing.length}</b> vídeo{missing.length > 1 ? 's' : ''} de cámara (no se copian dentro del proyecto para no ocupar GB). Elige la carpeta donde están:
          </span>
          {needClick > 0 && (
            <button className="btn small primary" disabled={busy} onClick={() => run(async () => report(await allowAccess()))} title="El navegador te pedirá permiso para volver a leer tus vídeos">
              <FolderOpen size={13} /> Permitir acceso a tus vídeos
            </button>
          )}
          {folder && !needClick && (
            <button className="btn small primary" disabled={busy} onClick={() => run(async () => report(await folder.reopen()))}>
              <FolderOpen size={13} /> Abrir «{folder.name}»
            </button>
          )}
          {canPickFolder() && (
            <button className={`btn small ${folder ? '' : 'primary'}`} disabled={busy} onClick={() => run(async () => report(await relinkFolder()))}>
              <FolderSearch size={13} /> Elegir carpeta…
            </button>
          )}
          <button className="btn small" disabled={busy} onClick={() => relinkRef.current?.click()}>
            Elegir archivos…
          </button>
          <input
            ref={relinkRef}
            type="file"
            multiple
            hidden
            accept="video/*,audio/*,image/*"
            onChange={(e) => {
              report(relinkFiles(Array.from(e.target.files ?? [])));
              e.target.value = '';
            }}
          />
          <span className="hint">{missing.slice(0, 4).map((m) => m.name).join(', ')}{missing.length > 4 ? '…' : ''}</span>
        </div>
      )}

      {open && (
        <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div className="modal projects">
            <div className="modal-head">
              <b>Proyectos</b>
              <span className="spacer" />
              <button className="icon-btn" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="btn-row">
              <button
                className="btn small primary"
                onClick={() =>
                  run(async () => {
                    await newProject();
                    setOpen(false);
                  })
                }
              >
                <Plus size={14} /> Nuevo proyecto
              </button>
              <button className="btn small" onClick={() => run(exportProjectFile)} disabled={!cur} title="Descarga el proyecto como archivo (sin los vídeos) para guardarlo o llevarlo a otro ordenador">
                <FileDown size={14} /> Guardar como archivo
              </button>
              <button className="btn small" onClick={() => fileRef.current?.click()}>
                <FileUp size={14} /> Abrir archivo
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,.orion"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f)
                    run(async () => {
                      await importProjectFile(f);
                      setOpen(false);
                    });
                }}
              />
            </div>
            <div className="project-list">
              {list.length === 0 && <p className="hint">Todavía no hay proyectos guardados.</p>}
              {list.map((p) => (
                <div key={p.id} className={`project-item ${p.id === cur?.id ? 'current' : ''}`}>
                  <div className="cover">{p.cover ? <img src={p.cover} alt="" /> : null}</div>
                  <div className="info">
                    <b translate="no">{p.name}</b>
                    <span className="hint">
                      {p.clips} clips · {ago(p.updatedAt)}
                      {p.id === cur?.id ? ' · abierto' : ''}
                    </span>
                  </div>
                  {p.id !== cur?.id && (
                    <button
                      className="btn small"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await openProject(p.id);
                          setOpen(false);
                        })
                      }
                    >
                      Abrir
                    </button>
                  )}
                  <button
                    className="icon-btn"
                    title="Borrar proyecto"
                    onClick={() => {
                      if (confirm(`¿Borrar «${p.name}»? No se puede deshacer. (Tus vídeos originales no se borran.)`)) run(async () => {
                        await deleteProject(p.id);
                        await refresh();
                      });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <button className="link" style={{ marginBottom: 8, color: 'var(--muted)' }} onClick={() => { setOpen(false); openLicenses(); }}>
              Licencias y créditos
            </button>
            <p className="hint" style={{ marginBottom: 0 }}>
              Se guarda solo, en este equipo. La música, los efectos, las fotos y los clips pequeños van dentro del proyecto; los vídeos grandes de la cámara se quedan en tu carpeta y Orion los busca al abrir.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
