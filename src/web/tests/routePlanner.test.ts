import { describe, expect, it } from 'vitest';
import type { Element } from '../src/contracts/generated';
import { planRoutes, routeDefects, type PlanResult } from '../src/layout/routePlanner';
import { isClear, search, type Segment } from '../src/layout/obstacleRoute';
import { selectObstacles, visualRect } from '../src/layout/obstacles';
import { compile } from '../src/script/compiler';
import { createTestEngine, sequenceIds } from './support/engine';
import { id } from './support/ops';

const solid = { kind: 'solid', colour: '#fff', opacity: 1 } as const;
const shape = (id: string, x: number, y: number, w = 100, h = 60, extra: object = {}): Element => ({
  id, kind: 'shape', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: { x, y, width: w, height: h }, rotationDeg: 0, metadata: {}, geometry: { preset: 'rectangle' },
  style: { fill: solid, stroke: solid, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' }, ...extra,
}) as Element;
const conn = (id: string, from: string, to: string, extra: object = {}, fromPort?: string, toPort?: string): Element => ({
  id, kind: 'connector', layerIds: [], zIndex: 2, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, rotationDeg: 0, metadata: {},
  from: fromPort ? { elementId: from, glue: 'static', port: fromPort } : { elementId: from, glue: 'dynamic' },
  to: toPort ? { elementId: to, glue: 'static', port: toPort } : { elementId: to, glue: 'dynamic' },
  route: 'orthogonal', waypoints: [], style: { stroke: solid, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' }, ...extra,
}) as unknown as Element;
const plan = (elements: Element[], previous?: PlanResult['routes'], measureWidth?: (text: string, font: { family: string; sizePt: number; bold: boolean; italic: boolean }) => number): PlanResult => planRoutes({ elements, layers: [], pageArea: 1_000_000, previous, measureWidth });
const moveBy = (els: Element[], id: string, dx: number, dy: number): Element[] => els.map(e => (e.id === id && e.kind !== 'connector' && e.kind !== 'group' ? { ...e, bounds: { ...e.bounds, x: e.bounds.x + dx, y: e.bounds.y + dy } } : e));
const pts = (r: PlanResult, id: string) => r.routes.get(id)!.points;

describe('route planner', () => {
  const base = [shape('a', 0, 100), shape('b', 400, 100), shape('c', 0, 400), shape('d', 400, 400), conn('ab', 'a', 'b', {}, 'east', 'west'), conn('cd', 'c', 'd', {}, 'east', 'west')];

  it('plans an exact orthogonal route and says where it came from', () => {
    const r = plan(base);
    for (const id of ['ab', 'cd']) {
      expect(routeDefects(pts(r, id))).toEqual([]);
      expect(r.routes.get(id)!.provenance).toBe('rerouted');
    }
    expect(r.changes.map(c => c.id)).toEqual(['ab', 'cd']);
  });

  it('is the same whatever order the elements are listed in (z-order does not decide priority)', () => {
    const a = plan(base), b = plan([...base].reverse());
    for (const id of ['ab', 'cd']) expect(pts(b, id)).toEqual(pts(a, id));
  });

  it('keeps every route and reports no change when an unrelated shape is nudged by 1 pt', () => {
    const els = [...base, shape('far', 800, 800)];
    const first = plan(els);
    const next = plan(moveBy(els, 'far', 1, 0), first.routes);
    expect(next.changes).toEqual([]);
    for (const id of ['ab', 'cd']) { expect(pts(next, id)).toEqual(pts(first, id)); expect(next.routes.get(id)!.provenance).toBe('kept'); }
  });

  it('required_endpoint_side_overrides_the_soft_preference', () => {
    const a = shape('a', 0, 100), b = shape('b', 400, 100);
    const link = { ...conn('ab', 'a', 'b'), from: { elementId: 'a', glue: 'dynamic', preferredSide: 'east', requiredSide: 'north' } } as unknown as Element;
    const routes = plan([a, b, link]).routes.get('ab')!.points;
    expect(routes[0]).toEqual({ x: 50, y: 100 });
    expect(routes[1]!.y).toBeLessThan(routes[0]!.y);
  });

  it('reports_a_distinct_finding_when_a_required_side_cannot_route', () => {
    const a = shape('a', 100, 100), b = shape('b', 700, 100);
    const link = { ...conn('ab', 'a', 'b'), from: { elementId: 'a', glue: 'dynamic', requiredSide: 'north' } } as unknown as Element;
    const wall = shape('wall', 120, 65, 60, 30, { routingPolicy: { obstacle: 'forbidden' } });
    expect(plan([a, b, wall, link]).routeFindings).toContainEqual(expect.objectContaining({ code: 'ROUTE_REQUIRED_SIDE_UNRESOLVED', elementId: 'ab' }));
  });

  it('does not blame the required side when another hard obstacle still blocks the route', () => {
    const a = shape('a', 100, 100), b = shape('b', 700, 100);
    const link = { ...conn('ab', 'a', 'b'), from: { elementId: 'a', glue: 'dynamic', requiredSide: 'north' } } as unknown as Element;
    const wall = shape('wall', 0, 0, 1000, 700, { routingPolicy: { obstacle: 'forbidden' } });
    expect(plan([a, b, wall, link]).routeFindings).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_ROUTE', elementId: 'ab' }));
  });

  it('keeps a clear beautified automatic route after an unrelated shape move, regardless of straightening hysteresis', () => {
    const route = [{ x: 100, y: 130 }, { x: 200, y: 130 }, { x: 200, y: 50 }, { x: 600, y: 50 }, { x: 600, y: 130 }, { x: 700, y: 130 }];
    const marked = { ...conn('ab', 'a', 'b', {}, 'east', 'west'), routing: { beautified: true, advisory: route } } as unknown as Element;
    const els = [shape('a', 0, 100), shape('b', 700, 100), shape('far', 900, 900), marked];
    const first = plan(els);
    expect(pts(first, 'ab')).toEqual(route);
    expect(first.routes.get('ab')!.provenance).toBe('beautified');

    const moved = plan(moveBy(els, 'far', 1, 0), first.routes);
    expect(pts(moved, 'ab')).toEqual(route);
    expect(moved.routes.get('ab')!.provenance).toBe('beautified');
    expect(moved.changes.map(change => change.id)).not.toContain('ab');
  });

  it('allows normal straightening when Visio import preserves advisory geometry but drops the Beautified marker', () => {
    const importedAdvisory = [{ x: 100, y: 130 }, { x: 200, y: 130 }, { x: 200, y: 50 }, { x: 600, y: 50 }, { x: 600, y: 130 }, { x: 700, y: 130 }];
    const imported = { ...conn('ab', 'a', 'b', {}, 'east', 'west'), routing: { advisory: importedAdvisory } } as unknown as Element;
    const result = plan([shape('a', 0, 100), shape('b', 700, 100), imported]);
    expect(pts(result, 'ab')).not.toEqual(importedAdvisory);
    expect(pts(result, 'ab')).toEqual([{ x: 100, y: 130 }, { x: 700, y: 130 }]);
    expect(result.routes.get('ab')!.provenance).not.toBe('beautified');
  });

  it('repairs a blocked beautified route and leaves its engine marker on the document connector', () => {
    const route = [{ x: 100, y: 130 }, { x: 200, y: 130 }, { x: 200, y: 50 }, { x: 600, y: 50 }, { x: 600, y: 130 }, { x: 700, y: 130 }];
    const marked = { ...conn('ab', 'a', 'b', {}, 'east', 'west'), routing: { beautified: true, advisory: route } } as unknown as Element;
    const wall = shape('wall', 350, 30, 80, 40);
    const next = plan([shape('a', 0, 100), shape('b', 700, 100), wall, marked]);
    expect(next.routes.get('ab')!.provenance).toBe('repaired');
    expect(routeDefects(pts(next, 'ab'))).toEqual([]);
    expect((marked as never as { routing: { beautified: boolean } }).routing.beautified).toBe(true);
  });

  it('keeps the interior track when an end shape moves a few points, changing only the end runs', () => {
    // a to d: leaves east, comes in from the top of d, so the route has an interior vertical track
    const els = [shape('a', 0, 100), shape('d', 400, 400), conn('ad', 'a', 'd', {}, 'east', 'north')];
    const first = plan(els);
    const moved = plan(moveBy(els, 'd', 7, 0), first.routes);
    expect(moved.routes.get('ad')!.provenance).toBe('elastic');
    expect(routeDefects(pts(moved, 'ad'))).toEqual([]);
    const was = pts(first, 'ad'), now = pts(moved, 'ad');
    expect(now[now.length - 1]).toEqual({ x: 457, y: 400 }); // glued to the moved north port
    expect(now[0]).toEqual(was[0]); // the unmoved end did not change
  });

  it('splices a local detour around a newly blocking shape and keeps the route either side', () => {
    const els = [shape('a', 0, 100), shape('b', 700, 100), conn('ab', 'a', 'b', {}, 'east', 'west')];
    const first = plan(els);
    expect(pts(first, 'ab').length).toBe(2);
    const wall = shape('wall', 330, 90, 40, 80);
    const next = plan([...els, wall], first.routes);
    const r = next.routes.get('ab')!;
    expect(['repaired', 'rerouted']).toContain(r.provenance);
    expect(routeDefects(r.points)).toEqual([]);
    const obstacles = selectObstacles([...els, wall], [], new Set(['a', 'b']), [visualRect(els[0] as never), visualRect(els[1] as never)], [], 1_000_000);
    expect(isClear(r.points, obstacles.map(o => o.rect), [], 2)).toBe(true);
    expect(r.points[0]).toEqual(pts(first, 'ab')[0]);
  });

  it('keeps a frozen route and reports a newly blocking hard obstacle', () => {
    const a = shape('a', 0, 100), b = shape('b', 700, 100);
    const initial = conn('ab', 'a', 'b', {}, 'east', 'west');
    const stored = pts(plan([a, b, initial]), 'ab');
    const frozen = conn('ab', 'a', 'b', { routing: { mode: 'frozen', advisory: stored } }, 'east', 'west');
    const wall = shape('wall', 330, 90, 40, 80);

    const result = plan([a, b, wall, frozen]);

    expect(pts(result, 'ab')).toEqual(stored);
    expect(result.routes.get('ab')!.provenance).toBe('unresolved');
    expect(result.routeFindings).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_ROUTE', elementId: 'ab', blockerIds: ['wall'] }));
  });

  it('follows a moved frozen endpoint through an obstacle the stored route already crosses', () => {
    const a = shape('a', 0, 100), b = shape('b', 700, 100);
    const initial = conn('ab', 'a', 'b', {}, 'east', 'west');
    const stored = pts(plan([a, b, initial]), 'ab');
    const frozen = conn('ab', 'a', 'b', { routing: { mode: 'frozen', advisory: stored } }, 'east', 'west');
    const wall = shape('wall', 330, 90, 40, 80);
    const blocked = plan([a, b, wall, frozen]);
    const movedB = moveBy([a, b, wall, frozen], 'b', 40, 0);

    const moved = plan(movedB, blocked.routes);

    expect(pts(moved, 'ab')).toEqual([{ x: 100, y: 130 }, { x: 740, y: 130 }]);
    expect(moved.routes.get('ab')!.provenance).toBe('unresolved');
    expect(moved.routes.get('ab')!.reason).toMatch(/crosses a hard obstacle/);
    expect(moved.routeFindings).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_ROUTE', elementId: 'ab', blockerIds: ['wall'] }));
  });

  it('does not let an existing frozen crossing authorize a new obstacle crossing while following', () => {
    const a = shape('a', 0, 100), b = shape('b', 700, 100);
    const initial = conn('ab', 'a', 'b', {}, 'east', 'west');
    const stored = pts(plan([a, b, initial]), 'ab');
    const frozen = conn('ab', 'a', 'b', { routing: { mode: 'frozen', advisory: stored } }, 'east', 'west');
    const existingWall = shape('existingWall', 330, 90, 40, 80);
    const newWall = shape('newWall', 710, 90, 20, 80);
    const blocked = plan([a, b, existingWall, frozen]);

    const moved = plan(moveBy([a, b, existingWall, newWall, frozen], 'b', 40, 0), blocked.routes);

    expect(pts(moved, 'ab')).toEqual(stored);
    expect(moved.routes.get('ab')!.provenance).toBe('unresolved');
    expect(moved.routes.get('ab')!.reason).toMatch(/cannot follow the moved end safely/);
    expect(moved.routeFindings).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_ROUTE', elementId: 'ab', blockerIds: ['existingWall'] }));
  });

  it('repairs only the blocked run of a longer route', () => {
    // a to d with a vertical track at x=450; a wall lands on the horizontal run along y=130
    const els = [shape('a', 0, 100), shape('d', 600, 500), conn('ad', 'a', 'd', {}, 'east', 'north')];
    const first = plan(els);
    const was = pts(first, 'ad');
    const wall = shape('wall', 200, 110, 40, 40);
    const next = plan([...els, wall], first.routes);
    const r = next.routes.get('ad')!;
    expect(r.provenance).toBe('repaired');
    expect(routeDefects(r.points)).toEqual([]);
    expect(r.points[r.points.length - 1]).toEqual(was[was.length - 1]);
    expect(r.points[0]).toEqual(was[0]);
  });

  it('does not flip to a slightly shorter route when a nearby shape changes a little (hysteresis)', () => {
    const els = [shape('a', 0, 100), shape('b', 700, 100), shape('wall', 330, 90, 40, 80), conn('ab', 'a', 'b', {}, 'east', 'west')];
    const first = plan(els);
    const smaller = els.map(e => (e.id === 'wall' ? shape('wall', 330, 100, 40, 70) : e));
    const next = plan(smaller, first.routes);
    expect(next.routes.get('ab')!.provenance).toBe('kept');
    expect(pts(next, 'ab')).toEqual(pts(first, 'ab'));
  });

  it('straightens a detour once the obstacle that forced it is gone and the direct route is much shorter', () => {
    const els = [shape('a', 0, 100), shape('b', 700, 100), shape('wall', 330, 90, 40, 80), conn('ab', 'a', 'b', {}, 'east', 'west')];
    const first = plan(els);
    const without = plan(els.filter(e => e.id !== 'wall'), first.routes);
    expect(without.routes.get('ab')!.provenance).toBe('rerouted');
    expect(pts(without, 'ab').length).toBe(2);
    expect(without.routes.get('ab')!.reason).toMatch(/gone/);
  });

  it('flags a connector that cannot be routed instead of calling it a success', () => {
    const els = [shape('a', 0, 100), shape('b', 700, 100),
      shape('n', 690, 20, 120, 20), shape('s', 690, 180, 120, 20), shape('w', 650, 20, 30, 180), shape('e2', 820, 20, 30, 180), shape('lid', 650, 5, 200, 10),
      conn('ab', 'a', 'b', {}, 'east', 'west')];
    // b is walled in on all four sides with gaps smaller than the clearance
    const r = plan(els).routes.get('ab')!;
    expect(r.provenance).toBe('unresolved');
    expect(r.reason).toMatch(/no clear route/);
    expect(plan(els).routes.get('ab')!.points).toEqual(r.points); // deterministic
  });

  it('never searches a connector that has author waypoints', () => {
    const els = [shape('a', 0, 100), shape('b', 400, 100), shape('wall', 190, 90, 20, 80), conn('ab', 'a', 'b', { waypoints: [{ x: 200, y: 130 }] }, 'east', 'west')];
    const r = plan(els).routes.get('ab')!;
    expect(r.provenance).toBe('authored');
  });

  it('forbidden_obstacle_is_never_crossed', () => {
    const wall = shape('wall', 330, 90, 40, 80, { routingPolicy: { obstacle: 'forbidden' } });
    const r = plan([shape('a', 0, 100), shape('b', 700, 100), wall, conn('ab', 'a', 'b', {}, 'east', 'west')]);
    const route = pts(r, 'ab');
    const bounds = visualRect(wall as never);
    expect(isClear(route, [bounds], [], 8)).toBe(true);
    expect(r.routeFindings).toEqual([]);
  });

  it('hard_obstacle_failure_names_blocker_and_keeps_previous_route', () => {
    const els = [shape('a', 0, 100), shape('b', 700, 100), conn('ab', 'a', 'b', {}, 'east', 'west')];
    const first = plan(els);
    const wall = shape('wall', 0, 0, 1000, 700, { routingPolicy: { obstacle: 'forbidden' } });
    const next = plan([...els, wall], first.routes);
    expect(next.routes.get('ab')!.provenance).toBe('unresolved');
    expect(pts(next, 'ab')).toEqual(pts(first, 'ab'));
    expect(next.routeFindings).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_ROUTE', elementId: 'ab', blockerIds: ['wall'] }));
  });

  it('endpoint_shape_is_crossed_only_by_glue_stubs', () => {
    const a = shape('a', 0, 100, 100, 60, { routingPolicy: { obstacle: 'forbidden' } });
    const b = shape('b', 500, 100, 100, 60, { routingPolicy: { obstacle: 'forbidden' } });
    const route = pts(plan([a, b, conn('ab', 'a', 'b', {}, 'east', 'west')]), 'ab');
    expect(route[0]).toEqual({ x: 100, y: 130 });
    expect(route[1]!.x).toBeGreaterThan(route[0]!.x);
    expect(route[route.length - 2]!.x).toBeLessThan(route[route.length - 1]!.x);
    expect(routeDefects(route)).toEqual([]);
  });

  it('clearance_includes_visible_stroke', () => {
    const wall = shape('wall', 300, 90, 50, 31, { routingPolicy: { obstacle: 'forbidden' }, style: { fill: solid, stroke: solid, strokeWidthPt: 8, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' } });
    const route = pts(plan([shape('a', 0, 100), shape('b', 700, 100), wall, conn('ab', 'a', 'b', {}, 'east', 'west')]), 'ab');
    expect(isClear(route, [visualRect(wall as never)], [], 12)).toBe(true);
  });

  it('avoid_is_relaxed_only_after_clear_search_fails', () => {
    const soft = shape('soft', 0, 0, 1000, 700, { routingPolicy: { obstacle: 'avoid' } });
    const r = plan([shape('a', 0, 100), shape('b', 700, 100), soft, conn('ab', 'a', 'b', {}, 'east', 'west')]);
    expect(r.routeFindings).toContainEqual(expect.objectContaining({ code: 'ROUTING_AVOIDANCE_VIOLATION', elementId: 'ab', blockerIds: ['soft'] }));
    expect(r.routeFindings).not.toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_ROUTE', elementId: 'ab' }));
  });

  it('pass_through_does_not_change_route', () => {
    const els = [shape('a', 0, 100), shape('b', 700, 100), conn('ab', 'a', 'b', {}, 'east', 'west')];
    const baseline = plan(els);
    const withPassThrough = plan([...els, shape('tunnel', 200, 50, 300, 160, { routingPolicy: { obstacle: 'passThrough' } })]);
    expect(pts(withPassThrough, 'ab')).toEqual(pts(baseline, 'ab'));
    expect(withPassThrough.routeFindings).toEqual([]);
  });

  it('protected_text_is_avoided', () => {
    const label: Element = { id: 'label', kind: 'text', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: { x: 320, y: 115, width: 60, height: 30 }, rotationDeg: 0, metadata: {}, text: { value: 'hello', fontFamily: 'Test', fontSizePt: 10, bold: false, italic: false, underline: false, colour: '#000000', horizontalAlign: 'left', verticalAlign: 'top', wrap: false, paddingPt: 0 }, routingPolicy: { text: 'avoid' } };
    const r = plan([shape('a', 0, 100), shape('b', 700, 100), label, conn('ab', 'a', 'b', {}, 'east', 'west')], undefined, value => value.length * 10);
    expect(r.routes.get('ab')!.provenance).not.toBe('unresolved');
    expect(isClear(pts(r, 'ab'), [{ x: 320, y: 115, width: 50, height: 12 }], [], 8)).toBe(true);
  });
  it('protected_connector_label_is_measured_from_its_route_anchor', () => {
    const a = shape('a', 0, 100), b = shape('b', 700, 100), c = shape('c', 350, -100), d = shape('d', 350, 300);
    const labelled = conn('ab', 'a', 'b', { label: { value: 'hello', fontFamily: 'Test', fontSizePt: 10, bold: false, italic: false, underline: false, colour: '#000000', horizontalAlign: 'center', verticalAlign: 'middle', wrap: false, paddingPt: 0 }, routingPolicy: { text: 'avoid' } }, 'east', 'west');
    const crossing = conn('cd', 'c', 'd', {}, 'south', 'north');
    const r = plan([a, b, c, d, labelled, crossing], undefined, value => value.length * 10);
    expect(pts(r, 'cd')).not.toEqual([{ x: 350, y: -40 }, { x: 350, y: 300 }]);
    expect(isClear(pts(r, 'cd'), [{ x: 375, y: 124, width: 50, height: 12 }], [], 8)).toBe(true);
  });

  it('preferred_side_rotates_with_shape', () => {
    const a = { ...shape('a', 0, 100), rotationDeg: 90 } as Element;
    const route = pts(plan([a, shape('b', 400, 100), conn('ab', 'a', 'b', { from: { elementId: 'a', glue: 'dynamic', preferredSide: 'north' } }, undefined, 'west')]), 'ab');
    expect(route[0]).toEqual({ x: 80, y: 130 });
    expect(route[1]!.x).toBeGreaterThan(route[0]!.x);
  });

  it('static_port_overrides_preferred_side', () => {
    const route = pts(plan([shape('a', 0, 100), shape('b', 400, 100), conn('ab', 'a', 'b', { from: { elementId: 'a', glue: 'static', port: 'east', preferredSide: 'north' } }, undefined, 'west')]), 'ab');
    expect(route[0]).toEqual({ x: 100, y: 130 });
  });
  it('falls back and reports when a preferred side has no clear route', () => {
    const a = shape('a', 0, 100), b = shape('b', 0, 500), wall = shape('wall', 110, 80, 40, 160, { routingPolicy: { obstacle: 'forbidden' } });
    const r = plan([a, b, wall, conn('ab', 'a', 'b', { from: { elementId: 'a', glue: 'dynamic', preferredSide: 'east' } })]);
    expect(r.routes.get('ab')!.points[0]).toEqual({ x: 50, y: 160 }); // automatic south side
    expect(r.routeFindings).toContainEqual(expect.objectContaining({ code: 'ROUTE_SIDE_PREFERENCE_RELAXED', elementId: 'ab' }));
  });
  it('plans only orthogonal connectors', () => {
    const r = plan([shape('a', 0, 0), shape('b', 300, 0), conn('ab', 'a', 'b', { route: 'straight' })]);
    expect(r.routes.size).toBe(0);
  });
});

describe('aesthetic A* routing (R24)', () => {
  const free = (id: string, from: { x: number; y: number }, to: { x: number; y: number }, advisory = [from, to]) => ({
    id, kind: 'connector', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, rotationDeg: 0, metadata: {},
    from: { glue: 'none', point: from }, to: { glue: 'none', point: to }, route: 'orthogonal', waypoints: [], routing: { advisory },
    style: { stroke: solid, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' },
  }) as unknown as Element;

  it('beautifies a crossing at a grid vertex even when an unrelated shape adds that grid line', () => {
    const horizontal = free('horizontal', { x: 0, y: 0 }, { x: 100, y: 0 });
    const vertical = free('vertical', { x: 50, y: -100 }, { x: 50, y: 100 });
    const run = (extra: Element[] = []) => planRoutes({ elements: [horizontal, vertical, ...extra], layers: [], pageArea: 1_000_000,
      beautifyTargets: new Set(['horizontal']), costProfile: 'aesthetic' });
    const alone = run();
    const withGridLine = run([shape('far', 50, 200, 10, 10)]);
    const hasCrossing = (route: readonly { x: number; y: number }[]) => route.some((p, i) => i > 0
      && Math.abs(p.y - route[i - 1]!.y) < 1e-6 && p.y > -100 && p.y < 100
      && Math.min(p.x, route[i - 1]!.x) < 50 && Math.max(p.x, route[i - 1]!.x) > 50);
    expect(hasCrossing(pts(alone, 'horizontal'))).toBe(true); // establishes the original crossing at x=50, y=0
    expect(withGridLine.routes.get('horizontal')!.provenance).toBe('beautified');
    expect(hasCrossing(pts(withGridLine, 'horizontal'))).toBe(false);
    expect(withGridLine.aestheticStats?.get('horizontal')?.expandedStates).toBeLessThan(80_000);
  });

  it('prefers a longer crossing-free path inside search over a shorter crossing path', () => {
    const path = search({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 100, y: 0 }, { x: 1, y: 0 },
      [{ x: 40, y: -20, width: 20, height: 40 }],
      [{ a: { x: 80, y: -100 }, b: { x: 80, y: 30 }, ownerId: 'existing' } as Segment], 6, 80_000,
      { profile: 'aesthetic', crossingsPolicy: 'avoid' });
    expect(path).toBeDefined();
    expect(path!.some(point => point.y > 30)).toBe(true);
  });

  it('separates a 100 pt overlapping automatic route by at least the 6 pt Beautify track', () => {
    const free = (id: string) => ({
      id, kind: 'connector', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, rotationDeg: 0, metadata: {},
      from: { glue: 'none', point: { x: 0, y: 0 } }, to: { glue: 'none', point: { x: 100, y: 0 } }, route: 'orthogonal', waypoints: [],
      style: { stroke: solid, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' },
    }) as unknown as Element;
    const result = planRoutes({ elements: [free('a'), free('b')], layers: [], pageArea: 100_000, beautifyTargets: new Set(['b']), costProfile: 'aesthetic' });
    const candidate = pts(result, 'b');
    expect(Math.sign(candidate[candidate.length - 2]!.x - candidate[candidate.length - 1]!.x)).toBe(-1);
    const parallelOverlap = candidate.slice(1).map((point, index) => {
      const previous = candidate[index]!;
      if (Math.abs(point.y - previous.y) > 1e-6) return { offset: 0, overlap: 0 };
      return { offset: Math.abs(point.y), overlap: Math.max(0, Math.min(100, Math.max(point.x, previous.x)) - Math.max(0, Math.min(point.x, previous.x))) };
    });
    expect(parallelOverlap.some(run => run.offset >= 6 && run.overlap >= 60)).toBe(true);
    expect(result.routes.get('b')!.provenance).toBe('beautified');
  });

  it('does not relax avoid-policy shapes during Beautify searches', () => {
    const free = (id: string) => ({
      id, kind: 'connector', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, rotationDeg: 0, metadata: {},
      from: { glue: 'none', point: { x: 0, y: 0 } }, to: { glue: 'none', point: { x: 100, y: 0 } }, route: 'orthogonal', waypoints: [],
      style: { stroke: solid, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' },
    }) as unknown as Element;
    const avoid = shape('avoid', -100, -100, 500, 500, { routingPolicy: { obstacle: 'avoid' } });
    const result = planRoutes({ elements: [avoid, free('a'), free('b')], layers: [], pageArea: 1_000_000, beautifyTargets: new Set(['b']), costProfile: 'aesthetic' });
    expect(result.routes.get('b')!.provenance).not.toBe('beautified');
  });
});

/** A seeded 60-shape, 60-connector diagram: the stress case from the performance targets. */
function stress(shapeCount = 60, connectorCount = 60): Element[] {
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const els: Element[] = [];
  const id = (p: string, n: number) => `${p}${String(n).padStart(3, '0')}`;
  for (let i = 0; i < shapeCount; i++) els.push(shape(id('s', i), 40 + (i % 10) * 170, 40 + Math.floor(i / 10) * 130, 100, 60));
  for (let i = 0; i < connectorCount; i++) {
    const a = Math.floor(rnd() * shapeCount);
    let b = Math.floor(rnd() * shapeCount);
    if (b === a) b = (b + 1) % shapeCount;
    els.push(conn(id('c', i), id('s', a), id('s', b)));
  }
  return els;
}

describe('route planner on the 60 shape, 60 connector diagram', () => {
  const els = stress();
  it('bounds and reports all opt-in searches in the 60/60 workload', () => {
    const started = performance.now();
    const targets = new Set(els.filter(e => e.kind === 'connector').map(e => e.id));
    const result = planRoutes({ elements: els, layers: [], pageArea: 1_000_000, beautifyTargets: targets, costProfile: 'aesthetic' });
    const stats = [...(result.aestheticStats?.values() ?? [])];
    const maxExpanded = Math.max(0, ...stats.map(s => s.expandedStates));
    const totalExpanded = stats.reduce((n, s) => n + s.expandedStates, 0);
    const maxGridCells = Math.max(0, ...stats.map(s => s.gridCells));
    const maxPeakMemoryBytes = Math.max(0, ...stats.map(s => s.peakMemoryBytes));
    const elapsedMs = performance.now() - started;
    console.info('R24 60/60 aesthetic stats', { searched: stats.length, maxExpanded, totalExpanded, maxGridCells, maxPeakMemoryBytes, elapsedMs: Math.round(elapsedMs) });
    expect(result.routes.size).toBe(60);
    expect(stats.length).toBe(60);
    expect(maxExpanded).toBeLessThanOrEqual(80_000);
    expect(elapsedMs).toBeLessThan(30_000);
  }, 35_000);

  it('bounds and reports every opt-in search in a denser 60/90 workload', () => {
    const dense = stress(60, 90);
    const started = performance.now();
    const targets = new Set(dense.filter(e => e.kind === 'connector').map(e => e.id));
    const result = planRoutes({ elements: dense, layers: [], pageArea: 1_000_000, beautifyTargets: targets, costProfile: 'aesthetic' });
    const stats = [...(result.aestheticStats?.values() ?? [])];
    const maxExpanded = Math.max(0, ...stats.map(s => s.expandedStates));
    const totalExpanded = stats.reduce((n, s) => n + s.expandedStates, 0);
    const maxGridCells = Math.max(0, ...stats.map(s => s.gridCells));
    const maxPeakMemoryBytes = Math.max(0, ...stats.map(s => s.peakMemoryBytes));
    const elapsedMs = performance.now() - started;
    console.info('R24 60/90 aesthetic stats', { searched: stats.length, maxExpanded, totalExpanded, maxGridCells, maxPeakMemoryBytes, elapsedMs: Math.round(elapsedMs) });
    expect(result.routes.size).toBe(90);
    expect(stats.length).toBe(90);
    expect(maxExpanded).toBeLessThanOrEqual(80_000);
    expect(elapsedMs).toBeLessThan(60_000);
  }, 65_000);

  it('baseline: fresh planning is deterministic and exact', async () => {
    const t0 = performance.now();
    const r = plan(els);
    const ms = performance.now() - t0;
    expect(r.routes.size).toBe(60);
    for (const [id, route] of r.routes) expect(routeDefects(route.points), id).toEqual([]);
    const counts: Record<string, number> = {};
    for (const route of r.routes.values()) counts[route.provenance] = (counts[route.provenance] ?? 0) + 1;
    const summary = { provenance: counts, vertices: Object.fromEntries([...r.routes].map(([k, v]) => [k, v.points.map(p => `${p.x},${p.y}`).join(' ')])) };
    await expect(JSON.stringify(summary, null, 1)).toMatchFileSnapshot('baselines/route-planner-stress-60.json');
    expect(ms).toBeLessThan(5000);
  });

  it('a 1 pt nudge of one shape changes only connectors attached to it or near it', () => {
    const first = plan(els);
    const target = 's027';
    const next = plan(moveBy(els, target, 1, 0), first.routes);
    const attached = new Set(els.filter(e => e.kind === 'connector' && (e.from.elementId === target || e.to.elementId === target)).map(e => e.id));
    const unexpected = next.changes.filter(c => !attached.has(c.id));
    // anything else that moved must have had the nudged shape within its clearance
    const box = els.find(e => e.id === target)!;
    const near = (id: string) => {
      const r = visualRect({ bounds: { x: (box as never as { bounds: { x: number } }).bounds.x - 20, y: (box as never as { bounds: { y: number } }).bounds.y - 20, width: 142, height: 102 }, rotationDeg: 0 });
      return !isClear(first.routes.get(id)!.points, [r], [], 0);
    };
    expect(unexpected.filter(c => !near(c.id))).toEqual([]);
    expect(next.changes.length).toBeLessThanOrEqual(attached.size + 6);
  });
});

describe('route planner with levels (R23)', () => {
  // a 200 x 200 frame between the two ends: small enough (4% of the page) that the legacy rules treat it as an obstacle
  const scene = (frameExtra: object = {}, connExtra: object = {}) => [shape('a', 0, 170), shape('b', 500, 170), shape('frame', 200, 100, 200, 200, frameExtra), conn('ab', 'a', 'b', connExtra, 'east', 'west')];
  const straight = (r: PlanResult) => pts(r, 'ab').every(p => p.y === 200);
  const length = (r: PlanResult) => pts(r, 'ab').slice(1).reduce((s, p, i) => s + Math.abs(p.x - pts(r, 'ab')[i]!.x) + Math.abs(p.y - pts(r, 'ab')[i]!.y), 0);

  it('detours around a frame on the same level, as before levels existed', () => {
    const r = plan(scene());
    expect(straight(r)).toBe(false);
    expect(length(r)).toBeGreaterThan(400);
  });

  it('runs straight over a frame on a lower level', () => {
    const r = plan(scene({ level: -1 }));
    expect(pts(r, 'ab')).toEqual([{ x: 100, y: 200 }, { x: 500, y: 200 }]);
  });

  it('a connector raised above the frame runs over it too', () => {
    expect(straight(plan(scene({}, { level: 1 })))).toBe(true);
  });

  it('straightens a kept detour once the frame is sent back, and detours again when it comes forward', () => {
    const first = plan(scene());
    const back = plan(scene({ level: -1 }), first.routes);
    expect(straight(back)).toBe(true);
    expect(back.changes.map(c => c.id)).toEqual(['ab']);
    const forward = plan(scene(), back.routes);
    expect(straight(forward)).toBe(false);
  });

  it('DrawScript level= sends the frame back and the route straightens', async () => {
    const doc = structuredClone(createTestEngine().store.snapshot().document);
    doc.pages[0]!.elements = [];
    const t = createTestEngine({ document: doc });
    const exec = (script: string, n: number) => t.engine.executeScript({ ...t.scope(), transactionId: id(n), baseRevision: t.engine.revision, script },
      (src, snap, c) => compile(src, { snapshot: snap, newUuid: sequenceIds('7'), ...c }));
    expect((await exec('add shape id=a x=0pt y=170pt w=100pt h=60pt\nadd shape id=b x=500pt y=170pt w=100pt h=60pt\nadd shape id=frame x=200pt y=100pt w=200pt h=200pt\n'
      + 'connect id=ab fromAlias=a fromPort="east" toAlias=b toPort="west" route=orthogonal', 7400)).ok).toBe(true);
    const routeOf = () => { const page = t.store.snapshot().document.pages[0]!; const r = planRoutes({ elements: page.elements, layers: page.layers, pageArea: 1_000_000 }); return [...r.routes.values()][0]!.points; };
    expect(routeOf().every(p => p.y === 200)).toBe(false);
    expect((await exec('set frame level=-1', 7401)).ok).toBe(true);
    expect(routeOf().every(p => p.y === 200)).toBe(true);
  });

  it('a frame below the connector but marked forbidden is still avoided', () => {
    expect(straight(plan(scene({ level: -1, routingPolicy: { obstacle: 'forbidden' } })))).toBe(false);
  });
});
