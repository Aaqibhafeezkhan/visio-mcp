import { describe, expect, it } from 'vitest';
import type { ConnectorElement, DiagramDocument, ShapeElement } from '../src/contracts/generated';
import { validateDocument } from '../src/model/validate';
import { compareElementOrder } from '../src/model/elementOrder';
import { readObjects, readSummary } from '../src/bridge/readTools';
import { copyElements, pasteOperations } from '../src/commands/clipboard';
import { compile } from '../src/script/compiler';
import { createTestEngine, exactElementHashes, hashesExcept, sequenceIds } from './support/engine';
import { byId, has, id, refused, run, shape } from './support/ops';

type T = ReturnType<typeof createTestEngine>;
const s = (t: T, n: number) => t.ids.shapes[n]!;
const OUTER = id(910), INNER = id(911), OTHER = id(912), C1 = id(920);
const members = (t: T, cid: string) => shape(t, cid).container!.memberIds;
const without = (hashes: Record<string, string>, key: string) => Object.fromEntries(Object.entries(hashes).filter(([k]) => k !== key));
const shifted = (b: { x: number; y: number; width: number; height: number }, dx: number, dy: number) => ({ ...b, x: b.x + dx, y: b.y + dy });

/** OUTER holds INNER and s2; INNER holds s0 and s1. s5 stays outside. */
async function nested(t: T, extra: { fit?: 'grow' | 'fit'; marginPt?: number } = {}) {
  await run(t, [
    { op: 'createShape', id: INNER, bounds: { x: 90, y: 30, width: 240, height: 80 }, container: { memberIds: [s(t, 0), s(t, 1)], ...extra } },
    { op: 'createShape', id: OUTER, bounds: { x: 80, y: 20, width: 380, height: 100 }, container: { memberIds: [INNER, s(t, 2)], ...extra } },
  ]);
}

describe('containers (R17)', () => {
  it('a container lists its members explicitly; creating one leaves the members untouched', async () => {
    const t = createTestEngine();
    const before = exactElementHashes(t.store.snapshot());
    const r = await run(t, [{ op: 'createShape', id: C1, bounds: { x: 90, y: 30, width: 240, height: 80 }, container: { memberIds: ['s0', 's1'] } }]);
    expect(r.created).toEqual([C1]);
    expect(r.changed).toEqual([t.ids.image]); // the image below s0 steps back to free a stacking value just behind it
    expect(shape(t, C1).container).toEqual({ memberIds: [s(t, 0), s(t, 1)] }); // fit none and margin 0 are not stored
    expect(without(hashesExcept(t.store.snapshot(), C1), t.ids.image)).toEqual(without(before, t.ids.image));
  });

  it('moving a container moves every member at every depth by the same amount, and nothing outside', async () => {
    const t = createTestEngine();
    await nested(t);
    const b = (n: number) => shape(t, s(t, n)).bounds;
    const was = { s0: b(0), s1: b(1), s2: b(2), s5: b(5), inner: shape(t, INNER).bounds, outer: shape(t, OUTER).bounds };
    const r = await run(t, [{ op: 'move', target: OUTER, delta: { xPt: 15, yPt: -5 } }]);
    expect(r.changed).toEqual(expect.arrayContaining([OUTER, INNER, s(t, 0), s(t, 1), s(t, 2)]));
    expect(b(0)).toEqual(shifted(was.s0, 15, -5));
    expect(b(1)).toEqual(shifted(was.s1, 15, -5));
    expect(b(2)).toEqual(shifted(was.s2, 15, -5));
    expect(shape(t, INNER).bounds).toEqual(shifted(was.inner, 15, -5));
    expect(shape(t, OUTER).bounds).toEqual(shifted(was.outer, 15, -5));
    expect(b(5)).toEqual(was.s5);
    expect(members(t, OUTER)).toEqual([INNER, s(t, 2)]); // membership is unchanged by a move
  });

  it('a connector with both ends inside moves whole with its stored route; one with an end outside is left to the router', async () => {
    const t = createTestEngine();
    await nested(t);
    await run(t, [
      { op: 'createConnector', id: id(930), from: { elementId: 's0', glue: 'dynamic' }, to: { elementId: 's1', glue: 'dynamic' }, route: 'orthogonal' },
      { op: 'createConnector', id: id(931), from: { elementId: 's0', glue: 'dynamic' }, to: { elementId: 's5', glue: 'dynamic' }, route: 'orthogonal' },
    ]);
    const inner = byId<ConnectorElement>(t, id(930)).routing!.advisory!;
    const r = await run(t, [{ op: 'move', target: OUTER, delta: { xPt: 40, yPt: 0 } }]);
    expect(byId<ConnectorElement>(t, id(930)).routing!.advisory).toEqual(inner.map(p => ({ x: p.x + 40, y: p.y })));
    expect(r.routeChanges?.find(c => c.id === id(930))).toBeUndefined(); // moved with its container, not planned again
    expect(r.visuallyAffectedIds).toContain(id(931));
  });

  it('moving a member alone moves only it, and it stays a member', async () => {
    const t = createTestEngine();
    await nested(t);
    const before = exactElementHashes(t.store.snapshot());
    const r = await run(t, [{ op: 'move', target: 's0', delta: { xPt: 5, yPt: 5 } }]);
    expect(r.changed).toEqual([s(t, 0)]);
    expect(members(t, INNER)).toContain(s(t, 0));
    expect(hashesExcept(t.store.snapshot(), s(t, 0))).toEqual(without(before, s(t, 0)));
  });

  it('resizing a container never scales or moves its members', async () => {
    const t = createTestEngine();
    await nested(t);
    const before = exactElementHashes(t.store.snapshot());
    const r = await run(t, [{ op: 'resize', target: OUTER, bounds: { width: 600, height: 300 } }]);
    expect(r.changed).toEqual([OUTER]);
    expect(hashesExcept(t.store.snapshot(), OUTER)).toEqual(without(before, OUTER));
  });

  it('grow expands a container, innermost first, to keep a moved member inside with its margin', async () => {
    const t = createTestEngine();
    await nested(t, { fit: 'grow', marginPt: 10 });
    const outer = shape(t, OUTER).bounds;
    // s1 (220..320 x 40..100) moves 100 right and 50 down: 320..420 x 90..150
    const r = await run(t, [{ op: 'move', target: 's1', delta: { xPt: 100, yPt: 50 } }]);
    expect(r.changed).toEqual(expect.arrayContaining([s(t, 1), INNER, OUTER]));
    expect(shape(t, INNER).bounds).toEqual({ x: 90, y: 30, width: 340, height: 130 }); // right 420+10, bottom 150+10
    expect(shape(t, OUTER).bounds).toEqual({ x: outer.x, y: outer.y, width: 380, height: 150 }); // INNER bottom 160 + 10; right 460 already holds 430 + 10
  });

  it('a growing container resized smaller than its members is pushed back out; fit hugs the members exactly', async () => {
    const t = createTestEngine();
    await run(t, [{ op: 'createShape', id: C1, bounds: { x: 90, y: 30, width: 240, height: 80 }, container: { memberIds: ['s0', 's1'], fit: 'grow', marginPt: 10 } }]);
    await run(t, [{ op: 'resize', target: C1, bounds: { width: 50 } }]);
    expect(shape(t, C1).bounds).toEqual({ x: 90, y: 30, width: 240, height: 80 });
    await run(t, [{ op: 'set', target: C1, patch: { container: { fit: 'fit', marginPt: 4 } } }]);
    expect(shape(t, C1).bounds).toEqual({ x: 96, y: 36, width: 228, height: 68 });
    await run(t, [{ op: 'set', target: C1, patch: { container: { fit: 'none', marginPt: 0 } } }]);
    expect(shape(t, C1).container).toEqual({ memberIds: [s(t, 0), s(t, 1)] });
  });

  it('a new container is stacked just behind its lowest member, in front of what lay below, such as a page background', async () => {
    const t = createTestEngine();
    const BG = id(940);
    await run(t, [{ op: 'createShape', id: BG, bounds: { x: 0, y: 0, width: 800, height: 600 } }, { op: 'reorder', targets: [BG], to: 'back' }]);
    await run(t, [{ op: 'createShape', id: C1, bounds: { x: 200, y: 20, width: 260, height: 100 }, container: { memberIds: [s(t, 3), s(t, 1)] } }]);
    const order = t.store.snapshot().document.pages[0]!.elements.filter(e => e.kind !== 'group').sort(compareElementOrder).map(e => e.id);
    expect(order[0]).toBe(BG);
    expect(order.indexOf(C1)).toBe(order.indexOf(s(t, 1)) - 1);
    expect(order.indexOf(s(t, 1))).toBeLessThan(order.indexOf(s(t, 3))); // the members keep their own order
  });

  it('a container fitted to a straight line keeps a positive size, so the document stays valid', async () => {
    const t = createTestEngine();
    await run(t, [
      { op: 'createConnector', id: id(930), from: { glue: 'none', point: { x: 120, y: 250 } }, to: { glue: 'none', point: { x: 380, y: 250 } }, route: 'straight' },
      { op: 'createShape', id: C1, bounds: { x: 100, y: 200, width: 300, height: 100 }, container: { memberIds: [id(930)], fit: 'fit' } },
    ]);
    expect(shape(t, C1).bounds).toEqual({ x: 120, y: 249.5, width: 260, height: 1 });
    expect(validateDocument(t.store.snapshot().document).ok).toBe(true);
  });

  it('deleting a container with members needs a choice: keep moves them up in its place, delete removes everything inside', async () => {
    const t = createTestEngine();
    await nested(t);
    const e = await refused(t, [{ op: 'delete', target: INNER }]);
    expect(e.details?.reason).toBe('container_delete_requires_choice');
    expect((await refused(t, [{ op: 'delete', target: 's5', members: 'keep' }])).details?.reason).toBe('members_only_for_containers');
    const kept = await run(t, [{ op: 'delete', target: INNER, members: 'keep' }]);
    expect(kept.deleted).toEqual([INNER]);
    expect(members(t, OUTER)).toEqual([s(t, 0), s(t, 1), s(t, 2)]);
    const gone = await run(t, [{ op: 'delete', target: OUTER, members: 'delete' }]);
    expect(gone.deleted.sort()).toEqual([OUTER, s(t, 0), s(t, 1), s(t, 2)].sort());
    expect(has(t, s(t, 5))).toBe(true);
  });

  it('deleting a member removes it from its container, which may be left empty', async () => {
    const t = createTestEngine();
    await run(t, [{ op: 'createShape', id: C1, bounds: { x: 90, y: 30, width: 240, height: 80 }, container: { memberIds: ['s0'] } }]);
    const r = await run(t, [{ op: 'delete', target: 's0' }]);
    expect(r.changed).toEqual([C1]);
    expect(members(t, C1)).toEqual([]);
    await run(t, [{ op: 'delete', target: C1 }]); // an empty container needs no choice
    expect(has(t, C1)).toBe(false);
  });

  it('contain adds (moving an element out of another container) and removes (moving it up a level)', async () => {
    const t = createTestEngine();
    await nested(t);
    await run(t, [{ op: 'createShape', id: OTHER, bounds: { x: 80, y: 120, width: 380, height: 100 } }]);
    const r = await run(t, [{ op: 'contain', container: OTHER, add: ['s1', 's5'] }]);
    expect(r.changed.sort()).toEqual([OTHER, INNER].sort());
    expect(members(t, OTHER)).toEqual([s(t, 1), s(t, 5)]);
    expect(members(t, INNER)).toEqual([s(t, 0)]);
    await run(t, [{ op: 'contain', container: INNER, remove: ['s0'] }]);
    expect(members(t, INNER)).toEqual([]);
    expect(members(t, OUTER)).toEqual([INNER, s(t, 2), s(t, 0)]);
    expect((await refused(t, [{ op: 'contain', container: INNER, remove: ['s3'] }])).details?.reason).toBe('not_a_member');
    expect((await refused(t, [{ op: 'contain', container: t.ids.image, add: ['s3'] }])).details?.reason).toBe('container_must_be_shape');
  });

  it('a container cannot contain itself, directly or through another container', async () => {
    const t = createTestEngine();
    await nested(t);
    expect((await refused(t, [{ op: 'contain', container: OUTER, add: [OUTER] }])).details?.reason).toBe('container_cycle');
    expect((await refused(t, [{ op: 'contain', container: INNER, add: [OUTER] }])).details?.reason).toBe('container_cycle');
  });

  it('a container and its members are grouped together or not at all', async () => {
    const t = createTestEngine();
    await nested(t);
    const e = await refused(t, [{ op: 'group', targets: [INNER, 's2'] }]);
    expect(e.details?.reason).toBe('container_split');
    await run(t, [{ op: 'group', targets: [OUTER, INNER, 's0', 's1', 's2'], id: id(940) }]);
    const was = shape(t, s(t, 0)).bounds;
    await run(t, [{ op: 'move', target: OUTER, delta: { xPt: 10, yPt: 0 } }]);
    expect(shape(t, s(t, 0)).bounds).toEqual(shifted(was, 10, 0));
  });

  it('a container with members is not rotated, and is not moved when anything inside is locked', async () => {
    const t = createTestEngine();
    await nested(t);
    expect((await refused(t, [{ op: 'rotate', target: OUTER, deltaDeg: 90 }])).details?.reason).toBe('container_rotation');
    await run(t, [{ op: 'set', target: 's1', patch: { locked: true } }]);
    expect((await refused(t, [{ op: 'move', target: OUTER, delta: { xPt: 1, yPt: 0 } }])).code).toBe('locked_target');
  });

  it('disbanding keeps the shape and moves its members up in its place', async () => {
    const t = createTestEngine();
    await nested(t);
    const r = await run(t, [{ op: 'set', target: INNER, patch: { container: null } }]);
    expect(r.changed.sort()).toEqual([INNER, OUTER].sort());
    expect(shape(t, INNER).container).toBeUndefined();
    expect(members(t, OUTER)).toEqual([INNER, s(t, 0), s(t, 1), s(t, 2)]);
  });

  it('duplicating a container copies everything inside with the same structure; a duplicated member joins its container', async () => {
    const t = createTestEngine();
    await nested(t);
    const r = await run(t, [{ op: 'duplicate', targets: [INNER], offset: { xPt: 0, yPt: 200 } }]);
    expect(r.created).toHaveLength(3);
    const copy = r.created.map(i => byId(t, i)).find(e => e.kind === 'shape' && (e as ShapeElement).container) as ShapeElement;
    expect(copy.container!.memberIds).toHaveLength(2);
    expect(copy.container!.memberIds.every(m => r.created.includes(m))).toBe(true);
    expect(members(t, OUTER)).toEqual([INNER, copy.id, s(t, 2)]); // the copy of INNER joins OUTER next to INNER
    const lone = await run(t, [{ op: 'duplicate', targets: ['s2'], offset: { xPt: 0, yPt: 10 } }]);
    expect(members(t, OUTER)).toEqual([INNER, copy.id, s(t, 2), lone.created[0]]);
  });

  it('every container edit undoes to the exact prior state in one step', async () => {
    const t = createTestEngine();
    const start = exactElementHashes(t.store.snapshot());
    const r = await run(t, [
      { op: 'createShape', id: INNER, bounds: { x: 90, y: 30, width: 240, height: 80 }, container: { memberIds: ['s0', 's1'], fit: 'grow' } },
      { op: 'createShape', id: OUTER, bounds: { x: 80, y: 20, width: 380, height: 100 }, container: { memberIds: [INNER, 's2'], fit: 'grow' } },
      { op: 'move', target: 's1', delta: { xPt: 200, yPt: 0 } },
      { op: 'move', target: OUTER, delta: { xPt: 10, yPt: 10 } },
    ]);
    const after = exactElementHashes(t.store.snapshot());
    expect((await t.engine.undo({ ...t.scope(), transactionId: id(7001), baseRevision: r.revision })).ok).toBe(true);
    expect(exactElementHashes(t.store.snapshot())).toEqual(start);
    expect((await t.engine.redo({ ...t.scope(), transactionId: id(7002), baseRevision: t.engine.revision })).ok).toBe(true);
    expect(exactElementHashes(t.store.snapshot())).toEqual(after);
  });

  it('documents with broken containment are refused at the door', () => {
    const t = createTestEngine();
    const doc = structuredClone(t.store.snapshot().document) as DiagramDocument;
    const els = doc.pages[0]!.elements as ShapeElement[];
    const a = els.find(e => e.id === s(t, 0))!, b = els.find(e => e.id === s(t, 1))!;
    a.container = { memberIds: [b.id] };
    b.container = { memberIds: [a.id] };
    const r = validateDocument(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/contain themselves/);
    b.container = { memberIds: [id(999)] };
    const missing = validateDocument(doc);
    expect(!missing.ok && missing.error.message).toMatch(/unknown member/);
  });
});

describe('containers in DrawScript, reads and the clipboard (R17)', () => {
  const script = (t: T, source: string) => {
    const r = compile(source, { snapshot: t.store.snapshot(), newUuid: sequenceIds('7') });
    if (!r.ok) throw new Error(r.error.message);
    return r.value.operations;
  };

  it('DrawScript makes containers, changes their members and settings, and deletes them with a choice', async () => {
    const t = createTestEngine();
    const made = script(t, 'add shape id=zone x=90pt y=30pt w=240pt h=80pt container=grow margin=8pt\ncontain zone add s0 s1');
    expect(made[0]).toMatchObject({ op: 'createShape', alias: 'zone', container: { fit: 'grow', marginPt: 8 } });
    expect(made[1]).toEqual({ op: 'contain', container: made[0]!.op === 'createShape' ? made[0]!.id : '', add: [s(t, 0), s(t, 1)] });
    await run(t, made);
    expect(script(t, 'contain zone remove s1')).toEqual([{ op: 'contain', container: expect.any(String), remove: [s(t, 1)] }]);
    expect(script(t, 'set zone container=fit margin=4pt')).toEqual([{ op: 'set', target: expect.any(String), patch: { container: { fit: 'fit', marginPt: 4 } } }]);
    expect(script(t, 'contain zone disband')).toEqual([{ op: 'set', target: expect.any(String), patch: { container: null } }]);
    expect(script(t, 'delete zone members=keep')).toEqual([{ op: 'delete', target: expect.any(String), members: 'keep' }]);
    const wrong = compile('contain zone keep s1', { snapshot: t.store.snapshot(), newUuid: sequenceIds('7') });
    expect(!wrong.ok && wrong.error.message).toMatch(/add, remove or disband/);
  });

  it('reads name the container of each member, and show a container with its members and settings', async () => {
    const t = createTestEngine();
    await nested(t, { fit: 'grow' });
    const summary = readSummary(t.store.snapshot());
    if (!summary.ok) throw new Error('summary failed');
    const elements = (summary.value as { pages: { elements: { id: string; containerId?: string; container?: unknown }[] }[] }).pages[0]!.elements;
    const of = (eid: string) => elements.find(e => e.id === eid)!;
    expect(of(s(t, 0)).containerId).toBe(INNER);
    expect(of(INNER).containerId).toBe(OUTER);
    expect(of(OUTER).containerId).toBeUndefined();
    expect(of(OUTER).container).toEqual({ memberIds: [INNER, s(t, 2)], fit: 'grow' });
    const objects = readObjects(t.store.snapshot(), [s(t, 1), OUTER]);
    expect(objects.ok && objects.value.map(o => (o as { containerId?: string }).containerId)).toEqual([INNER, undefined]);
  });

  it('copying a container copies what is inside it; the paste is a container holding the copies', async () => {
    const t = createTestEngine();
    await nested(t, { fit: 'grow', marginPt: 6 });
    const clip = copyElements(t.store.snapshot(), [OUTER])!;
    expect(clip.elements.map(e => e.id).sort()).toEqual([OUTER, INNER, s(t, 0), s(t, 1), s(t, 2)].sort());
    const page = t.store.snapshot().document.pages[0]!;
    const { operations, newIds } = pasteOperations(clip, page, 300, sequenceIds('4'));
    expect(operations.filter(o => o.op === 'contain')).toHaveLength(2);
    await run(t, operations);
    const pasted = newIds.map(i => byId(t, i));
    const outerCopy = pasted.find(e => e.kind === 'shape' && (e as ShapeElement).container?.memberIds.length === 2 && (e as ShapeElement).container!.memberIds.some(m => (byId(t, m) as ShapeElement).container)) as ShapeElement;
    expect(outerCopy.container).toMatchObject({ fit: 'grow', marginPt: 6 });
    expect(outerCopy.container!.memberIds.every(m => newIds.includes(m))).toBe(true);
    const lone = copyElements(t.store.snapshot(), [s(t, 2)])!;
    expect(lone.elements.map(e => e.id)).toEqual([s(t, 2)]); // a member copied on its own lands at the top level
  });
});
