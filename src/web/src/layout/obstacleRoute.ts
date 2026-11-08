import type { End, V } from './orthogonalRoute';
import { TRACK_SPACING_PT } from './routeContacts';

/**
 * Obstacle-aware orthogonal routing (R08b). Pure geometry in page points, y down.
 *
 * Policy:
 * - The route from orthogonalRoute.ts is kept when it is clear. Only a blocked route is searched again.
 * - Obstacles are inflated by CLEARANCE. The two end shapes are obstacles too, except for the stub that leaves or enters them.
 * - Explicit waypoints are never rerouted: the caller does not call this when the author supplied any.
 * - Routes are made one after another; a later route pays a penalty for running along an earlier one, and the search can use a
 *   track SPACING beside each obstacle edge, so parallel connectors fan out instead of overprinting.
 * - If no clear route exists, or the search budget runs out, the result is the unchanged base route with `blocked: true`. That
 *   outcome is deterministic for a given input, and the layout check already reports the crossing.
 */
export interface Rect { x: number; y: number; width: number; height: number }
export interface Segment { a: V; b: V; ownerId?: string }
export interface SearchStats { expandedStates: number; gridCells: number; peakMemoryBytes: number }
export interface SearchOptions { profile?: 'aesthetic'; crossingsPolicy?: 'avoid' | 'allow'; previous?: readonly V[]; labelRects?: readonly Rect[]; joinConnectorIds?: readonly string[]; stats?: SearchStats }
export interface AvoidOptions { clearance?: number; spacing?: number; stub?: number; budget?: number; search?: SearchOptions }
export interface AvoidResult { route: V[]; blocked: boolean; rerouted: boolean }

export const CLEARANCE = 8;
export const SPACING = 6;
export const STUB = 12;
export const BUDGET = 80_000;
const TURN = 24;
const SHARED = 1; // extra cost per point of overlap with an earlier route
const EPS = 1e-6;

function lowerBound(values: readonly number[], value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid]! < value) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBound(values: readonly number[], value: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid]! <= value) lo = mid + 1; else hi = mid; }
  return lo;
}

export const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, width: r.width + 2 * d, height: r.height + 2 * d });

/** Whether an axis-aligned segment passes through the open interior of a rectangle. */
function crosses(a: V, b: V, r: Rect): boolean {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x), y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  return x2 > r.x + EPS && x1 < r.x + r.width - EPS && y2 > r.y + EPS && y1 < r.y + r.height - EPS
    && (Math.abs(a.x - b.x) < EPS ? a.x > r.x + EPS && a.x < r.x + r.width - EPS : a.y > r.y + EPS && a.y < r.y + r.height - EPS);
}

/** Total length of a route that runs along (collinear with and overlapping) earlier segments. */
function sharedLength(a: V, b: V, occupied: readonly Segment[]): number {
  let n = 0;
  const horizontal = Math.abs(a.y - b.y) < EPS;
  for (const s of occupied) {
    if (horizontal) {
      if (Math.abs(s.a.y - a.y) > 0.5 || Math.abs(s.b.y - a.y) > 0.5) continue;
      n += Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(s.a.x, s.b.x)) - Math.max(Math.min(a.x, b.x), Math.min(s.a.x, s.b.x)));
    } else {
      if (Math.abs(s.a.x - a.x) > 0.5 || Math.abs(s.b.x - a.x) > 0.5) continue;
      n += Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(s.a.y, s.b.y)) - Math.max(Math.min(a.y, b.y), Math.min(s.a.y, s.b.y)));
    }
  }
  return n;
}

/** The segments of a polyline, for recording as occupied once a connector is routed. */
export const segmentsOf = (route: readonly V[], ownerId?: string): Segment[] => route.slice(1).map((p, i) => ({ a: route[i]!, b: p, ...(ownerId ? { ownerId } : {}) }));

export function isClear(route: readonly V[], others: readonly Rect[], ends: readonly Rect[], pad: number): boolean {
  const inflatedOthers = others.map(r => inflate(r, pad)), inflatedEnds = ends.map(r => inflate(r, pad));
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    if (inflatedOthers.some(r => crosses(a, b, r))) return false;
    // the first and last segments touch their own shape; only the middle ones must stay off the end shapes
    if (i > 1 && i < route.length - 1 && inflatedEnds.some(r => crosses(a, b, r))) return false;
  }
  return true;
}

/** Indices of the segments of `route` that pass through an obstacle inflated by `pad`; the first and last may touch their own shapes. */
export function blockedSegments(route: readonly V[], others: readonly Rect[], ends: readonly Rect[], pad: number): number[] {
  const inflatedOthers = others.map(r => inflate(r, pad)), inflatedEnds = ends.map(r => inflate(r, pad));
  const out: number[] = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    if (inflatedOthers.some(r => crosses(a, b, r)) || (i > 1 && i < route.length - 1 && inflatedEnds.some(r => crosses(a, b, r)))) out.push(i - 1);
  }
  return out;
}

const DIRS: V[] = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];

class Heap {
  private h: Array<{ f: number; seq: number; id: number }> = [];
  private seq = 0;
  get size(): number { return this.h.length; }
  push(f: number, id: number): void {
    const n = { f, seq: this.seq++, id }; const h = this.h; h.push(n);
    let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.less(h[i]!, h[p]!)) { [h[i], h[p]] = [h[p]!, h[i]!]; i = p; } else break; }
  }
  pop(): { f: number; id: number } {
    const h = this.h, top = h[0]!, last = h.pop()!;
    if (h.length) {
      h[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!]; i = m;
      }
    }
    return top;
  }
  private less(a: { f: number; seq: number }, b: { f: number; seq: number }): boolean { return a.f < b.f || (a.f === b.f && a.seq < b.seq); }
}

class AestheticHeap {
  private h: Array<{ crossings: number; f: number; seq: number; id: number }> = [];
  private seq = 0;
  get size(): number { return this.h.length; }
  push(crossings: number, f: number, id: number): void {
    const n = { crossings, f, seq: this.seq++, id }, h = this.h; h.push(n);
    let i = h.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.less(h[i]!, h[p]!)) { [h[i], h[p]] = [h[p]!, h[i]!]; i = p; } else break; }
  }
  pop(): { crossings: number; f: number; id: number } {
    const h = this.h, top = h[0]!, last = h.pop()!;
    if (h.length) {
      h[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!]; i = m;
      }
    }
    return top;
  }
  private less(a: { crossings: number; f: number; seq: number }, b: { crossings: number; f: number; seq: number }): boolean {
    return a.crossings < b.crossings || (a.crossings === b.crossings && (a.f < b.f || (a.f === b.f && a.seq < b.seq)));
  }
}

interface IndexedSegment { coordinate: number; segment: Segment }
function segmentIndex(segments: readonly Segment[], horizontal: boolean): IndexedSegment[] {
  return segments.filter(s => horizontal ? Math.abs(s.a.y - s.b.y) < EPS : Math.abs(s.a.x - s.b.x) < EPS)
    .map(segment => ({ coordinate: horizontal ? segment.a.y : segment.a.x, segment }))
    .sort((a, b) => a.coordinate - b.coordinate);
}
function lowerBoundIndexed<T extends { coordinate: number }>(items: readonly T[], value: number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (items[mid]!.coordinate < value) lo = mid + 1; else hi = mid; }
  return lo;
}
function upperBoundIndexed<T extends { coordinate: number }>(items: readonly T[], value: number): number {
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (items[mid]!.coordinate <= value) lo = mid + 1; else hi = mid; }
  return lo;
}

function crossingCount(a: V, b: V, ignored: ReadonlySet<string>, crossings: { verticalByX: IndexedSegment[]; horizontalByY: IndexedSegment[] }): number {
  const horizontal = Math.abs(a.y - b.y) < EPS, start = horizontal ? a.x : a.y, end = horizontal ? b.x : b.y;
  const forward = end >= start, low = Math.min(start, end), high = Math.max(start, end), seen = new Set<string>();
  const candidates = horizontal ? crossings.verticalByX : crossings.horizontalByY;
  for (let i = lowerBoundIndexed(candidates, low - EPS); i < upperBoundIndexed(candidates, high + EPS); i++) {
    const s = candidates[i]!.segment;
    if (s.ownerId && ignored.has(s.ownerId)) continue;
    const x = horizontal ? s.a.x : a.x, y = horizontal ? a.y : s.a.y;
    const along = horizontal ? x : y, across = horizontal ? y : x;
    const occupiedLo = horizontal ? Math.min(s.a.y, s.b.y) : Math.min(s.a.x, s.b.x), occupiedHi = horizontal ? Math.max(s.a.y, s.b.y) : Math.max(s.a.x, s.b.x);
    const onOccupiedAxis = horizontal ? a.y : a.x;
    if ((horizontal ? Math.abs(across - a.y) > EPS : Math.abs(across - a.x) > EPS) || along < low - EPS || along > high + EPS || onOccupiedAxis <= occupiedLo + 0.5 || onOccupiedAxis >= occupiedHi - 0.5) continue;
    const delta = forward ? along - start : start - along;
    if (delta <= EPS || delta >= Math.abs(end - start) - EPS) continue; // route elbows that join a track are not crossings
    const key = `${s.ownerId ?? 'unowned'}:${Math.round(x * 100)}:${Math.round(y * 100)}`;
    seen.add(key);
  }
  return seen.size;
}

/** Counts crossings strictly inside one route step. Crossings at grid vertices are charged separately. */
export function countCrossingsOnSegment(a: V, b: V, occupied: readonly Segment[], ignored: ReadonlySet<string> = new Set()): number {
  return crossingCount(a, b, ignored, {
    verticalByX: segmentIndex(occupied, false),
    horizontalByY: segmentIndex(occupied, true),
  });
}

/** Counts only a perpendicular crossing where the candidate route passes straight through a grid vertex. */
export function countCrossingsAtVertex(point: V, incoming: V, outgoing: V, occupied: readonly Segment[], ignored: ReadonlySet<string> = new Set()): number {
  return crossingsAtVertex(point, incoming, outgoing, ignored, {
    verticalByX: segmentIndex(occupied, false),
    horizontalByY: segmentIndex(occupied, true),
  });
}

function crossingsAtVertex(point: V, incoming: V, outgoing: V, ignored: ReadonlySet<string>, crossings: { verticalByX: IndexedSegment[]; horizontalByY: IndexedSegment[] }): number {
  const horizontalPass = incoming.y === 0 && outgoing.y === 0 && incoming.x === -outgoing.x;
  const verticalPass = incoming.x === 0 && outgoing.x === 0 && incoming.y === -outgoing.y;
  if (!horizontalPass && !verticalPass) return 0;
  const candidates = horizontalPass ? crossings.verticalByX : crossings.horizontalByY;
  const coordinate = horizontalPass ? point.x : point.y;
  const seen = new Set<string>();
  for (let i = lowerBoundIndexed(candidates, coordinate - EPS); i < upperBoundIndexed(candidates, coordinate + EPS); i++) {
    const segment = candidates[i]!.segment;
    if (segment.ownerId && ignored.has(segment.ownerId)) continue;
    const horizontal = Math.abs(segment.a.y - segment.b.y) < EPS;
    if (horizontalPass === horizontal) continue;
    const lo = horizontal ? Math.min(segment.a.x, segment.b.x) : Math.min(segment.a.y, segment.b.y);
    const hi = horizontal ? Math.max(segment.a.x, segment.b.x) : Math.max(segment.a.y, segment.b.y);
    const across = horizontal ? point.y : point.x;
    if (across <= lo + 0.5 || across >= hi - 0.5) continue;
    const key = `${segment.ownerId ?? 'unowned'}:${Math.round(point.x * 100)}:${Math.round(point.y * 100)}`;
    seen.add(key);
  }
  return seen.size;
}

function aestheticEdgeCost(a: V, b: V, direction: number, previousDirection: number, goalDirection: number, atGoal: boolean,
  occupiedIndex: { horizontal: IndexedSegment[]; vertical: IndexedSegment[] }, previousIndex: { horizontal: Array<{ coordinate: number; lo: number; hi: number }>; vertical: Array<{ coordinate: number; lo: number; hi: number }> }, labelCandidates: readonly Rect[]): number {
  const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  let overlap = 0, near = 0;
  const horizontal = Math.abs(a.y - b.y) < EPS;
  const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y), hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
  const coord = horizontal ? a.y : a.x;
  const axisSegments = horizontal ? occupiedIndex.horizontal : occupiedIndex.vertical;
  for (let i = lowerBoundIndexed(axisSegments, coord - TRACK_SPACING_PT); i < upperBoundIndexed(axisSegments, coord + TRACK_SPACING_PT); i++) {
    const { segment: s, coordinate: otherCoord } = axisSegments[i]!;
    const gap = Math.abs(coord - otherCoord);
    const sLo = horizontal ? Math.min(s.a.x, s.b.x) : Math.min(s.a.y, s.b.y), sHi = horizontal ? Math.max(s.a.x, s.b.x) : Math.max(s.a.y, s.b.y);
    const shared = Math.max(0, Math.min(hi, sHi) - Math.max(lo, sLo));
    if (gap <= 0.5) overlap += shared * 20;
    else if (gap < TRACK_SPACING_PT && shared >= 10) near += 2 * (TRACK_SPACING_PT - gap) * shared;
  }
  const deviationShared = (() => {
    const pieces: Array<[number, number]> = [];
    const runs = horizontal ? previousIndex.horizontal : previousIndex.vertical;
    for (let i = lowerBoundIndexed(runs, coord - 0.01); i < upperBoundIndexed(runs, coord + 0.01); i++) {
      const run = runs[i]!;
      if (Math.abs(run.coordinate - coord) >= 0.01) continue;
      const from = Math.max(lo, run.lo), to = Math.min(hi, run.hi); if (to > from) pieces.push([from, to]);
    }
    pieces.sort((x, y) => x[0] - y[0]);
    let covered = 0, from = Infinity, to = -Infinity;
    for (const [x, y] of pieces) { if (x > to) { covered += Math.max(0, to - from); from = x; to = y; } else to = Math.max(to, y); }
    return covered + Math.max(0, to - from);
  })();
  const labelCost = labelCandidates.reduce((sum, r) => {
    const hits = horizontal ? a.y >= r.y && a.y <= r.y + r.height && hi >= r.x && lo <= r.x + r.width
      : a.x >= r.x && a.x <= r.x + r.width && hi >= r.y && lo <= r.y + r.height;
    return sum + (hits ? 500 : 0);
  }, 0);
  return len + (direction === previousDirection ? 0 : 24) + overlap + near + (len - deviationShared) * 0.1 + labelCost + (atGoal && direction !== goalDirection ? 24 : 0);
}

function searchAesthetic(start: V, startDir: V, goal: V, goalDir: V, blockers: readonly Rect[], occupied: readonly Segment[], spacing: number, budget: number, options: SearchOptions): V[] | undefined {
  const xs = new Set<number>([start.x, goal.x]), ys = new Set<number>([start.y, goal.y]);
  // Add local turn tracks around both endpoint stubs. Without an interior
  // coordinate just before the goal, a path that fans away from a parallel
  // route can only rejoin at the goal and then violates its arrival direction.
  for (const x of [start.x, goal.x]) { xs.add(x - spacing); xs.add(x + spacing); }
  for (const y of [start.y, goal.y]) { ys.add(y - spacing); ys.add(y + spacing); }
  for (const r of blockers) {
    for (const x of [r.x, r.x + r.width]) { xs.add(x); xs.add(x < r.x + r.width / 2 ? x - spacing : x + spacing); }
    for (const y of [r.y, r.y + r.height]) { ys.add(y); ys.add(y < r.y + r.height / 2 ? y - spacing : y + spacing); }
  }
  const lo = { x: Math.min(...xs) - 4 * spacing, y: Math.min(...ys) - 4 * spacing }, hi = { x: Math.max(...xs) + 4 * spacing, y: Math.max(...ys) + 4 * spacing };
  xs.add(lo.x); xs.add(hi.x); ys.add(lo.y); ys.add(hi.y);
  for (const s of occupied) {
    const horizontal = Math.abs(s.a.y - s.b.y) < EPS;
    const minX = Math.min(s.a.x, s.b.x), maxX = Math.max(s.a.x, s.b.x), minY = Math.min(s.a.y, s.b.y), maxY = Math.max(s.a.y, s.b.y);
    if (maxX < lo.x - spacing || minX > hi.x + spacing || maxY < lo.y - spacing || minY > hi.y + spacing) continue;
    if (horizontal) { ys.add(s.a.y - spacing); ys.add(s.a.y + spacing); }
    else { xs.add(s.a.x - spacing); xs.add(s.a.x + spacing); }
  }
  const X = [...xs].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b), nx = X.length, ny = Y.length;
  const stats = options.stats;
  if (stats) { stats.expandedStates = 0; stats.gridCells = nx * ny; stats.peakMemoryBytes = nx * ny * 24; }
  const ix = (v: number) => X.findIndex(x => Math.abs(x - v) < EPS), iy = (v: number) => Y.findIndex(y => Math.abs(y - v) < EPS);
  const sx = ix(start.x), sy = iy(start.y), gx = ix(goal.x), gy = iy(goal.y), state = (x: number, y: number, d: number) => (y * nx + x) * 4 + d;
  const count = nx * ny * 4, distCross = new Int32Array(count).fill(0x7fffffff), distQuality = new Float64Array(count).fill(Infinity), prev = new Int32Array(count).fill(-1);
  const d0 = DIRS.findIndex(d => d.x === startDir.x && d.y === startDir.y), arrive = DIRS.findIndex(d => d.x === -goalDir.x && d.y === -goalDir.y);
  const heap = new AestheticHeap(), h = (x: number, y: number) => Math.abs(X[x]! - goal.x) + Math.abs(Y[y]! - goal.y), startState = state(sx, sy, d0);
  distCross[startState] = 0; distQuality[startState] = 0; heap.push(0, h(sx, sy), startState);
  const ignored = new Set(options.joinConnectorIds ?? []);
  // These edge costs and obstacle checks are independent of the path history. Compute them
  // once per directed grid edge rather than rescanning every shape and route during A*.
  const blockedNodes = new Uint8Array(nx * ny), blockedEdges = new Uint8Array(count);
  // Rectangles contribute only within their coordinate ranges. This is equivalent to testing
  // every node/edge against every blocker, while avoiding the page-wide blockers × grid scan.
  for (const r of blockers) {
    const x0 = upperBound(X, r.x + EPS), x1 = lowerBound(X, r.x + r.width - EPS);
    const y0 = upperBound(Y, r.y + EPS), y1 = lowerBound(Y, r.y + r.height - EPS);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) blockedNodes[y * nx + x] = 1;
    const right = r.x + r.width, bottom = r.y + r.height;
    // Horizontal grid edges which cross the open interior of this rectangle.
    const hx0 = Math.max(0, upperBound(X, r.x + EPS) - 1), hx1 = Math.min(nx - 1, lowerBound(X, right - EPS));
    for (let y = y0; y < y1; y++) for (let x = hx0; x < hx1; x++) blockedEdges[state(x, y, 0)] = 1;
    // Vertical edges use direction 1 (south); mark the reverse edge as well.
    const vy0 = Math.max(0, upperBound(Y, r.y + EPS) - 1), vy1 = Math.min(ny - 1, lowerBound(Y, bottom - EPS));
    for (let x = x0; x < x1; x++) for (let y = vy0; y < vy1; y++) blockedEdges[state(x, y, 1)] = 1;
  }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (x + 1 < nx && blockedEdges[state(x, y, 0)]) blockedEdges[state(x + 1, y, 2)] = 1;
    if (y + 1 < ny && blockedEdges[state(x, y, 1)]) blockedEdges[state(x, y + 1, 3)] = 1;
  }
  const edgeCrossings = new Uint16Array(count), horizontalVertexCrossings = new Uint16Array(nx * ny), verticalVertexCrossings = new Uint16Array(nx * ny), edgeQuality = new Float64Array(count);
  const fixedMemoryBytes = nx * ny * 24 + count * (1 + 2 + 8) + nx * ny * 3;
  if (stats) stats.peakMemoryBytes = fixedMemoryBytes;
  const occupiedIndex = { horizontal: segmentIndex(occupied, true), vertical: segmentIndex(occupied, false) };
  const crossingsIndex = { verticalByX: occupiedIndex.vertical, horizontalByY: occupiedIndex.horizontal };
  if (options.crossingsPolicy !== 'allow') {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const point = { x: X[x]!, y: Y[y]! }, cell = y * nx + x;
      horizontalVertexCrossings[cell] = crossingsAtVertex(point, { x: -1, y: 0 }, { x: 1, y: 0 }, ignored, crossingsIndex);
      verticalVertexCrossings[cell] = crossingsAtVertex(point, { x: 0, y: -1 }, { x: 0, y: 1 }, ignored, crossingsIndex);
    }
  }
  const previousIndex = { horizontal: [] as Array<{ coordinate: number; lo: number; hi: number }>, vertical: [] as Array<{ coordinate: number; lo: number; hi: number }> };
  for (let i = 1; i < (options.previous?.length ?? 0); i++) {
    const p = options.previous![i - 1]!, q = options.previous![i]!;
    if (Math.abs(p.y - q.y) < EPS) previousIndex.horizontal.push({ coordinate: p.y, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x) });
    else if (Math.abs(p.x - q.x) < EPS) previousIndex.vertical.push({ coordinate: p.x, lo: Math.min(p.y, q.y), hi: Math.max(p.y, q.y) });
  }
  previousIndex.horizontal.sort((a, b) => a.coordinate - b.coordinate);
  previousIndex.vertical.sort((a, b) => a.coordinate - b.coordinate);
  const horizontalLabelsByY = Y.map(y => (options.labelRects ?? []).filter(r => y >= r.y && y <= r.y + r.height));
  const verticalLabelsByX = X.map(x => (options.labelRects ?? []).filter(r => x >= r.x && x <= r.x + r.width));
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    for (let nd = 0; nd < 4; nd++) {
      const tx = x + DIRS[nd]!.x, ty = y + DIRS[nd]!.y;
      if (tx < 0 || ty < 0 || tx >= nx || ty >= ny) continue;
      const move = state(x, y, nd), a = { x: X[x]!, y: Y[y]! }, b = { x: X[tx]!, y: Y[ty]! };
      if (blockedNodes[ty * nx + tx] || blockedEdges[move]) continue;
      edgeCrossings[move] = options.crossingsPolicy === 'allow' ? 0 : crossingCount(a, b, ignored, crossingsIndex);
      edgeQuality[move] = aestheticEdgeCost(a, b, nd, nd, arrive, false, occupiedIndex, previousIndex,
        nd === 0 || nd === 2 ? horizontalLabelsByY[y]! : verticalLabelsByX[x]!);
    }
  }
  let steps = 0, best = -1;
  while (heap.size) {
    const top = heap.pop(), id = top.id, d = id % 4, cell = (id - d) / 4, x = cell % nx, y = (cell - x) / nx;
    if (top.crossings !== distCross[id] || Math.abs(top.f - distQuality[id]! - h(x, y)) > 1e-7) continue;
    // Aesthetic cost can prefer a visually attractive final segment, but endpoint
    // direction is a routing constraint. Do not accept the goal until the route
    // arrives along the axis that enters the endpoint correctly.
    if (x === gx && y === gy && d === arrive) { best = id; break; }
    if (steps >= budget) { if (stats) { stats.expandedStates = steps; stats.peakMemoryBytes = fixedMemoryBytes + steps * 48; } return undefined; }
    steps++;
    const gCross = distCross[id]!, gQuality = distQuality[id]!;
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      const tx = x + DIRS[nd]!.x, ty = y + DIRS[nd]!.y;
      if (tx < 0 || ty < 0 || tx >= nx || ty >= ny) continue;
      const move = id - d + nd;
      if (blockedEdges[move]) continue;
      const vertexCrossings = id !== startState && nd === d
        ? (nd === 0 || nd === 2 ? horizontalVertexCrossings[cell]! : verticalVertexCrossings[cell]!)
        : 0;
      const ns = state(tx, ty, nd), nextCross = gCross + edgeCrossings[move]! + vertexCrossings;
      const nextQuality = gQuality + edgeQuality[move]! + (nd === d ? 0 : 24) + (tx === gx && ty === gy && nd !== arrive ? 24 : 0);
      if (nextCross < distCross[ns]! || (nextCross === distCross[ns]! && nextQuality < distQuality[ns]! - 1e-9)) {
        distCross[ns] = nextCross; distQuality[ns] = nextQuality; prev[ns] = id; heap.push(nextCross, nextQuality + h(tx, ty), ns);
      }
    }
  }
  if (stats) { stats.expandedStates = steps; stats.peakMemoryBytes = nx * ny * 24 + steps * 48; }
  if (best < 0) return undefined;
  const points: V[] = [];
  for (let s = best; s >= 0; s = prev[s]!) { const cell = (s - (s % 4)) / 4; points.push({ x: X[cell % nx]!, y: Y[(cell - (cell % nx)) / nx]! }); }
  return points.reverse();
}

/** Searches the grid of obstacle-edge lines for the cheapest orthogonal path from `start` (leaving along `startDir`) to `goal`. */
export function search(start: V, startDir: V, goal: V, goalDir: V, blockers: readonly Rect[], occupied: readonly Segment[], spacing: number, budget: number, options: SearchOptions = {}): V[] | undefined {
  if (options.profile === 'aesthetic') return searchAesthetic(start, startDir, goal, goalDir, blockers, occupied, spacing, budget, options);
  const xs = new Set<number>([start.x, goal.x]), ys = new Set<number>([start.y, goal.y]);
  for (const r of blockers) {
    for (const x of [r.x, r.x + r.width]) { xs.add(x); xs.add(x < r.x + r.width / 2 ? x - spacing : x + spacing); }
    for (const y of [r.y, r.y + r.height]) { ys.add(y); ys.add(y < r.y + r.height / 2 ? y - spacing : y + spacing); }
  }
  const lo = { x: Math.min(...xs) - 4 * spacing, y: Math.min(...ys) - 4 * spacing }, hi = { x: Math.max(...xs) + 4 * spacing, y: Math.max(...ys) + 4 * spacing };
  xs.add(lo.x); xs.add(hi.x); ys.add(lo.y); ys.add(hi.y);
  const X = [...xs].sort((a, b) => a - b), Y = [...ys].sort((a, b) => a - b);
  const nx = X.length, ny = Y.length;
  const ix = (v: number) => X.findIndex(x => Math.abs(x - v) < EPS), iy = (v: number) => Y.findIndex(y => Math.abs(y - v) < EPS);
  const sx = ix(start.x), sy = iy(start.y), gx = ix(goal.x), gy = iy(goal.y);
  const state = (x: number, y: number, d: number) => (y * nx + x) * 4 + d;
  const blockedNode = (x: number, y: number): boolean => blockers.some(r => X[x]! > r.x + EPS && X[x]! < r.x + r.width - EPS && Y[y]! > r.y + EPS && Y[y]! < r.y + r.height - EPS);
  const dist = new Float64Array(nx * ny * 4).fill(Infinity), prev = new Int32Array(nx * ny * 4).fill(-1);
  const d0 = DIRS.findIndex(d => d.x === startDir.x && d.y === startDir.y);
  const heap = new Heap();
  const h = (x: number, y: number) => Math.abs(X[x]! - goal.x) + Math.abs(Y[y]! - goal.y);
  dist[state(sx, sy, d0)] = 0; heap.push(h(sx, sy), state(sx, sy, d0));
  const arrive = DIRS.findIndex(d => d.x === -goalDir.x && d.y === -goalDir.y);
  let steps = 0, best = -1;
  while (heap.size) {
    const { id } = heap.pop();
    const d = id % 4, cell = (id - d) / 4, x = cell % nx, y = (cell - x) / nx;
    if (x === gx && y === gy) { best = id; break; }
    if (++steps > budget) return undefined;
    const g = dist[id]!;
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue; // no U-turn on the spot
      const tx = x + DIRS[nd]!.x, ty = y + DIRS[nd]!.y;
      if (tx < 0 || ty < 0 || tx >= nx || ty >= ny) continue;
      const a = { x: X[x]!, y: Y[y]! }, b = { x: X[tx]!, y: Y[ty]! };
      if (blockedNode(tx, ty) || blockers.some(r => crosses(a, b, r))) continue;
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const cost = g + len + (nd === d ? 0 : TURN) + SHARED * sharedLength(a, b, occupied) + (tx === gx && ty === gy && nd !== arrive ? TURN : 0);
      const ns = state(tx, ty, nd);
      if (cost < dist[ns]!) { dist[ns] = cost; prev[ns] = id; heap.push(cost + h(tx, ty), ns); }
    }
  }
  if (best < 0) return undefined;
  const pts: V[] = [];
  for (let s = best; s >= 0; s = prev[s]!) { const cell = (s - (s % 4)) / 4; pts.push({ x: X[cell % nx]!, y: Y[(cell - (cell % nx)) / nx]! }); }
  return pts.reverse();
}

/**
 * Keeps `base` when it is clear, otherwise looks for a clear orthogonal route between the same two ends.
 * `others` are the obstacles; `ends` are the two connected shapes (rotated bounds).
 */
export function avoidObstacles(a: End, b: End, base: readonly V[], others: readonly Rect[], ends: readonly Rect[], occupied: readonly Segment[], opts: AvoidOptions = {}): AvoidResult {
  const clearance = opts.clearance ?? CLEARANCE, spacing = opts.spacing ?? SPACING, stub = opts.stub ?? STUB;
  if (!opts.search?.profile && isClear(base, others, ends, clearance)) {
    let overlaps = 0;
    for (let i = 1; i < base.length; i++) overlaps += sharedLength(base[i - 1]!, base[i]!, occupied);
    if (overlaps === 0) return { route: [...base], blocked: false, rerouted: false };
  }
  const A1 = { x: a.anchor.x + a.dir.x * stub, y: a.anchor.y + a.dir.y * stub }, B1 = { x: b.anchor.x + b.dir.x * stub, y: b.anchor.y + b.dir.y * stub };
  const blockers = [...others, ...ends].map(r => inflate(r, clearance));
  const path = search(A1, a.dir, B1, b.dir, blockers, occupied, spacing, opts.budget ?? BUDGET, opts.search);
  if (!path) return { route: [...base], blocked: !isClear(base, others, ends, clearance), rerouted: false };
  const out: V[] = [a.anchor, ...path, b.anchor];
  const tidy: V[] = [];
  for (const p of out) if (!tidy.length || Math.abs(tidy[tidy.length - 1]!.x - p.x) > EPS || Math.abs(tidy[tidy.length - 1]!.y - p.y) > EPS) tidy.push(p);
  for (let i = tidy.length - 2; i > 0; i--) {
    const p = tidy[i - 1]!, q = tidy[i]!, r = tidy[i + 1]!;
    if ((Math.abs(p.x - q.x) < EPS && Math.abs(q.x - r.x) < EPS) || (Math.abs(p.y - q.y) < EPS && Math.abs(q.y - r.y) < EPS)) tidy.splice(i, 1);
  }
  return { route: tidy, blocked: false, rerouted: true };
}
