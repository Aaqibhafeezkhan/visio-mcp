import { describe, expect, it } from 'vitest';
import type { Operation } from '../src/contracts/generated';
import { deleteOperations, intentOperations, membershipAfterDrag, nudgeOperations } from '../src/canvas/intents';
import { carriedConnectors, carriedLeaves, outermostTargets } from '../src/canvas/selection';
import { createTestEngine } from './support/engine';
import { id, run } from './support/ops';

type T = ReturnType<typeof createTestEngine>;
const s = (t: T, n: number) => t.ids.shapes[n]!;
const OUTER = id(910), INNER = id(911);
const NO_SNAP = { enabled: false, scale: 1 };

/** OUTER (60..480 x 10..230) holds INNER and s2; INNER (90..330 x 30..110) holds s0 and s1. s5 (100..200 x 130..190) is loose inside OUTER. */
async function nested(): Promise<T> {
  const t = createTestEngine();
  await run(t, [
    { op: 'setPage', patch: { grid: { snap: false } } },
    { op: 'createShape', id: INNER, bounds: { x: 90, y: 30, width: 240, height: 80 }, container: { memberIds: ['s0', 's1'] } },
    { op: 'createShape', id: OUTER, bounds: { x: 60, y: 10, width: 420, height: 220 }, container: { memberIds: [INNER, 's2'] } },
  ]);
  return t;
}
const snap = (t: T) => t.store.snapshot();
const contains = (ops: Operation[]) => ops.filter(o => o.op === 'contain');

describe('editing containers on the canvas (R17)', () => {
  it('only the outermost of a container and what it holds is moved, nudged or deleted', async () => {
    const t = await nested();
    expect(outermostTargets(snap(t), [s(t, 0), INNER, OUTER, s(t, 5)])).toEqual([OUTER, s(t, 5)]);
    expect(carriedLeaves(snap(t), [OUTER]).sort()).toEqual([INNER, s(t, 0), s(t, 1), s(t, 2)].sort());
    const moves = intentOperations(snap(t), { type: 'move', ids: [OUTER, INNER, s(t, 0), s(t, 1), s(t, 2)], dx: 20, dy: 0 }, NO_SNAP);
    expect(moves.filter(o => o.op === 'move')).toEqual([{ op: 'move', target: OUTER, delta: { xPt: 20, yPt: 0 } }]);
    expect(nudgeOperations(snap(t), [OUTER, s(t, 0)], 1, 0)).toEqual([{ op: 'move', target: OUTER, delta: { xPt: 1, yPt: 0 } }]);
    const del = deleteOperations(snap(t), [OUTER, s(t, 0), s(t, 2)]);
    expect(del).toEqual([{ op: 'delete', target: OUTER, members: 'delete', withConnectors: true }]);
    await run(t, del);
    expect(snap(t).document.pages[0]!.elements.some(e => e.id === s(t, 1))).toBe(false); // the Delete key takes the contents too
  });

  it('the drag preview carries a connector glued at both ends inside a container, as the engine moves it', async () => {
    const t = await nested();
    const LINK = id(930), OUT = id(931);
    await run(t, [
      { op: 'createConnector', id: LINK, from: { elementId: s(t, 0), glue: 'dynamic' }, to: { elementId: s(t, 2), glue: 'dynamic' } },
      { op: 'createConnector', id: OUT, from: { elementId: s(t, 0), glue: 'dynamic' }, to: { elementId: s(t, 5), glue: 'dynamic' } },
    ]);
    expect(carriedConnectors(snap(t), [OUTER])).toEqual([LINK]); // OUT has s5, which stays behind, so the router redraws it
    expect(carriedConnectors(snap(t), [s(t, 0)])).toEqual([]);
    expect(carriedLeaves(snap(t), [OUTER])).not.toContain(LINK); // not a member, so grouping a container leaves it out
  });

  it('dropping an object wholly inside a container adds it to the smallest one; dragging a member clear of it takes it out', async () => {
    const t = await nested();
    // s5 is already inside OUTER's bounds but not a member; dragged up by 90 it lands wholly inside INNER (s5 becomes 100..200 x 40..100)
    expect(contains(intentOperations(snap(t), { type: 'move', ids: [s(t, 5)], dx: 0, dy: -90 }, NO_SNAP))).toEqual([{ op: 'contain', container: INNER, add: [s(t, 5)] }]);
    // s1 dragged far away leaves INNER, and OUTER too since it lands outside both: removed from INNER, then from OUTER it passed up to
    const away = intentOperations(snap(t), { type: 'move', ids: [s(t, 1)], dx: 600, dy: 0 }, NO_SNAP);
    expect(contains(away)).toEqual([{ op: 'contain', container: INNER, remove: [s(t, 1)] }, { op: 'contain', container: OUTER, remove: [s(t, 1)] }]);
    await run(t, away);
    expect((snap(t).document.pages[0]!.elements.find(e => e.id === OUTER) as { container: { memberIds: string[] } }).container.memberIds).not.toContain(s(t, 1));
    // dragged clear of INNER but still across OUTER's edge (s1 becomes 220..320 x 220..280), it passes up to OUTER only
    const t2 = await nested();
    expect(contains(intentOperations(snap(t2), { type: 'move', ids: [s(t2, 1)], dx: 0, dy: 180 }, NO_SNAP))).toEqual([{ op: 'contain', container: INNER, remove: [s(t2, 1)] }]);
    // a member dragged within its container, or only partly out of it, keeps its place
    expect(contains(intentOperations(snap(t), { type: 'move', ids: [s(t, 0)], dx: 5, dy: 5 }, NO_SNAP))).toEqual([]);
    expect(contains(intentOperations(snap(t), { type: 'move', ids: [s(t, 0)], dx: -40, dy: 0 }, NO_SNAP))).toEqual([]);
  });

  it('a member dragged clear of growing containers leaves them all, so none grows to follow it', async () => {
    const t = await nested();
    await run(t, [INNER, OUTER].map(target => ({ op: 'set', target, patch: { container: { fit: 'grow' } } }) as Operation));
    const before = snap(t).document.pages[0]!.elements.find(e => e.id === OUTER)!.bounds;
    await run(t, intentOperations(snap(t), { type: 'move', ids: [s(t, 1)], dx: 600, dy: 0 }, NO_SNAP));
    const els = snap(t).document.pages[0]!.elements;
    expect(els.find(e => e.id === OUTER)!.bounds).toEqual(before);
    expect(els.some(e => 'container' in e && (e as { container: { memberIds: string[] } }).container.memberIds.includes(s(t, 1)))).toBe(false);
  });

  it('a dragged container never joins itself or what it holds, and locked containers are left alone', async () => {
    const t = await nested();
    expect(membershipAfterDrag(snap(t), [INNER], 5, 5)).toEqual([]); // INNER still sits inside OUTER, its container
    await run(t, [{ op: 'set', target: INNER, patch: { locked: true } }]);
    expect(membershipAfterDrag(snap(t), [s(t, 5)], 0, -90)).toEqual([{ op: 'contain', container: OUTER, add: [s(t, 5)] }]); // INNER is locked, so the next one up
  });

  it('the drag and the membership change commit as one transaction that one undo reverses', async () => {
    const t = await nested();
    const before = JSON.stringify(snap(t).document.pages);
    const r = await run(t, intentOperations(snap(t), { type: 'move', ids: [s(t, 5)], dx: 0, dy: -90 }, NO_SNAP));
    expect(r.changed).toEqual(expect.arrayContaining([s(t, 5), INNER]));
    expect((await t.engine.undo({ ...t.scope(), transactionId: id(7001), baseRevision: r.revision })).ok).toBe(true);
    expect(JSON.stringify(snap(t).document.pages)).toBe(before);
  });
});
