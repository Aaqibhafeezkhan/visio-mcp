import { componentCatalog, planComponent, componentPreview } from '../layout/components';
import type { AppError, DiagramDocument, RequestEnvelope, ResponseEnvelope, Scope } from '../contracts/generated';
import type { CommandEngine } from '../commands/CommandEngine';
import { fail, ok, type Result } from '../model/result';
import { validateDocument, validateMutationRequest, validateScriptRequest, validateUndoRequest } from '../model/validate';
import { drawScriptCompiler } from '../script/compiler';
import type { Operation } from '../contracts/generated';
import { listAssets, readObjects, readSummary } from './readTools';
import { proposeRoutes } from './proposeRoutes';
import { inspectLayout, type LayoutContext } from '../layout/inspectLayout';
import { getTextLayout } from '../layout/textLayout';
import type { Projection, Snapshot } from '../contracts/generated';
import type { RenderParams, RenderResult } from '../render/SnapshotRenderer';
import { iconCatalog, iconInfo, iconOperations, searchIcons } from '../icons/catalog';
import { iconPreview } from '../icons/preview';

const toResponse = <T>(requestId: string, r: Result<T>): ResponseEnvelope =>
  r.ok ? { protocolVersion: 1, kind: 'response', requestId, result: r.value } : { protocolVersion: 1, kind: 'response', requestId, error: r.error as AppError };

/** A document living in the agent-only view, as the person's window shows it. */
export interface AgentDocument { documentId: string; sessionId: string; title: string | null; revision: number; unsaved: boolean; pages: number }

/** What the window-level `app.*` requests do. The person's page and the agent-only page each supply the ones that apply to them. */
export interface AppHandlers {
  /** Agent view: a new document in the background. */
  createDocument?: (params: Record<string, unknown>) => Result<Scope & { revision: number; title: string; pageId: string }> | Promise<Result<Scope & { revision: number; title: string; pageId: string }>>;
  /** Agent view: let go of a document (it was handed over, or the person closed its tab). */
  dropDocument?: (documentId: string) => Result<{ dropped: string }>;
  /** The person's page: take a document from the agent view as a new tab. */
  adoptDocument?: (document: DiagramDocument, activate: boolean) => Promise<Result<Scope & { revision: number }>>;
  /** The person's page: show an open tab. */
  activateDocument?: (documentId: string) => Result<{ activated: string }>;
  /** The person's page: the background documents changed. */
  agentDocuments?: (documents: AgentDocument[]) => void;
  /** The person's page: the shell asked for these files to be opened (a double-click, Open with, or a second launch). */
  openFiles?: (files: Array<{ path: string; kind: 'json' | 'vsdx' }>) => Promise<Result<{ opened: number }>>;
  /** The visible editor: a native drop admitted by the host as bounded one-use tickets. */
  captureIngressTarget?: (point: { clientX: number; clientY: number }) => Result<{ documentId: string; sessionId: string; baseRevision: number; pageId: string; x: number; y: number }>;
  ingressAvailable?: (batch: { batchId: string; items: Array<{ ticketId: string; displayName: string; kind: 'json' | 'vsdx' | 'image' }>; rejections: string[]; target?: { documentId: string; sessionId: string; baseRevision: number; pageId: string; x: number; y: number } }) => void;
}

/** Finds the engine of the document a request names; with no document named, the active one. */
export type EngineResolver = (documentId: string | undefined) => CommandEngine | null;

export interface EngineHandlerOptions {
  /** Called after the engine starts a new session (document replaced), so the host can learn the new scope. */
  onSessionChanged?: (scope: Scope, revision: number, engine: CommandEngine) => void;
  /** Rasterises a committed snapshot. Only the page has a drawing surface; without it, render answers not_ready. */
  render?: (snapshot: Snapshot, projection: Projection | undefined, params: RenderParams) => Promise<Result<RenderResult>>;
  /** Turns an approved asset (by hash) into a PNG, for formats that cannot hold the original (an SVG picture inside a Visio file). */
  rasterise?: (sha256: string, maxPixels: number) => Promise<Result<{ base64: string; widthPx: number; heightPx: number }>>;
  /** Text measurement and picture sizes for layout inspection, supplied by the page. */
  layoutContext?: (snapshot: Snapshot, options?: { includeAssets?: boolean }) => Promise<Pick<LayoutContext, 'measureWidth' | 'assetSize'>>;
  app?: AppHandlers;
  /** The host is closing the window: say whether there are unsaved changes (and, if so, ask the person what to do). */
  beforeClose?: () => Promise<{ dirty: boolean }>;
}

/** Used when the page cannot measure text: a rough average advance, and the report says its sizes are estimates either way. */
const approximateWidth: LayoutContext['measureWidth'] = (text, font) => text.length * font.sizePt * 0.5;

/**
 * Routes host-initiated doc.* requests to the engine. Scope arrives at the envelope top level and is merged into the
 * request here; the engine remains the authority on session, duplicate delivery and revision.
 */
export function createEngineHandler(source: CommandEngine | EngineResolver, opts: EngineHandlerOptions = {}) {
  return async (env: RequestEnvelope): Promise<ResponseEnvelope> => {
    const id = env.requestId;
    const p = env.params as Record<string, unknown>;
    const respond = <T>(r: Result<T>) => toResponse(id, r);
    const appHandler = opts.app;
    switch (env.method) {
      case 'app.createDocument': return respond(appHandler?.createDocument ? await appHandler.createDocument(p) : fail('method_not_found', 'this page does not create documents'));
      case 'app.dropDocument': return respond(appHandler?.dropDocument && typeof p.documentId === 'string' ? appHandler.dropDocument(p.documentId) : fail('method_not_found', 'this page does not drop documents'));
      case 'app.adoptDocument': {
        if (!appHandler?.adoptDocument) return respond(fail('method_not_found', 'this page does not take documents'));
        const doc = validateDocument(p.document);
        return respond(doc.ok ? await appHandler.adoptDocument(doc.value as DiagramDocument, p.activate !== false) : doc);
      }
      case 'app.activateDocument': return respond(appHandler?.activateDocument && typeof p.documentId === 'string' ? appHandler.activateDocument(p.documentId) : fail('method_not_found', 'this page does not switch documents'));
      case 'app.openFiles': {
        const list = Array.isArray(p.files) ? p.files : [];
        const files = list.filter((f): f is { path: string; kind: 'json' | 'vsdx' } => !!f && typeof f.path === 'string' && (f.kind === 'json' || f.kind === 'vsdx'));
        if (!appHandler?.openFiles || files.length !== list.length) return respond(fail('invalid_request', 'app.openFiles needs a list of {path, kind}'));
        return respond(await appHandler.openFiles(files));
      }
      case 'app.captureIngressTarget': {
        const hasOnlyKeys = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
        if (!hasOnlyKeys(p, ['clientX', 'clientY']) || typeof p.clientX !== 'number' || !Number.isFinite(p.clientX) || p.clientX < 0 || typeof p.clientY !== 'number' || !Number.isFinite(p.clientY) || p.clientY < 0)
          return respond(fail('invalid_request', 'app.captureIngressTarget needs a finite native drop point'));
        return respond(appHandler?.captureIngressTarget?.({ clientX: p.clientX, clientY: p.clientY }) ?? fail('not_ready', 'the visible editor is not ready'));
      }
      case 'app.ingressAvailable': {
        const batch = p as { batchId?: unknown; items?: unknown; rejections?: unknown; target?: unknown };
        const hasOnlyKeys = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
        const target = batch.target as Record<string, unknown> | undefined;
        const validTarget = target === undefined || (!!target && typeof target === 'object' && hasOnlyKeys(target, ['documentId', 'sessionId', 'baseRevision', 'pageId', 'x', 'y']) &&
          typeof target.documentId === 'string' && target.documentId.length > 0 && target.documentId.length <= 128 && typeof target.sessionId === 'string' && target.sessionId.length > 0 && target.sessionId.length <= 128 &&
          Number.isSafeInteger(target.baseRevision) && Number(target.baseRevision) >= 0 && typeof target.pageId === 'string' && target.pageId.length > 0 && target.pageId.length <= 128 &&
          typeof target.x === 'number' && Number.isFinite(target.x) && typeof target.y === 'number' && Number.isFinite(target.y));
        if (!hasOnlyKeys(p, ['batchId', 'items', 'rejections', 'target']) || !validTarget || typeof batch.batchId !== 'string' || batch.batchId.length < 1 || batch.batchId.length > 128 || !Array.isArray(batch.items) || batch.items.length > 32 || !Array.isArray(batch.rejections) || batch.rejections.length > 32)
          return respond(fail('invalid_request', 'app.ingressAvailable needs a bounded ticket batch'));
        const items = batch.items.filter((item): item is { ticketId: string; displayName: string; kind: 'json' | 'vsdx' | 'image' } =>
          !!item && typeof item === 'object' && hasOnlyKeys(item, ['ticketId', 'displayName', 'kind']) && typeof (item as { ticketId?: unknown }).ticketId === 'string' &&
          typeof (item as { displayName?: unknown }).displayName === 'string' && (item as { displayName: string }).displayName.length <= 128 &&
          ['json', 'vsdx', 'image'].includes(String((item as { kind?: unknown }).kind)));
        if (items.length !== batch.items.length || !batch.rejections.every(x => typeof x === 'string' && x.length <= 256))
          return respond(fail('invalid_request', 'app.ingressAvailable contains invalid ticket metadata'));
        appHandler?.ingressAvailable?.({ batchId: batch.batchId, items, rejections: batch.rejections, ...(target ? { target: target as { documentId: string; sessionId: string; baseRevision: number; pageId: string; x: number; y: number } } : {}) });
        return respond(ok({ received: true }));
      }
      case 'app.agentDocuments':
        appHandler?.agentDocuments?.(Array.isArray(p.documents) ? (p.documents as AgentDocument[]) : []);
        return respond(ok({ received: true }));
      default: break;
    }
    const engine = typeof source === 'function' ? source(env.documentId) : source;
    if (!engine) return toResponse(id, fail('document_mismatch', 'the document is not the open one'));
    const scope = { documentId: env.documentId ?? '', sessionId: env.sessionId ?? '' };

    switch (env.method) {
      case 'app.beforeClose':
        return respond(ok(opts.beforeClose ? await opts.beforeClose() : { dirty: false }));
      case 'components.list': {
        const snap = await engine.snapshot(scope); if (!snap.ok) return respond(snap);
        if (Object.keys(p).length) return respond(fail('invalid_request', 'Component discovery has no options'));
        return respond(ok({ ...componentCatalog, documentId: snap.value.documentId, sessionId: snap.value.sessionId, revision: snap.value.revision }));
      }
      case 'components.get': {
        const snap = await engine.snapshot(scope); if (!snap.ok) return respond(snap);
        if (!opts.layoutContext || !opts.render) return respond(fail('not_ready', 'Component previews require the editor drawing and font measurement context'));
        const ctx = await opts.layoutContext(snap.value, { includeAssets: false });
        const proposal = planComponent(snap.value, ctx, p); if (!proposal.ok) return respond(proposal);
        const scene = componentPreview(snap.value, proposal.value); if (!scene.ok) return respond(scene);
        const image = await opts.render(scene.value, undefined, { scope: 'region', pageId: proposal.value.pageId, bounds: proposal.value.bounds, paddingPt: 8, maxWidth: 1200, maxHeight: 1600, format: 'png' });
        return respond(image.ok ? ok({ ...image.value, ...proposal.value, preview: true, previewOf: 'layout_component', catalogVersion: componentCatalog.version,
          guidance: 'Read-only proposal. Apply operations with returned documentId/sessionId/baseRevision and a new transactionId. Reflow again after conflicting edits. Named parts remain ordinary editable objects; no automatic constraints are installed.' }) : image);
      }
      case 'icons.search':
      case 'icons.get': {
        const snap = await engine.snapshot(scope); if (!snap.ok) return respond(snap);
        if (!opts.render) return respond(fail('not_ready', 'icon previews require the editor drawing surface'));
        let icons: typeof iconCatalog.icons;
        let metadata: Record<string, unknown>;
        let colour = '#334155', strokeRatio = 1 / 12;
        if (env.method === 'icons.search') {
          const found = searchIcons(p.query ?? '', p.limit ?? 24); if (!found.ok) return respond(found);
          icons = found.value.icons;
          metadata = { icons: icons.map(iconInfo), total: found.value.total, hasMore: found.value.total > icons.length };
        } else {
          if (!snap.value.document.pages.some(page => page.id === p.pageId)) return respond(fail('not_found', 'pageId is not in the open document'));
          const prepared = iconOperations(p); if (!prepared.ok) return respond(prepared);
          const v = prepared.value; icons = [v.icon]; colour = v.colour; strokeRatio = v.strokeWidthPt / v.sizePt;
          metadata = { icon: { ...iconInfo(v.icon), geometry: { svgPath: v.icon.path } }, elementId: v.elementId, operations: v.operations,
            baseRevision: snap.value.revision, destinationPageId: p.pageId,
            guidance: 'Apply these operations with the returned document/session identity and baseRevision, using a new transactionId. This preview changed nothing.' };
        }
        const scene = iconPreview(snap.value, icons, { colour, strokeRatio });
        const image = await opts.render(scene, undefined, { scope: 'page', pageId: scene.document.pages[0]!.id, maxWidth: 1200, maxHeight: 1200, format: 'png' });
        return respond(image.ok ? ok({ ...image.value, ...metadata, preview: true, previewOf: 'icon_catalog', catalogVersion: iconCatalog.version,
          sourceVersion: iconCatalog.sourceVersion, sourceCommit: iconCatalog.sourceCommit, licence: iconCatalog.licence }) : image);
      }
      case 'doc.snapshot':
        return respond(await engine.snapshot(scope));
      case 'doc.retainedBlobs': {
        const s = await engine.snapshot(scope); // checks scope and waits for the queue like any read
        return respond(s.ok ? ok({ revision: s.value.revision, hashes: engine.retainedBlobHashes() }) : s);
      }
      case 'doc.apply': {
        const req = validateMutationRequest({ ...p, ...scope });
        return respond(req.ok ? await engine.execute(req.value, 'mcp') : req);
      }
      case 'doc.executeScript': {
        const req = validateScriptRequest({ ...p, ...scope });
        if (!req.ok) return respond(req);
        // Show the model exactly what its script became. A retry answered from the cache never compiles, so it carries no operations.
        let operations: Operation[] | undefined;
        const r = await engine.executeScript(req.value, (src, snap, ctx) => {
          const out = drawScriptCompiler(src, snap, ctx);
          if (out.ok) operations = out.value.operations;
          return out;
        });
        return respond(r.ok ? ok({ transaction: r.value, ...(operations ? { operations } : {}) }) : r);
      }
      case 'doc.summary': {
        const s = await engine.snapshot(scope);
        if (!s.ok) return respond(s);
        const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
        return respond(readSummary(s.value, {
          ...(typeof p.pageId === 'string' ? { pageId: p.pageId } : {}),
          ...(bool(p.includeGeometry) !== undefined ? { includeGeometry: p.includeGeometry as boolean } : {}),
          ...(bool(p.includeStyle) !== undefined ? { includeStyle: p.includeStyle as boolean } : {}),
          ...(bool(p.includeHidden) !== undefined ? { includeHidden: p.includeHidden as boolean } : {}),
        }));
      }
      case 'doc.getObjects': {
        if (!Array.isArray(p.ids) || p.ids.length === 0 || p.ids.length > 500 || p.ids.some(i => typeof i !== 'string')) return respond(fail('invalid_request', 'ids must be 1 to 500 strings'));
        const exportSnapshot = await engine.exportSnapshot(scope);
        if (exportSnapshot.ok) {
          const objects = readObjects(exportSnapshot.value, p.ids as string[], typeof p.pageId === 'string' ? p.pageId : undefined);
          if (!objects.ok) return respond(objects);
          const routeDiagnostics = objects.value.flatMap(element => {
            if (element.kind !== 'connector') return [];
            const projection = exportSnapshot.value.projection.connectors[element.id];
            if (!projection?.routeProvenance && !projection?.routeReason && !projection?.routeFindings?.length) return [];
            return [{
              id: element.id,
              ...(projection.routeProvenance ? { routeProvenance: projection.routeProvenance } : {}),
              ...(projection.routeReason ? { routeReason: projection.routeReason } : {}),
              ...(projection.routeFindings?.length ? { routeFindings: projection.routeFindings } : {}),
            }];
          });
          return respond(ok({ revision: exportSnapshot.value.revision, objects: objects.value, routeDiagnostics }));
        }
        if (exportSnapshot.error.code !== 'projection_failed') return respond(exportSnapshot);
        // Keep canonical object reads available when the derived projection is unavailable; mark diagnostics unavailable rather than returning stale data.
        const snapshot = await engine.snapshot(scope);
        if (!snapshot.ok) return respond(snapshot);
        const objects = readObjects(snapshot.value, p.ids as string[], typeof p.pageId === 'string' ? p.pageId : undefined);
        return respond(objects.ok ? ok({
          revision: snapshot.value.revision,
          objects: objects.value,
          routeDiagnostics: [],
          routeDiagnosticsStatus: { status: 'unavailable', reason: exportSnapshot.error.message },
        }) : objects);
      }
      case 'doc.proposeRoutes':
        return respond(await proposeRoutes(engine, scope, p));
      case 'assets.list': {
        const s = await engine.snapshot(scope);
        if (!s.ok) return respond(s);
        const tags = Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === 'string') : undefined;
        return respond(ok({ revision: s.value.revision, assets: listAssets(s.value, typeof p.query === 'string' ? p.query : undefined, tags) }));
      }
      case 'doc.exportSnapshot': {
        // The barrier read export and save use: committed state at one revision plus the derived routes at that same revision.
        const snap = await engine.exportSnapshot(scope);
        return respond(snap);
      }
      case 'assets.rasterise': {
        if (!opts.rasterise) return respond(fail('not_ready', 'this editor has no drawing surface to rasterise with'));
        if (typeof p.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(p.sha256)) return respond(fail('invalid_request', 'sha256 must be a 64 character hex string'));
        return respond(await opts.rasterise(p.sha256, typeof p.maxPixels === 'number' ? Math.min(4096, Math.max(16, p.maxPixels)) : 1024));
      }
      case 'doc.render': {
        if (!opts.render) return respond(fail('not_ready', 'this editor has no drawing surface to render with', { retryable: false }));
        if (p.scope !== 'page' && p.scope !== 'region') return respond(fail('invalid_request', 'scope must be page or region'));
        // A barrier read: the picture shows the revision committed at this point, however far the live document moves while it is drawn.
        const snap = await engine.exportSnapshot(scope);
        if (!snap.ok) return respond(snap);
        return respond(await opts.render(snap.value as Snapshot, snap.value.projection, p as unknown as RenderParams));
      }
      case 'doc.textLayout': {
        const snap = await engine.snapshot(scope);
        if (!snap.ok) return respond(snap);
        if (!opts.layoutContext) return respond(fail('not_ready', 'The editor font measurement context is not available'));
        const measured = await opts.layoutContext(snap.value, { includeAssets: false });
        return respond(getTextLayout(snap.value, measured, p));
      }
      case 'doc.inspectLayout': {
        let snap: Result<Snapshot & { projection?: Projection }> = await engine.exportSnapshot(scope);
        // A host with no drawing surface has no resolved routes; connectors are then judged by straight lines, and the report says so.
        if (!snap.ok && snap.error.code === 'projection_failed') snap = await engine.snapshot(scope);
        if (!snap.ok) return respond(snap);
        const measured = opts.layoutContext ? await opts.layoutContext(snap.value as Snapshot) : { measureWidth: approximateWidth };
        const report = inspectLayout(snap.value as Snapshot, { ...measured, ...(snap.value.projection ? { projection: snap.value.projection } : {}) }, typeof p.pageId === 'string' ? { pageId: p.pageId } : {});
        return respond(ok({ documentId: snap.value.documentId, sessionId: snap.value.sessionId, revision: snap.value.revision, issues: report.issues, notes: report.notes }));
      }
      case 'doc.export':
        return respond(fail('not_ready', 'export arrives with the native file work (I40)', { retryable: false }));
      case 'doc.undo':
      case 'doc.redo': {
        const req = validateUndoRequest({ ...p, ...scope });
        if (!req.ok) return respond(req);
        return respond(env.method === 'doc.undo' ? await engine.undo(req.value) : await engine.redo(req.value));
      }
      case 'doc.changes': {
        if (typeof p.sinceRevision !== 'number' || !Number.isInteger(p.sinceRevision) || p.sinceRevision < 0) return respond(fail('invalid_request', 'sinceRevision must be a non-negative integer'));
        return respond(await engine.getChanges(scope, p.sinceRevision));
      }
      case 'doc.replace': {
        if (typeof p.baseRevision !== 'number' || !Number.isInteger(p.baseRevision)) return respond(fail('invalid_request', 'baseRevision must be an integer'));
        const doc = validateDocument(p.document);
        if (!doc.ok) return respond(doc);
        const r = await engine.replaceDocument(doc.value as DiagramDocument, { ...scope, baseRevision: p.baseRevision });
        if (r.ok) opts.onSessionChanged?.(engine.scope(), engine.revision, engine);
        return respond(r);
      }
      case 'doc.markSaved': {
        if (typeof p.revision !== 'number' || !Number.isInteger(p.revision) || typeof p.path !== 'string') return respond(fail('invalid_request', 'revision and path are required'));
        const r = await engine.markSaved(scope, p.revision, p.path);
        return respond(r.ok ? ok({ revision: p.revision }) : r);
      }
      case 'doc.status': {
        const s = await engine.snapshot(scope);
        return respond(s.ok ? ok({ ...engine.status(), ...engine.scope(), revision: engine.revision, title: s.value.document.title, pageCount: s.value.document.pages.length }) : s);
      }
      default:
        return respond(fail('method_not_found', `unknown method ${env.method}`));
    }
  };
}
