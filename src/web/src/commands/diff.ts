import type { Asset, DiagramDocument, DiffDeletes, DiffUpserts, Element, Layer, Page, ResolvedDiff } from '../contracts/generated';

export type DiffBody = Pick<ResolvedDiff, 'upserts' | 'deletes'>;

export const emptyDiffBody = (): DiffBody => ({
  upserts: { elements: [], pages: [], layers: [], assets: [] } satisfies DiffUpserts,
  deletes: { elementIds: [], pageIds: [], layerIds: [], assetIds: [] } satisfies DiffDeletes,
});

export const isEmptyDiff = (d: DiffBody): boolean =>
  d.upserts.elements.length + d.upserts.pages.length + d.upserts.layers.length + d.upserts.assets.length +
  d.deletes.elementIds.length + d.deletes.pageIds.length + d.deletes.layerIds.length + d.deletes.assetIds.length === 0;

function insertAt<T>(arr: readonly T[], index: number | undefined, item: T): T[] {
  const copy = arr.slice();
  copy.splice(index === undefined ? copy.length : Math.min(index, copy.length), 0, item);
  return copy;
}

/**
 * The one way committed state changes: deletes first, then upserts. A diff produced by the planner, its inverse
 * (undo) and the forward diff again (redo) all go through here, so replay is exact. Unchanged subtrees keep identity.
 */
export function applyDiff(doc: DiagramDocument, diff: DiffBody, revision: number): DiagramDocument {
  let pages: Page[] = doc.pages.slice();

  // Deletes.
  if (diff.deletes.pageIds.length) pages = pages.filter(p => !diff.deletes.pageIds.includes(p.id));
  if (diff.deletes.elementIds.length || diff.deletes.layerIds.length) {
    const delEl = new Set(diff.deletes.elementIds);
    const delLayer = new Set(diff.deletes.layerIds);
    pages = pages.map(p => {
      const elements = delEl.size ? p.elements.filter(e => !delEl.has(e.id)) : p.elements;
      const layers = delLayer.size ? p.layers.filter(l => !delLayer.has(l.id)) : p.layers;
      return elements === p.elements && layers === p.layers ? p : { ...p, elements: elements === p.elements ? p.elements : elements, layers };
    });
  }
  let assets: readonly Asset[] = doc.assets;
  if (diff.deletes.assetIds.length) assets = assets.filter(a => !diff.deletes.assetIds.includes(a.id));

  // Upserts.
  for (const pu of diff.upserts.pages) {
    const at = pages.findIndex(p => p.id === pu.page.id);
    if (at >= 0) {
      const merged = { ...pages[at]!, ...pu.page };
      if (pu.index === undefined || pu.index === at) pages[at] = merged;
      else { // an index on an existing page moves it
        const copy = pages.slice();
        copy.splice(at, 1);
        copy.splice(Math.min(pu.index, copy.length), 0, merged);
        pages = copy;
      }
    } else {
      const page: Page = { ...pu.page, layers: [], elements: [] };
      const copy = pages.slice();
      copy.splice(pu.index === undefined ? copy.length : Math.min(pu.index, copy.length), 0, page);
      pages = copy;
    }
  }
  for (const lu of diff.upserts.layers) {
    pages = pages.map(p => {
      if (p.id !== lu.pageId) return p;
      const at = p.layers.findIndex(l => l.id === lu.layer.id);
      const layers: Layer[] = at >= 0 ? p.layers.map((l, i) => (i === at ? lu.layer : l)) : insertAt(p.layers, lu.index, lu.layer);
      return { ...p, layers };
    });
  }
  for (const eu of diff.upserts.elements) {
    pages = pages.map(p => {
      if (p.id !== eu.pageId) return p;
      const at = p.elements.findIndex(e => e.id === eu.element.id);
      const elements: Element[] = at >= 0 ? p.elements.map((e, i) => (i === at ? eu.element : e)) : insertAt(p.elements, eu.index, eu.element);
      return { ...p, elements };
    });
  }
  if (diff.upserts.assets.length) {
    const next = assets.slice() as Asset[];
    for (const a of diff.upserts.assets) {
      const at = next.findIndex(x => x.id === a.id);
      if (at >= 0) next[at] = a; else next.push(a);
    }
    assets = next;
  }

  const next = { ...doc, revision, pages, assets: assets as Asset[] };
  if (Object.prototype.hasOwnProperty.call(diff.upserts, 'routingDefaults')) {
    if (diff.upserts.routingDefaults === null) delete next.routingDefaults;
    else next.routingDefaults = diff.upserts.routingDefaults;
  }
  return next;
}
