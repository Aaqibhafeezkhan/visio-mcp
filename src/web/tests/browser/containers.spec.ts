import { test, expect, type Page } from '@playwright/test';
import type { Element, ShapeElement } from '../../src/contracts/generated';
import { centre, drag, elements, openEditor, placeShape, ptToClient, revision, selection } from './support';

const get = async (page: Page, id: string): Promise<Element | undefined> => (await elements(page)).find(e => e.id === id);
const box = async (page: Page, id: string) => (await get(page, id))!.bounds;
const members = async (page: Page, id: string) => ((await get(page, id)) as ShapeElement | undefined)?.container?.memberIds ?? [];
const at = async (page: Page, x: number, y: number) => ptToClient(page, { x, y });

/** A point in the container's left margin, clear of its members and of the corner and edge-middle resize handles. */
const grip = (b: { x: number; y: number; height: number }) => ({ x: b.x + 5, y: b.y + b.height * 0.3 });

/** Clicks the container's margin, where none of its members are, so the container itself is picked. */
async function pickFrame(page: Page, id: string): Promise<void> {
  const g = grip(await box(page, id));
  const p = await at(page, g.x, g.y);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => selection(page)).toEqual([id]);
}

test('make a container from the selection, drag it with its contents, drag objects in and out, then disband and delete', async ({ page }) => {
  const errors = await openEditor(page);
  await page.evaluate(() => (window as any).__editor.agentApply([{ op: 'setPage', patch: { grid: { snap: false } } }]));
  const a = await placeShape(page, 'shape-rectangle', { x: 200, y: 150 }, 'a');
  const b = await placeShape(page, 'shape-rectangle', { x: 360, y: 150 }, 'b');
  const c = await placeShape(page, 'shape-rectangle', { x: 650, y: 420 }, 'c');

  let frame = '';
  await test.step('Arrange > Make container wraps the selection in one revision, behind it, and selects it', async () => {
    const from = await at(page, 120, 90), to = await at(page, 460, 220);
    await drag(page, from, to); // rubber band round a and b
    await expect.poll(async () => [...await selection(page)].sort()).toEqual([a.id, b.id].sort());
    const r0 = await revision(page);
    await page.getByTestId('menu-arrange').click();
    await page.getByTestId('menu-make-container').click();
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const made = (await elements(page)).find(e => e.kind === 'shape' && e.container) as ShapeElement;
    frame = made.id;
    expect(made.container).toEqual({ memberIds: [a.id, b.id], fit: 'grow', marginPt: 12 });
    expect(made.zIndex).toBeLessThan(Math.min((await get(page, a.id))!.zIndex, (await get(page, b.id))!.zIndex));
    expect(await selection(page)).toEqual([frame]);
  });

  await test.step('dragging the container moves its members with it, in the preview and in one committed revision', async () => {
    const b0 = await box(page, frame), a0 = await box(page, a.id), bb0 = await box(page, b.id), cBefore = await box(page, c.id);
    const g = grip(b0);
    const from = await at(page, g.x, g.y), to = await at(page, g.x + 100, g.y + 60);
    const r0 = await revision(page);
    await drag(page, from, to, { release: false });
    // the members travel with the frame in the drag preview
    await expect.poll(async () => [...await page.evaluate(() => (window as any).__editor.dragCells()) as string[]].sort()).toEqual([frame, a.id, b.id].sort());
    await page.mouse.up();
    await expect.poll(() => revision(page)).toBe(r0 + 1);
    const moved = await box(page, frame);
    const dx = moved.x - b0.x, dy = moved.y - b0.y;
    expect(dx).toBeGreaterThan(50);
    expect(await box(page, a.id)).toEqual({ ...a0, x: a0.x + dx, y: a0.y + dy });
    expect(await box(page, b.id)).toEqual({ ...bb0, x: bb0.x + dx, y: bb0.y + dy });
    expect(await box(page, c.id)).toEqual(cBefore);
  });

  await test.step('dropping an object wholly inside the container makes it a member; dragging a member clear takes it out', async () => {
    const f = await box(page, frame), cb = await box(page, c.id);
    // c lands inside the frame's lower right, and the frame grows if it needs to
    const target = { x: f.x + f.width - cb.width / 2 - 20, y: f.y + f.height - cb.height / 2 - 20 };
    const r0 = await revision(page);
    await drag(page, await centre(page, c.id), await at(page, target.x, target.y));
    await expect.poll(() => members(page, frame)).toEqual([a.id, b.id, c.id]);
    expect(await revision(page)).toBe(r0 + 1);
    const ab = await box(page, a.id);
    await drag(page, await centre(page, a.id), await at(page, ab.x + ab.width / 2, ab.y + 400));
    await expect.poll(() => members(page, frame)).toEqual([b.id, c.id]);
  });

  await test.step('the inspector changes how the container fits, and disbands it', async () => {
    await pickFrame(page, frame);
    await expect(page.getByTestId('container-members')).toContainText('Holds 2 objects');
    await page.getByTestId('field-container-fit').selectOption('fit');
    await expect.poll(async () => ((await get(page, frame)) as ShapeElement).container?.fit).toBe('fit');
    const f = await box(page, frame), bb = await box(page, b.id), cc = await box(page, c.id);
    expect(f.x).toBeCloseTo(Math.min(bb.x, cc.x) - 12, 6);
    expect(f.x + f.width).toBeCloseTo(Math.max(bb.x + bb.width, cc.x + cc.width) + 12, 6);
    await page.getByTestId('container-disband').click();
    await expect.poll(async () => ((await get(page, frame)) as ShapeElement).container).toBeUndefined();
    await page.keyboard.press('Control+z'); // undo the disband
    await expect.poll(() => members(page, frame)).toEqual([b.id, c.id]);
  });

  await test.step('Delete on a container deletes it with what it holds', async () => {
    await pickFrame(page, frame);
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await elements(page)).map(e => e.id).sort()).toEqual([a.id]);
  });

  expect(errors).toEqual([]);
});
