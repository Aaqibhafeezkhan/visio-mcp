import { test, expect, type Page } from '@playwright/test';
import { openEditor, snapshot } from './support';

// R25: route proposals on the real hidden projector (MaxGraphAdapter), which remembers the routes it drew.
const box = (x: number, y: number, width = 100, height = 60) => ({ x, y, width, height });
const call = (page: Page, method: string, params: Record<string, unknown>) =>
  page.evaluate(([m, p]) => (window as any).__editor.callTool(m, p), [method, params] as const) as Promise<{ result?: any; error?: any }>;
const apply = (page: Page, ops: unknown[]) => page.evaluate(o => (window as any).__editor.agentApply(o), ops) as Promise<{ ok: boolean; value?: any; error?: any }>;
const projection = async (page: Page) => (await page.evaluate(() => (window as any).__editor.exportSnapshot())).projection.connectors as Record<string, { routePoints: Array<{ x: number; y: number }> }>;
const commit = (page: Page, c: { baseRevision: number; operations: unknown[] }) =>
  call(page, 'doc.apply', { transactionId: crypto.randomUUID(), baseRevision: c.baseRevision, atomic: true, operations: c.operations });
const near = (a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>) =>
  a.length === b.length && a.every((p, i) => Math.abs(p.x - b[i]!.x) < 0.01 && Math.abs(p.y - b[i]!.y) < 0.01);

async function scene(page: Page, extra: unknown[]): Promise<Map<string, string>> {
  const pageId = (await snapshot(page)).document.pages[0]!.id;
  const made = await apply(page, [
    { op: 'createShape', pageId, alias: 'a', bounds: box(0, 100) },
    { op: 'createShape', pageId, alias: 'b', bounds: box(700, 100) },
    { op: 'createShape', pageId, alias: 'c', bounds: box(300, 400) },
    { op: 'createShape', pageId, alias: 'd', bounds: box(700, 400) },
    { op: 'createShape', pageId, alias: 'wall', bounds: box(330, 122, 40, 16) },
    { op: 'createConnector', pageId, alias: 'ab', from: { elementId: 'a', port: 'east', glue: 'static' }, to: { elementId: 'b', port: 'west', glue: 'static' }, route: 'orthogonal' },
    ...extra,
  ]);
  expect(made.ok, JSON.stringify(made.error)).toBe(true);
  expect((await apply(page, [{ op: 'delete', target: 'wall' }])).ok).toBe(true); // the detour is kept: only an explicit reroute straightens it
  return new Map((await snapshot(page)).document.pages[0]!.elements.filter(e => e.alias).map(e => [e.alias!, e.id]));
}

test('a proposal leaves the projection as it was, and its points are the geometry the commit draws', async ({ page }) => {
  await openEditor(page);
  const ids = await scene(page, [
    { op: 'createConnector', alias: 'cd', from: { elementId: 'c', port: 'east', glue: 'static' }, to: { elementId: 'd', port: 'west', glue: 'static' }, route: 'orthogonal' },
    { op: 'createText', alias: 'note', bounds: { x: 0, y: 0, width: 60, height: 20 }, text: { value: 'note' }, attachment: { connector: 'cd', position: 0.5 } },
  ]);
  // make ab an older connector with no stored route: the hidden projector then draws it from its memory of the detour
  const snap = await snapshot(page);
  const legacy = structuredClone(snap.document);
  for (const e of legacy.pages[0]!.elements) if (e.id === ids.get('ab')) delete (e as any).routing;
  const replaced = await call(page, 'doc.replace', { document: legacy, baseRevision: snap.revision });
  expect(replaced.error, JSON.stringify(replaced.error)).toBeUndefined();

  const drawn = await projection(page);
  const diagnostics = await call(page, 'doc.getObjects', { ids: [ids.get('ab'), ids.get('cd')] });
  expect(drawn[ids.get('ab')!]!.routePoints.length).toBeGreaterThan(2);

  const proposed = await call(page, 'doc.proposeRoutes', {});
  expect(proposed.error, JSON.stringify(proposed.error)).toBeUndefined();
  const proposal = proposed.result;
  const ab = proposal.routes.find((r: any) => r.id === ids.get('ab'));
  expect(ab.geometryChanged).toBe(true);
  expect(proposal.commit).toBeDefined();

  // nothing moved: the same projection and diagnostics for the unchanged document
  expect(await projection(page)).toEqual(drawn);
  expect((await call(page, 'doc.getObjects', { ids: [ids.get('ab'), ids.get('cd')] })).result).toEqual(diagnostics.result);

  const applied = await commit(page, proposal.commit);
  expect(applied.error, JSON.stringify(applied.error)).toBeUndefined();
  const after = await projection(page);
  for (const r of proposal.routes) expect(near(after[r.id]!.routePoints, r.points), r.id).toBe(true);
});

test('no proposal offers a commit that leaves a joined branch off its trunk', async ({ page }) => {
  await openEditor(page);
  const ids = await scene(page, [
    { op: 'createConnector', alias: 'tap', from: { elementId: 'c', glue: 'dynamic' }, to: { glue: 'none', join: { connector: 'ab', position: 0.5 } }, route: 'orthogonal' },
  ]);
  await projection(page); // a read, as get_objects or an export does
  const scoped = await call(page, 'doc.proposeRoutes', { connectorIds: [ids.get('ab')] });
  expect(scoped.error?.code).toBe('dependency_conflict');
  expect(scoped.error?.details?.connectorIds).toEqual([ids.get('tap')]);

  const both = await call(page, 'doc.proposeRoutes', { connectorIds: [ids.get('ab'), ids.get('tap')] });
  if (both.error) {
    expect(both.error).toMatchObject({ code: 'dependency_conflict', details: { reason: 'join_not_followed' } });
    return;
  }
  expect((await commit(page, both.result.commit)).error).toBeUndefined();
  const doc = (await snapshot(page)).document.pages[0]!.elements;
  const tap = doc.find(e => e.id === ids.get('tap')) as any;
  const trunk = (doc.find(e => e.id === ids.get('ab')) as any).routing.advisory as Array<{ x: number; y: number }>;
  expect(trunk.some((p, i) => i > 0 && Math.abs(p.y - tap.to.point.y) < 0.01 && Math.min(p.x, trunk[i - 1]!.x) <= tap.to.point.x && tap.to.point.x <= Math.max(p.x, trunk[i - 1]!.x))).toBe(true);
});
