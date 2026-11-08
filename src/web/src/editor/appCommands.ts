import type { EditorModel } from './EditorModel';
import { arrangeActions } from './arrangeActions';
import type { WorkspaceModel } from '../workspace/WorkspaceModel';

export type CommandGroup = 'File' | 'Edit' | 'Arrange' | 'View' | 'Help';

export interface AppCommand {
  id: string;
  label: string;
  group: CommandGroup;
  shortcut?: string;
  run: () => void;
  disabled?: boolean;
  checked?: boolean;
  /** A separator is drawn above this item in its menu. */
  sepBefore?: boolean;
}

/** Keys that do something but are not a menu command (movement, tab switching, the pointer modifier). */
export const fixedShortcuts: ReadonlyArray<{ group: string; label: string; shortcut: string }> = [
  { group: 'Canvas', label: 'Nudge the selection by 1 point', shortcut: 'Arrow keys' },
  { group: 'Canvas', label: 'Nudge the selection by 10 points', shortcut: 'Shift+Arrow keys' },
  { group: 'Canvas', label: 'Delete the selection', shortcut: 'Backspace' },
  { group: 'Canvas', label: 'Return to the Select tool', shortcut: 'Esc' },
  { group: 'Canvas', label: 'Pick one member of a group', shortcut: 'Ctrl+click' },
  { group: 'Tabs', label: 'Next tab (most recently used)', shortcut: 'Ctrl+Tab' },
  { group: 'Tabs', label: 'Previous tab (most recently used)', shortcut: 'Ctrl+Shift+Tab' },
  { group: 'Tabs', label: 'Next tab in order', shortcut: 'Ctrl+PageDown' },
  { group: 'Tabs', label: 'Previous tab in order', shortcut: 'Ctrl+PageUp' },
  { group: 'Tabs', label: 'Move the focused tab', shortcut: 'Ctrl+Shift+Arrow keys' },
];

/**
 * The one list of commands. The menus, the shortcut list and the command palette all render it, so they cannot disagree about what exists
 * or which key runs it. Arrange comes from the shared arrange actions, which the context menu and Arrange panel also use.
 */
export function appCommands(model: EditorModel, ws: WorkspaceModel): AppCommand[] {
  const hasSelection = model.selection.length > 0;
  const page = model.currentPage;
  const arrange: AppCommand[] = [];
  let section = '';
  for (const a of arrangeActions(model)) {
    arrange.push({ id: a.id, label: a.label, group: 'Arrange', run: a.run, disabled: a.disabled, ...(a.shortcut ? { shortcut: a.shortcut } : {}), ...(section && a.section !== section ? { sepBefore: true } : {}) });
    section = a.section;
  }
  return [
    { id: 'new', label: 'New…', group: 'File', shortcut: 'Ctrl+N', run: () => model.newDocument.begin() },
    { id: 'open', label: 'Open…', group: 'File', shortcut: 'Ctrl+O', run: () => void ws.openFile() },
    { id: 'recent', label: 'Recent files…', group: 'File', run: () => ws.showRecent() },
    { id: 'save', label: 'Save', group: 'File', shortcut: 'Ctrl+S', run: () => void model.save(false) },
    { id: 'save-as', label: 'Save as…', group: 'File', shortcut: 'Ctrl+Shift+S', run: () => void model.save(true) },
    { id: 'open-visio', label: 'Open Visio drawing…', group: 'File', sepBefore: true, run: () => void ws.openFile('vsdx') },
    { id: 'close-tab', label: 'Close tab', group: 'File', shortcut: 'Ctrl+W', run: () => void ws.closeTab(model) },
    { id: 'export-image', label: 'Export image…', group: 'File', run: () => model.beginImageExport() },
    { id: 'export-pdf', label: 'Export PDF (all pages)…', group: 'File', run: () => model.beginImageExport('pdf') },
    { id: 'print', label: 'Print…', group: 'File', shortcut: 'Ctrl+P', run: () => model.beginPrint() },
    { id: 'export-visio', label: 'Export to Visio (.vsdx)…', group: 'File', run: () => void model.exportVsdx() },

    { id: 'undo', label: 'Undo', group: 'Edit', shortcut: 'Ctrl+Z', run: () => void model.undo() },
    { id: 'redo', label: 'Redo', group: 'Edit', shortcut: 'Ctrl+Y', run: () => void model.redo() },
    { id: 'copy-image', label: 'Copy as image', group: 'Edit', sepBefore: true, run: () => void model.finishImageExport(true), disabled: !hasSelection },
    { id: 'copy', label: 'Copy', group: 'Edit', shortcut: 'Ctrl+C', run: () => model.copy(), disabled: !hasSelection },
    { id: 'paste', label: 'Paste', group: 'Edit', shortcut: 'Ctrl+V', run: () => void ws.pasteFromClipboard() },
    { id: 'duplicate', label: 'Duplicate', group: 'Edit', shortcut: 'Ctrl+D', run: () => void model.duplicate(), disabled: !hasSelection },
    { id: 'delete', label: 'Delete', group: 'Edit', shortcut: 'Del', run: () => void model.deleteSelection(), disabled: !hasSelection },
    { id: 'find', label: 'Find and replace…', group: 'Edit', shortcut: 'Ctrl+F', sepBefore: true, run: () => model.find.open() },
    { id: 'select-style', label: 'Select same style', group: 'Edit', run: () => model.selectMatching('style'), disabled: model.targets.length !== 1 },
    { id: 'select-layers', label: 'Select same layer membership', group: 'Edit', run: () => model.selectMatching('layers'), disabled: model.targets.length !== 1 },
    { id: 'select-all', label: 'Select all', group: 'Edit', shortcut: 'Ctrl+A', run: () => model.selectAll() },
    { id: 'connect', label: 'Connect objects…', group: 'Edit', sepBefore: true, run: () => model.beginConnect() },
    { id: 'preferences', label: 'Preferences…', group: 'Edit', sepBefore: true, run: () => void ws.openPreferences() },
    { id: 'routing-defaults', label: 'Routing defaults…', group: 'Edit', run: () => model.openRoutingDefaults() },

    ...arrange,
    { id: 'beautify-preview', label: 'Preview Beautify…', group: 'Arrange', sepBefore: true, run: () => model.beginBeautify(model.selection.length ? 'selection' : 'page') },

    { id: 'zoom-in', label: 'Zoom in', group: 'View', shortcut: 'Ctrl++', run: () => model.zoomBy(1.25) },
    { id: 'zoom-out', label: 'Zoom out', group: 'View', shortcut: 'Ctrl+-', run: () => model.zoomBy(0.8) },
    { id: 'zoom-fit', label: 'Fit page', group: 'View', shortcut: 'Ctrl+0', run: () => model.zoomToFit() },
    { id: 'zoom-100', label: 'Actual size', group: 'View', run: () => model.zoomReset() },
    { id: 'grid', label: 'Show grid', group: 'View', sepBefore: true, checked: page.grid.visible, run: () => void model.toggleGrid('visible') },
    { id: 'guides', label: 'Show guides', group: 'View', checked: model.showGuides, run: () => model.toggleGuides('showGuides') },
    { id: 'snap-guides', label: 'Snap to guides', group: 'View', checked: model.snapToGuides, run: () => model.toggleGuides('snapToGuides') },
    { id: 'snap', label: 'Snap to grid', group: 'View', checked: page.grid.snap, run: () => void model.toggleGrid('snap') },
    { id: 'route-diagnostics', label: 'Show route diagnostics', group: 'View', checked: model.showRouteDiagnostics, run: () => model.toggleRouteDiagnostics() },
    { id: 'script-drawer', label: 'Script drawer', group: 'View', sepBefore: true, checked: model.drawerOpen && model.drawerTab === 'script', run: () => model.toggleDrawer('script') },
    { id: 'transaction-drawer', label: 'Transactions', group: 'View', checked: model.drawerOpen && model.drawerTab === 'transactions', run: () => model.toggleDrawer('transactions') },

    { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Help', run: () => void ws.help.show('shortcuts') },
    { id: 'palette', label: 'Command palette…', group: 'Help', shortcut: 'Ctrl+Shift+P', run: () => void ws.help.show('palette') },
    { id: 'about', label: 'About', group: 'Help', sepBefore: true, run: () => void ws.help.show('about') },
  ];
}

/** Commands whose name (or menu) contains every word typed, best matches first: names that start with the query, then word starts, then the rest. */
export function filterCommands(commands: readonly AppCommand[], query: string): AppCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...commands];
  const scored: Array<{ c: AppCommand; score: number; i: number }> = [];
  commands.forEach((c, i) => {
    const label = c.label.toLowerCase().replace(/…$/, '');
    const hay = `${label} ${c.group.toLowerCase()}`;
    if (!words.every(w => hay.includes(w))) return;
    const score = label.startsWith(words.join(' ')) ? 0 : words.every(w => label.split(/\s+/).some(t => t.startsWith(w))) ? 1 : 2;
    scored.push({ c, score, i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map(s => s.c);
}
