import { initializePreferences } from './bridge/initializePreferences';
import { startAgentApp } from './bridge/agentApp';
import { createSnapshotProjector } from './canvas/SnapshotProjector';
import { createSnapshotRenderer } from './render/SnapshotRenderer';
import { createBrowserLayoutContext } from './layout/browserContext';

// The agent-only view: same engine and renderer as the editor, no interface. Nothing is drawn on screen; renders and exports are made from snapshots.
const assetUrl = (snapshot: { document: { assets: Array<{ id: string; sha256: string }> } }, id: string) => {
  const a = snapshot.document.assets.find(x => x.id === id);
  return a ? `/assets/${a.sha256}` : '';
};
const renderer = createSnapshotRenderer({ assetUrl: assetUrl as never });
const initialPreferences = await initializePreferences(window.chrome?.webview);
const app = startAgentApp(window.chrome?.webview, {
  ...initialPreferences,
  render: renderer.render, rasterise: renderer.rasterise, layoutContext: createBrowserLayoutContext(assetUrl as never),
  configureEngine: engine => {
    const projector = createSnapshotProjector((snapshot, id) => assetUrl(snapshot as never, id));
    engine.setSnapshotProjector(projector.project, projector.isolate);
  },
});
(window as unknown as { __agent?: unknown }).__agent = import.meta.env.VITE_TEST_API === '1' ? app : undefined;
document.title = 'Diagram (background)';
