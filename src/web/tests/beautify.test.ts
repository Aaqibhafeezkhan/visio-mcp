import { describe, expect, it } from 'vitest';
import type { ConnectorElement, DiagramDocument, Element, Operation, ShapeElement } from '../src/contracts/generated';
import { buildBeautifyPreview } from '../src/editor/beautifyPreview';
import { createTestEngine, element, seedDocument } from './support/engine';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const connector = (n: number, extra: object = {}): ConnectorElement => ({
  id: id(n), kind: 'connector', layerIds: [], zIndex: n, locked: false, hidden: false,
  bounds: { x: 0, y: 200, width: 100, height: 0 }, rotationDeg: 0, metadata: {},
  from: { glue: 'none', point: { x: 0, y: 200 } }, to: { glue: 'none', point: { x: 100, y: 200 } },
  route: 'orthogonal', waypoints: [], style: { colour: '#334155', widthPt: 1, dash: 'solid', startArrow: 'none', endArrow: 'none' },
  ...extra,
} as ConnectorElement);
function documentWithConnectors(overrides: { a?: object; b?: object } = {}): DiagramDocument {
  const source = seedDocument(1).document;
  const page = source.pages[0]!;
  page.elements = [];
  page.elements.push(connector(700, overrides.a), connector(701, overrides.b));
  return source;
}
const operation = (pageId: string, baseRevision: number, targets: string[], routes: Array<{ id: string; points: Array<{ x: number; y: number }> }>, includeManual = false): Operation => ({
  op: 'beautify', pageId, baseRevision, targets, routes, includeManual,
});

describe('atomic Beautify transaction', () => {
  it('commits the exact preview path for only its target, and undo/redo restores path and marker', async () => {
    const source = documentWithConnectors({ a: {
      label: { value: 'Nearby measured label', fontFamily: 'Test', fontSizePt: 10, bold: false, italic: false, underline: false, colour: '#000000', horizontalAlign: 'center', verticalAlign: 'middle', wrap: false, paddingPt: 0 },
      labelAnchor: { position: 0.5, offsetPt: 6 },
    } });
    const page = source.pages[0]!;
    const preview = await buildBeautifyPreview(source, page.id, [id(701)], { measureWidth: text => text.length * 7.12345 });
    expect(preview.proposedRoutes).toHaveLength(1);
    const exact = preview.proposedRoutes[0]!.points;
    const target = page.elements.find(item => item.id === id(701)) as ConnectorElement;
    expect(Math.sign(exact[exact.length - 2]!.x - exact[exact.length - 1]!.x)).toBe(-1);
    expect(Math.sign(exact[exact.length - 2]!.y - exact[exact.length - 1]!.y)).toBe(0);
    expect(target.from.point).toEqual({ x: 0, y: 200 });
    const t = createTestEngine({ document: source });
    const untouched = JSON.stringify(element(t.store.snapshot(), id(700)));
    const committed = await t.engine.execute(t.request([operation(page.id, preview.baseRevision, preview.targets, preview.proposedRoutes)]), 'gui');
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.value.changed).toEqual([id(701)]);
    expect(committed.value.routeChanges?.map(change => change.id)).toEqual([id(701)]);
    const saved = element(t.store.snapshot(), id(701)) as ConnectorElement;
    expect(saved.routing?.advisory).toEqual(exact);
    expect(saved.routing?.beautified).toBe(true);
    expect(saved.waypoints).toEqual([]);
    expect(JSON.stringify(element(t.store.snapshot(), id(700)))).toBe(untouched);

    const undo = await t.engine.undo({ ...t.engine.scope(), transactionId: id(900), baseRevision: t.engine.revision });
    expect(undo.ok).toBe(true);
    expect(element(t.store.snapshot(), id(701))).toEqual(connector(701));
    const redo = await t.engine.redo({ ...t.engine.scope(), transactionId: id(901), baseRevision: t.engine.revision });
    expect(redo.ok).toBe(true);
    expect((element(t.store.snapshot(), id(701)) as ConnectorElement).routing?.advisory).toEqual(exact);
  });

  it('beside a fitting container (R17) the commit changes only the target, leaves the container alone, and one undo restores it', async () => {
    const source = documentWithConnectors({ a: {
      label: { value: 'Nearby measured label', fontFamily: 'Test', fontSizePt: 10, bold: false, italic: false, underline: false, colour: '#000000', horizontalAlign: 'center', verticalAlign: 'middle', wrap: false, paddingPt: 0 },
      labelAnchor: { position: 0.5, offsetPt: 6 },
    } });
    const page = source.pages[0]!;
    const [m1, m2, box] = seedDocument(4).document.pages[0]!.elements.filter(item => item.kind === 'shape') as ShapeElement[];
    const at = (shape: ShapeElement, n: number, bounds: ShapeElement['bounds']): ShapeElement => ({ ...shape, id: id(n), alias: `c${n}`, bounds });
    const container = { ...at(box!, 720, { x: 10, y: 10, width: 300, height: 80 }), container: { memberIds: [id(721), id(722)], fit: 'fit' as const, marginPt: 10 } } as ShapeElement;
    page.elements.push(at(m1!, 721, { x: 20, y: 20, width: 100, height: 60 }), at(m2!, 722, { x: 200, y: 20, width: 100, height: 60 }), container);

    const preview = await buildBeautifyPreview(source, page.id, [id(701)], { measureWidth: text => text.length * 7.12345 });
    expect(preview.proposedRoutes).toHaveLength(1);
    const t = createTestEngine({ document: source });
    const before = JSON.stringify(element(t.store.snapshot(), id(720)));
    const committed = await t.engine.execute(t.request([operation(page.id, preview.baseRevision, preview.targets, preview.proposedRoutes)]), 'gui');
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    expect(committed.value.changed).toEqual([id(701)]);
    expect((element(t.store.snapshot(), id(701)) as ConnectorElement).routing?.advisory).toEqual(preview.proposedRoutes[0]!.points);
    expect(JSON.stringify(element(t.store.snapshot(), id(720)))).toBe(before);

    const undo = await t.engine.undo({ ...t.engine.scope(), transactionId: id(902), baseRevision: t.engine.revision });
    expect(undo.ok).toBe(true);
    expect(element(t.store.snapshot(), id(701))).toEqual(connector(701));
    expect(JSON.stringify(element(t.store.snapshot(), id(720)))).toBe(before);
  });

  it('rejects an operation whose preview revision is stale before changing state', async () => {
    const source = documentWithConnectors();
    const page = source.pages[0]!;
    const t = createTestEngine({ document: source });
    const before = t.store.snapshot();
    const result = await t.engine.execute(t.request([operation(page.id, 1, [id(701)], [{ id: id(701), points: [{ x: 0, y: 200 }, { x: 100, y: 200 }] }])]), 'gui');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('revision_conflict');
    expect(t.store.snapshot()).toEqual(before);
  });

  it('rejects a diagonal proposed path atomically', async () => {
    const source = documentWithConnectors();
    const page = source.pages[0]!;
    const t = createTestEngine({ document: source });
    const before = t.store.snapshot();
    const result = await t.engine.execute(t.request([operation(page.id, 0, [id(701)], [{ id: id(701), points: [{ x: 0, y: 200 }, { x: 100, y: 250 }] }])]), 'gui');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_request');
    expect(t.store.snapshot()).toEqual(before);
  });

  it('accepts a valid route that uses space beyond the page edge', async () => {
    const source = documentWithConnectors();
    const page = source.pages[0]!;
    const points = [{ x: 0, y: 200 }, { x: 10, y: 200 }, { x: 10, y: 180 }, { x: -20, y: 180 }, { x: -20, y: 220 }, { x: 90, y: 220 }, { x: 90, y: 200 }, { x: 100, y: 200 }];
    const t = createTestEngine({ document: source });
    const result = await t.engine.execute(t.request([operation(page.id, 0, [id(701)], [{ id: id(701), points }])]), 'gui');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((element(t.store.snapshot(), id(701)) as ConnectorElement).routing?.advisory).toEqual(points);
  });

  it('rejects a route far beyond the page margin', async () => {
    const source = documentWithConnectors();
    const page = source.pages[0]!;
    const points = [{ x: 0, y: 200 }, { x: 10, y: 200 }, { x: 10, y: 180 }, { x: 900, y: 180 }, { x: 900, y: 220 }, { x: 90, y: 220 }, { x: 90, y: 200 }, { x: 100, y: 200 }];
    const t = createTestEngine({ document: source });
    const before = t.store.snapshot();
    const result = await t.engine.execute(t.request([operation(page.id, 0, [id(701)], [{ id: id(701), points }])]), 'gui');
    expect(result.ok).toBe(false);
    expect(t.store.snapshot()).toEqual(before);
  });

  it('rejects a submitted route that crosses a text-avoid region', async () => {
    const source = documentWithConnectors();
    const page = source.pages[0]!;
    page.elements.push({ id: id(710), kind: 'text', layerIds: [], zIndex: 4, locked: false, hidden: false,
      bounds: { x: 40, y: 190, width: 20, height: 20 }, rotationDeg: 0, metadata: {},
      text: { value: 'Label', fontFamily: 'Arial', fontSizePt: 10, bold: false, italic: false, underline: false, colour: '#000000', horizontalAlign: 'center', verticalAlign: 'middle', wrap: false, paddingPt: 0 },
      routingPolicy: { text: 'avoid' } } as Element);
    const points = [{ x: 0, y: 200 }, { x: 100, y: 200 }];
    const t = createTestEngine({ document: source });
    const before = t.store.snapshot();
    const result = await t.engine.execute(t.request([operation(page.id, 0, [id(701)], [{ id: id(701), points }])]), 'gui');
    expect(result.ok).toBe(false);
    expect(t.store.snapshot()).toEqual(before);
  });

  it('converts a manual connector only when includeManual is explicit', async () => {
    const source = documentWithConnectors({ b: { waypoints: [{ x: 50, y: 230 }] } });
    const page = source.pages[0]!;
    const t = createTestEngine({ document: source });
    const exactRoute = [{ x: 0, y: 200 }, { x: 100, y: 200 }];
    const refused = await t.engine.execute(t.request([operation(page.id, 0, [id(701)], [{ id: id(701), points: exactRoute }])]), 'gui');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.details?.reason).toBe('route_not_automatic');
    expect((element(t.store.snapshot(), id(701)) as ConnectorElement).waypoints).toEqual([{ x: 50, y: 230 }]);
    const result = await t.engine.execute(t.request([operation(page.id, 0, [id(701)], [{ id: id(701), points: exactRoute }], true)]), 'gui');
    expect(result.ok).toBe(true);
    const saved = element(t.store.snapshot(), id(701)) as ConnectorElement;
    expect(saved.waypoints).toEqual([]);
    expect(saved.routing?.mode).toBeUndefined();
    expect(saved.routing?.beautified).toBe(true);
    expect(saved.routing?.advisory).toEqual([{ x: 0, y: 200 }, { x: 100, y: 200 }]);
  });

  it('leaves frozen and locked targets untouched while committing eligible routes', async () => {
    const source = documentWithConnectors({
      a: { routing: { mode: 'frozen', advisory: [{ x: 0, y: 200 }, { x: 100, y: 200 }] } },
      b: { locked: true },
    });
    const page = source.pages[0]!;
    const eligible = connector(702, { bounds: { x: 0, y: 320, width: 100, height: 0 }, from: { glue: 'none', point: { x: 0, y: 320 } }, to: { glue: 'none', point: { x: 100, y: 320 } } });
    const overlap = connector(703, { bounds: { x: 0, y: 320, width: 100, height: 0 }, from: { glue: 'none', point: { x: 0, y: 320 } }, to: { glue: 'none', point: { x: 100, y: 320 } } });
    page.elements.push(eligible, overlap);
    const preview = await buildBeautifyPreview(source, page.id);
    expect(preview.skipped.map(item => item.id)).toContain(id(700));
    expect(preview.skipped.map(item => item.id)).toContain(id(701));
    expect(preview.proposedRoutes.length).toBeGreaterThan(0);
    const t = createTestEngine({ document: source });
    const frozenBefore = JSON.stringify(element(t.store.snapshot(), id(700)));
    const lockedBefore = JSON.stringify(element(t.store.snapshot(), id(701)));
    const result = await t.engine.execute(t.request([operation(page.id, 0, [id(700), id(701), id(702), id(703)], preview.proposedRoutes)]), 'gui');
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(element(t.store.snapshot(), id(700)))).toBe(frozenBefore);
    expect(JSON.stringify(element(t.store.snapshot(), id(701)))).toBe(lockedBefore);
    expect(preview.proposedRoutes.every(route => (element(t.store.snapshot(), route.id) as ConnectorElement).routing?.beautified)).toBe(true);
  });

  it('leaves omitted infeasible targets untouched while committing feasible routes in the same transaction', async () => {
    const source = documentWithConnectors();
    const page = source.pages[0]!;
    const preview = await buildBeautifyPreview(source, page.id, [id(701)]);
    const t = createTestEngine({ document: source });
    const before = JSON.stringify(element(t.store.snapshot(), id(700)));
    const points = preview.proposedRoutes[0]!.points;
    const result = await t.engine.execute(t.request([operation(page.id, 0, [id(700), id(701)], preview.proposedRoutes)]), 'gui');
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changed).toEqual([id(701)]);
    expect((element(t.store.snapshot(), id(701)) as ConnectorElement).routing?.advisory).toEqual(points);
    expect(JSON.stringify(element(t.store.snapshot(), id(700)))).toBe(before);
  });

  it('clears the beautified marker when an ordinary edit repairs the saved route', async () => {
    const source = documentWithConnectors({ a: { routing: { beautified: true, advisory: [{ x: 0, y: 200 }, { x: 100, y: 200 }] } },
      b: { from: { glue: 'none', point: { x: 0, y: 400 } }, to: { glue: 'none', point: { x: 100, y: 400 } }, bounds: { x: 0, y: 400, width: 100, height: 0 } } });
    const page = source.pages[0]!;
    const t = createTestEngine({ document: source });
    const wall = id(710);
    const result = await t.engine.execute(t.request([{ op: 'createShape', id: wall, bounds: { x: 40, y: 180, width: 20, height: 40 } }]), 'gui');
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const saved = element(t.store.snapshot(), id(700)) as ConnectorElement;
    expect(saved.routing?.advisory).not.toEqual([{ x: 0, y: 200 }, { x: 100, y: 200 }]);
    expect(saved.routing?.beautified).toBeUndefined();
    expect(t.store.snapshot().document.pages[0]!.id).toBe(page.id);
  });
});
