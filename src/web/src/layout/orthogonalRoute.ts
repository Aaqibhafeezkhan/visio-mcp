import type { Endpoint, Port } from '../contracts/generated';

/**
 * Orthogonal connector routing (R08). Pure geometry, in page points with y down.
 *
 * A route leaves and enters a shape along an axis (the side the end is on), uses only horizontal and vertical segments, and passes
 * through any waypoints the author gave, inserting elbows between them. It does not avoid other shapes.
 */
export interface V { x: number; y: number }
export interface Box { x: number; y: number; width: number; height: number }
export interface Terminal { box: Box; rotationDeg: number; ports?: readonly Port[] }
export interface End {
  /** Where the route starts or ends. For a floating end this is on the shape's outline bounding box; the renderer finds the real outline point. */
  anchor: V;
  /** Unit axis vector pointing out of the shape. */
  dir: V;
  /** True when the renderer, not the route, decides the exact outline point (dynamic glue). */
  floating: boolean;
  /** For a fixed port: its fraction of the unrotated shape, so the renderer can pin the end exactly. */
  fraction?: { x: number; y: number };
}

const STUB = 12;
const EPS = 1e-6;
const SIDE_PORTS: Record<string, [number, number]> = { north: [0.5, 0], south: [0.5, 1], west: [0, 0.5], east: [1, 0.5] };

const rotate = (x: number, y: number, deg: number): V => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
};
const centreOf = (b: Box): V => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const snapAxis = (v: V): V => (Math.abs(v.x) >= Math.abs(v.y) ? { x: Math.sign(v.x) || 1, y: 0 } : { x: 0, y: Math.sign(v.y) || 1 });
const horizontal = (d: V): boolean => Math.abs(d.x) > Math.abs(d.y);

/** Resolves one connector end to an anchor and an outward axis. `towards` says where the rest of the route lies. */
export function endFor(ep: Endpoint, t: Terminal | undefined, towards: V): End {
  if (!t || ep.glue === 'none') {
    const anchor = ep.point ?? towards;
    return { anchor, dir: snapAxis({ x: towards.x - anchor.x, y: towards.y - anchor.y }), floating: false };
  }
  const c = centreOf(t.box), { width: w, height: h } = t.box;
  if (ep.glue === 'static' && ep.port) {
    const frac = t.ports?.find(p => p.id === ep.port) ?? (SIDE_PORTS[ep.port] ? { id: ep.port, x: SIDE_PORTS[ep.port]![0], y: SIDE_PORTS[ep.port]![1] } : undefined);
    if (frac) {
      const ox = (frac.x - 0.5) * w, oy = (frac.y - 0.5) * h;
      const local: V = Math.abs(ox) * h >= Math.abs(oy) * w ? { x: Math.sign(ox) || 1, y: 0 } : { x: 0, y: Math.sign(oy) || 1 };
      const off = rotate(ox, oy, t.rotationDeg);
      return { anchor: { x: c.x + off.x, y: c.y + off.y }, dir: snapAxis(rotate(local.x, local.y, t.rotationDeg)), floating: false, fraction: { x: frac.x, y: frac.y } };
    }
  }
  const preferred: Record<string, V> = { north: { x: 0, y: -1 }, east: { x: 1, y: 0 }, south: { x: 0, y: 1 }, west: { x: -1, y: 0 } };
  const localPreference = ep.requiredSide ? preferred[ep.requiredSide] : ep.preferredSide ? preferred[ep.preferredSide] : undefined;
  const dir = localPreference ? snapAxis(rotate(localPreference.x, localPreference.y, t.rotationDeg)) : snapAxis({ x: towards.x - c.x, y: towards.y - c.y });
  const a = (t.rotationDeg * Math.PI) / 180, ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a));
  const extent = horizontal(dir) ? (w * ca + h * sa) / 2 : (w * sa + h * ca) / 2;
  return { anchor: { x: c.x + dir.x * extent, y: c.y + dir.y * extent }, dir, floating: true };
}

/** Where an end faces: the point the other end should be measured against. */
export const centreOfTerminal = (t: Terminal): V => centreOf(t.box);

const eq = (a: V, b: V): boolean => Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;

function tidy(points: V[]): V[] {
  const out: V[] = [];
  for (const p of points) if (!out.length || !eq(out[out.length - 1]!, p)) out.push(p);
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]!, b = out[i]!, c = out[i + 1]!;
    const sameX = Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS, sameY = Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS;
    if (sameX || sameY) out.splice(i, 1);
  }
  return out;
}

/** Elbows between two points: leave p along firstH, arrive along lastH (null: do not care). */
function elbows(p: V, firstH: boolean, q: V, lastH: boolean | null): V[] {
  if (Math.abs(p.x - q.x) < EPS || Math.abs(p.y - q.y) < EPS) return [];
  if (lastH === null || lastH !== firstH) return [firstH ? { x: q.x, y: p.y } : { x: p.x, y: q.y }];
  return firstH ? [{ x: (p.x + q.x) / 2, y: p.y }, { x: (p.x + q.x) / 2, y: q.y }] : [{ x: p.x, y: (p.y + q.y) / 2 }, { x: q.x, y: (p.y + q.y) / 2 }];
}

/** Route through the author's waypoints. Each pair of points is joined by elbows; the end segments follow the end axes. */
function throughWaypoints(a: End, b: End, waypoints: readonly V[]): V[] {
  const pts: V[] = [a.anchor];
  let lastH = horizontal(a.dir); // the virtual segment that arrived at the anchor; the first real segment continues along it
  let first = true;
  const targets = [...waypoints, b.anchor];
  for (let i = 0; i < targets.length; i++) {
    const p = pts[pts.length - 1]!, q = targets[i]!;
    const last = i === targets.length - 1;
    const firstH = first ? horizontal(a.dir) : !lastH;
    const arriveH = last ? horizontal(b.dir) : null;
    const mid = elbows(p, firstH, q, arriveH);
    pts.push(...mid, q);
    const prev = pts[pts.length - 2]!;
    lastH = Math.abs(prev.y - q.y) < EPS && Math.abs(prev.x - q.x) >= EPS ? true : false;
    first = false;
  }
  return tidy(pts);
}

/** Route between two ends with no waypoints: L, Z or U shapes leaving and entering along the end axes. */
function automatic(a: End, b: End): V[] {
  const A = a.anchor, B = b.anchor;
  const ha = horizontal(a.dir), hb = horizontal(b.dir);
  const A1 = { x: A.x + a.dir.x * STUB, y: A.y + a.dir.y * STUB }, B1 = { x: B.x + b.dir.x * STUB, y: B.y + b.dir.y * STUB };
  const toB = { x: B.x - A.x, y: B.y - A.y };
  if (ha === hb) {
    const opposite = a.dir.x * b.dir.x + a.dir.y * b.dir.y < 0;
    const facing = ha ? a.dir.x * toB.x >= STUB * 2 : a.dir.y * toB.y >= STUB * 2;
    if (opposite && facing) return tidy([A, ...elbows(A, ha, B, ha), B]);
    if (!opposite) { // both leave the same way: go round to the far side of both
      const far = ha
        ? { x: a.dir.x > 0 ? Math.max(A1.x, B1.x) : Math.min(A1.x, B1.x), y: 0 }
        : { x: 0, y: a.dir.y > 0 ? Math.max(A1.y, B1.y) : Math.min(A1.y, B1.y) };
      return tidy(ha ? [A, { x: far.x, y: A.y }, { x: far.x, y: B.y }, B] : [A, { x: A.x, y: far.y }, { x: B.x, y: far.y }, B]);
    }
    // facing away from each other: out, across a lane between them, and in
    return tidy(ha
      ? [A, A1, { x: A1.x, y: (A.y + B.y) / 2 || A.y }, { x: B1.x, y: (A.y + B.y) / 2 || A.y }, B1, B]
      : [A, A1, { x: (A.x + B.x) / 2 || A.x, y: A1.y }, { x: (A.x + B.x) / 2 || A.x, y: B1.y }, B1, B]);
  }
  // perpendicular ends: a single elbow when it leaves and arrives the right way, otherwise detour through the stubs
  const corner = ha ? { x: B.x, y: A.y } : { x: A.x, y: B.y };
  const leavesOk = ha ? (corner.x - A.x) * a.dir.x > EPS : (corner.y - A.y) * a.dir.y > EPS;
  const arrivesOk = hb ? (corner.x - B.x) * b.dir.x > EPS : (corner.y - B.y) * b.dir.y > EPS;
  if (leavesOk && arrivesOk) return tidy([A, corner, B]);
  return tidy(ha ? [A, A1, { x: A1.x, y: B1.y }, B1, B] : [A, A1, { x: B1.x, y: A1.y }, B1, B]);
}

/** Full route including both anchors. Interior points are `route.slice(1, -1)`. */
export function routeOrthogonal(a: End, b: End, waypoints: readonly V[]): V[] {
  return waypoints.length ? throughWaypoints(a, b, waypoints) : automatic(a, b);
}
