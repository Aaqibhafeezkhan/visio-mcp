import { useState } from 'react';
import { arrangeActions } from '../editor/arrangeActions';
import type { EditorModel } from '../editor/EditorModel';
import { useModel } from './useModel';

const SHORT: Record<string, string> = {
  group: 'Group', ungroup: 'Ungroup',
  'make-container': 'Make', 'add-to-container': 'Add', 'remove-from-container': 'Remove', 'disband-container': 'Disband', front: 'To front', forward: 'Forward', backward: 'Backward', back: 'To back',
  'align-left': 'Left', 'align-center': 'Centre', 'align-right': 'Right', 'align-top': 'Top', 'align-middle': 'Middle', 'align-bottom': 'Bottom',
  'distribute-h': 'Across', 'distribute-v': 'Down',
};

/** Grouping, stacking, alignment and spacing for the current selection. Every button goes through the same model commands as the menu. */
export function ArrangePanel({ model }: { model: EditorModel }) {
  useModel(model);
  const [gap, setGap] = useState('10');
  const [level, setLevel] = useState('');
  const actions = arrangeActions(model);
  const btn = (id: string) => {
    const a = actions.find(x => x.id === id)!;
    return <button key={id} type="button" data-testid={`arrange-${id}`} title={a.label + (a.shortcut ? ` (${a.shortcut})` : '')} disabled={a.disabled} onClick={a.run}>{SHORT[id]}</button>;
  };
  const n = model.targets.length;
  const gapPt = model.fromUnit(Number(gap));
  const canGap = n >= 2 && gap.trim() !== '' && Number.isFinite(gapPt) && gapPt >= 0;
  const levelValue = Number(level);
  const canSetLevel = n > 0 && level.trim() !== '' && Number.isInteger(levelValue) && levelValue >= -127 && levelValue <= 127;
  return (
    <section className="arrange-panel" aria-label="Arrange" data-testid="arrange-panel">
      <h3>Arrange</h3>
      <div className="row wrap">{btn('group')}{btn('ungroup')}</div>
      <h4>Container</h4>
      <div className="row wrap">{['make-container', 'add-to-container', 'remove-from-container', 'disband-container'].map(btn)}</div>
      <h4>Order</h4>
      <div className="row wrap">{['front', 'forward', 'backward', 'back'].map(btn)}</div>
      <div className="row wrap">
        <label className="field inline"><span>Level</span>
          <input type="number" min={-127} max={127} step="1" value={level} data-testid="arrange-level-input" onChange={e => setLevel(e.target.value)} />
        </label>
        <button type="button" data-testid="arrange-level-set" disabled={!canSetLevel} title="Set the selected objects' stacking level" onClick={() => void model.moveToLevel(levelValue)}>Move to level</button>
      </div>
      <h4>Align</h4>
      <div className="row wrap">{['align-left', 'align-center', 'align-right', 'align-top', 'align-middle', 'align-bottom'].map(btn)}</div>
      <h4>Space evenly</h4>
      <div className="row wrap">{['distribute-h', 'distribute-v'].map(btn)}</div>
      <div className="row wrap">
        <label className="field inline"><span>Gap ({model.unit})</span>
          <input type="number" min={0} step="any" value={gap} data-testid="arrange-gap-input" onChange={e => setGap(e.target.value)} />
        </label>
        <button type="button" data-testid="arrange-gap-h" disabled={!canGap} title="Set the horizontal gap between the selected objects" onClick={() => void model.setGap('horizontal', gapPt)}>Across</button>
        <button type="button" data-testid="arrange-gap-v" disabled={!canGap} title="Set the vertical gap between the selected objects" onClick={() => void model.setGap('vertical', gapPt)}>Down</button>
      </div>
    </section>
  );
}
