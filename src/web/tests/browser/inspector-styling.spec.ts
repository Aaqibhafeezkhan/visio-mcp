import { test, expect, type Page } from '@playwright/test';
import type { ConnectorElement, ShapeElement } from '../../src/contracts/generated';
import { centre, elements, openEditor, placeShape, revision, scale } from './support';

/**
 * A04: the inspector's line, arrowhead and font controls, driven the way a person drives them (real clicks, typing and drop-down choices).
 * Every change is checked three ways: the committed semantic value, what the canvas draws, and the transaction itself (one revision, one
 * undo, redo restores it, and no other object is touched).
 */

const canonical = async (page: Page) => Object.fromEntries((await elements(page)).map(e => [e.id, JSON.stringify(e)]));
type Canon = Record<string, string>;
const differing = (a: Canon, b: Canon) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(id => a[id] !== b[id]);

/** One user change: it makes one revision, changes only `target`, and undo and redo move exactly that object back and forth. */
async function change(page: Page, target: string, act: () => Promise<unknown>, settled: () => Promise<void>) {
  const before = await canonical(page);
  const r0 = await revision(page);
  await act();
  await settled();
  const after = await canonical(page);
  expect(await revision(page), 'one change is one revision').toBe(r0 + 1);
  expect(differing(before, after), 'nothing but the edited object changes').toEqual([target]);
  await page.getByTestId('tool-undo').click();
  await expect.poll(() => revision(page)).toBe(r0 + 2);
  expect(await canonical(page), 'undo restores every object exactly').toEqual(before);
  await page.getByTestId('tool-redo').click();
  await expect.poll(() => revision(page)).toBe(r0 + 3);
  expect(await canonical(page), 'redo restores the change exactly').toEqual(after);
}

interface DrawnPath { d: string; fill: string | null; stroke: string | null; width: number | null; dash: string | null; box: { x0: number; x1: number; y0: number; y1: number } }

/** Everything the canvas draws as a path, minus the selection chrome (green) and the white hit halo. */
async function paths(page: Page): Promise<DrawnPath[]> {
  return page.evaluate(() => [...document.querySelectorAll('[data-testid=canvas] svg path, [data-testid=canvas] svg ellipse')].map(n => {
    const d = n.tagName === 'ellipse' ? `M ${+n.getAttribute('cx')! - +n.getAttribute('rx')!} ${+n.getAttribute('cy')! - +n.getAttribute('ry')!} L ${+n.getAttribute('cx')! + +n.getAttribute('rx')!} ${+n.getAttribute('cy')! + +n.getAttribute('ry')!} ellipse` : n.getAttribute('d') ?? '';
    const nums = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0), ys = nums.filter((_, i) => i % 2 === 1);
    return {
      d, fill: n.getAttribute('fill'), stroke: n.getAttribute('stroke'), width: n.hasAttribute('stroke-width') ? Number(n.getAttribute('stroke-width')) : null,
      dash: n.getAttribute('stroke-dasharray'), box: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) },
    };
  }).filter(p => p.stroke !== '#00ff00' && p.stroke !== 'white'));
}

/** The connector's own line and its arrowheads, found by colour: the line is the longest path, a head is a short one. */
async function drawnConnector(page: Page, colour: string) {
  const mine = (await paths(page)).filter(p => p.stroke?.toLowerCase() === colour.toLowerCase());
  const line = mine.reduce((a, b) => (b.box.x1 - b.box.x0 > a.box.x1 - a.box.x0 ? b : a));
  const heads = mine.filter(p => p !== line);
  const atStart = heads.filter(h => Math.abs((h.box.x0 + h.box.x1) / 2 - line.box.x0) < 16);
  const atEnd = heads.filter(h => Math.abs((h.box.x0 + h.box.x1) / 2 - line.box.x1) < 16);
  return { line, heads, atStart, atEnd };
}

async function setup(page: Page) {
  const errors = await openEditor(page);
  const a = await placeShape(page, 'shape-rectangle', { x: 150, y: 150 }, 'a');
  const b = await placeShape(page, 'shape-rectangle', { x: 450, y: 150 }, 'b');
  await placeShape(page, 'shape-ellipse', { x: 300, y: 380 }, 'c'); // never edited: the control for "unrelated objects"
  await page.getByTestId('tool-connector').click();
  const ca = await centre(page, a.id), cb = await centre(page, b.id);
  await page.mouse.move(ca.x, ca.y); await page.mouse.down(); await page.mouse.move(cb.x, cb.y, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await elements(page)).filter(e => e.kind === 'connector').length).toBe(1);
  const link = (await elements(page)).find(e => e.kind === 'connector') as ConnectorElement;
  await page.evaluate(([id]) => (window as any).__editor.agentApply([{ op: 'set', target: id, patch: { alias: 'link' } }]), [link.id] as const);
  await expect.poll(async () => (await elements(page)).find(e => e.id === link.id)?.alias).toBe('link');
  return { errors, a, b, linkId: link.id, mid: { x: (ca.x + cb.x) / 2, y: ca.y } };
}

const connectorOf = async (page: Page, id: string) => (await elements(page)).find(e => e.id === id) as ConnectorElement;

test('connector line controls: colour, width and dash change the model and the drawing, one undoable step each', async ({ page }) => {
  const { errors, linkId, mid } = await setup(page);
  await page.mouse.click(mid.x, mid.y);
  await expect(page.getByTestId('field-line-colour')).toBeVisible();
  const k = await scale(page);

  await test.step('colour', async () => {
    expect((await drawnConnector(page, '#334155')).line.d).toBeTruthy(); // the default colour is what is drawn before the change
    await change(page, linkId,
      () => page.getByTestId('field-line-colour').fill('#c2410c'),
      async () => { await expect.poll(async () => (await connectorOf(page, linkId)).style.colour).toBe('#c2410c'); });
    const drawn = await drawnConnector(page, '#c2410c');
    expect(drawn.line.fill).toBe('none');
    expect(drawn.atEnd.length, 'the arrowhead takes the new colour too').toBeGreaterThan(0);
    expect((await paths(page)).filter(p => p.stroke === '#334155'), 'the old colour is gone from the canvas').toEqual([]);
  });

  await test.step('width', async () => {
    await change(page, linkId,
      async () => { await page.getByTestId('field-line-width').fill('4'); await page.getByTestId('field-line-width').press('Enter'); },
      async () => { await expect.poll(async () => (await connectorOf(page, linkId)).style.widthPt).toBe(4); });
    const drawn = await drawnConnector(page, '#c2410c');
    expect(drawn.line.width).not.toBeNull();
    expect(drawn.line.width! / k).toBeCloseTo(4, 0);
  });

  await test.step('dash: each pattern is stored and drawn differently, solid draws none', async () => {
    const seen = new Map<string, string | null>();
    for (const dash of ['dashed', 'dotted', 'dash-dot'] as const) {
      await change(page, linkId,
        () => page.getByTestId('field-line-dash').selectOption(dash),
        async () => { await expect.poll(async () => (await connectorOf(page, linkId)).style.dash).toBe(dash); });
      seen.set(dash, (await drawnConnector(page, '#c2410c')).line.dash);
      expect(seen.get(dash), `${dash} is drawn with a dash pattern`).toBeTruthy();
    }
    expect(new Set(seen.values()).size, 'the three patterns look different').toBe(3);
    // from a dashed line back to solid
    await page.getByTestId('field-line-dash').selectOption('dashed');
    await expect.poll(async () => (await connectorOf(page, linkId)).style.dash).toBe('dashed');
    await change(page, linkId,
      () => page.getByTestId('field-line-dash').selectOption('solid'),
      async () => { await expect.poll(async () => (await connectorOf(page, linkId)).style.dash).toBe('solid'); });
    expect((await drawnConnector(page, '#c2410c')).line.dash).toBeNull();
  });
  expect(errors).toEqual([]);
});

test('connector arrowheads: kind and size at each end change the model and the drawing', async ({ page }) => {
  const { errors, linkId, mid } = await setup(page);
  await page.mouse.click(mid.x, mid.y);
  await expect(page.getByTestId('field-end-arrow')).toBeVisible();
  const colour = '#334155';

  await test.step('the default is one block head at the end only', async () => {
    const d = await drawnConnector(page, colour);
    expect(d.atEnd.length).toBe(1);
    expect(d.atStart.length).toBe(0);
  });

  const endShapes = new Map<string, string>();
  await test.step('end arrow: each kind is stored and drawn, none draws nothing', async () => {
    for (const kind of ['open', 'diamond', 'oval', 'block'] as const) {
      await change(page, linkId,
        () => page.getByTestId('field-end-arrow').selectOption(kind),
        async () => { await expect.poll(async () => (await connectorOf(page, linkId)).style.endArrow).toBe(kind); });
      const d = await drawnConnector(page, colour);
      expect(d.atEnd.length, `${kind} head at the end`).toBeGreaterThan(0);
      expect(d.atStart.length).toBe(0);
      endShapes.set(kind, d.atEnd.map(h => h.d.replace(/-?\d+(\.\d+)?/g, '#')).join('|')); // the outline, ignoring where it sits
    }
    expect(new Set(endShapes.values()).size, 'four kinds, four outlines').toBe(4);
    await change(page, linkId,
      () => page.getByTestId('field-end-arrow').selectOption('none'),
      async () => { await expect.poll(async () => (await connectorOf(page, linkId)).style.endArrow).toBe('none'); });
    const d = await drawnConnector(page, colour);
    expect(d.atEnd.length).toBe(0);
    await page.getByTestId('field-end-arrow').selectOption('block');
    await expect.poll(async () => (await connectorOf(page, linkId)).style.endArrow).toBe('block');
  });

  await test.step('start arrow: a head appears at the start and the end head is unaffected', async () => {
    const endBefore = (await drawnConnector(page, colour)).atEnd.map(h => h.d).join('|');
    await change(page, linkId,
      () => page.getByTestId('field-start-arrow').selectOption('diamond'),
      async () => { await expect.poll(async () => (await connectorOf(page, linkId)).style.startArrow).toBe('diamond'); });
    const d = await drawnConnector(page, colour);
    expect(d.atStart.length).toBeGreaterThan(0);
    expect(d.atEnd.map(h => h.d).join('|')).toBe(endBefore);
  });

  await test.step('size: a large head is drawn larger than a small one, each end separately', async () => {
    const extent = async (end: 'atStart' | 'atEnd') => { const h = (await drawnConnector(page, colour))[end][0]!; return Math.max(h.box.x1 - h.box.x0, h.box.y1 - h.box.y0); };
    for (const [testId, key, end] of [['field-end-arrow-size', 'endArrowSize', 'atEnd'], ['field-start-arrow-size', 'startArrowSize', 'atStart']] as const) {
      await page.getByTestId(testId).selectOption('small');
      await expect.poll(async () => (await connectorOf(page, linkId)).style[key]).toBe('small');
      const small = await extent(end);
      await change(page, linkId,
        () => page.getByTestId(testId).selectOption('large'),
        async () => { await expect.poll(async () => (await connectorOf(page, linkId)).style[key]).toBe('large'); });
      expect(await extent(end), `${key}: large is bigger than small`).toBeGreaterThan(small * 1.3);
    }
  });
  expect(errors).toEqual([]);
});

test('shape line and font controls: colour, width, dash, family and size change the model and the drawing', async ({ page }) => {
  const { errors, a } = await setup(page);
  const k = await scale(page);
  await page.mouse.click((await centre(page, a.id)).x, (await centre(page, a.id)).y - 25); // the shape body, off the connector
  await expect(page.getByTestId('field-stroke-colour')).toBeVisible();
  const shape = async () => (await elements(page)).find(e => e.id === a.id) as ShapeElement;
  await page.getByTestId('field-text').fill('Alpha');
  await page.getByTestId('field-text').blur();
  await expect.poll(async () => (await shape()).text?.value).toBe('Alpha');
  const outline = () => page.evaluate(() => {
    const r = [...document.querySelectorAll('[data-testid=canvas] svg rect')].find(n => n.getAttribute('stroke') !== '#00ff00' && n.getAttribute('stroke') !== 'black' && n.getAttribute('fill') === '#ffffff' || (n.getAttribute('fill') !== 'none' && n.getAttribute('stroke') !== '#00ff00' && n.getAttribute('stroke') !== 'black' && n.getAttribute('stroke') !== 'none'));
    return r ? { stroke: r.getAttribute('stroke'), width: r.hasAttribute('stroke-width') ? Number(r.getAttribute('stroke-width')) : null, dash: r.getAttribute('stroke-dasharray') } : null;
  });
  const label = () => page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-testid=canvas] svg text')].find(n => n.textContent === 'Alpha');
    const g = t?.closest('g[font-family]');
    return g ? { family: g.getAttribute('font-family'), size: parseFloat(g.getAttribute('font-size') ?? '') } : null;
  });

  await test.step('line colour', async () => {
    await change(page, a.id,
      () => page.getByTestId('field-stroke-colour').fill('#0f766e'),
      async () => { await expect.poll(async () => (await shape()).style.stroke).toEqual({ kind: 'solid', colour: '#0f766e', opacity: 1 }); });
    expect((await outline())?.stroke).toBe('#0f766e');
  });

  await test.step('line width', async () => {
    await change(page, a.id,
      async () => { await page.getByTestId('field-strokewidth').fill('5'); await page.getByTestId('field-strokewidth').press('Enter'); },
      async () => { await expect.poll(async () => (await shape()).style.strokeWidthPt).toBe(5); });
    expect((await outline())!.width! / k).toBeCloseTo(5, 0);
  });

  await test.step('line dash', async () => {
    const seen = new Set<string | null>();
    for (const dash of ['dashed', 'dotted'] as const) {
      await change(page, a.id,
        () => page.getByTestId('field-dash').selectOption(dash),
        async () => { await expect.poll(async () => (await shape()).style.dash).toBe(dash); });
      const drawn = (await outline())!.dash;
      expect(drawn).toBeTruthy();
      seen.add(drawn);
    }
    expect(seen.size).toBe(2);
  });

  await test.step('font family', async () => {
    for (const family of ['Consolas', 'Times New Roman'] as const) {
      await change(page, a.id,
        () => page.getByTestId('field-font').selectOption(family),
        async () => { await expect.poll(async () => (await shape()).text?.fontFamily).toBe(family); });
      expect((await label())?.family).toBe(family);
    }
  });

  await test.step('font size', async () => {
    for (const pt of [9, 30]) {
      await change(page, a.id,
        async () => { await page.getByTestId('field-fontsize').fill(String(pt)); await page.getByTestId('field-fontsize').press('Enter'); },
        async () => { await expect.poll(async () => (await shape()).text?.fontSizePt).toBe(pt); });
      expect((await label())!.size / k).toBeCloseTo(pt, 0);
    }
  });

  await test.step('the label text and the other text options survive every one of those changes', async () => {
    const s = await shape();
    expect(s.text?.value).toBe('Alpha');
    expect(s.style.fill).toEqual({ kind: 'solid', colour: '#ffffff', opacity: 1 });
  });
  expect(errors).toEqual([]);
});

test('with several shapes selected, the shared line colour changes all of them and only them', async ({ page }) => {
  const { errors, a, b } = await setup(page);
  const ca = await centre(page, a.id), cb = await centre(page, b.id);
  await page.mouse.click(ca.x, ca.y - 25);
  await page.keyboard.down('Control');
  await page.mouse.click(cb.x, cb.y - 25);
  await page.keyboard.up('Control');
  await expect(page.getByTestId('multi-stroke-colour')).toBeVisible();
  const c0 = (await elements(page)).find(e => e.alias === 'c')!;
  const before = await canonical(page);
  const r0 = await revision(page);
  await page.getByTestId('multi-stroke-colour').fill('#7c3aed');
  await expect.poll(async () => ((await elements(page)).find(e => e.id === a.id) as ShapeElement).style.stroke).toEqual({ kind: 'solid', colour: '#7c3aed', opacity: 1 });
  const after = await canonical(page);
  expect(await revision(page)).toBe(r0 + 1);
  expect(differing(before, after).sort()).toEqual([a.id, b.id].sort());
  expect(after[c0.id]).toBe(before[c0.id]);
  const drawn = (await paths(page)).length + await page.evaluate(() => [...document.querySelectorAll('[data-testid=canvas] svg rect')].filter(n => n.getAttribute('stroke') === '#7c3aed').length);
  expect(drawn).toBeGreaterThanOrEqual(2);
  await page.getByTestId('tool-undo').click();
  await expect.poll(() => canonical(page)).toEqual(before);
  expect(errors).toEqual([]);
});

/** A02-07: two shapes of different fill and line must not show the first one's values as if both had them. */
test('with shapes of different fill and line selected, the inspector marks what differs, and an edit sets only what it names', async ({ page }) => {
  const { errors, a, b } = await setup(page);
  const c0 = (await elements(page)).find(e => e.alias === 'c')!;
  await page.evaluate(([ia, ib]) => (window as any).__editor.agentApply([
    { op: 'set', target: ia, patch: { style: { fill: { kind: 'solid', colour: '#fde68a', opacity: 0.5 }, stroke: { kind: 'solid', colour: '#1d4ed8', opacity: 1 } } } },
    { op: 'set', target: ib, patch: { style: { fill: { kind: 'solid', colour: '#bbf7d0', opacity: 1 }, stroke: { kind: 'none' } } } },
  ]), [a.id, b.id] as const);
  const shape = async (id: string) => (await elements(page)).find(e => e.id === id) as ShapeElement;
  await expect.poll(async () => (await shape(b.id)).style.stroke.kind).toBe('none');
  const ca = await centre(page, a.id), cb = await centre(page, b.id);
  await page.mouse.click(ca.x, ca.y - 25);
  await page.keyboard.down('Control');
  await page.mouse.click(cb.x, cb.y - 25);
  await page.keyboard.up('Control');
  await expect(page.getByRole('heading', { name: '2 objects' })).toBeVisible();
  const indeterminate = (testId: string) => page.getByTestId(testId).evaluate(n => (n as HTMLInputElement).indeterminate);

  await test.step('each differing value is marked, none is shown as shared', async () => {
    await expect(page.getByTestId('multi-fill-mixed')).toBeVisible();
    await expect(page.getByTestId('multi-fill-colour')).toHaveAttribute('aria-label', 'Fill colour, mixed');
    await expect(page.getByTestId('multi-fill-colour')).toHaveClass(/mixed/);
    await expect(page.getByTestId('multi-fill-opacity')).toHaveValue('');
    await expect(page.getByTestId('multi-fill-opacity')).toHaveAttribute('placeholder', '—');
    expect(await indeterminate('multi-fill-none'), 'both fills are solid').toBe(false);
    await expect(page.getByTestId('multi-stroke-mixed')).toBeVisible();
    expect(await indeterminate('multi-stroke-none'), 'one line is none, the other is not').toBe(true);
    await expect(page.getByTestId('multi-stroke-none')).not.toBeChecked();
    await expect(page.getByTestId('multi-stroke-colour'), 'only one line is solid, so its colour is not mixed').toHaveAttribute('aria-label', 'Line colour');
    await expect(page.getByTestId('multi-stroke-mixed')).toContainText('leave the ones with none alone');
  });

  const before = await canonical(page);
  const r0 = await revision(page);
  await test.step('focusing and leaving the controls changes nothing', async () => {
    for (const id of ['multi-fill-none', 'multi-fill-colour', 'multi-fill-opacity', 'multi-stroke-none', 'multi-stroke-colour', 'multi-stroke-opacity']) {
      const control = page.getByTestId(id);
      if (await control.isEnabled()) { await control.focus(); await control.blur(); }
    }
    expect(await revision(page)).toBe(r0);
    expect(await canonical(page)).toEqual(before);
  });

  await test.step('a shared fill colour changes both fills, keeps each opacity and line, and is one undoable step', async () => {
    await page.getByTestId('multi-fill-colour').fill('#7c3aed');
    await expect.poll(async () => (await shape(a.id)).style.fill).toEqual({ kind: 'solid', colour: '#7c3aed', opacity: 0.5 });
    const after = await canonical(page);
    expect(await revision(page)).toBe(r0 + 1);
    expect(differing(before, after).sort()).toEqual([a.id, b.id].sort());
    expect((await shape(b.id)).style.fill).toEqual({ kind: 'solid', colour: '#7c3aed', opacity: 1 });
    expect((await shape(a.id)).style.stroke).toEqual({ kind: 'solid', colour: '#1d4ed8', opacity: 1 });
    expect((await shape(b.id)).style.stroke).toEqual({ kind: 'none' });
    expect(after[c0.id]).toBe(before[c0.id]);
    await expect(page.getByTestId('multi-fill-colour'), 'the colour is now shared').toHaveValue('#7c3aed');
    await expect(page.getByTestId('multi-fill-colour')).not.toHaveClass(/mixed/);
    await expect(page.getByTestId('multi-fill-opacity'), 'the opacity still differs').toHaveValue('');
    await page.getByTestId('tool-undo').click();
    await expect.poll(() => canonical(page)).toEqual(before);
    await expect(page.getByTestId('multi-fill-colour')).toHaveClass(/mixed/);
    await page.getByTestId('tool-redo').click();
    await expect.poll(() => canonical(page)).toEqual(after);
  });

  await test.step('a shared opacity makes the fill fully shared and the mark goes', async () => {
    await page.getByTestId('multi-fill-opacity').fill('80');
    await expect.poll(async () => (await shape(b.id)).style.fill).toEqual({ kind: 'solid', colour: '#7c3aed', opacity: 0.8 });
    expect((await shape(a.id)).style.fill).toEqual({ kind: 'solid', colour: '#7c3aed', opacity: 0.8 });
    await expect(page.getByTestId('multi-fill-mixed')).toHaveCount(0);
    await expect(page.getByTestId('multi-fill-opacity')).toHaveValue('80');
  });

  await test.step('choosing none for the line sets both and clears the mixed mark', async () => {
    await page.getByTestId('multi-stroke-none').check();
    await expect.poll(async () => (await shape(a.id)).style.stroke).toEqual({ kind: 'none' });
    await expect(page.getByTestId('multi-stroke-mixed')).toHaveCount(0);
    expect(await indeterminate('multi-stroke-none')).toBe(false);
    expect((await shape(c0.id)).style).toEqual((JSON.parse(before[c0.id]!) as ShapeElement).style);
  });
  expect(errors).toEqual([]);
});

/** Colour and opacity reach solid paints only: typing works with a none or gradient shape in the selection, and a gradient is never flattened. */
test('with a solid fill selected beside none and gradient fills, opacity can be typed and the others are kept exactly', async ({ page }) => {
  const { errors, a, b } = await setup(page);
  const c = (await elements(page)).find(e => e.alias === 'c')!;
  const shape = async (id: string) => (await elements(page)).find(e => e.id === id) as ShapeElement;
  const fills = (fa: unknown, fb: unknown, fc: unknown) => page.evaluate(([ia, ib, ic, x, y, z]) => (window as any).__editor.agentApply([
    { op: 'set', target: ia, patch: { style: { fill: x } } }, { op: 'set', target: ib, patch: { style: { fill: y } } }, { op: 'set', target: ic, patch: { style: { fill: z } } },
  ]), [a.id, b.id, c.id, fa, fb, fc] as const);
  const select = async (...ids: string[]) => {
    await page.getByTestId('canvas').click({ position: { x: 5, y: 5 } });
    for (const [i, id] of ids.entries()) {
      const p = await centre(page, id);
      if (i) await page.keyboard.down('Control');
      await page.mouse.click(p.x, p.y - (id === c.id ? 0 : 25));
      if (i) await page.keyboard.up('Control');
    }
    await expect(page.getByRole('heading', { name: `${ids.length} objects` })).toBeVisible();
  };
  const gradient = { kind: 'linear-gradient', angleDeg: 30, stops: [{ offset: 0, colour: '#2563eb', opacity: 1 }, { offset: 0.4, colour: '#f59e0b', opacity: 0.7 }, { offset: 1, colour: '#ffffff', opacity: 1 }] };

  await test.step('solid beside none: typing 50 gives 0.5 and the box shows 50; the none fill stays none', async () => {
    await fills({ kind: 'solid', colour: '#fde68a', opacity: 0.2 }, { kind: 'none' }, { kind: 'solid', colour: '#ffffff', opacity: 1 });
    await select(a.id, b.id);
    await expect(page.getByTestId('multi-fill-opacity')).toHaveValue('20');
    await page.getByTestId('multi-fill-opacity').fill('');
    await page.getByTestId('multi-fill-opacity').pressSequentially('50');
    await expect.poll(async () => (await shape(a.id)).style.fill).toEqual({ kind: 'solid', colour: '#fde68a', opacity: 0.5 });
    await expect(page.getByTestId('multi-fill-opacity')).toHaveValue('50');
    expect((await shape(b.id)).style.fill).toEqual({ kind: 'none' });
  });

  await test.step('solid beside a gradient: colour and opacity change the solid one, the gradient keeps every stop, and the note says so', async () => {
    await fills({ kind: 'solid', colour: '#fde68a', opacity: 0.2 }, gradient, { kind: 'solid', colour: '#ffffff', opacity: 1 });
    await select(a.id, b.id);
    await expect(page.getByTestId('multi-fill-mixed')).toContainText('Gradients are kept as they are');
    await expect(page.getByTestId('multi-fill-gradient'), 'no gradient editor for differing paints').toHaveCount(0);
    await page.getByTestId('multi-fill-colour').fill('#7c3aed');
    await expect.poll(async () => (await shape(a.id)).style.fill).toEqual({ kind: 'solid', colour: '#7c3aed', opacity: 0.2 });
    await page.getByTestId('multi-fill-opacity').fill('60');
    await expect.poll(async () => (await shape(a.id)).style.fill).toEqual({ kind: 'solid', colour: '#7c3aed', opacity: 0.6 });
    await expect(page.getByTestId('multi-fill-opacity')).toHaveValue('60');
    expect((await shape(b.id)).style.fill).toEqual(gradient);
  });

  await test.step('two different gradients: colour and opacity are unavailable and nothing is changed', async () => {
    await fills(gradient, { ...gradient, angleDeg: 90 }, { kind: 'solid', colour: '#ffffff', opacity: 1 });
    await select(a.id, b.id);
    await expect(page.getByTestId('multi-fill-colour')).toBeDisabled();
    await expect(page.getByTestId('multi-fill-opacity')).toBeDisabled();
    await expect(page.getByTestId('multi-fill-mixed')).toContainText('select them on their own');
  });

  await test.step('identical gradients keep the shared gradient editor, and an angle edit sets both', async () => {
    await fills(gradient, gradient, { kind: 'solid', colour: '#ffffff', opacity: 1 });
    await select(a.id, b.id);
    await expect(page.getByTestId('multi-fill-gradient')).toBeVisible();
    await page.getByTestId('multi-fill-angle').fill('45');
    await expect.poll(async () => ((await shape(a.id)).style.fill as { angleDeg: number }).angleDeg).toBe(45);
    expect((await shape(b.id)).style.fill).toEqual({ ...gradient, angleDeg: 45 });
    expect((await shape(c.id)).style.fill).toEqual({ kind: 'solid', colour: '#ffffff', opacity: 1 });
  });
  expect(errors).toEqual([]);
});
