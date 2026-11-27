import { useEffect, useState } from 'react';
import { Coffee, Globe, Plus, Trash2 } from 'lucide-react';
import { deleteProject, listProjects, onProjectChange, type ProjectSummary } from '../lib/project';
import { openAbout } from '../components/AboutDialog';
import { openLanguagePicker } from '../components/LanguagePicker';
import { getLang } from '../i18n';

/** Phone start screen: a big "new project" button and your projects, like mobile editors. */
export default function MobileHome({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  useEffect(() => {
    const load = () => listProjects().then((l) => setList(l.filter((p) => p.clips > 0)));
    load();
    return onProjectChange(load);
  }, []);
  const when = (t: number) => new Date(t).toLocaleDateString(getLang(), { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="m-home">
      <header className="m-home-top">
        <div className="logo">
          <div className="logo-dot">◆</div> Leo
        </div>
        <span className="spacer" />
        <button className="icon-btn" title="Idioma · Language" onClick={() => openLanguagePicker()}>
          <Globe size={20} />
        </button>
        <button className="icon-btn m-coffee" title="Invítame a un café" onClick={() => openAbout()}>
          <Coffee size={20} />
        </button>
      </header>
      <button className="m-new" onClick={onNew}>
        <span className="m-new-icon">
          <Plus size={26} />
        </span>
        <b>Nuevo proyecto</b>
        <span className="hint">Elige tus vídeos o fotos y empieza a editar</span>
      </button>
      <h3 className="m-home-h">Proyectos</h3>
      {list && !list.length && <p className="hint m-home-empty">Aquí aparecerán tus proyectos. Se guardan solos mientras editas.</p>}
      <div className="m-projects">
        {list?.map((p) => (
          <div key={p.id} className="m-project" onClick={() => onOpen(p.id)}>
            <div className="cover">{p.cover ? <img src={p.cover} alt="" /> : null}</div>
            <div className="info">
              <b translate="no">{p.name}</b>
              <span className="hint">
                {when(p.updatedAt)} · {p.clips} clips
              </span>
            </div>
            <button
              className="icon-btn"
              title="Borrar proyecto"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`¿Borrar «${p.name}»? No se puede deshacer. (Tus vídeos originales no se borran.)`)) void deleteProject(p.id).then(() => setList((l) => l?.filter((x) => x.id !== p.id) ?? null));
              }}
            >
              <Trash2 size={17} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
