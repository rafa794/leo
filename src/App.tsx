import { useEffect } from 'react';
import TopBar from './components/TopBar';
import LeftPanel from './components/LeftPanel';
import Preview from './components/Preview';
import Inspector from './components/Inspector';
import Timeline from './components/Timeline';
import ExportDialog from './components/ExportDialog';
import Toast from './components/Toast';
import ProjectBar from './components/ProjectBar';
import PasteAttributes from './components/PasteAttributes';
import ExportJobs from './components/ExportJobs';
import LicensesDialog from './components/LicensesDialog';
import AboutDialog from './components/AboutDialog';
import SuggestionsDialog from './components/SuggestionsDialog';
import { initAutoFormat } from './lib/autoFormat';
import { useShortcuts } from './lib/shortcuts';
import { importFiles } from './lib/importFiles';
import { useEditor } from './store/editor';
import { LEFT_MIN, PANEL_MAX, RAIL_W, RIGHT_MIN, useCompact, useLayout } from './store/layout';
import { flushSave, hasPendingSave } from './lib/project';
import MobileApp from './mobile/MobileApp';

export default function App() {
  const exportRequest = useEditor((s) => s.exportRequest);
  const requestExport = useEditor((s) => s.requestExport);
  const layout = useLayout();
  const compact = useCompact();
  useShortcuts();
  useEffect(() => initAutoFormat(), []);

  // Projects save themselves; only warn if a save is still pending when closing
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (hasPendingSave()) {
        flushSave();
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // It's an app, not a web page: no browser right-click menu (except in text fields)
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.('input, textarea')) e.preventDefault();
    };
    window.addEventListener('contextmenu', h);
    return () => window.removeEventListener('contextmenu', h);
  }, []);

  // Dropping files anywhere imports them
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length || e.defaultPrevented) return;
      e.preventDefault();
      importFiles(Array.from(e.dataTransfer.files));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  const drag = (e: React.PointerEvent, onMove: (dx: number, dy: number) => void, cursor: string) => {
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    document.body.style.cursor = cursor;
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev.clientY - y0);
    const up = () => {
      document.body.style.cursor = '';
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const resizeTimeline = (e: React.PointerEvent) => {
    const h0 = layout.timelineH;
    drag(e, (_dx, dy) => layout.set({ timelineH: Math.min(window.innerHeight - 200, Math.max(150, h0 - dy)) }), 'row-resize');
  };
  // Drag a panel edge to resize it; drag it almost closed and it hides (like in CapCut / VS Code)
  const resizeLeft = (e: React.PointerEvent) => {
    const w0 = layout.leftOpen ? layout.leftW : 0;
    drag(e, (dx) => {
      const w = w0 + dx;
      if (w < LEFT_MIN * 0.6) layout.set({ leftOpen: false });
      else layout.set({ leftOpen: true, leftW: Math.min(PANEL_MAX, Math.max(LEFT_MIN, w)) });
    }, 'col-resize');
  };
  const resizeRight = (e: React.PointerEvent) => {
    const w0 = layout.rightOpen ? layout.rightW : 0;
    drag(e, (dx) => {
      const w = w0 - dx;
      if (w < RIGHT_MIN * 0.6) layout.set({ rightOpen: false });
      else layout.set({ rightOpen: true, rightW: Math.min(PANEL_MAX, Math.max(RIGHT_MIN, w)) });
    }, 'col-resize');
  };

  const cols = `${RAIL_W + (layout.leftOpen ? layout.leftW : 0)}px 5px minmax(0, 1fr) 5px ${layout.rightOpen ? layout.rightW : 0}px`;

  // phones / narrow windows: the mobile editor
  if (compact)
    return (
      <MobileApp
        dialogs={
          <>
            {exportRequest && <ExportDialog clipId={exportRequest.clipId} clipIds={exportRequest.clipIds} onClose={() => requestExport(null)} />}
            <PasteAttributes />
            <ExportJobs />
            <LicensesDialog />
            <AboutDialog />
            <SuggestionsDialog />
            <Toast />
          </>
        }
      />
    );

  return (
    <div className="app" style={{ ['--timeline-h' as string]: `${layout.timelineH}px` }}>
      <TopBar onExport={() => requestExport({})} />
      <ProjectBar />
      <div className="workspace" style={{ gridTemplateColumns: cols }}>
        <LeftPanel />
        <div className="vsplit" title="Arrastra para cambiar el tamaño (doble clic: ocultar / mostrar)" onPointerDown={resizeLeft} onDoubleClick={() => layout.set({ leftOpen: !layout.leftOpen })} />
        <Preview />
        <div className="vsplit" title="Arrastra para cambiar el tamaño (doble clic: ocultar / mostrar)" onPointerDown={resizeRight} onDoubleClick={() => layout.set({ rightOpen: !layout.rightOpen })} />
        {layout.rightOpen ? <Inspector /> : <div />}
      </div>
      <div className="splitter" title="Arrastra para cambiar la altura de la línea de tiempo" onPointerDown={resizeTimeline} />
      <Timeline />
      {exportRequest && <ExportDialog clipId={exportRequest.clipId} clipIds={exportRequest.clipIds} onClose={() => requestExport(null)} />}
      <PasteAttributes />
      <ExportJobs />
      <LicensesDialog />
      <AboutDialog />
      <SuggestionsDialog />
      <Toast />
    </div>
  );
}
