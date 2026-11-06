import type { EditorModel } from '../editor/EditorModel';
import { useModel } from './useModel';

const SAMPLE = `# Each line is one command. The whole script is one undo step.
add shape id=api type=roundedRect x=40mm y=30mm w=60mm h=20mm text="API"
add shape id=db type=cylinder x=40mm y=80mm w=60mm h=30mm text="Database"
connect from=api.south to=db.north route=orthogonal endArrow=triangle
align center api db`;

/** Write, validate and run DrawScript. Validate plans against the current revision without committing; Run is one atomic transaction. */
export function ScriptDrawer({ model }: { model: EditorModel }) {
  useModel(model);
  const report = model.scriptReport;
  const outcome = model.scriptOutcome;
  const lines = model.scriptText.split('\n').length;
  const where = (d: { line?: number; column?: number }) => (d.line ? ` (line ${d.line}${d.column ? `, column ${d.column}` : ''})` : '');

  return (
    <div className="script-drawer" data-testid="script-drawer">
      <div className="script-edit">
        <textarea
          className="script-input" data-testid="script-input" spellCheck={false} rows={8} value={model.scriptText} placeholder={SAMPLE}
          aria-label="DrawScript" aria-invalid={report?.ok === false || outcome?.ok === false}
          onChange={e => { model.scriptText = e.target.value; model.bump(); }}
        />
        <div className="row">
          <button type="button" data-testid="script-validate" onClick={() => model.validateScriptText()} disabled={!model.scriptText.trim()}>Validate</button>
          <button type="button" data-testid="script-run" onClick={() => void model.runScriptText()} disabled={!model.scriptText.trim()}>Run</button>
          <button type="button" data-testid="script-example" onClick={() => { model.scriptText = SAMPLE; model.scriptReport = null; model.scriptOutcome = null; model.bump(); }}>Insert example</button>
          <span className="muted small">{lines} line{lines === 1 ? '' : 's'} · revision {model.snapshot.revision}</span>
        </div>
      </div>
      <div className="script-feedback" aria-live="polite">
        {report?.ok === true && (
          <p data-testid="script-report" className="ok">
            Valid at revision {report.revision}: {report.operationCount} operation{report.operationCount === 1 ? '' : 's'}
            {report.noChange ? ', no change' : `, would create ${report.created}, change ${report.changed}, delete ${report.deleted}`}. Nothing was committed.
          </p>
        )}
        {report?.ok === false && (
          <p data-testid="script-diagnostic" className="bad">{report.message}{report.message.includes('line ') ? '' : where(report)}{report.hint && <span className="muted"> — {report.hint}</span>}</p>
        )}
        {outcome?.ok === true && (
          <div data-testid="script-result" className="ok">
            {outcome.noChange ? <p>The script changed nothing.</p> : <p>Ran as revision {outcome.revision}: created {outcome.created.length}, changed {outcome.changed.length}, deleted {outcome.deleted.length}.</p>}
            {outcome.warnings.map((w, i) => <p key={i} className="warn">Warning: {w}</p>)}
          </div>
        )}
        {outcome?.ok === false && (
          <p data-testid="script-error" className="bad">{outcome.message}{outcome.hint && <span className="muted"> — {outcome.hint}</span>} <span className="muted small">[{outcome.code}]</span></p>
        )}
        {!report && !outcome && <p className="muted small">Commands: page, add shape|text|image, connect, group, contain, set, move, resize, rotate, delete, duplicate, align, distribute, set-gap, z, layer, asset. Use level=n on add, connect, or set to control stacking; 0 is the default. Colours are quoted: fill="#FFFFFF".</p>}
      </div>
    </div>
  );
}
