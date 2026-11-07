import { test, expect, type Page } from '@playwright/test';
import type { ChangeSet, Element, GroupElement } from '../../src/contracts/generated';
import { centre, drag, elements, openEditor, placeShape, ptToClient, revision, scale, selection, snapshot, type Pt } from './support';

const MM = 72 / 25.4;

/** Exact bytes of every element, to prove what a gesture did not touch. */
async function hashes(page: Page): Promise<Record<string, string>> {
  return Object.fromEntries((await elements(page)).map(e => [e.id, JSON.stringify(e)]));
}
const only = (all: Record<string, string>, ...ids: string[]) => Object.fromEntries(ids.map(i => [i, all[i]]));
const without = (all: Record<string, string>, ...ids: string[]) => Object.fromEntries(Object.entries(all).filter(([k]) => !ids.includes(k)));
const sorted = (xs: string[]) => [...xs].sort();

async function changesSince(page: Page, rev: number): Promise<ChangeSet> {
  return page.evaluate(r => (window as any).__editor.changesSince(r), rev);
}
async function targets(page: Page): Promise<string[]> { return page.evaluate(() => (window as any).__editor.targets()); }

async function rubberBand(page: Page, from: Pt, to: Pt): Promise<void> {
  await drag(page, await ptToClient(page, from), await ptToClient(page, to));
}

async function clearSelection(page: Page): Promise<void> {
  const empty = await ptToClient(page, { x: 800, y: 560 });
  await page.mouse.click(empty.x, empty.y);
  await expect.poll(() => selection(page)).toEqual([]);
}

/** Four shapes at different positions; the fourth lies outside the rubber band used to select the first three. */
async function fourShapes(page: Page) {
  const a = await placeShape(page, 'shape-rectangle', { x: 150, y: 100 }, 'a');
  const b = await placeShape(page, 'shape-ellipse', { x: 400, y: 190 }, 'b');
  const c = await placeShape(page, 'shape-rectangle', { x: 650, y: 140 }, 'c');
  const d = await placeShape(page, 'shape-rectangle', { x: 400, y: 440 }, 'd');
  return { a, b, c, d };
}

const get = async (page: Page, id: string): Promise<Element> => (await elements(page)).find(e => e.id === id)!;

test('align, distribute and gap from the Arrange menu and panel, each one revision, nothing else touched', async ({ page }) => {
  const errors = await openEditor(page);
  const { a, b, c, d } = await fourShapes(page);
  await rubberBand(page, { x: 30, y: 30 }, { x: 780, y: 300 });
  await expect.poll(async () => sorted(await selection(page))).toEqual(sorted([a.id, b.id, c.id]));
  expect(await targets(page)).toHaveLength(3);

  await test.step('align top through the Arrange menu', async () => {
    const before = await hashes(page);
    const r0 = await revision(page);
    await page.getByTestId('menu-arrange').click();
    await expect(page.getByTestId('menu-distribute-h')).toBeEnabled();
    await page.getByTestId('menu-align-top').click();
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const top = Math.min(a.bounds.y, b.bounds.y, c.bounds.y);
    for (const id of [a.id, b.id, c.id]) expect((await get(page, id)).bounds.y).toBeCloseTo(top, 6);
    expect(without(await hashes(page), a.id, b.id, c.id)).toEqual(without(before, a.id, b.id, c.id)); // d and anything else: byte identical
    expect((await get(page, a.id)).bounds).toEqual(a.bounds); // already on the shared edge, so not rewritten
    const ch = await changesSince(page, r0);
    expect(ch.transactions).toHaveLength(1);
    expect(sorted(ch.transactions[0]!.changed)).toEqual(sorted([b.id, c.id]));
  });

  await test.step('undo restores every byte', async () => {
    const r1 = await revision(page);
    await page.keyboard.press('Control+z');
    await expect.poll(() => revision(page)).toBe(r1 + 1); // undo is a new revision, never a rewind
    expect((await get(page, b.id)).bounds).toEqual(b.bounds);
    expect((await get(page, c.id)).bounds).toEqual(c.bounds);
  });

  await test.step('distribute horizontally from the panel keeps the outer two in place', async () => {
    const r0 = await revision(page);
    const first = await get(page, a.id), last = await get(page, c.id);
    await page.getByTestId('arrange-distribute-h').click();
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const [pa, pb, pc] = await Promise.all([a, b, c].map(s => get(page, s.id)));
    expect(pa!.bounds).toEqual(first.bounds);
    expect(pc!.bounds).toEqual(last.bounds);
    const gap1 = pb!.bounds.x - (pa!.bounds.x + pa!.bounds.width);
    const gap2 = pc!.bounds.x - (pb!.bounds.x + pb!.bounds.width);
    expect(gap1).toBeCloseTo(gap2, 6);
  });

  await test.step('set an exact gap of 20 mm', async () => {
    const r0 = await revision(page);
    await page.getByTestId('arrange-gap-input').fill('20');
    await page.getByTestId('arrange-gap-h').click();
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const [pa, pb, pc] = await Promise.all([a, b, c].map(s => get(page, s.id)));
    expect(pb!.bounds.x - (pa!.bounds.x + pa!.bounds.width)).toBeCloseTo(20 * MM, 6);
    expect(pc!.bounds.x - (pb!.bounds.x + pb!.bounds.width)).toBeCloseTo(20 * MM, 6);
    expect(pa!.bounds.x).toBe(a.bounds.x); // the first object keeps its place
  });

  expect(await get(page, d.id)).toEqual(d);
  expect(errors.filter(e => !/Failed to load resource|favicon/.test(e))).toEqual([]);
});

test('alignment of fewer objects than needed is refused with a message and changes nothing', async ({ page }) => {
  await openEditor(page);
  const { a, b } = await fourShapes(page);
  await page.mouse.click((await centre(page, a.id)).x, (await centre(page, a.id)).y);
  await expect(page.getByTestId('arrange-align-left')).toBeDisabled();
  await expect(page.getByTestId('arrange-distribute-h')).toBeDisabled();
  await rubberBand(page, { x: 30, y: 30 }, { x: 560, y: 260 }); // a and b
  await expect.poll(async () => (await selection(page)).length).toBe(2);
  await expect(page.getByTestId('arrange-distribute-h')).toBeDisabled(); // distribution needs three
  await expect(page.getByTestId('arrange-align-left')).toBeEnabled();
  expect((await get(page, b.id)).bounds).toEqual(b.bounds);
});

test('z order from the context menu changes what is drawn on top', async ({ page }) => {
  await openEditor(page);
  const under = await placeShape(page, 'shape-rectangle', { x: 300, y: 260 }, 'under');
  const placed = await placeShape(page, 'shape-rectangle', { x: 600, y: 260 }, 'over'); // a click on an existing shape would not place one
  await page.evaluate(([id, dx, dy]) => (window as any).__editor.agentApply([{ op: 'move', target: id, delta: { xPt: dx, yPt: dy } }]), [placed.id, under.bounds.x + 40 - placed.bounds.x, under.bounds.y + 30 - placed.bounds.y] as const);
  const over = await get(page, placed.id);
  const red = { kind: 'solid' as const, colour: '#ff0000', opacity: 1 }, blue = { kind: 'solid' as const, colour: '#0000ff', opacity: 1 };
  await page.evaluate(([u, o, r, bl]) => (window as any).__editor.agentApply([
    { op: 'set', target: u, patch: { style: { fill: r } } }, { op: 'set', target: o, patch: { style: { fill: bl } } },
  ]), [under.id, over.id, red, blue] as const);
  await expect.poll(async () => ((await get(page, under.id)) as any).style.fill.colour).toBe('#ff0000');

  const k = await scale(page);
  const overlap = await ptToClient(page, { x: under.bounds.x + 60, y: under.bounds.y + 45 }); // inside both
  const fillAt = (p: Pt) => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('fill') ?? '', p);
  expect((await fillAt(overlap)).toLowerCase()).toBe('#0000ff'); // `over` is in front
  expect((await get(page, over.id)).zIndex).toBeGreaterThan((await get(page, under.id)).zIndex);

  // select `under` by clicking its exposed corner, then use the right-click menu
  const exposed = await ptToClient(page, { x: under.bounds.x + 6, y: under.bounds.y + 6 });
  await page.mouse.click(exposed.x, exposed.y);
  expect(await selection(page)).toEqual([under.id]);
  const before = await hashes(page);
  const r0 = await revision(page);
  await page.mouse.click(exposed.x, exposed.y, { button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  expect(await selection(page)).toEqual([under.id]); // the button's release reaches the shape, not the menu opened under the pointer
  await expect(page.getByTestId('context-front')).toBeEnabled();
  await page.getByTestId('context-front').click();
  await expect.poll(() => revision(page)).toBe(r0 + 1);
  await expect(page.getByTestId('context-menu')).toHaveCount(0);

  expect((await get(page, under.id)).zIndex).toBeGreaterThan((await get(page, over.id)).zIndex);
  expect((await fillAt(overlap)).toLowerCase()).toBe('#ff0000'); // and the canvas really draws it in front now
  expect(without(await hashes(page), under.id)).toEqual(without(before, under.id));
  const ch = await changesSince(page, r0);
  expect(ch.transactions[0]!.changed).toEqual([under.id]); // front moves only its own target: nothing intervenes

  // one step back through the keyboard shortcut
  await page.keyboard.press('Control+Shift+B');
  await expect.poll(() => revision(page)).toBe(r0 + 2);
  expect((await get(page, under.id)).zIndex).toBeLessThan((await get(page, over.id)).zIndex);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await get(page, under.id)).zIndex).toBeGreaterThan((await get(page, over.id)).zIndex);
  // and a second undo takes back Bring to front itself: the original order, drawn as before
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await get(page, under.id)).zIndex).toBeLessThan((await get(page, over.id)).zIndex);
  expect((await fillAt(overlap)).toLowerCase()).toBe('#0000ff');
  expect(k).toBeGreaterThan(0);
});

test('right-clicking another shape selects it; right-clicking empty canvas clears the selection, as a click there does', async ({ page }) => {
  await openEditor(page);
  const a = await placeShape(page, 'shape-rectangle', { x: 200, y: 200 }, 'a');
  const b = await placeShape(page, 'shape-rectangle', { x: 500, y: 200 }, 'b'); // placed last, so in front of `a`
  const pa = await centre(page, a.id), pb = await centre(page, b.id);
  await page.mouse.click(pa.x, pa.y);
  expect(await selection(page)).toEqual([a.id]);

  await test.step('right-click on another shape: it becomes the selection and the menu acts on it', async () => {
    await page.mouse.click(pb.x, pb.y, { button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    expect(await selection(page)).toEqual([b.id]);
    const r0 = await revision(page);
    await page.getByTestId('context-back').click();
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    expect((await get(page, b.id)).zIndex).toBeLessThan((await get(page, a.id)).zIndex);
  });

  await test.step('right-click on empty canvas: nothing is selected, so only actions that need no selection are offered', async () => {
    const empty = await ptToClient(page, { x: 800, y: 560 });
    await page.mouse.click(empty.x, empty.y, { button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    expect(await selection(page)).toEqual([]);
    await expect(page.getByTestId('context-copy')).toBeDisabled();
    await expect(page.getByTestId('context-front')).toBeDisabled();
    await expect(page.getByTestId('context-paste')).toBeEnabled();
  });
});

test('group, drag, ungroup and delete with real selection; one undo restores each action', async ({ page }) => {
  const errors = await openEditor(page);
  const { a, b, c, d } = await fourShapes(page);
  let r0 = await revision(page);

  await test.step('rubber band two shapes and group them from the keyboard', async () => {
    await rubberBand(page, { x: 30, y: 30 }, { x: 560, y: 260 });
    await expect.poll(async () => sorted(await selection(page))).toEqual(sorted([a.id, b.id]));
    await page.keyboard.press('Control+g');
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const g = (await elements(page)).find(e => e.kind === 'group') as GroupElement;
    expect(sorted(g.childIds)).toEqual(sorted([a.id, b.id]));
    expect(g.rotationDeg).toBe(0);
    const left = Math.min(a.bounds.x, b.bounds.x), top = Math.min(a.bounds.y, b.bounds.y);
    expect(g.bounds.x).toBeCloseTo(left, 6);
    expect(g.bounds.y).toBeCloseTo(top, 6);
    const ch = await changesSince(page, r0);
    expect(ch.transactions[0]!.created).toEqual([g.id]);
    expect(ch.transactions[0]!.changed).toEqual([]); // grouping rewrites no member
    expect(await targets(page)).toEqual([g.id]);
    await expect(page.getByTestId('inspector').locator('h2')).toHaveText('Group');
    await expect(page.getByTestId('group-frame')).toHaveCount(1); // the dashed frame is the visible sign of a group
  });

  const group = () => elements(page).then(es => es.find(e => e.kind === 'group') as GroupElement);

  await test.step('clicking a member selects the whole group; dragging moves every member in one revision', async () => {
    await clearSelection(page);
    const pa = await centre(page, a.id);
    await page.mouse.click(pa.x, pa.y);
    await expect.poll(async () => sorted(await selection(page))).toEqual(sorted([a.id, b.id]));
    const g0 = await group();
    const before = await hashes(page);
    r0 = await revision(page);
    const k = await scale(page);
    await drag(page, pa, { x: pa.x + 60 * k, y: pa.y + 40 * k });
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const [na, nb, g1] = [await get(page, a.id), await get(page, b.id), await group()];
    const dx = na.bounds.x - a.bounds.x, dy = na.bounds.y - a.bounds.y;
    expect(dx).toBeGreaterThan(30);
    expect(nb.bounds.x - b.bounds.x).toBeCloseTo(dx, 6); // the same displacement for every member
    expect(nb.bounds.y - b.bounds.y).toBeCloseTo(dy, 6);
    expect(g1.bounds.x).toBeCloseTo(g0.bounds.x + dx, 6);
    expect(without(await hashes(page), a.id, b.id, g0.id)).toEqual(without(before, a.id, b.id, g0.id));
    const ch = await changesSince(page, r0);
    expect(sorted(ch.transactions[0]!.changed)).toEqual(sorted([a.id, b.id, g0.id])); // descendants and the ancestor group are both reported
  });

  await test.step('Ctrl+click reaches into the group and selects one member', async () => {
    await clearSelection(page);
    const pb = await centre(page, b.id);
    await page.keyboard.down('Control');
    await page.mouse.click(pb.x, pb.y);
    await page.keyboard.up('Control');
    expect(await selection(page)).toEqual([b.id]);
    expect(await targets(page)).toEqual([b.id]); // a lone member, not the group
  });

  await test.step('turn the group by 90 degrees from the inspector', async () => {
    await clearSelection(page);
    const pa = await centre(page, a.id);
    await page.mouse.click(pa.x, pa.y);
    await expect(page.getByTestId('inspector').locator('h2')).toHaveText('Group');
    r0 = await revision(page);
    const g0 = await group();
    await page.getByTestId('field-turn').fill('90');
    await page.getByTestId('field-turn').press('Enter');
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const g1 = await group();
    expect(g1.rotationDeg).toBe(0);
    expect((await get(page, a.id)).rotationDeg).toBe(90);
    expect((await get(page, b.id)).rotationDeg).toBe(90);
    const cx = (e: { bounds: { x: number; width: number } }) => e.bounds.x + e.bounds.width / 2;
    expect(cx(g1)).toBeCloseTo(cx(g0), 6); // turned about its own centre
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await get(page, a.id)).rotationDeg).toBe(0);
  });

  await test.step('ungroup from the panel: members are untouched and one undo brings the group back', async () => {
    const before = await hashes(page);
    const g0 = await group();
    r0 = await revision(page);
    await page.getByTestId('arrange-ungroup').click();
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    expect((await elements(page)).some(e => e.kind === 'group')).toBe(false);
    await expect(page.getByTestId('group-frame')).toHaveCount(0);
    expect(only(await hashes(page), a.id, b.id)).toEqual(only(before, a.id, b.id));
    const ch = await changesSince(page, r0);
    expect(ch.transactions[0]!.deleted).toEqual([g0.id]);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await elements(page)).some(e => e.kind === 'group')).toBe(true);
    expect(await hashes(page)).toEqual(before);
  });

  await test.step('delete a complete group: the group and its members go together, undo restores them', async () => {
    const before = await hashes(page);
    await clearSelection(page);
    const pa = await centre(page, a.id);
    await page.mouse.click(pa.x, pa.y);
    r0 = await revision(page);
    await page.keyboard.press('Delete');
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const left = (await elements(page)).map(e => e.id);
    expect(sorted(left)).toEqual(sorted([c.id, d.id]));
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await elements(page)).length).toBe(Object.keys(before).length);
    expect(await hashes(page)).toEqual(before);
  });

  await test.step('duplicate a group copies its structure', async () => {
    await clearSelection(page);
    const pa = await centre(page, a.id);
    await page.mouse.click(pa.x, pa.y);
    r0 = await revision(page);
    await page.keyboard.press('Control+d');
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const groups = (await elements(page)).filter((e): e is GroupElement => e.kind === 'group');
    expect(groups).toHaveLength(2);
    expect(new Set(groups.flatMap(g => g.childIds)).size).toBe(4);
    expect((await snapshot(page)).document.pages[0]!.elements.filter(e => e.kind === 'shape')).toHaveLength(6);
  });

  expect(errors.filter(e => !/Failed to load resource|favicon/.test(e))).toEqual([]);
});

test('evidence: a grouped pair aligned with a third shape', async ({ page }) => {
  await openEditor(page);
  const { a, b, c } = await fourShapes(page);
  await rubberBand(page, { x: 30, y: 30 }, { x: 560, y: 260 });
  await page.keyboard.press('Control+g');
  await expect(page.getByTestId('group-frame')).toHaveCount(1);
  const r0 = await revision(page);
  await clearSelection(page);
  await rubberBand(page, { x: 30, y: 30 }, { x: 780, y: 300 }); // the group and the third shape
  await expect.poll(async () => (await targets(page)).length).toBe(2); // the group counts once
  await page.getByTestId('arrange-align-top').click();
  await expect.poll(() => revision(page)).toBe(r0 + 1);
  const g = (await elements(page)).find(e => e.kind === 'group')!;
  expect(g.bounds.y).toBeCloseTo((await get(page, c.id)).bounds.y, 6); // the group is one object: its frame, not its members, is what lines up
  await clearSelection(page);
  const pa = await centre(page, a.id);
  await page.mouse.click(pa.x, pa.y);
  await expect(page.getByTestId('group-frame')).toHaveCount(1);
  await page.screenshot({ path: '../../docs/m2/evidence/I20/grouped-and-aligned.png' });
  void b;
});

test('set level from Arrange preserves zero as the default and is undoable', async ({ page }) => {
  await openEditor(page);
  const shape = await placeShape(page, 'shape-rectangle', { x: 240, y: 150 }, 'leveled');
  await page.mouse.click((await centre(page, shape.id)).x, (await centre(page, shape.id)).y);
  const r0 = await revision(page);
  await page.getByTestId('arrange-level-input').fill('3');
  await page.getByTestId('arrange-level-set').click();
  await expect.poll(() => revision(page)).toBe(r0 + 1);
  expect((await get(page, shape.id)).level).toBe(3);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await get(page, shape.id)).level ?? 0).toBe(0);
});
