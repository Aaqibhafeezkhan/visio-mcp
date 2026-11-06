import type { ConnectorElement, Element, Endpoint, Operation, Page, Snapshot } from '../contracts/generated';
import { compareElementOrder } from '../model/elementOrder';
import { isContainer } from '../layout/containers';
import { leavesUnder } from './groups';

export interface ClipboardData { pageId: string; elements: Element[] }

/**
 * Copies the selected elements. Connectors travel only if both ends are in the selection; others would point outside the copy. A container
 * travels with everything inside it (R17); groups are not copied, so a group inside a container is listed by its leaves instead.
 */
export function copyElements(snapshot: Snapshot, ids: string[]): ClipboardData | null {
  const page = snapshot.document.pages.find(p => ids.some(id => p.elements.some(e => e.id === id)));
  if (!page) return null;
  const byId = new Map(page.elements.map(e => [e.id, e] as const));
  const wanted = new Set(ids);
  const carry = (id: string) => {
    for (const leaf of leavesUnder(byId, id)) {
      if (wanted.has(leaf) && leaf !== id) continue;
      wanted.add(leaf);
      const el = byId.get(leaf);
      if (isContainer(el)) for (const m of el.container.memberIds) carry(m);
    }
  };
  for (const id of ids) if (isContainer(byId.get(id))) carry(id);
  const elements = page.elements.filter(e => wanted.has(e.id) && e.kind !== 'group').filter(e =>
    e.kind !== 'connector' || [e.from, e.to].every(ep => ep.glue === 'none' || (ep.elementId && wanted.has(ep.elementId))))
    .sort(compareElementOrder);
  const copied = new Set(elements.map(e => e.id));
  const clones = (structuredClone(elements) as Element[]).map(e => isContainer(e)
    ? { ...e, container: { ...e.container, memberIds: e.container.memberIds.flatMap(m => leavesUnder(byId, m)).filter(m => copied.has(m)) } }
    : e);
  return clones.length ? { pageId: page.id, elements: clones } : null;
}

function uniqueAlias(alias: string, taken: Set<string>): string {
  if (!taken.has(alias)) return alias;
  let n = 2;
  while (taken.has(`${alias}-${n}`)) n++;
  return `${alias}-${n}`;
}

/**
 * Builds create operations for a paste. Every element gets a fresh UUID (supplied by `newId`), aliases are made unique
 * on the target page, and connectors between copied elements are re-attached to the copies.
 */
export function pasteOperations(clip: ClipboardData, target: Page, offsetPt: number, newId: () => string): { operations: Operation[]; newIds: string[] } {
  const idMap = new Map<string, string>();
  for (const e of clip.elements) idMap.set(e.id, newId());
  const taken = new Set(target.elements.map(e => e.alias).filter((a): a is string => !!a));
  const layerOk = (ids: string[]) => ids.filter(id => target.layers.some(l => l.id === id));
  const operations: Operation[] = [];
  const base = (e: Element) => {
    const o: { id: string; pageId: string; layerIds: string[]; name?: string; alias?: string; level?: number } = { id: idMap.get(e.id)!, pageId: target.id, layerIds: layerOk(e.layerIds) };
    if (e.level !== undefined && e.level !== 0) o.level = e.level;
    if (e.name !== undefined) o.name = e.name;
    if (e.alias) { const a = uniqueAlias(e.alias, taken); taken.add(a); o.alias = a; }
    return o;
  };
  const moved = (e: Element) => ({ x: e.bounds.x + offsetPt, y: e.bounds.y + offsetPt, width: e.bounds.width, height: e.bounds.height });
  // Shapes first, then connectors, so every endpoint exists when the connector is created.
  for (const e of clip.elements) {
    if (e.kind === 'shape') {
      operations.push({
        op: 'createShape', ...base(e), bounds: moved(e), rotationDeg: e.rotationDeg, geometry: { ...e.geometry }, style: { ...e.style },
        ...(e.text ? { text: { ...e.text } } : {}), ...(e.ports ? { ports: e.ports.map(p => ({ ...p })) } : {}),
        ...(e.container ? { container: { ...(e.container.fit ? { fit: e.container.fit } : {}), ...(e.container.marginPt ? { marginPt: e.container.marginPt } : {}) } } : {}),
      });
    } else if (e.kind === 'text') {
      operations.push({ op: 'createText', ...base(e), bounds: moved(e), rotationDeg: e.rotationDeg, text: { ...e.text } });
    } else if (e.kind === 'image') {
      operations.push({
        op: 'createImage', ...base(e), bounds: moved(e), rotationDeg: e.rotationDeg, assetId: e.assetId, fit: e.fit, opacity: e.opacity,
        preserveAspectRatio: e.preserveAspectRatio,
      });
    }
  }
  // A branch is created after the connector it joins, so order the connectors by how deep their joins run.
  const connectors = clip.elements.filter((e): e is ConnectorElement => e.kind === 'connector');
  const byId = new Map(connectors.map(c => [c.id, c] as const));
  const depth = (c: ConnectorElement, seen = new Set<string>()): number => {
    seen.add(c.id);
    const ids = [c.from, c.to].map(ep => ep.join?.connectorId).filter((id): id is string => !!id && byId.has(id) && !seen.has(id));
    return ids.length ? 1 + Math.max(...ids.map(id => depth(byId.get(id)!, new Set(seen)))) : 0;
  };
  for (const c of connectors.map(c => [depth(c), c] as const).sort((a, b) => a[0] - b[0] || compareElementOrder(a[1], b[1])).map(x => x[1])) {
    const remap = (ep: Endpoint) => ep.join && idMap.has(ep.join.connectorId)
      ? { glue: 'none' as const, join: { connector: idMap.get(ep.join.connectorId)!, position: ep.join.position } }
      : ep.glue === 'none'
        ? { glue: 'none' as const, point: { x: ep.point!.x + offsetPt, y: ep.point!.y + offsetPt } }
        : { glue: ep.glue, elementId: idMap.get(ep.elementId!)!, ...(ep.port ? { port: ep.port } : {}) };
    operations.push({
      op: 'createConnector', ...base(c), from: remap(c.from), to: remap(c.to), route: c.route,
      waypoints: c.waypoints.map(p => ({ x: p.x + offsetPt, y: p.y + offsetPt })), style: { ...c.style }, ...(c.label ? { label: { ...c.label } } : {}),
      ...(c.hops ? { hops: c.hops } : {}),
    });
  }
  // Membership last, once every member exists: a pasted container holds the copies of its members.
  for (const e of clip.elements) {
    if (!isContainer(e)) continue;
    const add = e.container.memberIds.filter(m => idMap.has(m)).map(m => idMap.get(m)!);
    if (add.length) operations.push({ op: 'contain', container: idMap.get(e.id)!, add });
  }
  return { operations, newIds: [...idMap.values()] };
}
