import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toPoints, validateDocument, validateEnvelope, validateMutationRequest, validateOperation } from '../src/model/validate';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${name}`, import.meta.url), 'utf8'));
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('R22 routing policy contracts', () => {
  it('accepts the engine-owned beautified route marker and its result provenance', () => {
    const document = structuredClone(fixture('samples.json').DiagramDocument);
    const connector = document.pages.flatMap((page: any) => page.elements).find((element: any) => element.kind === 'connector');
    connector.routing = { ...connector.routing, beautified: true };
    expect(validateDef('DiagramDocument', document).valid).toBe(true);
    expect(validateDef('TransactionResult', {
      transactionId: U(1), previousRevision: 1, revision: 2, noChange: false,
      created: [], changed: [], deleted: [], changedPageIds: [], changedLayerIds: [], changedAssetIds: [], visuallyAffectedIds: [], warnings: [], projectionStatus: 'applied',
      routeChanges: [{ id: connector.id, provenance: 'beautified' }],
    }).valid).toBe(true);
  });

  it('routingPolicy_accepts_supported_values_and_rejects_unknown_or_out_of_range_values', () => {
    for (const obstacle of ['automatic', 'forbidden', 'avoid', 'passThrough']) {
      expect(validateDef('RoutingPolicy', { obstacle, clearancePt: 0, text: 'avoid' }).valid, obstacle).toBe(true);
    }
    expect(validateDef('RoutingPolicy', { obstacle: 'forbidden', clearancePt: 2000, text: 'ignore' }).valid).toBe(true);
    expect(validateDef('RoutingPolicy', { obstacle: 'forbidden', clearancePt: 2001 }).valid).toBe(false);
    expect(validateDef('RoutingPolicy', { obstacle: 'invalid' }).valid).toBe(false);
    expect(validateDef('RoutingPolicy', { text: 'invalid' }).valid).toBe(false);
  });

  it('route_findings_expose_stable_typed_codes_and_blockers', () => {
    expect(validateDef('RouteFinding', {
      code: 'UNRESOLVED_ROUTE', severity: 'error', message: 'blocked', elementId: U(1), blockerIds: [U(2)],
    }).valid).toBe(true);
    expect(validateDef('RouteFinding', {
      code: 'UNKNOWN', severity: 'error', message: 'blocked', elementId: U(1),
    }).valid).toBe(false);
    expect(validateOperation({ op: 'set', target: 'shape', patch: { routingPolicy: { obstacle: 'forbidden', clearancePt: 0 } } }).ok).toBe(true);
    expect(validateOperation({ op: 'set', target: 'shape', patch: { routingPolicy: { clearancePt: 2001 } } }).ok).toBe(false);
  });
  it('transaction_result_accepts_optional_structured_route_findings', () => {
    expect(validateDef('TransactionResult', {
      transactionId: U(1), previousRevision: 1, revision: 2, noChange: false,
      created: [], changed: [U(9)], deleted: [], changedPageIds: [U(3)], changedLayerIds: [], changedAssetIds: [],
      visuallyAffectedIds: [U(9)], warnings: [], projectionStatus: 'applied',
      routeFindings: [{ code: 'UNRESOLVED_ROUTE', severity: 'error', message: 'No clear route was found', elementId: U(9), blockerIds: [U(4)] }],
    }).valid).toBe(true);
  });
  it('endpoint_preferred_side_is_shape_local_enum', () => {
    for (const preferredSide of ['north', 'east', 'south', 'west']) {
      expect(validateDef('Endpoint', { glue: 'dynamic', preferredSide }).valid, preferredSide).toBe(true);
      expect(validateDef('EndpointInput', { glue: 'dynamic', preferredSide }).valid, preferredSide).toBe(true);
    }
    expect(validateDef('Endpoint', { glue: 'dynamic', preferredSide: 'up' }).valid).toBe(false);
    expect(validateDef('EndpointInput', { glue: 'dynamic', preferredSide: 'up' }).valid).toBe(false);
  });
});

describe('R24 routing contracts', () => {
  it('accepts document crossing defaults and connector-only crossing policy and priority', () => {
    const document = structuredClone(fixture('samples.json').DiagramDocument);
    document.routingDefaults = { crossing: 'allow' };
    const elements = document.pages.flatMap((page: any) => page.elements);
    const connector = elements.find((element: any) => element.kind === 'connector');
    connector.routingPolicy = { crossing: 'avoid', priority: -100 };
    expect(validateDef('DiagramDocument', document).valid).toBe(true);
    connector.routingPolicy.priority = 100;
    expect(validateDef('DiagramDocument', document).valid).toBe(true);
    connector.routingPolicy.priority = 101;
    expect(validateDef('DiagramDocument', document).valid).toBe(false);
  });

  it('rejects connector crossing policy on shapes and text while keeping shared obstacle policy', () => {
    const document = structuredClone(fixture('samples.json').DiagramDocument);
    const elements = document.pages.flatMap((page: any) => page.elements);
    const shape = elements.find((element: any) => element.kind === 'shape');
    shape.routingPolicy = { obstacle: 'forbidden', crossing: 'avoid' };
    expect(validateDef('DiagramDocument', document).valid).toBe(false);
    delete shape.routingPolicy;
    const text = elements.find((element: any) => element.kind === 'text');
    if (text) text.routingPolicy = { priority: 2 };
    expect(validateDef('DiagramDocument', document).valid).toBe(false);
  });

  it('accepts required endpoint sides and rejects an invalid side', () => {
    for (const requiredSide of ['north', 'east', 'south', 'west']) {
      expect(validateDef('Endpoint', { elementId: U(4), glue: 'dynamic', requiredSide }).valid, requiredSide).toBe(true);
      expect(validateDef('EndpointInput', { elementId: U(4), glue: 'dynamic', requiredSide }).valid, requiredSide).toBe(true);
    }
    expect(validateDef('Endpoint', { glue: 'dynamic', requiredSide: 'up' }).valid).toBe(false);
    expect(validateDef('Endpoint', { glue: 'none', point: { x: 0, y: 0 }, requiredSide: 'north' }).valid).toBe(false);
    expect(validateDef('EndpointInput', { glue: 'none', point: { x: 0, y: 0 }, requiredSide: 'north' }).valid).toBe(false);
    expect(validateDef('EndpointInput', { glue: 'none', point: { x: 0, y: 0 }, requiredSide: null }).valid).toBe(true);
    expect(validateDef('EndpointInput', { glue: 'dynamic', requiredSide: 'north' }).valid).toBe(false);
  });

  it('accepts routing-defaults and exact-route beautify transaction operations', () => {
    expect(validateOperation({ op: 'setRoutingDefaults', crossing: 'allow' }).ok).toBe(true);
    expect(validateOperation({ op: 'setRoutingDefaults', crossing: 'invalid' }).ok).toBe(false);
    expect(validateOperation({ op: 'beautify', baseRevision: 4, pageId: U(1), targets: [U(2)], includeManual: false,
      routes: [{ id: U(2), points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }] }).ok).toBe(true);
    expect(validateOperation({ op: 'set', target: U(2), patch: { routing: { mode: 'automatic', beautified: true } } }).ok).toBe(false);
  });

  it('accepts the required-side unresolved route finding', () => {
    expect(validateDef('RouteFinding', {
      code: 'ROUTE_REQUIRED_SIDE_UNRESOLVED', severity: 'error', message: 'blocked', elementId: U(1),
    }).valid).toBe(true);
  });
});
const validBatch = () => ({
  documentId: U(1), sessionId: U(2), transactionId: U(3), baseRevision: 0, atomic: true as const,
  operations: [{ op: 'move', target: 'box', delta: { xPt: 1, yPt: 2 } }],
});

describe('contract validation', () => {
  it('accepts the valid apply fixture as an envelope and as a merged request', () => {
    expect(validateEnvelope(fixture('valid-apply.json')).ok).toBe(true);
  });

  it('rejects unknown operation fields', () => {
    const r = validateEnvelope(fixture('invalid-apply.json'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid_request');
      expect(r.error.details?.keyword).toBe('additionalProperties');
    }
  });

  it('rejects unknown patch fields', () => {
    const r = validateOperation({ op: 'set', target: 'box', patch: { colour: '#ffffff' } });
    expect(r.ok).toBe(false);
  });

  it('rejects an empty patch and an empty bounds patch', () => {
    expect(validateOperation({ op: 'set', target: 'box', patch: {} }).ok).toBe(false);
    expect(validateOperation({ op: 'resize', target: 'box', bounds: {} }).ok).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite number %s', n => {
    expect(validateOperation({ op: 'move', target: 'box', delta: { xPt: n, yPt: 0 } }).ok).toBe(false);
  });

  it('rejects atomic:false', () => {
    expect(validateMutationRequest({ ...validBatch(), atomic: false }).ok).toBe(false);
  });

  it('returns invalid_request instead of throwing for every operation in the union', () => {
    // The three routing ops were missing from opValidators: a malformed one threw
    // `TypeError: v is not a function` instead of returning invalid_request (#91).
    // targets/connector with the wrong type: schema-invalid, but the branch must be
    // reached through opValidators instead of blowing up on the lookup.
    for (const op of ['reroute', 'moveSegment', 'pinSegment']) {
      const r = validateMutationRequest({ ...validBatch(), operations: [{ op, targets: 5 }] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('invalid_request');
    }

    // A schema-valid body of each kind must also come back as a result, not a throw.
    const valid: Record<string, object> = {
      reroute: { targets: [U(4)] },
      moveSegment: { target: U(5), segment: 1, to: 0 },
      pinSegment: { target: U(5), segment: 0, pinned: true },
    };
    for (const op of Object.keys(valid)) {
      const r = validateMutationRequest({ ...validBatch(), operations: [{ op, ...valid[op] }] });
      expect(r.ok).toBe(true);
    }
  });

  it('every operation in the schema union has a per-operation validator', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../contracts/operations.schema.json', import.meta.url), 'utf8'));
    const names = (schema.$defs.Operation.oneOf as Array<{ $ref: string }>).map(r => r.$ref.replace('#/$defs/', ''));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const tag = schema.$defs[name].properties.op.const;
      // `{op: tag}` alone is schema-valid for operations with no other required fields (Reroute),
      // so validation returns before the per-op validator is ever consulted. A schema-forbidden
      // extra property fails the union for every operation and forces that lookup, which is what
      // used to throw `TypeError: v is not a function` for an unregistered operation (#91).
      const r = validateMutationRequest({ ...validBatch(), operations: [{ op: tag, probe: true }] });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe('invalid_request');
        // A missing opByTag entry also returns invalid_request, but about the op tag itself (keyword 'enum',
        // "not a known operation"). A registered tag reports a problem inside the branch instead.
        expect(r.error.details).not.toMatchObject({ path: '/operations/0/op', keyword: 'enum' });
      }
    }
  });

  it('rejects duplicate ids and duplicate aliases created in one batch', () => {
    const create = (extra: object) => ({ op: 'createShape', bounds: { x: 0, y: 0, width: 10, height: 10 }, ...extra });
    const sameId = validateMutationRequest({ ...validBatch(), operations: [create({ id: U(10) }), create({ id: U(10) })] });
    expect(sameId.ok).toBe(false);
    const sameAlias = validateMutationRequest({ ...validBatch(), operations: [create({ alias: 'a' }), create({ alias: 'a' })] });
    expect(sameAlias.ok).toBe(false);
    if (!sameAlias.ok) expect(sameAlias.error.details).toEqual({ alias: 'a' });
  });

  it('rejects an operation with both angleDeg and deltaDeg, and with neither', () => {
    expect(validateOperation({ op: 'rotate', target: 'a', angleDeg: 1, deltaDeg: 2 }).ok).toBe(false);
    expect(validateOperation({ op: 'rotate', target: 'a' }).ok).toBe(false);
    expect(validateOperation({ op: 'rotate', target: 'a', deltaDeg: 2 }).ok).toBe(true);
  });

  it('rejects scope repeated inside params', () => {
    const env = fixture('valid-apply.json');
    env.params.documentId = env.documentId;
    expect(validateEnvelope(env).ok).toBe(false);
  });

  it('converts units at the boundary: mm, cm, in, pt, px', () => {
    expect(toPoints(25.4, 'mm')).toBeCloseTo(72, 10);
    expect(toPoints(2.54, 'cm')).toBeCloseTo(72, 10);
    expect(toPoints(1, 'in')).toBe(72);
    expect(toPoints(5, 'pt')).toBe(5);
    expect(toPoints(96, 'px')).toBe(72);
    expect(toPoints(297, 'mm')).toBeCloseTo(841.8897637795, 6);
    expect(() => toPoints(Infinity, 'mm')).toThrow(RangeError);
  });

  it('accepts one valid batch with a create, a move and a nested style patch', () => {
    const r = validateMutationRequest({ ...validBatch(), operations: fixture('valid-apply.json').params.operations });
    expect(r.ok).toBe(true);
  });
});

describe('document validation', () => {
  const doc = () => ({
    schemaVersion: 1, id: U(1), title: 't', revision: 0, assets: [], metadata: {},
    pages: [{
      id: U(2), name: 'Page 1', widthPt: 842, heightPt: 595, background: { kind: 'none' },
      grid: { visible: true, spacingPt: 14.17, snap: true }, guides: [], layers: [], elements: [] as unknown[],
    }],
  });
  const shape = (n: number, extra: object = {}) => ({
    id: U(n), kind: 'shape', layerIds: [], zIndex: n, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 10, height: 10 },
    rotationDeg: 0, metadata: {}, geometry: { preset: 'rectangle' },
    style: { fill: { kind: 'none' }, stroke: { kind: 'none' }, strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter' }, ...extra,
  });

  it('accepts a minimal document', () => {
    const d = doc();
    d.pages[0]!.elements.push(shape(10));
    expect(validateDocument(d).ok).toBe(true);
  });

  it('rejects duplicate element ids and duplicate aliases', () => {
    const a = doc(); a.pages[0]!.elements.push(shape(10), shape(10));
    expect(validateDocument(a).ok).toBe(false);
    const b = doc(); b.pages[0]!.elements.push(shape(10, { alias: 'x' }), shape(11, { alias: 'x' }));
    expect(validateDocument(b).ok).toBe(false);
  });

  it('rejects images with unknown assets and glued connectors with missing targets', () => {
    const img = doc();
    img.pages[0]!.elements.push({ ...shape(10), kind: 'image', assetId: 'asset:none', fit: 'contain', opacity: 1, preserveAspectRatio: true, geometry: undefined, style: undefined });
    expect(validateDocument(img).ok).toBe(false);
    const con = doc();
    con.pages[0]!.elements.push({
      id: U(10), kind: 'connector', layerIds: [], zIndex: 1, locked: false, hidden: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, rotationDeg: 0, metadata: {},
      from: { elementId: U(99), glue: 'dynamic' }, to: { point: { x: 1, y: 1 }, glue: 'none' }, route: 'straight', waypoints: [],
      style: { colour: '#000000', widthPt: 1, dash: 'solid', startArrow: 'none', endArrow: 'block' },
    });
    expect(validateDocument(con).ok).toBe(false);
  });

  it('rejects unknown fields and non-finite geometry', () => {
    const a = doc(); (a as Record<string, unknown>).extra = 1;
    expect(validateDocument(a).ok).toBe(false);
    const b = doc(); b.pages[0]!.elements.push(shape(10, { bounds: { x: NaN, y: 0, width: 10, height: 10 } }));
    expect(validateDocument(b).ok).toBe(false);
  });

  it('accepts_optional_bounded_level_on_each_element_kind_and_rejects_invalid_values', () => {
    const source = structuredClone(fixture('samples.json').DiagramDocument);
    const elements = source.pages.flatMap((p: any) => p.elements);
    expect(elements.map((e: any) => e.kind).sort()).toEqual(['connector', 'group', 'image', 'shape', 'text']);
    for (const level of [-127, 0, 127]) {
      const candidate = structuredClone(source);
      for (const p of candidate.pages) for (const element of p.elements) element.level = level;
      expect(validateDef('DiagramDocument', candidate).valid, `level ${level}`).toBe(true);
    }
    for (const level of [-128, 1.5, 128]) {
      const candidate = structuredClone(source);
      candidate.pages[0].elements[0].level = level;
      expect(validateDef('DiagramDocument', candidate).valid, `level ${level}`).toBe(false);
    }
  });

  it('accepts_level_on_create_and_set_operations_with_the_same_bounds', () => {
    const examples = fixture('operation-examples.json');
    for (const name of ['createShape', 'createText', 'createImage', 'createConnector']) {
      expect(validateOperation({ ...examples[name], level: -127 }).ok, `${name} minimum`).toBe(true);
      expect(validateOperation({ ...examples[name], level: 127 }).ok, `${name} maximum`).toBe(true);
      for (const level of [-128, 1.5, 128]) expect(validateOperation({ ...examples[name], level }).ok, `${name} ${level}`).toBe(false);
    }
    expect(validateOperation({ ...examples.set, patch: { level: 0 } }).ok).toBe(true);
    for (const level of [-128, 1.5, 128]) expect(validateOperation({ ...examples.set, patch: { level } }).ok, `set ${level}`).toBe(false);
  });
});

import { samples } from './support/samples';
import { schemaDefinitionNames, validateDef } from './support/schemaCheck';

describe('shared DTO samples', () => {
  const defOf = (key: string) => (key === 'ResponseEnvelopeError' ? 'ResponseEnvelope' : key);

  it.each(Object.keys(samples))('sample %s is valid against its schema definition', key => {
    const r = validateDef(defOf(key), samples[key]);
    expect(r.message).toBeUndefined();
    expect(r.valid).toBe(true);
  });

  it('covers every cross-boundary type named by the overview plan', () => {
    const required = [
      'Scope', 'Snapshot', 'Projection', 'ExportSnapshot', 'TransactionResult', 'ResolvedDiff', 'ChangeSet', 'Diagnostic',
      'AppError', 'RequestEnvelope', 'ResponseEnvelope', 'CommittedEvent', 'PreparedAssetRef', 'PreparedAsset',
      'MutationRequest', 'ScriptRequest', 'UndoRequest', 'DiagramDocument', 'TransactionSummary',
    ];
    for (const r of required) expect(Object.keys(samples), r).toContain(r);
    expect(schemaDefinitionNames()).toEqual(expect.arrayContaining(required));
  });

  it('exercises every operation and every element kind', () => {
    const ops = (samples.MutationRequest as { operations: Array<{ op: string }> }).operations.map(o => o.op).sort();
    expect(ops).toEqual([
      'addLayer', 'addPage', 'align', 'assignLayers', 'createConnector', 'createImage', 'createShape', 'createText', 'delete', 'deleteLayer', 'deletePage',
      'distribute', 'duplicate', 'duplicatePage', 'group', 'move', 'registerAsset', 'removeAsset', 'reorder', 'reorderPage', 'replaceAsset', 'resize',
      'rotate', 'set', 'setAsset', 'setGap', 'setLayer', 'setPage', 'ungroup',
    ]);
    const kinds = (samples.DiagramDocument as { pages: Array<{ elements: Array<{ kind: string }> }> }).pages[0]!.elements.map(e => e.kind).sort();
    expect(kinds).toEqual(['connector', 'group', 'image', 'shape', 'text']);
  });

  it('keeps the generated TypeScript and C# contracts in step with the schemas', async () => {
    const { execFileSync } = await import('node:child_process');
    const script = new URL('../../../tools/generate-contracts.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    expect(() => execFileSync('node', [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
