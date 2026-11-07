import type { ConnectorElement, Element, Operation, Page, Point, Projection, RouteFinding, Scope } from '../contracts/generated';
import type { CommandEngine } from '../commands/CommandEngine';
import { ancestorsOf } from '../commands/groups';
import { pointOnRoute } from '../commands/pathAnchor';
import { STORED_TOLERANCE, storedRoute, type RouteProvenance } from '../layout/routePlanner';
import { fail, ok, type Result } from '../model/result';

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_TARGETS = 1000;

export interface ProposedRoute {
  id: string;
  /** The whole route in page points, as the commit would leave it drawn. */
  points: Point[];
  provenance: RouteProvenance;
  reason?: string;
  /** The route differs from the one drawn now (by more than the stored-route tolerance). Not the same as a transaction's noChange. */
  geometryChanged: boolean;
  lengthPt: number;
  bends: number;
}
export interface RouteProposal {
  documentId: string;
  sessionId: string;
  revision: number;
  pageId: string;
  strategy: 'reroute';
  routes: ProposedRoute[];
  skipped: Array<{ id: string; reason: string }>;
  routeFindings: RouteFinding[];
  visuallyAffectedIds: string[];
  /** Present only when committing would improve something and change nothing outside the targets: apply it as is with a new transactionId. */
  commit?: { baseRevision: number; operations: Operation[] };
}

type Connector = ConnectorElement;
const isConnector = (e: Element | undefined): e is Connector => e?.kind === 'connector';
const samePoints = (a: readonly Point[], b: readonly Point[]) =>
  a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i]!.x) < STORED_TOLERANCE && Math.abs(p.y - b[i]!.y) < STORED_TOLERANCE);
const lengthOf = (r: readonly Point[]) => r.slice(1).reduce((n, p, i) => n + Math.abs(p.x - r[i]!.x) + Math.abs(p.y - r[i]!.y), 0);
const bendsOf = (r: readonly Point[]) => r.slice(1, -1).filter((p, i) => (Math.abs(r[i]!.y - p.y) < 1e-6) !== (Math.abs(p.y - r[i + 2]!.y) < 1e-6)).length;
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The input, checked before anything is queued: only these two fields, and connectorIds never widened by being empty or repeated. */
function readInput(p: Record<string, unknown>): Result<{ pageId?: string; connectorIds?: string[] }> {
  const unknown = Object.keys(p).filter(k => k !== 'pageId' && k !== 'connectorIds');
  if (unknown.length) return fail('invalid_request', `unknown field ${unknown.join(', ')}`, { details: { fields: unknown } });
  if (p.pageId !== undefined && (typeof p.pageId !== 'string' || !UUID.test(p.pageId))) return fail('invalid_request', 'pageId must be a UUID');
  if (p.connectorIds === undefined) return ok(p.pageId ? { pageId: p.pageId as string } : {});
  const ids = p.connectorIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_TARGETS) return fail('invalid_request', `connectorIds must hold 1 to ${MAX_TARGETS} connector UUIDs`);
  if (ids.some(i => typeof i !== 'string' || !UUID.test(i))) return fail('invalid_request', 'connectorIds must be UUIDs');
  if (new Set(ids).size !== ids.length) return fail('invalid_request', 'connectorIds must not repeat an id');
  return ok({ ...(p.pageId ? { pageId: p.pageId as string } : {}), connectorIds: ids as string[] });
}

/** Why the page-wide proposal leaves a connector out, or undefined when it is a target: the same rules reroute and editing apply. */
function ineligible(page: Page, el: Connector, parents: ReadonlyMap<string, string>): string | undefined {
  if (el.route !== 'orthogonal') return 'not an orthogonal connector';
  if (el.waypoints.length) return 'manual: its route is its waypoints';
  if (el.routing?.mode === 'frozen') return 'frozen: its stored route is kept';
  const layerLocked = (e: Element) => e.layerIds.some(id => page.layers.find(l => l.id === id)?.locked);
  if (el.locked) return 'locked';
  if (layerLocked(el)) return 'on a locked layer';
  for (const a of ancestorsOf(parents, el.id)) {
    const g = page.elements.find(e => e.id === a);
    if (g && (g.locked || layerLocked(g))) return 'in a locked group';
  }
  return undefined;
}

/**
 * R25 propose_routes: what rerouting these connectors would do, worked out by the engine's own transaction planning on one captured
 * snapshot, with nothing committed. The commit it offers is that same reroute (every target, changed or not, so the planner sees the same
 * thing) at the captured revision; a stale commit then fails with revision_conflict.
 */
export function proposeRoutes(engine: CommandEngine, scope: Scope, params: Record<string, unknown>): Promise<Result<RouteProposal>> {
  const input = readInput(params);
  if (!input.ok) return Promise.resolve(input);
  const { pageId, connectorIds } = input.value;

  return engine.previewRoutes<RouteProposal>(scope, ({ before, plan, drawn }) => {
    const doc = before.document;
    const pageNamed = pageId ? doc.pages.find(p => p.id === pageId) : undefined;
    if (pageId && !pageNamed) return fail('not_found', `page ${pageId} does not exist`);

    let page: Page;
    if (connectorIds) {
      const home = new Map<string, Page>();
      for (const id of connectorIds) {
        const found = doc.pages.find(p => p.elements.some(e => e.id === id));
        if (!found) return fail('not_found', `no element ${id}`, { details: { target: id } });
        home.set(id, found);
      }
      const pages = [...new Set(home.values())];
      if (pageNamed) {
        const elsewhere = connectorIds.filter(id => home.get(id) !== pageNamed);
        if (elsewhere.length) return fail('invalid_request', `connectors are not on page ${pageNamed.id}`, { details: { pageId: pageNamed.id, connectorIds: elsewhere.sort() } });
        page = pageNamed;
      } else if (pages.length > 1) {
        return fail('invalid_request', 'the connectors are on more than one page; propose routes for one page at a time', { details: { pageIds: pages.map(p => p.id) } });
      } else page = pages[0]!;
    } else if (pageNamed) page = pageNamed;
    else if (doc.pages.length === 1) page = doc.pages[0]!;
    else return fail('invalid_request', 'this request needs a pageId: the document has more than one page');

    const skipped: RouteProposal['skipped'] = [];
    let targets: string[];
    if (connectorIds) targets = [...connectorIds].sort();
    else {
      const parents = new Map<string, string>();
      for (const e of page.elements) if (e.kind === 'group') for (const c of e.childIds) parents.set(c, e.id);
      targets = [];
      for (const el of page.elements.filter(isConnector).sort(byId)) {
        const why = ineligible(page, el, parents);
        if (why) skipped.push({ id: el.id, reason: why }); else targets.push(el.id);
      }
      if (targets.length > MAX_TARGETS) return fail('limit_exceeded', `the page has ${targets.length} connectors to reroute; name at most ${MAX_TARGETS}`, { details: { limit: MAX_TARGETS, actual: targets.length } });
    }

    const head = { documentId: before.documentId, sessionId: before.sessionId, revision: before.revision, pageId: page.id, strategy: 'reroute' as const };
    if (!targets.length) return ok({ ...head, routes: [], skipped, routeFindings: [], visuallyAffectedIds: [] });

    // Every surface draws a stored route as stored. A connector with no stored route (an older document) is drawn from the projector's
    // memory, so what is drawn now is read from the projection of this snapshot, before planning projects documents of its own.
    let shown: Projection | undefined;
    if (targets.some(id => !storedRoute(page.elements.find(e => e.id === id) as Connector))) {
      const projected = drawn();
      if (!projected.ok) return projected;
      shown = projected.value;
    }

    const operations: Operation[] = [{ op: 'reroute', targets }];
    const planned = plan(operations);
    if (!planned.ok) return planned;
    const { plan: p, after } = planned.value;

    // Scope is never widened: a connector outside the targets that the commit would change (a joined branch, or a connector whose stored
    // route settling would write) is a conflict, named so the caller can include it. Attached labels move with their connector and are reported.
    const targetSet = new Set(targets);
    const connectorIdsBefore = new Set(doc.pages.flatMap(pg => pg.elements.filter(isConnector).map(e => e.id)));
    const outside = [...new Set([...p.changed, ...p.created, ...p.deleted])].filter(id => connectorIdsBefore.has(id) && !targetSet.has(id)).sort();
    if (outside.length) {
      return fail('dependency_conflict', 'rerouting these connectors would also change other connectors: include them or leave this change out', { details: { connectorIds: outside } });
    }

    const afterPage = after.pages.find(pg => pg.id === page.id)!;
    // Joins are settled before routes are stored, against the routes the projector draws. A connector joined to a target must end up on the
    // target's new route; if the commit would leave it on the old one, the join is not kept, and no choice of targets fixes that.
    const detached = afterPage.elements.filter(isConnector).filter(c => [c.from, c.to].some(ep => {
      if (!ep.join || !targetSet.has(ep.join.connectorId) || !ep.point) return false;
      const trunk = storedRoute(afterPage.elements.find(e => e.id === ep.join!.connectorId) as Connector)?.points;
      const on = trunk && pointOnRoute(trunk, ep.join.position, 0);
      return !!on && (Math.abs(on.point.x - ep.point.x) > STORED_TOLERANCE || Math.abs(on.point.y - ep.point.y) > STORED_TOLERANCE);
    })).map(c => c.id).sort();
    if (detached.length) {
      return fail('dependency_conflict', 'connectors joined to these would be left off the new routes, so reroute cannot keep the joins', { details: { connectorIds: detached, reason: 'join_not_followed' } });
    }
    const changes = new Map((p.routeChanges ?? []).map(c => [c.id, c]));
    const routes: ProposedRoute[] = [];
    for (const id of targets) {
      const was = page.elements.find(e => e.id === id) as Connector;
      const now = afterPage.elements.find(e => e.id === id) as Connector;
      const beforePoints = storedRoute(was)?.points ?? shown?.connectors[id]?.routePoints;
      if (!beforePoints?.length) return fail('projection_failed', `the projection has no route for ${id}`, { details: { connectorIds: [id] } });
      // A plan that changes nothing (reroute of connectors with no stored route) commits nothing: the drawing stays as it is.
      const points = p.noChange ? beforePoints : storedRoute(now)?.points ?? beforePoints;
      const change = changes.get(id);
      const provenance: RouteProvenance = p.noChange ? 'kept' : change?.provenance ?? 'kept';
      const reason = p.noChange ? 'it has no stored route, so reroute leaves it as drawn' : change?.reason;
      routes.push({
        id, points: points.map(pt => ({ x: pt.x, y: pt.y })), provenance, ...(reason ? { reason } : {}),
        geometryChanged: !samePoints(beforePoints, points), lengthPt: lengthOf(points), bends: bendsOf(points),
      });
    }
    const routeFindings = p.noChange ? targets.flatMap(id => shown?.connectors[id]?.routeFindings ?? []) : p.routeFindings ?? [];
    const unresolved = routes.some(r => r.provenance === 'unresolved') || routeFindings.some(f => f.code === 'UNRESOLVED_ROUTE' && targetSet.has(f.elementId));
    const improves = !p.noChange && routes.some(r => r.geometryChanged) && !unresolved;
    return ok({
      ...head, routes, skipped, routeFindings, visuallyAffectedIds: p.noChange ? [] : p.visuallyAffectedIds,
      ...(improves ? { commit: { baseRevision: before.revision, operations } } : {}),
    });
  });
}
