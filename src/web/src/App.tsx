import { ExportImageDialog } from './components/ExportImageDialog';
import { PrintPreviewDialog } from './components/PrintPreviewDialog';
import { RecentFilesDialog } from './components/RecentFilesDialog';
import { FindPanel } from './components/FindPanel';
import { FileConflictDialog } from './components/FileConflictDialog';
import { NewDocumentDialog } from './components/NewDocumentDialog';
import { useEffect } from 'react';
import type { EditorModel } from './editor/EditorModel';
import type { WorkspaceModel } from './workspace/WorkspaceModel';
import { TabStrip } from './components/TabStrip';
import { useWorkspace } from './components/useWorkspace';
import { AssetsPanel } from './components/AssetsPanel';
import { CompatibilityDialog } from './components/CompatibilityDialog';
import { Drawer } from './components/Drawer';
import { Inspector } from './components/Inspector';
import { LayersPanel } from './components/LayersPanel';
import { RecoveryDialog } from './components/RecoveryDialog';
import { CloseDialog } from './components/CloseDialog';
import { DocumentTitle } from './components/DocumentTitle';
import { PageTabs } from './components/PageTabs';
import { PageCanvas } from './components/PageCanvas';
import { ShapesPanel } from './components/ShapesPanel';
import { StatusBar } from './components/StatusBar';
import { Toolbar } from './components/Toolbar';
import { PreferencesDialog } from './components/PreferencesDialog';
import { HelpDialogs } from './components/HelpDialogs';
import { ConnectDialog } from './components/ConnectDialog';
import { FileIngressQueue } from './components/FileIngressQueue';
import { BeautifyDialog } from './components/BeautifyDialog';
import { RoutingDefaultsDialog } from './components/RoutingDefaultsDialog';

const typing = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);

/** Every shortcut calls the same model commands the buttons do, so keyboard, menu and toolbar share one path into the engine. */
function useShortcuts(ws: WorkspaceModel) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const model = ws.active;
      if (ws.preferences.dialogOpen || ws.tabs.some(t => t.beautifyPrompt || t.routingDefaultsOpen)) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); if (!ws.recentPrompt && !ws.tabs.some(t => t.newDocument.prompt || t.closePrompt || t.exportPrompt || t.printPrompt || t.report || t.files.prompt || t.connectPrompt)) ws.help.toggle('palette'); return; }
      if (ws.help.panel) return; // a Help panel is up: it takes the keys
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase()==='f') {
        e.preventDefault();
        if(!ws.tabs.some(t=>t.newDocument.prompt||t.closePrompt||t.exportPrompt||t.printPrompt||t.files.prompt||t.report||t.recoveryOffers.length||t.recoveryReport))model.find.open();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!ws.recentPrompt && !ws.tabs.some(t => t.newDocument.prompt || t.closePrompt || t.exportPrompt || t.printPrompt || t.files.prompt || t.connectPrompt)) model.newDocument.begin(); return; }
      if (ws.recentPrompt || ws.tabs.some(t => t.newDocument.prompt || t.closePrompt || t.exportPrompt || t.printPrompt || t.files.prompt || t.connectPrompt)) return;
      if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); ws.cycle(e.shiftKey ? -1 : 1); return; } // most recently used first; works while typing too, like a browser
      if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); ws.step(e.key === 'PageDown' ? 1 : -1); return; } // in tab order
      if (typing(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); void model.undo(); }
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); void model.redo(); }
      else if (mod && key === 'g') { e.preventDefault(); void (e.shiftKey ? model.ungroup() : model.group()); }
      else if (mod && e.shiftKey && key === 'f') { e.preventDefault(); void model.reorder('front'); }
      else if (mod && e.shiftKey && key === 'b') { e.preventDefault(); void model.reorder('back'); }
      else if (mod && key === 'c') { e.preventDefault(); model.copy(); }
      else if (mod && key === 'v') { e.preventDefault(); void model.pasteFromClipboard(); }
      else if (mod && key === 'd') { e.preventDefault(); void model.duplicate(); }
      else if (mod && key === 'a') { e.preventDefault(); model.selectAll(); }
      else if (mod && key === 's') { e.preventDefault(); void model.save(e.shiftKey); }
      else if (mod && key === 'o') { e.preventDefault(); void ws.openFile(); }
      else if (mod && key === 'p') { e.preventDefault(); model.beginPrint(); }
      else if (mod && key === 'n') { e.preventDefault(); ws.newTab(); }
      else if (mod && key === 'w') { e.preventDefault(); void ws.closeTab(model); }
      else if (mod && (key === '=' || key === '+')) { e.preventDefault(); model.zoomBy(1.25); }
      else if (mod && key === '-') { e.preventDefault(); model.zoomBy(0.8); }
      else if (mod && key === '0') { e.preventDefault(); model.zoomToFit(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { if (model.selection.length) { e.preventDefault(); void model.deleteSelection(); } }
      else if (e.key === 'Escape') { if (model.tool.kind !== 'select') model.setTool({ kind: 'select' }); }
      else if (e.key.startsWith('Arrow') && !mod && model.selection.length) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : model.nudgeStepPt; // one grid step; Shift is the fine adjustment
        void model.nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Control') ws.endCycle(); };
    const onBlur = () => ws.endCycle();
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); };
  }, [ws]);
}

export function App({ ws }: { ws: WorkspaceModel }) {
  const workspaceVersion = useWorkspace(ws);
  useShortcuts(ws);
  useEffect(() => { void ws.processIngress(); }, [ws, workspaceVersion]);
  const model = ws.active;
  const asking = ws.tabs.find(t => t.closePrompt);
  useEffect(()=>{const focus=()=>{if(!ws.preferences.dialogOpen)void ws.checkFiles();};window.addEventListener('focus',focus);return()=>window.removeEventListener('focus',focus);},[ws]);
  useEffect(()=>{if(!ws.isBusy()&&!ws.tabs.some(t=>t.newDocument.prompt||t.closePrompt||t.recoveryOffers.length||t.recoveryReport))model.files.presentNotice();});
  const holder = ws.tabs.find(t => t.recoveryOffers.length > 0 || t.recoveryReport) ?? model; // the tab that holds the recovery question
  return (
    <div className="app">
      <Toolbar key={`t${model.tabId}`} model={model} ws={ws} />
      <TabStrip ws={ws} />
      <div className="left-stack" key={`l${model.tabId}`}>
        <ShapesPanel model={model} />
        <LayersPanel model={model} />
        <AssetsPanel model={model} />
      </div>
      <PageCanvas key={`c${model.tabId}`} model={model} />
      <Inspector key={`i${model.tabId}`} model={model} />
      <PageTabs model={model} />
      <Drawer model={model} />
      {!ws.tabs.some(t=>t.newDocument.prompt||t.closePrompt||t.files.prompt||t.report||t.recoveryOffers.length||t.recoveryReport)&&<FindPanel key={model.tabId} model={model} />}
      {/* A report from an in-flight host call waits here until Preferences releases modal ownership. */}
      {!ws.preferences.dialogOpen && <CompatibilityDialog model={model} />}
      {!ws.tabs.some(t=>t.files.prompt) && <RecoveryDialog model={holder} onRecover={id => void ws.restoreOrphan(holder, id)} />}
      {asking && !ws.tabs.some(t=>t.files.prompt) && <CloseDialog model={asking} />}
      <FileConflictDialog model={ws.tabs.find(t=>t.files.prompt?.source==='save') ?? ws.tabs.find(t=>t.files.prompt) ?? model} />
      {ws.tabs.filter(t => t.beautifyPrompt && !ws.tabs.some(x => x.files.prompt || x.newDocument.prompt || x.closePrompt || x.printPrompt || x.exportPrompt)).slice(0,1).map(t => <BeautifyDialog key={`${t.tabId}-beautify`} model={t} />)}
      {ws.tabs.filter(t => t.newDocument.prompt).map(t => <NewDocumentDialog key={t.tabId} model={t} />)}
      {ws.tabs.filter(t=>t.exportPrompt && !ws.tabs.some(x=>x.files.prompt) && !asking && !holder.recoveryReport && !holder.recoveryOffers.length && !ws.tabs.some(x=>x.newDocument.prompt)).slice(0,1).map(t=><ExportImageDialog key={t.tabId} model={t}/>)}
      {ws.tabs.filter(t=>t.printPrompt && !ws.tabs.some(x=>x.files.prompt) && !asking && !holder.recoveryReport && !holder.recoveryOffers.length && !ws.tabs.some(x=>x.newDocument.prompt)).slice(0,1).map(t=><PrintPreviewDialog key={`${t.tabId}-print`} model={t}/>)}
      {ws.recentPrompt && !ws.tabs.some(t=>t.files.prompt) && !asking && !holder.recoveryReport && !holder.recoveryOffers.length && !ws.tabs.some(t=>t.newDocument.prompt) && <RecentFilesDialog ws={ws} />}
      <HelpDialogs ws={ws} model={model} />
      {ws.tabs.filter(t => t.connectPrompt).map(t => <ConnectDialog key={`${t.tabId}-connect`} model={t} />)}
      <DocumentTitle model={model} />
      <StatusBar model={model} />
      <PreferencesDialog ws={ws} />
      <RoutingDefaultsDialog model={model} />
      <FileIngressQueue ws={ws} />
    </div>
  );
}

