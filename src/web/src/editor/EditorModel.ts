import type { EditorExportOptions } from './EditorExportOptions';
import type { EditorPrintOptions, EditorPrintResponse, PrintDevice, PrintSheetPreview } from './EditorPrintOptions';
import { FileConflictFlow, type FileHost, type FileOutcome } from './FileConflictFlow';
import type { ExpectedDocument } from './NewDocumentFlow';
import { NewDocumentFlow } from './NewDocumentFlow';
import { componentWarningText } from '../layout/componentTemplates';
import type { ComponentProposal } from '../layout/components';
import type { DiagramDocument, Element, Operation, PreparedAssetRef, Scope, Snapshot, TransactionResult } from '../contracts/generated';
import { CommandEngine } from '../commands/CommandEngine';
import { copyElements, pasteOperations, type ClipboardData } from '../commands/clipboard';
import type { ClipboardDescriptor } from '../commands/clipboardPaste';
import { MaxGraphAdapter, DEFAULT_SCALE } from '../canvas/MaxGraphAdapter';
import type { GestureNotice, Tool, ViewportInfo } from '../canvas/CanvasAdapter';
import { GestureController, type GestureKind, type GestureToken } from '../canvas/GestureController';
import { createSnapshotProjector } from '../canvas/SnapshotProjector';
import { inspectLayout, type LayoutIssue } from '../layout/inspectLayout';
import { ROUTE_FINDING_CODES } from '../layout/inspectRoutes';
import { carriedLeaves, collapseToGroups, expandToGroups, leavesOfTargets, outermostTargets } from '../canvas/selection';
import { containerAncestors, containerParents, isContainer } from '../layout/containers';
import { parentMap } from '../commands/groups';
import { visualBounds, unionBounds } from '../commands/geometry';
import { deleteOperations, findElement, intentOperations, nudgeOperations, pageContaining, pageOf, type Intent } from '../canvas/intents';
import { fail, ok, type Result } from '../model/result';
import { canDeleteAsset, prepareDocumentAsset, imagesUsing, replaceEverywhere, replaceOneImage } from '../commands/assetVersions';
import { effectiveState } from '../canvas/cellMapping';
import { restoreRecovery, type RecoveryPayload } from '../commands/recovery';
import { drawScriptCompiler, validateScript, type ValidationReport } from '../script/compiler';
import { toPoints, type Unit } from '../model/validate';
import { FindReplaceFlow } from './FindReplaceFlow';
import { matchingSelection, findSelection } from './findReplace';
import { snapCreation } from '../canvas/guideSnapping';
import { connectable, navigableObjects, nearestIn, stepFrom, type Direction } from './objectNav';
import { iconOperations } from '../icons/catalog';
import type { AgentDocument } from '../bridge/engineHandlers';
import type { AboutInfo } from '../workspace/HelpState';

/** What the page needs from the host. In a plain browser (tests, dev) a stub stands in. */
export interface HostApi extends FileHost {
  editorExport(options: EditorExportOptions): Promise<Result<{cancelled?:true;path?:string;copied?:boolean;pages?:number}>>;
  editorPrint(action: 'devices'|'preview'|'print'|'savePdf', params?: Record<string, unknown>): Promise<Result<EditorPrintResponse>>;
  recentList(): Promise<Result<RecentList>>;
  recentRemove(id: string): Promise<Result<RecentList>>;
  recentClear(): Promise<Result<RecentList>>;
  pickImage(): Promise<Result<{ cancelled: true } | { ref: PreparedAssetRef; notes: string[]; width: number; height: number }>>;
  /** Without a path the person chooses a file; with one (from the last session's tabs) it is reopened without asking. */
  openJson(path?: string, recentId?: string, scope?: Scope): Promise<Result<{ cancelled?: true; path?: string; notes?: string[] }>>;
  openIngress(ticketId: string, expected: Scope & { baseRevision: number }): Promise<Result<{ path?: string; existingDocumentId?: string; warning?: string | null; summary?: string; diagnostics?: DiagnosticItem[]; lossy?: boolean; notes?: string[] }>>;
  importIngressImage(ticketId: string, scope: Scope): Promise<Result<{ asset: LibraryEntry; created: boolean; idWasTaken: boolean; notes: string[]; width: number; height: number }>>;
  clipboardDescribe(): Promise<Result<ClipboardDescriptor>>;
  markInternalCopy(copyId: string): Promise<Result<{ sequence: number }>>;
  importClipboardImage(expectedSequence: number, scope: Scope): Promise<Result<{ batchId: string; item: { ticketId: string; displayName: string; kind: 'image' } }>>;
  dismissIngress(ticketIds: string[]): Promise<Result<{ dismissed: number }>>;
  /** Records the open tabs so the next start can reopen them. */
  workspaceSave(tabs: Array<{ documentId: string; sessionId: string; title: string; unsaved: boolean }>, activeDocumentId: string | null): Promise<Result<{ saved: number }>>;
  /** What the last run left open. */
  workspaceLoad(): Promise<Result<WorkspaceMemory>>;
  saveJson(saveAs: boolean, expected?: ExpectedDocument): Promise<Result<FileOutcome>>;
  libraryList(query?: string, tags?: string[]): Promise<Result<{ assets: LibraryEntry[] }>>;
  libraryImport(): Promise<Result<{ cancelled?: true; asset?: LibraryEntry; created?: boolean; idWasTaken?: boolean; notes?: string[] }>>;
  /** Resolves a library picture to an approved preparation (optionally one specific version) a document can pin. */
  libraryUse(id: string, hash?: string): Promise<Result<{ ref: PreparedAssetRef; notes: string[]; width: number; height: number }>>;
  libraryReplaceSource(id: string): Promise<Result<{ cancelled?: true; asset?: LibraryEntry }>>;
  librarySetMetadata(id: string, patch: { name?: string; tags?: string[] }): Promise<Result<{ asset: LibraryEntry }>>;
  libraryDelete(id: string): Promise<Result<{ deleted: string }>>;
  recoveryStatus(): Promise<Result<{ lastDurableRevision: number; lastCommittedRevision: number; degraded: boolean; note?: string | null }>>;
  /** Every session that holds unsaved work, described well enough to tell them apart. */
  recoveryList(): Promise<Result<{ auto: boolean; sessions: RecoveryOffer[] }>>;
  recoveryFetch(sessionId: string): Promise<Result<RecoveryPayload & { loss: RecoveryLossInfo }>>;
  recoveryDiscard(sessionId: string): Promise<Result<{ discarded: string }>>;
  recoveryFinish(sessionId: string, originalPath: string | null): Promise<Result<{ finished: string }>>;
  /** The person answered the close prompt: close the window now (and let the unsaved work go when `discard`). */
  appClose(discard: boolean): Promise<Result<{ closing: true }>>;
  /** The person cancelled the close prompt: the window stays open and may ask again. */
  appCloseCancelled(): Promise<Result<{ cancelled: true }>>;
  appAbout(): Promise<Result<AboutInfo>>;
  /** With a recent id or a path named by the shell the file opens without asking; otherwise the person chooses. */
  openVsdx(recentId?: string, path?: string, scope?: Scope): Promise<Result<NativeOutcome>>;
  /** `path` repeats a choice the person already made when they agree to a lossy export. */
  exportVsdx(opts: { acceptLoss?: boolean; path?: string }): Promise<Result<NativeOutcome>>;
  /** Brings a document an agent made in the background into this window as a tab. */
  documentShow(documentId: string): Promise<Result<{ documentId: string; shown: boolean }>>;
  /** Throws a background document away. */
  documentDiscard(documentId: string): Promise<Result<{ discarded: string }>>;
  /** The documents agents have open in the background. */
  agentDocuments(): Promise<Result<{ documents: AgentDocument[] }>>;
  /** Shows a document's file in Explorer. */
  documentReveal(documentId: string): Promise<Result<{ revealed: string }>>;
  /** Puts a document's file path on the clipboard. */
  documentCopyPath(documentId: string): Promise<Result<{ copied: string }>>;
}

export interface RecentEntry { id: string; path: string; kind: 'json' | 'vsdx'; availability: 'available' | 'missing' | 'unavailable' }
export interface RecentList { entries: RecentEntry[]; warning?: string | null }
export interface LibraryEntry { id: string; name: string; tags: string[]; mimeType: string; sha256: string; width: number; height: number; version: number; scope: 'library' }
export type WorkspaceMemory = { found: false } | { found: true; cleanExit: boolean; activeDocumentId: string | null; tabs: Array<{ documentId: string; sessionId: string; path: string | null; title: string | null; unsaved: boolean }> };
export interface RecoveryLossInfo { tornTailDiscarded: boolean; corruptionAfterRevision: number | null; messages: string[] }
/** Unfinished work from an earlier run (or before a renderer crash), as the host describes it. */
/** One unfinished session as the host describes it. Sizes are as of the session's last checkpoint. */
export interface RecoveryOffer { sessionId: string; documentId: string; title: string | null; originalPath: string | null; pageCount: number; objectCount: number; checkpointRevision: number; lastDurableRevision: number; lastWrite: string; loss: RecoveryLossInfo; restoredEarlier?: boolean; unchangedSinceRestore?: boolean }
export interface DiagnosticItem { severity: 'info' | 'warning' | 'error'; code: string; message: string; elementId?: string; pageId?: string; action?: string }
export interface NativeOutcome { warning?: string | null; cancelled?: true; path?: string; summary?: string; diagnostics?: DiagnosticItem[]; lossy?: boolean; revision?: number; bytes?: number }

/** What a person is shown about a Visio file: what came across and what did not, with an optional action (export anyway). */
export interface CompatibilityView { title: string; summary: string; diagnostics: DiagnosticItem[]; confirm?: { label: string; run: () => void } }

export const noHost: HostApi = {
  editorExport: async () => fail('not_running', 'there is no host to export images'),
  editorPrint: async () => fail('not_running', 'Print preview requires the desktop app'),
  recentList: async () => fail('not_running', 'Recent files require the desktop app'),
  recentRemove: async () => fail('not_running', 'Recent files require the desktop app'),
  recentClear: async () => fail('not_running', 'Recent files require the desktop app'),
  recoveryStatus: async () => fail('not_running', 'there is no host'),
  recoveryList: async () => ok({ auto: false, sessions: [] }),
  recoveryFetch: async () => fail('not_running', 'there is no host'),
  recoveryDiscard: async () => fail('not_running', 'there is no host'),
  recoveryFinish: async () => fail('not_running', 'there is no host'),
  appClose: async () => fail('not_running', 'there is no host'),
  appCloseCancelled: async () => fail('not_running', 'there is no host'),
  appAbout: async () => fail('not_running', 'there is no host to report its version'),
  libraryList: async () => fail('not_running', 'there is no host to read the picture library'),
  libraryImport: async () => fail('not_running', 'there is no host to add pictures'),
  libraryUse: async () => fail('not_running', 'there is no host to read the picture library'),
  libraryReplaceSource: async () => fail('not_running', 'there is no host to add pictures'),
  librarySetMetadata: async () => fail('not_running', 'there is no host to change the picture library'),
  libraryDelete: async () => fail('not_running', 'there is no host to change the picture library'),
  openVsdx: async () => fail('not_running', 'there is no host to open files'),
  exportVsdx: async () => fail('not_running', 'there is no host to save files'),
  pickImage: async () => fail('not_running', 'there is no host to choose a picture'),
  openJson: async () => fail('not_running', 'there is no host to open files'),
  openIngress: async () => fail('not_running', 'there is no host to open files'),
  importIngressImage: async () => fail('not_running', 'there is no host to import a dropped picture'),
  clipboardDescribe: async () => fail('not_running', 'there is no host clipboard'),
  markInternalCopy: async () => fail('not_running', 'there is no host clipboard'),
  importClipboardImage: async () => fail('not_running', 'there is no host clipboard'),
  dismissIngress: async () => fail('not_running', 'there is no host to dismiss pending files'),
  workspaceSave: async () => fail('not_running', 'there is no host'),
  documentShow: async () => fail('not_running', 'there is no host'),
  documentDiscard: async () => fail('not_running', 'there is no host'),
  agentDocuments: async () => ok({ documents: [] }),
  documentReveal: async () => fail('not_running', 'there is no host'),
  documentCopyPath: async () => fail('not_running', 'there is no host'),
  workspaceLoad: async () => ok({ found: false }),
  fileCheck: async () => ok({ unchanged: true }),
  fileResolve: async () => fail('not_running', 'there is no host'),
  saveJson: async () => fail('not_running', 'there is no host to save files'),
};

const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  rectangle: { w: 120, h: 72 }, 'rounded-rectangle': { w: 120, h: 72 }, ellipse: { w: 96, h: 72 }, diamond: { w: 96, h: 72 }, triangle: { w: 90, h: 80 },
  hexagon: { w: 108, h: 72 }, terminator: { w: 120, h: 48 }, 'stored-data': { w: 108, h: 60 }, document: { w: 108, h: 72 }, 'lined-document': { w: 108, h: 72 }, parallelogram: { w: 120, h: 60 }, cylinder: { w: 72, h: 96 }, cloud: { w: 120, h: 80 }, callout: { w: 120, h: 80 },
};

const sharedClipboard: { data: ClipboardData | null; copyId: string | null; marking: Promise<Result<{ sequence: number }>> | null } = { data: null, copyId: null, marking: null };

export type ScriptReport =
  | ({ ok: true; source: string } & ValidationReport)
  | { ok: false; source: string; revision: number; message: string; line?: number; column?: number; hint?: string };
export type ScriptOutcome =
  | { ok: true; transactionId: string; revision: number; created: string[]; changed: string[]; deleted: string[]; noChange: boolean; warnings: string[] }
  | { ok: false; message: string; code: string; line?: number; column?: number; hint?: string };

export interface Status { text: string; kind: 'info' | 'warning' | 'error' }

/**
 * The editor's non-React core. Every document change goes through GestureController or CommandEngine; the canvas only emits intents.
 * `version` changes whenever anything the UI shows may have changed (React subscribes through `subscribe`/`getVersion`).
 */
export class EditorModel {
  exportPrompt: {options:EditorExportOptions;busy:boolean;error?:string}|null=null;
  printPrompt: {options:EditorPrintOptions;devices:PrintDevice[];jobId:string|null;sheets:PrintSheetPreview[];marginWarnings:string[];busy:boolean;loadingDevices:boolean;error:string|null}|null=null;
  beginPrint(): void {
    if (this.printPrompt) return;
    this.printPrompt = { options: { expected: { ...this.engine.scope(), baseRevision: this.engine.revision }, pageRange: '1', printerId: '', mediaId: '', orientation: 'portrait', layout: 'fit', margins: { leftPt: 36, topPt: 36, rightPt: 36, bottomPt: 36 } }, devices: [], jobId: null, sheets: [], marginWarnings: [], busy: false, loadingDevices: true, error: null };
    const prompt = this.printPrompt;
    this.bump();
    void (async () => {
      const result = await this.host.editorPrint('devices');
      if (this.printPrompt !== prompt) return;
      prompt.loadingDevices = false;
      if (!result.ok) prompt.error = result.error.message;
      else {
        prompt.devices = result.value.devices ?? [];
        const device = prompt.devices[0], media = device?.media[0];
        if (device && media) { prompt.options.printerId = device.id; prompt.options.mediaId = media.id; }
        else prompt.error = 'No printers with supported paper sizes are available.';
      }
      this.bump();
    })().catch(error => { if (this.printPrompt === prompt) { prompt.loadingDevices = false; prompt.error = String(error); this.bump(); } });
  }
  cancelPrint(): void { if (!this.printPrompt?.busy) { this.printPrompt = null; this.bump(); } }
  changePrintOptions(patch: Partial<Omit<EditorPrintOptions, 'expected'>>): void {
    const prompt = this.printPrompt;
    if (!prompt || prompt.busy) return;
    prompt.options = { ...prompt.options, ...patch };
    prompt.jobId = null; prompt.sheets = []; prompt.marginWarnings = []; prompt.error = null;
    this.bump();
  }
  private printStateCurrent(prompt: NonNullable<EditorModel['printPrompt']>): boolean {
    const scope = this.engine.scope();
    if (scope.documentId === prompt.options.expected.documentId && scope.sessionId === prompt.options.expected.sessionId && this.engine.revision === prompt.options.expected.baseRevision) return true;
    prompt.jobId = null; prompt.sheets = []; prompt.error = 'The drawing changed while Print preview was open. Close it and open a fresh preview.'; this.bump(); return false;
  }
  async preparePrint(): Promise<void> {
    const prompt = this.printPrompt;
    if (!prompt || prompt.busy || !prompt.options.printerId || !prompt.options.mediaId || !this.printStateCurrent(prompt)) return;
    prompt.busy = true; prompt.error = null; prompt.jobId = null; prompt.sheets = []; prompt.marginWarnings = []; this.bump();
    try {
      const result = await this.host.editorPrint('preview', structuredClone(prompt.options) as unknown as Record<string, unknown>);
      if (this.printPrompt !== prompt) return;
      if (!result.ok) { prompt.error = result.error.message; return; }
      if (!result.value.jobId || !result.value.sheets?.length) { prompt.error = 'The host did not return a prepared print preview.'; return; }
      prompt.jobId = result.value.jobId; prompt.sheets = result.value.sheets; prompt.marginWarnings = result.value.marginWarnings ?? [];
    } catch (error) { prompt.error = String(error); }
    finally { if (this.printPrompt === prompt) { prompt.busy = false; this.bump(); } }
  }
  async finishPrint(action: 'print'|'savePdf'): Promise<void> {
    const prompt = this.printPrompt;
    if (!prompt || prompt.busy || !prompt.jobId || !this.printStateCurrent(prompt)) return;
    prompt.busy = true; prompt.error = null; this.bump();
    try {
      const result = await this.host.editorPrint(action, { jobId: prompt.jobId });
      if (this.printPrompt !== prompt) return;
      if (!result.ok) { prompt.error = result.error.message; prompt.jobId = null; prompt.sheets = []; return; }
      if (result.value.cancelled) { prompt.error = 'Save was cancelled. Prepare the preview again before output.'; prompt.jobId = null; prompt.sheets = []; return; }
      this.printPrompt = null;
      this.say(action === 'print' ? 'Print job sent' : `Saved print-layout PDF to ${result.value.path ?? ''}`, 'info');
    } catch (error) { prompt.error = String(error); prompt.jobId = null; prompt.sheets = []; }
    finally { if (this.printPrompt === prompt) { prompt.busy = false; this.bump(); } }
  }
  beginImageExport(format: 'png'|'pdf'='png'):void {
    this.exportPrompt={busy:false,options:{expected:{...this.engine.scope(),baseRevision:this.engine.revision},format,scope:format==='pdf'?'all':'page',pageId:this.currentPage.id,elementIds:[...this.selection],scale:1,background:'page'}};
    this.bump();
  }
  cancelImageExport():void { if(!this.exportPrompt?.busy){this.exportPrompt=null;this.bump();} }
  async finishImageExport(copy=false):Promise<void> {
    if(copy){if(!this.selection.length)return;this.beginImageExport();this.exportPrompt!.options={...this.exportPrompt!.options,scope:'selection',format:'png',background:'transparent',copy:true};}
    const p=this.exportPrompt;if(!p||p.busy)return;p.busy=true;p.error=undefined;this.bump();
    try {
      const r=await this.host.editorExport(structuredClone(p.options));
      if(!r.ok){p.error=r.error.message;this.say(r.error.message,'error');return;}
      this.exportPrompt=null;
      if(!r.value.cancelled)this.say(r.value.copied?'Copied selection as image':`Exported ${r.value.pages??1} page(s) to ${r.value.path??''}`,'info');
    } catch(e){p.error=String(e);this.say(String(e),'error');}
    finally{p.busy=false;this.bump();}
  }
  readonly engine: CommandEngine;
  readonly newDocument: NewDocumentFlow;
  readonly controller: GestureController;
  readonly find: FindReplaceFlow;
  private adapter: MaxGraphAdapter | null = null;
  private readonly projector = createSnapshotProjector((snapshot, assetId) => this.assetUrlIn(snapshot, assetId));
  private listeners = new Set<() => void>();
  private version = 0;
  /** Copy in one tab, paste in another: the clipboard belongs to the window, not the document. */
  private get clipboard(): ClipboardData | null { return sharedClipboard.data; }
  private set clipboard(v: ClipboardData | null) { sharedClipboard.data = v; }
  get internalCopyId(): string | null { return sharedClipboard.copyId; }
  get hasInternalCopy(): boolean { return this.clipboard !== null; }
  async waitForInternalCopyMarker(): Promise<void> { if (sharedClipboard.marking) await sharedClipboard.marking; }
  /** Stable for the life of the tab (the document id changes when a file is opened into it). */
  readonly tabId = crypto.randomUUID();
  /** The number in "Untitled N", given when the tab is made. */
  untitledNo = 1;
  private savedView: { scale: number; scrollLeft: number; scrollTop: number } | null = null;
  private pastes = 0;

  /** The script and transaction drawer. */
  drawerOpen = false;
  drawerTab: 'script' | 'transactions' = 'script';
  scriptText = '';
  scriptReport: ScriptReport | null = null;
  scriptOutcome: ScriptOutcome | null = null;
  /** What each script transaction ran, so the transaction drawer can show its source. */
  readonly scriptSources = new Map<string, string>();

  host: HostApi = noHost;
  /** Workspace installs the shared host-aware paste route used by menu and keyboard actions. */
  pasteFromClipboard: () => Promise<void> = () => this.paste();
  readonly files: FileConflictFlow;
  /** The compatibility report dialog, when one is showing. */
  report: CompatibilityView | null = null;
  /** Unfinished work found at start, waiting for the person's answer. */
  /** The unfinished sessions on offer; the dialog lists them, each with its own Recover and Discard. */
  recoveryOffers: RecoveryOffer[] = [];
  /** Thumbnails of the offered sessions, by session id: undefined while loading, null when one could not be made. */
  offerPreviews = new Map<string, string | null>();
  /** Pages and objects of each offered session as rebuilt (checkpoint plus journal), which the host's summary cannot know. */
  offerStats = new Map<string, { pages: number; objects: number }>();
  /** Draws a recovered document's first page as a data URL (set by the page, which owns the renderer). */
  renderPreview: ((doc: DiagramDocument) => Promise<string | null>) | null = null;
  /** When this window last saved or opened a file (for the status bar). */
  lastSavedAt: Date | null = null;
  /** Set while the host's close request waits for the person: Save, Don't save or Cancel. */
  closePrompt: { fileName: string | null; saving: boolean; error: string | null; mode: 'window' | 'tab'; count: number } | null = null;
  /** What a recovery brought back and what it could not, shown after restoring. */
  recoveryReport: { title: string; lines: string[]; saveAs?: boolean } | null = null;
  /** Newest revision the host has on disk (the editor's own revision runs ahead of this by whatever is still being written). */
  protectedRevision: number | null = null;
  /** The revision the editor was at when recovery was offered: restoring replaces the document only if nothing was done since. */
  private recoveryBaseRevision = 0;
  protectionNote: string | null = null;
  /** Called after a restore replaced the document, so the host learns the new session. */
  afterRecoveryRestore: () => void = () => {};
  /** The recovery session the document now showing was rebuilt from. Announced with the new session so the host can write it down before anything else; read once. */
  restoredFromSession: string | null = null;
  takeRestoredFrom(): string | null { const id = this.restoredFromSession; this.restoredFromSession = null; return id; }
  private protectionTimer: ReturnType<typeof setTimeout> | null = null;
  selection: string[] = [];
  tool: Tool = { kind: 'select' };
  iconSettings = { sizePt: 24, colour: '#334155', strokeWidthPt: 2 };
  unit: Unit = 'mm';
  status: Status = { text: 'Ready', kind: 'info' };
  viewport: ViewportInfo | null = null;
  showGuides = true;
  snapToGuides = true;
  toggleGuides(field: 'showGuides' | 'snapToGuides'): void { this[field] = !this[field]; this.bump(); }
  /** R26: the route diagnostics overlay. Off by default; it only draws, it never changes the document. */
  showRouteDiagnostics = false;
  toggleRouteDiagnostics(): void { this.showRouteDiagnostics = !this.showRouteDiagnostics; this.bump(); }
  private diagnosed: { key: string; issues: LayoutIssue[] } | null = null;
  /** R26: the routing findings for the page on screen, judged on the routes this canvas draws. A pure read, cached per revision and page. */
  routeDiagnostics(): LayoutIssue[] {
    if (!this.adapter) return [];
    const key = `${this.snapshot.revision}|${this.currentPage.id}`;
    if (this.diagnosed?.key === key) return this.diagnosed.issues;
    const projection = this.adapter.readProjection(this.snapshot, this.currentPage.id);
    const codes = new Set<string>(ROUTE_FINDING_CODES);
    // routing findings do not measure text, so a rough width is enough here
    const issues = inspectLayout(this.snapshot, { measureWidth: (t, f) => t.length * f.sizePt * 0.5, projection }, { pageId: this.currentPage.id }).issues.filter(i => codes.has(i.code));
    this.diagnosed = { key, issues };
    return issues;
  }
  /** Called when the interlock should hold agent mutations (I30 wires this to the admission gate). */
  onGestureState: (active: boolean) => void = () => {};

  constructor(engine: CommandEngine) {
    this.engine = engine;
    this.controller = new GestureController(engine);
    this.find = new FindReplaceFlow(engine, () => this.bump(), hit => {
      this.setCurrentPage(hit.pageId);
      if(hit.hidden){this.find.message='This result is hidden; it was not unhidden or selected.';return;}
      const ids=findSelection(this.currentPage,hit.id);
      this.selection=ids;this.canvas?.setSelection(ids);
      queueMicrotask(()=>this.adapter?.reveal(ids[0]??hit.id));
    });
    this.find.canStart=()=>!this.controller.isActive()&&!this.closePrompt&&!this.files?.prompt&&!this.newDocument?.prompt&&!this.report&&!this.recoveryOffers.length&&!this.recoveryReport;
    this.newDocument = new NewDocumentFlow(engine, () => this.bump());
    this.files = new FileConflictFlow(engine, () => this.host, () => this.bump());
  this.files.canPresent = () => !this.exportPrompt && !this.printPrompt && !this.controller.isActive() && !this.closePrompt && !this.newDocument.prompt && !this.recoveryOffers.length && !this.recoveryReport;
    this.files.message = (text,error) => this.say(text,error?'error':'warning');
    this.files.completed = outcome => {
      if(outcome.reloaded){this.pageId=undefined;this.selection=[];this.tool={kind:'select'};this.sessionReplaced();this.zoomToFit();}
      else this.lastSavedAt=new Date();
      this.say(outcome.warning ?? (outcome.reloaded?'Reloaded the disk version.':('Saved '+(outcome.path??'')+'.')),outcome.warning?'warning':'info');
    };
    this.newDocument.canStart = () => !this.controller.isActive() && !this.closePrompt && !this.recoveryOffers.length;
    this.newDocument.save = () => this.save();
    this.newDocument.create = async (document, expected) => {
      const r = await this.engine.replaceDocument(document, expected);
      if (r.ok) this.afterRecoveryRestore();
      return r;
    };
    this.newDocument.created = result => {
      this.pageId = undefined; this.selection = []; this.tool = { kind: 'select' };
      this.lastSavedAt = null; this.protectedRevision = null; this.protectionNote = null;
      this.report = null; this.recoveryReport = null; this.scriptReport = null; this.scriptOutcome = null; this.scriptSources.clear();
      this.sessionReplaced(); this.canvas?.setTool(this.tool); this.zoomToFit();
      const warning = (result as { recoveryWarning?: string } | null)?.recoveryWarning;
      this.say(warning ?? 'Created a new untitled drawing. Save it to keep it.', warning ? 'warning' : 'info');
    };
    this.controller.onGestureState = a => this.onGestureState(a);
    this.controller.onDiscard = reason => {
      this.showCommitted(); // show committed state again
      if (reason) this.say(reason, 'warning');
      this.bump();
    };
    engine.setProjector(snapshot => this.adapter ? this.adapter.project(snapshot, this.pageId) : ok(undefined));
    engine.setSnapshotProjector(this.projector.project);
    engine.onCommitted(() => { this.pruneSelection(); this.syncGroupFrames(); this.scheduleProtectionRead(); this.bump(); });
  }

  // ------------------------------------------------------------------ React subscription
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;
  bump(): void { this.version++; for (const l of this.listeners) l(); }
  say(text: string, kind: Status['kind'] = 'info'): void { this.status = { text, kind }; this.bump(); }

  get snapshot(): Snapshot { return this.engine.store.snapshot(); }
  /** The page being edited. A page that was deleted (or never existed) falls back to the first. */
  pageId: string | undefined;
  get currentPage() { return pageOf(this.snapshot, this.pageId); }
  /** What the user has selected, with every complete group standing for its members. The canvas itself only ever holds the members. */
  get targets(): string[] { return [...this.collapsed().ids]; }
  selectedElements(): Element[] { return [...this.collapsed().elements]; }
  /** Several panels ask for this on every render; the answer only changes with the document or the selection, so it is kept until one of them does. */
  private collapsedFor?: { document: Snapshot['document']; selection: string[]; ids: string[]; elements: Element[] };
  private collapsed(): { ids: string[]; elements: Element[] } {
    const snapshot = this.snapshot, hit = this.collapsedFor;
    if (hit && hit.document === snapshot.document && hit.selection === this.selection) return hit;
    const ids = collapseToGroups(snapshot, this.selection);
    const elements = ids.map(id => findElement(snapshot, id)).filter((e): e is Element => !!e);
    const fresh = { document: snapshot.document, selection: this.selection, ids, elements };
    this.collapsedFor = fresh;
    return fresh;
  }

  /** Picking a member of a group picks the whole group, unless Ctrl was held to reach into it. */
  private handleSelection(ids: string[], subSelect: boolean): void {
    const next = subSelect ? ids : expandToGroups(this.snapshot, ids);
    if (next.length !== ids.length || next.some((id, i) => id !== ids[i])) this.adapter?.setSelection(next);
    this.selection = next;
    this.syncGroupFrames();
    this.bump();
  }

  private syncGroupFrames(): void {
    const frames = this.selectedElements().filter(e => e.kind === 'group').map(e => e.bounds);
    this.adapter?.setGroupFrames(frames);
  }

  assetUrlIn(snapshot: Snapshot, assetId: string): string {
    const a = snapshot.document.assets.find(x => x.id === assetId);
    return a ? `/assets/${a.sha256}` : '';
  }

  // ------------------------------------------------------------------ canvas lifecycle
  attachCanvas(container: HTMLElement): MaxGraphAdapter {
    this.adapter?.dispose();
    this.adapter = new MaxGraphAdapter(container, {
      onIntent: i => void this.handleIntent(i),
      onSelection: (ids, info) => this.handleSelection(ids, info?.subSelect ?? false),
      onGesture: n => this.handleGesture(n),
      onViewport: v => { this.viewport = v; this.syncGroupFrames(); this.bump(); },
      onPlace: (what, at) => void this.place(what, at),
    }, id => this.assetUrlIn(this.snapshot, id));
    this.adapter.project(this.snapshot, this.pageId);
    this.adapter.setTool(this.tool);
    if (this.selection.length) this.adapter.setSelection(this.selection);
    const view = this.savedView;
    queueMicrotask(() => {
      if (!this.adapter) return;
      if (!view) { this.adapter.zoomToFit(); return; }
      this.adapter.setZoom(view.scale); // coming back to a tab: the zoom and place it was left at
      container.scrollLeft = view.scrollLeft; container.scrollTop = view.scrollTop;
    });
    return this.adapter;
  }

  detachCanvas(): void {
    if (this.adapter) { const v = this.adapter.getViewport(); this.savedView = { scale: v.scale, scrollLeft: v.scrollLeft, scrollTop: v.scrollTop }; }
    this.adapter?.dispose(); this.adapter = null;
  }
  get canvas(): MaxGraphAdapter | null { return this.adapter; }

  // ------------------------------------------------------------------ gestures and intents
  private handleGesture(n: GestureNotice): void {
    if (n.phase === 'begin') this.controller.begin(n.kind, this.engine.scope(), n.ids);
    // Commit and cancel are driven by the intent (which carries the operations) or by cancel below.
    else if (n.phase === 'cancel' && this.controller.active) this.controller.cancel(this.controller.active);
  }

  /** The canvas reported a finished edit. Plan it from the committed snapshot the gesture began with, then commit once. */
  async handleIntent(intent: Intent): Promise<void> {
    let token = this.controller.active;
    if (token && !gestureMatches(token.kind, intent)) token = null;
    const oneShot = !token;
    if (!token) token = this.controller.begin(intent.type === 'connect' ? 'create' : 'inspector', this.engine.scope(), []);
    const operations = intentOperations(token.startSnapshot, intent, { enabled: this.showGuides && this.snapToGuides, scale: this.viewport?.scale ?? 1 });
    const planned = this.controller.preview(token, operations);
    if (!planned.ok) { this.controller.cancel(token); this.say(planned.error.message, 'warning'); return; }
    const r = await this.controller.commit(token);
    if (!r.ok) { if (r.error.code !== 'revision_conflict') this.say(r.error.message, 'warning'); return; }
    if (r.value.noChange) this.showCommitted(); // a snapped-back drag changes nothing: redraw committed state
    if (oneShot && intent.type === 'connect') this.setTool({ kind: 'select' });
  }

  /** Runs operations as one GUI transaction (inspector, nudge, paste, create, delete). */
  async apply(kind: GestureKind, operations: Operation[]): Promise<Result<TransactionResult>> {
    if (!operations.length) return fail('invalid_request', 'nothing to do');
    const token: GestureToken = this.controller.begin(kind, this.engine.scope(), []);
    const planned = this.controller.preview(token, operations);
    if (!planned.ok) { this.controller.cancel(token); this.say(planned.error.message, 'warning'); return planned; }
    const r = await this.controller.commit(token);
    if (!r.ok && r.error.code !== 'revision_conflict') this.say(r.error.message, 'warning');
    return r;
  }

  // ------------------------------------------------------------------ commands
  setTool(tool: Tool): void {
    this.tool = tool;
    this.adapter?.setTool(tool);
    this.status = tool.kind === 'place' ? { text: 'Click on the page to place the shape. Esc cancels.', kind: 'info' }
      : tool.kind === 'connector' ? { text: 'Drag from one shape to another to connect them.', kind: 'info' } : { text: 'Ready', kind: 'info' };
    this.bump();
  }

  proposeComponent: (params: Record<string, unknown>) => Promise<Result<ComponentProposal & { base64: string; mimeType: string }>> = async () => fail('not_ready', 'Component preview is unavailable');

  async applyComponent(proposal: ComponentProposal): Promise<boolean> {
    const snapshot = this.snapshot;
    if (snapshot.documentId !== proposal.documentId || snapshot.sessionId !== proposal.sessionId || snapshot.revision !== proposal.baseRevision) {
      this.say('The document changed. Preview the component again before applying it.', 'warning'); return false;
    }
    const result = await this.apply('create', proposal.operations);
    if (!result.ok) return false;
    this.handleSelection([proposal.groupId], false);
    this.canvas?.setSelection(this.selection);
    this.say(proposal.warnings.length ? proposal.warnings.map(componentWarningText).join(' ') : 'Component applied as one undo step.', 'info');
    return true;
  }

  async place(what: string, at: { x: number; y: number }): Promise<void> {
    const page = this.currentPage;
    if (what.startsWith('icon:')) {
      const prepared = iconOperations({ ...this.iconSettings, iconId: what.slice(5), pageId: page.id,
        x: at.x - this.iconSettings.sizePt / 2, y: at.y - this.iconSettings.sizePt / 2 });
      if (!prepared.ok) { this.say(prepared.error.message, 'error'); return; }
      const r = await this.apply('create', prepared.value.operations.map(op => snapCreation(op,page,{enabled:this.showGuides && this.snapToGuides,scale:this.viewport?.scale??1,preserveSize:true})));
      this.setTool({ kind: 'select' });
      if (r.ok) { this.selection = [prepared.value.elementId]; this.canvas?.setSelection(this.selection); this.bump(); }
      return;
    }
    let op: Operation;
    if (what === 'text') {
      op = { op: 'createText', bounds: { x: at.x - 60, y: at.y - 15, width: 120, height: 30 }, text: { value: 'Text', horizontalAlign: 'left' } };
    } else {
      const size = DEFAULT_SIZE[what] ?? DEFAULT_SIZE.rectangle!;
      op = { op: 'createShape', bounds: { x: at.x - size.w / 2, y: at.y - size.h / 2, width: size.w, height: size.h }, geometry: { preset: what as 'rectangle' } };
    }
    const snapped = snapCreation(op, page, {enabled:this.showGuides && this.snapToGuides,scale:this.viewport?.scale??1});
    const r = await this.apply('create', [snapped]);
    this.setTool({ kind: 'select' });
    if (r.ok && r.value.created[0]) this.canvas?.setSelection([r.value.created[0]]), this.selection = [r.value.created[0]], this.bump();
  }

  async insertPicture(): Promise<void> {
    const picked = await this.host.pickImage();
    if (!picked.ok) { this.say(picked.error.message, 'warning'); return; }
    if ('cancelled' in picked.value) return;
    const { ref, notes, width, height } = picked.value;
    const page = this.currentPage;
    const maxW = page.widthPt / 2, maxH = page.heightPt / 2;
    const natW = toPoints(width, 'px'), natH = toPoints(height, 'px');
    const k = Math.min(1, maxW / natW, maxH / natH);
    const w = natW * k, h = natH * k;
    const exists = this.snapshot.document.assets.some(a => a.id === ref.asset.id);
    const ops: Operation[] = [];
    if (!exists) ops.push({ op: 'registerAsset', asset: ref.asset });
    ops.push({ op: 'createImage', assetId: ref.asset.id, name: ref.asset.name, bounds: { x: (page.widthPt - w) / 2, y: (page.heightPt - h) / 2, width: w, height: h }, fit: 'contain', preserveAspectRatio: true });
    const r = await this.apply('create', ops);
    if (r.ok && notes.length) this.say(`Picture inserted. ${notes.join('; ')}`, 'info');
    if (r.ok && r.value.created[0]) { this.selection = [r.value.created[0]]; this.canvas?.setSelection(this.selection); this.bump(); }
  }

  async undo(): Promise<void> {
    const r = await this.engine.undo({ ...this.engine.scope(), transactionId: crypto.randomUUID(), baseRevision: this.engine.revision });
    if (!r.ok) this.say(r.error.code === 'history_unavailable' ? 'Nothing to undo.' : r.error.message, 'info');
  }

  async redo(): Promise<void> {
    const r = await this.engine.redo({ ...this.engine.scope(), transactionId: crypto.randomUUID(), baseRevision: this.engine.revision });
    if (!r.ok) this.say(r.error.code === 'history_unavailable' ? 'Nothing to redo.' : r.error.message, 'info');
  }

  async deleteSelection(): Promise<void> { await this.apply('inspector', deleteOperations(this.snapshot, this.selection)); this.selection = []; this.bump(); }

  copy(): void {
    const clip = copyElements(this.snapshot, this.selection);
    if (!clip) { this.say('Select something to copy.', 'info'); return; }
    this.clipboard = clip;
    const copyId = crypto.randomUUID();
    sharedClipboard.copyId = copyId;
    sharedClipboard.marking = this.host.markInternalCopy(copyId);
    void sharedClipboard.marking.then(result => {
      if (!result.ok) this.say('The internal copy is ready in memory, but the system clipboard could not be marked.', 'info');
    });
    this.pastes = 0;
    this.say(`Copied ${clip.elements.length} object${clip.elements.length === 1 ? '' : 's'}.`, 'info');
  }

  async paste(): Promise<void> {
    if (!this.clipboard) { this.say('Nothing to paste.', 'info'); return; }
    this.pastes++;
    const page = this.currentPage;
    const target = this.clipboard.pageId === page.id ? page : page;
    const { operations, newIds } = pasteOperations(this.clipboard, target, 14.1732283465 * this.pastes, () => crypto.randomUUID());
    const r = await this.apply('paste', operations);
    if (r.ok) { this.selection = newIds; this.canvas?.setSelection(newIds); this.bump(); }
  }

  /** Copies the selection in place of a clipboard round trip, so groups and the connectors between copied shapes keep their structure. */
  async duplicate(): Promise<void> {
    const targets = this.targets;
    if (!targets.length) { this.say('Select something to duplicate.', 'info'); return; }
    const snapshot = this.snapshot;
    const chosen = new Set(targets.flatMap(t => leavesOfTargets(snapshot, [t])));
    // A connector is copied only with both of its shapes, like a pasted selection; one left dangling would have to point at the original.
    const copyable = targets.filter(t => {
      const el = findElement(snapshot, t);
      return el && (el.kind !== 'connector' || [el.from, el.to].every(ep => ep.glue === 'none' || (ep.elementId && chosen.has(ep.elementId))));
    });
    if (!copyable.length) return;
    this.pastes++;
    const offset = 14.1732283465 * this.pastes;
    const before = new Set(this.currentPage.elements.map(e => e.id));
    const r = await this.apply('paste', [{ op: 'duplicate', targets: copyable, offset: { xPt: offset, yPt: offset }, keepAliases: true }]);
    if (!r.ok) return;
    const created = r.value.created.filter(id => !before.has(id));
    const leaves = leavesOfTargets(this.snapshot, created.filter(id => findElement(this.snapshot, id)?.kind !== 'group'));
    this.selection = [...new Set(leaves)];
    this.canvas?.setSelection(this.selection);
    this.bump();
  }

  // ------------------------------------------------------------------ script and transaction drawer
  toggleDrawer(tab?: 'script' | 'transactions'): void {
    if (tab) { this.drawerTab = tab; this.drawerOpen = true; } else this.drawerOpen = !this.drawerOpen;
    this.bump();
  }

  private scriptContext() {
    return { snapshot: this.snapshot, newUuid: () => crypto.randomUUID(), pageId: this.currentPage.id };
  }

  /** Compiles and plans against the current revision without committing anything. */
  validateScriptText(): void {
    const source = this.scriptText;
    const snapshot = this.snapshot;
    const r = validateScript(source, this.scriptContext());
    this.scriptOutcome = null;
    if (r.ok) {
      const { compiled: _compiled, ...report } = r.value;
      this.scriptReport = { ok: true, source, ...report };
    } else {
      this.scriptReport = { ok: false, source, revision: snapshot.revision, message: r.error.message, ...diagnosticOf(r.error.details), };
    }
    this.bump();
  }

  /** Runs the script as one atomic transaction. If it was validated and the document has moved on since, the engine refuses it rather than guess. */
  async runScriptText(): Promise<void> {
    const source = this.scriptText;
    const validated = this.scriptReport?.ok && this.scriptReport.source === source ? this.scriptReport.revision : null;
    const transactionId = crypto.randomUUID();
    const r = await this.engine.executeScript({
      ...this.engine.scope(), transactionId, baseRevision: validated ?? this.engine.revision, pageId: this.currentPage.id, atomic: true, script: source,
    }, drawScriptCompiler);
    if (r.ok) {
      this.scriptSources.set(transactionId, source);
      this.scriptOutcome = { ok: true, transactionId, revision: r.value.revision, created: r.value.created, changed: r.value.changed, deleted: r.value.deleted, noChange: r.value.noChange, warnings: r.value.warnings.map(w => w.message) };
      this.scriptReport = null;
      if (r.value.noChange) this.say('The script changed nothing.', 'info');
      else this.say(`Script ran as revision ${r.value.revision}.`, 'info');
    } else {
      const stale = r.error.code === 'revision_conflict';
      this.scriptOutcome = {
        ok: false, code: r.error.code,
        message: stale ? `The document changed after you validated (now at revision ${this.engine.revision}). Validate again, then run.` : r.error.message,
        ...diagnosticOf(r.error.details),
      };
    }
    this.bump();
  }

  // ------------------------------------------------------------------ groups, arrangement, stacking
  /** Runs one structural operation on the current targets as a single transaction and keeps the members selected. */
  private async arrangeWith(build: (targets: string[]) => Operation, minimum: number, what: string): Promise<Result<TransactionResult> | null> {
    const targets = outermostTargets(this.snapshot, this.targets); // R17: what is inside a selected container moves with it
    if (targets.length < minimum) { this.say(`Select at least ${minimum} object${minimum === 1 ? '' : 's'} to ${what}.`, 'info'); return null; }
    const r = await this.apply('arrange', [build(targets)]);
    if (r.ok) this.canvas?.setSelection(this.selection);
    return r;
  }

  async group(): Promise<void> {
    // R17: a container is grouped with everything inside it, since a container and its members share a group
    const r = await this.arrangeWith(targets => ({ op: 'group', targets: [...targets, ...this.withContents(targets).filter(id => !targets.includes(id))] }), 2, 'group');
    if (r?.ok) this.say('Grouped.', 'info');
  }

  // ------------------------------------------------------------------ containers (R17)
  /** The top-level objects inside the given containers, at every depth (a member inside a group is counted by its group). */
  private withContents(targets: readonly string[]): string[] {
    const groups = parentMap(this.currentPage.elements);
    const top = (id: string) => { let x = id; for (let p = groups.get(x); p !== undefined; p = groups.get(p)) x = p; return x; };
    return [...new Set(carriedLeaves(this.snapshot, targets).map(top))];
  }

  /** Selected containers, the other selected objects, and the selected objects that are in a container. */
  get containerSelection(): { containers: Element[]; others: string[]; members: string[] } {
    const targets = this.targets;
    const containers = targets.map(id => findElement(this.snapshot, id)).filter((e): e is Element => isContainer(e));
    const holders = containerParents(this.currentPage.elements);
    return { containers, others: targets.filter(id => !containers.some(c => c.id === id)), members: targets.filter(id => holders.has(id)) };
  }

  /**
   * Draws a container around the selection and makes the selection its members. It grows with its members, sits behind them, and joins
   * the container they were in, if they all shared one.
   */
  async makeContainer(): Promise<void> {
    const snapshot = this.snapshot;
    const units = outermostTargets(snapshot, this.targets);
    if (!units.length) { this.say('Select the objects to put in a container.', 'info'); return; }
    const groups = parentMap(this.currentPage.elements);
    if (units.some(id => groups.has(id))) { this.say('A container holds whole objects: select the whole group rather than part of it.', 'info'); return; }
    const margin = 12;
    const inner = unionBounds(units.map(id => visualBounds(findElement(snapshot, id)!)));
    const id = crypto.randomUUID();
    const holders = containerParents(this.currentPage.elements);
    const shared = holders.get(units[0]!);
    const parent = shared !== undefined && units.every(u => holders.get(u) === shared) ? shared : undefined;
    const operations: Operation[] = [
      {
        op: 'createShape', id, pageId: this.currentPage.id, name: 'Container',
        bounds: { x: inner.x - margin, y: inner.y - margin, width: inner.width + 2 * margin, height: inner.height + 2 * margin },
        style: { fill: { kind: 'solid', colour: '#f8fafc', opacity: 1 }, stroke: { kind: 'solid', colour: '#64748b', opacity: 1 }, dash: 'dashed' },
        container: { memberIds: units, fit: 'grow', marginPt: margin },
      },
      // the engine stacks it just behind its lowest member, so it stays in front of its own container and of a page background
      ...(parent !== undefined ? [{ op: 'contain', container: parent, add: [id] } as Operation] : []),
    ];
    const r = await this.apply('arrange', operations);
    if (!r.ok) return;
    this.selection = [id]; this.canvas?.setSelection(this.selection);
    this.say(`Put ${units.length} object${units.length === 1 ? '' : 's'} in a container.`, 'info');
  }

  /** Adds the other selected objects to the selected container (the largest, if several are selected). */
  async addToContainer(): Promise<void> {
    const { containers, others } = this.containerSelection;
    if (!containers.length || (!others.length && containers.length < 2)) { this.say('Select a container and the objects to add to it.', 'info'); return; }
    const target = [...containers].sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0]!;
    const holders = containerParents(this.currentPage.elements);
    const above = new Set(containerAncestors(holders, target.id));
    const add = outermostTargets(this.snapshot, this.targets).filter(id => id !== target.id && !above.has(id) && holders.get(id) !== target.id);
    if (!add.length) { this.say('Those objects are already in that container.', 'info'); return; }
    const r = await this.apply('arrange', [{ op: 'contain', container: target.id, add }]);
    if (r.ok) this.say(`Added ${add.length} object${add.length === 1 ? '' : 's'} to the container.`, 'info');
  }

  /** Takes the selected objects out of their containers; each moves up to its container's own container, if any. */
  async removeFromContainer(): Promise<void> {
    const holders = containerParents(this.currentPage.elements);
    const byContainer = new Map<string, string[]>();
    for (const id of this.containerSelection.members) { const c = holders.get(id)!; byContainer.set(c, [...(byContainer.get(c) ?? []), id]); }
    if (!byContainer.size) { this.say('Select objects that are in a container.', 'info'); return; }
    const r = await this.apply('arrange', [...byContainer].map(([container, remove]) => ({ op: 'contain', container, remove }) as Operation));
    if (r.ok) this.say('Removed from the container.', 'info');
  }

  /** Stops the selected containers being containers; the shapes stay, and what they held moves up a level. */
  async disbandContainer(): Promise<void> {
    const { containers } = this.containerSelection;
    if (!containers.length) { this.say('Select a container to disband.', 'info'); return; }
    const r = await this.apply('arrange', containers.map(c => ({ op: 'set', target: c.id, patch: { container: null } }) as Operation));
    if (r.ok) this.say('Disbanded.', 'info');
  }

  async ungroup(): Promise<void> {
    const groups = this.targets.filter(t => findElement(this.snapshot, t)?.kind === 'group');
    if (!groups.length) { this.say('Select a group to ungroup.', 'info'); return; }
    const r = await this.apply('arrange', groups.map(target => ({ op: 'ungroup', target }) as Operation));
    if (r.ok) this.say('Ungrouped.', 'info');
  }

  async align(edge: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'): Promise<void> {
    await this.arrangeWith(targets => ({ op: 'align', targets, edge }), 2, 'align');
  }

  async distribute(axis: 'horizontal' | 'vertical'): Promise<void> {
    await this.arrangeWith(targets => ({ op: 'distribute', targets, axis }), 3, 'distribute');
  }

  async setGap(axis: 'horizontal' | 'vertical', gapPt: number): Promise<void> {
    if (!Number.isFinite(gapPt) || gapPt < 0) { this.say('The gap must be zero or more.', 'warning'); return; }
    await this.arrangeWith(targets => ({ op: 'setGap', targets, axis, gapPt }), 2, 'set a gap between');
  }

  async reorder(to: 'front' | 'back' | 'forward' | 'backward'): Promise<void> {
    await this.arrangeWith(targets => ({ op: 'reorder', targets, to }), 1, 'reorder');
  }

  /** Sets the selected objects' logical stacking level in one atomic transaction. */
  async moveToLevel(level: number): Promise<void> {
    if (!Number.isInteger(level) || level < -127 || level > 127) { this.say('Level must be an integer from -127 to 127.', 'warning'); return; }
    const targets = this.targets;
    if (!targets.length) { this.say('Select an object to change its level.', 'info'); return; }
    const r = await this.apply('arrange', targets.map(target => ({ op: 'set', target, patch: { level } }) as Operation));
    if (r.ok) { this.canvas?.setSelection(this.selection); this.say(level === 0 ? 'Returned to level 0.' : `Moved to level ${level}.`, 'info'); }
  }


  /** What an arrow key moves the selection by: one grid step (at least 1 pt). */
  get nudgeStepPt(): number { return Math.max(1, this.currentPage.grid.spacingPt); }
  async nudge(dx: number, dy: number): Promise<void> { await this.apply('nudge', nudgeOperations(this.snapshot, this.selection, dx, dy)); }

  selectMatching(mode: 'style' | 'layers'): void {
    if(this.targets.length!==1){this.say('Select one object first.','info');return;}
    const result=matchingSelection(this.currentPage,this.targets[0]!,mode);
    if(result.limitation){this.say(result.limitation,'info');return;}
    this.selection=result.ids;this.canvas?.setSelection(result.ids);this.bump();
  }

  // ------------------------------------------------------------------ keyboard navigation (W17)
  /** The object the keyboard is on: the last thing selected, standing as a group when the whole group is. */
  get activeObjectId(): string | undefined { return this.targets.at(-1); }

  /** Selects exactly these objects (a group stands for its members) and brings the last into view. Not a pointer gesture, so nothing is moved or edited. */
  selectObjects(ids: string[]): void {
    const leaves = leavesOfTargets(this.snapshot, ids);
    this.selection = leaves;
    this.canvas?.setSelection(leaves);
    if (ids.length) this.canvas?.ensureVisible(leaves.at(-1)!);
    this.bump();
  }

  /** Tab / Shift+Tab. False when there is nowhere further to go, so the key can leave the canvas. */
  stepObject(delta: 1 | -1): boolean {
    const next = stepFrom(navigableObjects(this.currentPage), this.activeObjectId, delta);
    if (!next) return false;
    this.selectObjects([next.id]);
    return true;
  }

  jumpObject(dir: Direction): void {
    const page = this.currentPage, order = navigableObjects(page), from = this.activeObjectId;
    const next = from ? nearestIn(page, order, from, dir) : order[0];
    if (next) this.selectObjects([next.id]); else if (from) this.say(`No object ${dir === 'up' || dir === 'down' ? dir : 'to the ' + dir} of this one.`, 'info');
  }

  endObject(which: 'first' | 'last'): void {
    const order = navigableObjects(this.currentPage);
    const e = which === 'first' ? order[0] : order.at(-1);
    if (e) this.selectObjects([e.id]);
  }

  /** Enter / F2: edit the text of the selected shape or text box. */
  editSelectedText(): void {
    const only = this.selectedElements();
    if (only.length !== 1 || (only[0]!.kind !== 'shape' && only[0]!.kind !== 'text')) { this.say('Select one shape or text box to edit its text.', 'info'); return; }
    if (only[0]!.locked) { this.say('That object is locked.', 'warning'); return; }
    this.canvas?.startTextEdit(only[0]!.id);
  }

  /** "Connect objects": choose where a connector starts and ends from lists, with no pointer. */
  connectPrompt: { from: string; to: string; error: string | null } | null = null;
  beginConnect(): void {
    const picks = connectable(this.currentPage);
    if (picks.length < 2) { this.say('Add at least two objects before connecting them.', 'info'); return; }
    const chosen = this.targets.filter(id => picks.some(p => p.id === id));
    this.connectPrompt = { from: chosen[0] ?? picks[0]!.id, to: chosen[1] ?? picks.find(p => p.id !== (chosen[0] ?? picks[0]!.id))!.id, error: null };
    this.bump();
  }
  connectCancel(): void { this.connectPrompt = null; this.bump(); }
  async connectCreate(from: string, to: string): Promise<void> {
    if (from === to) { this.connectPrompt = { from, to, error: 'Choose two different objects.' }; this.bump(); return; }
    const r = await this.apply('create', intentOperations(this.snapshot, { type: 'connect', from, to }));
    if (!r.ok) { this.connectPrompt = { from, to, error: r.error.message }; this.bump(); return; }
    this.connectPrompt = null;
    if (r.value.created[0]) this.selectObjects([r.value.created[0]]); else this.bump();
    this.say('Connector created.', 'info');
  }

  selectAll(): void {
    const page = this.currentPage;
    const ids = page.elements.filter(e => e.kind !== 'group' && effectiveState(e, page.layers).visible).map(e => e.id); // a hidden object cannot be picked, even in bulk
    this.selection = ids;
    this.canvas?.setSelection(ids);
    this.bump();
  }

  async toggleGrid(field: 'visible' | 'snap'): Promise<void> {
    const page = this.currentPage;
    // Grid settings are page properties; changing them goes through the same engine so undo and recovery see them.
    this.say(`Grid ${field === 'visible' ? (page.grid.visible ? 'hidden' : 'shown') : (page.grid.snap ? 'snapping off' : 'snapping on')}.`, 'info');
    await this.setPageGrid({ [field]: !page.grid[field] });
  }

  private async setPageGrid(change: { visible?: boolean; snap?: boolean }): Promise<void> {
    await this.apply('inspector', [{ op: 'setPage', pageId: this.currentPage.id, patch: { grid: change } }]);
  }

  zoomBy(factor: number): void { const a = this.adapter; if (a) a.setZoom(a.graph.view.scale * factor); }
  zoomToFit(): void { this.adapter?.zoomToFit(); }
  zoomReset(): void { this.adapter?.setZoom(DEFAULT_SCALE); }

  /** Opens a file into this document. Says whether a file was opened (not cancelled, not failed) and which. */
  async open(path?: string, recentId?: string): Promise<{ opened: boolean; path?: string; error?: string }> {
    const r = await this.host.openJson(path, recentId, this.engine.scope());
    if (!r.ok) { this.say(r.error.message, 'error'); return { opened: false, error: r.error.message }; }
    if (r.value.cancelled) return { opened: false };
    // The host marks the file as saved too, but its note can reach this tab before the new session is settled; this tab knows its own session.
    if (r.value.path && this.engine.status().savedPath !== r.value.path) await this.engine.markSaved(this.engine.scope(), this.engine.revision, r.value.path);
    this.selection = [];
    this.showCommitted();
    this.lastSavedAt = new Date();
    this.say(`Opened ${r.value.path ?? 'file'}.${r.value.notes?.length ? ' ' + r.value.notes.join('; ') : ''}`, 'info');
    return r.value.path ? { opened: true, path: r.value.path } : { opened: true };
  }

  async openIngress(ticketId: string): Promise<{ opened: boolean; path?: string; existingDocumentId?: string; error?: string }> {
    const scope = this.engine.scope();
    const r = await this.host.openIngress(ticketId, { ...scope, baseRevision: this.engine.revision });
    if (!r.ok) { this.say(r.error.message, 'error'); return { opened: false, error: r.error.message }; }
    if (r.value.existingDocumentId) return { opened: true, existingDocumentId: r.value.existingDocumentId, path: r.value.path };
    this.selection = [];
    this.showCommitted();
    if (r.value.diagnostics?.length) this.report = { title: 'Opened a Visio drawing', summary: r.value.summary ?? '', diagnostics: r.value.diagnostics };
    this.say(`Opened ${r.value.path ?? 'file'}. ${r.value.summary ?? ''} ${r.value.warning ?? ''} ${r.value.notes?.join('; ') ?? ''}`.trim(), r.value.lossy || r.value.warning ? 'warning' : 'info');
    this.bump();
    return { opened: true, path: r.value.path };
  }

  /** Nothing in it, never saved, never edited: a new tab can take its place. */
  get isBlank(): boolean {
    const s = this.engine.status();
    return !s.unsaved && !s.savedPath && this.snapshot.document.pages.every(p => p.elements.length === 0);
  }

  /** What the tab shows: the file name, or Untitled N. */
  get tabLabel(): string {
    const p = this.engine.status().savedPath;
    return p ? (p.split(/[\\/]/).pop() || p) : `Untitled ${this.untitledNo}`;
  }

  async openVsdx(recentId?: string, path?: string): Promise<{ opened: boolean; path?: string; error?: string }> {
    const r = await this.host.openVsdx(recentId, path, this.engine.scope());
    if (!r.ok) { this.say(r.error.message, 'error'); return { opened: false, error: r.error.message }; }
    if (r.value.cancelled) return { opened: false };
    this.selection = [];
    this.showCommitted();
    const items = r.value.diagnostics ?? [];
    this.say(`Opened ${r.value.path ?? 'file'}. ${r.value.summary ?? ''} ${r.value.warning ?? ''}`.trim(), r.value.lossy || r.value.warning ? 'warning' : 'info');
    if (items.length) this.report = { title: 'Opened a Visio drawing', summary: r.value.summary ?? '', diagnostics: items };
    this.bump();
    return r.value.path ? { opened: true, path: r.value.path } : { opened: true };
  }

  /** Exports an editable Visio file. If Visio cannot hold something, nothing is written until the person has seen what and agreed. */
  async exportVsdx(opts: { acceptLoss?: boolean; path?: string } = {}): Promise<void> {
    const r = await this.host.exportVsdx(opts);
    if (!r.ok) {
      if (r.error.code === 'compatibility_loss') {
        const d = r.error.details as { diagnostics?: DiagnosticItem[]; path?: string } | undefined;
        const path = d?.path;
        this.report = {
          title: 'Export to Visio', summary: r.error.message, diagnostics: d?.diagnostics ?? [],
          confirm: { label: 'Export anyway', run: () => { this.report = null; void this.exportVsdx({ acceptLoss: true, ...(path ? { path } : {}) }); } },
        };
        this.bump();
        return;
      }
      this.say(r.error.message, 'error');
      return;
    }
    if (r.value.cancelled) return;
    const items = r.value.diagnostics ?? [];
    this.say(`Exported ${r.value.path ?? ''} at revision ${r.value.revision}. ${r.value.summary ?? ''}`.trim(), r.value.lossy ? 'warning' : 'info');
    if (items.length) this.report = { title: 'Exported to Visio', summary: r.value.summary ?? '', diagnostics: items };
    this.bump();
  }

  closeReport(): void { this.report = null; this.bump(); }

  async save(saveAs = false): Promise<void> { await this.files.save(saveAs); }

  showCommittedNow(): void { this.showCommitted(); }

  private showCommitted(): void { this.adapter?.project(this.engine.store.snapshot(), this.pageId); }

  /** Anything selected that no longer exists, or is hidden, is let go: a hidden object cannot stay picked. */
  private pruneSelection(): void {
    const page = this.currentPage;
    const live = new Set(page.elements.filter(e => effectiveState(e, page.layers).visible).map(e => e.id));
    const next = this.selection.filter(id => live.has(id));
    if (next.length === this.selection.length) return;
    this.selection = next;
    this.canvas?.setSelection(next);
  }


  // ------------------------------------------------------------------ recovery
  private scheduleProtectionRead(): void {
    if (this.protectionTimer) return;
    this.protectionTimer = setTimeout(() => { this.protectionTimer = null; void this.readProtection(); }, 600);
  }

  async readProtection(): Promise<void> {
    const r = await this.host.recoveryStatus();
    if (!r.ok) return; // no host (a plain browser): nothing to show
    this.protectedRevision = r.value.lastDurableRevision;
    this.protectionNote = r.value.degraded ? (r.value.note ?? 'recovery is not keeping up') : null;
    this.bump();
  }

  /** At start: is there unfinished work from an earlier run? After a renderer crash it is restored at once, with a visible report. */
  /** Puts unfinished sessions on offer to the person (the recovery dialog lists them). */
  offerSessions(sessions: RecoveryOffer[]): void {
    this.recoveryOffers = sessions;
    this.recoveryBaseRevision = this.engine.revision;
    this.bump();
  }

  async checkRecovery(): Promise<void> {
    const r = await this.host.recoveryList();
    if (!r.ok || r.value.sessions.length === 0) { void this.readProtection(); return; }
    this.recoveryOffers = r.value.sessions;
    this.recoveryBaseRevision = this.engine.revision;
    this.bump();
    if (r.value.auto) await this.restoreOffered(r.value.sessions[0]!.sessionId);
  }

  /** Draws one offered session so a person can recognise it. Failing to is harmless: the card just has no picture. */
  async loadOfferPreview(sessionId: string): Promise<void> {
    if (this.offerPreviews.has(sessionId) || !this.renderPreview) return;
    this.offerPreviews.set(sessionId, undefined as never);
    const fetched = await this.host.recoveryFetch(sessionId);
    const built = fetched.ok ? restoreRecovery(fetched.value) : null;
    if (built && built.ok) this.offerStats.set(sessionId, { pages: built.value.document.pages.length, objects: built.value.document.pages.reduce((n, p) => n + p.elements.length, 0) });
    const url = built && built.ok ? await this.renderPreview(built.value.document).catch(() => null) : null;
    this.offerPreviews.set(sessionId, url);
    this.bump();
  }

  /**
   * Brings one offered session back as a document in `target` (this editor by default). The shell passes a blank or new tab so the
   * recovered work opens as its own tab; a target that has been edited since it was offered refuses, so no new work is thrown away.
   */
  async restoreOffered(sessionId?: string, target: EditorModel = this): Promise<void> {
    const offer = this.recoveryOffers.find(o => o.sessionId === sessionId) ?? this.recoveryOffers[0];
    if (!offer) return;
    const others = this.recoveryOffers.length - 1;
    const r = await this.restoreSession(offer, target, target === this ? this.recoveryBaseRevision : target.engine.revision);
    if (!r.ok) {
      if (r.fatal) { this.recoveryOffers = []; this.bump(); }
      else if (r.gone) { this.recoveryOffers = this.recoveryOffers.filter(o => o !== offer); this.bump(); }
      return;
    }
    this.recoveryOffers = [];
    const lines = [`Restored to revision ${r.revision}${r.originalPath ? ` of ${r.originalPath}` : ''}. The document is marked as unsaved.`];
    if (r.problem) lines.push(`Not recovered: ${r.problem}.`);
    lines.push(...offer.loss.messages);
    if (others > 0) lines.push(`${others} other unfinished session${others === 1 ? '' : 's'} remain on disk and will be offered next time.`);
    this.recoveryReport = { title: 'Recovered unsaved work', lines, saveAs: true };
    target.say(`Recovered unsaved work at revision ${r.revision}. Save it to keep it.`, 'warning');
    this.bump();
  }

  /**
   * Replaces `target`'s document with a recovered session (checkpoint plus journal), keeps the file it came from, and lets the old session
   * go once the rebuilt one is safe. Says nothing to the person: the caller decides what to report.
   */
  async restoreSession(offer: RecoveryOffer, target: EditorModel, baseRevision: number):
    Promise<{ ok: true; revision: number; originalPath: string | null; problem?: string } | { ok: false; fatal?: boolean; gone?: boolean; message: string }> {
    const fetched = await this.host.recoveryFetch(offer.sessionId);
    if (!fetched.ok) { this.say(fetched.error.message, 'error'); return { ok: false, gone: true, message: fetched.error.message }; }
    const built = restoreRecovery(fetched.value);
    if (!built.ok) {
      this.say(`Recovery failed: ${built.error.message}`, 'error');
      this.recoveryReport = { title: 'Recovery failed', lines: [built.error.message, 'Nothing was changed, and the recovery files are still on disk.'] };
      return { ok: false, fatal: true, message: built.error.message };
    }
    const replaced = await target.engine.replaceDocument(built.value.document, { ...target.engine.scope(), baseRevision });
    if (!replaced.ok) {
      const edited = replaced.error.code === 'revision_conflict';
      this.say(edited ? 'You started editing, so the recovered work was not applied. It is still available.' : `Recovery failed: ${replaced.error.message}`, 'warning');
      return { ok: false, message: replaced.error.message };
    }
    target.pageId = undefined;
    target.selection = [];
    target.restoredFromSession = offer.sessionId;
    target.afterRecoveryRestore(); // the host starts the new session (with its own checkpoint, and a note of the session it replaces) and announces it
    target.showCommittedNow();
    await this.host.recoveryFinish(offer.sessionId, fetched.value.originalPath ?? null);
    void target.readProtection();
    target.bump();
    return { ok: true, revision: built.value.revision, originalPath: fetched.value.originalPath ?? null, ...(built.value.problem ? { problem: built.value.problem } : {}) };
  }

  /** Throws one session away for good. The others stay on offer. */
  async discardOffered(sessionId?: string): Promise<void> {
    const offer = this.recoveryOffers.find(o => o.sessionId === sessionId) ?? this.recoveryOffers[0];
    if (!offer) return;
    const r = await this.host.recoveryDiscard(offer.sessionId);
    if (!r.ok) this.say(r.error.message, 'error');
    this.recoveryOffers = this.recoveryOffers.filter(o => o !== offer);
    this.offerPreviews.delete(offer.sessionId);
    this.offerStats.delete(offer.sessionId);
    this.bump();
  }

  /** Not now: every session stays on disk and is offered again next time. */
  deferOffered(): void { this.recoveryOffers = []; this.bump(); }

  /** After a recovery the person is offered Save as, so the work lands in a file of their choosing. */
  async saveRecoveredAs(): Promise<void> {
    await this.save(true);
    if (!this.engine.status().unsaved) { this.recoveryReport = null; this.bump(); }
  }

  // ------------------------------------------------------------------ closing the window or a tab
  /** What the shell does when the prompt is answered for a tab: close it (throwing the work away when `discard`). Set by the shell. */
  closeTabNow: (discard: boolean) => Promise<void> = async () => {};
  /** Told whether the tab was closed (true) or the person said Cancel (false); lets "Close others" go on to the next tab or stop. */
  tabCloseResult: ((closed: boolean) => void) | null = null;
  /** Saves everything the window close would lose (all unsaved tabs). Set by the shell; this document alone when absent. */
  saveAllForClose: (() => Promise<boolean>) | null = null;

  /** The host wants to close. Nothing unsaved: it may. Otherwise the prompt is shown and the host waits for the person's answer. */
  beginClose(count = 1): { dirty: boolean } {
    const s = this.engine.status();
    if (!s.unsaved && count <= 1) return { dirty: false };
    this.closePrompt = { fileName: s.savedPath ?? null, saving: false, error: null, mode: 'window', count };
    this.bump();
    return { dirty: true };
  }

  /** The person closed this tab. Unsaved work asks first (true: asked); otherwise it can go at once. */
  beginTabClose(): boolean {
    const s = this.engine.status();
    if (!s.unsaved) return false;
    this.closePrompt = { fileName: s.savedPath ?? null, saving: false, error: null, mode: 'tab', count: 1 };
    this.bump();
    return true;
  }

  async closeSave(): Promise<void> {
    const p = this.closePrompt; if (!p || p.saving) return;
    p.saving = true; p.error = null; this.bump();
    let saved: boolean;
    if (p.mode === 'window' && this.saveAllForClose) saved = await this.saveAllForClose();
    else { await this.save(false); saved = !this.engine.status().unsaved; }
    if (!saved) { p.saving = false; p.error = p.mode === 'tab' ? 'The changes were not saved, so the tab was not closed.' : 'The changes were not saved, so the window was not closed.'; this.bump(); return; } // Save as was cancelled or failed
    await this.finishClose(false);
  }

  async closeDiscard(): Promise<void> { if (this.closePrompt && !this.closePrompt.saving) await this.finishClose(true); }

  async closeCancel(): Promise<void> {
    const p = this.closePrompt;
    if (!p || p.saving) return;
    this.closePrompt = null; this.bump();
    if (p.mode === 'window') await this.host.appCloseCancelled();
    else { this.tabCloseResult?.(false); this.tabCloseResult = null; }
  }

  private async finishClose(discard: boolean): Promise<void> {
    const mode = this.closePrompt?.mode;
    if (mode === 'tab') { this.closePrompt = null; this.bump(); await this.closeTabNow(discard); this.tabCloseResult?.(true); this.tabCloseResult = null; return; }
    const r = await this.host.appClose(discard);
    if (!r.ok && this.closePrompt) { this.closePrompt.saving = false; this.closePrompt.error = r.error.message; this.bump(); }
  }
  closeRecoveryReport(): void { this.recoveryReport = null; this.bump(); }

  // ------------------------------------------------------------------ pages
  setCurrentPage(id: string): void {
    if (!this.snapshot.document.pages.some(p => p.id === id) || id === this.currentPage.id) return;
    this.pageId = id;
    this.selection = [];
    this.canvas?.setSelection([]);
    this.adapter?.project(this.snapshot, id);
    queueMicrotask(() => this.adapter?.zoomToFit());
    this.say(`Page: ${this.currentPage.name}`, 'info');
  }

  async addPage(size?: { widthPt: number; heightPt: number }): Promise<void> {
    const id = crypto.randomUUID();
    const n = this.snapshot.document.pages.length + 1;
    const r = await this.apply('create', [{ op: 'addPage', id, name: `Page ${n}`, ...(size ?? { widthPt: this.currentPage.widthPt, heightPt: this.currentPage.heightPt }) }]);
    if (r.ok) this.setCurrentPage(id);
  }

  async renamePage(pageId: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) { this.say('A page needs a name.', 'warning'); return; }
    if (trimmed === this.snapshot.document.pages.find(p => p.id === pageId)?.name) return;
    await this.apply('inspector', [{ op: 'setPage', pageId, patch: { name: trimmed } }]);
  }

  async movePage(pageId: string, by: -1 | 1): Promise<void> {
    const pages = this.snapshot.document.pages;
    const at = pages.findIndex(p => p.id === pageId);
    const to = at + by;
    if (at < 0 || to < 0 || to >= pages.length) return;
    await this.apply('inspector', [{ op: 'reorderPage', pageId, index: to }]);
  }

  async duplicatePage(pageId: string): Promise<void> {
    const id = crypto.randomUUID();
    const r = await this.apply('create', [{ op: 'duplicatePage', pageId, id }]);
    if (r.ok) this.setCurrentPage(id);
  }

  async deletePage(pageId: string): Promise<void> {
    const pages = this.snapshot.document.pages;
    if (pages.length <= 1) { this.say('A document keeps at least one page.', 'warning'); return; }
    const at = pages.findIndex(p => p.id === pageId);
    const r = await this.apply('inspector', [{ op: 'deletePage', pageId }]);
    if (r.ok && this.currentPage.id !== pages[Math.max(0, at - 1)]!.id && this.pageId === pageId) this.setCurrentPage(pages[Math.max(0, at - 1)]!.id);
  }

  async setPageSize(pageId: string, widthPt: number, heightPt: number): Promise<void> {
    if (!(widthPt > 0 && heightPt > 0)) { this.say('A page needs a positive width and height.', 'warning'); return; }
    await this.apply('inspector', [{ op: 'setPage', pageId, patch: { widthPt, heightPt } }]);
  }

  // ------------------------------------------------------------------ layers
  async addLayer(name: string): Promise<void> {
    const trimmed = name.trim() || `Layer ${this.currentPage.layers.length + 1}`;
    await this.apply('create', [{ op: 'addLayer', pageId: this.currentPage.id, id: crypto.randomUUID(), name: trimmed }]);
  }

  async setLayer(layerId: string, patch: { name?: string; visible?: boolean; locked?: boolean; printable?: boolean }): Promise<void> {
    if (patch.name !== undefined && !patch.name.trim()) { this.say('A layer needs a name.', 'warning'); return; }
    await this.apply('inspector', [{ op: 'setLayer', layerId, patch }]);
  }

  async deleteLayer(layerId: string): Promise<void> {
    if (this.currentPage.layers.length <= 1) { this.say('A page keeps at least one layer.', 'warning'); return; }
    await this.apply('inspector', [{ op: 'deleteLayer', layerId }]);
  }

  /** Puts the selection in (or takes it out of) a layer. An object may belong to several layers. */
  async assignSelectionToLayer(layerId: string, member: boolean): Promise<void> {
    const targets = this.targets;
    if (!targets.length) { this.say('Select something first.', 'info'); return; }
    await this.apply('inspector', [{ op: 'assignLayers', targets, layerIds: [layerId], mode: member ? 'add' : 'remove' }]);
  }

  // ------------------------------------------------------------------ pictures: the document's and the library's
  /** Library entries as last read from the host. */
  library: LibraryEntry[] = [];
  libraryNote = '';

  /** What this document pins, with how many images use each. */
  documentAssets() {
    const doc = this.snapshot.document;
    return doc.assets.map(a => ({ ...a, usedBy: imagesUsing(this.snapshot, a.id).length, inLibrary: this.library.some(l => l.id === a.id), newerInLibrary: this.library.some(l => l.id === a.id && l.sha256 !== a.sha256) }));
  }

  async refreshLibrary(): Promise<void> {
    const r = await this.host.libraryList();
    if (!r.ok) { this.libraryNote = r.error.code === 'not_running' ? 'No host: the library is not available here.' : r.error.message; this.library = []; this.bump(); return; }
    this.library = r.value.assets;
    this.libraryNote = '';
    this.bump();
  }

  async importToLibrary(): Promise<void> {
    const r = await this.host.libraryImport();
    if (!r.ok) { this.say(r.error.message, 'error'); return; }
    if (r.value.cancelled) return;
    await this.refreshLibrary();
    const a = r.value.asset!;
    this.say(r.value.created ? `Added ${a.name} to the library as ${a.id}.${r.value.idWasTaken ? ' That name was taken by a different picture, so it has its own version id.' : ''}` : `${a.name} is already in the library as ${a.id}.`, r.value.idWasTaken ? 'warning' : 'info');
  }

  async renameAsset(scope: 'document' | 'library', id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) { this.say('A picture needs a name.', 'warning'); return; }
    if (scope === 'library') {
      const r = await this.host.librarySetMetadata(id, { name: trimmed });
      if (!r.ok) { this.say(r.error.message, 'error'); return; }
      await this.refreshLibrary();
      return;
    }
    await this.apply('inspector', [{ op: 'setAsset', assetId: id, patch: { name: trimmed } }]);
  }

  async tagAsset(scope: 'document' | 'library', id: string, tags: string[]): Promise<void> {
    const clean = [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))];
    if (scope === 'library') {
      const r = await this.host.librarySetMetadata(id, { tags: clean });
      if (!r.ok) { this.say(r.error.message, 'error'); return; }
      await this.refreshLibrary();
      return;
    }
    await this.apply('inspector', [{ op: 'setAsset', assetId: id, patch: { tags: clean } }]);
  }

  /** Deleting a document picture that images still use is refused with the reason; the library entry can always go (documents keep their own copy). */
  async deleteAsset(scope: 'document' | 'library', id: string): Promise<void> {
    if (scope === 'library') {
      const r = await this.host.libraryDelete(id);
      if (!r.ok) { this.say(r.error.message, 'error'); return; }
      await this.refreshLibrary();
      this.say(`Removed ${id} from the library. Documents that use it keep their own copy.`, 'info');
      return;
    }
    const check = canDeleteAsset(this.snapshot, id);
    if (!check.ok) { this.say(`${id} is still used by ${check.imageIds.length} picture(s). Replace those first.`, 'warning'); return; }
    await this.apply('inspector', [{ op: 'removeAsset', assetId: id }]);
  }

  async copyAssetId(id: string): Promise<void> {
    try {
      // the clipboard can wait forever for permission or focus; do not leave the person with no answer
      await Promise.race([navigator.clipboard.writeText(id), new Promise((_, no) => setTimeout(() => no(new Error('clipboard timeout')), 1500))]);
      this.say(`Copied ${id}.`, 'info');
    } catch { this.say(`${id} (the clipboard is not available here; select and copy it by hand)`, 'info'); }
  }

  async replaceLibrarySource(id: string): Promise<void> {
    const r = await this.host.libraryReplaceSource(id);
    if (!r.ok) { this.say(r.error.message, 'error'); return; }
    if (r.value.cancelled) return;
    await this.refreshLibrary();
    this.say(`${id} now points at the new picture. Documents keep what they pinned until you choose to update them.`, 'info');
  }

  /** The approved preparation for a library picture, or the document's own pinned asset as a stand-in so one code path serves both. */
  private async prepared(source: { scope: 'library' | 'document'; id: string; hash?: string }): Promise<Result<{ ref: PreparedAssetRef; width: number; height: number }>> {
    if (source.scope === 'library') {
      const r = await this.host.libraryUse(source.id, source.hash);
      return r.ok ? ok({ ref: r.value.ref, width: r.value.width, height: r.value.height }) : r;
    }
    const asset = this.snapshot.document.assets.find(a => a.id === source.id);
    if (!asset) return fail('not_found', `the document has no picture ${source.id}`);
    return ok({ ref: { preparationId: 'document', expiresAt: '', asset }, width: 0, height: 0 });
  }

  /** Puts a picture on the page (registering it in the document in the same transaction). */
  async placeAsset(source: { scope: 'library' | 'document'; id: string; hash?: string }, at?: { x: number; y: number }): Promise<void> {
    const p = await this.prepared(source);
    if (!p.ok) { this.say(p.error.message, 'error'); return; }
    const plan = prepareDocumentAsset(this.snapshot, p.value.ref);
    const page = this.currentPage;
    const natW = p.value.width ? toPoints(p.value.width, 'px') : 96, natH = p.value.height ? toPoints(p.value.height, 'px') : 96;
    const k = Math.min(1, page.widthPt / 2 / natW, page.heightPt / 2 / natH);
    const w = natW * k, h = natH * k;
    const r = await this.apply('create', [...plan.operations, snapCreation({ op: 'createImage', assetId: plan.resolvedAssetId, name: p.value.ref.asset.name, bounds: { x: (at?.x ?? page.widthPt / 2) - w / 2, y: (at?.y ?? page.heightPt / 2) - h / 2, width: w, height: h }, fit: 'contain', preserveAspectRatio: true }, page, {enabled:this.showGuides && this.snapToGuides,scale:this.viewport?.scale??1})]);
    if (r.ok && r.value.created.length) { this.selection = [r.value.created[r.value.created.length - 1]!]; this.canvas?.setSelection(this.selection); this.bump(); }
  }

  /** Places a dropped library picture only if its original drawing, page and revision are still current. */
  async placeIngressImage(asset: { id: string; sha256: string }, expected: { documentId: string; sessionId: string; pageId: string; baseRevision: number; x: number; y: number }): Promise<Result<TransactionResult>> {
    const matches = () => this.engine.scope().documentId === expected.documentId && this.engine.scope().sessionId === expected.sessionId &&
      this.currentPage.id === expected.pageId && this.engine.revision === expected.baseRevision;
    if (!matches()) return fail('revision_conflict', 'The drawing, page, or revision changed after the picture was dropped. Choose a fresh placement.');
    const p = await this.prepared({ scope: 'library', id: asset.id, hash: asset.sha256 });
    if (!p.ok) return p;
    if (!matches()) return fail('revision_conflict', 'The drawing, page, or revision changed while the picture was being prepared. Choose a fresh placement.');
    const plan = prepareDocumentAsset(this.snapshot, p.value.ref);
    const page = this.currentPage;
    const natW = p.value.width ? toPoints(p.value.width, 'px') : 96, natH = p.value.height ? toPoints(p.value.height, 'px') : 96;
    const k = Math.min(1, page.widthPt / 2 / natW, page.heightPt / 2 / natH);
    const w = natW * k, h = natH * k;
    const image = snapCreation({ op: 'createImage', pageId: expected.pageId, assetId: plan.resolvedAssetId, name: p.value.ref.asset.name,
      bounds: { x: expected.x - w / 2, y: expected.y - h / 2, width: w, height: h }, fit: 'contain', preserveAspectRatio: true }, page,
      { enabled: this.showGuides && this.snapToGuides, scale: this.viewport?.scale ?? 1 });
    return this.apply('create', [...plan.operations, image]);
  }

  /** Changes the picture of the selected image only. Its twins that share the old picture keep it. */
  async useForSelectedImage(source: { scope: 'library' | 'document'; id: string; hash?: string }): Promise<void> {
    const images = this.selectedElements().filter(e => e.kind === 'image');
    if (images.length !== 1 || this.selectedElements().length !== 1) { this.say('Select one picture on the page first.', 'info'); return; }
    const p = await this.prepared(source);
    if (!p.ok) { this.say(p.error.message, 'error'); return; }
    const plan = replaceOneImage(this.snapshot, images[0]!.id, p.value.ref);
    if ('error' in plan) { this.say(plan.error, 'warning'); return; }
    if (!plan.operations.length) { this.say('That picture already shows this image.', 'info'); return; }
    const r = await this.apply('inspector', plan.operations);
    if (r.ok) this.say(`Changed one picture to ${plan.resolvedAssetId}.`, 'info');
  }

  /** Changes every use of a document picture. Says how many pictures changed. */
  async replaceEverywhere(fromAssetId: string, source: { scope: 'library' | 'document'; id: string; hash?: string }): Promise<void> {
    const p = await this.prepared(source);
    if (!p.ok) { this.say(p.error.message, 'error'); return; }
    const plan = replaceEverywhere(this.snapshot, fromAssetId, p.value.ref);
    if ('error' in plan) { this.say(plan.error, 'warning'); return; }
    if (!plan.operations.length) { this.say('Nothing to change: that is already the picture in use.', 'info'); return; }
    const r = await this.apply('inspector', plan.operations);
    if (r.ok) this.say(`Replaced ${fromAssetId} with ${plan.resolvedAssetId} in ${plan.affectedImageIds.length} picture${plan.affectedImageIds.length === 1 ? '' : 's'}.`, 'info');
  }

  /** Called when the host replaced the document (open) and the engine started a new session. */
  sessionReplaced(): void {
    this.selection = [];
    this.showCommitted();
    this.bump();
  }

  /** Unit-aware helpers for the inspector. */
  toUnit(pt: number): number { return pt / toPoints(1, this.unit); }
  fromUnit(value: number): number { return toPoints(value, this.unit); }

  pageOfElement(id: string) { return pageContaining(this.snapshot, id); }
  dispose(): void { this.files.dispose(); this.detachCanvas(); this.projector.dispose(); }
}

function gestureMatches(kind: GestureKind, intent: Intent): boolean {
  switch (intent.type) {
    case 'move': return kind === 'move';
    case 'resize': return kind === 'resize';
    case 'rotate': return kind === 'rotate';
    case 'bend': return kind === 'bend';
    case 'reconnect': return kind === 'bend';
    case 'text': return kind === 'text';
    case 'connect': return false;
  }
}


function diagnosticOf(details: Record<string, unknown> | undefined): { line?: number; column?: number; hint?: string } {
  const out: { line?: number; column?: number; hint?: string } = {};
  if (typeof details?.line === 'number') out.line = details.line;
  if (typeof details?.column === 'number') out.column = details.column;
  if (typeof details?.hint === 'string') out.hint = details.hint;
  return out;
}
