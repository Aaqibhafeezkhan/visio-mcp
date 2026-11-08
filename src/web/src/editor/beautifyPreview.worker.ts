import { buildBeautifyPreview, type BeautifyPreview } from './beautifyPreview';
import type { DiagramDocument } from '../contracts/generated';

interface PreviewRequest { document: DiagramDocument; pageId: string; targetIds?: string[] }
type PreviewResponse = { preview: BeautifyPreview } | { error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PreviewRequest>) => void) | null;
  postMessage: (message: PreviewResponse) => void;
};

scope.onmessage = async ({ data }) => {
  try {
    const preview = await buildBeautifyPreview(data.document, data.pageId, data.targetIds);
    scope.postMessage({ preview });
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
