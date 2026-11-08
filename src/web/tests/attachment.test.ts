import { describe, expect, it } from 'vitest';
import { nearestOnRoute, pointOnRoute } from '../src/commands/pathAnchor';
import { newDocument } from '../src/model/newDocument';
import { createTestEngine } from './support/engine';
import type { Element, Operation, Projection, Snapshot } from '../src/contracts/generated';
import { ok } from '../src/model/result';

/** Routes as straight lines between the two shapes' middles, which is all these tests need from the drawing surface. */
function straightRoutes(snapshot: Snapshot) {
  const connectors: Projection['connectors'] = {};
  for (const page of snapshot.document.pages) {
    const byId = new Map(page.elements.map(e => [e.id, e] as const));
    for (const e of page.elements) {
      if (e.kind !== 'connector') continue;
      const mid = (id?: string) => { const b = byId.get(id ?? '')!.bounds; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
      const routePoints = [mid(e.from.elementId), mid(e.to.elementId)];
      connectors[e.id] = { routePoints: e.routing?.advisory ?? routePoints, visualBounds: { x: 0, y: 0, width: 0, height: 0 } };
    }
  }
  return ok({ documentId: snapshot.documentId, sessionId: snapshot.sessionId, revision: snapshot.revision, connectors, groupVisualBounds: {} } as Projection);
}

async function setup() {
  const t = createTestEngine({ document: newDocument() });
  t.engine.setSnapshotProjector(straightRoutes);
  const page = t.store.snapshot().document.pages[0]!.id;
  const run = async (ops: object[]) => t.engine.execute(t.request(ops.map(o => ((o as { op: string }).op.startsWith('create') ? { pageId: page, ...o } : o) as Operation)), 'mcp');
  const first = await run([
    { op: 'createShape', alias: 'a', bounds: { x: 0, y: 100, width: 40, height: 40 } },
    { op: 'createShape', alias: 'b', bounds: { x: 300, y: 100, width: 40, height: 40 } },
    { op: 'createConnector', alias: 'link', from: { elementId: 'a', glue: 'dynamic' }, to: { elementId: 'b', glue: 'dynamic' } },
  ]);
  expect(first.ok).toBe(true);
  const el = (alias: string) => t.store.snapshot().document.pages[0]!.elements.find(e => e.alias === alias) as Element & Record<string, any>;
  const centre = (alias: string) => { const b = el(alias).bounds; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  return { t, page, run, el, centre };
}

describe('positions along a route', () => {
  const L = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
  it('are measured along the whole length, with the offset to the right of travel', () => {
    expect(pointOnRoute(L, 0, 0)!.point).toEqual({ x: 0, y: 0 });
    expect(pointOnRoute(L, 0.5, 0)!.point).toEqual({ x: 100, y: 0 });
    expect(pointOnRoute(L, 0.75, 0)!.point).toEqual({ x: 100, y: 50 });
    expect(pointOnRoute(L, 0.25, 10)!.point).toEqual({ x: 50, y: 10 });   // travelling east, right is south (y grows downwards)
    expect(pointOnRoute(L, 0.75, 10)!.point).toEqual({ x: 90, y: 50 });   // travelling south, right is west
    expect(pointOnRoute(L, 1, 0)!.point).toEqual({ x: 100, y: 100 });
  });
  it('are found again from a point', () => {
    expect(nearestOnRoute(L, { x: 50, y: 10 })).toEqual({ position: 0.25, offsetPt: 10 });
    expect(nearestOnRoute(L, { x: 90, y: 50 })).toEqual({ position: 0.75, offsetPt: 10 });
    expect(nearestOnRoute(L, { x: 500, y: 500 })!.position).toBe(1);
  });
});

describe('elements attached to a connector', () => {
  it('sit at the chosen place on the connector, on the right-hand side for a positive offset', async () => {
    const { run, el, centre } = await setup();
    expect((await run([{ op: 'createShape', alias: 'tag', bounds: { x: 0, y: 0, width: 40, height: 20 }, attachment: { connector: 'link', position: 0.5 } }])).ok).toBe(true);
    expect(centre('tag')).toEqual({ x: 170, y: 120 });
    expect(el('tag').attachment).toMatchObject({ position: 0.5, offsetPt: 0 });
    expect((await run([{ op: 'set', target: 'tag', patch: { attachment: { connector: 'link', position: 0.25, offsetPt: 30 } } }])).ok).toBe(true);
    expect(centre('tag')).toEqual({ x: 95, y: 150 });
  });

  it('follow the connector when its end shape moves, and one undo puts both back', async () => {
    const { t, run, el, centre } = await setup();
    await run([{ op: 'createText', alias: 'note', bounds: { x: 0, y: 0, width: 60, height: 20 }, text: { value: 'PSGL Report' }, attachment: { connector: 'link', position: 0.5, offsetPt: -20 } }]);
    const was = centre('note');
    expect(was).toEqual({ x: 170, y: 100 });
    expect((await run([{ op: 'move', target: 'b', delta: { xPt: 100, yPt: 100 } }])).ok).toBe(true);
    // the line now runs (20,120) to (420,220); its middle is (220,170); the left of travel is up and a little right
    const c = centre('note');
    expect(c.x).toBeCloseTo(220 + 20 * (100 / Math.hypot(400, 100)), 1);
    expect(c.y).toBeCloseTo(170 - 20 * (400 / Math.hypot(400, 100)), 1);
    const undone = await t.engine.undo({ ...t.scope(), transactionId: crypto.randomUUID(), baseRevision: t.engine.revision } as never);
    expect(undone.ok).toBe(true);
    expect(centre('note')).toEqual(was);
    expect(el('b').bounds.x).toBe(300);
  });

  it('slide along the connector when moved, and keep their side', async () => {
    const { run, el, centre } = await setup();
    await run([{ op: 'createShape', alias: 'dot', bounds: { x: 0, y: 0, width: 20, height: 20 }, attachment: { connector: 'link', position: 0.5, offsetPt: 0 } }]);
    expect((await run([{ op: 'move', target: 'dot', delta: { xPt: 50, yPt: 15 } }])).ok).toBe(true);
    expect(el('dot').attachment).toMatchObject({ position: 0.6667, offsetPt: 15 });
    expect(centre('dot')).toEqual({ x: 220, y: 135 }); // exactly where it was dropped
  });

  it('repositions attached shapes and text after Beautify commits an exact path', async () => {
    const { t, page, run, el, centre } = await setup();
    await run([{ op: 'set', target: 'link', patch: { route: 'orthogonal' } }]);
    await run([
      { op: 'createShape', alias: 'tag', bounds: { x: 150, y: 110, width: 40, height: 20 }, attachment: { connector: 'link', position: 0.5 } },
      { op: 'createText', alias: 'note', bounds: { x: 140, y: 90, width: 60, height: 20 }, text: { value: 'Note' }, attachment: { connector: 'link', position: 0.5, offsetPt: -20 } },
    ]);
    const connectorId = el('link').id;
    const points = [{ x: 40, y: 120 }, { x: 50, y: 120 }, { x: 50, y: 200 }, { x: 290, y: 200 }, { x: 290, y: 120 }, { x: 300, y: 120 }];
    const result = await run([{ op: 'beautify', pageId: page, baseRevision: t.engine.revision, targets: [connectorId], routes: [{ id: connectorId, points }], includeManual: false }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(centre('tag')).toEqual({ x: 170, y: 200 });
    expect(centre('note')).toEqual({ x: 170, y: 180 });
  });

  it('are detached, and stay put, when their connector is deleted', async () => {
    const { run, el, centre } = await setup();
    await run([{ op: 'createShape', alias: 'dot', bounds: { x: 0, y: 0, width: 20, height: 20 }, attachment: { connector: 'link' } }]);
    const at = centre('dot');
    expect((await run([{ op: 'delete', target: 'link' }])).ok).toBe(true);
    expect(el('dot').attachment).toBeUndefined();
    expect(centre('dot')).toEqual(at);
  });

  it('can be detached on purpose', async () => {
    const { run, el } = await setup();
    await run([{ op: 'createShape', alias: 'dot', bounds: { x: 0, y: 0, width: 20, height: 20 }, attachment: { connector: 'link' } }]);
    expect((await run([{ op: 'set', target: 'dot', patch: { attachment: null } }])).ok).toBe(true);
    expect(el('dot').attachment).toBeUndefined();
  });

  it('refuse what makes no sense', async () => {
    const { run, el } = await setup();
    const bad = async (op: object, message: RegExp) => { const r = await run([op]); expect(r.ok).toBe(false); if (!r.ok) expect(r.error.message).toMatch(message); };
    await bad({ op: 'createShape', bounds: { x: 0, y: 0, width: 20, height: 20 }, attachment: { connector: 'a' } }, /not a connector/);
    await bad({ op: 'createShape', bounds: { x: 0, y: 0, width: 20, height: 20 }, attachment: { connector: 'link', position: 1.5 } }, /outside 0 to 1|1/);
    await bad({ op: 'set', target: 'a', patch: { attachment: { connector: 'link' } } }, /glued to it/);
    await run([{ op: 'createShape', alias: 'dot', bounds: { x: 0, y: 0, width: 20, height: 20 }, attachment: { connector: 'link' } }]);
    await bad({ op: 'set', target: 'link', patch: { from: { elementId: el('dot').id, glue: 'dynamic' } } }, /rides on it/);
  });

  it('copy with their connector, and land where they are put when copied alone', async () => {
    const { run, t } = await setup();
    await run([{ op: 'createShape', alias: 'dot', bounds: { x: 0, y: 0, width: 20, height: 20 }, attachment: { connector: 'link', position: 0.5 } }]);
    const r = await run([{ op: 'duplicate', targets: ['a', 'b', 'link', 'dot'], offset: { xPt: 0, yPt: 200 } }]);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const els = t.store.snapshot().document.pages[0]!.elements;
    const copies = els.filter(e => e.kind === 'shape' && e.attachment && e.alias !== 'dot') as Array<Element & { attachment: { connectorId: string }; bounds: { y: number } }>;
    expect(copies).toHaveLength(1);
    expect(copies[0]!.attachment.connectorId).not.toBe(els.find(e => e.alias === 'link')!.id);
    expect(copies[0]!.bounds.y).toBeCloseTo(310, 0); // on the copied line, 200 below the first
  });
});

describe('connector label placement', () => {
  it('is kept, merged and cleared', async () => {
    const { run, el } = await setup();
    expect((await run([{ op: 'set', target: 'link', patch: { labelAnchor: { position: 0.2 } } }])).ok).toBe(true);
    expect(el('link').labelAnchor).toEqual({ position: 0.2, offsetPt: 0 });
    expect((await run([{ op: 'set', target: 'link', patch: { labelAnchor: { offsetPt: -12 } } }])).ok).toBe(true);
    expect(el('link').labelAnchor).toEqual({ position: 0.2, offsetPt: -12 });
    expect((await run([{ op: 'set', target: 'link', patch: { labelAnchor: null } }])).ok).toBe(true);
    expect(el('link').labelAnchor).toBeUndefined();
    expect((await run([{ op: 'set', target: 'a', patch: { labelAnchor: { position: 0.2 } } }])).ok).toBe(false);
    expect((await run([{ op: 'set', target: 'link', patch: { labelAnchor: { position: 2 } } }])).ok).toBe(false);
  });
});
