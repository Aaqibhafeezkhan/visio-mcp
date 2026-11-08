import { describe, expect, it } from 'vitest';
import type { ConnectorElement, ShapeElement } from '../src/contracts/generated';
import { createTestEngine, element, exactElementHashes, hashesExcept } from './support/engine';

describe('incremental commit and rollback', () => {
  it('failed_forbidden_policy_edit_is_atomic', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const before = store.snapshot();
    const wall = '00000000-0000-4000-8000-000000000f10', a = '00000000-0000-4000-8000-000000000f11', b = '00000000-0000-4000-8000-000000000f12', link = '00000000-0000-4000-8000-000000000f13';
    const result = await engine.execute(request([
      { op: 'createShape', id: a, bounds: { x: 20, y: 300, width: 40, height: 30 } },
      { op: 'createShape', id: b, bounds: { x: 700, y: 300, width: 40, height: 30 } },
      { op: 'createConnector', id: link, from: { elementId: a, glue: 'static', port: 'east' }, to: { elementId: b, glue: 'static', port: 'west' }, route: 'orthogonal' },
      { op: 'createShape', id: wall, bounds: { x: 0, y: 0, width: 841, height: 595 } },
      { op: 'set', target: wall, patch: { routingPolicy: { obstacle: 'forbidden' } } },
    ]), 'mcp');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.reason).toBe('routing_policy_unresolved');
    expect(store.snapshot().revision).toBe(before.revision);
    expect(exactElementHashes(store.snapshot())).toEqual(exactElementHashes(before));
    expect(store.snapshot().document).toBe(before.document);
    void ids;
  });

  it('set_routing_policy_updates_shape_and_connector', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const made = await engine.execute(request([{ op: 'createConnector', id: '00000000-0000-4000-8000-000000000f14', from: { elementId: ids.shapes[0]!, glue: 'dynamic' }, to: { elementId: ids.shapes[1]!, glue: 'dynamic' }, route: 'orthogonal' }]), 'mcp');
    expect(made.ok).toBe(true);
    const before = store.snapshot(), connectorId = '00000000-0000-4000-8000-000000000f14';
    const changed = await engine.execute(request([
      { op: 'set', target: ids.shape, patch: { routingPolicy: { obstacle: 'passThrough', clearancePt: 12 } } },
      { op: 'set', target: connectorId, patch: { routingPolicy: { text: 'avoid' }, from: { elementId: ids.shapes[0]!, glue: 'dynamic', preferredSide: 'north' } } },
    ]), 'mcp');
    expect(changed.ok).toBe(true);
    expect(store.snapshot().revision).toBe(before.revision + 1);
    expect((element(store.snapshot(), ids.shape) as ShapeElement).routingPolicy).toEqual({ obstacle: 'passThrough', clearancePt: 12 });
    expect(element(store.snapshot(), connectorId)).toMatchObject({ routingPolicy: { text: 'avoid' }, from: { preferredSide: 'north' } });
    const undone = await engine.undo({ ...engine.scope(), transactionId: '00000000-0000-4000-8000-000000000f15', baseRevision: engine.revision });
    expect(undone.ok).toBe(true);
    expect(store.snapshot().document.pages[0]!.elements.find(e => e.id === connectorId)).not.toHaveProperty('routingPolicy');
  });

  it('routing_defaults_are_one_atomic_document_diff_and_do_not_reroute_ordinary_edits', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const connectorId = '00000000-0000-4000-8000-000000000f24';
    const created = await engine.execute(request([{ op: 'createConnector', id: connectorId, from: { elementId: ids.shapes[0]!, glue: 'dynamic' }, to: { elementId: ids.shapes[1]!, glue: 'dynamic' }, route: 'orthogonal' }]), 'mcp');
    expect(created.ok).toBe(true);
    const configured = await engine.execute(request([{ op: 'setRoutingDefaults', crossing: 'allow' }]), 'mcp');
    expect(configured.ok).toBe(true);
    expect(store.snapshot().document.routingDefaults).toEqual({ crossing: 'allow' });
    if (configured.ok) expect(configured.value.changed).toEqual([]);
    const beforeEdit = store.snapshot();
    const edited = await engine.execute(request([{ op: 'set', target: ids.shape, patch: { name: 'renamed' } }]), 'mcp');
    expect(edited.ok).toBe(true);
    expect(store.snapshot().document.pages[0]!.elements.find(e => e.id === connectorId)).toEqual(beforeEdit.document.pages[0]!.elements.find(e => e.id === connectorId));
    const undone = await engine.undo({ ...engine.scope(), transactionId: '00000000-0000-4000-8000-000000000f25', baseRevision: engine.revision });
    expect(undone.ok).toBe(true);
    expect(store.snapshot().document.routingDefaults).toEqual({ crossing: 'allow' });
    const defaultsUndone = await engine.undo({ ...engine.scope(), transactionId: '00000000-0000-4000-8000-000000000f27', baseRevision: engine.revision });
    expect(defaultsUndone.ok).toBe(true);
    expect(store.snapshot().document).not.toHaveProperty('routingDefaults');
    const defaultsRedone = await engine.redo({ ...engine.scope(), transactionId: '00000000-0000-4000-8000-000000000f28', baseRevision: engine.revision });
    expect(defaultsRedone.ok).toBe(true);
    expect(store.snapshot().document.routingDefaults).toEqual({ crossing: 'allow' });
  });

  it('rejects_connector_crossing_policy_on_non_connector_and_static_required_side_conflicts', async () => {
    const { engine, request, ids } = createTestEngine();
    const invalidPolicy = await engine.execute(request([{ op: 'set', target: ids.shape, patch: { routingPolicy: { crossing: 'allow' } } }]), 'mcp');
    expect(invalidPolicy.ok).toBe(false);
    if (!invalidPolicy.ok) expect(invalidPolicy.error.code).toBe('invalid_request');
    const conflict = await engine.execute(request([{ op: 'createConnector', id: '00000000-0000-4000-8000-000000000f26', from: { elementId: ids.shapes[0]!, glue: 'static', port: 'east', requiredSide: 'north' }, to: { elementId: ids.shapes[1]!, glue: 'dynamic' }, route: 'orthogonal' }]), 'mcp');
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.details).toMatchObject({ reason: 'routing_side_conflict', connectorId: '00000000-0000-4000-8000-000000000f26', endpoint: 'from' });
  });

  it('reports a general routing failure when hard obstacles block every required-side alternative', async () => {
    const { engine, request, ids } = createTestEngine();
    const blocked = await engine.execute(request([
      { op: 'createShape', id: '00000000-0000-4000-8000-000000000f29', bounds: { x: 0, y: 0, width: 841, height: 595 } },
      { op: 'set', target: '00000000-0000-4000-8000-000000000f29', patch: { routingPolicy: { obstacle: 'forbidden' } } },
      { op: 'createConnector', id: '00000000-0000-4000-8000-000000000f30', from: { elementId: ids.shapes[0]!, glue: 'dynamic', requiredSide: 'north' }, to: { elementId: ids.shapes[1]!, glue: 'dynamic' }, route: 'orthogonal' },
    ]), 'mcp');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.details?.reason).toBe('routing_policy_unresolved');
  });

  it('one_logo_patch_changes_one_object_and_leaves_19_byte_identical', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const before = store.snapshot();
    const r = await engine.execute(request([{ op: 'set', target: ids.image, patch: { assetId: 'asset:logo-v2' } }]), 'mcp');
    expect(r.ok && r.value.changed).toEqual([ids.image]);
    expect(store.snapshot().revision).toBe(before.revision + 1);
    expect(hashesExcept(store.snapshot(), ids.image)).toEqual(hashesExcept(before, ids.image));
    expect(Object.keys(exactElementHashes(store.snapshot()))).toHaveLength(20);
    // Unchanged elements are the very same immutable objects, not copies.
    expect(element(store.snapshot(), ids.shape)).toBe(element(before, ids.shape));
  });

  it('late_invalid_operation_rolls_back_all', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const before = store.snapshot();
    const r = await engine.execute(request([
      { op: 'move', target: ids.shape, delta: { xPt: 10, yPt: 0 } },
      { op: 'set', target: ids.image, patch: { assetId: 'asset:logo-v2' } },
      { op: 'set', target: ids.image, patch: { assetId: 'asset:does-not-exist' } },
    ]), 'mcp');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_request');
    expect(store.snapshot().revision).toBe(before.revision);
    expect(exactElementHashes(store.snapshot())).toEqual(exactElementHashes(before));
    expect(store.snapshot().document).toBe(before.document);
  });

  it('nested_stroke_patch_preserves_other_leaves', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const before = element(store.snapshot(), ids.shape) as ShapeElement;
    const r = await engine.execute(request([
      { op: 'set', target: ids.shape, patch: { style: { stroke: { kind: 'solid', colour: '#333333', opacity: 1 } } } },
    ]), 'mcp');
    expect(r.ok).toBe(true);
    const after = element(store.snapshot(), ids.shape) as ShapeElement;
    expect(after.style.stroke).toEqual({ kind: 'solid', colour: '#333333', opacity: 1 });
    expect({ ...after.style, stroke: before.style.stroke }).toEqual(before.style); // every other style leaf untouched
    expect(after.text).toEqual(before.text);
    expect(after.bounds).toEqual(before.bounds);
    expect(after.metadata).toBe(before.metadata);
  });

  it('create_then_reference', async () => {
    const { engine, store, request } = createTestEngine();
    const r = await engine.execute(request([
      { op: 'createShape', alias: 'a', bounds: { x: 10, y: 10, width: 50, height: 30 }, text: { value: 'A' } },
      { op: 'createShape', alias: 'b', bounds: { x: 200, y: 10, width: 50, height: 30 } },
      { op: 'createConnector', from: { elementId: 'a', glue: 'dynamic' }, to: { elementId: 'b', port: 'west', glue: 'static' }, route: 'orthogonal' },
      { op: 'move', target: 'a', delta: { xPt: 5, yPt: 5 } },
    ]), 'mcp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.created).toHaveLength(3);
    const els = store.snapshot().document.pages[0]!.elements;
    const a = els.find(e => e.alias === 'a')!;
    const b = els.find(e => e.alias === 'b')!;
    const c = els.find(e => e.kind === 'connector') as ConnectorElement;
    expect(c.from.elementId).toBe(a.id); // alias was resolved to a UUID before commit
    expect(c.to.elementId).toBe(b.id);
    expect(a.bounds.x).toBe(15);
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(els.map(e => e.zIndex)).size).toBe(els.length); // distinct stacking order
  });

  it('no_op_has_no_history', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const before = store.snapshot();
    const r = await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 0, yPt: 0 } }]), 'mcp');
    expect(r.ok && r.value.noChange).toBe(true);
    expect(r.ok && r.value.revision).toBe(before.revision);
    expect(store.snapshot().document).toBe(before.document);
    const changes = await engine.getChanges(engine.scope(), 0);
    expect(changes.ok && changes.value.transactions).toEqual([]);
    const undo = await engine.undo({ ...engine.scope(), transactionId: '00000000-0000-4000-8000-000000000f01', baseRevision: engine.revision });
    expect(undo.ok).toBe(false);
  });

  it('ambiguous_name_returns_candidates_and_changes_nothing', async () => {
    const { engine, store, request, ids } = createTestEngine();
    await engine.execute(request([{ op: 'set', target: ids.shapes[1]!, patch: { name: 'Shape 0' } }]), 'mcp');
    const before = store.snapshot();
    const r = await engine.execute(request([{ op: 'set', target: 'Shape 0', patch: { hidden: true } }]), 'mcp');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ambiguous_target');
      expect((r.error.details?.candidates as string[]).sort()).toEqual([ids.shapes[0]!, ids.shapes[1]!].sort());
    }
    expect(store.snapshot().revision).toBe(before.revision);
  });

  it('resolves uuid first, then alias, then exact name', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const r = await engine.execute(request([
      { op: 'move', target: ids.shape, delta: { xPt: 1, yPt: 0 } },
      { op: 'move', target: 's1', delta: { xPt: 1, yPt: 0 } },
      { op: 'move', target: 'Shape 2', delta: { xPt: 1, yPt: 0 } },
    ]), 'gui');
    expect(r.ok && r.value.changed.sort()).toEqual([ids.shapes[0]!, ids.shapes[1]!, ids.shapes[2]!].sort());
    expect(element(store.snapshot(), ids.shapes[3]!)).toBeDefined();
  });

  it('locked_target_rejects_geometry_but_allows_unlock', async () => {
    const { engine, store, request, ids } = createTestEngine();
    expect((await engine.execute(request([{ op: 'set', target: ids.shape, patch: { locked: true } }]), 'gui')).ok).toBe(true);
    const move = await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 5, yPt: 0 } }]), 'mcp');
    expect(!move.ok && move.error.code).toBe('locked_target');
    const restyle = await engine.execute(request([{ op: 'set', target: ids.shape, patch: { name: 'x' } }]), 'mcp');
    expect(!restyle.ok && restyle.error.code).toBe('locked_target');
    expect((await engine.execute(request([{ op: 'set', target: ids.shape, patch: { locked: false } }]), 'gui')).ok).toBe(true);
    expect((await engine.execute(request([{ op: 'move', target: ids.shape, delta: { xPt: 5, yPt: 0 } }]), 'mcp')).ok).toBe(true);
    expect(element(store.snapshot(), ids.shape).bounds.x).toBe(105);
  });

  it('locked_layer_locks_its_members', async () => {
    const { engine, request, ids } = createTestEngine();
    const doc = structuredClone(engine.store.snapshot().document);
    doc.pages[0]!.layers[0]!.locked = true;
    const locked = createTestEngine({ document: doc });
    const r = await locked.engine.execute(locked.request([{ op: 'move', target: ids.shape, delta: { xPt: 5, yPt: 0 } }]), 'mcp');
    expect(!r.ok && r.error.code).toBe('locked_target');
    void request;
  });

  it('deleting_a_connected_shape_is_a_dependency_conflict_unless_connectors_go_too', async () => {
    const { engine, store, request, ids } = createTestEngine();
    await engine.execute(request([{ op: 'createConnector', alias: 'link', from: { elementId: ids.shapes[0]!, glue: 'dynamic' }, to: { elementId: ids.shapes[1]!, glue: 'dynamic' } }]), 'gui');
    const blocked = await engine.execute(request([{ op: 'delete', target: ids.shapes[0]! }]), 'mcp');
    expect(!blocked.ok && blocked.error.code).toBe('dependency_conflict');
    if (!blocked.ok) expect((blocked.error.details?.connectorIds as string[]).length).toBe(1);
    const both = await engine.execute(request([{ op: 'delete', target: ids.shapes[0]!, withConnectors: true }]), 'mcp');
    expect(both.ok && both.value.deleted).toHaveLength(2);
    expect(store.snapshot().document.pages[0]!.elements.some(e => e.kind === 'connector')).toBe(false);
  });

  it('resize_rotate_and_text_patch', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const r = await engine.execute(request([
      { op: 'resize', target: ids.shape, bounds: { width: 200 } },
      { op: 'rotate', target: ids.shape, angleDeg: 33 },
      { op: 'rotate', target: ids.shape, deltaDeg: 10 },
      { op: 'set', target: ids.shape, patch: { text: { value: 'Renamed', bold: true } } },
    ]), 'gui');
    expect(r.ok).toBe(true);
    const s = element(store.snapshot(), ids.shape) as ShapeElement;
    expect(s.bounds).toEqual({ x: 100, y: 40, width: 200, height: 60 });
    expect(s.rotationDeg).toBe(43);
    expect(s.text).toMatchObject({ value: 'Renamed', bold: true, fontFamily: 'Segoe UI' });
    const bad = await engine.execute(request([{ op: 'resize', target: ids.shape, bounds: { width: -5 } }]), 'gui');
    expect(!bad.ok && bad.error.code).toBe('invalid_request');
  });

  it('result_reports_visually_affected_connectors_without_rewriting_them', async () => {
    const { engine, store, request, ids } = createTestEngine();
    await engine.execute(request([{ op: 'createConnector', alias: 'link', from: { elementId: ids.shapes[0]!, glue: 'dynamic' }, to: { elementId: ids.shapes[1]!, glue: 'dynamic' } }]), 'gui');
    const connectorHash = exactElementHashes(store.snapshot());
    const r = await engine.execute(request([{ op: 'move', target: ids.shapes[0]!, delta: { xPt: 30, yPt: 0 } }]), 'gui');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const connector = store.snapshot().document.pages[0]!.elements.find(e => e.kind === 'connector')!;
    expect(r.value.changed).toEqual([ids.shapes[0]!]);
    expect(r.value.visuallyAffectedIds).toContain(connector.id);
    expect(exactElementHashes(store.snapshot())[connector.id]).toBe(connectorHash[connector.id]); // canonical connector untouched
  });

  it('registers_an_asset_and_references_it_in_the_same_batch', async () => {
    const { engine, store, request } = createTestEngine();
    const asset = { id: 'asset:new', name: 'New', mimeType: 'image/png' as const, sha256: 'c'.repeat(64), tags: [] };
    const r = await engine.execute(request([
      { op: 'registerAsset', asset },
      { op: 'createImage', alias: 'pic', bounds: { x: 0, y: 0, width: 30, height: 30 }, assetId: 'asset:new' },
    ]), 'mcp');
    expect(r.ok && r.value.changedAssetIds).toEqual(['asset:new']);
    expect(store.snapshot().document.assets.map(a => a.id)).toContain('asset:new');
  });

  it('setPage_changes_page_properties_with_exact_undo_and_touches_no_element', async () => {
    const { engine, store, request, ids } = createTestEngine();
    const before = store.snapshot();
    const r = await engine.execute(request([{ op: 'setPage', patch: { name: 'Renamed', grid: { visible: false, snap: false } } }]), 'gui');
    expect(r.ok && r.value.changedPageIds).toEqual([ids.page]);
    expect(r.ok && r.value.changed).toEqual([]);
    const page = store.snapshot().document.pages[0]!;
    expect(page.name).toBe('Renamed');
    expect(page.grid).toEqual({ visible: false, snap: false, spacingPt: before.document.pages[0]!.grid.spacingPt }); // unsupplied leaves are preserved
    expect(page.elements).toBe(before.document.pages[0]!.elements); // the element array is shared, not copied
    expect(page.layers).toBe(before.document.pages[0]!.layers);
    const undone = await engine.undo({ ...engine.scope(), transactionId: '00000000-0000-4000-8000-000000000f02', baseRevision: engine.revision });
    expect(undone.ok && undone.value.changedPageIds).toEqual([ids.page]);
    expect(store.snapshot().document.pages[0]!.grid).toEqual(before.document.pages[0]!.grid);
    expect(store.snapshot().document.pages[0]!.name).toBe('Page 1');
    const same = await engine.execute(request([{ op: 'setPage', patch: { name: 'Page 1' } }]), 'gui');
    expect(same.ok && same.value.noChange).toBe(true);
    const bad = await engine.execute(request([{ op: 'setPage', patch: { widthPt: -1 } }]), 'gui');
    expect(bad.ok).toBe(false);
  });
});
