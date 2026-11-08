import type { ConnectorElement, DiagramDocument, Element, Endpoint, Page, Point, Snapshot } from '../contracts/generated';
import { applyDiff, type DiffBody } from './diff';
import { pointOnRoute } from './pathAnchor';
import type { Plan } from './planPatch';
import type { RouteSource } from './attachments';

const isConnector = (e: Element): e is ConnectorElement => e.kind === 'connector';
const joined = (c: ConnectorElement): boolean => c.from.join !== undefined || c.to.join !== undefined;
const hasJoins = (doc: DiagramDocument): boolean => doc.pages.some(p => p.elements.some(e => isConnector(e) && joined(e)));
const round = (n: number): number => Math.round(n * 100) / 100;
/** A branch of a branch needs the one before it settled first, so the pass repeats; chains are cut off here. */
const MAX_PASSES = 8;

/** Locked by itself, by an assigned layer, or by a locked group above it: the same rule the planner applies to an edit. */
function isProtected(page: Page, el: Element): boolean {
  const locked = (e: Element) => e.locked || e.layerIds.some(id => page.layers.find(l => l.id === id)?.locked);
  const parentOf = (id: string) => page.elements.find(e => e.kind === 'group' && e.childIds.includes(id));
  for (let e: Element | undefined = el; e; e = parentOf(e.id)) if (locked(e)) return true;
  return false;
}

/**
 * The locked connectors that follow `id` when its route changes: those joined to it, and those joined to them, and so on. Settling would
 * move them, so a caller that must not touch locked content refuses or skips the edit instead.
 */
export function lockedJoinDependents(page: Page, id: string): string[] {
  const following = new Set([id]), locked: string[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const e of page.elements) {
      if (!isConnector(e) || following.has(e.id)) continue;
      if (!(following.has(e.from.join?.connectorId ?? '') || following.has(e.to.join?.connectorId ?? ''))) continue;
      following.add(e.id); grew = true;
      if (isProtected(page, e)) locked.push(e.id);
    }
  }
  return locked.sort();
}

/** The box around a connector's ends and author waypoints, as the planner derives it. */
function boundsOf(c: ConnectorElement, byId: ReadonlyMap<string, Element>): ConnectorElement['bounds'] {
  const end = (ep: Endpoint): Point | undefined => {
    if (ep.point) return ep.point;
    const b = ep.elementId ? byId.get(ep.elementId)?.bounds : undefined;
    return b && { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  const pts: Point[] = [end(c.from), end(c.to), ...c.waypoints].filter((p): p is Point => !!p);
  if (pts.length === 0) return c.bounds;
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Keeps the joined ends of branch connectors on the connectors they join. After a plan, every joined end is put at its place along the
 * route of the connector it joins, as drawn (so it follows when that connector, or a shape it is glued to, moves or reroutes). A join whose
 * connector is gone is released and the end stays where it is. The changes join the plan, so one undo returns all of it.
 */
export function settleJoins(before: DiagramDocument, plan: Plan, source: RouteSource | null, snapshotOf: (doc: DiagramDocument) => Snapshot): Plan {
  if (plan.noChange) return plan;
  let after = applyDiff(before, plan.forward, before.revision + 1);
  if (!hasJoins(after)) return plan;

  const beforeById = new Map<string, Element>();
  for (const p of before.pages) for (const e of p.elements) beforeById.set(e.id, e);
  const forward: DiffBody = { upserts: { ...plan.forward.upserts, elements: plan.forward.upserts.elements.slice() }, deletes: plan.forward.deletes };
  const inverse: DiffBody = { upserts: { ...plan.inverse.upserts, elements: plan.inverse.upserts.elements.slice() }, deletes: plan.inverse.deletes };
  const changed: string[] = [], pageIds = new Set(plan.changedPageIds);

  const put = (page: Page, next: ConnectorElement) => {
    const old = beforeById.get(next.id);
    const f = forward.upserts.elements.findIndex(u => u.element.id === next.id);
    if (f >= 0) forward.upserts.elements[f] = { ...forward.upserts.elements[f]!, element: next };
    else forward.upserts.elements.push({ pageId: page.id, element: next });
    if (old && !inverse.upserts.elements.some(u => u.element.id === next.id)) inverse.upserts.elements.push({ pageId: page.id, element: old });
    if (old && !plan.created.includes(next.id)) changed.push(next.id);
    pageIds.add(page.id);
  };

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const routes = source ? source(snapshotOf(after)) : null;
    let moved = false;
    for (const page of after.pages) {
      const byId = new Map(page.elements.map(e => [e.id, e] as const));
      for (const el of page.elements) {
        if (!isConnector(el) || !joined(el)) continue;
        let next: ConnectorElement = el;
        for (const key of ['from', 'to'] as const) {
          const ep: Endpoint = next[key];
          if (!ep.join) continue;
          const target = byId.get(ep.join.connectorId);
          if (!target || target.kind !== 'connector') { const { join: _gone, ...rest } = ep; next = { ...next, [key]: rest }; continue; } // its connector is gone: the end stays where it is
          const route = routes && routes.ok ? routes.value.connectors[target.id]?.routePoints : undefined;
          if (!route?.length) continue;
          const on = pointOnRoute(route, ep.join.position, 0);
          if (!on) continue;
          const point = { x: round(on.point.x), y: round(on.point.y) };
          if (ep.point && Math.abs(ep.point.x - point.x) < 0.005 && Math.abs(ep.point.y - point.y) < 0.005) continue;
          next = { ...next, [key]: { ...ep, point } };
        }
        if (next === el) continue;
        next = { ...next, bounds: boundsOf(next, byId) };
        put(page, next);
        moved = true;
        after = { ...after, pages: after.pages.map(p => (p.id === page.id ? { ...p, elements: p.elements.map(e => (e.id === next.id ? next : e)) } : p)) };
      }
    }
    if (!moved || !source) break;
  }
  if (changed.length === 0 && forward.upserts.elements.length === plan.forward.upserts.elements.length && forward.upserts.elements.every((u, i) => u === plan.forward.upserts.elements[i])) return plan;
  return {
    ...plan, forward, inverse,
    changed: [...new Set([...plan.changed, ...changed])], changedPageIds: [...pageIds],
    visuallyAffectedIds: [...new Set([...plan.visuallyAffectedIds, ...changed])],
  };
}
