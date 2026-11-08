import { useEffect, useRef } from 'react';
import type { EditorModel } from '../editor/EditorModel';
import { useModel } from './useModel';

export function BeautifyDialog({ model }: { model: EditorModel }) {
  useModel(model);
  const prompt = model.beautifyPrompt;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('select:not(:disabled),button:not(:disabled)')?.focus();
    return () => { if (old?.isConnected) old.focus(); };
  }, []);
  if (!prompt) return null;
  const preview = prompt.preview;
  const stale = !!preview && model.snapshot.revision !== preview.baseRevision;
  const setScope = (scope: 'selection' | 'page') => {
    if (!model.beautifyPrompt) return;
    model.beautifyPrompt.scope = scope;
    model.bump();
    void model.refreshBeautify();
  };
  return <div className="dialog-backdrop" role="presentation"><div ref={box} className="dialog" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="beautify-title" data-testid="beautify-dialog" onKeyDown={e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); model.cancelBeautify(); }
  }}>
    <h2 id="beautify-title">Preview Beautify</h2>
    <label className="field"><span>Scope</span><select aria-label="Beautify scope" data-testid="beautify-scope" value={prompt.scope} disabled={prompt.busy} onChange={e => setScope(e.target.value as 'selection' | 'page')}>
      <option value="selection" disabled={!model.selection.length}>Selected objects</option><option value="page">Current page</option>
    </select></label>
    {prompt.busy && <p role="status">Planning routes…</p>}
    {prompt.error && <p role="alert" className="diag diag-warning">{prompt.error}</p>}
    {preview && <>
      {stale && <p role="alert" className="diag diag-warning">The drawing changed after this preview. Refresh before applying it.</p>}
      <p data-testid="beautify-changed-count">{preview.changedCount} connector{preview.changedCount === 1 ? '' : 's'} will change.</p>
      <div className="beautify-review">
        <h3>Proposed routes</h3>
        {preview.proposedRoutes.length ? <ul>{preview.proposedRoutes.map(route => <li key={route.id}>{model.currentPage.elements.find(e => e.id === route.id)?.name ?? route.id}</li>)}</ul> : <p>No route changes are proposed.</p>}
        {preview.skipped.length > 0 && <><h3>Skipped</h3><ul>{preview.skipped.map(item => <li key={item.id}><code>{item.id}</code>: {item.reason}</li>)}</ul></>}
      </div>
    </>}
    <div className="dialog-actions">
      <button type="button" data-testid="beautify-apply" disabled={prompt.busy || !preview?.proposedRoutes.length || stale} onClick={() => void model.acceptBeautify()}>Apply {preview?.changedCount ?? 0} route changes</button>
      <button type="button" data-testid="beautify-refresh" disabled={prompt.busy} onClick={() => void model.refreshBeautify()}>Refresh preview</button>
      <button type="button" disabled={prompt.busy && !prompt.abortController} onClick={() => model.cancelBeautify()}>Cancel</button>
    </div>
  </div></div>;
}
