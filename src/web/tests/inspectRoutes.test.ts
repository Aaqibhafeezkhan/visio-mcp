import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Element, Page, Point, Projection, Snapshot } from '../src/contracts/generated';
import { inspectLayout, type LayoutIssue } from '../src/layout/inspectLayout';
import { ROUTE_FINDING_CODES } from '../src/layout/inspectRoutes';

const solid = { kind: 'solid', colour: '#ffffff', opacity: 1 } as const;
const line = { kind: 'solid', colour: '#000000', opacity: 1 } as const;
const shape = (id: string, x: number, y: number, w = 60, h = 40, extra: object = {}): Element => ({
  id, kind: 'shape', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: { x, y, width: w, height: h }, rotationDeg: 0, metadata: {}, geometry: { preset: 'rectangle' },
  style: { fill: solid, stroke: line, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' }, ...extra,
}) as Element;
const conn = (id: string, from: object, to: object, extra: object = {}): Element => ({
  id, kind: 'connector', layerIds: [], zIndex: 5, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, rotationDeg: 0, metadata: {},
  from, to, route: 'orthogonal', waypoints: [], style: { stroke: line, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' }, ...extra,
}) as unknown as Element;
const free = (x: number, y: number) => ({ glue: 'none', point: { x, y } });
const glued = (elementId: string) => ({ elementId, glue: 'dynamic' });

const PAGE = '00000000-0000-4000-8000-0000000000aa';
/** Inspects one page with the given routes standing in for what the canvas drew. */
function inspect(elements: Element[], routes: Record<string, Point[]> | undefined, provenance: Record<string, string> = {}): LayoutIssue[] {
  const page = { id: PAGE, name: 'P', widthPt: 1000, heightPt: 1000, background: { kind: 'none' }, grid: { visible: false, snap: false, spacingPt: 10 }, layers: [], guides: [], elements } as unknown as Page;
  const snapshot = { documentId: 'd', sessionId: 's', revision: 1, document: { pages: [page] } } as unknown as Snapshot;
  const projection = routes && ({ documentId: 'd', sessionId: 's', revision: 1, groupVisualBounds: {},
    connectors: Object.fromEntries(Object.entries(routes).map(([id, points]) => [id, { routePoints: points, visualBounds: { x: 0, y: 0, width: 0, height: 0 }, ...(provenance[id] ? { routeProvenance: provenance[id] } : {}) }])) } as unknown as Projection);
  return inspectLayout(snapshot, { measureWidth: t => t.length * 5, ...(projection ? { projection } : {}) }).issues;
}
const codes = (issues: LayoutIssue[]) => issues.map(i => i.code);
const one = (issues: LayoutIssue[], code: string) => { const found = issues.filter(i => i.code === code); expect(found).toHaveLength(1); return found[0]!; };

describe('route diagnostics (R26): connector to connector', () => {
  const across = conn('h', free(0, 100), free(400, 100)), down = conn('v', free(200, 0), free(200, 300));
  const routes = { h: [{ x: 0, y: 100 }, { x: 400, y: 100 }], v: [{ x: 200, y: 0 }, { x: 200, y: 300 }] };

  it('a crossing is reported once per pair, as information', () => {
    const c = one(inspect([across, down], routes), 'CONNECTORS_CROSS');
    expect(c).toMatchObject({ severity: 'info', elementIds: ['h', 'v'], evidence: { classification: 'crossing', intended: false, crossings: 1, points: [{ x: 200, y: 100 }] } });
  });

  it('a crossing a line hop draws is reported as intended, and names the connector that hops', () => {
    const hopping = { ...across, hops: 'arc' } as Element;
    expect(one(inspect([hopping, down], routes), 'CONNECTORS_CROSS').evidence).toMatchObject({ classification: 'hopped', intended: true, hopped: 1, hopsOver: 'h' });
  });

  it('a T-join is a join, not a crossing or a touching end', () => {
    const branch = conn('b', { glue: 'none', point: { x: 200, y: 100 }, join: { connectorId: 'h', position: 0.5 } }, free(200, 300));
    const issues = inspect([across, branch], { h: routes.h, b: [{ x: 200, y: 100 }, { x: 200, y: 300 }] });
    expect(one(issues, 'CONNECTOR_JOIN')).toMatchObject({ severity: 'info', elementIds: ['b', 'h'], evidence: { classification: 't_join', intended: true, end: 'from' } });
    expect(codes(issues)).not.toContain('CONNECTORS_CROSS');
    expect(codes(issues)).not.toContain('CONNECTOR_TOUCHES_CONNECTOR');
  });

  it('an end lying on another connector without a join is a warning: it looks like a junction that is not there', () => {
    const stub = conn('s', free(200, 100), free(200, 300));
    const t = one(inspect([across, stub], { h: routes.h, s: [{ x: 200, y: 100 }, { x: 200, y: 300 }] }), 'CONNECTOR_TOUCHES_CONNECTOR');
    expect(t).toMatchObject({ severity: 'warning', elementIds: ['s', 'h'], evidence: { classification: 'endpoint_contact', end: 'from', point: { x: 200, y: 100 } } });
  });

  it('connectors drawn on top of each other overlap; sharing an end is said so', () => {
    const a = conn('a', free(0, 100), free(300, 100)), b = conn('b', free(100, 100), free(400, 100));
    const o = one(inspect([a, b], { a: [{ x: 0, y: 100 }, { x: 300, y: 100 }], b: [{ x: 100, y: 100 }, { x: 400, y: 100 }] }), 'CONNECTORS_OVERLAP');
    expect(o).toMatchObject({ severity: 'warning', evidence: { classification: 'collinear_overlap', overlapPt: 200 } });
    const s1 = shape('s1', 0, 300), s2 = shape('s2', 500, 300), s3 = shape('s3', 500, 500);
    const x = conn('x', glued('s1'), glued('s2')), y = conn('y', glued('s1'), glued('s3'));
    const shared = one(inspect([s1, s2, s3, x, y], { x: [{ x: 60, y: 320 }, { x: 500, y: 320 }], y: [{ x: 60, y: 320 }, { x: 300, y: 320 }, { x: 300, y: 520 }, { x: 500, y: 520 }] }), 'CONNECTORS_OVERLAP');
    expect(shared.evidence).toMatchObject({ classification: 'collinear_shared_end', overlapPt: 240 });
  });

  it('parallel runs a couple of points apart are too close, with a run to move', () => {
    const a = conn('a', free(0, 100), free(300, 100)), b = conn('b', free(0, 102), free(300, 102));
    const c = one(inspect([a, b], { a: [{ x: 0, y: 100 }, { x: 300, y: 100 }], b: [{ x: 0, y: 102 }, { x: 300, y: 102 }] }), 'CONNECTORS_TOO_CLOSE');
    expect(c.evidence).toMatchObject({ classification: 'parallel_near_miss', gapPt: 2, alongsidePt: 300, suggestion: { action: 'move_run', elementId: 'a', segment: 0, to: 92 } });
  });

  it('runs far enough apart, or crossing at an end, report nothing', () => {
    const a = conn('a', free(0, 100), free(300, 100)), b = conn('b', free(0, 110), free(280, 110)), c = conn('c', free(300, 100), free(300, 400));
    expect(inspect([a, b, c], { a: [{ x: 0, y: 100 }, { x: 300, y: 100 }], b: [{ x: 0, y: 110 }, { x: 280, y: 110 }], c: [{ x: 300, y: 100 }, { x: 300, y: 400 }] })).toEqual([]);
  });
});

describe('route diagnostics (R26): the shape of a route', () => {
  const kinked = [{ x: 0, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 101 }, { x: 300, y: 101 }];
  const flat = [{ x: 0, y: 100 }, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 300, y: 100 }];

  it('a run of a point or so is a kink, and a corner that does not turn is redundant', () => {
    expect(one(inspect([conn('k', free(0, 100), free(300, 101))], { k: kinked }, { k: 'kept' }), 'ROUTE_SHORT_SEGMENT')).toMatchObject({
      severity: 'warning', evidence: { classification: 'near_zero_segment', routeMode: 'automatic', provenance: 'kept', segments: [{ index: 1, lengthPt: 1 }], suggestion: { action: 'straighten' } } });
    expect(one(inspect([conn('f', free(0, 100), free(300, 100))], { f: flat }), 'ROUTE_REDUNDANT_VERTEX').evidence).toMatchObject({ vertexIndices: [1, 2], suggestion: { action: 'remove_vertices', vertexIndices: [1, 2] } });
  });

  it('reports the engine-owned beautified route provenance', () => {
    const kink = [{ x: 0, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 101 }, { x: 300, y: 101 }];
    expect(one(inspect([conn('b', free(0, 100), free(300, 101))], { b: kink }, { b: 'beautified' }), 'ROUTE_SHORT_SEGMENT').evidence.provenance).toBe('beautified');
  });

  it('a manual or frozen route is drawn that way on purpose and its shape is not judged', () => {
    const manual = conn('m', free(0, 100), free(300, 101), { waypoints: [{ x: 150, y: 100 }, { x: 150, y: 101 }] });
    const frozen = conn('z', free(0, 300), free(300, 300), { routing: { mode: 'frozen' } });
    expect(inspect([manual, frozen], { m: kinked, z: flat.map(p => ({ x: p.x, y: 300 })) })).toEqual([]);
  });

  it('a kept detour round a shape that has gone has more bends than a reroute would draw', () => {
    const a = shape('a', 0, 80), b = shape('b', 400, 80);
    const c = conn('c', { elementId: 'a', glue: 'static', port: 'east' }, { elementId: 'b', glue: 'static', port: 'west' });
    const detour = [{ x: 60, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 20 }, { x: 300, y: 20 }, { x: 300, y: 100 }, { x: 400, y: 100 }];
    const e = one(inspect([a, b, c], { c: detour }, { c: 'kept' }), 'ROUTE_EXCESS_BENDS');
    expect(e.evidence).toMatchObject({ bends: 4, bendsIfRerouted: 0, provenance: 'kept', suggestion: { action: 'reroute', elementId: 'c' } });
  });

  it('a run beside a shape is tight; a run along its outline is a warning', () => {
    const near = shape('near', 100, 104, 100, 40), on = shape('on', 100, 300, 100, 40);
    const c = conn('c', free(0, 102), free(300, 102)), d = conn('d', free(0, 300), free(300, 300));
    const issues = inspect([near, on, c, d], { c: [{ x: 0, y: 102 }, { x: 300, y: 102 }], d: [{ x: 0, y: 300 }, { x: 300, y: 300 }] }).filter(i => i.code === 'ROUTE_TOO_CLOSE_TO_SHAPE');
    expect(issues.map(i => [i.elementIds, i.severity, i.evidence.classification])).toEqual([[['c', 'near'], 'info', 'tight_clearance'], [['d', 'on'], 'warning', 'runs_on_outline']]);
  });
});

describe('route diagnostics (R26): connectors through shapes', () => {
  it('a frame round one end is entered on purpose, a page-size backdrop is decoration, a wall is a defect with its policy', () => {
    const inner = shape('inner', 120, 120), frame = shape('frame', 100, 100, 200, 200), wall = shape('wall', 500, 80, 20, 100), backdrop = shape('backdrop', 0, 0, 1000, 600);
    const target = shape('target', 800, 120);
    const c = conn('c', glued('inner'), glued('target'));
    const issues = inspect([backdrop, frame, inner, wall, target, c], { c: [{ x: 180, y: 140 }, { x: 800, y: 140 }] });
    expect(one(issues, 'CONNECTOR_CROSSES_CONTAINER')).toMatchObject({ severity: 'info', evidence: { classification: 'container_boundary', intended: true, crossedElementIds: ['frame'] } });
    expect(one(issues, 'CONNECTOR_CROSSES_BACKGROUND')).toMatchObject({ severity: 'info', evidence: { crossedElementIds: ['backdrop'] } });
    expect(one(issues, 'CONNECTOR_CROSSES_SHAPE')).toMatchObject({ severity: 'warning', evidence: { crossedElementIds: ['wall'], classification: 'obstacle_crossing', policies: { wall: 'automatic' } } });
  });

  it('a backdrop the router was told to avoid is a real crossing', () => {
    const backdrop = shape('backdrop', 0, 0, 1000, 600, { routingPolicy: { obstacle: 'avoid' } });
    const issues = inspect([backdrop, conn('c', free(10, 10), free(900, 10))], { c: [{ x: 10, y: 10 }, { x: 900, y: 10 }] });
    expect(codes(issues)).not.toContain('CONNECTOR_CROSSES_BACKGROUND');
    expect(one(issues, 'CONNECTOR_CROSSES_SHAPE').evidence.policies).toEqual({ backdrop: 'avoid' });
  });

  it('without drawn routes nothing about connectors against each other is guessed', () => {
    const a = conn('a', free(0, 100), free(300, 100)), b = conn('b', free(0, 101), free(300, 101));
    expect(inspect([a, b], undefined).filter(i => ROUTE_FINDING_CODES.includes(i.code as never) && i.code !== 'UNGLUED_CONNECTOR_END')).toEqual([]);
  });
});

describe('route diagnostics (R26): the code list', () => {
  it('every routing code is named in the inspect_layout tool help', () => {
    const help = readFileSync(new URL('../../Diagram.Mcp/DiagramTools.cs', import.meta.url), 'utf8');
    const described = help.slice(help.indexOf('Name = "inspect_layout"'), help.indexOf('Name = "inspect_layout"') + 4000);
    for (const code of ROUTE_FINDING_CODES) expect(described, code).toContain(code);
  });
});
