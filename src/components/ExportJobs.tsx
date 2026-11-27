import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, Download, Loader2, Share2, TriangleAlert, X } from 'lucide-react';
import { cancelExport, dismissExport, useExports } from '../lib/exportQueue';
import { shareFile } from '../lib/platform';
import { openAbout } from './AboutDialog';
import { NUDGE_AT, markDonated, useSupport } from '../lib/support';

/** Background exports: a small card at the bottom right, so you can keep editing. */
export default function ExportJobs() {
  const tasks = useExports((s) => s.tasks);
  const [small, setSmall] = useState(false);
  const donated = useSupport((s) => s.donated);
  if (!tasks.length) return null;
  const active = tasks.filter((t) => t.state === 'running' || t.state === 'queued' || t.state === 'saving').length;
  return (
    <div className="export-jobs">
      <div className="ej-head" onClick={() => setSmall(!small)}>
        <b>{active ? `Exportando ${active > 1 ? `(${active})` : ''}` : 'Exportaciones'}</b>
        <span className="spacer" />
        {small ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </div>
      {!small &&
        tasks.map((t) => (
          <div key={t.id} className={`ej-row ${t.state}`}>
            <div className="ej-title">
              {t.state === 'done' ? (
                <CheckCircle2 size={14} className="ok" />
              ) : t.state === 'error' ? (
                <TriangleAlert size={14} className="bad" />
              ) : t.state === 'cancelled' ? (
                <X size={14} />
              ) : (
                <Loader2 size={14} className="spin" />
              )}
              <span className="name" title={`${t.name}.mp4`}>
                {t.name}.mp4
              </span>
              <span className="hint">
                {t.opts.height}p · {t.opts.fps} fps
              </span>
              {t.state === 'running' || t.state === 'queued' ? (
                <button className="icon-btn sm" title="Cancelar" onClick={() => cancelExport(t.id)}>
                  <X size={13} />
                </button>
              ) : t.state !== 'saving' ? (
                <button className="icon-btn sm" title="Quitar de la lista" onClick={() => dismissExport(t.id)}>
                  <X size={13} />
                </button>
              ) : null}
            </div>
            {(t.state === 'running' || t.state === 'saving' || t.state === 'queued') && (
              <>
                <div className="progress">
                  <div style={{ width: `${Math.round(t.progress * 100)}%` }} />
                </div>
                <div className="hint">{t.label}</div>
              </>
            )}
            {t.state === 'done' && t.result && (
              <div className="ej-done">
                <span className="hint">
                  {(t.result.size / 1024 / 1024).toFixed(1)} MB · {Math.round(t.result.secs)} s · en {t.result.where}
                </span>
                {t.result.uri ? (
                  <button className="btn small primary" onClick={() => shareFile(t.result!.uri!, t.name).catch(() => {})}>
                    <Share2 size={13} /> Compartir
                  </button>
                ) : (
                  <a className="btn small" href={t.result.url} download={`${t.name}.mp4`}>
                    <Download size={13} /> Descargar otra vez
                  </a>
                )}
              </div>
            )}
            {t.state === 'error' && <div className="hint" style={{ color: 'var(--danger)' }}>{t.error}</div>}
            {t.state === 'done' && t.nudge && !donated && (
              <div className="coffee-nudge">
                <span>{`☕ ¡Ya llevas ${NUDGE_AT} vídeos hechos con Leo! Si te está sirviendo, puedes invitarme a un café. Solo te lo digo esta vez.`}</span>
                <div className="coffee-nudge-actions">
                  <button className="btn small coffee-yes" onClick={() => openAbout()}>
                    Invitar a un café
                  </button>
                  <button className="link coffee-done" onClick={markDonated}>
                    Ya he invitado
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
