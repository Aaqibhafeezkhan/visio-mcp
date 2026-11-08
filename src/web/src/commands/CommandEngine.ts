import type {
  ChangeSet, CommittedEvent, DiagramDocument, ExportSnapshot, MutationRequest, Operation, Projection, ResolvedDiff, ScriptRequest,
  Scope, Snapshot, TransactionRecord, TransactionResult, TransactionSource, TransactionSummary, UndoRequest,
} from '../contracts/generated';
import { canonicalSerialize } from '../model/canonical';
import { fail, ok, type Result } from '../model/result';
import { sha256Hex } from '../model/sha256';
import { DocumentStore } from '../model/store';
import { validateDocument, validateMutationRequest, validateOperation, validateScriptRequest, validateUndoRequest } from '../model/validate';
import { withSpan, type SourceSpan } from '../script/compiler';
import { applyDiff, type DiffBody } from './diff';
import { History } from './history';
import { settleAttachments, type RouteSource } from './attachments';
import { settleRoutes } from './routes';
import { settleJoins } from './joins';
import { planPatch, type Plan } from './planPatch';
import { readDocumentDefaults } from '../model/documentDefaults';
import { planRoutes } from '../layout/routePlanner';

export type Projector = (snapshot: Snapshot, diff: ResolvedDiff) => Result<void>;
export type SnapshotProjector = (snapshot: Snapshot) => Result<Projection>;
/** Runs work whose hidden projections must leave the projector as it was (R25 proposals project documents that are never committed). */
export type ProjectionIsolation = <T>(run: () => T) => T;
/** What a route proposal (R25) gets inside its queue job: the committed snapshot and a planner bound to it that commits nothing. */
export interface RoutePreview {
  before: Snapshot;
  /** Plans reroute operations exactly as a transaction at `before` would; `after` is the document that transaction would produce. */
  plan(operations: Operation[]): Result<{ plan: Plan; after: DiagramDocument }>;
  /** The routes as drawn at `before` (the hidden projection), checked to belong to it; projection_failed when there is none. */
  drawn(): Result<Projection>;
}
export type ScriptCompiler = (
  script: string,
  snapshot: Snapshot,
  context: { pageId?: string; preparedAssetRefs?: ScriptRequest['preparedAssetRefs'] },
) => Result<{ operations: Operation[]; sourceSpans?: unknown }>;

function requestsHardRoutePreflight(operations: readonly Operation[]): boolean {
  const hardEndpoint = (value: unknown) => !!value && typeof value === 'object' && (value as { glue?: unknown }).glue === 'static';
  return operations.some(op => {
    if (op.op === 'set') {
      const patch = op.patch as Record<string, unknown>;
      const policy = patch.routingPolicy as { obstacle?: string; text?: string } | undefined;
      const required = (value: unknown) => !!value && typeof value === 'object' && (value as { requiredSide?: unknown }).requiredSide != null;
      return policy?.obstacle === 'forbidden' || policy?.text === 'avoid' || hardEndpoint(patch.from) || hardEndpoint(patch.to) || required(patch.from) || required(patch.to);
    }
    if (op.op === 'createConnector') return hardEndpoint(op.from) || hardEndpoint(op.to) || op.from.requiredSide != null || op.to.requiredSide != null;
    return false;
  });
}

export interface EngineOptions {
  document: DiagramDocument;
  /** Explicit File > New tabs hold intentional unsaved work, even before their first edit. */
  explicitUnsaved?: boolean;
  /** Element and (for tests) transaction ids. Default: crypto.randomUUID. */
  idFactory?: () => string;
  /** The engine, not callers, creates session ids. Default: crypto.randomUUID. */
  sessionIdFactory?: () => string;
  retention?: { results?: number; resultBytes?: number; history?: number };
  now?: () => number;
}

interface CacheEntry { hash: string; result: Result<TransactionResult>; bytes: number }
type Method = 'apply' | 'script' | 'undo' | 'redo';

export interface EngineStatus {
  recoveryDegraded: boolean;
  checkpointRequested: boolean;
  projectionHealthy: boolean;
  savedRevision: number | null;
  savedPath: string | null;
  /** Not the same as the revision having moved past the save: false for a brand-new blank document nobody has touched. */
  dirty: boolean;
  /** There is work a person could lose: edits since the last save, or a document that was opened or recovered and never saved. */
  unsaved: boolean;
}

/**
 * The only writer of committed state. Every GUI edit, script and MCP call is queued here and goes through the same
 * sequence: scope, then duplicate-transaction cache, then base revision, then planning and one synchronous commit.
 */
export class CommandEngine {
  readonly store: DocumentStore;
  private readonly newId: () => string;
  private readonly newSessionId: () => string;
  private history: History;
  private cache = new Map<string, CacheEntry>();
  private cacheBytes = 0;
  private readonly maxResults: number;
  private readonly maxResultBytes: number;
  private readonly maxHistory: number;
  private tail: Promise<unknown> = Promise.resolve();
  private projector: Projector | null = null;
  private snapshotProjector: SnapshotProjector | null = null;
  private isolateProjection: ProjectionIsolation | null = null;
  private listeners = new Set<(e: CommittedEvent) => void>();
  private sequence = 0;
  private recoveryDegraded = false;
  private checkpointRequested = false;
  private projectionHealthy = true;
  private savedRevision: number | null = null;
  private savedPath: string | null = null;
  /** The revision of the untouched blank page the app started with; null once any document was opened or recovered into it. */
  private blankRevision: number | null;

  constructor(opts: EngineOptions) {
    this.newId = opts.idFactory ?? (() => crypto.randomUUID());
    this.newSessionId = opts.sessionIdFactory ?? (() => crypto.randomUUID());
    this.maxResults = opts.retention?.results ?? 256;
    this.maxResultBytes = opts.retention?.resultBytes ?? 16 * 1024 * 1024;
    this.maxHistory = opts.retention?.history ?? 1000;
    this.store = new DocumentStore(opts.document, this.newSessionId());
    this.history = new History(this.store.revision, this.maxHistory);
    this.blankRevision = opts.explicitUnsaved ? null : this.store.revision;
  }

  get documentId(): string { return this.store.documentId; }
  get sessionId(): string { return this.store.sessionId; }
  get revision(): number { return this.store.revision; }
  scope(): Scope { return { documentId: this.documentId, sessionId: this.sessionId }; }

  status(): EngineStatus {
    return {
      recoveryDegraded: this.recoveryDegraded, checkpointRequested: this.checkpointRequested, projectionHealthy: this.projectionHealthy,
      savedRevision: this.savedRevision, savedPath: this.savedPath, dirty: this.savedRevision !== this.revision,
      unsaved: this.savedRevision === null ? this.blankRevision === null || this.revision !== this.blankRevision : this.revision !== this.savedRevision,
    };
  }

  /** Picture hashes the document and its undo/redo history still need (for garbage collection, which must never remove them). */
  retainedBlobHashes(): string[] {
    const live = new Set(this.store.snapshot().document.assets.map(a => a.sha256));
    for (const h of this.history.retainedAssetHashes()) live.add(h);
    return [...live];
  }

  setProjector(project: Projector): void { this.projector = project; }
  setSnapshotProjector(project: SnapshotProjector, isolate?: ProjectionIsolation): void { this.snapshotProjector = project; this.isolateProjection = isolate ?? null; }

  onCommitted(listener: (event: CommittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------------ queue
  private enqueue<T>(job: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(job, job);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private checkScope(scope: { documentId?: string; sessionId?: string }): Result<void> {
    if (!scope.documentId || !scope.sessionId) return fail('invalid_request', 'documentId and sessionId are required');
    if (scope.documentId !== this.documentId) return fail('document_mismatch', 'the request is for a different document', { details: { actual: this.documentId } });
    if (scope.sessionId !== this.sessionId) return fail('session_mismatch', 'the session is not the current one', { details: { actual: this.sessionId } });
    return ok(undefined);
  }

  // ------------------------------------------------------------------ mutations
  execute(req: MutationRequest, source: TransactionSource | 'gui' | 'script' | 'mcp'): Promise<Result<TransactionResult>> {
    const v = validateMutationRequest(req);
    if (!v.ok) return Promise.resolve(v);
    const hash = this.hashOf('apply', req, { operations: req.operations });
    return this.enqueue(() => this.runMutation('apply', req, source, hash, () => ok(req.operations)));
  }

  executeScript(req: ScriptRequest, compile: ScriptCompiler): Promise<Result<TransactionResult>> {
    const v = validateScriptRequest(req);
    if (!v.ok) return Promise.resolve(v);
    // Source and the pictures it may import are the caller's input; compiled UUIDs are not, so they stay out of the hash. A preparation id is
    // issued fresh for every request, so only the approved descriptors count: retrying the same script must hash the same.
    const pictures = req.preparedAssetRefs ? Object.fromEntries(Object.entries(req.preparedAssetRefs).map(([k, r]) => [k, r.asset])) : null;
    const hash = this.hashOf('script', req, { script: req.script, preparedAssetRefs: pictures });
    let spans: SourceSpan[] | undefined;
    return this.enqueue(() => this.runMutation('script', req, 'script', hash, snapshot => {
      const ctx: Parameters<ScriptCompiler>[2] = {};
      if (req.pageId) ctx.pageId = req.pageId;
      if (req.preparedAssetRefs) ctx.preparedAssetRefs = req.preparedAssetRefs;
      const compiled = compile(req.script, snapshot, ctx);
      if (!compiled.ok) return compiled;
      spans = compiled.value.sourceSpans as SourceSpan[] | undefined;
      // A script is bounded and typed exactly like an apply request, whatever produced the operations.
      if (compiled.value.operations.length > 1000) return fail('limit_exceeded', `a script can produce at most 1000 operations, this one produced ${compiled.value.operations.length}`, { details: { limit: 1000, actual: compiled.value.operations.length } });
      for (const [i, op] of compiled.value.operations.entries()) {
        const valid = validateOperation(op);
        if (!valid.ok) return withSpan(fail(valid.error.code, valid.error.message, { details: { ...valid.error.details, operationIndex: i } }), spans);
      }
      return ok(compiled.value.operations);
    }, () => spans));
  }

  /** The newest transaction summaries (including undo and redo records), newest last. A read: it does not enter the queue. */
  recentTransactions(limit = 50): TransactionSummary[] { return this.history.recent(limit); }

  /** The transaction an undo would take back now, if any. Only this one can be undone: there is no selective undo across later changes. */
  undoHead(): TransactionSummary | undefined { return this.history.peekUndo()?.summary; }
  redoHead(): TransactionSummary | undefined { return this.history.peekRedo()?.summary; }

  undo(req: UndoRequest): Promise<Result<TransactionResult>> { return this.replay('undo', req); }
  redo(req: UndoRequest): Promise<Result<TransactionResult>> { return this.replay('redo', req); }

  private hashOf(method: Method, req: { documentId: string; sessionId: string; pageId?: string; baseRevision: number }, params: unknown): string {
    return sha256Hex(canonicalSerialize({
      method, documentId: req.documentId, sessionId: req.sessionId, pageId: req.pageId ?? null, baseRevision: req.baseRevision, params,
    }));
  }

  /** Steps 2 and 3 of the lifecycle, shared by every mutation: scope, then cache, then revision. Order is mandatory. */
  private admit(req: { documentId: string; sessionId: string; transactionId: string; baseRevision: number }, hash: string): Result<TransactionResult> | null {
    const scope = this.checkScope(req);
    if (!scope.ok) return scope;
    const cached = this.cache.get(req.transactionId);
    if (cached) {
      if (cached.hash === hash) return cached.result;
      return fail('transaction_id_conflict', 'this transaction id was already used for a different request', { details: { transactionId: req.transactionId } });
    }
    if (req.baseRevision !== this.revision) {
      const changes = this.history.since(req.baseRevision);
      return fail('revision_conflict', `the document is at revision ${this.revision}, not ${req.baseRevision}`, {
        retryable: false,
        details: { expected: req.baseRevision, actual: this.revision, ...(changes ? { changesSinceExpected: changes } : { historyUnavailable: true }) },
      });
    }
    return null;
  }

  private async runMutation(
    method: Method,
    req: MutationRequest | ScriptRequest,
    source: TransactionSource | 'gui' | 'script' | 'mcp',
    hash: string,
    produce: (snapshot: Snapshot) => Result<Operation[]>,
    spans?: () => SourceSpan[] | undefined,
  ): Promise<Result<TransactionResult>> {
    const early = this.admit(req, hash);
    if (early) return early;
    const before = this.store.snapshot();
    const ops = produce(before);
    if (!ops.ok) return ops;
    const planned = this.planOn(before, ops.value, req.pageId, this.newId, this.snapshotProjector);
    if (!planned.ok) return spans ? withSpan(planned, spans()) : planned;
    const plan = planned.value;
    const previousRevision = before.revision;

    if (plan.noChange) {
      const result = this.resultOf(req.transactionId, previousRevision, previousRevision, plan, 'applied');
      return this.remember(req.transactionId, hash, ok(result));
    }

    const result = this.commit(plan.forward, plan.inverse, {
      transactionId: req.transactionId, source: source as TransactionSource, previousRevision, description: plan.description,
      plan, kind: 'edit',
    });
    return this.remember(req.transactionId, hash, result);
  }

  /**
   * Plans a batch on a snapshot without committing anything: the one planning path that transactions and route proposals (R25) share, so a
   * proposal is what the transaction would do. Joins are settled before routes are stored, attachments after.
   */
  private planOn(before: Snapshot, operations: Operation[], pageId: string | undefined, newId: () => string, source: RouteSource | null): Result<Plan> {
    const planned = planPatch(before.document, operations, { newId, ...(pageId ? { pageId } : {}) });
    if (!planned.ok) return planned;
    const snapshotOf = (doc: DiagramDocument) => ({ ...before, revision: before.revision + 1, document: doc });
    const exactBeautify = planned.value.exactRouteIds !== undefined; // Beautify stores exact routes; settling must not replan them
    const joined = settleJoins(before.document, planned.value, source, snapshotOf);
    const routed = exactBeautify ? joined : settleRoutes(before.document, joined);
    if (!exactBeautify && requestsHardRoutePreflight(operations)) {
      const existing = new Set(before.document.pages.flatMap(page => planRoutes({ elements: page.elements, layers: page.layers, pageArea: page.widthPt * page.heightPt }).routeFindings)
        .filter(finding => finding.code === 'UNRESOLVED_ROUTE' || finding.code === 'ROUTE_REQUIRED_SIDE_UNRESOLVED')
        .map(finding => `${finding.elementId}:${finding.code}`));
      const introduced = (routed.routeFindings ?? []).filter(finding => (finding.code === 'UNRESOLVED_ROUTE' || finding.code === 'ROUTE_REQUIRED_SIDE_UNRESOLVED') && !existing.has(`${finding.elementId}:${finding.code}`));
      if (introduced.length) {
        return fail('invalid_request', 'the routing policy would leave one or more connectors without a clear route', {
          details: {
            reason: introduced.some(finding => finding.code === 'ROUTE_REQUIRED_SIDE_UNRESOLVED') ? 'required_side_unresolved' : 'routing_policy_unresolved',
            connectorIds: introduced.map(finding => finding.elementId).sort(),
          },
        });
      }
    }
    return ok(settleAttachments(before.document, routed, source, snapshotOf));
  }

  /**
   * R25: a route proposal. One queue job captures the committed snapshot and hands the caller a planner bound to it, so selection, planning
   * and reporting all see the same revision. Nothing is committed: store, revision, history, transaction cache, ids and listeners are not
   * touched, and the hidden projector's route memory is put back afterwards.
   */
  previewRoutes<T>(scope: Scope, job: (preview: RoutePreview) => Result<T>): Promise<Result<T>> {
    return this.enqueue(() => {
      const s = this.checkScope(scope);
      if (!s.ok) return s;
      const before = this.store.snapshot();
      const run = () => job({ before, plan: operations => this.previewPlan(before, operations), drawn: () => this.checkedProjection(before) });
      return this.isolateProjection ? this.isolateProjection(run) : run();
    });
  }

  private previewPlan(before: Snapshot, operations: Operation[]): Result<{ plan: Plan; after: DiagramDocument }> {
    if (operations.some(op => op.op !== 'reroute')) return fail('invalid_request', 'a route proposal plans reroute operations only');
    // Settling joins and attachments quietly skips a route it cannot get. A proposal must not offer that as complete, so it remembers why.
    let unavailable: Result<never> | undefined;
    const source: RouteSource = snapshot => {
      const projected = this.checkedProjection(snapshot);
      if (!projected.ok) unavailable ??= projected;
      return projected;
    };
    const planned = this.planOn(before, operations, undefined, () => { throw new Error('a route proposal cannot create elements'); }, source);
    if (!planned.ok) return planned;
    if (unavailable) return unavailable;
    return ok({ plan: planned.value, after: applyDiff(before.document, planned.value.forward, before.revision + 1) });
  }

  /** A projection of exactly this snapshot that holds every route joins and attachments are placed on, or projection_failed. */
  private checkedProjection(snapshot: Snapshot): Result<Projection> {
    if (!this.snapshotProjector) return fail('projection_failed', 'no snapshot projector is registered');
    let projected: Result<Projection>;
    try { projected = this.snapshotProjector(snapshot); } catch (e) { projected = fail('projection_failed', String(e)); }
    if (!projected.ok) return fail('projection_failed', projected.error.message);
    const p = projected.value;
    if (p.revision !== snapshot.revision || p.sessionId !== snapshot.sessionId || p.documentId !== snapshot.documentId) {
      return fail('projection_failed', 'the projection does not belong to the planned document');
    }
    const missing = routesNeeded(snapshot.document).filter(id => !p.connectors[id]?.routePoints?.length);
    if (missing.length) return fail('projection_failed', 'the projection has no route for connectors that others are joined or attached to', { details: { connectorIds: missing } });
    return projected;
  }

  private resultOf(transactionId: string, previousRevision: number, revision: number, plan: ReturnType<typeof emptyPlan>, projectionStatus: 'applied' | 'failed'): TransactionResult {
    const diagnostic = readDocumentDefaults(this.store.snapshot().document).diagnostic;
    return {
      transactionId, previousRevision, revision, noChange: previousRevision === revision,
      created: plan.created, changed: plan.changed, deleted: plan.deleted, changedPageIds: plan.changedPageIds,
      changedLayerIds: plan.changedLayerIds, changedAssetIds: plan.changedAssetIds, visuallyAffectedIds: plan.visuallyAffectedIds,
      warnings: diagnostic ? [{ severity: 'warning', code: 'DOCUMENT_DEFAULTS_INVALID', message: diagnostic }] : [], projectionStatus,
      ...(plan.routeChanges?.length ? { routeChanges: plan.routeChanges } : {}),
      ...(plan.routeFindings?.length ? { routeFindings: plan.routeFindings } : {}),
    };
  }

  /** The single commit point: apply, record, notify. Runs synchronously inside the queue. */
  private commit(
    forwardBody: DiffBody,
    inverseBody: DiffBody,
    meta: { transactionId: string; source: TransactionSource; previousRevision: number; description: string; plan: ReturnType<typeof emptyPlan>; kind: 'edit' | 'undo' | 'redo'; replayOf?: TransactionRecord },
  ): Result<TransactionResult> {
    const revision = meta.previousRevision + 1;
    const forward: ResolvedDiff = { ...forwardBody, transactionId: meta.transactionId, source: meta.source, previousRevision: meta.previousRevision, revision };
    const inverse: ResolvedDiff = { ...inverseBody, transactionId: meta.transactionId, source: meta.source, previousRevision: revision, revision: meta.previousRevision };

    this.store.commit(applyDiff(this.store.snapshot().document, forward, revision));
    const summary: TransactionSummary = {
      transactionId: meta.transactionId, source: meta.source, previousRevision: meta.previousRevision, revision, description: meta.description,
      created: meta.plan.created, changed: meta.plan.changed, deleted: meta.plan.deleted, changedPageIds: meta.plan.changedPageIds,
      changedLayerIds: meta.plan.changedLayerIds, changedAssetIds: meta.plan.changedAssetIds,
    };
    const record: TransactionRecord = { summary, forward, inverse };
    if (meta.kind === 'edit') this.history.pushEdit(record);
    else this.history.pushReplay(record);
    this.sequence++;

    let projectionStatus: 'applied' | 'failed' = 'applied';
    if (this.projector) {
      let projected: Result<void>;
      try { projected = this.projector(this.store.snapshot(), forward); } catch (e) { projected = fail('projection_failed', String(e)); }
      if (!projected.ok) { projectionStatus = 'failed'; this.projectionHealthy = false; } else this.projectionHealthy = true;
    }

    const event: CommittedEvent = { sequence: this.sequence, documentId: this.documentId, sessionId: this.sessionId, revision, resolvedDiff: forward };
    for (const l of this.listeners) {
      try { l(event); } catch { this.recoveryDegraded = true; this.checkpointRequested = true; } // a failed durability listener cannot undo a commit
    }
    return ok(this.resultOf(meta.transactionId, meta.previousRevision, revision, meta.plan, projectionStatus));
  }

  private remember(transactionId: string, hash: string, result: Result<TransactionResult>): Result<TransactionResult> {
    const bytes = JSON.stringify(result).length;
    this.cache.set(transactionId, { hash, result, bytes });
    this.cacheBytes += bytes;
    // Bounded by count and total bytes; byte pressure may evict earlier entries.
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= this.maxResults && this.cacheBytes <= this.maxResultBytes) break;
      if (key === transactionId) continue;
      this.cache.delete(key);
      this.cacheBytes -= entry.bytes;
    }
    return result;
  }

  // ------------------------------------------------------------------ undo / redo
  private replay(kind: 'undo' | 'redo', req: UndoRequest): Promise<Result<TransactionResult>> {
    const v = validateUndoRequest(req);
    if (!v.ok) return Promise.resolve(v);
    const hash = this.hashOf(kind, req, {});
    return this.enqueue((): Result<TransactionResult> => {
      const early = this.admit(req, hash);
      if (early) return early;
      const rec = kind === 'undo' ? this.history.peekUndo() : this.history.peekRedo();
      if (!rec) {
        const evicted = kind === 'undo' && this.history.hasEvictedUndo;
        return fail('history_unavailable', evicted ? 'older history was discarded' : `nothing to ${kind}`, {
          details: { reason: evicted ? 'evicted' : 'empty', earliestRetainedRevision: this.history.earliestRetainedRevision },
        });
      }
      const previousRevision = this.revision;
      const body = kind === 'undo' ? rec.inverse : rec.forward;
      const opposite = kind === 'undo' ? rec.forward : rec.inverse;
      const plan = describeDiff(this.store.snapshot().document, body);
      const result = this.commit(body, opposite, {
        transactionId: req.transactionId, source: kind, previousRevision, description: `${kind}: ${rec.summary.description}`, plan, kind,
      });
      if (result.ok) { if (kind === 'undo') this.history.moveUndoToRedo(); else this.history.moveRedoToUndo(); }
      return this.remember(req.transactionId, hash, result);
    });
  }

  // ------------------------------------------------------------------ reads and lifecycle barriers
  snapshot(scope: Scope): Promise<Result<Snapshot>> {
    return this.enqueue(() => {
      const s = this.checkScope(scope);
      return s.ok ? ok(this.store.snapshot()) : s;
    });
  }

  exportSnapshot(scope: Scope): Promise<Result<ExportSnapshot>> {
    return this.enqueue(() => {
      const s = this.checkScope(scope);
      if (!s.ok) return s;
      if (!this.snapshotProjector) return fail('projection_failed', 'no snapshot projector is registered');
      const snapshot = this.store.snapshot();
      let projection: Result<Projection>;
      try { projection = this.snapshotProjector(snapshot); } catch (e) { projection = fail('projection_failed', String(e)); }
      if (!projection.ok) return projection;
      const p = projection.value;
      if (p.revision !== snapshot.revision || p.sessionId !== snapshot.sessionId || p.documentId !== snapshot.documentId) {
        return fail('projection_failed', 'the projection does not belong to this snapshot');
      }
      return ok({ ...snapshot, projection: p });
    });
  }

  getChanges(scope: Scope, sinceRevision: number): Promise<Result<ChangeSet>> {
    return this.enqueue(() => {
      const s = this.checkScope(scope);
      if (!s.ok) return s;
      const transactions = this.history.since(sinceRevision);
      if (!transactions) {
        return fail('history_unavailable', 'that revision is older than the retained history', {
          details: { earliestRetainedRevision: this.history.earliestRetainedRevision, revision: this.revision, guidance: 'read a full summary instead' },
        });
      }
      return ok({ sinceRevision, earliestRetainedRevision: this.history.earliestRetainedRevision, revision: this.revision, transactions });
    });
  }

  /**
   * Replaces the open document (open file, recovery). The import must name the revision it started from, so an import
   * that finishes after the user kept editing cannot discard those edits. Starts a new session and clears history and cache.
   */
  replaceDocument(doc: DiagramDocument, expected: Scope & { baseRevision: number }): Promise<Result<Snapshot>> {
    return this.enqueue(() => {
      const s = this.checkScope(expected);
      if (!s.ok) return s;
      if (expected.baseRevision !== this.revision) {
        return fail('revision_conflict', `the document is at revision ${this.revision}, not ${expected.baseRevision}`, { details: { expected: expected.baseRevision, actual: this.revision } });
      }
      const valid = validateDocument(doc);
      if (!valid.ok) return valid;
      this.store.replace(valid.value, this.newSessionId());
      this.history = new History(this.store.revision, this.maxHistory);
      this.cache.clear();
      this.cacheBytes = 0;
      this.sequence = 0;
      this.savedRevision = null;
      this.savedPath = null;
      this.blankRevision = null;
      this.recoveryDegraded = false;
      this.checkpointRequested = false;
      this.projectionHealthy = true;
      return ok(this.store.snapshot());
    });
  }

  /** Records that `revision` of this session reached disk. A save of an older session or an older revision never cleans newer state. */
  markSaved(scope: Scope, revision: number, path: string): Promise<Result<void>> {
    return this.enqueue(() => {
      const s = this.checkScope(scope);
      if (!s.ok) return s;
      if (revision > this.revision || revision < 0) return fail('invalid_request', `revision ${revision} does not exist in this session`);
      if (this.savedRevision === null || revision >= this.savedRevision) { this.savedRevision = revision; this.savedPath = path; }
      return ok(undefined);
    });
  }
}

/** Connectors whose routes settling needs: the ones other connectors are joined to and the ones shapes or text are attached to. */
function routesNeeded(doc: DiagramDocument): string[] {
  const ids = new Set<string>();
  for (const page of doc.pages) {
    const connectors = new Set(page.elements.filter(e => e.kind === 'connector').map(e => e.id));
    for (const e of page.elements) {
      if (e.kind === 'connector') for (const ep of [e.from, e.to]) { if (ep.join && connectors.has(ep.join.connectorId)) ids.add(ep.join.connectorId); }
      else if ((e.kind === 'shape' || e.kind === 'text') && e.attachment && connectors.has(e.attachment.connectorId)) ids.add(e.attachment.connectorId);
    }
  }
  return [...ids].sort();
}

const emptyPlan = (): { created: string[]; changed: string[]; deleted: string[]; changedPageIds: string[]; changedLayerIds: string[]; changedAssetIds: string[]; visuallyAffectedIds: string[]; routeChanges?: import('../contracts/generated').RouteChange[]; routeFindings?: import('../contracts/generated').RouteFinding[] } => ({
  created: [] as string[], changed: [] as string[], deleted: [] as string[], changedPageIds: [] as string[],
  changedLayerIds: [] as string[], changedAssetIds: [] as string[], visuallyAffectedIds: [] as string[],
});

/** Summarises a replayed diff (undo/redo) against the state it is applied to. */
function describeDiff(doc: DiagramDocument, diff: DiffBody): ReturnType<typeof emptyPlan> {
  const existing = new Set<string>();
  for (const p of doc.pages) for (const e of p.elements) existing.add(e.id);
  const plan = emptyPlan();
  for (const u of diff.upserts.elements) (existing.has(u.element.id) ? plan.changed : plan.created).push(u.element.id);
  plan.deleted.push(...diff.deletes.elementIds.filter(id => existing.has(id)));
  plan.changedAssetIds.push(...diff.upserts.assets.map(a => a.id), ...diff.deletes.assetIds);
  plan.changedPageIds.push(...diff.upserts.pages.map(p => p.page.id), ...diff.deletes.pageIds);
  plan.changedLayerIds.push(...diff.upserts.layers.map(l => l.layer.id), ...diff.deletes.layerIds);
  plan.visuallyAffectedIds.push(...plan.created, ...plan.changed);
  return plan;
}
