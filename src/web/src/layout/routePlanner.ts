import type { Element, Layer } from '../contracts/generated';
import { centreOfTerminal, endFor, routeOrthogonal, type End, type Terminal, type V } from './orthogonalRoute';
import { avoidObstacles, blockedSegments, CLEARANCE, BUDGET, SPACING, STUB, inflate, isClear, search, segmentsOf, type Rect, type SearchStats, type Segment } from './obstacleRoute';
import { selectObstacles, visualRect } from './obstacles';
import { effectiveState } from '../canvas/cellMapping';
import { textRect } from './routingPolicy';
import { isAestheticImprovement, scoreRoute } from './routeQuality';
import { applyConstraints } from './routeSegments';
import type { RouteFinding } from '../contracts/generated';
import type { TextWidthMeasurer } from './textMeasurement';
import { measureTextBox } from './textMeasurement';

/**
 * The route planner (R19). Pure: the same elements, layers and previous routes always give the same routes, whichever surface asks
 * (live canvas, hidden projection, layout check, export, MCP).
 *
 * An edit must not re-route what it does not touch. For each automatic orthogonal connector, in connector id order (never z-order):
 *   1. keep  - the previous route, if its ends have not moved and it is still clear of the obstacles;
 *   2. elastic - the previous route with only its first and last runs moved to follow a moved end;
 *   3. repaired - a detour spliced in around the new obstacle, between the vertices either side of the blocked run;
 *   4. rerouted - the full search (R08b);
 *   5. unresolved - nothing clear was found: the best available route is returned and flagged, never reported as success.
 * Connectors with author waypoints are `authored`: their route is computed from the waypoints and never searched.
 */
type Connector = Extract<Element, { kind: 'connector' }>;
export type RouteProvenance = 'authored' | 'frozen' | 'kept' | 'elastic' | 'repaired' | 'rerouted' | 'unresolved' | 'beautified';
export interface PinnedEnd { x: number; y: number; perimeter: boolean }
export interface PlannedRoute {
  /** The whole route including both anchors. */
  points: V[];
  provenance: RouteProvenance;
  /** Why the route is not simply the previous one; absent for `kept` and `authored`. */
  reason?: string;
  fixed: { from?: PinnedEnd; to?: PinnedEnd };
  /** The ends the route was planned for, used to see whether an end has moved. */
  ends: { a: { anchor: V; dir: V }; b: { anchor: V; dir: V } };
}
export interface PlanInput {
  elements: readonly Element[];
  layers: readonly Layer[];
  pageArea: number;
  /** Routes planned earlier for this document; absent on a first load. */
  previous?: ReadonlyMap<string, PlannedRoute>;
  /** Shared canvas text measurement, used for protected text obstacles. */
  measureWidth?: TextWidthMeasurer;
  /** Only explicit Beautify supplies these options; omitted options preserve the R19 route plan. */
  beautifyTargets?: ReadonlySet<string>;
  costProfile?: 'legacy' | 'aesthetic';
  /** Document default is consumed only by explicit Beautify; an element policy still wins. */
  beautifyCrossingDefault?: 'avoid' | 'allow';
}
export interface RouteChange { id: string; provenance: RouteProvenance; reason?: string }
export interface PlanResult {
  routes: Map<string, PlannedRoute>;
  /** Connectors whose route differs from `previous` (or that had none), with why. */
  changes: RouteChange[];
  routeFindings: RouteFinding[];
  aestheticStats?: Map<string, SearchStats>;
}

const EPS = 1e-6;
const SIDE = new Set(['0.5,0', '0.5,1', '0,0.5', '1,0.5']);
const same = (p: V, q: V): boolean => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;
/** Stored routes are rounded, so "the same place" for a stored route is a hundredth of a point. */
export const STORED_TOLERANCE = 0.01;
const near = (p: V, q: V): boolean => Math.abs(p.x - q.x) < STORED_TOLERANCE && Math.abs(p.y - q.y) < STORED_TOLERANCE;
const horizontalSeg = (p: V, q: V): boolean => Math.abs(p.y - q.y) < EPS;
const dot = (p: V, q: V): number => p.x * q.x + p.y * q.y;
const dirOf = (p: V, q: V): V => ({ x: Math.sign(q.x - p.x), y: Math.sign(q.y - p.y) });

function tidy(points: V[]): V[] {
  const out: V[] = [];
  for (const p of points) if (!out.length || !same(out[out.length - 1]!, p)) out.push(p);
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]!, b = out[i]!, c = out[i + 1]!;
    if ((Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS) || (Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS)) out.splice(i, 1);
  }
  return out;
}

/** What is wrong with a route as a committed orthogonal path; empty when it is exact. */
export function routeDefects(points: readonly V[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!, q = points[i]!;
    if (same(p, q)) out.push(`zero-length segment ${i - 1}`);
    else if (Math.abs(p.x - q.x) > EPS && Math.abs(p.y - q.y) > EPS) out.push(`diagonal segment ${i - 1}`);
    else if (i > 1) {
      const o = points[i - 2]!;
      if ((Math.abs(o.x - p.x) < EPS && Math.abs(p.x - q.x) < EPS) || (Math.abs(o.y - p.y) < EPS && Math.abs(p.y - q.y) < EPS)) out.push(`redundant vertex ${i - 1}`);
    }
  }
  return out;
}

/** The previous route with its first and last runs moved to the new anchors; interior tracks stay. Undefined when it cannot be adapted. */
function elastic(prev: readonly V[], a: End, b: End): V[] | undefined {
  const n = prev.length;
  if (n < 2) return undefined;
  if (n === 2) { // a straight run whose ends are no longer aligned takes one short jog, half way along
    const h = horizontalSeg(prev[0]!, prev[1]!);
    const A = a.anchor, B = b.anchor, mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
    const jog = tidy(h ? [A, { x: mx, y: A.y }, { x: mx, y: B.y }, B] : [A, { x: A.x, y: my }, { x: B.x, y: my }, B]);
    return dot(dirOf(jog[0]!, jog[1]!), a.dir) > 0 && dot(dirOf(jog[jog.length - 1]!, jog[jog.length - 2]!), b.dir) > 0 && !routeDefects(jog).length ? jog : undefined;
  }
  const r = prev.map(p => ({ ...p }));
  r[0] = { ...a.anchor }; r[n - 1] = { ...b.anchor };
  if (horizontalSeg(prev[0]!, prev[1]!)) r[1]!.y = a.anchor.y; else r[1]!.x = a.anchor.x;
  if (horizontalSeg(prev[n - 2]!, prev[n - 1]!)) r[n - 2]!.y = b.anchor.y; else r[n - 2]!.x = b.anchor.x;
  if (dot(dirOf(r[0]!, r[1]!), a.dir) <= 0 || dot(dirOf(r[n - 1]!, r[n - 2]!), b.dir) <= 0) return undefined;
  const out = tidy(r);
  return routeDefects(out).length ? undefined : out;
}

interface Work {
  el: Connector;
  a: End; b: End;
  base: V[];
  endRects: Rect[];
  others: Rect[];
  soft: Rect[];
  obstacleIds: Map<string, string[]>;
  shapeRects: Rect[];
}

const lengthOf = (r: readonly V[]): number => r.slice(1).reduce((n, p, i) => n + Math.abs(p.x - r[i]!.x) + Math.abs(p.y - r[i]!.y), 0);
/** Hysteresis has a limit: a previous route is dropped only when the clear default route is shorter by more than this (two turns' worth). */
const STRAIGHTEN_GAIN = 48;
const detourPays = (candidate: readonly V[], w: Work): boolean =>
  lengthOf(candidate) - lengthOf(w.base) > STRAIGHTEN_GAIN && isClear(w.base, w.others, w.endRects, CLEARANCE);

const pin = (e: End): PinnedEnd | undefined => (e.fraction ? { x: e.fraction.x, y: e.fraction.y, perimeter: SIDE.has(`${e.fraction.x},${e.fraction.y}`) } : undefined);

/** Detours around the blocked run only, keeping the vertices either side; undefined if that is not possible. */
function repair(route: readonly V[], w: Work, occupied: readonly Segment[]): V[] | undefined {
  const bad = blockedSegments(route, w.others, w.endRects, CLEARANCE);
  if (!bad.length) return undefined;
  const n = route.length;
  const lo = bad[0]!, hi = bad[bad.length - 1]! + 1;
  const blockers = [...w.others, ...w.endRects].map(r => inflate(r, CLEARANCE));
  const inside = (p: V) => blockers.some(r => p.x > r.x + EPS && p.x < r.x + r.width - EPS && p.y > r.y + EPS && p.y < r.y + r.height - EPS);
  // an end run is searched from just outside its shape, as the full search does; the vertices either side of the rest stay
  const stubOf = (e: End): V => ({ x: e.anchor.x + e.dir.x * STUB, y: e.anchor.y + e.dir.y * STUB });
  const start = lo === 0 ? stubOf(w.a) : route[lo]!, into = lo === 0 ? w.a.dir : dirOf(route[lo - 1]!, route[lo]!);
  const goal = hi === n - 1 ? stubOf(w.b) : route[hi]!, goalDir = hi === n - 1 ? w.b.dir : (() => { const o = dirOf(route[hi]!, route[hi + 1]!); return { x: -o.x, y: -o.y }; })();
  if (inside(start) || inside(goal)) return undefined;
  const path = search(start, into, goal, goalDir, blockers, occupied, SPACING, BUDGET);
  if (!path) return undefined;
  const next = tidy([...(lo === 0 ? [route[0]!] : route.slice(0, lo)), ...path, ...(hi === n - 1 ? [route[n - 1]!] : route.slice(hi + 1))]);
  return routeDefects(next).length || !isClear(next, w.others, w.endRects, CLEARANCE) ? undefined : next;
}

/** The route stored on a connector (R20), as the planner's memory of it. Absent when there is none. */
export function storedRoute(el: Connector): PlannedRoute | undefined {
  const pts = el.routing?.advisory;
  if (!pts || pts.length < 2) return undefined;
  const points = pts.map(p => ({ x: p.x, y: p.y }));
  const n = points.length;
  return {
    points, provenance: el.routing?.mode === 'frozen' ? 'frozen' : el.routing?.beautified ? 'beautified' : 'kept', fixed: {},
    ends: { a: { anchor: points[0]!, dir: dirOf(points[0]!, points[1]!) }, b: { anchor: points[n - 1]!, dir: dirOf(points[n - 1]!, points[n - 2]!) } },
  };
}
export const isFrozen = (el: Connector): boolean => el.routing?.mode === 'frozen';

export function planRoutes(input: PlanInput): PlanResult {
  const byId = new Map(input.elements.map(e => [e.id, e]));
  const terminal = (ep: Connector['from']): Terminal | undefined => {
    const t = ep.glue !== 'none' && ep.elementId ? byId.get(ep.elementId) : undefined;
    if (!t || t.kind === 'connector' || t.kind === 'group') return undefined;
    return { box: t.bounds, rotationDeg: t.rotationDeg, ports: t.kind === 'shape' ? t.ports : undefined };
  };
  const connectors = input.elements.filter((e): e is Connector => e.kind === 'connector' && e.route === 'orthogonal').sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // Protected connector labels use the same measured text metrics and normalized path anchor as the canvas.
  const connectorLabelRects = new Map<string, Rect>();
  for (const c of connectors) {
    if (!c.label) continue;
    const ta = terminal(c.from), tb = terminal(c.to);
    const a = endFor(c.from, ta, c.to.point ?? (tb ? centreOfTerminal(tb) : { x: 0, y: 0 }));
    const b = endFor(c.to, tb, c.from.point ?? (ta ? centreOfTerminal(ta) : { x: 0, y: 0 }));
    const route = routeOrthogonal(a, b, c.waypoints.map(p => ({ x: p.x, y: p.y })));
    const measure = measureTextBox(c.label, 1_000_000, 10_000, input.measureWidth ?? ((value, font) => value.length * font.sizePt * 0.5));
    const total = route.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - route[i]!.x) + Math.abs(p.y - route[i]!.y), 0);
    let distance = total * (c.labelAnchor?.position ?? 0.5), anchor = route[0]!, tangent: V = { x: 1, y: 0 };
    for (let i = 1; i < route.length; i++) {
      const p = route[i - 1]!, q = route[i]!, len = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      if (distance <= len || i === route.length - 1) { const sign = Math.sign(q.x - p.x || q.y - p.y) || 1; tangent = Math.abs(q.x - p.x) >= Math.abs(q.y - p.y) ? { x: sign, y: 0 } : { x: 0, y: sign }; anchor = { x: p.x + tangent.x * Math.min(distance, len), y: p.y + tangent.y * Math.min(distance, len) }; break; }
      distance -= len;
    }
    const offset = c.labelAnchor?.offsetPt ?? 0;
    anchor = { x: anchor.x - tangent.y * offset, y: anchor.y + tangent.x * offset };
    const width = Math.max(measure.contentWidthPt, 1), height = Math.max(measure.contentHeightPt, c.label.fontSizePt * 1.2);
    connectorLabelRects.set(c.id, { x: anchor.x - width / 2, y: anchor.y - height / 2, width, height });
  }
  const measuredLabelRects = new Map<string, Rect>();
  for (const c of connectors) if (c.label && effectiveState(c, input.layers).visible) {
    const rect = connectorLabelRects.get(c.id);
    if (rect) measuredLabelRects.set(c.id, rect);
  }
  for (const el of input.elements) {
    if ((el.kind !== 'shape' && el.kind !== 'text') || !el.text || !effectiveState(el, input.layers).visible) continue;
    const rect = textRect(el, el.text, input.measureWidth ?? ((value, font) => value.length * font.sizePt * 0.5));
    if (rect) measuredLabelRects.set(el.id, rect);
  }

  const work: Work[] = connectors.map(el => {
    const ta = terminal(el.from), tb = terminal(el.to);
    const pointOf = (t: Terminal | undefined, ep: Connector['from']) => (t ? centreOfTerminal(t) : ep.point ?? { x: 0, y: 0 });
    const wp = el.waypoints.map(p => ({ x: p.x, y: p.y }));
    const a = endFor(el.from, ta, wp[0] ?? pointOf(tb, el.to));
    const b = endFor(el.to, tb, wp[wp.length - 1] ?? pointOf(ta, el.from));
    const endIds = new Set([el.from.elementId, el.to.elementId].filter((id): id is string => !!id));
    const endRects = [ta, tb].filter((t): t is Terminal => !!t).map(t => visualRect({ bounds: t.box, rotationDeg: t.rotationDeg }));
    const free = [el.from, el.to].filter(ep => ep.glue === 'none' && ep.point).map(ep => ep.point!);
    const records = wp.length ? [] : selectObstacles(input.elements, input.layers, endIds, endRects, free, input.pageArea, input.measureWidth, el.id, connectorLabelRects);
    const adjusted = records.map(o => {
      const obstacle = byId.get(o.id);
      const stroke = obstacle && 'style' in obstacle && 'strokeWidthPt' in obstacle.style ? Number(obstacle.style.strokeWidthPt) / 2 : 0;
      // The router supplies its normal 8pt clearance; apply only the policy delta and visible half-stroke here.
      return { ...o, rect: inflate(o.rect, Math.max(0, o.clearancePt - CLEARANCE) + stroke) };
    });
    // Endpoint shapes are represented by endRects; only their glue stubs may cross them.
    const hard = adjusted.filter(o => o.policy === 'forbidden' && !endIds.has(o.id));
    const soft = adjusted.filter(o => o.policy === 'avoid' && !endIds.has(o.id));
    const obstacleIds = new Map<string, string[]>();
    for (const o of adjusted) {
      const key = `${o.rect.x},${o.rect.y},${o.rect.width},${o.rect.height}`;
      obstacleIds.set(key, [...(obstacleIds.get(key) ?? []), o.id]);
    }
    const shapeRects = adjusted.filter(o => o.source === 'element').flatMap(o => {
      const element = byId.get(o.id);
      return element && (element.kind === 'shape' || element.kind === 'image') && !endIds.has(o.id) ? [visualRect(element)] : [];
    });
    return { el, a, b, base: routeOrthogonal(a, b, wp), endRects,
      others: hard.map(o => o.rect), soft: soft.map(o => o.rect), obstacleIds, shapeRects };
  });

  const routes = new Map<string, PlannedRoute>();
  const relaxedSideIds = new Set<string>();
  const requiredSideFailed = new Set<string>();
  const occupied: Segment[] = [];
  const make = (w: Work, points: V[], provenance: RouteProvenance, reason?: string): PlannedRoute => ({
    points, provenance, ...(reason ? { reason } : {}), fixed: { from: pin(w.a), to: pin(w.b) },
    ends: { a: { anchor: w.a.anchor, dir: w.a.dir }, b: { anchor: w.b.anchor, dir: w.b.dir } },
  });
  /** A frozen route is the stored one. Only its end runs may move, and only to keep the glue; otherwise it stays and is flagged. */
  const frozenRoute = (w: Work, stored: PlannedRoute | undefined): PlannedRoute => {
    if (!stored) return make(w, w.base, 'unresolved', 'a frozen route has no stored route');
    const moved = !near(stored.ends.a.anchor, w.a.anchor) || !near(stored.ends.b.anchor, w.b.anchor) || !same(stored.ends.a.dir, w.a.dir) || !same(stored.ends.b.dir, w.b.dir);
    if (!moved) {
      return isClear(stored.points, w.others, w.endRects, CLEARANCE)
        ? make(w, stored.points, 'frozen')
        : make(w, stored.points, 'unresolved', 'a frozen route crosses a hard obstacle, so it was kept as stored');
    }
    const follow = elastic(stored.points, w.a, w.b);
    const newlyBlocked = !!follow && w.others.some(obstacle =>
      isClear(stored.points, [obstacle], [], CLEARANCE) && !isClear(follow, [obstacle], [], CLEARANCE));
    const safe = follow && !newlyBlocked && isClear(follow, [], w.endRects, CLEARANCE);
    if (!safe) return make(w, stored.points, 'unresolved', 'a frozen route cannot follow the moved end safely, so it was kept as stored');
    const stillBlocked = !isClear(follow, w.others, w.endRects, CLEARANCE);
    return stillBlocked
      ? make(w, follow, 'unresolved', 'a frozen route follows the moved end but still crosses a hard obstacle')
      : make(w, follow, 'frozen', 'an end moved; only its end run followed');
  };
  const put = (w: Work, r: PlannedRoute) => { routes.set(w.el.id, r); occupied.push(...segmentsOf(r.points, w.el.id)); };

  /**
   * Guided routes (R21): the router draws the route as for an automatic connector, then holds each pinned run where it was put. If a
   * held run cannot stay there (it no longer exists, would cross an obstacle, or would change how the route leaves a port), the route
   * is left as drawn and flagged unresolved rather than moved somewhere the person did not choose.
   */
  const guide = (w: Work, r: PlannedRoute): PlannedRoute => {
    const held = w.el.routing?.constraints;
    if (!held?.length || r.provenance === 'unresolved') return r;
    const out = applyConstraints(r.points, held);
    const moved = out.points.length !== r.points.length || out.points.some((p, i) => !near(p, r.points[i]!));
    if (out.unmet.length) return make(w, r.points, 'unresolved', 'a pinned run no longer exists on this route');
    if (!moved) return r;
    const n = out.points.length;
    const leaves = same(dirOf(out.points[0]!, out.points[1]!), w.a.dir) && same(dirOf(out.points[n - 1]!, out.points[n - 2]!), w.b.dir);
    if (routeDefects(out.points).length || !leaves || !isClear(out.points, w.others, w.endRects, 2)) return make(w, r.points, 'unresolved', 'a pinned run cannot be held there without crossing something');
    return make(w, out.points, r.provenance === 'kept' ? 'repaired' : r.provenance, 'a pinned run was held');
  };

  // Authored and frozen routes are fixed: they claim their tracks first.
  for (const w of work) {
    if (isFrozen(w.el)) put(w, frozenRoute(w, storedRoute(w.el)));
    else if (w.el.waypoints.length) put(w, make(w, w.base, 'authored'));
  }

  // Routes that survive (kept or elastic) claim theirs next, so only the connectors that need it are searched.
  const pending: Array<{ w: Work; candidate?: V[]; why: string }> = [];
  for (const w of work) {
    if (w.el.waypoints.length || isFrozen(w.el)) continue;
    const prev = storedRoute(w.el) ?? input.previous?.get(w.el.id);
    if (!prev || prev.provenance === 'authored') { pending.push({ w, why: 'no previous route' }); continue; }
    const unmoved = near(prev.ends.a.anchor, w.a.anchor) && near(prev.ends.b.anchor, w.b.anchor) && same(prev.ends.a.dir, w.a.dir) && same(prev.ends.b.dir, w.b.dir);
    const candidate = unmoved ? [...prev.points] : elastic(prev.points, w.a, w.b);
    if (!candidate) { pending.push({ w, why: 'an end moved and the old route cannot follow it' }); continue; }
    if (isClear(candidate, [...w.others, ...w.soft], w.endRects, CLEARANCE) && !(prev.provenance !== 'beautified' && detourPays(candidate, w))) put(w, guide(w, make(w, candidate, unmoved ? prev.provenance === 'beautified' ? 'beautified' : 'kept' : 'elastic', unmoved ? undefined : 'an end moved')));
    else if (!isClear(candidate, w.others, w.endRects, CLEARANCE)) pending.push({ w, candidate, why: 'an obstacle is now in the way' });
    else pending.push({ w, why: 'the obstacle that forced a detour is gone and the direct route is much shorter' });
  }

  for (const { w, candidate, why } of pending) {
    const fixed = candidate && repair(candidate, w, occupied);
    if (fixed) { put(w, guide(w, make(w, fixed, 'repaired', why))); continue; }
    const strict = avoidObstacles(w.a, w.b, w.base, [...w.others, ...w.soft], w.endRects, occupied);
    if (!strict.blocked) { put(w, guide(w, make(w, strict.route, 'rerouted', why))); continue; }
    // A preferred side is a hint. If its constrained route fails, retry using the automatic side before relaxing soft obstacles.
    const hasPreference = (w.el.from.glue === 'dynamic' && !!w.el.from.preferredSide) || (w.el.to.glue === 'dynamic' && !!w.el.to.preferredSide);
    if (hasPreference && !w.el.waypoints.length) {
      const ta = terminal(w.el.from), tb = terminal(w.el.to);
      const pointOf = (t: Terminal | undefined, ep: Connector['from']) => (t ? centreOfTerminal(t) : ep.point ?? { x: 0, y: 0 });
      const autoA = endFor({ ...w.el.from, preferredSide: undefined }, ta, pointOf(tb, w.el.to));
      const autoB = endFor({ ...w.el.to, preferredSide: undefined }, tb, pointOf(ta, w.el.from));
      const autoBase = routeOrthogonal(autoA, autoB, []);
      const auto = avoidObstacles(autoA, autoB, autoBase, [...w.others, ...w.soft], w.endRects, occupied);
      const autoRelaxed = auto.blocked && w.soft.length ? avoidObstacles(autoA, autoB, autoBase, w.others, w.endRects, occupied) : auto;
      if (!autoRelaxed.blocked) {
        w.a = autoA; w.b = autoB; w.base = autoBase; relaxedSideIds.add(w.el.id);
        put(w, guide(w, make(w, autoRelaxed.route, 'rerouted', 'the preferred side had no clear route; the automatic side was used')));
        continue;
      }
    }
    // Avoid-policy obstacles are soft: retry once with only forbidden blockers before declaring failure.
    const relaxed = w.soft.length ? avoidObstacles(w.a, w.b, w.base, w.others, w.endRects, occupied) : strict;
    if (relaxed.blocked) {
      const hasRequiredSide = !!w.el.from.requiredSide || !!w.el.to.requiredSide;
      if (hasRequiredSide) {
        const withoutRequired = (ep: Connector['from']): Connector['from'] => ({ ...ep, requiredSide: undefined });
        const from = withoutRequired(w.el.from), to = withoutRequired(w.el.to);
        const ta = terminal(from), tb = terminal(to);
        const pointOf = (t: Terminal | undefined, ep: Connector['from']) => (t ? centreOfTerminal(t) : ep.point ?? { x: 0, y: 0 });
        const autoA = endFor(from, ta, pointOf(tb, to)), autoB = endFor(to, tb, pointOf(ta, from));
        const autoBase = routeOrthogonal(autoA, autoB, []);
        const withoutSide = avoidObstacles(autoA, autoB, autoBase, w.others, w.endRects, occupied);
        if (!withoutSide.blocked) requiredSideFailed.add(w.el.id);
      }
      put(w, make(w, candidate ?? relaxed.route, 'unresolved', 'no clear route was found'));
    } else put(w, guide(w, make(w, relaxed.route, 'rerouted', why)));
  }

  const aestheticStats = new Map<string, SearchStats>();
  if (input.costProfile === 'aesthetic' && input.beautifyTargets?.size) {
    const targetWork = work.filter(w => input.beautifyTargets!.has(w.el.id) && !w.el.waypoints.length && !w.el.routing?.constraints?.length && !isFrozen(w.el) && !w.el.locked);
    const difficulty = (w: Work) => blockedSegments(w.base, [...w.others, ...w.soft], w.endRects, CLEARANCE).length;
    const span = (w: Work) => Math.abs(w.a.anchor.x - w.b.anchor.x) + Math.abs(w.a.anchor.y - w.b.anchor.y);
    targetWork.sort((a, b) => {
      const ap = (a.el as unknown as { routingPolicy?: { priority?: number } }).routingPolicy?.priority ?? 0;
      const bp = (b.el as unknown as { routingPolicy?: { priority?: number } }).routingPolicy?.priority ?? 0;
      return bp - ap || difficulty(b) - difficulty(a) || span(b) - span(a) || (a.el.id < b.el.id ? -1 : a.el.id > b.el.id ? 1 : 0);
    });
    const workById = new Map(work.map(w => [w.el.id, w]));
    for (const w of targetWork) {
      const current = routes.get(w.el.id);
      if (!current) continue;
      const otherRoutes = [...routes].filter(([id]) => id !== w.el.id).map(([connectorId, route]) => ({
        connectorId, points: route.points,
        joinConnectorIds: workById.get(connectorId) ? [workById.get(connectorId)!.el.from.join?.connectorId, workById.get(connectorId)!.el.to.join?.connectorId].filter((id): id is string => Boolean(id)) : [],
      }));
      const labels = [...measuredLabelRects].filter(([id]) => id !== w.el.id).map(([, rect]) => rect);
      const policy = (w.el as unknown as { routingPolicy?: { crossing?: 'avoid' | 'allow' } }).routingPolicy?.crossing ?? input.beautifyCrossingDefault ?? 'avoid';
      const previousRoute = storedRoute(w.el)?.points ?? current.points;
      const currentScore = scoreRoute({ route: current.points, previous: previousRoute, otherRoutes, labelRects: labels, obstacleRects: w.shapeRects, crossingsPolicy: policy });
      const minimumQuality = lengthOf(current.points) + 24 * Math.max(0, current.points.length - 2);
      const isOrdinaryBase = current.points.length === w.base.length && current.points.every((point, index) => same(point, w.base[index]!));
      // A clear ordinary route with no aesthetic defect already has the baseline length and bend
      // cost. Re-search only routes whose measured score shows a concrete quality opportunity.
      if (isOrdinaryBase && currentScore.policyCrossings === 0
        && currentScore.qualityPoints <= minimumQuality + EPS
        && isClear(current.points, [...w.others, ...w.soft], w.endRects, CLEARANCE)) {
        aestheticStats.set(w.el.id, { expandedStates: 0, gridCells: 0, peakMemoryBytes: 0 });
        continue;
      }
      const stats: SearchStats = { expandedStates: 0, gridCells: 0, peakMemoryBytes: 0 };
      aestheticStats.set(w.el.id, stats);
      const options = { search: { profile: 'aesthetic' as const, crossingsPolicy: policy, previous: current.points, labelRects: labels,
        joinConnectorIds: [w.el.from.join?.connectorId, w.el.to.join?.connectorId].filter((id): id is string => Boolean(id)), stats } };
      let candidate = avoidObstacles(w.a, w.b, w.base, [...w.others, ...w.soft], w.endRects, otherRoutes.flatMap(r => segmentsOf(r.points, r.connectorId)), options);
      if (!candidate.rerouted || candidate.blocked) continue;
      const score = scoreRoute({ route: candidate.route, previous: previousRoute, otherRoutes, labelRects: labels, obstacleRects: w.shapeRects, crossingsPolicy: policy });
      if (!isAestheticImprovement(score, currentScore)) continue;
      const { reason: _reason, ...retained } = current;
      routes.set(w.el.id, { ...retained, points: candidate.route, provenance: 'beautified' });
    }
  }

  const changes: RouteChange[] = [];
  const routeFindings: RouteFinding[] = [];
  for (const w of work) {
    const now = routes.get(w.el.id)!, was = storedRoute(w.el) ?? input.previous?.get(w.el.id);
    const moved = !was || was.points.length !== now.points.length || now.points.some((p, i) => !near(p, was.points[i]!));
    if (moved || now.provenance === 'unresolved') changes.push({ id: w.el.id, provenance: now.provenance, ...(now.reason ? { reason: now.reason } : {}) });
    const blockers = (rects: Rect[]) => [...new Set(blockedSegments(now.points, rects, [], CLEARANCE).flatMap(index => {
      const a = now.points[index]!, b = now.points[index + 1]!;
      return rects.filter(r => !isClear([a, b], [r], [], CLEARANCE)).flatMap(r => w.obstacleIds.get(`${r.x},${r.y},${r.width},${r.height}`) ?? []);
    }))].sort();
    if (now.provenance === 'unresolved') {
      const hasRequiredSide = requiredSideFailed.has(w.el.id);
      routeFindings.push({
        code: hasRequiredSide ? 'ROUTE_REQUIRED_SIDE_UNRESOLVED' : 'UNRESOLVED_ROUTE', severity: 'error',
        message: hasRequiredSide ? 'The required endpoint side could not be routed without violating hard constraints' : now.reason ?? 'No clear route was found',
        elementId: w.el.id, blockerIds: blockers(w.others),
      });
    }
    if (relaxedSideIds.has(w.el.id)) routeFindings.push({ code: 'ROUTE_SIDE_PREFERENCE_RELAXED', severity: 'info', message: 'The preferred endpoint side had no clear route; the automatic side was used', elementId: w.el.id });
    const softIds = blockers(w.soft);
    if (softIds.length) routeFindings.push({ code: 'ROUTING_AVOIDANCE_VIOLATION', severity: 'warning', message: 'The route crosses one or more avoid-policy obstacles because no clear route was found', elementId: w.el.id, blockerIds: softIds });
  }
  return { routes, changes, routeFindings, ...(aestheticStats.size ? { aestheticStats } : {}) };
}
