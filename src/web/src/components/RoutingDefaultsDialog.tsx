import { useEffect, useRef } from 'react';
import type { EditorModel } from '../editor/EditorModel';
import { useModel } from './useModel';

export function RoutingDefaultsDialog({ model }: { model: EditorModel }) {
  useModel(model);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!model.routingDefaultsOpen) return;
    const app = document.querySelector('.app');
    const opener = document.querySelector<HTMLElement>('[data-testid="menu-edit"]');
    const siblings = Array.from(app?.children ?? []).filter(child => child !== box.current?.parentElement) as HTMLElement[];
    for (const sibling of siblings) sibling.inert = true;
    box.current?.querySelector<HTMLElement>('select:not(:disabled),button:not(:disabled)')?.focus();
    return () => { for (const sibling of siblings) sibling.inert = false; if (opener?.isConnected) opener.focus(); };
  }, [model, model.routingDefaultsOpen]);

  if (!model.routingDefaultsOpen) return null;
  const crossing = model.snapshot.document.routingDefaults?.crossing ?? 'default';
  return <div className="dialog-backdrop" role="presentation"><div ref={box} tabIndex={-1} className="dialog" role="dialog" aria-modal="true" aria-labelledby="routing-defaults-title" data-testid="routing-defaults-dialog"
    onKeyDown={e => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); model.closeRoutingDefaults(); }
      if (e.key === 'Tab') {
        const items = Array.from(box.current!.querySelectorAll<HTMLElement>('select:not(:disabled),button:not(:disabled)'));
        if (!items.length) { e.preventDefault(); box.current?.focus(); }
        else if (e.shiftKey && document.activeElement === items[0]) { e.preventDefault(); items.at(-1)?.focus(); }
        else if (!e.shiftKey && document.activeElement === items.at(-1)) { e.preventDefault(); items[0]?.focus(); }
      }
    }}>
    <h2 id="routing-defaults-title">Routing defaults</h2>
    <p>These defaults apply only when you preview Beautify. Ordinary edits keep existing routes.</p>
    <label className="field"><span>Connector crossings</span>
      <select aria-label="Default crossing policy" data-testid="routing-default-crossing" value={crossing} onChange={e => void model.apply('inspector', [{ op: 'setRoutingDefaults', crossing: e.target.value === 'default' ? null : e.target.value as 'avoid' | 'allow' }])}>
        <option value="default">Default (avoid crossings)</option><option value="avoid">Avoid crossings</option><option value="allow">Allow crossings</option>
      </select>
    </label>
    <div className="row dialog-actions"><button type="button" data-testid="routing-defaults-close" onClick={() => model.closeRoutingDefaults()}>Close</button></div>
  </div></div>;
}
