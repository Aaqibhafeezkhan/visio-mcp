import type { Projection, Snapshot } from '../contracts/generated';
import type { ProjectionIsolation, SnapshotProjector } from '../commands/CommandEngine';
import { fail, ok } from '../model/result';
import { MaxGraphAdapter } from './MaxGraphAdapter';

/**
 * Derives connector routes (and later group frames) from an immutable canonical snapshot, in an isolated hidden model.
 * It never reads live drag or text-edit preview cells, so a render or export taken mid-gesture shows committed geometry.
 * I31's offscreen renderer reuses the same mapping (cellMapping.ts and the projection in MaxGraphAdapter).
 */
export function createSnapshotProjector(assetUrl: (snapshot: Snapshot, assetId: string) => string): { project: SnapshotProjector; isolate: ProjectionIsolation; dispose(): void } {
  let host: HTMLDivElement | null = null;
  let adapter: MaxGraphAdapter | null = null;
  let current: Snapshot | null = null;

  const ensure = () => {
    if (adapter) return adapter;
    host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-20000px;top:0;width:1600px;height:1200px;visibility:hidden;pointer-events:none;';
    document.body.appendChild(host);
    adapter = new MaxGraphAdapter(host, { onIntent() {}, onSelection() {}, onGesture() {}, onViewport() {}, onPlace() {} }, id => (current ? assetUrl(current, id) : ''));
    return adapter;
  };

  return {
    project(snapshot) {
      try {
        const a = ensure();
        current = snapshot;
        // routes are derived page by page: a connector on the second page needs its own pass
        let merged: Projection | null = null;
        for (const page of snapshot.document.pages) {
          a.project(snapshot, page.id);
          const one = a.readProjection(snapshot, page.id) as Projection;
          merged = merged ? ({ ...(merged as object), connectors: { ...(merged.connectors as object), ...(one.connectors as object) } } as Projection) : one;
        }
        return ok(merged!);
      } catch (e) {
        return fail('projection_failed', e instanceof Error ? e.message : String(e));
      }
    },
    // A route proposal projects documents that are never committed; its route memory must not decide how the committed one is drawn next.
    isolate(run) {
      const a = ensure();
      const saved = a.saveRouteMemory();
      try { return run(); } finally { a.restoreRouteMemory(saved); }
    },
    dispose() { adapter?.dispose(); host?.remove(); adapter = null; host = null; },
  };
}
