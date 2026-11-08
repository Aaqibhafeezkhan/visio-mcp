import { describe, expect, it, vi } from 'vitest';
import type { DiagramDocument, Element, Page } from '../src/contracts/generated';
import { buildBeautifyPreview } from '../src/editor/beautifyPreview';

const solid = { kind: 'solid', colour: '#fff', opacity: 1 } as const;
const shape = (id: string, x: number, y: number, width: number, height: number, extra: object = {}): Element => ({
  id, kind: 'shape', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: { x, y, width, height }, rotationDeg: 0, metadata: {}, geometry: { preset: 'rectangle' },
  style: { fill: solid, stroke: solid, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' }, ...extra,
} as unknown as Element);
const attached = (id: string, from: string, to: string, extra: object = {}): Element => ({
  id, kind: 'connector', layerIds: [], zIndex: 2, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, rotationDeg: 0, metadata: {},
  from: { elementId: from, glue: 'dynamic', ...(extra as { requiredSide?: string }).requiredSide ? { requiredSide: (extra as { requiredSide: string }).requiredSide } : {} },
  to: { elementId: to, glue: 'dynamic' }, route: 'orthogonal', waypoints: [],
  style: { colour: '#000', widthPt: 1, dash: 'solid', startArrow: 'none', endArrow: 'none' },
} as unknown as Element);
const free = (id: string, extra: object = {}): Element => ({
  id, kind: 'connector', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, rotationDeg: 0, metadata: {},
  from: { glue: 'none', point: { x: 0, y: 0 } }, to: { glue: 'none', point: { x: 100, y: 0 } }, route: 'orthogonal', waypoints: [],
  style: { colour: '#000', widthPt: 1, dash: 'solid', startArrow: 'none', endArrow: 'none' }, ...extra,
} as unknown as Element);
const documentOf = (elements: Element[], crossing?: 'avoid' | 'allow'): DiagramDocument => ({
  schemaVersion: 1, id: 'doc', title: 'Preview', revision: 7, pages: [{
    id: 'page', name: 'Page 1', widthPt: 800, heightPt: 600, background: { kind: 'none' },
    grid: { visible: false, spacingPt: 10, snap: false }, guides: [], layers: [], elements,
  } as Page], assets: [], metadata: {}, ...(crossing ? { routingDefaults: { crossing } } : {}),
});

describe('buildBeautifyPreview', () => {
  it('returns deterministic exact proposals for selected targets and leaves the snapshot unchanged', async () => {
    const source = documentOf([free('b', { routing: { advisory: [{ x: 0, y: 0 }, { x: 100, y: 0 }] } }), free('a')]);
    const before = JSON.stringify(source);
    const preview = await buildBeautifyPreview(source, 'page', ['b', 'a']);
    const again = await buildBeautifyPreview(source, 'page', ['a', 'b']);

    expect(preview.baseRevision).toBe(7);
    expect(preview.pageId).toBe('page');
    expect(preview.targets).toEqual(['a', 'b']);
    expect(preview.proposedRoutes.map(r => r.id)).toEqual(again.proposedRoutes.map(r => r.id));
    expect(preview.proposedRoutes).toEqual(again.proposedRoutes);
    for (const route of preview.proposedRoutes) expect(route.points).toEqual(again.proposedRoutes.find(r => r.id === route.id)!.points);
    expect(preview.changedCount).toBe(preview.proposedRoutes.length);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('materializes page targets when targetIds is omitted and only selected targets when supplied', async () => {
    const source = documentOf([free('c'), free('a'), free('b')]);
    const page = await buildBeautifyPreview(source, 'page');
    const selected = await buildBeautifyPreview(source, 'page', ['b']);
    expect(page.targets).toEqual(['a', 'b', 'c']);
    expect(selected.targets).toEqual(['b']);
    expect(selected.proposedRoutes).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(selected.proposedRoutes[0]!.points))).toEqual(selected.proposedRoutes[0]!.points);
  });

  it('skips manual, frozen, element-locked and layer-locked connectors', async () => {
    const source = documentOf([
      free('manual', { waypoints: [{ x: 50, y: 10 }] }),
      free('frozen', { routing: { mode: 'frozen', advisory: [{ x: 0, y: 0 }, { x: 100, y: 0 }] } }),
      free('guided', { routing: { constraints: [{ axis: 'h', index: 0, at: 10 }] } }),
      free('locked', { locked: true }),
      free('layer-locked', { layerIds: ['locked-layer'] }),
      free('ready'),
    ]);
    source.pages[0]!.layers.push({ id: 'locked-layer', name: 'Locked', visible: true, locked: true, printable: true, snap: true, glue: true });
    const preview = await buildBeautifyPreview(source, 'page');
    expect(preview.targets).toEqual(['ready']);
    expect(preview.skipped.map(x => x.id)).toEqual(['frozen', 'guided', 'layer-locked', 'locked', 'manual']);
    expect(preview.skipped.find(x => x.id === 'guided')?.reason).toBe('guided connectors keep their pinned runs');
    expect(preview.skipped.every(x => x.reason.length > 0)).toBe(true);
  });

  it('skips hidden connectors during page-wide materialization', async () => {
    const preview = await buildBeautifyPreview(documentOf([free('hidden', { hidden: true }), free('visible')]), 'page');
    expect(preview.targets).toEqual(['visible']);
    expect(preview.skipped).toEqual([{ id: 'hidden', reason: 'hidden connectors are not eligible for Beautify' }]);
  });

  it('reports an unroutable target while still proposing feasible targets', async () => {
    const source = documentOf([
      shape('start', 100, 100, 100, 60), shape('end', 700, 100, 100, 60),
      shape('wall', 0, 0, 1000, 700, { routingPolicy: { obstacle: 'forbidden' } }),
      attached('blocked', 'start', 'end', { requiredSide: 'north' }),
      free('a', { from: { glue: 'none', point: { x: 1500, y: 1500 } }, to: { glue: 'none', point: { x: 1600, y: 1500 } } }),
      free('b', { from: { glue: 'none', point: { x: 1500, y: 1500 } }, to: { glue: 'none', point: { x: 1600, y: 1500 } } }),
    ]);
    const preview = await buildBeautifyPreview(source, 'page');
    expect(preview.skipped).toContainEqual(expect.objectContaining({ id: 'blocked' }));
    expect(preview.proposedRoutes.length).toBeGreaterThan(0);
    expect(preview.proposedRoutes.some(route => route.id === 'blocked')).toBe(false);
  });

  it('passes the shared width measurer and document crossing default to the planner', async () => {
    const measureWidth = vi.fn(() => 8);
    const label = { value: 'protected label', fontFamily: 'Arial', fontSizePt: 12, bold: false, italic: false, underline: false, colour: '#000', horizontalAlign: 'center', verticalAlign: 'middle', wrap: false, paddingPt: 0 } as const;
    const source = documentOf([free('labelled', { label }), free('other')], 'allow');
    await buildBeautifyPreview(source, 'page', undefined, { measureWidth });
    expect(measureWidth).toHaveBeenCalled();
  });
});
