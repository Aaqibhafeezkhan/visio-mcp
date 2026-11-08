import { test, expect } from '@playwright/test';
import { centre, openEditor, ptToClient, snapshot } from './support';

const element = async (page: import('@playwright/test').Page, id: string) =>
  (await snapshot(page)).document.pages[0]!.elements.find(el => el.id === id) as any;

async function selectAt(page: import('@playwright/test').Page, point: { x: number; y: number }) {
  const client = await ptToClient(page, point);
  await page.mouse.click(client.x, client.y);
}

test('MCP layout inspection surfaces route policy findings from the committed projection', async ({ page }) => {
  await openEditor(page);
  const ids = {
    a: '00000000-0000-4000-8000-000000000a01', b: '00000000-0000-4000-8000-000000000a02',
    soft: '00000000-0000-4000-8000-000000000a03', link: '00000000-0000-4000-8000-000000000a04',
  };
  const applied = await page.evaluate(ids => (window as any).__editor.agentApply([
    { op: 'createShape', id: ids.a, bounds: { x: 20, y: 480, width: 60, height: 40 } },
    { op: 'createShape', id: ids.b, bounds: { x: 740, y: 480, width: 60, height: 40 } },
    { op: 'createShape', id: ids.soft, bounds: { x: 0, y: 0, width: 841, height: 595 } },
    { op: 'createConnector', id: ids.link, from: { elementId: ids.a, glue: 'static', port: 'east' }, to: { elementId: ids.b, glue: 'static', port: 'west' }, route: 'orthogonal' },
    { op: 'set', target: ids.soft, patch: { routingPolicy: { obstacle: 'avoid' } } },
  ]), ids);
  expect(applied.ok).toBe(true);
  const committed = await page.evaluate(() => (window as any).__editor.exportSnapshot());
  expect(committed.projection.connectors[ids.link].routeFindings).toContainEqual(expect.objectContaining({ code: 'ROUTING_AVOIDANCE_VIOLATION', blockerIds: [ids.soft] }));
  const inspected = await page.evaluate(() => (window as any).__editor.callTool('doc.inspectLayout', {}));
  const report = inspected.result ?? inspected;
  expect(report.issues).toContainEqual(expect.objectContaining({ code: 'ROUTING_AVOIDANCE_VIOLATION', elementIds: [ids.link, ids.soft] }));
  expect(report.issues.filter((issue: any) => issue.code === 'CONNECTOR_CROSSES_SHAPE' && issue.elementIds.includes(ids.soft))).toHaveLength(0);
  expect((await snapshot(page)).revision).toBe(committed.revision);
});

test('inspector_sets_and_clears_obstacle_policy', async ({ page }) => {
  await openEditor(page);
  const id = '00000000-0000-4000-8000-000000000b01';
  expect((await page.evaluate(id => (window as any).__editor.agentApply([
    { op: 'createShape', id, bounds: { x: 120, y: 130, width: 100, height: 60 }, text: { value: 'Database' } },
  ]), id)).ok).toBe(true);
  await selectAt(page, { x: 170, y: 160 });

  await page.getByTestId('field-obstacle-policy').selectOption('forbidden');
  await page.getByTestId('field-route-clearance').fill('16');
  await page.getByTestId('field-route-clearance').press('Enter');
  await page.getByTestId('field-text-obstacle-policy').selectOption('avoid');
  await expect.poll(async () => {
    const policy = (await element(page, id)).routingPolicy;
    return [policy?.obstacle, policy?.clearancePt, policy?.text];
  }).toEqual(['forbidden', 16, 'avoid']);

  await selectAt(page, { x: 700, y: 500 });
  await selectAt(page, { x: 170, y: 160 });
  await expect(page.getByTestId('field-obstacle-policy')).toHaveValue('forbidden');
  await expect(page.getByTestId('field-route-clearance')).toHaveValue('16');
  await expect(page.getByTestId('field-text-obstacle-policy')).toHaveValue('avoid');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await element(page, id)).routingPolicy).toBeUndefined();
});

test('inspector_sets_dynamic_endpoint_preferred_side', async ({ page }) => {
  await openEditor(page);
  const ids = {
    a: '00000000-0000-4000-8000-000000000b11', b: '00000000-0000-4000-8000-000000000b12',
    wall: '00000000-0000-4000-8000-000000000b13', link: '00000000-0000-4000-8000-000000000b14',
  };
  expect((await page.evaluate(ids => (window as any).__editor.agentApply([
    { op: 'createShape', id: ids.a, bounds: { x: 100, y: 100, width: 100, height: 60 }, text: { value: 'A' } },
    { op: 'createShape', id: ids.b, bounds: { x: 100, y: 500, width: 100, height: 60 }, text: { value: 'B' } },
    { op: 'createShape', id: ids.wall, bounds: { x: 210, y: 80, width: 40, height: 160 } },
    { op: 'createConnector', id: ids.link, from: { elementId: ids.a, glue: 'dynamic' }, to: { elementId: ids.b, glue: 'dynamic' }, route: 'orthogonal' },
  ]), ids)).ok).toBe(true);
  expect((await page.evaluate(wall => (window as any).__editor.agentApply([
    { op: 'set', target: wall, patch: { routingPolicy: { obstacle: 'forbidden' } } },
  ]), ids.wall)).ok).toBe(true);
  const mid = await centre(page, ids.link);
  await page.mouse.click(mid.x, mid.y);

  await page.getByTestId('field-from-preferred-side').selectOption('south');
  await page.getByTestId('field-to-preferred-side').selectOption('north');
  await expect.poll(async () => {
    const current = await element(page, ids.link);
    return [current.from.preferredSide, current.to.preferredSide];
  }).toEqual(['south', 'north']);

  await selectAt(page, { x: 700, y: 500 });
  const updatedMid = await centre(page, ids.link);
  await page.mouse.click(updatedMid.x, updatedMid.y);
  await expect(page.getByTestId('field-from-preferred-side')).toHaveValue('south');
  await page.getByTestId('field-from-preferred-side').selectOption('east');
  await expect(page.getByTestId('route-side-relaxed')).toContainText('preferred endpoint side had no clear route');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => {
    const current = await element(page, ids.link);
    return [current.from.preferredSide, current.to.preferredSide];
  }).toEqual([undefined, undefined]);
});

test('routing defaults and connector policies are editable without changing routes on ordinary edits', async ({ page }) => {
  const errors = await openEditor(page);
  const [a, b, c, link, link2] = ['00000000-0000-4000-8000-000000000970', '00000000-0000-4000-8000-000000000971', '00000000-0000-4000-8000-000000000973', '00000000-0000-4000-8000-000000000972', '00000000-0000-4000-8000-000000000974'];
  const created = await page.evaluate(([a, b, c, link, link2]) => (window as any).__editor.agentApply([
    { op: 'createShape', id: a, bounds: { x: 100, y: 160, width: 50, height: 30 }, geometry: { preset: 'rectangle' } },
    { op: 'createShape', id: b, bounds: { x: 360, y: 160, width: 50, height: 30 }, geometry: { preset: 'rectangle' } },
    { op: 'createShape', id: c, bounds: { x: 360, y: 360, width: 50, height: 30 }, geometry: { preset: 'rectangle' } },
    { op: 'createConnector', id: link, from: { elementId: a, glue: 'static', port: 'east' }, to: { elementId: b, glue: 'static', port: 'west' }, route: 'orthogonal' },
    { op: 'createConnector', id: link2, from: { elementId: b, glue: 'dynamic' }, to: { elementId: c, glue: 'dynamic' }, route: 'orthogonal' },
  ]), [a, b, c, link, link2]);
  expect(created.ok).toBe(true);

  await page.getByTestId('menu-edit').click();
  await page.getByTestId('menu-routing-defaults').click();
  await expect(page.getByTestId('routing-defaults-dialog')).toBeVisible();
  await page.getByTestId('routing-default-crossing').selectOption('allow');
  await expect.poll(async () => (await snapshot(page)).document.routingDefaults?.crossing).toBe('allow');
  await page.getByTestId('routing-default-crossing').selectOption('default');
  await expect.poll(async () => (await snapshot(page)).document).not.toHaveProperty('routingDefaults');
  await page.getByTestId('routing-default-crossing').selectOption('allow');
  await expect.poll(async () => (await snapshot(page)).document.routingDefaults?.crossing).toBe('allow');
  await page.getByTestId('routing-defaults-close').click();

  await selectAt(page, { x: 255, y: 175 });
  await expect(page.getByTestId('field-crossing-policy')).toBeVisible();
  await page.getByTestId('field-crossing-policy').selectOption('avoid');
  await page.getByTestId('field-crossing-policy').selectOption('');
  await expect.poll(async () => (await element(page, link)).routingPolicy).not.toHaveProperty('crossing');
  await page.getByTestId('field-crossing-policy').selectOption('avoid');
  await page.getByTestId('field-route-priority').fill('120');
  await page.getByTestId('field-route-priority').press('Enter');
  await expect(page.getByTestId('field-route-priority')).toHaveValue('100');
  await page.getByTestId('field-route-priority').fill('37');
  await page.getByTestId('field-route-priority').press('Enter');
  await page.getByTestId('field-required-side-from').selectOption('east');
  await page.getByTestId('field-required-side-to').selectOption('west');
  await expect.poll(async () => await element(page, link)).toMatchObject({
    routingPolicy: { crossing: 'avoid', priority: 37 }, from: { requiredSide: 'east' }, to: { requiredSide: 'west' },
  });
  const routesBefore = (await snapshot(page)).document.pages[0]!.elements.filter(e => e.kind === 'connector').map((e: any) => ({ id: e.id, from: e.from, to: e.to, waypoints: e.waypoints, routing: e.routing, bounds: e.bounds }));

  await selectAt(page, { x: 125, y: 175 });
  await page.getByTestId('field-name').fill('renamed shape');
  await page.getByTestId('field-name').blur();
  await expect.poll(async () => (await element(page, a)).name).toBe('renamed shape');
  const routesAfter = (await snapshot(page)).document.pages[0]!.elements.filter(e => e.kind === 'connector').map((e: any) => ({ id: e.id, from: e.from, to: e.to, waypoints: e.waypoints, routing: e.routing, bounds: e.bounds }));
  expect(routesAfter).toEqual(routesBefore);
  expect(errors).toEqual([]);
});

test('routing defaults dialog contains focus and blocks editor shortcuts', async ({ page }) => {
  await openEditor(page);
  const shape = '00000000-0000-4000-8000-000000000975';
  const created = await page.evaluate(shape => (window as any).__editor.agentApply([
    { op: 'createShape', id: shape, bounds: { x: 120, y: 130, width: 100, height: 60 } },
  ]), shape);
  expect(created.ok).toBe(true);
  await selectAt(page, { x: 170, y: 160 });
  await expect.poll(async () => (await snapshot(page)).document.pages[0]!.elements.some(e => e.id === shape)).toBe(true);
  await page.getByTestId('tool-connector').click();
  await page.getByTestId('menu-edit').click();
  await page.getByTestId('menu-routing-defaults').click();
  const dialog = page.getByTestId('routing-defaults-dialog');
  await expect(dialog).toBeVisible();
  const before = await snapshot(page);
  await expect(page.getByTestId('routing-default-crossing')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('routing-defaults-close')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('routing-default-crossing')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('routing-defaults-close')).toBeFocused();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+z');
  expect((await snapshot(page)).revision).toBe(before.revision);
  expect((await snapshot(page)).document.pages[0]!.elements.some(e => e.id === shape)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('tool-connector')).toHaveAttribute('aria-pressed', 'true');
});
