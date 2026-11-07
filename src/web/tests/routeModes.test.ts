import { describe, expect, it } from 'vitest';
import type { ConnectorElement, Element, Operation, Projection, Snapshot, TransactionResult } from '../src/contracts/generated';
import { newDocument } from '../src/model/newDocument';
import { planRoutes, routeDefects } from '../src/layout/routePlanner';
import { canonicalSerialize } from '../src/model/canonical';
import { ok } from '../src/model/result';
import { createTestEngine } from './support/engine';

const box = (x: number, y: number, width = 100, height = 60) => ({ x, y, width, height });

/** Minimal snapshot projector for join settlement: connectors follow endpoint centers and explicit join points. */
function joinedRouteProjection(snapshot: Snapshot) {
  const connectors: Projection['connectors'] = {};
  for (const page of snapshot.document.pages) {
    const byId = new Map(page.elements.map(e => [e.id, e] as const));
    const endpoint = (ep: ConnectorElement['from']) => {
      if (ep.point) return ep.point;
      const bounds = byId.get(ep.elementId ?? '')?.bounds;
      return bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : { x: 0, y: 0 };
    };
    for (const element of page.elements) {
      if (element.kind !== 'connector') continue;
      const points = [endpoint(element.from), ...element.waypoints, endpoint(element.to)];
      connectors[element.id] = { routePoints: points, visualBounds: { x: 0, y: 0, width: 0, height: 0 } };
    }
  }
  return ok({ documentId: snapshot.documentId, sessionId: snapshot.sessionId, revision: snapshot.revision, connectors, groupVisualBounds: {} } as Projection);
}

async function setup(extra: object[] = []) {
  const t = createTestEngine({ document: newDocument() });
  const page = t.store.snapshot().document.pages[0]!.id;
  const run = async (ops: object[]) => t.engine.execute(t.request(ops.map(o => ((o as { op: string }).op.startsWith('create') ? { pageId: page, ...o } : o) as Operation)), 'mcp');
  const ok = async (ops: object[]): Promise<TransactionResult> => {
    const r = await run(ops);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.value;
  };
  await ok([
    { op: 'createShape', alias: 'a', bounds: box(0, 100) },
    { op: 'createShape', alias: 'b', bounds: box(700, 100) },
    { op: 'createShape', alias: 'c', bounds: box(0, 400) },
    { op: 'createShape', alias: 'd', bounds: box(700, 400) },
    { op: 'createShape', alias: 'far', bounds: box(1200, 900, 40, 40) },
    { op: 'createConnector', alias: 'ab', from: { elementId: 'a', port: 'east', glue: 'static' }, to: { elementId: 'b', port: 'west', glue: 'static' }, route: 'orthogonal' },
    { op: 'createConnector', alias: 'cd', from: { elementId: 'c', port: 'east', glue: 'static' }, to: { elementId: 'd', port: 'west', glue: 'static' }, route: 'orthogonal' },
    { op: 'createConnector', alias: 'straight', from: { elementId: 'a', glue: 'dynamic' }, to: { elementId: 'c', glue: 'dynamic' } },
    ...extra,
  ]);
  const doc = () => t.store.snapshot().document;
  const el = (alias: string) => doc().pages[0]!.elements.find(e => e.alias === alias) as Element & Record<string, any>;
  const conn = (alias: string) => el(alias) as unknown as ConnectorElement;
  return { t, page, run, ok, doc, el, conn };
}

describe('stored routes (R20)', () => {
  it('stores the route of automatic orthogonal connectors only', async () => {
    const s = await setup();
    expect(s.conn('ab').routing?.advisory?.length).toBeGreaterThanOrEqual(2);
    expect(s.conn('cd').routing?.advisory).toBeDefined();
    expect(s.conn('straight').routing).toBeUndefined();
    expect(routeDefects(s.conn('ab').routing!.advisory!)).toEqual([]);
  });

  it('a 1 pt nudge of an unrelated shape changes no connector and reports no route change', async () => {
    const s = await setup();
    const result = await s.ok([{ op: 'move', target: 'far', delta: { xPt: 1, yPt: 0 } }]);
    expect(result.changed).toEqual([s.el('far').id]);
    expect(result.routeChanges ?? []).toEqual([]);
  });

  it('moving an end shape changes that connector, names it in changed and routeChanges, and undo restores the route exactly', async () => {
    const s = await setup();
    const before = canonicalSerialize(s.doc().pages);
    const result = await s.ok([{ op: 'move', target: 'b', delta: { xPt: 0, yPt: 40 } }]);
    const ab = s.conn('ab');
    expect(result.changed).toContain(ab.id);
    expect(result.routeChanges?.find(c => c.id === ab.id)?.provenance).toMatch(/elastic|rerouted|kept/);
    expect(result.changed).not.toContain(s.conn('cd').id);
    expect(ab.routing!.advisory![ab.routing!.advisory!.length - 1]!.y).toBe(170);
    const undo = await s.t.engine.undo({ ...s.t.scope(), transactionId: '00000000-0000-4000-8000-0000000000aa', baseRevision: s.t.engine.revision });
    expect(undo.ok).toBe(true);
    expect(canonicalSerialize(s.doc().pages)).toBe(before);
  });

  it('a joined branch stores the route from the settled join endpoint', async () => {
    const s = await setup();
    s.t.engine.setSnapshotProjector(joinedRouteProjection);
    await s.ok([{
      op: 'createConnector', alias: 'branch', route: 'orthogonal',
      from: { elementId: 'c', glue: 'dynamic' },
      to: { glue: 'none', join: { connector: 'ab', position: 0.5 } },
    }]);
    const before = s.conn('branch').routing!.advisory!;

    const result = await s.ok([{ op: 'move', target: 'b', delta: { xPt: 20, yPt: 40 } }]);
    const branch = s.conn('branch');
    const endpoint = branch.to.point!;
    const stored = branch.routing!.advisory!;

    expect(endpoint).not.toEqual(before[before.length - 1]);
    expect(stored[stored.length - 1]).toEqual(endpoint);
    expect(result.changed).toContain(branch.id);
    expect(result.routeChanges?.some(change => change.id === branch.id)).toBe(true);
  });

  it('planning a document again from its stored routes changes nothing', async () => {
    const s = await setup();
    const page = s.doc().pages[0]!;
    const again = planRoutes({ elements: page.elements, layers: page.layers, pageArea: page.widthPt * page.heightPt });
    expect(again.changes).toEqual([]);
    expect([...again.routes.values()].every(r => r.provenance === 'kept')).toBe(true);
    const renamed = await s.ok([{ op: 'set', target: 'ab', patch: { name: 'x' } }]);
    expect(renamed.changed).toEqual([s.conn('ab').id]);
    expect(renamed.routeChanges ?? []).toEqual([]);
  });

  it('copies and moves carry the stored route with them', async () => {
    const s = await setup();
    const was = s.conn('ab').routing!.advisory!;
    await s.ok([{ op: 'duplicate', targets: ['a', 'b', 'ab'], offset: { xPt: 0, yPt: 300 } }]);
    const copy = s.doc().pages[0]!.elements.filter(e => e.kind === 'connector' && e.alias !== 'ab' && e.routing?.advisory && e.route === 'orthogonal' && e.id !== s.conn('cd').id);
    expect(copy.length).toBeGreaterThan(0);
    const dup = copy.find(c => (c as ConnectorElement).routing!.advisory![0]!.y === was[0]!.y + 300) as ConnectorElement | undefined;
    expect(dup).toBeDefined();
    expect(routeDefects(dup!.routing!.advisory!)).toEqual([]);
  });
});

describe('route modes (R20)', () => {
  it('manual keeps the drawn route as waypoints and stores no route; automatic forgets both', async () => {
    const s = await setup();
    const drawn = s.conn('ab').routing!.advisory!;
    await s.ok([{ op: 'set', target: 'ab', patch: { routing: { mode: 'manual' } } }]);
    const manual = s.conn('ab');
    expect(manual.waypoints.length).toBeGreaterThan(0);
    expect(manual.routing).toBeUndefined();
    const page = s.doc().pages[0]!;
    const route = planRoutes({ elements: page.elements, layers: page.layers, pageArea: 1e6 }).routes.get(manual.id)!;
    expect(route.provenance).toBe('authored');
    expect(route.points).toEqual(drawn);
    await s.ok([{ op: 'set', target: 'ab', patch: { routing: { mode: 'automatic' } } }]);
    expect(s.conn('ab').waypoints).toEqual([]);
    expect(s.conn('ab').routing?.advisory).toBeDefined();
  });

  it('frozen keeps the route as it is, follows a small end move, and never searches around a new obstacle', async () => {
    const s = await setup();
    await s.ok([{ op: 'set', target: 'ab', patch: { routing: { mode: 'frozen' } } }]);
    const frozen = s.conn('ab');
    expect(frozen.routing?.mode).toBe('frozen');
    expect(frozen.waypoints).toEqual([]);
    const stored = frozen.routing!.advisory!.map(p => ({ ...p }));
    const obstacle = await s.ok([{ op: 'createShape', alias: 'wall', bounds: box(330, 90, 40, 80) }]);
    expect(s.conn('ab').routing!.advisory).toEqual(stored); // the obstacle did not move the route
    expect(obstacle.routeFindings).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_ROUTE', elementId: s.conn('ab').id, blockerIds: [s.el('wall').id] }));
    const blockedFollow = await s.ok([{ op: 'move', target: 'b', delta: { xPt: 0, yPt: 20 } }]);
    const followedAcrossExistingBlocker = s.conn('ab').routing!.advisory!;
    expect(followedAcrossExistingBlocker.at(-1)!.y).toBe(stored.at(-1)!.y + 20);
    expect(blockedFollow.routeChanges?.find(c => c.id === s.conn('ab').id)?.provenance).toBe('unresolved');
    expect(blockedFollow.routeFindings).toContainEqual(expect.objectContaining({ code: 'UNRESOLVED_ROUTE', elementId: s.conn('ab').id, blockerIds: [s.el('wall').id] }));
    await s.ok([{ op: 'delete', target: 'wall' }]);
    const result = await s.ok([{ op: 'move', target: 'b', delta: { xPt: 0, yPt: 20 } }]);
    const now = s.conn('ab').routing!.advisory!;
    expect(result.changed).toContain(s.conn('ab').id);
    expect(now[now.length - 1]!.y).toBe(stored[stored.length - 1]!.y + 40);
    expect(s.conn('ab').routing!.mode).toBe('frozen');
    expect(s.conn('ab').waypoints).toEqual([]);
  });

  it('frozen that cannot follow an end safely keeps the stored route and flags it unresolved', async () => {
    const s = await setup();
    await s.ok([{ op: 'set', target: 'ab', patch: { routing: { mode: 'frozen' } } }]);
    const stored = s.conn('ab').routing!.advisory!.map(p => ({ ...p }));
    // b jumps to the other side of a, so the stored east-to-west route cannot follow
    const result = await s.ok([{ op: 'move', target: 'b', delta: { xPt: -900, yPt: 0 } }]);
    expect(s.conn('ab').routing!.advisory).toEqual(stored);
    expect(result.routeChanges?.find(c => c.id === s.conn('ab').id)?.provenance).toBe('unresolved');
  });

  it('a frozen route refuses waypoint edits with a structured error and nothing changes', async () => {
    const s = await setup();
    await s.ok([{ op: 'set', target: 'ab', patch: { routing: { mode: 'frozen' } } }]);
    const rev = s.t.engine.revision;
    const r = await s.run([{ op: 'set', target: 'ab', patch: { waypoints: [{ x: 300, y: 130 }] } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toMatch(/route_frozen|frozen/);
    expect(s.t.engine.revision).toBe(rev);
  });

  it('guided is refused with a clear error and is never persisted', async () => {
    const s = await setup();
    const rev = s.t.engine.revision;
    const r = await s.run([{ op: 'set', target: 'ab', patch: { routing: { mode: 'guided' } } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).toMatch(/guided/);
    expect(s.t.engine.revision).toBe(rev);
    expect(s.conn('ab').routing?.mode).toBeUndefined();
  });

  it('route modes are refused on connectors that are not orthogonal', async () => {
    const s = await setup();
    const r = await s.run([{ op: 'set', target: 'straight', patch: { routing: { mode: 'frozen' } } }]);
    expect(r.ok).toBe(false);
  });

  it('reroute forgets the stored route, reports what changed, and is undoable', async () => {
    const s = await setup([{ op: 'createShape', alias: 'wall', bounds: box(330, 90, 40, 80) }]);
    const detour = s.conn('ab').routing!.advisory!;
    expect(detour.length).toBeGreaterThan(2);
    await s.ok([{ op: 'delete', target: 'wall' }]); // gain is under the straighten limit only if small; force the explicit path either way
    const before = canonicalSerialize(s.doc().pages);
    const result = await s.ok([{ op: 'reroute' }]);
    expect(s.conn('ab').routing!.advisory!.length).toBe(2);
    expect(result.changed).toContain(s.conn('ab').id);
    expect(result.routeChanges?.some(c => c.id === s.conn('ab').id)).toBe(true);
    const undo = await s.t.engine.undo({ ...s.t.scope(), transactionId: '00000000-0000-4000-8000-0000000000ab', baseRevision: s.t.engine.revision });
    expect(undo.ok).toBe(true);
    expect(canonicalSerialize(s.doc().pages)).toBe(before);
  });

  it('reroute with UUID targets needs no page scope on a multipage document; other targeting keeps its rules (R25)', async () => {
    const s = await setup([{ op: 'createShape', alias: 'wall', bounds: box(330, 122, 40, 16) }]);
    await s.ok([{ op: 'addPage', id: '00000000-0000-4000-8000-0000000000f2', name: 'Second' }, { op: 'delete', target: 'wall' }]);
    const ab = s.conn('ab'), cd = s.conn('cd');
    const before = ab.routing!.advisory!;
    expect(before.length).toBeGreaterThan(2); // the detour is kept after the wall goes: only an explicit reroute straightens it

    const rerouted = await s.run([{ op: 'reroute', targets: [ab.id] }]);
    expect(rerouted.ok, JSON.stringify(!rerouted.ok && rerouted.error)).toBe(true);
    expect(s.conn('ab').routing!.advisory!.length).toBe(2);
    expect(s.conn('cd')).toEqual(cd);

    const code = async (ops: object[], pageId?: string) => {
      const r = await s.t.engine.execute(s.t.request(ops as Operation[], pageId ? { pageId } : {}), 'mcp');
      return r.ok ? 'ok' : r.error.code;
    };
    expect(await code([{ op: 'reroute', targets: ['00000000-0000-4000-8000-0000000000ee'] }])).toBe('not_found');
    expect(await code([{ op: 'reroute', targets: [ab.id] }], '00000000-0000-4000-8000-0000000000ef')).toBe('not_found');
    expect(await code([{ op: 'reroute', targets: ['ab'] }])).toBe('invalid_request'); // an alias still needs a page
    expect(await code([{ op: 'reroute', targets: ['ab'] }], s.page)).toBe('ok');
    expect(await code([{ op: 'reroute' }])).toBe('invalid_request'); // no targets: which page is still asked
    expect(await code([{ op: 'reroute' }], s.page)).toBe('ok');

    await s.ok([{ op: 'set', target: cd.id, patch: { routing: { mode: 'frozen' } } }]);
    const frozen = await s.run([{ op: 'reroute', targets: [cd.id] }]);
    expect(!frozen.ok && frozen.error.details?.reason).toBe('route_not_automatic');
    await s.ok([{ op: 'set', target: ab.id, patch: { locked: true } }]);
    expect(await code([{ op: 'reroute', targets: [ab.id] }])).toBe('locked_target');
  });

  it('reroute named for a manual or frozen connector is refused; unnamed it skips them', async () => {
    const s = await setup();
    await s.ok([{ op: 'set', target: 'ab', patch: { routing: { mode: 'frozen' } } }]);
    const named = await s.run([{ op: 'reroute', targets: ['ab'] }]);
    expect(named.ok).toBe(false);
    const all = await s.run([{ op: 'reroute' }]);
    expect(all.ok).toBe(true);
    expect(s.conn('ab').routing?.mode).toBe('frozen');
  });
});
