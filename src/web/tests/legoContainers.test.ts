import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import type { Bounds, Operation, ShapeElement } from '../src/contracts/generated';
import { containerAncestors, containerParents, isContainer } from '../src/layout/containers';
import { inspectLayout, type LayoutContext } from '../src/layout/inspectLayout';
import { createTestEngine } from './support/engine';
import { run } from './support/ops';

const ctx: LayoutContext = { measureWidth: (s, f) => s.length * f.sizePt * 0.5 };
const area = (b: Bounds) => b.width * b.height;
const holds = (o: Bounds, i: Bounds) => i.x >= o.x && i.y >= o.y && i.x + i.width <= o.x + o.width && i.y + i.height <= o.y + o.height;
const overlap = (a: Bounds, b: Bounds) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * R17 acceptance on the R15 Lego reproduction (artifacts/lego-infra/ops.json: 14 frames drawn as loose rectangles). The frames are declared
 * as containers and filled the way an agent would: from the inspector's own UNLISTED_INSIDE_CONTAINER findings, then labels that straddle a
 * frame edge go to the frame they mostly sit in. Containment-caused warnings go; real ones stay.
 */
it('the Lego frames become four levels of containers and the false containment warnings go', async () => {
  const t = createTestEngine();
  await run(t, JSON.parse(readFileSync(new URL('../../../artifacts/lego-infra/ops.json', import.meta.url), 'utf8')) as Operation[]);
  const page = () => t.store.snapshot().document.pages.find(p => p.name === 'Lego Infrastructure')!;
  const report = () => inspectLayout(t.store.snapshot(), ctx, { pageId: page().id }).issues;
  const count = (code: string) => report().filter(i => i.code === code).length;
  const before = { crosses: count('CONNECTOR_CROSSES_SHAPE'), overlaps: count('OVERLAP') };

  const shapes = page().elements.filter((e): e is ShapeElement => e.kind === 'shape');
  const frames = shapes.filter(f => shapes.some(o => o.id !== f.id && holds(f.bounds, o.bounds) && area(o.bounds) < area(f.bounds)));
  await run(t, frames.map(f => ({ op: 'set', target: f.id, patch: { container: { fit: 'none' } } }) as Operation), page().id);
  const unlisted = report().filter(i => i.code === 'UNLISTED_INSIDE_CONTAINER');
  const adds = new Map<string, string[]>();
  for (const i of unlisted) adds.set(i.evidence.containerId as string, [...(adds.get(i.evidence.containerId as string) ?? []), i.elementIds[0]!]);
  await run(t, [...adds].map(([container, add]) => ({ op: 'contain', container, add }) as Operation), page().id);
  expect(report().filter(i => i.code === 'UNLISTED_INSIDE_CONTAINER')).toEqual([]);

  const listed = containerParents(page().elements);
  const containers = page().elements.filter(isContainer);
  const straddlers = new Map<string, string[]>();
  for (const e of page().elements) {
    if (e.kind === 'connector' || e.kind === 'group' || isContainer(e)) continue;
    const host = containers.filter(c => overlap(c.bounds, e.bounds) >= 0.5 * area(e.bounds)).sort((a, b) => area(a.bounds) - area(b.bounds))[0];
    const now = listed.get(e.id);
    if (host && host.id !== now && (now === undefined || containerAncestors(listed, host.id).includes(now))) straddlers.set(host.id, [...(straddlers.get(host.id) ?? []), e.id]);
  }
  await run(t, [...straddlers].map(([container, add]) => ({ op: 'contain', container, add }) as Operation), page().id);

  const parents = containerParents(page().elements);
  expect(Math.max(...page().elements.map(e => containerAncestors(parents, e.id).length))).toBe(4); // public cloud > tenant > component > contents
  const after = report();
  const crossings = after.filter(i => i.code === 'CONNECTOR_CROSSES_SHAPE');
  const declared = new Set(page().elements.filter(isContainer).map(e => e.id));
  // a line still crosses a container only when it neither starts nor ends inside it
  for (const c of crossings) for (const id of c.evidence.crossedElementIds as string[]) if (declared.has(id)) {
    const line = page().elements.find(e => e.id === c.elementIds[0])!;
    if (line.kind !== 'connector') continue;
    const frame = page().elements.find(e => e.id === id)!.bounds;
    expect([line.from.point, line.to.point].some(p => p && p.x > frame.x && p.x < frame.x + frame.width && p.y > frame.y && p.y < frame.y + frame.height)).toBe(false);
  }
  expect(crossings.length).toBeLessThan(before.crosses); // R26 already passes frames round an end; declaring containers removes more
  expect(after.filter(i => i.code === 'OVERLAP').length).toBeLessThan(before.overlaps);
  // R17_WRITE_LEGO=1 refreshes the committed document the Visio acceptance test exports (tests/Diagram.Visio.Tests/LegoContainerVisioTests.cs)
  if (process.env.R17_WRITE_LEGO) writeFileSync(new URL('../../../artifacts/r17-containers/lego-containers.document.json', import.meta.url), `${JSON.stringify({ ...t.store.snapshot().document, pages: [page()], assets: [] }, null, 1)}
`);
  // moving the outermost frame carries everything inside it, the free lines included
  const outer = [...declared].find(id => !parents.has(id) && containerAncestors(parents, id).length === 0 && page().elements.some(e => containerAncestors(parents, e.id).length === 4 && containerAncestors(parents, e.id).includes(id)))!;
  const inside = page().elements.filter(e => containerAncestors(parents, e.id).includes(outer));
  const lines = inside.filter(e => e.kind === 'connector');
  const was = new Map(inside.map(e => [e.id, e.kind === 'connector' ? e.from.point!.x : e.bounds.x] as const));
  await run(t, [{ op: 'move', target: outer, delta: { xPt: 10, yPt: 0 } }], page().id);
  for (const e of page().elements.filter(x => was.has(x.id))) expect((e.kind === 'connector' ? e.from.point!.x : e.bounds.x) - was.get(e.id)!).toBeCloseTo(10, 6);
  expect(lines.length).toBeGreaterThan(0);
  console.log(`R17 Lego evidence: moving the outermost frame carried ${inside.length} elements (${lines.length} free lines)`);
  console.log(`R17 Lego evidence: ${frames.length} containers, ${parents.size} members; CONNECTOR_CROSSES_SHAPE ${before.crosses} -> ${crossings.length}; OVERLAP ${before.overlaps} -> ${after.filter(i => i.code === 'OVERLAP').length}; MEMBER_OUTSIDE_CONTAINER ${after.filter(i => i.code === 'MEMBER_OUTSIDE_CONTAINER').length}`);
});
