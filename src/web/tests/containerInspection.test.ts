import { describe, expect, it } from 'vitest';
import type { Element, Operation } from '../src/contracts/generated';
import { inspectLayout, type LayoutContext } from '../src/layout/inspectLayout';
import { selectObstacles } from '../src/layout/routingPolicy';
import { createTestEngine } from './support/engine';
import { id, run } from './support/ops';

const ctx: LayoutContext = { measureWidth: (t, f) => t.length * f.sizePt * 0.5 };
const box = (x: number, y: number, w = 60, h = 40) => ({ x, y, width: w, height: h });
const NO_FILL = { fill: { kind: 'none' as const } };
const FRAME = id(1), A = id(2), B = id(3), X = id(4), Y = id(5), INNER = id(6), LOOSE = id(7);

/** An empty page, so only what a test creates is judged. */
async function scene(ops: Operation[]) {
  const doc = structuredClone(createTestEngine().store.snapshot().document);
  doc.pages[0]!.elements = [];
  const t = createTestEngine({ document: doc });
  await run(t, ops);
  return t;
}
const issues = (t: Awaited<ReturnType<typeof scene>>) => inspectLayout(t.store.snapshot(), ctx).issues;
const codes = (t: Awaited<ReturnType<typeof scene>>, code: string) => issues(t).filter(i => i.code === code);

/** A frame with A inside it and B half outside; X and Y outside. The frame is drawn first, so it is behind everything. */
const base = (declared = false): Operation[] => [
  { op: 'createShape', id: FRAME, bounds: box(100, 100, 300, 200), style: NO_FILL },
  { op: 'createShape', id: A, bounds: box(130, 150) },
  { op: 'createShape', id: B, bounds: box(370, 150) }, // 370..430: sticks 30pt out of the frame's right edge
  { op: 'createShape', id: X, bounds: box(600, 150) },
  { op: 'createShape', id: Y, bounds: box(600, 400) },
  ...(declared ? [{ op: 'contain', container: FRAME, add: [A, B] } as Operation] : []),
];

describe('layout inspection of containers (R17)', () => {
  it('a member that sticks out of its container is reported as such, not as an overlap', async () => {
    const plain = await scene(base());
    expect(codes(plain, 'OVERLAP').map(i => i.elementIds)).toContainEqual([FRAME, B].sort());
    const declared = await scene(base(true));
    expect(codes(declared, 'OVERLAP')).toEqual([]);
    const out = codes(declared, 'MEMBER_OUTSIDE_CONTAINER');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ severity: 'warning', elementIds: [B, FRAME], evidence: { containerId: FRAME, overhangPt: { left: 0, top: 0, right: 30, bottom: 0 } } });
  });

  it('real collisions are still reported: overlapping members, and sibling containers that partly overlap', async () => {
    const t = await scene([
      { op: 'createShape', id: FRAME, bounds: box(100, 100, 300, 200), style: NO_FILL },
      { op: 'createShape', id: A, bounds: box(130, 150) },
      { op: 'createShape', id: B, bounds: box(160, 160) }, // half over A
      { op: 'createShape', id: INNER, bounds: box(300, 200, 200, 200), style: NO_FILL, container: { memberIds: [] } }, // a quarter of it over the frame
      { op: 'contain', container: FRAME, add: [A, B] },
    ]);
    const pairs = codes(t, 'OVERLAP').map(i => i.elementIds);
    expect(pairs).toContainEqual([A, B].sort());
    expect(pairs).toContainEqual([FRAME, INNER].sort());
  });

  it('a connector crossing into the container that holds its end is not a crossing; one passing through an unrelated container is', async () => {
    const connectors: Operation[] = [
      { op: 'createConnector', id: id(10), from: { elementId: A, glue: 'dynamic' }, to: { elementId: X, glue: 'dynamic' }, route: 'straight' },
      { op: 'createConnector', id: id(11), from: { elementId: Y, glue: 'dynamic' }, to: { elementId: id(8), glue: 'dynamic' }, route: 'straight' },
    ];
    const outsider: Operation = { op: 'createShape', id: id(8), bounds: box(20, 160) }; // Y to here runs through the frame
    const crossedBy = (t: Awaited<ReturnType<typeof scene>>, c: string) => codes(t, 'CONNECTOR_CROSSES_SHAPE').find(i => i.elementIds[0] === c)?.evidence.crossedElementIds as string[] | undefined;
    // (R26 already passes a frame drawn round a connector's end without declaring anything; a declared container is passed the same way)
    const declared = await scene([...base(true), outsider, ...connectors]);
    expect(crossedBy(declared, id(10)) ?? []).not.toContain(FRAME);
    expect(crossedBy(declared, id(11))).toContain(FRAME);
  });

  it('an element wholly inside a container but not listed is reported once, against the smallest container', async () => {
    const t = await scene([
      { op: 'createShape', id: FRAME, bounds: box(100, 100, 300, 200), style: NO_FILL },
      { op: 'createShape', id: INNER, bounds: box(120, 120, 150, 120), style: NO_FILL },
      { op: 'createShape', id: A, bounds: box(130, 150) },
      { op: 'createShape', id: LOOSE, bounds: box(140, 200, 30, 20) },
      { op: 'createShape', id: B, bounds: box(300, 150) },
    ]);
    expect(codes(t, 'UNLISTED_INSIDE_CONTAINER')).toEqual([]); // no declared containers: nothing to say
    await run(t, [
      { op: 'contain', container: INNER, add: [A] },
      { op: 'contain', container: FRAME, add: [INNER] },
    ]);
    const unlisted = codes(t, 'UNLISTED_INSIDE_CONTAINER');
    expect(unlisted.map(i => i.elementIds)).toEqual(expect.arrayContaining([[LOOSE, INNER], [B, FRAME]]));
    expect(unlisted).toHaveLength(2); // A is listed in INNER, and INNER in FRAME
    expect(unlisted.every(i => i.severity === 'info')).toBe(true);
  });

  it('a line free at both ends counts as something inside a container; a glued connector does not', async () => {
    const t = await scene([
      { op: 'createShape', id: FRAME, bounds: box(100, 100, 300, 200), style: NO_FILL, container: { memberIds: [] } },
      { op: 'createShape', id: A, bounds: box(130, 150) },
      { op: 'createShape', id: B, bounds: box(250, 150) },
      { op: 'contain', container: FRAME, add: [A, B] },
      { op: 'createConnector', id: id(10), from: { glue: 'none', point: { x: 120, y: 250 } }, to: { glue: 'none', point: { x: 380, y: 250 } } },
      { op: 'createConnector', id: id(11), from: { elementId: A, glue: 'dynamic' }, to: { elementId: B, glue: 'dynamic' } },
    ]);
    expect(codes(t, 'UNLISTED_INSIDE_CONTAINER').map(i => i.elementIds)).toEqual([[id(10), FRAME]]);
  });

  it('a filled container drawn in front of its own member is reported until it is sent back', async () => {
    const t = await scene([
      { op: 'createShape', id: A, bounds: box(130, 150) },
      { op: 'createShape', id: FRAME, bounds: box(100, 100, 300, 200), container: { memberIds: [A] } }, // stacked behind A, with the default white fill
      { op: 'reorder', targets: [FRAME], to: 'front' },
    ]);
    expect(codes(t, 'CONTAINER_HIDES_MEMBER')).toEqual([expect.objectContaining({ elementIds: [FRAME, A], evidence: { containerId: FRAME, hiddenElementIds: [A] } })]);
    await run(t, [{ op: 'reorder', targets: [FRAME], to: 'back' }]);
    expect(codes(t, 'CONTAINER_HIDES_MEMBER')).toEqual([]);
    await run(t, [{ op: 'reorder', targets: [FRAME], to: 'front' }, { op: 'set', target: FRAME, patch: { style: { fill: { kind: 'none' } } } }]);
    expect(codes(t, 'CONTAINER_HIDES_MEMBER')).toEqual([]); // nothing to hide behind
  });

  it('the router passes through a declared container, as it does a guessed one', () => {
    const solid = { kind: 'solid', colour: '#ffffff', opacity: 1 } as const;
    const style = { fill: solid, stroke: solid, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' } as const;
    const frame = (container?: object) => ({ id: FRAME, kind: 'shape', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: box(100, 100, 300, 200), rotationDeg: 0, metadata: {},
      geometry: { preset: 'rectangle' }, style, ...(container ? { container } : {}) }) as Element;
    // the only member is a text box, which the legacy guess does not count, so without the declaration the frame is an obstacle
    const label = { id: A, kind: 'text', layerIds: [], zIndex: 2, locked: false, hidden: false, bounds: box(130, 150), rotationDeg: 0, metadata: {},
      text: { value: 'Tenant', fontFamily: 'Segoe UI', fontSizePt: 12, bold: false, italic: false, underline: false, colour: '#000000', horizontalAlign: 'center', verticalAlign: 'middle', wrap: true, paddingPt: 4 } } as Element;
    const ids = (els: Element[]) => selectObstacles(els, [], new Set(), [], [], 1_000_000).map(o => o.id);
    expect(ids([frame(), label])).toContain(FRAME);
    expect(ids([frame({ memberIds: [A] }), label])).not.toContain(FRAME);
  });
});
