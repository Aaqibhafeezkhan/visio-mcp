import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConnectorElement, DiagramDocument, Element, Operation, Projection, RequestEnvelope, Snapshot, TransactionResult } from '../src/contracts/generated';
import { createEngineHandler } from '../src/bridge/engineHandlers';
import type { RouteProposal } from '../src/bridge/proposeRoutes';
import { planRoutes, type PlannedRoute } from '../src/layout/routePlanner';
import { canonicalSerialize } from '../src/model/canonical';
import { newDocument } from '../src/model/newDocument';
import { fail, ok, type Result } from '../src/model/result';
import { createTestEngine } from './support/engine';

const box = (x: number, y: number, width = 100, height = 60) => ({ x, y, width, height });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * A stand-in for the hidden projector: routes come from the pure planner. With `memory` it behaves like the real adapter, which remembers the
 * routes it planned last and uses them for connectors that have no stored route; `isolate` saves and restores that memory.
 */
function plannerProjector(opts: { memory?: boolean } = {}) {
  let memory = new Map<string, PlannedRoute>();
  let depth = 0;
  const stats = { calls: 0, insideIsolate: 0, isolations: 0 };
  const project = (snapshot: Snapshot): Result<Projection> => {
    stats.calls++;
    if (depth) stats.insideIsolate++;
    const connectors: Projection['connectors'] = {};
    for (const page of snapshot.document.pages) {
      const plan = planRoutes({ elements: page.elements, layers: page.layers, pageArea: page.widthPt * page.heightPt, ...(opts.memory ? { previous: memory } : {}) });
      if (opts.memory) memory = plan.routes;
      const byId = new Map(page.elements.map(e => [e.id, e] as const));
      const centre = (ep: ConnectorElement['from']) => {
        const b = byId.get(ep.elementId ?? '')?.bounds;
        return ep.point ?? (b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 });
      };
      for (const e of page.elements) {
        if (e.kind !== 'connector') continue;
        const r = plan.routes.get(e.id);
        connectors[e.id] = { routePoints: r ? r.points : [centre(e.from), centre(e.to)], visualBounds: { x: 0, y: 0, width: 0, height: 0 }, ...(r ? { routeProvenance: r.provenance } : {}) };
      }
    }
    return ok({ documentId: snapshot.documentId, sessionId: snapshot.sessionId, revision: snapshot.revision, connectors, groupVisualBounds: {} } as Projection);
  };
  const isolate = <T,>(run: () => T): T => {
    stats.isolations++; depth++;
    const saved = memory;
    try { return run(); } finally { memory = saved; depth--; }
  };
  return { project, isolate, stats, seed(id: string, points: Array<{ x: number; y: number }>) { memory = new Map(memory).set(id, { points, provenance: 'kept', fixed: {}, ends: { a: { anchor: points[0]!, dir: { x: Math.sign(points[1]!.x - points[0]!.x), y: Math.sign(points[1]!.y - points[0]!.y) } }, b: { anchor: points[points.length - 1]!, dir: { x: Math.sign(points[points.length - 2]!.x - points[points.length - 1]!.x), y: Math.sign(points[points.length - 2]!.y - points[points.length - 1]!.y) } } } }); } };
}

type T = ReturnType<typeof createTestEngine>;
function harness(t: T) {
  const handler = createEngineHandler(t.engine);
  let tx = 70_000;
  const call = async (method: string, params: Record<string, unknown>) =>
    handler({ protocolVersion: 1, kind: 'request', requestId: 'q', method, ...t.scope(), params } as RequestEnvelope);
  const propose = async (params: Record<string, unknown> = {}) => {
    const r = await call('doc.proposeRoutes', params);
    return r.error ? { ok: false as const, error: r.error } : { ok: true as const, value: r.result as RouteProposal };
  };
  const mustPropose = async (params: Record<string, unknown> = {}) => {
    const r = await propose(params);
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} ${JSON.stringify(r.error.details)}`);
    return r.value;
  };
  /** Exactly what apply_operations sends: no page scope. */
  const apply = async (commit: NonNullable<RouteProposal['commit']>, transactionId = uuid(++tx)) =>
    call('doc.apply', { transactionId, baseRevision: commit.baseRevision, atomic: true, operations: commit.operations });
  const mustApply = async (commit: NonNullable<RouteProposal['commit']>) => {
    const r = await apply(commit);
    if (r.error) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.result as TransactionResult;
  };
  const run = async (ops: object[], pageId?: string) => {
    const r = await t.engine.execute(t.request(ops as Operation[], pageId ? { pageId } : {}), 'mcp');
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    return r.value;
  };
  const doc = () => t.store.snapshot().document;
  const find = (ref: string): Element => { for (const p of doc().pages) for (const e of p.elements) if (e.id === ref || e.alias === ref) return e; throw new Error(`no ${ref}`); };
  const conn = (ref: string) => find(ref) as ConnectorElement;
  return { call, propose, mustPropose, apply, mustApply, run, doc, find, conn };
}

/** Everything a proposal must leave alone: committed state, history, cache, status, events (ids are checked by creating one after). */
function observe(t: T, events: unknown[]) {
  const engine = t.engine as unknown as { cache: Map<string, unknown>; sequence: number };
  return canonicalSerialize({
    doc: t.store.snapshot().document, revision: t.engine.revision, status: t.engine.status(), undo: t.engine.undoHead() ?? null, redo: t.engine.redoHead() ?? null,
    recent: t.engine.recentTransactions(), cache: [...engine.cache.keys()], sequence: engine.sequence, events: events.length,
  });
}

/**
 * Shapes a and b joined by `ab` on fixed ports. A small wall forces a detour; once it is deleted the detour is kept (under the straighten
 * limit), so only an explicit reroute straightens it.
 */
async function scene(opts: { projector?: ReturnType<typeof plannerProjector> | null; extra?: object[]; document?: DiagramDocument } = {}) {
  const t = createTestEngine({ document: opts.document ?? newDocument() });
  const projector = opts.projector === undefined ? plannerProjector() : opts.projector;
  if (projector) t.engine.setSnapshotProjector(projector.project, projector.isolate);
  const h = harness(t);
  const page = h.doc().pages[0]!.id;
  const events: unknown[] = [];
  t.engine.onCommitted(e => events.push(e));
  if (!opts.document) {
    await h.run([
      { op: 'createShape', pageId: page, alias: 'a', bounds: box(0, 100) },
      { op: 'createShape', pageId: page, alias: 'b', bounds: box(700, 100) },
      { op: 'createShape', pageId: page, alias: 'c', bounds: box(300, 400) },
      { op: 'createShape', pageId: page, alias: 'd', bounds: box(700, 400) },
      { op: 'createShape', pageId: page, alias: 'wall', bounds: box(330, 122, 40, 16) },
      { op: 'createConnector', pageId: page, alias: 'ab', from: { elementId: 'a', port: 'east', glue: 'static' }, to: { elementId: 'b', port: 'west', glue: 'static' }, route: 'orthogonal' },
      ...(opts.extra ?? []),
    ]);
    await h.run([{ op: 'delete', target: 'wall' }]);
  }
  return { t, h, page, projector, events };
}

describe('route proposals (R25)', () => {
  it('proposes a reroute without changing anything, and the commit stores exactly the proposed route in one undoable transaction', async () => {
    const { t, h, events } = await scene();
    const ab = h.conn('ab');
    expect(ab.routing!.advisory!.length).toBeGreaterThan(2);
    const before = observe(t, events);

    const proposal = await h.mustPropose({ connectorIds: [ab.id] });
    expect(observe(t, events)).toBe(before);
    // the scene used six live ids (a, b, c, d, wall, ab); the next is still the seventh, so the proposal created nothing on the side
    expect(t.idFactory()).toBe(`00000000-0000-4000-8000-1${String(7).padStart(11, '0')}`);
    expect(proposal).toMatchObject({ documentId: t.documentId, sessionId: t.sessionId, revision: t.engine.revision, pageId: h.doc().pages[0]!.id, strategy: 'reroute', skipped: [] });
    const route = proposal.routes[0]!;
    expect(route).toMatchObject({ id: ab.id, geometryChanged: true, provenance: 'rerouted', bends: 0, lengthPt: 600 });
    expect(route.points).toEqual([{ x: 100, y: 130 }, { x: 700, y: 130 }]);
    expect(proposal.visuallyAffectedIds).toEqual([ab.id]);
    expect(proposal.commit).toEqual({ baseRevision: t.engine.revision, operations: [{ op: 'reroute', targets: [ab.id] }] });

    const again = await h.mustPropose({ connectorIds: [ab.id] });
    expect(again).toEqual(proposal); // deterministic

    const pre = canonicalSerialize(h.doc().pages);
    const committed = await h.apply(proposal.commit!, uuid(7777));
    expect(committed.error).toBeUndefined();
    expect(h.conn('ab').routing!.advisory).toEqual(route.points);
    const result = committed.result as TransactionResult;
    expect(result.changed).toContain(ab.id);
    const retry = await h.apply(proposal.commit!, uuid(7777)); // same transaction id and payload: the original result, applied once
    expect(retry.result).toEqual(result);
    expect(t.engine.revision).toBe(result.revision);

    const undo = await t.engine.undo({ ...t.scope(), transactionId: uuid(7778), baseRevision: t.engine.revision });
    expect(undo.ok).toBe(true);
    expect(canonicalSerialize(h.doc().pages)).toBe(pre);
  });

  it('a commit made stale by another edit is refused with revision_conflict', async () => {
    const { h } = await scene();
    const proposal = await h.mustPropose({ connectorIds: [h.conn('ab').id] });
    await h.run([{ op: 'move', target: 'c', delta: { xPt: 1, yPt: 0 } }]);
    const stale = await h.apply(proposal.commit!);
    expect(stale.error?.code).toBe('revision_conflict');
  });

  it('offers no commit when the reroute would not change the drawing', async () => {
    const { t, h } = await scene();
    await h.run([{ op: 'reroute', targets: [h.conn('ab').id] }]);
    const proposal = await h.mustPropose({ connectorIds: [h.conn('ab').id] });
    expect(proposal.routes[0]!.geometryChanged).toBe(false);
    expect(proposal.commit).toBeUndefined();
    // a raw reroute still behaves as before: it records the explicit replan as a transaction
    const raw = await h.run([{ op: 'reroute', targets: [h.conn('ab').id] }]);
    expect(raw.noChange).toBe(false);
    expect(t.engine.revision).toBe(raw.revision);
  });

  it('a joined branch outside the selection is a dependency_conflict; included, the committed geometry is the proposed geometry', async () => {
    const { t, h, events } = await scene({ extra: [
      { op: 'createConnector', alias: 'tap', from: { elementId: 'c', glue: 'dynamic' }, to: { glue: 'none', join: { connector: 'ab', position: 0.5 } }, route: 'orthogonal' },
    ] });
    const ab = h.conn('ab'), tap = h.conn('tap');
    const before = observe(t, events);
    const scoped = await h.propose({ connectorIds: [ab.id] });
    expect(!scoped.ok && scoped.error).toMatchObject({ code: 'dependency_conflict', details: { connectorIds: [tap.id] } });
    expect(observe(t, events)).toBe(before);

    const both = await h.mustPropose({ connectorIds: [tap.id, ab.id] });
    expect(both.commit?.operations).toEqual([{ op: 'reroute', targets: [ab.id, tap.id].sort() }]);
    await h.mustApply(both.commit!);
    for (const r of both.routes) expect(h.conn(r.id).routing!.advisory).toEqual(r.points);
    expect(h.conn('tap').to.point).toEqual(both.routes.find(r => r.id === tap.id)!.points.at(-1));
  });

  it('refuses when the commit would leave a joined branch on the trunk\'s old route', async () => {
    // a projector that remembers routes, as the real one does, still draws the trunk's old route while joins are settled
    const { t, h, events } = await scene({ projector: plannerProjector({ memory: true }), extra: [
      { op: 'createConnector', alias: 'tap', from: { elementId: 'c', glue: 'dynamic' }, to: { glue: 'none', join: { connector: 'ab', position: 0.5 } }, route: 'orthogonal' },
    ] });
    const before = observe(t, events);
    for (const ids of [[h.conn('ab').id], [h.conn('ab').id, h.conn('tap').id]]) {
      const r = await h.propose({ connectorIds: ids });
      expect(!r.ok && r.error).toMatchObject({ code: 'dependency_conflict', details: { connectorIds: [h.conn('tap').id], reason: 'join_not_followed' } });
    }
    expect(observe(t, events)).toBe(before);
  });

  it('an attached label moves with its connector: reported, committed and undone together', async () => {
    const { t, h } = await scene({ extra: [
      { op: 'createText', alias: 'note', bounds: { x: 0, y: 0, width: 60, height: 20 }, text: { value: 'flows' }, attachment: { connector: 'ab', position: 0.5, offsetPt: -12 } },
    ] });
    const note = h.find('note');
    const proposal = await h.mustPropose({ connectorIds: [h.conn('ab').id] });
    expect(proposal.visuallyAffectedIds).toEqual(expect.arrayContaining([h.conn('ab').id, note.id]));
    const pre = canonicalSerialize(h.doc().pages);
    await h.mustApply(proposal.commit!);
    expect(h.find('note').bounds).not.toEqual(note.bounds);
    expect((await t.engine.undo({ ...t.scope(), transactionId: uuid(8001), baseRevision: t.engine.revision })).ok).toBe(true);
    expect(canonicalSerialize(h.doc().pages)).toBe(pre);
  });

  it('page scope reroutes every eligible connector, lists the others as skipped, and commits all of them, changed or not', async () => {
    const { h, page } = await scene({ extra: [
      { op: 'createConnector', alias: 'cd', from: { elementId: 'c', port: 'east', glue: 'static' }, to: { elementId: 'd', port: 'west', glue: 'static' }, route: 'orthogonal' },
      { op: 'createConnector', alias: 'manual', from: { elementId: 'a', glue: 'dynamic' }, to: { elementId: 'c', glue: 'dynamic' }, route: 'orthogonal', waypoints: [{ x: 50, y: 300 }] },
      { op: 'createConnector', alias: 'straight', from: { elementId: 'b', glue: 'dynamic' }, to: { elementId: 'd', glue: 'dynamic' } },
      { op: 'createConnector', alias: 'frozen', from: { elementId: 'a', port: 'south', glue: 'static' }, to: { elementId: 'c', port: 'north', glue: 'static' }, route: 'orthogonal' },
      { op: 'createConnector', alias: 'locked', from: { elementId: 'b', port: 'south', glue: 'static' }, to: { elementId: 'd', port: 'north', glue: 'static' }, route: 'orthogonal' },
    ] });
    await h.run([{ op: 'set', target: 'frozen', patch: { routing: { mode: 'frozen' } } }, { op: 'set', target: 'locked', patch: { locked: true } }]);
    const proposal = await h.mustPropose({ pageId: page });
    const ids = (...a: string[]) => a.map(x => h.conn(x).id).sort();
    expect(proposal.routes.map(r => r.id)).toEqual(ids('ab', 'cd'));
    expect(proposal.routes.find(r => r.id === h.conn('cd').id)!.geometryChanged).toBe(false);
    expect(proposal.skipped.map(s => s.id)).toEqual(ids('manual', 'straight', 'frozen', 'locked'));
    expect(proposal.skipped.find(s => s.id === h.conn('locked').id)!.reason).toBe('locked');
    expect(proposal.commit?.operations).toEqual([{ op: 'reroute', targets: ids('ab', 'cd') }]);
    await h.mustApply(proposal.commit!);
    for (const r of proposal.routes) expect(h.conn(r.id).routing!.advisory).toEqual(r.points);
  });

  it('page scope skips connectors on a locked layer or in a locked group; named, they are refused as a transaction would refuse them', async () => {
    const { h, page } = await scene({ extra: [
      { op: 'addLayer', id: uuid(901), name: 'Frozen layer' },
      { op: 'createConnector', alias: 'onLayer', layerIds: [uuid(901)], from: { elementId: 'c', port: 'east', glue: 'static' }, to: { elementId: 'd', port: 'west', glue: 'static' }, route: 'orthogonal' },
    ] });
    await h.run([{ op: 'setLayer', layerId: uuid(901), patch: { locked: true } }]);
    const proposal = await h.mustPropose({ pageId: page });
    expect(proposal.skipped).toEqual([{ id: h.conn('onLayer').id, reason: 'on a locked layer' }]);
    const named = await h.propose({ connectorIds: [h.conn('onLayer').id] });
    expect(!named.ok && named.error.code).toBe('locked_target');
  });

  it('connectors with no stored route: drawn geometry comes from the projection, and a reroute that changes nothing offers no commit', async () => {
    const built = await scene({ projector: plannerProjector() });
    const legacy = structuredClone(built.t.store.snapshot().document);
    for (const page of legacy.pages) for (const e of page.elements) if (e.kind === 'connector') delete (e as ConnectorElement).routing;
    const projector = plannerProjector({ memory: true });
    const { t, h, events } = await scene({ document: legacy, projector });
    const ab = h.conn('ab');
    const detour = [{ x: 100, y: 130 }, { x: 200, y: 130 }, { x: 200, y: 110 }, { x: 400, y: 110 }, { x: 400, y: 130 }, { x: 700, y: 130 }];
    projector.seed(ab.id, detour); // what this session drew earlier

    const before = observe(t, events);
    const proposal = await h.mustPropose({ connectorIds: [ab.id] });
    expect(observe(t, events)).toBe(before);
    expect(proposal.routes[0]).toMatchObject({ geometryChanged: false, provenance: 'kept', points: detour });
    expect(proposal.commit).toBeUndefined();
    const raw = await t.engine.execute(t.request([{ op: 'reroute', targets: [ab.id] }]), 'mcp');
    expect(raw.ok && raw.value.noChange).toBe(true); // and that is what the transaction would do
  });

  it('a stored route that settling would write on an outside connector with none is a dependency_conflict', async () => {
    const built = await scene({ extra: [
      { op: 'createConnector', alias: 'cd', from: { elementId: 'c', port: 'east', glue: 'static' }, to: { elementId: 'd', port: 'west', glue: 'static' }, route: 'orthogonal' },
    ] });
    const mixed = structuredClone(built.t.store.snapshot().document);
    const cdId = built.h.conn('cd').id;
    for (const page of mixed.pages) for (const e of page.elements) if (e.id === cdId) delete (e as ConnectorElement).routing;
    const { h, page } = await scene({ document: mixed });
    const scoped = await h.propose({ connectorIds: [h.conn('ab').id] });
    expect(!scoped.ok && scoped.error).toMatchObject({ code: 'dependency_conflict', details: { connectorIds: [cdId] } });
    const all = await h.mustPropose({ pageId: page });
    expect(all.commit).toBeDefined();
    await h.mustApply(all.commit!);
    for (const r of all.routes) expect(h.conn(r.id).routing!.advisory).toEqual(r.points);
  });

  it('runs inside the projector isolation, so a proposal does not change how the committed document is projected next', async () => {
    const extra = [
      { op: 'createConnector', alias: 'cd', from: { elementId: 'c', port: 'east', glue: 'static' }, to: { elementId: 'd', port: 'west', glue: 'static' }, route: 'orthogonal' },
      { op: 'createText', alias: 'note', bounds: { x: 0, y: 0, width: 60, height: 20 }, text: { value: 'x' }, attachment: { connector: 'cd', position: 0.5 } },
    ];
    const built = await scene({ extra });
    const legacy = structuredClone(built.t.store.snapshot().document);
    const abId = built.h.conn('ab').id;
    for (const page of legacy.pages) for (const e of page.elements) if (e.id === abId) delete (e as ConnectorElement).routing;
    const detour = [{ x: 100, y: 130 }, { x: 200, y: 130 }, { x: 200, y: 110 }, { x: 400, y: 110 }, { x: 400, y: 130 }, { x: 700, y: 130 }];

    for (const isolated of [true, false]) {
      const projector = plannerProjector({ memory: true });
      const t = createTestEngine({ document: structuredClone(legacy) });
      if (isolated) t.engine.setSnapshotProjector(projector.project, projector.isolate); else t.engine.setSnapshotProjector(projector.project);
      const h = harness(t);
      projector.project(t.store.snapshot());
      projector.seed(abId, detour);
      const drawnBefore = projector.project(t.store.snapshot());
      const proposal = await h.mustPropose({ pageId: h.doc().pages[0]!.id });
      expect(proposal.routes.find(r => r.id === abId)!.geometryChanged).toBe(true);
      const drawnAfter = projector.project(t.store.snapshot());
      if (isolated) {
        expect(projector.stats.insideIsolate).toBeGreaterThan(0);
        expect(drawnAfter).toEqual(drawnBefore);
      } else {
        // the control: without isolation the proposal's routes leak into the next projection of a document that never changed
        expect(drawnAfter).not.toEqual(drawnBefore);
      }
    }
  });

  it('refuses a proposal whose joins or attachments need a projection it cannot trust', async () => {
    const withJoin = [{ op: 'createConnector', alias: 'tap', from: { elementId: 'c', glue: 'dynamic' }, to: { glue: 'none', join: { connector: 'ab', position: 0.5 } }, route: 'orthogonal' }];
    const good = plannerProjector();
    const variants: Array<[string, ((s: Snapshot) => Result<Projection>) | null]> = [
      ['none registered', null],
      ['failed', () => fail('projection_failed', 'no drawing surface')],
      ['threw', () => { throw new Error('boom'); }],
      ['another revision', s => { const r = good.project(s); return r.ok ? ok({ ...r.value, revision: r.value.revision + 5 }) : r; }],
      ['incomplete', s => { const r = good.project(s); if (!r.ok) return r; const connectors = { ...r.value.connectors }; for (const page of s.document.pages) for (const e of page.elements) if (e.alias === 'ab') delete connectors[e.id]; return ok({ ...r.value, connectors }); }],
    ];
    const built = await scene({ extra: withJoin });
    for (const [name, project] of variants) {
      const t = createTestEngine({ document: structuredClone(built.t.store.snapshot().document) });
      if (project) t.engine.setSnapshotProjector(project);
      const h = harness(t), events: unknown[] = [];
      t.engine.onCommitted(e => events.push(e));
      const before = observe(t, events);
      const r = await h.propose({ connectorIds: [h.conn('ab').id, h.conn('tap').id] });
      expect(!r.ok && r.error.code, name).toBe('projection_failed');
      expect(observe(t, events), name).toBe(before);
    }
    // planner-only geometry needs no projector
    const plain = createTestEngine({ document: structuredClone((await scene()).t.store.snapshot().document) });
    const r = await harness(plain).mustPropose({});
    expect(r.commit).toBeDefined();
  });

  it('an unresolved target is reported with evidence and offers no commit', async () => {
    // shape e is fenced in by forbidden walls closer than the routing clearance, so nothing can reach it
    const { h } = await scene({ extra: [
      { op: 'createShape', alias: 'e', bounds: box(500, 250, 60, 40) },
      ...[box(482, 232, 96, 6), box(482, 302, 96, 6), box(482, 232, 6, 76), box(572, 232, 6, 76)].map((bounds, i) => ({ op: 'createShape', alias: `fence${i}`, bounds })),
    ] });
    await h.run([0, 1, 2, 3].map(i => ({ op: 'set', target: `fence${i}`, patch: { routingPolicy: { obstacle: 'forbidden' } } })));
    await h.run([{ op: 'createConnector', alias: 'boxed', from: { elementId: 'c', glue: 'dynamic' }, to: { elementId: 'e', glue: 'dynamic' }, route: 'orthogonal' }]);
    const proposal = await h.mustPropose({ connectorIds: [h.conn('boxed').id] });
    expect(proposal.routes[0]!.provenance).toBe('unresolved');
    expect(proposal.routeFindings.some(f => f.code === 'UNRESOLVED_ROUTE' && f.elementId === h.conn('boxed').id)).toBe(true);
    expect(proposal.commit).toBeUndefined();
  });

  it('never drops a pinned run to offer a route: a pin the new route cannot hold is unresolved, with no commit', async () => {
    const { t, h, events } = await scene();
    const ab = h.conn('ab');
    const detour = ab.routing!.advisory!;
    const inner = detour.findIndex((p, i) => i > 0 && i < detour.length - 2 && Math.abs(p.y - detour[i + 1]!.y) < 1e-6 && p.y !== 130);
    expect(inner).toBeGreaterThan(0);
    await h.run([{ op: 'pinSegment', target: ab.id, segment: inner, pinned: true }]);
    const before = observe(t, events);
    const proposal = await h.mustPropose({ connectorIds: [ab.id] });
    expect(proposal.routes[0]).toMatchObject({ provenance: 'unresolved', reason: 'a pinned run no longer exists on this route' });
    expect(proposal.routeFindings.some(f => f.code === 'UNRESOLVED_ROUTE' && f.elementId === ab.id)).toBe(true);
    expect(proposal.commit).toBeUndefined();
    expect(observe(t, events)).toBe(before);
  });

  it('works on a second page, and its commit applies without a page scope', async () => {
    const t = createTestEngine({ document: newDocument() });
    t.engine.setSnapshotProjector(plannerProjector().project);
    const h = harness(t);
    const second = uuid(902);
    await h.run([{ op: 'addPage', id: second, name: 'Second' }]);
    await h.run([
      { op: 'createShape', pageId: second, alias: 'a', bounds: box(0, 100) },
      { op: 'createShape', pageId: second, alias: 'b', bounds: box(700, 100) },
      { op: 'createShape', pageId: second, alias: 'wall', bounds: box(330, 122, 40, 16) },
      { op: 'createConnector', pageId: second, alias: 'ab', from: { elementId: 'a', port: 'east', glue: 'static' }, to: { elementId: 'b', port: 'west', glue: 'static' }, route: 'orthogonal' },
    ], second);
    await h.run([{ op: 'delete', target: 'wall' }], second);
    const ab = h.conn('ab');
    const proposal = await h.mustPropose({ connectorIds: [ab.id] });
    expect(proposal.pageId).toBe(second);
    const applied = await h.apply(proposal.commit!);
    expect(applied.error).toBeUndefined();
    expect(h.conn('ab').routing!.advisory).toEqual(proposal.routes[0]!.points);

    expect((await h.propose({})).ok).toBe(false); // page scope on a multipage document needs the page
    expect((await h.mustPropose({ pageId: second })).routes.map(r => r.id)).toEqual([ab.id]);
  });

  it('refuses input that would widen or guess the selection', async () => {
    const { h, page } = await scene({ extra: [
      { op: 'createConnector', alias: 'manual', from: { elementId: 'a', glue: 'dynamic' }, to: { elementId: 'c', glue: 'dynamic' }, route: 'orthogonal', waypoints: [{ x: 50, y: 300 }] },
    ] });
    const ab = h.conn('ab').id;
    const code = async (params: Record<string, unknown>) => { const r = await h.propose(params); return r.ok ? 'ok' : r.error.code; };
    expect(await code({ connectorIds: [] })).toBe('invalid_request');
    expect(await code({ connectorIds: [ab, ab] })).toBe('invalid_request');
    expect(await code({ connectorIds: ['ab'] })).toBe('invalid_request');
    expect(await code({ connectorIds: Array.from({ length: 1001 }, (_, i) => uuid(i + 1)) })).toBe('invalid_request');
    expect(await code({ connectorIds: [uuid(999_999)] })).toBe('not_found');
    expect(await code({ connectorIds: [ab], extra: true })).toBe('invalid_request');
    expect(await code({ pageId: 'page-1' })).toBe('invalid_request');
    expect(await code({ pageId: uuid(999_998) })).toBe('not_found');
    expect(await code({ connectorIds: [ab], pageId: page })).toBe('ok');
    const manual = await h.propose({ connectorIds: [h.conn('manual').id] });
    expect(!manual.ok && manual.error.details?.reason).toBe('route_not_automatic');
    expect(await code({ connectorIds: [h.find('a').id] })).toBe('invalid_request'); // not a connector
  });

  it('refuses a selection spread over pages or outside the named page', async () => {
    const t = createTestEngine({ document: newDocument() });
    const h = harness(t);
    const first = h.doc().pages[0]!.id, second = uuid(903);
    await h.run([{ op: 'addPage', id: second, name: 'Second' }]);
    const make = (pageId: string, n: number) => [
      { op: 'createShape', pageId, id: uuid(n), bounds: box(0, 100) },
      { op: 'createShape', pageId, id: uuid(n + 1), bounds: box(700, 100) },
      { op: 'createConnector', pageId, id: uuid(n + 2), from: { elementId: uuid(n), port: 'east', glue: 'static' }, to: { elementId: uuid(n + 1), port: 'west', glue: 'static' }, route: 'orthogonal' },
    ];
    await h.run([...make(first, 910), ...make(second, 920)]);
    const mixed = await h.propose({ connectorIds: [uuid(912), uuid(922)] });
    expect(!mixed.ok && mixed.error.code).toBe('invalid_request');
    const wrong = await h.propose({ connectorIds: [uuid(912)], pageId: second });
    expect(!wrong.ok && wrong.error).toMatchObject({ code: 'invalid_request', details: { connectorIds: [uuid(912)] } });
  });

  it('a proposal queued behind a mutation sees it', async () => {
    const { t, h } = await scene();
    const ab = h.conn('ab').id;
    const moving = t.engine.execute(t.request([{ op: 'move', target: 'b', delta: { xPt: 0, yPt: 40 } }]), 'mcp');
    const proposal = h.mustPropose({ connectorIds: [ab] });
    const [moved, proposed] = await Promise.all([moving, proposal]);
    expect(moved.ok && proposed.revision).toBe(moved.ok ? moved.value.revision : -1);
    expect(proposed.routes[0]!.points.at(-1)).toEqual({ x: 700, y: 170 });
  });

  it('on a stressed fixture page the proposal is what the commit stores', async () => {
    const ops = JSON.parse(readFileSync('../../tests/fixtures/diagrams/lego-infra.operations.json', 'utf8')) as Array<Record<string, any>>;
    const t = createTestEngine({ document: newDocument() });
    t.engine.setSnapshotProjector(plannerProjector().project);
    const h = harness(t);
    const later = (o: Record<string, any>) => o.op === 'createConnector' && o.from.glue !== 'static' && o.to.glue !== 'static' && (o.from.glue === 'dynamic' || o.to.glue === 'dynamic');
    for (const batch of [ops.filter(o => !later(o)), ops.filter(later)]) if (batch.length) await h.run(batch);
    const pageId = ops[0]!.id as string;
    const proposal = await h.mustPropose({ pageId });
    expect(proposal.routes.length).toBeGreaterThan(20);
    expect(await h.mustPropose({ pageId })).toEqual(proposal);
    if (!proposal.commit) return expect(proposal.routes.every(r => !r.geometryChanged) || proposal.routes.some(r => r.provenance === 'unresolved')).toBe(true);
    await h.mustApply(proposal.commit);
    for (const r of proposal.routes) expect(h.conn(r.id).routing?.advisory ?? null, r.id).toEqual(r.points);
  });
});
