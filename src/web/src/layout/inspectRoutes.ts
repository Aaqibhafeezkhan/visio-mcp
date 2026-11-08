import type { Bounds, ConnectorElement, Element, Page, Point } from '../contracts/generated';
import { visualBounds } from '../commands/geometry';
import { HOP_SIZE_PT } from '../canvas/cellMapping';
import { compareHopOrder, hopCrossings } from '../canvas/hopShape';
import { planRoutes } from './routePlanner';
import { simplifyRoute } from './routeSegments';
import { passesBehind } from './routingPolicy';
import { BACKGROUND_SHARE } from './obstacleGeometry';
import { isLaneStructure } from './swimlane';
import { ALONGSIDE_PT, classifyRouteContacts, NEAR_PT, routeRuns, SHORT_PT } from './routeContacts';
import type { RouteContact, RouteContactRoute, RouteRun } from './routeContacts';
import type { RouteProvenance } from './routePlanner';
import type { Severity } from './inspectLayout';

/**
 * R26: the routing findings `inspect_layout` can report, as a stable list. Each is read-only and carries ids, bounds and evidence with a
 * `classification`, so an agent can tell a defect from something drawn on purpose.
 */
export const ROUTE_FINDING_CODES = [
  'CONNECTOR_CROSSES_SHAPE', 'CONNECTOR_CROSSES_CONTAINER', 'CONNECTOR_CROSSES_BACKGROUND', 'CONNECTOR_PASSES_OVER_SHAPE',
  'CONNECTORS_CROSS', 'CONNECTOR_JOIN', 'CONNECTOR_TOUCHES_CONNECTOR', 'CONNECTORS_OVERLAP', 'CONNECTORS_TOO_CLOSE',
  'ROUTE_SHORT_SEGMENT', 'ROUTE_REDUNDANT_VERTEX', 'ROUTE_EXCESS_BENDS', 'ROUTE_TOO_CLOSE_TO_SHAPE',
  'UNRESOLVED_ROUTE', 'ROUTING_AVOIDANCE_VIOLATION', 'ROUTE_SIDE_PREFERENCE_RELAXED', 'ROUTE_REQUIRED_SIDE_UNRESOLVED',
  'UNGLUED_CONNECTOR_END', 'DANGLING_CONNECTOR',
] as const;

/** A kept route with this many more bends than the router would now draw has gone stale. */
export const EXTRA_BENDS = 2;

type Add = (code: string, severity: Severity, ids: string[], bounds: Bounds, message: string, evidence?: Record<string, unknown>) => void;
export type RouteMode = 'automatic' | 'guided' | 'manual' | 'frozen' | 'straight' | 'curved';

export function routeModeOf(c: ConnectorElement): RouteMode {
  if (c.route !== 'orthogonal') return c.route;
  if (c.routing?.mode === 'frozen') return 'frozen';
  if (c.waypoints.length) return 'manual';
  return c.routing?.constraints?.length ? 'guided' : 'automatic';
}

type Run = RouteRun;

const boxOf = (pts: readonly Point[], pad = 0): Bounds => {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
};
const round = (v: number) => Math.round(v * 100) / 100;

const contains = (outer: Bounds, inner: Bounds, tol = 0.5): boolean =>
  outer.x <= inner.x + tol && outer.y <= inner.y + tol && outer.x + outer.width >= inner.x + inner.width - tol && outer.y + outer.height >= inner.y + inner.height - tol;

/** Why a shape a connector passes through is not a defect, or undefined if it is one. The router ignores the same shapes. */
export function intendedCrossing(c: ConnectorElement, shape: Element, byId: ReadonlyMap<string, Element>, pageArea: number): 'container' | 'background' | undefined {
  const policy = 'routingPolicy' in shape ? shape.routingPolicy?.obstacle : undefined;
  if (policy === 'forbidden' || policy === 'avoid') return undefined; // the router was told to keep out
  const box = visualBounds(shape);
  if (box.width * box.height >= BACKGROUND_SHARE * pageArea) return 'background'; // size first: a page-size backdrop holds everything
  for (const id of [c.from.elementId, c.to.elementId]) {
    const end = id ? byId.get(id) : undefined;
    if (end && end.kind !== 'connector' && end.kind !== 'group' && end.id !== shape.id && contains(box, visualBounds(end))) return 'container';
  }
  return undefined;
}

interface Routed { el: ConnectorElement; points: Point[]; runs: Run[]; mode: RouteMode; provenance?: RouteProvenance }

/**
 * Connector-to-connector and route-shape findings for one page (R26). Needs resolved routes: without them a connector is only a straight
 * line between its ends, which says nothing about how it is drawn, so nothing is reported.
 */
export function inspectRoutes(page: Page, shown: readonly Element[], routes: ReadonlyMap<string, { points: Point[]; provenance?: RouteProvenance }>, add: Add): void {
  const byId = new Map(page.elements.map(e => [e.id, e] as const));
  const routed: Routed[] = [];
  for (const el of shown) {
    if (el.kind !== 'connector') continue;
    const r = routes.get(el.id);
    if (!r || r.points.length < 2) continue;
    const mode = routeModeOf(el);
    routed.push({ el, points: r.points, runs: routeRuns(r.points), mode, ...(r.provenance ? { provenance: r.provenance } : {}) });
  }
  routed.sort((a, b) => (a.el.id < b.el.id ? -1 : a.el.id > b.el.id ? 1 : 0));
  const contactRoutes: RouteContactRoute[] = routed.map(r => ({
    connectorId: r.el.id, points: r.points, mode: r.mode,
    joinConnectorIds: [...new Set([r.el.from.join?.connectorId, r.el.to.join?.connectorId].filter((id): id is string => Boolean(id)))],
    joinedEnds: ([['from', r.el.from], ['to', r.el.to]] as const).flatMap(([end, ep]) => ep.join ? [{ connectorId: ep.join.connectorId, end }] : []),
    ...(r.el.from.elementId ? { fromElementId: r.el.from.elementId } : {}), ...(r.el.to.elementId ? { toElementId: r.el.to.elementId } : {}),
  }));
  const contactPairs = new Map<string, RouteContact[]>();
  for (const contact of classifyRouteContacts(contactRoutes)) {
    const key = `${contact.connectorIds[0]}\0${contact.connectorIds[1]}`;
    contactPairs.set(key, [...(contactPairs.get(key) ?? []), contact]);
  }

  // ---- connector to connector
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      const A = routed[i]!, B = routed[j]!;
      if (A.mode === 'curved' || B.mode === 'curved') continue; // a curve is drawn by maxGraph from control points: its line is not known here
      const ids = [A.el.id, B.el.id];
      const pairContacts = contactPairs.get(`${A.el.id}\0${B.el.id}`) ?? [];
      const joins = pairContacts.filter(contact => contact.classification === 't_join');
      if (joins.length) {
        for (const contact of joins) add('CONNECTOR_JOIN', 'info', [contact.branchId!, contact.trunkId!], boxOf([contact.point!], 2), 'The connector joins another connector here; this is a junction, not a crossing.',
          { classification: 't_join', intended: true, branchId: contact.branchId, trunkId: contact.trunkId, end: contact.end, point: contact.point });
        continue; // joined connectors meet on purpose; they are not judged against each other (hops ignore them too)
      }

      const points: Point[] = [], hopped: Point[] = [];
      const hopper = [A, B].filter(x => x.el.hops === 'arc').sort((x, y) => -compareHopOrder({ hopLevel: x.el.level ?? 0, hopOrder: x.el.zIndex }, { hopLevel: y.el.level ?? 0, hopOrder: y.el.zIndex }))[0];
      // the renderer's own rule decides which crossings get an arc (it reads only x and y, so plain points will do)
      const arcs = hopper ? hopCrossings(hopper.points as never, [(hopper === A ? B : A).points] as never, HOP_SIZE_PT).flat().map(c => c.point) : [];
      for (const contact of pairContacts.filter(c => c.classification === 'crossing')) {
        const at = contact.point!;
        (arcs.some(h => Math.hypot(h.x - at.x, h.y - at.y) <= 0.5) ? hopped : points).push(at);
      }
      if (points.length || hopped.length) {
        const all = [...points, ...hopped];
        add('CONNECTORS_CROSS', 'info', ids, boxOf(all, 2), points.length ? 'The connectors cross each other.' : 'The connectors cross, and a line hop shows which passes over.',
          { classification: points.length ? 'crossing' : 'hopped', intended: points.length === 0, crossings: all.length, hopped: hopped.length, points: all, ...(hopper ? { hopsOver: hopper.el.id } : {}) });
      }

      for (const [X, Y] of [[A, B], [B, A]] as const) {
        for (const [side, at] of [['from', X.points[0]!], ['to', X.points[X.points.length - 1]!]] as const) {
          const contact = pairContacts.find(c => c.classification === 'endpoint_contact' && c.end === side && c.point?.x === round(at.x) && c.point?.y === round(at.y) && c.connectorIds.includes(X.el.id));
          if (!contact) continue;
          const touchedRun = contact.connectorIds[0] === Y.el.id ? contact.segments[0] : contact.segments[1];
          add('CONNECTOR_TOUCHES_CONNECTOR', 'warning', [X.el.id, Y.el.id], boxOf([at], 2), 'The end of one connector lies on another connector without being joined to it, so it looks like a junction that is not there.',
            { classification: 'endpoint_contact', intended: false, end: side, point: contact.point, touchedRun });
        }
      }

      const overlapContacts = pairContacts.filter(c => c.classification === 'collinear_overlap' || c.classification === 'collinear_shared_end');
      const overlaps = overlapContacts.map(c => ({ runA: c.segments[0], runB: c.segments[1], from: c.overlap!.from, to: c.overlap!.to, axis: c.overlap!.axis, at: c.overlap!.at }));
      const overlapPt = overlapContacts.reduce((sum, contact) => sum + contact.overlap!.length, 0);
      if (overlaps.length) {
        const shared = overlapContacts.some(contact => contact.classification === 'collinear_shared_end');
        const spans = overlaps.flatMap(o => o.axis === 'h' ? [{ x: o.from, y: o.at }, { x: o.to, y: o.at }] : [{ x: o.at, y: o.from }, { x: o.at, y: o.to }]);
        add('CONNECTORS_OVERLAP', 'warning', ids, boxOf(spans, 2), shared ? 'The connectors share an end and are drawn on top of each other along the way, so they read as one line.' : 'The connectors are drawn on top of each other along the way, so they read as one line.',
          { classification: shared ? 'collinear_shared_end' : 'collinear_overlap', intended: false, overlapPt: round(overlapPt), overlaps });
      }
      const near = pairContacts.find(c => c.classification === 'parallel_near_miss');
      if (near) {
        const mover = A.mode === 'automatic' || A.mode === 'guided' ? A : B;
        const [runA, runB] = near.segments, ra = A.runs[runA]!, rb = B.runs[runB]!;
        const run = mover === A ? runA : runB, from = mover === A ? ra.coord : rb.coord, to = mover === A ? rb.coord : ra.coord;
        add('CONNECTORS_TOO_CLOSE', 'info', ids, boxOf([ra.a, ra.b, rb.a, rb.b], 2), 'Two connectors run side by side very close together.',
          { classification: 'parallel_near_miss', intended: false, gapPt: near.gapPt, alongsidePt: near.alongsidePt, suggestion: { action: 'move_run', elementId: mover.el.id, segment: run, to: round(from + Math.sign(from - to || 1) * 8) } });
      }
    }
  }

  // ---- the shape of each route: automatic and guided routes only; a manual or frozen route was drawn that way on purpose
  const judged = routed.filter(r => r.mode === 'automatic' || r.mode === 'guided');
  if (!judged.length) return;
  const fresh = planRoutes({ elements: page.elements, layers: page.layers, pageArea: page.widthPt * page.heightPt }).routes;
  const pageArea = page.widthPt * page.heightPt;
  const bends = (pts: readonly Point[]) => Math.max(0, simplifyRoute(pts).length - 2);
  for (const r of judged) {
    const base = { routeMode: r.mode, ...(r.provenance ? { provenance: r.provenance } : {}) };
    const box = boxOf(r.points);
    const short = r.runs.filter(run => run.length > 0.01 && run.length < SHORT_PT);
    if (short.length) add('ROUTE_SHORT_SEGMENT', 'warning', [r.el.id], boxOf(short.flatMap(s => [s.a, s.b]), 2), 'The route has a run so short it shows as a kink.',
      { ...base, classification: 'near_zero_segment', intended: false, segments: short.map(s => ({ index: s.index, lengthPt: round(s.length) })), suggestion: { action: 'straighten', elementId: r.el.id } });

    const simple = simplifyRoute(r.points);
    if (simple.length < r.points.length) {
      const kept = new Set(simple.map(p => `${p.x},${p.y}`)), redundant: number[] = [];
      r.points.forEach((p, i) => { if (i > 0 && i < r.points.length - 1 && (!kept.has(`${p.x},${p.y}`) || (p.x === r.points[i - 1]!.x && p.y === r.points[i - 1]!.y))) redundant.push(i); });
      if (redundant.length) add('ROUTE_REDUNDANT_VERTEX', 'info', [r.el.id], boxOf(redundant.map(i => r.points[i]!), 3), 'The route has corners that do not turn.',
        { ...base, classification: 'redundant_vertex', intended: false, vertexIndices: redundant, suggestion: { action: 'remove_vertices', elementId: r.el.id, vertexIndices: redundant } });
    }

    const now = fresh.get(r.el.id)?.points;
    if (now && bends(r.points) - bends(now) >= EXTRA_BENDS) add('ROUTE_EXCESS_BENDS', 'info', [r.el.id], box, 'The route has more bends than the router would draw now; re-routing it would simplify it.',
      { ...base, classification: 'excess_bends', intended: false, bends: bends(r.points), bendsIfRerouted: bends(now), suggestion: { action: 'reroute', elementId: r.el.id } });

    const ends = new Set([r.el.from.elementId, r.el.to.elementId].filter(Boolean));
    const level = r.el.level ?? 0;
    const close: Array<{ elementId: string; segment: number; gapPt: number }> = [];
    for (const other of shown) {
      if ((other.kind !== 'shape' && other.kind !== 'image') || ends.has(other.id)) continue;
      if (other.kind === 'shape' && (isLaneStructure(other) || other.routingPolicy?.obstacle === 'passThrough')) continue;
      if (passesBehind(other, level) || intendedCrossing(r.el, other, byId, pageArea)) continue;
      const b = visualBounds(other);
      let best: { segment: number; gapPt: number } | undefined;
      for (const run of r.runs) {
        if (run.axis === 'd') continue;
        const [lo, hi, near1, near2] = run.axis === 'h' ? [b.x, b.x + b.width, b.y, b.y + b.height] : [b.y, b.y + b.height, b.x, b.x + b.width];
        if (Math.min(run.hi, hi) - Math.max(run.lo, lo) < ALONGSIDE_PT) continue;
        const gap = run.coord <= near1 ? near1 - run.coord : run.coord >= near2 ? run.coord - near2 : -1; // -1: inside, which is a crossing
        if (gap >= 0 && gap < NEAR_PT && (!best || gap < best.gapPt)) best = { segment: run.index, gapPt: round(gap) };
      }
      if (best) close.push({ elementId: other.id, ...best });
    }
    if (close.length) {
      close.sort((a, b) => (a.elementId < b.elementId ? -1 : 1));
      const touching = close.some(c => c.gapPt <= 1);
      const runs = [...new Set(close.map(c => c.segment))].map(i => r.runs[i]!);
      add('ROUTE_TOO_CLOSE_TO_SHAPE', touching ? 'warning' : 'info', [r.el.id, ...close.map(c => c.elementId)], boxOf(runs.flatMap(s => [s.a, s.b]), 2), touching ? 'The route runs along the outline of a shape it is not attached to.' : 'The route runs very close beside a shape it is not attached to.',
        { ...base, classification: touching ? 'runs_on_outline' : 'tight_clearance', intended: false, shapes: close, suggestion: { action: 'move_run', elementId: r.el.id, segment: close[0]!.segment } });
    }
  }
}
