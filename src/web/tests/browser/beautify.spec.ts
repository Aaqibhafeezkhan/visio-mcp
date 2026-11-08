import { test, expect } from '@playwright/test';
import { elements, openEditor, ptToClient, revision, selection, snapshot } from './support';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function addOverlappingConnectors(page: import('@playwright/test').Page) {
  const result = await page.evaluate(ids => (window as any).__editor.agentApply(ids.map((id: string, i: number) => ({
    op: 'createConnector', id, from: { glue: 'none', point: { x: 0, y: 200 } }, to: { glue: 'none', point: { x: 100, y: 200 } },
    route: 'orthogonal', waypoints: [], style: { colour: '#334155', widthPt: 1 },
    ...(i === 0 ? { label: { value: 'Nearby label', fontFamily: 'Segoe UI', fontSizePt: 10, bold: false, italic: false, underline: false, colour: '#000000', horizontalAlign: 'center', verticalAlign: 'middle', wrap: false, paddingPt: 0 }, labelAnchor: { position: 0.5, offsetPt: 6 } } : {}),
  }))), [id(980), id(981)]);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

test('Beautify previews exact routes, reports skipped manual routes, applies one undoable transaction, and rejects stale acceptance', async ({ page }) => {
  const errors = await openEditor(page);
  await addOverlappingConnectors(page);
  const manual = await page.evaluate(manualId => (window as any).__editor.agentApply([{ op: 'createConnector', id: manualId,
    from: { glue: 'none', point: { x: 0, y: 320 } }, to: { glue: 'none', point: { x: 100, y: 320 } }, route: 'orthogonal', waypoints: [{ x: 50, y: 350 }],
    style: { colour: '#334155', widthPt: 1 },
  }]), id(982));
  expect(manual.ok).toBe(true);
  const start = await revision(page);
  await page.getByTestId('menu-arrange').click();
  await page.getByTestId('menu-beautify-preview').click();
  await expect(page.getByTestId('beautify-dialog')).toBeVisible();
  await expect(page.getByTestId('beautify-scope')).toHaveValue('page');
  await expect(page.getByTestId('beautify-overlay')).toBeVisible();
  await expect(page.getByTestId('beautify-dialog')).toContainText('manual connectors are not eligible');
  await expect(page.getByTestId('beautify-changed-count')).toContainText('2 connectors will change');
  await expect(page.getByTestId('beautify-apply')).toBeEnabled();
  const overlays = page.locator('[data-testid="beautify-overlay"] polyline');
  await expect(overlays).toHaveCount(2);
  expect(await overlays.first().getAttribute('points')).toBeTruthy();
  const staleRevision = await revision(page);
  await page.evaluate(newId => (window as any).__editor.agentApply([{ op: 'createShape', id: newId, bounds: { x: 500, y: 400, width: 30, height: 30 } }]), id(983));
  await expect(page.getByTestId('beautify-apply')).toBeDisabled();
  await expect(page.getByTestId('beautify-dialog')).toContainText('drawing changed after this preview');
  await page.getByTestId('beautify-refresh').click();
  await expect(page.getByTestId('beautify-apply')).toBeEnabled();
  await page.getByTestId('beautify-apply').click();
  await expect(page.getByTestId('beautify-dialog')).toHaveCount(0);
  await expect.poll(() => revision(page)).toBe(staleRevision + 2);
  const after = await elements(page);
  const target = after.find(e => e.id === id(981)) as any;
  expect(target.routing?.beautified).toBe(true);
  expect(target.routing?.advisory).toBeTruthy();
  expect((after.find(e => e.id === id(980)) as any).routing?.beautified).toBe(true);
  expect(after.find(e => e.id === id(980))).toMatchObject({ id: id(980) });
  expect(after.find(e => e.id === id(982))).toMatchObject({ waypoints: [{ x: 50, y: 350 }] });
  expect(errors).toEqual([]);
  const beforeUndo = await revision(page);
  await page.getByTestId('menu-edit').click();
  await page.getByTestId('menu-undo').click();
  await expect.poll(() => revision(page)).toBe(beforeUndo + 1);
  expect((await elements(page)).filter(e => e.id === id(980) || e.id === id(981)).every(e => !(e as any).routing?.beautified)).toBe(true);
  await page.getByTestId('menu-edit').click();
  await page.getByTestId('menu-redo').click();
  await expect.poll(() => revision(page)).toBe(beforeUndo + 2);
  expect((await elements(page)).filter(e => e.id === id(980) || e.id === id(981)).every(e => (e as any).routing?.beautified)).toBe(true);
  const beforeCancel = await snapshot(page);
  await page.getByTestId('menu-arrange').click();
  await page.getByTestId('menu-beautify-preview').click();
  await expect(page.getByTestId('beautify-dialog')).toBeVisible();
  await page.getByTestId('beautify-dialog').getByRole('button', { name: 'Cancel' }).click();
  expect((await snapshot(page)).revision).toBe(beforeCancel.revision);
  const objectList = page.getByRole('listbox', { name: /Objects on Page 1/ });
  await objectList.focus();
  await objectList.press('Home');
  await expect.poll(() => selection(page)).toContain(id(980));
  await page.getByTestId('menu-arrange').click();
  await page.getByTestId('menu-beautify-preview').click();
  await expect(page.getByTestId('beautify-scope')).toHaveValue('selection');
  await page.getByTestId('beautify-scope').selectOption('page');
  await expect(page.getByTestId('beautify-scope')).toHaveValue('page');
  await page.getByTestId('beautify-dialog').getByRole('button', { name: 'Cancel' }).click();
});

test('a page-wide preview for 60 connectors keeps the editor event loop responsive', async ({ page }) => {
  const errors = await openEditor(page);
  const ids = Array.from({ length: 60 }, (_, index) => id(800 + index));
  const created = await page.evaluate(ids => (window as any).__editor.agentApply(ids.map((id: string) => ({
    op: 'createConnector', id, from: { glue: 'none', point: { x: 0, y: 200 } }, to: { glue: 'none', point: { x: 100, y: 200 } },
    route: 'orthogonal', waypoints: [], style: { colour: '#334155', widthPt: 1 },
  }))), ids);
  expect(created.ok).toBe(true);
  await page.getByTestId('menu-arrange').click();
  await page.getByTestId('menu-beautify-preview').click();
  await expect(page.getByTestId('beautify-dialog')).toBeVisible();
  const tickDelay = await page.evaluate(() => new Promise<number>(resolve => {
    const started = performance.now();
    setTimeout(() => resolve(performance.now() - started), 0);
  }));
  expect(tickDelay).toBeLessThan(250);
  await expect(page.getByTestId('beautify-changed-count')).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('selected-shape Beautify omits non-connectors from skipped results', async ({ page }) => {
  const errors = await openEditor(page);
  const shapeId = id(984);
  const created = await page.evaluate(shapeId => (window as any).__editor.agentApply([{ op: 'createShape', id: shapeId,
    bounds: { x: 100, y: 100, width: 120, height: 60 }, geometry: { preset: 'rectangle' },
  }]), shapeId);
  expect(created.ok).toBe(true);
  const point = await ptToClient(page, { x: 160, y: 130 });
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => selection(page)).toContain(shapeId);
  await page.getByTestId('menu-arrange').click();
  await page.getByTestId('menu-beautify-preview').click();
  await expect(page.getByTestId('beautify-dialog')).toBeVisible();
  await expect(page.getByTestId('beautify-scope')).toHaveValue('selection');
  await expect(page.getByRole('heading', { name: 'Skipped' })).toHaveCount(0);
  await expect(page.getByTestId('beautify-dialog')).not.toContainText(shapeId);
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(errors).toEqual([]);
});
