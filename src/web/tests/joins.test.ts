import { describe, expect, it } from 'vitest';
import { newDocument } from '../src/model/newDocument';
import { createTestEngine } from './support/engine';
import type { Element, Operation, Projection, Snapshot } from '../src/contracts/generated';
import { ok } from '../src/model/result';
import { buildBeautifyPreview } from '../src/editor/beautifyPreview';

/** Routes as straight lines through each connector's ends and waypoints, which is all these tests need from the drawing surface. */
function straightRoutes(snapshot: Snapshot) {
  const connectors: Projection['connectors'] = {};
  for (const page of snapshot.document.pages) {
    const byId = new Map(page.elements.map(e => [e.id, e] as const));
    for (const e of page.elements) {
      if (e.kind !== 'connector') continue;
      const end = (ep: typeof e.from) => { if (ep.point) return ep.point; const b = byId.get(ep.elementId ?? '')!.bounds; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
      connectors[e.id] = { routePoints: e.routing?.advisory ?? [end(e.from), ...e.waypoints, end(e.to)], visualBounds: { x: 0, y: 0, width: 0, height: 0 } };
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
    { op: 'createShape', alias: 'c', bounds: { x: 150, y: 300, width: 40, height: 40 } },
    { op: 'createConnector', alias: 'bus', from: { elementId: 'a', glue: 'dynamic' }, to: { elementId: 'b', glue: 'dynamic' } },
  ]);
  expect(first.ok).toBe(true);
  const el = (alias: string) => t.store.snapshot().document.pages[0]!.elements.find(e => e.alias === alias) as Element & Record<string, any>;
  return { t, page, run, el };
}

const branch = (alias: string, connector: string, position?: number) => ({
  op: 'createConnector', alias, from: { elementId: 'c', glue: 'dynamic' }, to: { glue: 'none', join: { connector, ...(position === undefined ? {} : { position }) } },
});

describe('a branch joined to a connector', () => {
  it('ends on the connector at the chosen place, and says so', async () => {
    const { run, el } = await setup();
    expect((await run([branch('tap', 'bus', 0.25)])).ok).toBe(true);
    const tap = el('tap');
    expect(tap.to.glue).toBe('none');
    expect(tap.to.join).toEqual({ connectorId: el('bus').id, position: 0.25 });
    expect(tap.to.point).toEqual({ x: 95, y: 120 }); // bus runs (20,120) to (320,120): a quarter of 300 along is x 95
  });

  it('defaults to the middle', async () => {
    const { run, el } = await setup();
    await run([branch('tap', 'bus')]);
    expect(el('tap').to.join.position).toBe(0.5);
    expect(el('tap').to.point).toEqual({ x: 170, y: 120 });
  });

  it('follows when a shape at either end of the connector it joins moves, and one undo returns both', async () => {
    const { t, run, el } = await setup();
    await run([branch('tap', 'bus', 0.5)]);
    const before = el('tap').to.point;
    const moved = await run([{ op: 'move', target: 'b', delta: { xPt: 100, yPt: 0 } }]);
    expect(moved.ok).toBe(true);
    expect(el('tap').to.point).toEqual({ x: 220, y: 120 }); // bus now runs (20,120) to (420,120)
    expect(el('tap').bounds.x).toBeCloseTo(170, 1);
    expect((await t.engine.undo({ ...t.scope(), transactionId: crypto.randomUUID(), baseRevision: t.engine.revision } as never)).ok).toBe(true);
    expect(el('tap').to.point).toEqual(before);
    expect(el('b').bounds.x).toBe(300);
  });

  it('follows a connector that was itself routed through waypoints, along the drawn route', async () => {
    const { run, el } = await setup();
    await run([{ op: 'set', target: 'bus', patch: { waypoints: [{ x: 170, y: 20 }] } }]);
    await run([branch('tap', 'bus', 0.5)]);
    expect(el('tap').to.point.y).toBeLessThan(120); // the middle of a detour through (170,20) is nowhere near the straight line
  });

  it('repositions a joined branch after Beautify commits an exact path', async () => {
    const { t, page, run, el } = await setup();
    await run([{ op: 'set', target: 'bus', patch: { route: 'orthogonal' } }]);
    await run([branch('tap', 'bus', 0.5)]);
    const busId = el('bus').id;
    const points = [{ x: 40, y: 120 }, { x: 50, y: 120 }, { x: 50, y: 200 }, { x: 290, y: 200 }, { x: 290, y: 120 }, { x: 300, y: 120 }];
    const result = await run([{ op: 'beautify', pageId: page, baseRevision: t.engine.revision, targets: [busId], routes: [{ id: busId, points }], includeManual: false }]);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(el('tap').to.point).toEqual({ x: 170, y: 200 });
  });

  it.each([
    ['the branch itself', async (run: any, el: any) => run([{ op: 'set', target: 'tap', patch: { locked: true } }])],
    ['a layer the branch is on', async (run: any, el: any) => {
      await run([{ op: 'addLayer', name: 'Frozen layer', id: '00000000-0000-4000-8000-0000000007a1' }]);
      await run([{ op: 'assignLayers', targets: ['tap'], layerIds: ['00000000-0000-4000-8000-0000000007a1'], mode: 'add' }]);
      return run([{ op: 'setLayer', layerId: '00000000-0000-4000-8000-0000000007a1', patch: { locked: true } }]);
    }],
    ['a group the branch is in', async (run: any, el: any) => {
      await run([{ op: 'group', targets: ['tap', 'c'], id: '00000000-0000-4000-8000-0000000007a2' }]);
      return run([{ op: 'set', target: '00000000-0000-4000-8000-0000000007a2', patch: { locked: true } }]);
    }],
  ])('keeps a branch locked through %s where it is: Beautify skips the connector it joins, and a hand-made commit is refused', async (_kind, lock) => {
    const { t, page, run, el } = await setup();
    await run([{ op: 'set', target: 'bus', patch: { route: 'orthogonal' } }]);
    await run([branch('tap', 'bus', 0.5)]);
    expect((await lock(run, el)).ok).toBe(true);
    const busId = el('bus').id;
    const points = [{ x: 40, y: 120 }, { x: 50, y: 120 }, { x: 50, y: 200 }, { x: 290, y: 200 }, { x: 290, y: 120 }, { x: 300, y: 120 }];
    const preview = await buildBeautifyPreview(t.store.snapshot().document, page, [busId]);
    expect(preview.targets).toEqual([]);
    expect(preview.skipped).toEqual([{ id: busId, reason: 'a locked connector is joined to this one' }]);

    const tapBefore = JSON.stringify(el('tap')), docBefore = JSON.stringify(t.store.snapshot().document), revision = t.engine.revision;
    const refused = await run([{ op: 'beautify', pageId: page, baseRevision: revision, targets: [busId], routes: [{ id: busId, points }], includeManual: false }]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.details).toMatchObject({ target: busId, lockedConnectorIds: [el('tap').id] });
    expect(JSON.stringify(el('tap'))).toBe(tapBefore);
    expect(el('tap').to.join).toEqual({ connectorId: busId, position: 0.5 }); // still joined, still at (170,120)
    expect(JSON.stringify(t.store.snapshot().document)).toBe(docBefore);
    expect(t.engine.revision).toBe(revision);
  });

  it('protects a locked branch two joins down, and still lets an unlocked one follow', async () => {
    const { t, page, run, el } = await setup();
    await run([{ op: 'set', target: 'bus', patch: { route: 'orthogonal' } }]);
    await run([branch('tap', 'bus', 0.5), branch('tap2', 'tap', 0.5)]);
    const busId = el('bus').id;
    const points = [{ x: 40, y: 120 }, { x: 50, y: 120 }, { x: 50, y: 200 }, { x: 290, y: 200 }, { x: 290, y: 120 }, { x: 300, y: 120 }];
    expect((await run([{ op: 'set', target: 'tap2', patch: { locked: true } }])).ok).toBe(true);
    expect((await buildBeautifyPreview(t.store.snapshot().document, page, [busId])).targets).toEqual([]);
    expect((await run([{ op: 'set', target: 'tap2', patch: { locked: false } }])).ok).toBe(true);
    const free = await run([{ op: 'beautify', pageId: page, baseRevision: t.engine.revision, targets: [busId], routes: [{ id: busId, points }], includeManual: false }]);
    expect(free.ok, JSON.stringify(free)).toBe(true);
    expect(el('tap').to.point).toEqual({ x: 170, y: 200 }); // unlocked, so it follows
  });

  it('can be joined by patching an existing connector, and released by giving it a point', async () => {
    const { run, el } = await setup();
    await run([{ op: 'createConnector', alias: 'tap', from: { elementId: 'c', glue: 'dynamic' }, to: { glue: 'none', point: { x: 10, y: 10 } } }]);
    expect((await run([{ op: 'set', target: 'tap', patch: { to: { glue: 'none', join: { connector: 'bus', position: 0.75 } } } }])).ok).toBe(true);
    expect(el('tap').to.point).toEqual({ x: 245, y: 120 });
    expect((await run([{ op: 'set', target: 'tap', patch: { to: { glue: 'none', point: { x: 5, y: 5 } } } }])).ok).toBe(true);
    expect(el('tap').to.join).toBeUndefined();
    expect(el('tap').to.point).toEqual({ x: 5, y: 5 });
  });

  it('can itself be joined (a branch of a branch) and both follow', async () => {
    const { run, el } = await setup();
    await run([branch('tap', 'bus', 0.5)]);
    await run([{ op: 'createShape', alias: 'd', bounds: { x: 400, y: 300, width: 40, height: 40 } }]);
    await run([{ op: 'createConnector', alias: 'sub', from: { elementId: 'd', glue: 'dynamic' }, to: { glue: 'none', join: { connector: 'tap', position: 0.5 } } }]);
    const was = el('sub').to.point;
    await run([{ op: 'move', target: 'b', delta: { xPt: 100, yPt: 0 } }]);
    expect(el('tap').to.point.x).toBe(220);
    expect(el('sub').to.point.x).not.toBe(was.x); // the middle of tap moved because tap's end did
  });

  it('is released where it stands when the connector it joined is deleted', async () => {
    const { run, el } = await setup();
    await run([branch('tap', 'bus', 0.5)]);
    const stood = el('tap').to.point;
    expect((await run([{ op: 'delete', target: 'bus' }])).ok).toBe(true);
    expect(el('tap').to.join).toBeUndefined();
    expect(el('tap').to.point).toEqual(stood);
  });

  it('is refused for itself, for a shape, for a loop, and for a position off the line', async () => {
    const { run } = await setup();
    await run([branch('tap', 'bus', 0.5)]);
    const bad = async (to: object, why: RegExp) => {
      const r = await run([{ op: 'createConnector', alias: `x${Math.random()}`, from: { elementId: 'c', glue: 'dynamic' }, to }]);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).toMatch(why);
    };
    await bad({ glue: 'none', join: { connector: 'a' } }, /not a connector/);
    await bad({ glue: 'none', join: { connector: 'bus', position: 1.5 } }, /<= 1/);
    await bad({ glue: 'dynamic', join: { connector: 'bus' } }, /glue none/);
    const loop = await run([{ op: 'set', target: 'bus', patch: { from: { glue: 'none', join: { connector: 'tap' } } } }]);
    expect(loop.ok).toBe(false);
    expect(JSON.stringify(loop)).toMatch(/loop/);
    const self = await run([{ op: 'set', target: 'tap', patch: { from: { glue: 'none', join: { connector: 'tap' } } } }]);
    expect(JSON.stringify(self)).toMatch(/itself/);
  });
});

describe('copies of a branch', () => {
  it('join the copied connector when it is copied too, and are released where they land when it is not', async () => {
    const { run, el, t } = await setup();
    await run([branch('tap', 'bus', 0.5)]);
    const all = t.store.snapshot().document.pages[0]!.elements.filter(e => e.kind === 'connector').map(e => e.id);
    // both copied: the copy of the branch joins the copy of the bus
    expect((await run([{ op: 'duplicate', targets: ['a', 'b', 'c', 'bus', 'tap'], offset: { xPt: 0, yPt: 400 }, keepAliases: true }])).ok).toBe(true);
    const copies = t.store.snapshot().document.pages[0]!.elements.filter(e => e.kind === 'connector' && !all.includes(e.id)) as unknown as Array<Element & Record<string, any>>;
    const tapCopy = copies.find(c => c.alias === 'tap-2' || c.to.join)!;
    const busCopy = copies.find(c => c !== tapCopy)!;
    expect(tapCopy.to.join.connectorId).toBe(busCopy.id);
    expect(tapCopy.to.point.y).toBe(520);
    // the branch copied alone is released and keeps the shifted point
    expect((await run([{ op: 'duplicate', targets: ['tap'], offset: { xPt: 0, yPt: 40 }, keepExternalLinks: true }])).ok).toBe(true);
    const alone = t.store.snapshot().document.pages[0]!.elements.filter(e => e.kind === 'connector' && !all.includes(e.id) && !copies.some(c => c.id === e.id)) as unknown as Array<Record<string, any>>;
    expect(alone).toHaveLength(1);
    expect(alone[0]!.to.join).toBeUndefined();
    expect(alone[0]!.to.point).toEqual({ x: 170, y: 160 });
    expect(el('tap').to.join).toBeDefined();
  });
});

describe('hops', () => {
  it('are off unless asked for, can be turned on at creation or by patch, and turned off again', async () => {
    const { run, el } = await setup();
    expect(el('bus').hops).toBeUndefined();
    await run([{ op: 'set', target: 'bus', patch: { hops: 'arc' } }]);
    expect(el('bus').hops).toBe('arc');
    await run([{ op: 'set', target: 'bus', patch: { hops: 'none' } }]);
    expect(el('bus').hops).toBeUndefined();
    await run([{ op: 'createConnector', alias: 'hopper', from: { elementId: 'a', glue: 'dynamic' }, to: { elementId: 'c', glue: 'dynamic' }, hops: 'arc' }]);
    expect(el('hopper').hops).toBe('arc');
  });
});
