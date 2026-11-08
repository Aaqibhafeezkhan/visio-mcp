import type { Point } from '../contracts/generated';
import type { RouteMode } from './inspectRoutes';

export const OVERLAP_PT = 0.5;
export const NEAR_PT = 4;
export const ALONGSIDE_PT = 10;
export const SHORT_PT = 2;
/** Beautify's placement target; intentionally distinct from R26's 4 pt diagnostic threshold. */
export const TRACK_SPACING_PT = 6;

export interface RouteContactRoute {
  connectorId: string;
  points: readonly Point[];
  mode: RouteMode;
  joinConnectorIds: readonly string[];
  fromElementId?: string;
  toElementId?: string;
  joinedEnds?: readonly { connectorId: string; end: 'from' | 'to' }[];
}

export type RouteContactClassification = 'crossing' | 't_join' | 'endpoint_contact' | 'collinear_overlap' | 'collinear_shared_end' | 'parallel_near_miss';
export interface RouteContact {
  connectorIds: [string, string];
  segments: [number, number];
  classification: RouteContactClassification;
  branchId?: string;
  trunkId?: string;
  point?: Point;
  end?: 'from' | 'to';
  overlap?: { from: number; to: number; length: number; axis: 'h' | 'v'; at: number };
  gapPt?: number;
  alongsidePt?: number;
}

export interface RouteRun {
  index: number;
  a: Point;
  b: Point;
  axis: 'h' | 'v' | 'd';
  coord: number;
  lo: number;
  hi: number;
  length: number;
}

export function routeRuns(points: readonly Point[]): RouteRun[] {
  const out: RouteRun[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!, b = points[i + 1]!;
    const axis = Math.abs(a.y - b.y) <= 0.01 ? 'h' : Math.abs(a.x - b.x) <= 0.01 ? 'v' : 'd';
    const along = axis === 'v' ? [a.y, b.y] : [a.x, b.x];
    out.push({ index: i, a, b, axis, coord: axis === 'h' ? a.y : a.x, lo: Math.min(...along), hi: Math.max(...along), length: Math.hypot(b.x - a.x, b.y - a.y) });
  }
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100;
const point = (p: Point): Point => ({ x: round(p.x), y: round(p.y) });

function crossing(a: Point, b: Point, c: Point, d: Point, margin: number): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den, u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  const lr = Math.hypot(r.x, r.y), ls = Math.hypot(s.x, s.y);
  if (t * lr < margin || (1 - t) * lr < margin || u * ls < margin || (1 - u) * ls < margin) return null;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}

function endpointOnRun(p: Point, run: RouteRun): boolean {
  if (run.axis === 'd') return false;
  const across = run.axis === 'h' ? Math.abs(p.y - run.coord) : Math.abs(p.x - run.coord);
  const along = run.axis === 'h' ? p.x : p.y;
  return across <= OVERLAP_PT * 1.5 && along > run.lo + OVERLAP_PT && along < run.hi - OVERLAP_PT;
}

function cmp(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

/** Classifies geometric contacts between resolved connector routes, independent of editor or Visio rendering. */
export function classifyRouteContacts(routes: readonly RouteContactRoute[]): RouteContact[] {
  const ordered = [...routes].filter(r => r.points.length >= 2).sort((a, b) => cmp(a.connectorId, b.connectorId));
  const runs = new Map(ordered.map(r => [r.connectorId, routeRuns(r.points)]));
  const contacts: RouteContact[] = [];
  const emit = (a: RouteContactRoute, b: RouteContactRoute, first: number, second: number, classification: RouteContactClassification, extra: Partial<RouteContact> = {}) => {
    const aFirst = cmp(a.connectorId, b.connectorId) < 0;
    contacts.push({ connectorIds: aFirst ? [a.connectorId, b.connectorId] : [b.connectorId, a.connectorId], segments: aFirst ? [first, second] : [second, first], classification, ...extra });
  };

  for (let i = 0; i < ordered.length; i++) for (let j = i + 1; j < ordered.length; j++) {
    const A = ordered[i]!, B = ordered[j]!;
    if (A.mode === 'curved' || B.mode === 'curved') continue;
    const ar = runs.get(A.connectorId)!, br = runs.get(B.connectorId)!;
    const joined = A.joinConnectorIds.includes(B.connectorId) || B.joinConnectorIds.includes(A.connectorId);
    if (joined) {
      const joinEnds = [
        ...(A.joinedEnds?.filter(join => join.connectorId === B.connectorId).map(join => ({ ...join, branch: A, trunk: B })) ?? []),
        ...(B.joinedEnds?.filter(join => join.connectorId === A.connectorId).map(join => ({ ...join, branch: B, trunk: A })) ?? []),
      ];
      if (!A.joinedEnds && A.joinConnectorIds.includes(B.connectorId)) {
        for (const end of ['from', 'to'] as const) {
          const at = end === 'from' ? A.points[0]! : A.points[A.points.length - 1]!;
          if (br.some(run => endpointOnRun(at, run))) joinEnds.push({ connectorId: A.connectorId, end, branch: A, trunk: B });
        }
      }
      if (!B.joinedEnds && B.joinConnectorIds.includes(A.connectorId)) {
        for (const end of ['from', 'to'] as const) {
          const at = end === 'from' ? B.points[0]! : B.points[B.points.length - 1]!;
          if (ar.some(run => endpointOnRun(at, run))) joinEnds.push({ connectorId: B.connectorId, end, branch: B, trunk: A });
        }
      }
      for (const join of joinEnds) {
        const { branch, trunk } = join;
        const pointAt = join.end === 'from' ? branch.points[0]! : branch.points[branch.points.length - 1]!;
        const trunkRuns = runs.get(trunk.connectorId)!;
        const target = trunkRuns.find(run => endpointOnRun(pointAt, run));
        emit(branch, trunk, join.end === 'from' ? 0 : routeRuns(branch.points).length - 1, target?.index ?? -1, 't_join', { branchId: branch.connectorId, trunkId: trunk.connectorId, point: point(pointAt), end: join.end });
      }
      continue;
    }
    for (const ra of ar) for (const rb of br) {
      const at = crossing(ra.a, ra.b, rb.a, rb.b, OVERLAP_PT);
      if (at) emit(A, B, ra.index, rb.index, 'crossing', { point: point(at) });
    }
    for (const [X, Y, xr, yr] of [[A, B, ar, br], [B, A, br, ar]] as const) {
      for (const [end, at, index] of [['from', X.points[0]!, 0] as const, ['to', X.points[X.points.length - 1]!, xr.length - 1] as const]) {
        const target = yr.find(run => endpointOnRun(at, run));
        if (target) emit(X, Y, index, target.index, 'endpoint_contact', { point: point(at), end });
      }
    }

    let nearPt = 0, gapPt = Infinity, nearPair: { ra: RouteRun; rb: RouteRun } | undefined;
    for (const ra of ar) for (const rb of br) {
      if (ra.axis === 'd' || ra.axis !== rb.axis) continue;
      const from = Math.max(ra.lo, rb.lo), to = Math.min(ra.hi, rb.hi), gap = Math.abs(ra.coord - rb.coord);
      if (gap <= OVERLAP_PT && to - from >= 1) {
        const shared = Boolean(A.fromElementId && (A.fromElementId === B.fromElementId || A.fromElementId === B.toElementId) || A.toElementId && (A.toElementId === B.fromElementId || A.toElementId === B.toElementId));
        const classification = shared ? 'collinear_shared_end' : 'collinear_overlap';
        const contact: RouteContact = { connectorIds: [A.connectorId, B.connectorId], segments: [ra.index, rb.index], classification, overlap: { from: round(from), to: round(to), length: to - from, axis: ra.axis, at: round(ra.coord) } };
        contacts.push(contact);
      } else if (gap > OVERLAP_PT && gap < NEAR_PT && to - from >= ALONGSIDE_PT) {
        nearPt += to - from;
        if (gap < gapPt) { gapPt = gap; nearPair = { ra, rb }; }
      }
    }
    if (nearPair) emit(A, B, nearPair.ra.index, nearPair.rb.index, 'parallel_near_miss', { gapPt: round(gapPt), alongsidePt: round(nearPt) });
  }
  return contacts;
}
