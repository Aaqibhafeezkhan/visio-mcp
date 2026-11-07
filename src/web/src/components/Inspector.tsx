import { useEffect, useState } from 'react';
import type { ConnectorElement, Element, ImageElement, Operation, Paint, RoutingPolicy, ShapeElement, TextBlock, TextElement } from '../contracts/generated';
import type { EditorModel } from '../editor/EditorModel';
import { ArrangePanel } from './ArrangePanel';
import { useModel } from './useModel';
import { textDefaults } from '../model/documentDefaults';
import { planRoutes } from '../layout/routePlanner';
import { runIndexOf, segmentsOf } from '../layout/routeSegments';

const round = (v: number) => Math.round(v * 1000) / 1000;

const FONT_FAMILIES = ['Segoe UI', 'Arial', 'Calibri', 'Consolas', 'Times New Roman'];

/** A field that edits locally and commits one transaction on Enter or blur, so typing never makes a revision per keystroke. */
function NumberField({ label, value, onCommit, testId, step = 'any', min }: { label: string; value: number; onCommit: (v: number) => void; testId: string; step?: string; min?: number }) {
  const [text, setText] = useState(String(round(value)));
  useEffect(() => setText(String(round(value))), [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n) && round(n) !== round(value)) onCommit(n);
    else setText(String(round(value)));
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" value={text} step={step} min={min} data-testid={testId}
        onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

function PaintField({ label, paint, testId, onCommit, gradients = false }: { label: string; paint: Paint; testId: string; onCommit: (p: Paint) => void; gradients?: boolean }) {
  if (paint.kind === 'linear-gradient') {
    const first = paint.stops[0]!, last = paint.stops[paint.stops.length - 1]!;
    const withStops = (a: typeof first, b: typeof last): Paint => ({ ...paint, stops: [a, ...paint.stops.slice(1, -1), b] });
    return (
      <div className="field paint gradient" data-testid={`${testId}-gradient`}>
        <span>{label}</span>
        <select value="gradient" aria-label={`${label} type`} data-testid={`${testId}-kind`} onChange={e => onCommit(e.target.value === 'solid' ? { kind: 'solid', colour: first.colour, opacity: first.opacity } : e.target.value === 'none' ? { kind: 'none' } : paint)}>
          <option value="solid">Solid</option><option value="gradient">Gradient</option><option value="none">None</option>
        </select>
        <input type="color" value={first.colour} aria-label={`${label} gradient start`} data-testid={`${testId}-stop-first`} onChange={e => onCommit(withStops({ ...first, colour: e.target.value }, last))} />
        <input type="color" value={last.colour} aria-label={`${label} gradient end`} data-testid={`${testId}-stop-last`} onChange={e => onCommit(withStops(first, { ...last, colour: e.target.value }))} />
        <input type="number" min={-360} max={360} value={paint.angleDeg} aria-label={`${label} gradient angle`} data-testid={`${testId}-angle`}
          onChange={e => onCommit({ ...paint, angleDeg: Math.min(360, Math.max(-360, Number(e.target.value) || 0)) })} />
        <small>° (0 left to right, 90 top to bottom){paint.stops.length > 2 ? `, ${paint.stops.length} stops` : ''}</small>
      </div>
    );
  }
  const colour = paint.kind === 'solid' ? paint.colour : '#ffffff';
  const opacity = paint.kind === 'solid' ? paint.opacity : 1;
  return (
    <div className="field paint">
      <span>{label}</span>
      <input type="checkbox" checked={paint.kind === 'none'} aria-label={`${label}: none`} data-testid={`${testId}-none`}
        onChange={e => onCommit(e.target.checked ? { kind: 'none' } : { kind: 'solid', colour, opacity })} /> <small>none</small>
      <input type="color" value={colour} disabled={paint.kind === 'none'} data-testid={`${testId}-colour`}
        onChange={e => onCommit({ kind: 'solid', colour: e.target.value, opacity })} />
      <input type="number" min={0} max={100} value={Math.round(opacity * 100)} disabled={paint.kind === 'none'} aria-label={`${label} opacity %`} data-testid={`${testId}-opacity`}
        onChange={e => onCommit({ kind: 'solid', colour, opacity: Math.min(1, Math.max(0, Number(e.target.value) / 100)) })} />
      {gradients && paint.kind === 'solid' && (
        <button type="button" data-testid={`${testId}-to-gradient`} title="Blend from this colour to white"
          onClick={() => onCommit({ kind: 'linear-gradient', angleDeg: 90, stops: [{ offset: 0, colour, opacity }, { offset: 1, colour: '#ffffff', opacity }] })}>Gradient</button>
      )}
    </div>
  );
}

/** R17: a container's fit and margin, and for a member the container it is in. Each change is one transaction, as elsewhere here. */
function ContainerFields({ el, model, set }: { el: Element; model: EditorModel; set: (patch: Record<string, unknown>) => void }) {
  const page = model.pageOfElement(el.id);
  const holder = page.elements.find(e => e.kind === 'shape' && e.container?.memberIds.includes(el.id));
  const box = el.kind === 'shape' ? el.container : undefined;
  if (!box && !holder) return null;
  const label = (e: Element) => e.name ?? e.alias ?? (e.kind === 'shape' ? e.text?.value : undefined) ?? 'a container';
  return (
    <section data-testid="container-fields">
      <h3>Container</h3>
      {box && <>
        <p className="muted small" data-testid="container-members">Holds {box.memberIds.length} object{box.memberIds.length === 1 ? '' : 's'}; they move with it and keep their size when it is resized.</p>
        <label className="field"><span>Fit</span>
          <select value={box.fit ?? 'none'} data-testid="field-container-fit" onChange={e => set({ container: { fit: e.target.value } })}>
            <option value="none">Leave its size alone</option><option value="grow">Grow to keep its members inside</option><option value="fit">Fit its members exactly</option>
          </select>
        </label>
        <NumberField label="Margin pt" testId="field-container-margin" value={box.marginPt ?? 0} min={0} onCommit={v => set({ container: { marginPt: Math.max(0, Math.min(500, v)) } })} />
        <button type="button" data-testid="container-disband" title="Stop this shape being a container; what it holds moves up a level" onClick={() => set({ container: null })}>Disband</button>
      </>}
      {holder && <>
        <p className="muted small" data-testid="container-holder">Inside {label(holder)}.</p>
        <button type="button" data-testid="container-remove" title="Take this object out of its container" onClick={() => void model.apply('inspector', [{ op: 'contain', container: holder.id, remove: [el.id] }])}>Remove from container</button>
      </>}
    </section>
  );
}

function RoutingPolicyFields({ policy, hasText, setPolicy, includeObstacle }: {
  policy: RoutingPolicy | undefined;
  hasText: boolean;
  setPolicy: (patch: Partial<RoutingPolicy>) => void;
  includeObstacle: boolean;
}) {
  return (
    <section>
      <h3>Routing policy</h3>
      {includeObstacle && <>
        <label className="field"><span>Obstacle policy</span>
          <select value={policy?.obstacle ?? 'automatic'} data-testid="field-obstacle-policy" onChange={e => setPolicy({ obstacle: e.target.value as NonNullable<RoutingPolicy['obstacle']> })}>
            <option value="automatic">Automatic</option><option value="forbidden">Forbidden</option><option value="avoid">Avoid if possible</option><option value="passThrough">Pass through</option>
          </select>
        </label>
        <NumberField label="Route clearance pt" testId="field-route-clearance" value={policy?.clearancePt ?? 0} min={0} onCommit={v => setPolicy({ clearancePt: v })} />
      </>}
      {hasText && <label className="field"><span>Text obstacle policy</span>
        <select value={policy?.text ?? 'ignore'} data-testid={includeObstacle ? 'field-text-obstacle-policy' : 'field-label-obstacle-policy'} onChange={e => setPolicy({ text: e.target.value as NonNullable<RoutingPolicy['text']> })}>
          <option value="ignore">Ignore nearby text</option><option value="avoid">Avoid nearby text</option>
        </select>
      </label>}
    </section>
  );
}

export function Inspector({ model }: { model: EditorModel }) {
  useModel(model);
  const els = model.selectedElements();
  const set = (patch: Record<string, unknown>) => void model.apply('inspector', els.map(e => ({ op: 'set', target: e.id, patch }) as Operation));

  if (els.length === 0) {
    const page = model.currentPage;
    return (
      <aside className="panel panel-right" aria-label="Inspector">
        <h2>Page</h2>
        <p className="muted">{page.name}: {model.toUnit(page.widthPt).toFixed(1)} × {model.toUnit(page.heightPt).toFixed(1)} {model.unit}</p>
        <p className="muted">Grid {page.grid.visible ? 'shown' : 'hidden'}, {page.grid.snap ? 'snapping' : 'free'}, every {model.toUnit(page.grid.spacingPt).toFixed(1)} {model.unit}</p>
        <p className="muted">Select an object to edit it.</p>
      </aside>
    );
  }

  if (els.length > 1) {
    const shapes = els.filter((e): e is ShapeElement => e.kind === 'shape');
    const connectors = els.filter((e): e is ConnectorElement => e.kind === 'connector');
    const connector = connectors.length === 1 ? connectors[0] : undefined;
    const pinnable = connector ? els.filter(e => (e.kind === 'shape' || e.kind === 'text') && e.id !== connector.from.elementId && e.id !== connector.to.elementId) : [];
    return (
      <aside className="panel panel-right" aria-label="Inspector">
        <h2>{els.length} objects</h2>
        {shapes.length > 0 && (
          <section>
            <h3>Style</h3>
            <PaintField label="Fill" testId="multi-fill" paint={shapes[0]!.style.fill} onCommit={fill => void model.apply('inspector', shapes.map(s => ({ op: 'set', target: s.id, patch: { style: { fill } } }) as Operation))} />
            <PaintField label="Line" testId="multi-stroke" paint={shapes[0]!.style.stroke} onCommit={stroke => void model.apply('inspector', shapes.map(s => ({ op: 'set', target: s.id, patch: { style: { stroke } } }) as Operation))} />
          </section>
        )}
        {pinnable.length > 0 && (
          <section>
            <h3>On a connector</h3>
            <button type="button" data-testid="pin-to-connector" title="Pin the selected shapes and text to the middle of the selected connector, so they follow it"
              onClick={() => void model.apply('inspector', pinnable.map(e => ({ op: 'set', target: e.id, patch: { attachment: { connector: connector!.id, position: 0.5, offsetPt: 0 } } }) as Operation))}>Pin to connector</button>
          </section>
        )}
        <section>
          <h3>Arrange</h3>
          <button type="button" onClick={() => void model.duplicate()}>Duplicate</button>{' '}
          <button type="button" onClick={() => void model.deleteSelection()} data-testid="inspector-delete">Delete</button>
        </section>
        <ArrangePanel model={model} />
      </aside>
    );
  }

  const el = els[0]!;
  const u = model.unit;
  const geometry = el.kind !== 'connector';
  const isGroup = el.kind === 'group';
  const move = (dx: number, dy: number) => void model.apply('inspector', [{ op: 'move', target: el.id, delta: { xPt: dx, yPt: dy } }]);
  const text: TextBlock | undefined = el.kind === 'shape' ? el.text ?? textDefaults(model.snapshot.document) : el.kind === 'text' ? el.text : el.kind === 'connector' ? el.label ?? textDefaults(model.snapshot.document) : undefined;
  const setText = (patch: Partial<TextBlock>) => set({ text: patch });

  return (
    <aside className="panel panel-right" aria-label="Inspector" data-testid="inspector" key={el.id}>
      <h2>{el.kind[0]!.toUpperCase() + el.kind.slice(1)}</h2>
      <label className="field"><span>Name</span>
        <input type="text" defaultValue={el.name ?? ''} data-testid="field-name" key={`${el.id}-${el.name}`}
          onBlur={e => { if (e.target.value !== (el.name ?? '')) set({ name: e.target.value === '' ? null : e.target.value }); }} />
      </label>

      {geometry && (
        <section>
          <h3>Geometry ({u})</h3>
          <div className="grid2">
            <NumberField label="X" testId="field-x" value={model.toUnit(el.bounds.x)} onCommit={v => move(model.fromUnit(v) - el.bounds.x, 0)} />
            <NumberField label="Y" testId="field-y" value={model.toUnit(el.bounds.y)} onCommit={v => move(0, model.fromUnit(v) - el.bounds.y)} />
            <NumberField label="W" testId="field-w" value={model.toUnit(el.bounds.width)} min={0} onCommit={v => void model.apply('inspector', [{ op: 'resize', target: el.id, bounds: { width: model.fromUnit(v) } }])} />
            <NumberField label="H" testId="field-h" value={model.toUnit(el.bounds.height)} min={0} onCommit={v => void model.apply('inspector', [{ op: 'resize', target: el.id, bounds: { height: model.fromUnit(v) } }])} />
            {isGroup
              ? <NumberField label="Turn by °" testId="field-turn" key={`turn-${model.snapshot.revision}`} value={0} onCommit={v => void model.apply('inspector', [{ op: 'rotate', target: el.id, deltaDeg: v }])} />
              : <NumberField label="Angle °" testId="field-angle" value={el.rotationDeg} onCommit={v => void model.apply('inspector', [{ op: 'rotate', target: el.id, angleDeg: v }])} />}
          </div>
        </section>
      )}

      {el.kind === 'shape' && <ShapeStyle model={model} el={el} set={set} />}
      {el.kind === 'connector' && <ConnectorStyle el={el} set={set} model={model} />}
      {(el.kind === 'shape' || el.kind === 'text' || el.kind === 'connector') && (
        <RoutingPolicyFields policy={el.routingPolicy} hasText={Boolean(text?.value.trim())} includeObstacle={el.kind !== 'connector'}
          setPolicy={patch => set({ routingPolicy: { ...(el.routingPolicy ?? {}), ...patch } })} />
      )}
      {(el.kind === 'shape' || el.kind === 'text') && el.attachment && <Pin el={el} model={model} set={set} />}
      <ContainerFields el={el} model={model} set={set} />
      {el.kind === 'image' && <ImageProps el={el} model={model} set={set} />}

      {text && (
        <section>
          <h3>Text</h3>
          <textarea defaultValue={text.value} rows={3} data-testid="field-text" key={`${el.id}-${text.value}`}
            onBlur={e => { if (e.target.value !== text.value) setText({ value: e.target.value }); }} />
          <div className="grid2">
            <NumberField label="Size pt" testId="field-fontsize" value={text.fontSizePt} min={1} onCommit={v => setText({ fontSizePt: v })} />
            <label className="field"><span>Font</span>
              <select value={text.fontFamily} data-testid="field-font" onChange={e => setText({ fontFamily: e.target.value })}>
                {[...new Set([text.fontFamily, ...FONT_FAMILIES])].map(f => <option key={f}>{f}</option>)}
              </select>
            </label>
          </div>
          <div className="row">
            {(['bold', 'italic', 'underline'] as const).map(k => (
              <label key={k}><input type="checkbox" checked={text[k]} data-testid={`field-${k}`} onChange={e => setText({ [k]: e.target.checked })} /> {k[0]!.toUpperCase() + k.slice(1)}</label>
            ))}
            <label><input type="checkbox" checked={text.wrap} data-testid="field-wrap" onChange={e => setText({ wrap: e.target.checked })} /> Wrap</label>
            <label><input type="checkbox" checked={text.orientation === 'vertical'} data-testid="field-vertical" onChange={e => setText({ orientation: e.target.checked ? 'vertical' : 'horizontal' })} /> Vertical</label>
          </div>
          <div className="grid2">
            {(['top', 'right', 'bottom', 'left'] as const).map(side => (
              <NumberField key={side} label={`Margin ${side} pt`} testId={`field-margin-${side}`} value={(text.insetsPt ?? { top: text.paddingPt, right: text.paddingPt, bottom: text.paddingPt, left: text.paddingPt })[side]} min={0}
                onCommit={v => set({ text: { insetsPt: { [side]: v } } })} />
            ))}
          </div>
          <div className="grid2">
            <label className="field"><span>Align</span>
              <select value={text.horizontalAlign} data-testid="field-halign" onChange={e => setText({ horizontalAlign: e.target.value as TextBlock['horizontalAlign'] })}>
                <option>left</option><option>center</option><option>right</option>
              </select>
            </label>
            <label className="field"><span>Vertical</span>
              <select value={text.verticalAlign} data-testid="field-valign" onChange={e => setText({ verticalAlign: e.target.value as TextBlock['verticalAlign'] })}>
                <option>top</option><option>middle</option><option>bottom</option>
              </select>
            </label>
          </div>
        </section>
      )}

      <section>
        <h3>Arrange</h3>
        <div className="row">
          <label><input type="checkbox" checked={el.locked} data-testid="field-locked" onChange={e => set({ locked: e.target.checked })} /> Locked</label>
          {!isGroup && <label><input type="checkbox" checked={el.hidden} data-testid="field-hidden" onChange={e => set({ hidden: e.target.checked })} /> Hidden</label>}
        </div>
        <button type="button" onClick={() => void model.duplicate()} data-testid="inspector-duplicate">Duplicate</button>{' '}
        <button type="button" onClick={() => void model.deleteSelection()} data-testid="inspector-delete">Delete</button>
      </section>

      <ArrangePanel model={model} />

      {!isGroup && <section>
        <h3>Layers</h3>
        {model.currentPage.layers.map(l => (
          <label key={l.id} className="row"><input type="checkbox" checked={el.layerIds.includes(l.id)} data-testid={`layer-${l.name}`}
            onChange={e => set({ layerIds: e.target.checked ? [...el.layerIds, l.id] : el.layerIds.filter(x => x !== l.id) })} /> {l.name}</label>
        ))}
      </section>}
      <p className="muted small" title={el.id}>id {el.id.slice(0, 8)}…</p>
    </aside>
  );
}

function ShapeStyle({ el, set }: { model: EditorModel; el: ShapeElement; set: (p: Record<string, unknown>) => void }) {
  return (
    <section>
      <h3>Style</h3>
      <PaintField label="Fill" testId="field-fill" paint={el.style.fill} gradients onCommit={fill => set({ style: { fill } })} />
      <PaintField label="Line" testId="field-stroke" paint={el.style.stroke} onCommit={stroke => set({ style: { stroke } })} />
      <div className="grid2">
        <NumberField label="Width pt" testId="field-strokewidth" value={el.style.strokeWidthPt} min={0} onCommit={v => set({ style: { strokeWidthPt: v } })} />
        <label className="field"><span>Dash</span>
          <select value={el.style.dash} data-testid="field-dash" onChange={e => set({ style: { dash: e.target.value } })}>
            <option>solid</option><option>dashed</option><option>dotted</option><option>dash-dot</option>
          </select>
        </label>
      </div>
    </section>
  );
}

/** A shape or text box riding on a connector: where along it, and how far to its side. Dragging it slides it along. */
function Pin({ el, model, set }: { el: ShapeElement | TextElement; model: EditorModel; set: (p: Record<string, unknown>) => void }) {
  const a = el.attachment!;
  const connector = model.snapshot.document.pages.flatMap(p => p.elements).find(e => e.id === a.connectorId);
  const to = (position: number, offsetPt: number) => set({ attachment: { connector: a.connectorId, position: Math.min(1, Math.max(0, position)), offsetPt } });
  return (
    <section data-testid="pin">
      <h3>On a connector</h3>
      <p className="muted small">Follows {connector?.alias ?? connector?.name ?? 'its connector'}; drag it to slide it along.</p>
      <div className="grid2">
        <NumberField label="Along %" testId="field-pin-at" value={Math.round(a.position * 100)} min={0} onCommit={v => to(v / 100, a.offsetPt)} />
        <NumberField label="Offset pt" testId="field-pin-offset" value={a.offsetPt} onCommit={v => to(a.position, v)} />
      </div>
      <button type="button" data-testid="pin-detach" onClick={() => set({ attachment: null })}>Detach</button>
    </section>
  );
}

/** Numeric position of each inner run, in the document's units. Same operation, same undo as dragging the handle. */
function RunFields({ el, model }: { el: ConnectorElement; model: EditorModel }) {
  const page = model.pageOfElement(el.id);
  const points = planRoutes({ elements: page.elements, layers: page.layers, pageArea: page.widthPt * page.heightPt }).routes.get(el.id)?.points;
  const runs = points ? segmentsOf(points).filter(s => s.movable && s.length > 0) : [];
  if (!runs.length) return null;
  const pinned = new Set((el.routing?.constraints ?? []).map(c => runIndexOf(points!, c.axis, c.index)));
  const automatic = !el.waypoints.length && el.routing?.mode !== 'frozen';
  return (
    <div className="grid2">
      {runs.map(r => (
        <div key={r.index} className="run-row">
          <NumberField label={`Run ${r.index} ${r.axis === 'h' ? 'y' : 'x'} ${model.unit}`} testId={`field-run-${r.index}`} value={model.toUnit(r.coord)}
            onCommit={v => void model.apply('inspector', [{ op: 'moveSegment', target: el.id, segment: r.index, to: model.fromUnit(v) }] as Operation[])} />
          {automatic && (
            <label className="field"><span>Pinned</span>
              <input type="checkbox" checked={pinned.has(r.index)} data-testid={`run-pin-${r.index}`} title="Hold this run where it is when the router plans the route again"
                onChange={e => void model.apply('inspector', [{ op: 'pinSegment', target: el.id, segment: r.index, pinned: e.target.checked }] as Operation[])} />
            </label>
          )}
        </div>
      ))}
    </div>
  );
}

/** R16: a connector's end can be a branch joined to another connector. Done from here as well as by dragging, so it needs no pointer. */
function JoinEnd({ el, end, model, set }: { el: ConnectorElement; end: 'from' | 'to'; model: EditorModel; set: (p: Record<string, unknown>) => void }) {
  const ep = el[end];
  const label = end === 'from' ? 'Start' : 'End';
  const connectors = model.currentPage.elements.filter((e): e is ConnectorElement => e.kind === 'connector');
  const nameOf = (c: ConnectorElement) => c.alias ?? c.name ?? `connector ${connectors.indexOf(c) + 1}`;
  const byId = new Map(connectors.map(c => [c.id, c] as const));
  /** joining it would make a loop when that connector, or one it joins in turn, is joined to this one */
  const loops = (candidate: ConnectorElement): boolean => {
    const seen = new Set<string>();
    for (let c: ConnectorElement | undefined = candidate; c && !seen.has(c.id); ) {
      if (c.id === el.id) return true;
      seen.add(c.id);
      const next: string | undefined = [c.from, c.to].find(e => e.join)?.join?.connectorId;
      c = next ? byId.get(next) : undefined;
    }
    return false;
  };
  if (ep.join) {
    const target = byId.get(ep.join.connectorId);
    return (
      <div className="grid2" data-testid={`join-${end}`}>
        <NumberField label={`${label} joins ${target ? nameOf(target) : 'a connector'} at %`} testId={`field-join-${end}-at`} value={Math.round(ep.join.position * 100)} min={0}
          onCommit={v => set({ [end]: { glue: 'none', join: { connector: ep.join!.connectorId, position: Math.min(1, Math.max(0, v / 100)) } } })} />
        <button type="button" data-testid={`join-${end}-release`} onClick={() => set({ [end]: { glue: 'none', point: ep.point } })}>Release {label.toLowerCase()}</button>
      </div>
    );
  }
  const options = ep.glue === 'none' ? connectors.filter(c => c.id !== el.id && !loops(c)) : [];
  if (options.length === 0) return null;
  return (
    <label className="field"><span>{label} joins a connector</span>
      <select value="" data-testid={`field-join-${end}`} onChange={e => { if (e.target.value) set({ [end]: { glue: 'none', join: { connector: e.target.value, position: 0.5 } } }); }}>
        <option value="">not joined</option>
        {options.map(c => <option key={c.id} value={c.id}>{nameOf(c)}</option>)}
      </select>
    </label>
  );
}

function ConnectorStyle({ el, set, model }: { el: ConnectorElement; set: (p: Record<string, unknown>) => void; model: EditorModel }) {
  const arrows = ['none', 'block', 'open', 'diamond', 'oval'];
  const routeFindings = model.canvas?.readProjection(model.snapshot, model.currentPage.id).connectors[el.id]?.routeFindings ?? [];
  return (
    <section>
      <h3>Connector</h3>
      <label className="field"><span>Colour</span><input type="color" value={el.style.colour} data-testid="field-line-colour" onChange={e => set({ style: { colour: e.target.value } })} /></label>
      <div className="grid2">
        <NumberField label="Width pt" testId="field-line-width" value={el.style.widthPt} min={0} onCommit={v => set({ style: { widthPt: v } })} />
        <label className="field"><span>Dash</span>
          <select value={el.style.dash} data-testid="field-line-dash" onChange={e => set({ style: { dash: e.target.value } })}><option>solid</option><option>dashed</option><option>dotted</option><option>dash-dot</option></select>
        </label>
        <label className="field"><span>Start</span>
          <select value={el.style.startArrow} data-testid="field-start-arrow" onChange={e => set({ style: { startArrow: e.target.value } })}>{arrows.map(a => <option key={a}>{a}</option>)}</select>
        </label>
        <label className="field"><span>End</span>
          <select value={el.style.endArrow} data-testid="field-end-arrow" onChange={e => set({ style: { endArrow: e.target.value } })}>{arrows.map(a => <option key={a}>{a}</option>)}</select>
        </label>
        <label className="field"><span>Start size</span>
          <select value={el.style.startArrowSize ?? 'medium'} data-testid="field-start-arrow-size" onChange={e => set({ style: { startArrowSize: e.target.value } })}><option>small</option><option>medium</option><option>large</option></select>
        </label>
        <label className="field"><span>End size</span>
          <select value={el.style.endArrowSize ?? 'medium'} data-testid="field-end-arrow-size" onChange={e => set({ style: { endArrowSize: e.target.value } })}><option>small</option><option>medium</option><option>large</option></select>
        </label>
        <label className="field"><span>Route</span>
          <select value={el.route} data-testid="field-route" onChange={e => set({ route: e.target.value })}><option>straight</option><option>orthogonal</option><option>curved</option></select>
        </label>
        {el.route === 'orthogonal' && (
          <>
            <label className="field"><span>Route mode</span>
              <select value={el.routing?.mode ?? (el.waypoints.length ? 'manual' : el.routing?.constraints?.length ? 'guided' : 'automatic')} data-testid="field-route-mode" title="Automatic: the router chooses and keeps the route. Manual: you control the bends. Frozen: the route is kept as it is."
                onChange={e => set({ routing: { mode: e.target.value } })}><option>automatic</option><option>manual</option><option>frozen</option>{el.routing?.constraints?.length ? <option disabled>guided</option> : null}</select>
            </label>
            <RunFields el={el} model={model} />
            {!el.routing?.mode && !el.waypoints.length && (
              <button type="button" data-testid="route-reroute" title="Forget the stored route and let the router plan it again" onClick={() => void model.apply('inspector', [{ op: 'reroute', targets: [el.id] }] as Operation[])}>Re-route</button>
            )}
          </>
        )}
      </div>
      <div className="grid2">
        <NumberField label="Label at %" testId="field-label-at" value={Math.round((el.labelAnchor?.position ?? 0.5) * 100)} min={0} onCommit={v => set({ labelAnchor: { position: Math.min(1, Math.max(0, v / 100)), offsetPt: el.labelAnchor?.offsetPt ?? 0 } })} />
        <NumberField label="Label offset pt" testId="field-label-offset" value={el.labelAnchor?.offsetPt ?? 0} onCommit={v => set({ labelAnchor: { position: el.labelAnchor?.position ?? 0.5, offsetPt: v } })} />
      </div>
      <p className="muted small">The offset is to the right of the line's direction; negative is to the left.</p>
      <label className="field"><span>Hops over crossings</span>
        <select value={el.hops ?? 'none'} data-testid="field-hops" disabled={el.route === 'curved'} onChange={e => set({ hops: e.target.value })}><option value="none">none</option><option value="arc">arc</option></select>
      </label>
      <JoinEnd el={el} end="from" model={model} set={set} />
      <JoinEnd el={el} end="to" model={model} set={set} />
      {(el.from.glue === 'dynamic' || el.to.glue === 'dynamic') && <div className="grid2">
        {(['from', 'to'] as const).filter(end => el[end].glue === 'dynamic').map(end => (
          <label className="field" key={end}><span>{end === 'from' ? 'Start' : 'End'} preferred side</span>
            <select value={el[end].preferredSide ?? ''} data-testid={`field-${end}-preferred-side`} onChange={e => set({ [end]: { ...el[end], ...(e.target.value ? { preferredSide: e.target.value } : { preferredSide: undefined }) } })}>
              <option value="">Automatic</option><option value="north">North</option><option value="east">East</option><option value="south">South</option><option value="west">West</option>
            </select>
          </label>
        ))}
      </div>}
      {routeFindings.filter(f => f.code === 'ROUTE_SIDE_PREFERENCE_RELAXED').map(f => <p className="muted small" data-testid="route-side-relaxed" key={f.code}>{f.message}</p>)}
      <p className="muted small">From {el.from.join ? 'a connector' : el.from.glue === 'none' ? 'a point' : 'a shape'} to {el.to.join ? 'a connector' : el.to.glue === 'none' ? 'a point' : 'a shape'}</p>
    </section>
  );
}

function ImageProps({ el, model, set }: { el: ImageElement; model: EditorModel; set: (p: Record<string, unknown>) => void }) {
  const asset = model.snapshot.document.assets.find(a => a.id === el.assetId);
  return (
    <section>
      <h3>Picture</h3>
      <p className="muted small" data-testid="image-asset" title={asset?.sha256}>{asset?.name ?? el.assetId} · {asset?.mimeType} · {asset?.sha256.slice(0, 12)}…</p>
      <div className="grid2">
        <label className="field"><span>Fit</span>
          <select value={el.fit} data-testid="field-fit" onChange={e => set({ fit: e.target.value })}><option>contain</option><option>cover</option><option>stretch</option></select>
        </label>
        <NumberField label="Opacity %" testId="field-image-opacity" value={Math.round(el.opacity * 100)} min={0} onCommit={v => set({ opacity: Math.min(1, Math.max(0, v / 100)) })} />
      </div>
    </section>
  );
}

export type { Element, TextElement };
