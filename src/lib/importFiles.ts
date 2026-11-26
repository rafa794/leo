import { useEditor } from '../store/editor';
import { importFile, loadMoreThumbnails, loadWaveform } from './media';

/**
 * Imports files into the media bin (sorted by name, which for camera clips is the recording order).
 * Optionally adds all of them to the timeline, one after another, when ready.
 */
export async function importFiles(files: File[], addTo?: { trackId?: string; start?: number }) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const ids: string[] = [];
  for (const [i, file] of sorted.entries()) {
    useEditor.getState().setStatus(`Importando ${sorted.length > 1 ? `${i + 1}/${sorted.length} ` : ''}${file.name}…`);
    try {
      const item = await importFile(file);
      useEditor.getState().addMedia(item);
      ids.push(item.id);
      loadWaveform(item).then((waveform) => waveform && useEditor.getState().updateMedia(item.id, { waveform }));
      loadMoreThumbnails(item).then((thumbnails) => thumbnails && useEditor.getState().updateMedia(item.id, { thumbnails }));
    } catch (e) {
      useEditor.getState().setStatus(e instanceof Error ? e.message : 'Error al importar');
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  if (addTo && ids.length) useEditor.getState().addMediaClips(ids, addTo);
  useEditor.getState().setStatus(ids.length > 1 ? `${ids.length} archivos importados` : null);
  return ids;
}
