import { describe, expect, it } from 'vitest';
import { endFor, routeOrthogonal, type Terminal } from '../src/layout/orthogonalRoute';
import { avoidObstacles, countCrossingsOnSegment, countCrossingsAtVertex, segmentsOf, type Rect } from '../src/layout/obstacleRoute';

const term = (x: number, y: number, w = 100, h = 60): Terminal => ({ box: { x, y, width: w, height: h }, rotationDeg: 0 });
const rect = (t: Terminal): Rect => t.box;
const ends = (a: Terminal, pa: string, b: Terminal, pb: string) => ({
  a: endFor({ elementId: 'a', port: pa, glue: 'static' }, a, { x: 0, y: 0 }), b: endFor({ elementId: 'b', port: pb, glue: 'static' }, b, { x: 0, y: 0 }),
});
const hits = (route: Array<{ x: number; y: number }>, r: Rect) => route.slice(1).some((p, i) => {
  const q = route[i]!; const x1 = Math.min(p.x, q.x), x2 = Math.max(p.x, q.x), y1 = Math.min(p.y, q.y), y2 = Math.max(p.y, q.y);
  return x2 > r.x && x1 < r.x + r.width && y2 > r.y && y1 < r.y + r.height;
});
const axis = (r: Array<{ x: number; y: number }>) => r.every((p, i) => i === 0 || Math.abs(p.x - r[i - 1]!.x) < 1e-6 || Math.abs(p.y - r[i - 1]!.y) < 1e-6);

describe('obstacle-aware routing', () => {
  const A = term(0, 100), B = term(500, 100);

  it('keeps a clear route untouched', () => {
    const { a, b } = ends(A, 'east', B, 'west');
    const base = routeOrthogonal(a, b, []);
    const r = avoidObstacles(a, b, base, [{ x: 200, y: 300, width: 80, height: 60 }], [rect(A), rect(B)], []);
    expect(r).toMatchObject({ blocked: false, rerouted: false });
    expect(r.route).toEqual(base);
  });

  it('goes around a shape that is in the way and keeps clear of it', () => {
    const { a, b } = ends(A, 'east', B, 'west');
    const base = routeOrthogonal(a, b, []);
    const wall: Rect = { x: 250, y: 90, width: 60, height: 80 };
    const r = avoidObstacles(a, b, base, [wall], [rect(A), rect(B)], []);
    expect(r).toMatchObject({ blocked: false, rerouted: true });
    expect(axis(r.route)).toBe(true);
    expect(hits(r.route, wall)).toBe(false);
    expect(r.route[0]).toEqual(base[0]);
    expect(r.route[r.route.length - 1]).toEqual(base[base.length - 1]);
    // leaves east and arrives travelling east into the west port
    expect(r.route[1]!.x).toBeGreaterThan(r.route[0]!.x);
    expect(r.route[r.route.length - 2]!.x).toBeLessThan(r.route[r.route.length - 1]!.x);
  });

  it('keeps the clearance around the obstacle', () => {
    const { a, b } = ends(A, 'east', B, 'west');
    const wall: Rect = { x: 250, y: 90, width: 60, height: 80 };
    const r = avoidObstacles(a, b, routeOrthogonal(a, b, []), [wall], [rect(A), rect(B)], [], { clearance: 10 });
    const padded: Rect = { x: wall.x - 9, y: wall.y - 9, width: wall.width + 18, height: wall.height + 18 };
    expect(hits(r.route, padded)).toBe(false);
  });

  it('does not run through the end shapes', () => {
    const { a, b } = ends(A, 'east', B, 'west');
    const tall: Rect = { x: 250, y: -400, width: 60, height: 900 };
    const r = avoidObstacles(a, b, routeOrthogonal(a, b, []), [tall], [rect(A), rect(B)], []);
    expect(r.rerouted).toBe(true);
    expect(hits(r.route.slice(1, -1), rect(A))).toBe(false);
    expect(hits(r.route.slice(1, -1), rect(B))).toBe(false);
    expect(hits(r.route, tall)).toBe(false);
  });

  it('reports blocked and keeps the base route when the end is walled in', () => {
    const { a, b } = ends(A, 'east', B, 'west');
    const base = routeOrthogonal(a, b, []);
    // a ring of walls around the target leaves no gap for the route to enter
    const walls: Rect[] = [
      { x: 380, y: 0, width: 300, height: 90 }, { x: 380, y: 170, width: 300, height: 90 },
      { x: 380, y: 0, width: 20, height: 260 }, { x: 660, y: 0, width: 20, height: 260 },
    ];
    const r = avoidObstacles(a, b, base, walls, [rect(A), rect(B)], []);
    expect(r).toMatchObject({ blocked: true, rerouted: false });
    expect(r.route).toEqual(base);
  });

  it('is deterministic', () => {
    const { a, b } = ends(A, 'east', B, 'west');
    const wall: Rect = { x: 250, y: 90, width: 60, height: 80 };
    const go = () => avoidObstacles(a, b, routeOrthogonal(a, b, []), [wall], [rect(A), rect(B)], []).route;
    expect(go()).toEqual(go());
  });

  it('fans a second connector out beside the first instead of overprinting it', () => {
    const wall: Rect = { x: 250, y: 90, width: 60, height: 80 };
    const A2 = term(0, 110), B2 = term(500, 110);
    const e1 = ends(A, 'east', B, 'west'), e2 = ends(A2, 'east', B2, 'west');
    const r1 = avoidObstacles(e1.a, e1.b, routeOrthogonal(e1.a, e1.b, []), [wall], [rect(A), rect(B)], []);
    const r2 = avoidObstacles(e2.a, e2.b, routeOrthogonal(e2.a, e2.b, []), [wall], [rect(A2), rect(B2)], segmentsOf(r1.route));
    const overlap = (p: typeof r1.route, q: typeof r1.route) => {
      let n = 0;
      for (const s of segmentsOf(p)) for (const t of segmentsOf(q)) {
        if (Math.abs(s.a.y - s.b.y) < 1e-6 && Math.abs(t.a.y - t.b.y) < 1e-6 && Math.abs(s.a.y - t.a.y) < 0.5) n += Math.max(0, Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x)) - Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x)));
      }
      return n;
    };
    expect(hits(r2.route, wall)).toBe(false);
    // the detour lines differ: the long horizontal runs are on different tracks
    const track = (r: typeof r1.route) => Math.max(...segmentsOf(r).filter(s => Math.abs(s.a.y - s.b.y) < 1e-6).map(s => Math.abs(s.a.x - s.b.x)));
    expect(track(r1.route)).toBeGreaterThan(0);
    expect(overlap(r1.route, r2.route)).toBeLessThan(Math.max(track(r1.route), track(r2.route)));
  });
});

describe('aesthetic crossing counts', () => {
  const occupied = [{ a: { x: 50, y: 0 }, b: { x: 50, y: 100 }, ownerId: 'vertical' }];
  it('counts a straight crossing once at the grid vertex, not on either adjoining half-edge', () => {
    expect(countCrossingsOnSegment({ x: 0, y: 50 }, { x: 100, y: 50 }, occupied)).toBe(1);
    expect(countCrossingsOnSegment({ x: 0, y: 50 }, { x: 50, y: 50 }, occupied)).toBe(0);
    expect(countCrossingsOnSegment({ x: 50, y: 50 }, { x: 100, y: 50 }, occupied)).toBe(0);
    expect(countCrossingsAtVertex({ x: 50, y: 50 }, { x: -1, y: 0 }, { x: 1, y: 0 }, occupied)).toBe(1);
  });

  it('does not count a route that turns at the other connector track', () => {
    expect(countCrossingsAtVertex({ x: 50, y: 50 }, { x: -1, y: 0 }, { x: 0, y: -1 }, occupied)).toBe(0);
  });
});
