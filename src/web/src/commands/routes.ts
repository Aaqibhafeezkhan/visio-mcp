import type { ConnectorElement, DiagramDocument, Element, Page, RouteChange, RouteFinding } from '../contracts/generated';
import { planRoutes, STORED_TOLERANCE, storedRoute, type PlannedRoute } from '../layout/routePlanner';
import { applyDiff, type DiffBody } from './diff';
import type { Plan } from './planPatch';

const orthogonal = (e: Element): e is ConnectorElement => e.kind === 'connector' && e.route === 'orthogonal';
const round = (n: number): number => Math.round(n * 1000) / 1000;
const sameRoute = (a: readonly { x: number; y: number }[] | undefined, b: readonly { x: number; y: number }[]): boolean =>
  !!a && a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i]!.x) < STORED_TOLERANCE && Math.abs(p.y - b[i]!.y) < STORED_TOLERANCE);

/**
 * R20: keeps the route the router chose on each automatic orthogonal connector (`routing.advisory`), so that a document reopened, projected
 * or exported shows the routes the person saw, and an edit changes only the routes it has to. The planner is run on the document the plan
 * would produce, starting from each connector's stored route (or, for one that has none yet, the route it had before this edit); the
 * connectors whose stored route changed join the plan, so one undo returns them. Manual connectors store no route, frozen ones keep theirs.
 */
export function settleRoutes(before: DiagramDocument, plan: Plan): Plan {
  if (plan.noChange) return plan;
  const after = applyDiff(before, plan.forward, before.revision + 1);
  const beforeById = new Map<string, Element>();
  for (const p of before.pages) for (const e of p.elements) beforeById.set(e.id, e);
  const fresh = new Set(plan.freshRoutes ?? []);

  const forward: DiffBody = { upserts: { ...plan.forward.upserts, elements: plan.forward.upserts.elements.slice() }, deletes: plan.forward.deletes };
  const inverse: DiffBody = { upserts: { ...plan.inverse.upserts, elements: plan.inverse.upserts.elements.slice() }, deletes: plan.inverse.deletes };
  const changed: string[] = [], pageIds = new Set(plan.changedPageIds), routeChanges: RouteChange[] = [], routeFindings: RouteFinding[] = [];

  const put = (page: Page, next: Element) => {
    const old = beforeById.get(next.id);
    const f = forward.upserts.elements.findIndex(u => u.element.id === next.id);
    if (f >= 0) forward.upserts.elements[f] = { ...forward.upserts.elements[f]!, element: next };
    else forward.upserts.elements.push({ pageId: page.id, element: next });
    if (old && !inverse.upserts.elements.some(u => u.element.id === next.id)) inverse.upserts.elements.push({ pageId: page.id, element: old });
    if (old && !plan.created.includes(next.id)) changed.push(next.id);
    pageIds.add(page.id);
  };

  for (const page of after.pages) {
    if (!page.elements.some(orthogonal)) continue;
    const beforePage = before.pages.find(p => p.id === page.id);
    const area = page.widthPt * page.heightPt;

    // A connector that has no stored route keeps the route it was drawn with before this edit, not a fresh one.
    const drawnBefore = new Map<string, PlannedRoute>();
    if (beforePage && beforePage.elements.some(e => orthogonal(e) && !e.routing?.advisory && !fresh.has(e.id))) {
      for (const [id, r] of planRoutes({ elements: beforePage.elements, layers: beforePage.layers, pageArea: area }).routes) drawnBefore.set(id, r);
    }
    const previous = new Map<string, PlannedRoute>();
    for (const e of page.elements) {
      if (!orthogonal(e) || fresh.has(e.id)) continue;
      const stored = storedRoute(e) ?? drawnBefore.get(e.id);
      if (stored) previous.set(e.id, stored);
    }

    const planned = planRoutes({ elements: page.elements, layers: page.layers, pageArea: area, previous });
    routeFindings.push(...planned.routeFindings);
    for (const e of page.elements) {
      if (!orthogonal(e)) continue;
      const route = planned.routes.get(e.id);
      if (!route) continue;
      const keepsRoute = e.waypoints.length === 0; // a manual connector's route is its waypoints
      const advisory = keepsRoute ? route.points.map(p => ({ x: round(p.x), y: round(p.y) })) : undefined;
      const clearBeautified = !!e.routing?.beautified && route.provenance !== 'beautified';
      if ((advisory ? !sameRoute(e.routing?.advisory, advisory) : e.routing?.advisory !== undefined) || clearBeautified) {
        const routing = { ...(e.routing ?? {}) } as NonNullable<ConnectorElement['routing']>;
        if (advisory) routing.advisory = advisory; else delete routing.advisory;
        if (clearBeautified) delete routing.beautified;
        const next: ConnectorElement = { ...e };
        if (Object.keys(routing).length) next.routing = routing; else delete next.routing;
        put(page, next);
      }
    }
    const ids = new Set(page.elements.filter(orthogonal).map(e => e.id));
    for (const c of planned.changes) if (ids.has(c.id)) routeChanges.push({ id: c.id, provenance: c.provenance, ...(c.reason ? { reason: c.reason } : {}) });
  }

  if (!changed.length && !routeChanges.length && forward.upserts.elements.length === plan.forward.upserts.elements.length && forward.upserts.elements.every((u, i) => u === plan.forward.upserts.elements[i])) return plan;
  return {
    ...plan, forward, inverse, routeChanges, routeFindings,
    changed: [...new Set([...plan.changed, ...changed])], changedPageIds: [...pageIds],
    visuallyAffectedIds: [...new Set([...plan.visuallyAffectedIds, ...changed])],
  };
}
