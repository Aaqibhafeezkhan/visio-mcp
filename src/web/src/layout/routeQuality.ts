import type { V } from './orthogonalRoute';
import type { Rect } from './obstacleRoute';
import { ALONGSIDE_PT, classifyRouteContacts, NEAR_PT, OVERLAP_PT, TRACK_SPACING_PT } from './routeContacts';

export interface RouteQualityInput {
  route: readonly V[];
  previous?: readonly V[];
  otherRoutes: readonly { connectorId: string; points: readonly V[]; joinConnectorIds?: readonly string[] }[];
  labelRects: readonly Rect[];
  obstacleRects: readonly Rect[];
  crossingsPolicy: 'avoid' | 'allow';
}
export interface RouteQualityScore {
  policyCrossings: number;
  qualityPoints: number;
  terms: { routeLength: number; bends: number; overlap: number; nearMiss: number; labels: number; clearance: number; shortRuns: number; reversals: number; deviation: number };
}

const lengthOf = (points: readonly V[]) => points.slice(1).reduce((sum, p, i) => sum + Math.abs(p.x - points[i]!.x) + Math.abs(p.y - points[i]!.y), 0);
const horizontal = (a: V, b: V) => Math.abs(a.y - b.y) <= 0.01;
const intervalRuns = (points: readonly V[]) => points.slice(1).map((p, i) => {
  const a = points[i]!;
  return { axis: horizontal(a, p) ? 'h' as const : 'v' as const, coord: horizontal(a, p) ? a.y : a.x,
    lo: horizontal(a, p) ? Math.min(a.x, p.x) : Math.min(a.y, p.y), hi: horizontal(a, p) ? Math.max(a.x, p.x) : Math.max(a.y, p.y) };
});
function merged(points: readonly V[]) {
  const sorted = intervalRuns(points).filter(r => r.hi - r.lo > 1e-9).sort((a, b) => a.axis.localeCompare(b.axis) || a.coord - b.coord || a.lo - b.lo || a.hi - b.hi);
  const out: typeof sorted = [];
  for (const run of sorted) {
    const previous = out[out.length - 1];
    if (previous && previous.axis === run.axis && Math.abs(previous.coord - run.coord) < 0.01 && run.lo <= previous.hi + 1e-9) previous.hi = Math.max(previous.hi, run.hi);
    else out.push({ ...run });
  }
  return out;
}
function sharedLength(a: readonly V[], b: readonly V[]): number {
  let total = 0;
  for (const x of merged(a)) for (const y of merged(b)) {
    if (x.axis !== y.axis || Math.abs(x.coord - y.coord) >= 0.01) continue;
    total += Math.max(0, Math.min(x.hi, y.hi) - Math.max(x.lo, y.lo));
  }
  return total;
}
const deviation = (route: readonly V[], previous: readonly V[]) => Math.max(0, lengthOf(route) + lengthOf(previous) - 2 * sharedLength(route, previous));
function intersectsRect(a: V, b: V, rect: Rect): boolean {
  if (horizontal(a, b)) return a.y >= rect.y && a.y <= rect.y + rect.height && Math.max(Math.min(a.x, b.x), rect.x) <= Math.min(Math.max(a.x, b.x), rect.x + rect.width);
  return a.x >= rect.x && a.x <= rect.x + rect.width && Math.max(Math.min(a.y, b.y), rect.y) <= Math.min(Math.max(a.y, b.y), rect.y + rect.height);
}
function nearTrackDeficit(route: readonly V[], others: RouteQualityInput['otherRoutes']): number {
  let total = 0;
  const targetRuns = intervalRuns(route);
  for (const other of others) {
    const groups = new Map<string, { gap: number; intervals: Array<[number, number]> }>();
    for (const a of targetRuns) for (const b of intervalRuns(other.points)) {
      if (a.axis !== b.axis) continue;
      const gap = Math.abs(a.coord - b.coord), from = Math.max(a.lo, b.lo), to = Math.min(a.hi, b.hi);
      if (gap <= OVERLAP_PT || gap >= TRACK_SPACING_PT || to - from < ALONGSIDE_PT) continue;
      const low = Math.min(a.coord, b.coord), high = Math.max(a.coord, b.coord), key = `${a.axis}:${low}:${high}`;
      const group = groups.get(key) ?? { gap, intervals: [] };
      group.intervals.push([from, to]);
      groups.set(key, group);
    }
    for (const { gap, intervals } of groups.values()) {
      intervals.sort((x, y) => x[0] - y[0]);
      let from = -Infinity, to = -Infinity, runLength = 0;
      for (const [lo, hi] of intervals) {
        if (from === -Infinity) { from = lo; to = hi; }
        else if (lo > to) { runLength += to - from; from = lo; to = hi; }
        else to = Math.max(to, hi);
      }
      runLength += Math.max(0, to - from);
      total += (TRACK_SPACING_PT - gap) * runLength * 2;
    }
  }
  return total;
}
function clearanceCost(route: readonly V[], obstacles: readonly Rect[]): number {
  let total = 0;
  for (const rect of obstacles) {
    for (const run of intervalRuns(route)) {
      const from = Math.max(run.lo, run.axis === 'h' ? rect.x : rect.y);
      const to = Math.min(run.hi, run.axis === 'h' ? rect.x + rect.width : rect.y + rect.height);
      const alongside = Math.max(0, to - from);
      if (!alongside) continue;
      const low = run.axis === 'h' ? rect.y : rect.x, high = low + (run.axis === 'h' ? rect.height : rect.width);
      const gap = run.coord < low ? low - run.coord : run.coord > high ? run.coord - high : -1;
      if (gap >= 8 && gap <= 12) total += (12 - gap) ** 2 * alongside;
    }
  }
  return total;
}
function reversalCount(route: readonly V[]): number {
  const runs = intervalRuns(route);
  let count = 0;
  for (let i = 2; i < runs.length; i++) {
    const a = runs[i - 2]!, turn = runs[i - 1]!, b = runs[i]!;
    if (a.axis === b.axis && turn.axis !== a.axis) {
      const firstDelta = a.axis === 'h' ? route[i - 1]!.x - route[i - 2]!.x : route[i - 1]!.y - route[i - 2]!.y;
      const lastDelta = b.axis === 'h' ? route[i + 1]!.x - route[i]!.x : route[i + 1]!.y - route[i]!.y;
      if (Math.sign(firstDelta) !== Math.sign(lastDelta)) count++;
    }
  }
  return count;
}

/** Deterministic aesthetic score; policy crossings sort before quality points. */
export function scoreRoute(input: RouteQualityInput): RouteQualityScore {
  const route = input.route;
  const routeInput = { connectorId: '__candidate__', points: route, mode: 'automatic' as const, joinConnectorIds: [] };
  const contacts = classifyRouteContacts([routeInput, ...input.otherRoutes.map(other => ({ connectorId: other.connectorId, points: other.points, mode: 'automatic' as const, joinConnectorIds: other.joinConnectorIds ?? [] }))]);
  const candidateContacts = contacts.filter(c => c.connectorIds.includes(routeInput.connectorId));
  const uniqueCrossings = new Set(candidateContacts.filter(c => c.classification === 'crossing').map(c => `${c.connectorIds.join('|')}:${c.point?.x}:${c.point?.y}`));
  const overlap = candidateContacts.filter(c => c.classification === 'collinear_overlap' || c.classification === 'collinear_shared_end').reduce((sum, c) => sum + (c.overlap?.length ?? 0) * 20, 0);
  const labels = new Set(input.labelRects.flatMap((rect, index) => route.slice(1).some((p, i) => intersectsRect(route[i]!, p, rect)) ? [index] : [])).size * 500;
  const shortRuns = intervalRuns(route).reduce((sum, run) => sum + Math.max(0, 2 - (run.hi - run.lo)) * 20, 0);
  const reversals = reversalCount(route) * 100;
  const deviationCost = input.previous ? deviation(route, input.previous) * 0.1 : 0;
  const terms = {
    routeLength: lengthOf(route), bends: Math.max(0, route.length - 2) * 24, overlap, nearMiss: nearTrackDeficit(route, input.otherRoutes), labels,
    clearance: clearanceCost(route, input.obstacleRects), shortRuns, reversals, deviation: deviationCost,
  };
  const policyCrossings = input.crossingsPolicy === 'allow' ? 0 : uniqueCrossings.size;
  return { policyCrossings, qualityPoints: Object.values(terms).reduce((sum, value) => sum + value, 0), terms };
}

/** Exact symmetric changed run length used for hysteresis decisions. */
export function changedRunLength(route: readonly V[], previous: readonly V[]): number { return deviation(route, previous); }

export const ROUTE_IMPROVEMENT_HYSTERESIS = 48;
export function isAestheticImprovement(candidate: Pick<RouteQualityScore, 'policyCrossings' | 'qualityPoints'>, current: Pick<RouteQualityScore, 'policyCrossings' | 'qualityPoints'>): boolean {
  if (candidate.policyCrossings !== current.policyCrossings) return candidate.policyCrossings < current.policyCrossings;
  return current.qualityPoints - candidate.qualityPoints >= ROUTE_IMPROVEMENT_HYSTERESIS;
}
