import type { DiagramDocument } from '../contracts/generated';
import type { BeautifyPreview } from './beautifyPreview';

/** Run the synchronous route search off the editor thread. */
export function buildBeautifyPreviewOffThread(document: DiagramDocument, pageId: string, targetIds?: readonly string[], signal?: AbortSignal): Promise<BeautifyPreview> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./beautifyPreview.worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => { worker.terminate(); cleanup(); const error = new Error('Beautify preview was cancelled'); error.name = 'AbortError'; reject(error); };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ preview?: BeautifyPreview; error?: string }>) => {
      worker.terminate();
      cleanup();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.preview) resolve(event.data.preview);
      else reject(new Error('Beautify preview worker returned no result'));
    };
    worker.onerror = event => {
      worker.terminate();
      cleanup();
      reject(new Error(event.message || 'Beautify preview worker failed'));
    };
    worker.postMessage({ document, pageId, ...(targetIds ? { targetIds: [...targetIds] } : {}) });
  });
}
