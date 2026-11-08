import { describe, expect, it, vi } from 'vitest';
import { buildBeautifyPreviewOffThread } from '../src/editor/beautifyPreviewWorker';
import { newDocument } from '../src/model/newDocument';

describe('Beautify preview worker lifecycle', () => {
  it('terminates an active worker when the dialog is cancelled', async () => {
    class FakeWorker {
      static latest: FakeWorker;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      terminated = false;
      constructor() { FakeWorker.latest = this; }
      postMessage() {}
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeWorker);
    try {
      const controller = new AbortController();
      const document = newDocument();
      const request = buildBeautifyPreviewOffThread(document, document.pages[0]!.id, undefined, controller.signal);
      controller.abort();
      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(FakeWorker.latest.terminated).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
