import { initializePreferences } from './bridge/initializePreferences';
import { applyChromeTheme } from './preferences/applyChromeTheme';
import type { ComponentProposal } from './layout/components';
import '@maxgraph/core/css/common.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startApp } from './bridge/bootstrap';
import { EditorModel, noHost, type HostApi } from './editor/EditorModel';
import type { HostServices } from './bridge/hostServices';
import { createSnapshotRenderer } from './render/SnapshotRenderer';
import { createBrowserLayoutContext } from './layout/browserContext';
import { WorkspaceModel } from './workspace/WorkspaceModel';
import type { DocumentState } from './workspace/Workspace';
import { fail } from './model/result';

function hostApi(host: HostServices | null): HostApi {
  if (!host) return noHost;
  return {
    editorExport: opts => host.call('host.exportImage', {...opts}),
    editorPrint: (action, params = {}) => host.call('host.print', { action, ...params }),
    pickImage: () => host.call('host.pickImage'),
    openJson: (path, recentId, scope) => host.call('host.openJson', { ...(recentId ? { recentId } : path ? { path } : {}), ...(scope ? { documentId: scope.documentId, sessionId: scope.sessionId } : {}) }),
    openIngress: (ticketId, expected) => host.call('host.ingress.open', { ticketId, ...expected }),
    importIngressImage: (ticketId, scope) => host.call('host.ingress.importImage', { ticketId, ...scope }),
    clipboardDescribe: () => host.call('host.clipboard.describe', {}),
    markInternalCopy: copyId => host.call('host.clipboard.markInternalCopy', { copyId }),
    importClipboardImage: (expectedSequence, scope) => host.call('host.clipboard.importImage', { expectedSequence, ...scope }),
    dismissIngress: ticketIds => host.call('host.ingress.dismiss', { ticketIds }),
    recentList: () => host.call('host.recent.list'),
    recentRemove: id => host.call('host.recent.remove', { id }),
    recentClear: () => host.call('host.recent.clear'),
    workspaceSave: (tabs, activeDocumentId) => host.call('host.workspace.save', { tabs, activeDocumentId }),
    workspaceLoad: () => host.call('host.workspace.load'),
    saveJson: (saveAs,expected) => host.call('host.saveJson', { saveAs, expected }),
    fileCheck: expected => host.call('host.fileConflict.check', { expected }),
    fileResolve: (token,action,discard) => host.call('host.fileConflict.resolve', { token, action, discard }),
    recoveryStatus: () => host.call('host.recovery.status'),
    recoveryList: () => host.call('host.recovery.list'),
    recoveryFetch: sessionId => host.call('host.recovery.fetch', { sessionId }),
    recoveryDiscard: sessionId => host.call('host.recovery.discard', { sessionId }),
    recoveryFinish: (sessionId, originalPath) => host.call('host.recovery.finish', { sessionId, originalPath }),
    appClose: discard => host.call('host.app.close', { discard }),
    appCloseCancelled: () => host.call('host.app.closeCancelled'),
    appAbout: () => host.call('host.app.about'),
    libraryList: (query, tags) => host.call('host.library.list', { query, tags }),
    libraryImport: () => host.call('host.library.import'),
    libraryUse: (id, hash) => host.call('host.library.use', { id, hash }),
    libraryReplaceSource: id => host.call('host.library.replaceSource', { id }),
    librarySetMetadata: (id, patch) => host.call('host.library.setMetadata', { id, ...patch }),
    libraryDelete: id => host.call('host.library.delete', { id }),
    openVsdx: (recentId, path, scope) => host.call('host.openVsdx', { ...(recentId ? { recentId } : path ? { path } : {}), ...(scope ? { documentId: scope.documentId, sessionId: scope.sessionId } : {}) }),
    documentShow: documentId => host.call('host.documents.show', { documentId }),
    documentDiscard: documentId => host.call('host.documents.discard', { documentId }),
    agentDocuments: () => host.call('host.documents.agent'),
    documentReveal: documentId => host.call('host.documents.reveal', { documentId }),
    documentCopyPath: documentId => host.call('host.documents.copyPath', { documentId }),
    exportVsdx: opts => host.call('host.exportVsdx', opts),
  };
}

const assetUrl = (snapshot: { document: { assets: Array<{ id: string; sha256: string }> } }, id: string) => {
  const a = snapshot.document.assets.find(x => x.id === id);
  return a ? `/assets/${a.sha256}` : '';
};
const renderer = createSnapshotRenderer({ assetUrl: assetUrl as never });
let ws: WorkspaceModel | null = null;
const initialPreferences = await initializePreferences(window.chrome?.webview);
applyChromeTheme(initialPreferences.preferences.current.theme);
const app = startApp(window.chrome?.webview, null, {
  ...initialPreferences,
  onSessionChanged: state => (state.ui as EditorModel | null)?.sessionReplaced(),
  render: renderer.render, rasterise: renderer.rasterise, layoutContext: createBrowserLayoutContext(assetUrl as never),
  beforeClose: async () => ws!.beginClose(),
  app: {
    captureIngressTarget: point => {
      const captured = ws?.captureIngressTarget(point);
      return captured ? { ok: true, value: captured } : fail('not_ready', 'The canvas is not ready to receive a picture.', { retryable: true });
    },
    adoptDocument: (document, activate) => ws!.adoptDocument(document, activate),
    activateDocument: documentId => ws!.activateById(documentId),
    agentDocuments: list => ws!.setAgentDocs(list),
    openFiles: files => ws!.openFromShell(files),
    ingressAvailable: batch => ws!.enqueueIngress(batch),
  },
});
const { engine, host, router, sessionChanged, workspace } = app;

/** What every tab's editor needs from the page: the host, component previews, the renderer, and the gesture interlock. */
function configure(model: EditorModel, state: DocumentState): void {
  model.proposeComponent = async params => {
    if (!router) return { ok: false, error: { code: 'not_ready', message: 'The editor bridge is unavailable', retryable: false } };
    const r = await router.dispatch({ protocolVersion: 1, kind: 'request', requestId: crypto.randomUUID(), ...model.engine.scope(), method: 'components.get', params } as never);
    return r.error ? { ok: false, error: r.error } : { ok: true, value: r.result as unknown as ComponentProposal & { base64: string; mimeType: string } };
  };
  model.afterRecoveryRestore = () => sessionChanged(state, model.takeRestoredFrom());
  model.renderPreview = async doc => {
    const r = await renderer.render({ documentId: doc.id, sessionId: doc.id, revision: 0, document: doc }, undefined, { scope: 'page', pageId: doc.pages[0]!.id, maxWidth: 280, maxHeight: 200, format: 'png' });
    return r.ok ? `data:${r.value.mimeType};base64,${r.value.base64}` : null;
  };
  if (router) model.onGestureState = active => router.setGestureActive(active); // an outside mutation waits (briefly) while the user is mid-gesture
}

const firstModel = new EditorModel(engine);
ws = new WorkspaceModel(app, firstModel);
app.preferences.onSaved = saved => { applyChromeTheme(saved.theme); ws!.applyPreferencesUnits(saved.units); };
app.preferences.subscribe(() => router?.setGestureActive(app.preferences.dialogOpen));
ws.configure = configure;
ws.isBusy = () => !!router?.isGestureActive();
ws.host = hostApi(host);
if (host) ws.protectNew = scope => host.call('host.protectNewDocument', { ...scope });
configure(firstModel, workspace.active!);
const model = firstModel;
ws.restored = ws.restoreWorkspace(model).then(() => ws!.refreshAgentDocs());
void ws.restored; // the last run's tabs come back; unfinished work no tab owns is offered

// A read-only window onto the editor for automated tests. It is compiled out of production builds, and nothing here edits the document.
// It always points at the active tab, so a test sees what the person sees.
if (import.meta.env.VITE_TEST_API === '1') {
  const shell = ws;
  const cur = () => shell.active;
  const recorded = new Map<unknown, unknown[]>();
  const record = (state: DocumentState) => { const list: unknown[] = []; recorded.set(state.engine, list); state.engine.onCommitted(e => list.push(JSON.parse(JSON.stringify(e)))); };
  record(workspace.active!);
  workspace.subscribe(e => { if (e.kind === 'opened') record(e.state); });
  (window as unknown as { __editor: unknown }).__editor = {
    committedEvents: () => JSON.parse(JSON.stringify(recorded.get(cur().engine) ?? [])),
    checkRecovery: () => cur().checkRecovery(),
    beginClose: () => shell.beginClose(),
    restoreWorkspace: () => shell.restoreWorkspace(cur()),
    callApp: (method: string, params: Record<string, unknown>) => router!.dispatch({ protocolVersion: 1, kind: 'request', requestId: crypto.randomUUID(), method, params } as never),
    persist: () => shell.persist(),
    markSaved: async (path: string) => { const m = cur(); await m.engine.markSaved(m.engine.scope(), m.engine.revision, path); m.say(`Saved ${path}.`, 'info'); },
    snapshot: () => JSON.parse(JSON.stringify(cur().snapshot)),
    selection: () => [...cur().selection],
    status: () => ({ ...cur().status, ...cur().engine.status() }),
    centre: (id: string) => cur().canvas!.centerOf(id),
    handle: (id: string, which: 'rotate' | 'se' | 'bend') => cur().canvas!.handleOf(id, which),
    sheetRect: () => cur().canvas!.sheetRect(),
    viewport: () => cur().viewport,
    textEdit: (id: string, text: string | null) => {
      const g = cur().canvas!.graph;
      const cell = g.getDataModel().getCell(id)!;
      g.startEditingAtCell(cell);
      const ed = g.getPlugin('CellEditorHandler') as unknown as { textarea: HTMLElement };
      if (text !== null) ed.textarea.innerText = text;
      g.stopEditing(text === null);
    },
    startTextEditing: (id: string) => {
      const g = cur().canvas!.graph;
      g.startEditingAtCell(g.getDataModel().getCell(id)!);
    },
    callTool: (method: string, params: Record<string, unknown>) => router!.dispatch({ protocolVersion: 1, kind: 'request', requestId: crypto.randomUUID(), method, ...cur().engine.scope(), params } as never),
    setHost: (h: Partial<HostApi>) => { shell.host = { ...noHost, ...h }; },
    pasteFromClipboard: () => shell.pasteFromClipboard(),
    routeDiagnostics: () => JSON.parse(JSON.stringify(cur().routeDiagnostics())),
    setCurrentPage: (id: string) => cur().setCurrentPage(id),
    exportSnapshot: async () => { const m = cur(); const r = await m.engine.exportSnapshot(m.engine.scope()); return r.ok ? JSON.parse(JSON.stringify(r.value)) : { error: r.error }; },
    changesSince: async (revision: number) => { const m = cur(); const r = await m.engine.getChanges(m.engine.scope(), revision); return r.ok ? JSON.parse(JSON.stringify(r.value)) : { error: r.error }; },
    targets: () => [...cur().targets],
    gestureActive: () => cur().controller.isActive(),
    dragCells: () => ((cur().canvas!.graph.getPlugin('SelectionHandler') as unknown as { cells?: { getId(): string | null }[] | null }).cells ?? []).map(c => c.getId()),
    agentApply: (operations: unknown[], baseRevision?: number) => { const m = cur(); return m.engine.execute({
      ...m.engine.scope(), transactionId: crypto.randomUUID(), baseRevision: baseRevision ?? m.engine.revision, atomic: true, operations,
    } as never, 'mcp'); },
    nodeCount: () => cur().canvas!.graph.getDataModel().getCell(cur().currentPage.id) ? 0 : (cur().canvas!.graph.getDefaultParent().getChildCount()),
    // tabs
    tabs: () => shell.tabs.map(t => ({ label: t.tabLabel, unsaved: t.engine.status().unsaved, documentId: t.engine.scope().documentId, active: t === shell.active })),
    newTab: () => { shell.newTab(); },
    openFile: (kind?: 'json' | 'vsdx') => shell.openFile(kind),
    enqueueIngress: (batch: import('./workspace/FileIngressModel').IngressBatch) => shell.enqueueIngress(batch),
    captureIngressTarget: (clientX: number, clientY: number) => shell.captureIngressTarget({ clientX, clientY }),
    cancelIngress: (batchId: string) => shell.cancelIngress(batchId),
    processIngress: () => shell.processIngress(),
    closeTab: (index?: number) => shell.closeTab(index === undefined ? shell.active : shell.tabs[index]!),
    activateTab: (index: number) => shell.activate(shell.tabs[index]!),
    moveTab: (from: number, to: number) => shell.moveTab(shell.tabs[from]!, to),
    agentOpenDocument: (opts?: { activate?: boolean }) => app.openDocument(opts ?? {}).engine.scope(),
    preferencesHostSave: async (patch: Partial<import('./contracts/generated').AppPreferences>) => {
      const read = await initialPreferences.preferencesService.get();
      return read.ok ? initialPreferences.preferencesService.save({ ...read.value.preferences, ...patch }, read.value.versionTag) : read;
    },
    preferencesFailWrites: () => app.preferences.useService({
      get: () => initialPreferences.preferencesService.get(),
      save: async () => ({ ok: false, error: { code: 'io_error', message: 'Settings file could not be written', retryable: false } }),
    }),
  };
}

createRoot(document.getElementById('root')!).render(<App ws={ws} />);
