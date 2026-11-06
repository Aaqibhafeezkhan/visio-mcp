import type {
  Asset, Bounds, Element, EndpointInput, Operation, Paint, PreparedAssetRef, Snapshot, TextBlock,
} from '../contracts/generated';
import type { ScriptCompiler } from '../commands/CommandEngine';
import { prepareDocumentAsset } from '../commands/assetVersions';
import { defaultScope, lookupTarget } from '../commands/resolveTarget';
import { planPatch } from '../commands/planPatch';
import { fail, ok, type Result } from '../model/result';
import { toPoints, type Unit } from '../model/validate';
import { ScriptError, type Span } from './lexer';
import { parse, type Command, type Named, type ValueToken } from './parser';

export const MAX_SCRIPT_BYTES = 1024 * 1024;
export const MAX_OPERATIONS = 1000;

export interface SourceSpan extends Span { /** The command the operation came from, as written. */ command: string }

export interface CompiledScript {
  operations: Operation[];
  /** One span per operation, in the same order: where in the source that operation came from. */
  sourceSpans: SourceSpan[];
  warnings: string[];
}

export interface CompileContext {
  snapshot: Snapshot;
  /** Creates every identity the script allocates, so compiled operations never depend on planner-chosen ids. */
  newUuid: () => string;
  /** The request's page scope; `page use` overrides it for the rest of the script. */
  pageId?: string;
  preparedAssetRefs?: Record<string, PreparedAssetRef>;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UNITS: readonly string[] = ['mm', 'cm', 'in', 'pt', 'px'];
const PRESETS: Record<string, string> = {
  rect: 'rectangle', rectangle: 'rectangle', roundedrect: 'rounded-rectangle', 'rounded-rectangle': 'rounded-rectangle', rounded: 'rounded-rectangle',
  ellipse: 'ellipse', oval: 'ellipse', circle: 'ellipse', diamond: 'diamond', decision: 'diamond', triangle: 'triangle', hexagon: 'hexagon',
  parallelogram: 'parallelogram', cylinder: 'cylinder', database: 'cylinder', cloud: 'cloud', callout: 'callout',
  // flowchart symbols: a process is a rectangle and a decision a diamond; the others have outlines of their own
  process: 'rectangle', terminator: 'terminator', startend: 'terminator', storeddata: 'stored-data', 'stored-data': 'stored-data',
  document: 'document', lineddocument: 'lined-document', 'lined-document': 'lined-document',
};
const ARROWS: Record<string, string> = { none: 'none', block: 'block', triangle: 'block', open: 'open', diamond: 'diamond', oval: 'oval' };

type Kind = Element['kind'];
interface Known { id: string; kind: Kind; assetId?: string }

class Scene {
  /** page id to alias to the element the script created there */
  aliases = new Map<string, Map<string, Known>>();
  layers = new Map<string, Map<string, string>>();
  pages: Array<{ id: string; name: string }> = [];
  /** Page names changed earlier in this script, which later lines use. */
  renames = new Map<string, string>();
  assets = new Set<string>();
}

/** Compiles DrawScript into the same typed operations MCP callers send. It reads the snapshot but changes nothing. */
export function compile(source: string, ctx: CompileContext): Result<CompiledScript> {
  const bytes = new TextEncoder().encode(source).length;
  if (bytes > MAX_SCRIPT_BYTES) return fail('limit_exceeded', `the script is ${bytes} bytes; the limit is ${MAX_SCRIPT_BYTES}`, { details: { limit: MAX_SCRIPT_BYTES, actual: bytes } });
  try {
    const commands = parse(source);
    const c = new Compiler(ctx, source);
    for (const cmd of commands) c.command(cmd);
    return ok(c.result());
  } catch (e) {
    if (e instanceof ScriptError) {
      return fail('invalid_request', `line ${e.span.line}, column ${e.span.column}: ${e.message}`, {
        details: { line: e.span.line, column: e.span.column, length: e.span.length, ...(e.hint ? { hint: e.hint } : {}) },
      });
    }
    throw e;
  }
}

export interface ValidationReport {
  revision: number;
  operationCount: number;
  created: number;
  changed: number;
  deleted: number;
  noChange: boolean;
}

/**
 * Compiles and plans against the captured snapshot without committing anything: the document, its revision and its history are untouched.
 * A planning failure is reported with the span of the command that caused it.
 */
export function validateScript(source: string, ctx: CompileContext): Result<ValidationReport & { compiled: CompiledScript }> {
  const compiled = compile(source, ctx);
  if (!compiled.ok) return compiled;
  const planned = planPatch(ctx.snapshot.document, compiled.value.operations, { newId: ctx.newUuid, ...(ctx.pageId ? { pageId: ctx.pageId } : {}) });
  if (!planned.ok) return withSpan(planned, compiled.value.sourceSpans);
  const p = planned.value;
  return ok({
    revision: ctx.snapshot.revision, operationCount: compiled.value.operations.length,
    created: p.created.length, changed: p.changed.length, deleted: p.deleted.length, noChange: p.noChange, compiled: compiled.value,
  });
}

/** Attaches the source position of the failing operation (planPatch reports its index) to an error. */
export function withSpan<T>(failure: Result<T>, spans: readonly SourceSpan[] | undefined): Result<T> {
  if (failure.ok || !spans) return failure;
  const index = failure.error.details?.operationIndex;
  const span = typeof index === 'number' ? spans[index] : undefined;
  if (!span) return failure;
  return { ok: false, error: { ...failure.error, message: `line ${span.line}: ${failure.error.message}`, details: { ...failure.error.details, line: span.line, column: span.column, length: span.length, command: span.command } } };
}

// ============================================================================================ compiler

class Compiler {
  private readonly ops: Operation[] = [];
  private readonly spans: SourceSpan[] = [];
  private readonly scene = new Scene();
  private activePageId: string | undefined;
  /** An imported picture whose id the document already pins to different bytes is registered as a separate version; later commands in the same script mean that version. */
  private readonly assetRemap = new Map<string, string>();
  private readonly importedAssets: Asset[] = [];
  private current!: Command;
  private readonly lines: string[];

  constructor(private readonly ctx: CompileContext, source: string) {
    this.lines = source.split('\n');
    this.activePageId = ctx.pageId ?? defaultScope(ctx.snapshot.document);
    for (const a of ctx.snapshot.document.assets) this.scene.assets.add(a.id);
  }

  result(): CompiledScript { return { operations: this.ops, sourceSpans: this.spans, warnings: [] }; }

  // ---------------------------------------------------------------- output
  private emit(op: Operation): void {
    if (this.ops.length >= MAX_OPERATIONS) throw new ScriptError(`a script can produce at most ${MAX_OPERATIONS} operations`, this.current.span, 'split the work into several scripts');
    this.ops.push(op);
    this.spans.push({ ...this.current.span, command: this.lines[this.current.span.line - 1]!.trim() });
  }

  private err(message: string, at: Span = this.current.span, hint?: string): never { throw new ScriptError(message, at, hint); }

  // ---------------------------------------------------------------- argument access
  private args!: { pos: ValueToken[]; named: Map<string, Named>; used: Set<string> };

  private begin(cmd: Command, skipPositionals = 0): void {
    this.current = cmd;
    this.args = { pos: cmd.positionals.slice(skipPositionals), named: new Map(cmd.named.map(n => [n.key, n])), used: new Set() };
  }

  private finish(known: readonly string[]): void {
    for (const n of this.current.named) {
      if (!known.includes(n.key)) this.err(`unknown field "${n.key}" for ${this.current.verb}`, n.keyToken, `known fields: ${known.join(', ')}`);
    }
  }

  private has(key: string): boolean { return this.args.named.has(key); }
  private raw(key: string): Named | undefined { return this.args.named.get(key); }
  private need(key: string): Named { const n = this.args.named.get(key); if (!n) this.err(`${this.current.verb} needs ${key}=`, this.current.span); return n!; }

  private str(n: Named): string {
    if (n.value.type !== 'string') this.err(`${n.key}= takes a quoted string`, n.value, `write ${n.key}="..."`);
    return (n.value as Extract<ValueToken, { type: 'string' }>).value;
  }

  private wordOrString(n: Named): string {
    if (n.value.type === 'word') return n.value.text;
    if (n.value.type === 'string') return n.value.value;
    return this.err(`${n.key}= takes a name`, n.value);
  }

  private bool(n: Named): boolean {
    if (n.value.type === 'word' && (n.value.text === 'true' || n.value.text === 'false')) return n.value.text === 'true';
    return this.err(`${n.key}= takes true or false`, n.value);
  }

  private dim(n: Named): number {
    const v = n.value;
    if (v.type !== 'number') return this.err(`${n.key}= takes a dimension such as 12mm`, v);
    if (!v.unit) return this.err(`${n.key}=${v.raw} needs a unit`, v, 'use mm, cm, in, pt or px');
    if (!UNITS.includes(v.unit)) return this.err(`unknown unit "${v.unit}" in ${n.key}=${v.raw}`, v, 'use mm, cm, in, pt or px');
    return toPoints(v.value, v.unit as Unit);
  }

  private angle(n: Named): number {
    const v = n.value;
    if (v.type !== 'number') return this.err(`${n.key}= takes an angle such as 30deg`, v);
    if (v.unit !== 'deg') return this.err(`${n.key}=${v.raw} needs the unit deg`, v, 'angles are always explicit: 30deg');
    return v.value;
  }

  private num(n: Named, min?: number, max?: number): number {
    const v = n.value;
    if (v.type !== 'number' || (v.unit !== '' && v.unit !== '%')) return this.err(`${n.key}= takes a plain number`, v);
    const value = v.unit === '%' ? v.value / 100 : v.value;
    if ((min !== undefined && value < min) || (max !== undefined && value > max)) return this.err(`${n.key}=${v.raw} is outside ${min}..${max}`, v);
    return value;
  }

  /** `on=CONNECTOR at=0..1 offset=DIM`: pins a shape or text box to a place along a connector. */
  private attachmentInput(patching = false): { connector: string; position?: number; offsetPt?: number } | null | undefined {
    const on = this.raw('on');
    if (!on) {
      if (this.has('at') || this.has('offset')) {
        if (!patching) this.err('at= and offset= go with on=CONNECTOR', (this.raw('at') ?? this.raw('offset'))!.keyToken);
        return undefined;
      }
      return undefined;
    }
    if (on.value.type === 'word' && on.value.text === 'none') return patching ? null : this.err('on=none only makes sense with set', on.value);
    const known = this.target(on.value);
    if (known.kind !== 'connector') this.err(`on= takes a connector, and ${on.value.type === 'word' ? on.value.text : 'that'} is a ${known.kind}`, on.value);
    const out: { connector: string; position?: number; offsetPt?: number } = { connector: known.id };
    if (this.has('at')) out.position = this.num(this.raw('at')!, 0, 1);
    if (this.has('offset')) out.offsetPt = this.signedDim(this.raw('offset')!);
    return out;
  }

  /** A dimension that may be negative, such as -6mm. */
  private signedDim(n: Named): number { return this.dim(n); }

  /** `labelAt=0..1 labelOffset=DIM` on a connector: where its text sits along the line. */
  private labelAnchorInput(): { position?: number; offsetPt?: number } | undefined {
    if (!this.has('labelAt') && !this.has('labelOffset')) return undefined;
    const out: { position?: number; offsetPt?: number } = {};
    if (this.has('labelAt')) out.position = this.num(this.raw('labelAt')!, 0, 1);
    if (this.has('labelOffset')) out.offsetPt = this.dim(this.raw('labelOffset')!);
    return out;
  }

  private enumValue<T extends string>(n: Named, allowed: readonly T[], synonyms: Record<string, T> = {}): T {
    const text = n.value.type === 'word' ? n.value.text : n.value.type === 'string' ? n.value.value : '';
    const hit = (allowed as readonly string[]).includes(text) ? (text as T) : synonyms[text];
    if (!hit) this.err(`${n.key}=${text || n.value.type} is not one of ${allowed.join(', ')}`, n.value);
    return hit!;
  }

  /** `none`, "#RRGGBB" or "#RRGGBBAA" */
  private paint(n: Named): Paint {
    const v = n.value;
    if (v.type === 'word' && v.text === 'none') return { kind: 'none' };
    if (v.type === 'string' && /^(linear-)?gradient\b/i.test(v.value)) return this.gradient(v.value, n, v);
    if (v.type === 'string') {
      const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(v.value);
      if (m) return { kind: 'solid', colour: `#${m[1]!.toLowerCase()}`, opacity: m[2] ? Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000 : 1 };
    }
    return this.err(`${n.key}= takes "#RRGGBB", "#RRGGBBAA", none or a gradient such as "gradient 90 #ffffff #336699"`, v, 'colours are quoted because # starts a comment outside quotes');
  }

  /** "gradient ANGLE STOP STOP ..." where a stop is #RRGGBB or #RRGGBBAA, optionally followed by @OFFSET (0 to 1). Stops without an offset are spread evenly. */
  private gradient(text: string, n: Named, at: ValueToken): Paint {
    const bad = (why: string): Paint => this.err(`${n.key}= gradient: ${why}`, at, 'for example "gradient 90 #ffffff #336699" or "gradient 0 #ff0000 #ffff00@0.3 #0000ff"');
    const parts = text.trim().split(/\s+/).slice(1);
    const angle = Number(parts.shift());
    if (!Number.isFinite(angle) || angle < -360 || angle > 360) return bad('the angle must be a number of degrees from -360 to 360 (0 runs left to right, 90 top to bottom)');
    if (parts.length < 2 || parts.length > 8) return bad('give 2 to 8 colour stops');
    const stops: Array<{ offset: number | null; colour: string; opacity: number }> = [];
    for (const part of parts) {
      const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?(?:@(\d*\.?\d+))?$/.exec(part);
      if (!m) return bad(`"${part}" is not a stop (#RRGGBB, #RRGGBBAA, optionally @offset)`);
      const offset = m[3] === undefined ? null : Number(m[3]);
      if (offset !== null && !(offset >= 0 && offset <= 1)) return bad('a stop offset must be from 0 to 1');
      stops.push({ offset, colour: `#${m[1]!.toLowerCase()}`, opacity: m[2] ? Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000 : 1 });
    }
    const last = stops.length - 1;
    const resolved = stops.map((s, i) => ({ offset: s.offset ?? i / last, colour: s.colour, opacity: s.opacity }));
    for (let i = 1; i < resolved.length; i++) if (resolved[i]!.offset < resolved[i - 1]!.offset) return bad('stop offsets must not go backwards');
    return { kind: 'linear-gradient', angleDeg: angle, stops: resolved };
  }

  private colour(n: Named): string {
    const v = n.value;
    if (v.type === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.value)) return v.value.toLowerCase();
    return this.err(`${n.key}= takes "#RRGGBB" here (no transparency, no none)`, v);
  }

  // ---------------------------------------------------------------- scope and lookup
  private pageIdForCreate(): string {
    if (!this.activePageId) this.err('this document has more than one page, so the script must say which one first', this.current.span, 'begin with: page use "Page name"');
    return this.activePageId!;
  }

  private page(ref: ValueToken): { id: string; name: string } {
    const text = ref.type === 'word' ? ref.text : ref.type === 'string' ? ref.value : this.err('a page is named by a word or a quoted string', ref);
    const called = (p: { id: string; name: string }) => (this.scene.renames.get(p.id) ?? p.name) === text || p.id === text;
    const added = this.scene.pages.filter(called);
    const existing = this.ctx.snapshot.document.pages.filter(called);
    const all = [...added, ...existing];
    if (all.length === 0) this.err(`there is no page called "${text}"`, ref);
    if (all.length > 1) this.err(`"${text}" names ${all.length} pages`, ref, `use one of the ids: ${all.map(p => p.id).join(', ')}`);
    return all[0]!;
  }


  /** An element named by alias, UUID or exact display name, as the planner would resolve it, including ones this script created earlier. */
  private target(ref: ValueToken): Known {
    const text = ref.type === 'word' ? ref.text : ref.type === 'string' ? ref.value : this.err('a target is an alias or a quoted name or id', ref);
    const made = this.activePageId ? this.scene.aliases.get(this.activePageId)?.get(text) : undefined;
    if (made) return made;
    const doc = this.ctx.snapshot.document;
    const hit = lookupTarget(doc.pages, text, this.activePageId);
    if (!hit.ok) {
      const candidates = (hit.details as { candidates?: string[] }).candidates;
      return this.err(hit.message, ref, candidates ? `quote the id of one of: ${candidates.join(', ')}` : hit.code === 'invalid_request' ? 'begin with: page use "Page name"' : undefined);
    }
    const el = doc.pages[hit.pageIdx]!.elements[hit.index]!;
    return { id: el.id, kind: el.kind, ...(el.kind === 'image' ? { assetId: el.assetId } : {}) };
  }

  private register(alias: string | undefined, known: Known, at: Span): void {
    if (!alias) return;
    const pageId = this.activePageId!;
    const here = this.scene.aliases.get(pageId) ?? new Map<string, Known>();
    const taken = here.has(alias) || this.ctx.snapshot.document.pages.find(p => p.id === pageId)?.elements.some(e => e.alias === alias);
    if (taken) this.err(`the alias "${alias}" is already used on this page`, at);
    here.set(alias, known);
    this.scene.aliases.set(pageId, here);
  }

  private layerId(name: string, at: Span): string {
    const pageId = this.pageIdForCreate();
    const made = this.scene.layers.get(pageId)?.get(name);
    if (made) return made;
    const matches = (this.ctx.snapshot.document.pages.find(p => p.id === pageId)?.layers ?? []).filter(l => l.name === name);
    if (matches.length === 0) return this.err(`there is no layer called "${name}" on this page`, at);
    if (matches.length > 1) return this.err(`"${name}" names ${matches.length} layers`, at, `use one of the ids: ${matches.map(l => l.id).join(', ')}`);
    return matches[0]!.id;
  }

  private uuidFor(): string { return this.ctx.newUuid(); }

  /** `id=alias` makes an alias; `uuid="..."` supplies an explicit canonical id. Both are validated here, so a clash is reported with its line. */
  private identity(): { id: string; alias?: string } {
    let alias: string | undefined;
    const idn = this.raw('id');
    if (idn) {
      if (idn.value.type === 'word') alias = idn.value.text;
      else if (idn.value.type === 'string') {
        if (UUID.test(idn.value.value)) this.err('a UUID is given with uuid=, not id=', idn.value, 'id= names an alias such as id=server_1');
        alias = idn.value.value;
      } else this.err('id= takes an alias', idn.value);
    }
    const un = this.raw('uuid');
    let id = this.uuidFor();
    if (un) {
      const u = this.str(un);
      if (!UUID.test(u)) this.err('uuid= takes a quoted UUID', un.value);
      id = u;
    }
    return alias ? { id, alias } : { id };
  }

  // ---------------------------------------------------------------- shared property groups
  private textPatch(known: Set<string>): Partial<TextBlock> {
    const t: Record<string, unknown> = {};
    const take = (key: string, f: (n: Named) => unknown, to: string) => { const n = this.raw(key); if (n) { t[to] = f(n); known.add(key); } };
    take('text', n => this.str(n), 'value');
    take('font', n => this.str(n), 'fontFamily');
    take('fontSize', n => this.dim(n), 'fontSizePt');
    take('bold', n => this.bool(n), 'bold');
    take('italic', n => this.bool(n), 'italic');
    take('underline', n => this.bool(n), 'underline');
    take('textColor', n => this.colour(n), 'colour');
    take('align', n => this.enumValue(n, ['left', 'center', 'right'] as const), 'horizontalAlign');
    take('valign', n => this.enumValue(n, ['top', 'middle', 'bottom'] as const), 'verticalAlign');
    take('wrap', n => this.bool(n), 'wrap');
    take('padding', n => this.dim(n), 'paddingPt');
    take('textDir', n => this.enumValue(n, ['horizontal', 'vertical'] as const), 'orientation');
    const sides: Record<string, number> = {};
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) { const key = `inset${side}`; const n = this.raw(key); if (n) { sides[side.toLowerCase()] = this.dim(n); known.add(key); } }
    if (Object.keys(sides).length) t.insetsPt = sides;
    return t as Partial<TextBlock>;
  }
  private static readonly TEXT_KEYS = ['text', 'font', 'fontSize', 'bold', 'italic', 'underline', 'textColor', 'align', 'valign', 'wrap', 'padding', 'textDir', 'insetTop', 'insetRight', 'insetBottom', 'insetLeft'];

  private bounds(): Bounds {
    const x = this.dim(this.need('x')), y = this.dim(this.need('y')), width = this.dim(this.need('w')), height = this.dim(this.need('h'));
    if (!(width > 0 && height > 0)) this.err('w and h must be positive', this.raw('w')?.value ?? this.current.span);
    return { x, y, width, height };
  }

  private shapeStyle(): Record<string, unknown> {
    const s: Record<string, unknown> = {};
    if (this.has('fill')) s.fill = this.paint(this.raw('fill')!);
    if (this.has('stroke')) s.stroke = this.paint(this.raw('stroke')!);
    if (this.has('strokeWidth')) s.strokeWidthPt = this.dim(this.raw('strokeWidth')!);
    if (this.has('dash')) s.dash = this.enumValue(this.raw('dash')!, ['solid', 'dashed', 'dotted', 'dash-dot']);
    if (this.has('lineCap')) s.lineCap = this.enumValue(this.raw('lineCap')!, ['butt', 'round', 'square']);
    if (this.has('lineJoin')) s.lineJoin = this.enumValue(this.raw('lineJoin')!, ['miter', 'round', 'bevel']);
    return s;
  }

  private lineStyle(): Record<string, unknown> {
    const s: Record<string, unknown> = {};
    if (this.has('stroke')) s.colour = this.colour(this.raw('stroke')!);
    if (this.has('strokeWidth')) s.widthPt = this.dim(this.raw('strokeWidth')!);
    if (this.has('dash')) s.dash = this.enumValue(this.raw('dash')!, ['solid', 'dashed', 'dotted', 'dash-dot']);
    if (this.has('startArrow')) s.startArrow = this.enumValue(this.raw('startArrow')!, ['none', 'block', 'open', 'diamond', 'oval'], ARROWS as Record<string, 'block'>);
    if (this.has('endArrow')) s.endArrow = this.enumValue(this.raw('endArrow')!, ['none', 'block', 'open', 'diamond', 'oval'], ARROWS as Record<string, 'block'>);
    if (this.has('startArrowSize')) s.startArrowSize = this.enumValue(this.raw('startArrowSize')!, ['small', 'medium', 'large']);
    if (this.has('endArrowSize')) s.endArrowSize = this.enumValue(this.raw('endArrowSize')!, ['small', 'medium', 'large']);
    return s;
  }

  private preset(n: Named): string {
    const text = (n.value.type === 'word' ? n.value.text : n.value.type === 'string' ? n.value.value : '').toLowerCase();
    const hit = PRESETS[text];
    if (!hit) this.err(`unknown shape type "${text}"`, n.value, `types: ${[...new Set(Object.values(PRESETS))].join(', ')}`);
    return hit!;
  }

  /** R17: `container=none|grow|fit` makes a shape a container (or changes how it fits its members); `margin=` is the clearance grow and fit keep. */
  private containerSettings(): { fit?: 'none' | 'grow' | 'fit'; marginPt?: number } | undefined {
    if (!this.has('container')) {
      if (this.has('margin')) this.err('margin= goes with container=', this.raw('margin')!.keyToken);
      return undefined;
    }
    const out: { fit?: 'none' | 'grow' | 'fit'; marginPt?: number } = { fit: this.enumValue(this.raw('container')!, ['none', 'grow', 'fit'] as const) };
    if (this.has('margin')) {
      const marginPt = this.dim(this.raw('margin')!);
      if (marginPt < 0 || marginPt > 500) this.err('margin= must be between 0pt and 500pt', this.raw('margin')!.value);
      out.marginPt = marginPt;
    }
    return out;
  }

  // ---------------------------------------------------------------- commands
  command(cmd: Command): void {
    this.current = cmd;
    switch (cmd.verb) {
      case 'page': return this.cmdPage(cmd);
      case 'add': return this.cmdAdd(cmd);
      case 'connect': return this.cmdConnect(cmd);
      case 'group': return this.cmdGroup(cmd);
      case 'contain': return this.cmdContain(cmd);
      case 'set': return this.cmdSet(cmd);
      case 'move': return this.cmdMove(cmd);
      case 'resize': return this.cmdResize(cmd);
      case 'rotate': return this.cmdRotate(cmd);
      case 'delete': return this.cmdDelete(cmd);
      case 'duplicate': return this.cmdDuplicate(cmd);
      case 'align': return this.cmdAlign(cmd);
      case 'distribute': return this.cmdDistribute(cmd);
      case 'set-gap': return this.cmdSetGap(cmd);
      case 'z': return this.cmdZ(cmd);
      case 'reroute': return this.cmdReroute(cmd);
      case 'move-segment': return this.cmdMoveSegment(cmd);
      case 'pin-segment': case 'unpin-segment': return this.cmdPinSegment(cmd);
      case 'layer': return this.cmdLayer(cmd);
      case 'asset': return this.cmdAsset(cmd);
      default:
        return this.err(`unknown command "${cmd.verb}"`, cmd.verbToken, 'commands: page, add, connect, group, contain, set, move, resize, rotate, delete, duplicate, align, distribute, set-gap, z, reroute, move-segment, pin-segment, unpin-segment, layer, asset');
    }
  }

  private sub(cmd: Command, allowed: readonly string[]): string {
    const t = cmd.positionals[0];
    if (!t || t.type !== 'word' || !allowed.includes(t.text)) this.err(`${cmd.verb} needs one of: ${allowed.join(', ')}`, t ?? cmd.span);
    return (t as Extract<ValueToken, { type: 'word' }>).text;
  }

  private ids(rest: ValueToken[], minimum: number, what: string): string[] {
    if (rest.length < minimum) this.err(`${what} needs at least ${minimum} target${minimum === 1 ? '' : 's'}`, this.current.span);
    const seen = new Set<string>();
    return rest.map(t => {
      const id = this.target(t).id;
      if (seen.has(id)) this.err('the same element is listed twice', t);
      seen.add(id);
      return id;
    });
  }

  // ---- page
  private cmdPage(cmd: Command): void {
    const action = this.sub(cmd, ['add', 'use', 'rename', 'size']);
    this.begin(cmd, 1);
    if (action === 'use') {
      this.finish([]);
      if (this.args.pos.length !== 1) this.err('page use needs one page name', cmd.span);
      this.activePageId = this.page(this.args.pos[0]!).id; // context only: nothing is emitted and the GUI's page is untouched
      return;
    }
    if (action === 'add') {
      this.finish(['w', 'h', 'index']);
      if (this.args.pos.length !== 1) this.err('page add needs a name: page add "Overview"', cmd.span);
      const nameTok = this.args.pos[0]!;
      const name = nameTok.type === 'string' ? nameTok.value : nameTok.type === 'word' ? nameTok.text : this.err('a page name is a word or a quoted string', nameTok);
      const id = this.uuidFor();
      const op: Operation = { op: 'addPage', id, name };
      if (this.has('w')) op.widthPt = this.dim(this.raw('w')!);
      if (this.has('h')) op.heightPt = this.dim(this.raw('h')!);
      if (this.has('index')) op.index = this.num(this.raw('index')!, 0);
      this.emit(op);
      this.scene.pages.push({ id, name });
      return;
    }
    if (action === 'rename') {
      this.finish(['name']);
      if (this.args.pos.length !== 1) this.err('page rename needs the page: page rename "Old" name="New"', cmd.span);
      const pageId = this.page(this.args.pos[0]!).id;
      const newName = this.str(this.need('name'));
      this.emit({ op: 'setPage', pageId, patch: { name: newName } });
      this.scene.renames.set(pageId, newName);
      return;
    }
    // size
    this.finish(['w', 'h']);
    if (!this.has('w') && !this.has('h')) this.err('page size needs w= and/or h=', cmd.span);
    if (this.args.pos.length > 1) this.err('page size takes at most one page name', this.args.pos[1]!);
    const pageId = this.args.pos[0] ? this.page(this.args.pos[0]).id : this.pageIdForCreate();
    const patch: { widthPt?: number; heightPt?: number } = {};
    if (this.has('w')) patch.widthPt = this.dim(this.raw('w')!);
    if (this.has('h')) patch.heightPt = this.dim(this.raw('h')!);
    this.emit({ op: 'setPage', pageId, patch });
  }

  // ---- add
  private cmdAdd(cmd: Command): void {
    const what = this.sub(cmd, ['shape', 'text', 'image']);
    this.begin(cmd, 1);
    if (this.args.pos.length) this.err(`add ${what} takes only name=value fields`, this.args.pos[0]!);
    const pageId = this.pageIdForCreate();
    const { id, alias } = this.identity();
    const common: { id: string; pageId: string; alias?: string; name?: string; layerIds?: string[]; rotationDeg?: number; level?: number } = { id, pageId };
    if (alias) common.alias = alias;
    if (this.has('name')) common.name = this.str(this.raw('name')!);
    if (this.has('layer')) common.layerIds = [this.layerId(this.wordOrString(this.raw('layer')!), this.raw('layer')!.value)];
    if (this.has('rotate')) common.rotationDeg = this.angle(this.raw('rotate')!);
    if (this.has('level')) common.level = this.num(this.raw('level')!, -127, 127);
    const base = ['id', 'uuid', 'x', 'y', 'w', 'h', 'name', 'layer', 'rotate', 'level', 'on', 'at', 'offset'];

    if (what === 'shape') {
      this.finish([...base, 'type', 'cornerRadius', 'fill', 'stroke', 'strokeWidth', 'dash', 'lineCap', 'lineJoin', 'container', 'margin', ...Compiler.TEXT_KEYS]);
      const op: Operation = { op: 'createShape', ...common, bounds: this.bounds() };
      const geometry: Record<string, unknown> = {};
      geometry.preset = this.has('type') ? this.preset(this.raw('type')!) : 'rectangle';
      if (this.has('cornerRadius')) geometry.cornerRadiusPt = this.dim(this.raw('cornerRadius')!);
      op.geometry = geometry as never;
      const style = this.shapeStyle();
      if (Object.keys(style).length) op.style = style as never;
      const text = this.textPatch(new Set());
      if (Object.keys(text).length) op.text = text as never;
      const att = this.attachmentInput(); if (att) op.attachment = att;
      const container = this.containerSettings(); if (container) op.container = container;
      this.emit(op);
      this.register(alias, { id, kind: 'shape' }, this.raw('id')?.value ?? cmd.span);
      return;
    }
    if (what === 'text') {
      this.finish([...base, ...Compiler.TEXT_KEYS]);
      if (!this.has('text')) this.err('add text needs text="..."', cmd.span);
      const op: Operation = { op: 'createText', ...common, bounds: this.bounds(), text: this.textPatch(new Set()) as never };
      const att = this.attachmentInput(); if (att) op.attachment = att;
      this.emit(op);
      this.register(alias, { id, kind: 'text' }, this.raw('id')?.value ?? cmd.span);
      return;
    }
    this.finish([...base, 'asset', 'fit', 'opacity']);
    const assetN = this.need('asset');
    const assetId = this.mapAsset(this.str(assetN));
    if (!this.scene.assets.has(assetId)) this.err(`unknown asset "${assetId}"`, assetN.value, 'import it first with: asset import prepared=<name>');
    const op: Operation = { op: 'createImage', ...common, bounds: this.bounds(), assetId };
    if (this.has('fit')) op.fit = this.enumValue(this.raw('fit')!, ['contain', 'cover', 'stretch'] as const);
    if (this.has('opacity')) op.opacity = this.num(this.raw('opacity')!, 0, 1);
    this.emit(op);
    this.register(alias, { id, kind: 'image', assetId }, this.raw('id')?.value ?? cmd.span);
  }

  // ---- connect
  /**
   * `alias` is a dynamic glue; `alias.port` is a static glue to that port. The whole token is tried as an alias first, then split at
   * its last dot. A token that could be read both ways must be written with fromAlias=/fromPort= (or toAlias=/toPort=) instead.
   */
  /** `toJoin=bus toAt=60%`: the end is a branch joined to another connector, a fraction of the way along it (default the middle). */
  private joinInput(side: 'from' | 'to', joined: Named): EndpointInput {
    const known = this.target(joined.value);
    if (known.kind !== 'connector') this.err(`${side}Join= takes a connector`, joined.keyToken, `"${joined.value.type === 'word' ? joined.value.text : 'that'}" is a ${known.kind}`);
    const join: { connector: string; position?: number } = { connector: known.id };
    if (this.has(`${side}At`)) join.position = this.num(this.raw(`${side}At`)!, 0, 1);
    return { glue: 'none', join };
  }

  private endpoint(side: 'from' | 'to'): EndpointInput {
    const fx = this.raw(`${side}X`), fy = this.raw(`${side}Y`);
    const explicitAlias = this.raw(`${side}Alias`), explicitPort = this.raw(`${side}Port`);
    const plain = this.raw(side);
    const joined = this.raw(`${side}Join`);
    const sideValue = this.raw(`${side}Side`);
    const withSide = (endpoint: EndpointInput): EndpointInput => {
      if (sideValue) {
        if (endpoint.glue === 'none') this.err(`${side}Side= applies only to a glued endpoint`, sideValue.keyToken);
        endpoint.preferredSide = this.enumValue(sideValue, ['north', 'east', 'south', 'west'] as const);
      }
      return endpoint;
    };
    const given = [plain, explicitAlias, fx, joined].filter(Boolean).length;
    if (given === 0) this.err(`connect needs ${side}=`, this.current.span);
    if (given > 1) this.err(`${side}, ${side}Alias, ${side}X/${side}Y and ${side}Join are alternatives`, (plain ?? explicitAlias ?? fx ?? joined)!.keyToken);
    if (joined) return withSide(this.joinInput(side, joined));
    if (this.has(`${side}At`)) this.err(`${side}At= goes with ${side}Join=`, this.raw(`${side}At`)!.keyToken);
    if (fx || fy) {
      if (!fx || !fy) this.err(`a free end needs both ${side}X= and ${side}Y=`, (fx ?? fy)!.keyToken);
      return withSide({ glue: 'none', point: { x: this.dim(fx), y: this.dim(fy) } });
    }
    if (explicitAlias) {
      const known = this.target(explicitAlias.value);
      const e: EndpointInput = { elementId: known.id, glue: explicitPort ? 'static' : 'dynamic' };
      if (explicitPort) e.port = this.str(explicitPort);
      return withSide(e);
    }
    if (explicitPort) this.err(`${side}Port= goes with ${side}Alias=`, explicitPort.keyToken);
    const tok = plain!.value;
    if (tok.type === 'string') return withSide({ elementId: this.target(tok).id, glue: 'dynamic' }); // a quoted token is a whole alias, id or name
    if (tok.type !== 'word') return this.err(`${side}= takes an alias or alias.port`, tok);
    const whole = this.tryTarget(tok.text, tok);
    const dot = tok.text.lastIndexOf('.');
    const split = dot > 0 ? this.tryTarget(tok.text.slice(0, dot), tok) : undefined;
    if (whole && split) this.err(`"${tok.text}" could be the alias "${tok.text}" or port "${tok.text.slice(dot + 1)}" of "${tok.text.slice(0, dot)}"`, tok, `write ${side}Alias="..." and ${side}Port="..." to say which`);
    if (whole) return withSide({ elementId: whole.id, glue: 'dynamic' });
    if (split) return withSide({ elementId: split.id, port: tok.text.slice(dot + 1), glue: 'static' });
    return this.err(`nothing is called "${tok.text}"${dot > 0 ? ` or "${tok.text.slice(0, dot)}"` : ''}`, tok);
  }

  private tryTarget(text: string, at: Span): Known | undefined {
    const made = this.activePageId ? this.scene.aliases.get(this.activePageId)?.get(text) : undefined;
    if (made) return made;
    const doc = this.ctx.snapshot.document;
    const hit = lookupTarget(doc.pages, text, this.activePageId);
    if (hit.ok) { const el = doc.pages[hit.pageIdx]!.elements[hit.index]!; return { id: el.id, kind: el.kind }; }
    if (hit.code === 'ambiguous_target') this.err(hit.message, at);
    return undefined;
  }

  private cmdConnect(cmd: Command): void {
    this.begin(cmd);
    if (this.args.pos.length) this.err('connect takes only name=value fields', this.args.pos[0]!);
    this.finish(['id', 'uuid', 'from', 'to', 'fromAlias', 'fromPort', 'toAlias', 'toPort', 'fromX', 'fromY', 'toX', 'toY', 'route', 'name', 'layer', 'level',
      'stroke', 'strokeWidth', 'dash', 'startArrow', 'endArrow', 'startArrowSize', 'endArrowSize', 'text', 'labelAt', 'labelOffset', 'mode',
      'fromJoin', 'fromAt', 'toJoin', 'toAt', 'fromSide', 'toSide', 'hops']);
    const pageId = this.pageIdForCreate();
    const { id, alias } = this.identity();
    const op: Operation = { op: 'createConnector', id, pageId, from: this.endpoint('from'), to: this.endpoint('to') };
    if (alias) op.alias = alias;
    if (this.has('name')) op.name = this.str(this.raw('name')!);
    if (this.has('layer')) op.layerIds = [this.layerId(this.wordOrString(this.raw('layer')!), this.raw('layer')!.value)];
    if (this.has('level')) op.level = this.num(this.raw('level')!, -127, 127);
    if (this.has('route')) op.route = this.enumValue(this.raw('route')!, ['straight', 'orthogonal', 'curved'] as const);
    if (this.has('mode')) op.routing = { mode: this.enumValue(this.raw('mode')!, ['automatic', 'manual', 'frozen', 'guided'] as const) };
    const style = this.lineStyle();
    if (Object.keys(style).length) op.style = style as never;
    if (this.has('text')) op.label = { value: this.str(this.raw('text')!) };
    const anchor = this.labelAnchorInput(); if (anchor) op.labelAnchor = anchor;
    if (this.has('hops')) op.hops = this.enumValue(this.raw('hops')!, ['none', 'arc'] as const);
    this.emit(op);
    this.register(alias, { id, kind: 'connector' }, this.raw('id')?.value ?? cmd.span);
  }

  // ---- group
  private cmdGroup(cmd: Command): void {
    this.begin(cmd);
    this.finish(['id', 'uuid', 'name']);
    this.pageIdForCreate();
    const { id, alias } = this.identity();
    const targets = this.ids(this.args.pos, 1, 'group');
    const op: Operation = { op: 'group', targets, id };
    if (alias) op.alias = alias;
    if (this.has('name')) op.name = this.str(this.raw('name')!);
    this.emit(op);
    this.register(alias, { id, kind: 'group' }, this.raw('id')?.value ?? cmd.span);
  }

  // ---- contain (R17)
  /** `contain zone add web db`, `contain zone remove db`, `contain zone disband` (the shape stays; its members move up a level). */
  private cmdContain(cmd: Command): void {
    this.begin(cmd);
    this.finish([]);
    const [containerTok, actionTok, ...rest] = this.args.pos;
    if (!containerTok || !actionTok) this.err('contain needs a container and add, remove or disband: contain zone add web db', cmd.span);
    const container = this.target(containerTok!);
    if (container.kind !== 'shape') this.err(`only a shape can be a container; "${containerTok!.type === 'word' ? containerTok!.text : 'that'}" is a ${container.kind}`, containerTok!);
    const action = actionTok!.type === 'word' ? actionTok!.text : '';
    if (action === 'disband') {
      if (rest.length) this.err('contain ... disband takes no targets', rest[0]!);
      this.emit({ op: 'set', target: container.id, patch: { container: null } });
      return;
    }
    if (action !== 'add' && action !== 'remove') this.err('contain needs add, remove or disband after the container', actionTok!);
    const targets = this.ids(rest, 1, `contain ${action}`);
    this.emit(action === 'add' ? { op: 'contain', container: container.id, add: targets } : { op: 'contain', container: container.id, remove: targets });
  }

  // ---- set
  private cmdSet(cmd: Command): void {
    this.begin(cmd);
    if (this.args.pos.length !== 1) this.err('set needs one target followed by name=value fields', this.args.pos[1] ?? cmd.span);
    const known = this.target(this.args.pos[0]!);
    if (!cmd.named.length) this.err('set needs at least one name=value field', cmd.span);
    const isConnector = known.kind === 'connector';
    const patch: Record<string, unknown> = {};
    const handled = new Set<string>();
    const take = (key: string, f: (n: Named) => unknown, to: string) => { const n = this.raw(key); if (n) { patch[to] = f(n); handled.add(key); } };
    take('name', n => this.str(n), 'name');
    take('level', n => this.num(n, -127, 127), 'level');
    take('alias', n => this.str(n), 'alias');
    take('locked', n => this.bool(n), 'locked');
    take('hidden', n => this.bool(n), 'hidden');
    if (this.has('layer')) { patch.layerIds = [this.layerId(this.wordOrString(this.raw('layer')!), this.raw('layer')!.value)]; handled.add('layer'); }

    const style = isConnector ? this.lineStyle() : this.shapeStyle();
    for (const k of ['fill', 'stroke', 'strokeWidth', 'dash', 'lineCap', 'lineJoin', 'startArrow', 'endArrow', 'startArrowSize', 'endArrowSize']) if (this.has(k)) handled.add(k);
    if (isConnector) { for (const k of ['fill', 'lineCap', 'lineJoin']) if (this.has(k)) this.err(`${k}= does not apply to a connector`, this.raw(k)!.keyToken); }
    else for (const k of ['startArrow', 'endArrow', 'startArrowSize', 'endArrowSize']) if (this.has(k)) this.err(`${k}= applies to connectors only`, this.raw(k)!.keyToken);
    if (Object.keys(style).length) {
      if (known.kind !== 'shape' && known.kind !== 'connector') this.err(`${known.kind === 'text' ? 'a text box' : known.kind === 'image' ? 'an image' : 'a group'} has no line or fill`, cmd.span, 'fill, stroke, strokeWidth and dash style shapes and connectors');
      patch.style = style;
    }

    const text = this.textPatch(handled);
    if (Object.keys(text).length) {
      if (known.kind === 'image' || known.kind === 'group') this.err(`${known.kind === 'image' ? 'an image' : 'a group'} has no text`, cmd.span);
      patch.text = text;
    }
    if (this.has('type') || this.has('cornerRadius')) {
      if (known.kind !== 'shape') this.err('type= and cornerRadius= apply to shapes only', (this.raw('type') ?? this.raw('cornerRadius'))!.keyToken);
      const g: Record<string, unknown> = {};
      if (this.has('type')) { g.preset = this.preset(this.raw('type')!); handled.add('type'); }
      if (this.has('cornerRadius')) { g.cornerRadiusPt = this.dim(this.raw('cornerRadius')!); handled.add('cornerRadius'); }
      patch.geometry = g;
    }
    if (this.has('asset')) {
      const n = this.raw('asset')!;
      if (known.kind !== 'image') this.err('asset= applies to images only', n.keyToken, 'to restyle other things use fill, stroke and text');
      const assetId = this.mapAsset(this.str(n));
      if (!this.scene.assets.has(assetId)) this.err(`unknown asset "${assetId}"`, n.value);
      patch.assetId = assetId; handled.add('asset');
    }
    if (this.has('fit')) { this.imageOnly(known, 'fit'); patch.fit = this.enumValue(this.raw('fit')!, ['contain', 'cover', 'stretch'] as const); handled.add('fit'); }
    if (this.has('opacity')) { this.imageOnly(known, 'opacity'); patch.opacity = this.num(this.raw('opacity')!, 0, 1); handled.add('opacity'); }
    if (this.has('route')) {
      if (!isConnector) this.err('route= applies to connectors only', this.raw('route')!.keyToken);
      patch.route = this.enumValue(this.raw('route')!, ['straight', 'orthogonal', 'curved'] as const); handled.add('route');
    }
    if (this.has('mode')) {
      if (!isConnector) this.err('mode= applies to connectors only', this.raw('mode')!.keyToken);
      patch.routing = { mode: this.enumValue(this.raw('mode')!, ['automatic', 'manual', 'frozen', 'guided'] as const) }; handled.add('mode');
    }
    for (const side of ['from', 'to'] as const) if (this.has(`${side}Side`)) {
      const token = this.raw(`${side}Side`)!;
      if (!isConnector) this.err(`${side}Side= applies to connectors only`, token.keyToken);
      const current = this.ctx.snapshot.document.pages.flatMap(page => page.elements).find(e => e.id === known.id);
      if (!current || current.kind !== 'connector') this.err(`${side}Side= can only change an existing connector end`, token.keyToken);
      if (current[side].glue === 'none') this.err(`${side}Side= applies only to a glued endpoint`, token.keyToken);
      patch[side] = { ...current[side], preferredSide: this.enumValue(token, ['north', 'east', 'south', 'west'] as const) };
      handled.add(`${side}Side`);
    }
    const routingPolicy: Record<string, unknown> = {};
    if (this.has('obstacle')) { routingPolicy.obstacle = this.enumValue(this.raw('obstacle')!, ['automatic', 'forbidden', 'avoid', 'passThrough'] as const); handled.add('obstacle'); }
    if (this.has('clearance')) {
      const clearancePt = this.dim(this.raw('clearance')!);
      if (clearancePt < 0 || clearancePt > 2000) this.err('clearance= must be between 0pt and 2000pt', this.raw('clearance')!.value);
      routingPolicy.clearancePt = clearancePt; handled.add('clearance');
    }
    if (this.has('textObstacle')) { routingPolicy.text = this.enumValue(this.raw('textObstacle')!, ['ignore', 'avoid'] as const); handled.add('textObstacle'); }
    if (Object.keys(routingPolicy).length) {
      if (known.kind === 'image' || known.kind === 'group') this.err('routing obstacle policies apply to shapes, text boxes, and connectors', (this.raw('obstacle') ?? this.raw('clearance') ?? this.raw('textObstacle'))!.keyToken);
      patch.routingPolicy = routingPolicy;
    }
    if (this.has('on') || this.has('at') || this.has('offset')) {
      if (known.kind !== 'shape' && known.kind !== 'text') this.err('on=, at= and offset= apply to shapes and text boxes', (this.raw('on') ?? this.raw('at') ?? this.raw('offset'))!.keyToken);
      const current = this.ctx.snapshot.document.pages.flatMap(pg => pg.elements).find(e => e.id === known.id);
      const was = current && (current.kind === 'shape' || current.kind === 'text') ? current.attachment : undefined;
      const att = this.attachmentInput(true);
      if (att === null) patch.attachment = null;
      else if (att) patch.attachment = att;
      else if (was) patch.attachment = { connector: was.connectorId, ...(this.has('at') ? { position: this.num(this.raw('at')!, 0, 1) } : { position: was.position }), ...(this.has('offset') ? { offsetPt: this.dim(this.raw('offset')!) } : { offsetPt: was.offsetPt }) };
      else this.err('at= and offset= go with on=CONNECTOR', (this.raw('at') ?? this.raw('offset'))!.keyToken);
      for (const k of ['on', 'at', 'offset']) handled.add(k);
    }
    if (this.has('labelAt') || this.has('labelOffset')) {
      if (!isConnector) this.err('labelAt= and labelOffset= apply to connectors', (this.raw('labelAt') ?? this.raw('labelOffset'))!.keyToken);
      patch.labelAnchor = this.labelAnchorInput(); handled.add('labelAt'); handled.add('labelOffset');
    }
    for (const side of ['from', 'to'] as const) {
      if (!this.has(`${side}Join`) && !this.has(`${side}At`)) continue;
      if (!isConnector) this.err(`${side}Join= applies to connectors`, (this.raw(`${side}Join`) ?? this.raw(`${side}At`))!.keyToken);
      if (!this.has(`${side}Join`)) this.err(`${side}At= goes with ${side}Join=`, this.raw(`${side}At`)!.keyToken);
      patch[side] = this.joinInput(side, this.raw(`${side}Join`)!); handled.add(`${side}Join`); handled.add(`${side}At`);
    }
    if (this.has('hops')) {
      if (!isConnector) this.err('hops= applies to connectors', this.raw('hops')!.keyToken);
      patch.hops = this.enumValue(this.raw('hops')!, ['none', 'arc'] as const); handled.add('hops');
    }
    if (this.has('container') || this.has('margin')) {
      if (known.kind !== 'shape') this.err('container= and margin= apply to shapes', (this.raw('container') ?? this.raw('margin'))!.keyToken);
      if (!this.has('container')) {
        const marginPt = this.dim(this.raw('margin')!);
        if (marginPt < 0 || marginPt > 500) this.err('margin= must be between 0pt and 500pt', this.raw('margin')!.value);
        patch.container = { marginPt };
      } else patch.container = this.containerSettings();
      handled.add('container'); handled.add('margin');
    }
    for (const n of cmd.named) {
      if (!handled.has(n.key)) this.err(`unknown field "${n.key}" for set`, n.keyToken, 'to change position or size use move, resize, rotate');
    }
    if (isConnector && patch.text) { /* the engine maps a connector's text patch to its label */ }
    this.emit({ op: 'set', target: known.id, patch: patch as never });
  }

  private imageOnly(known: Known, key: string): void {
    if (known.kind !== 'image') this.err(`${key}= applies to images only`, this.raw(key)!.keyToken);
  }

  // ---- move / resize / rotate / delete / duplicate
  private single(cmd: Command, what: string): Known {
    if (this.args.pos.length !== 1) this.err(`${what} needs exactly one target`, this.args.pos[1] ?? cmd.span);
    return this.target(this.args.pos[0]!);
  }

  private cmdMove(cmd: Command): void {
    this.begin(cmd);
    this.finish(['x', 'y', 'dx', 'dy']);
    const known = this.single(cmd, 'move');
    const abs = this.has('x') || this.has('y'), rel = this.has('dx') || this.has('dy');
    if (abs && rel) this.err('give x/y or dx/dy, not both', (this.raw('dx') ?? this.raw('dy'))!.keyToken, 'x= and y= place the object; dx= and dy= shift it');
    if (!abs && !rel) this.err('move needs x= y= or dx= dy=', cmd.span);
    if (rel) {
      const dx = this.has('dx') ? this.dim(this.raw('dx')!) : 0, dy = this.has('dy') ? this.dim(this.raw('dy')!) : 0;
      this.emit({ op: 'move', target: known.id, delta: { xPt: dx, yPt: dy } });
      return;
    }
    if (known.kind === 'connector') this.err('a connector is positioned by its ends: use dx= and dy=', this.raw('x')?.keyToken ?? this.raw('y')!.keyToken);
    const b: Partial<Bounds> = {};
    if (this.has('x')) b.x = this.dim(this.raw('x')!);
    if (this.has('y')) b.y = this.dim(this.raw('y')!);
    this.emit({ op: 'resize', target: known.id, bounds: b }); // an absolute position is a bounds patch that leaves the size alone
  }

  private cmdResize(cmd: Command): void {
    this.begin(cmd);
    this.finish(['w', 'h']);
    const known = this.single(cmd, 'resize');
    if (!this.has('w') && !this.has('h')) this.err('resize needs w= and/or h=', cmd.span);
    const b: Partial<Bounds> = {};
    if (this.has('w')) b.width = this.dim(this.raw('w')!);
    if (this.has('h')) b.height = this.dim(this.raw('h')!);
    for (const [k, v] of Object.entries(b)) if (!(v > 0)) this.err(`${k === 'width' ? 'w' : 'h'} must be positive`, this.raw(k === 'width' ? 'w' : 'h')!.value);
    this.emit({ op: 'resize', target: known.id, bounds: b });
  }

  private cmdRotate(cmd: Command): void {
    this.begin(cmd);
    this.finish(['angle', 'by', 'pivotX', 'pivotY']);
    const known = this.single(cmd, 'rotate');
    if (this.has('angle') && this.has('by')) this.err('give angle= or by=, not both', this.raw('by')!.keyToken, 'angle= sets the orientation; by= turns it');
    if (!this.has('angle') && !this.has('by')) this.err('rotate needs angle= or by=', cmd.span);
    if (this.has('pivotX') !== this.has('pivotY')) this.err('a pivot needs both pivotX= and pivotY=', (this.raw('pivotX') ?? this.raw('pivotY'))!.keyToken);
    if (known.kind === 'connector') this.err('connectors have no rotation', cmd.span);
    const hasPivot = this.has('pivotX');
    if (hasPivot && known.kind !== 'group') this.err('a pivot applies only to a group; other objects turn about their own centre', this.raw('pivotX')!.keyToken);
    if (known.kind === 'group' && this.has('angle')) this.err('a group has no angle of its own', this.raw('angle')!.keyToken, 'turn it with by=30deg');
    const pivot = hasPivot ? { xPt: this.dim(this.raw('pivotX')!), yPt: this.dim(this.raw('pivotY')!) } : undefined;
    const op: Operation = this.has('angle')
      ? { op: 'rotate', target: known.id, angleDeg: this.angle(this.raw('angle')!) }
      : { op: 'rotate', target: known.id, deltaDeg: this.angle(this.raw('by')!) };
    if (pivot) op.pivot = pivot;
    this.emit(op);
  }

  private cmdDelete(cmd: Command): void {
    this.begin(cmd);
    this.finish(['withConnectors', 'children', 'members']);
    const known = this.single(cmd, 'delete');
    const op: Operation = { op: 'delete', target: known.id };
    if (this.has('members')) {
      if (known.kind !== 'shape') this.err('members= applies only to a container', this.raw('members')!.keyToken);
      op.members = this.enumValue(this.raw('members')!, ['delete', 'keep'] as const);
    }
    if (this.has('withConnectors')) op.withConnectors = this.bool(this.raw('withConnectors')!);
    if (this.has('children')) {
      if (known.kind !== 'group') this.err('children= applies only to a group', this.raw('children')!.keyToken);
      op.children = this.enumValue(this.raw('children')!, ['delete', 'ungroup'] as const);
    } else if (known.kind === 'group') this.err('deleting a group needs children=delete or children=ungroup', cmd.span);
    this.emit(op);
  }

  private cmdDuplicate(cmd: Command): void {
    this.begin(cmd);
    this.finish(['as', 'dx', 'dy', 'keepAliases', 'keepExternalLinks']);
    const targets = this.ids(this.args.pos, 1, 'duplicate');
    const op: Operation = { op: 'duplicate', targets };
    if (this.has('as')) {
      if (targets.length !== 1) this.err('as= names one copy, so duplicate one target', this.raw('as')!.keyToken);
      const n = this.raw('as')!;
      const alias = n.value.type === 'word' ? n.value.text : n.value.type === 'string' ? n.value.value : this.err('as= takes an alias', n.value);
      const src = this.target(this.args.pos[0]!);
      op.as = alias;
      op.id = this.uuidFor();
      this.emit(this.withOffset(op));
      this.register(alias, { id: op.id, kind: src.kind, ...(src.assetId ? { assetId: src.assetId } : {}) }, n.value);
      return;
    }
    this.emit(this.withOffset(op));
  }

  private withOffset(op: Extract<Operation, { op: 'duplicate' }>): Operation {
    if (this.has('dx') || this.has('dy')) op.offset = { xPt: this.has('dx') ? this.dim(this.raw('dx')!) : 0, yPt: this.has('dy') ? this.dim(this.raw('dy')!) : 0 };
    if (this.has('keepAliases')) op.keepAliases = this.bool(this.raw('keepAliases')!);
    if (this.has('keepExternalLinks')) op.keepExternalLinks = this.bool(this.raw('keepExternalLinks')!);
    return op;
  }

  // ---- arrange
  private cmdAlign(cmd: Command): void {
    const t = cmd.positionals[0];
    const word = t?.type === 'word' ? t.text : '';
    const edge = ({ left: 'left', center: 'center', hcenter: 'center', right: 'right', top: 'top', middle: 'middle', vcenter: 'middle', bottom: 'bottom' } as Record<string, string>)[word];
    if (!edge) this.err('align needs left, center (or hcenter), right, top, middle (or vcenter) or bottom', t ?? cmd.span);
    this.begin(cmd, 1);
    this.finish([]);
    this.emit({ op: 'align', targets: this.ids(this.args.pos, 2, 'align'), edge: edge as 'left' });
  }

  private axis(cmd: Command): 'horizontal' | 'vertical' {
    const t = cmd.positionals[0];
    if (!t || t.type !== 'word' || (t.text !== 'horizontal' && t.text !== 'vertical')) this.err(`${cmd.verb} needs horizontal or vertical`, t ?? cmd.span);
    return (t as Extract<ValueToken, { type: 'word' }>).text as 'horizontal';
  }

  private cmdDistribute(cmd: Command): void {
    const axis = this.axis(cmd);
    this.begin(cmd, 1);
    this.finish([]);
    this.emit({ op: 'distribute', targets: this.ids(this.args.pos, 3, 'distribute'), axis });
  }

  private cmdSetGap(cmd: Command): void {
    const axis = this.axis(cmd);
    this.begin(cmd, 1);
    this.finish([]);
    const last = this.args.pos[this.args.pos.length - 1];
    if (!last || last.type !== 'number') this.err('set-gap ends with a distance such as 20mm', last ?? cmd.span);
    if (!(last as { unit: string }).unit || !UNITS.includes((last as { unit: string }).unit)) this.err(`the gap ${(last as { raw: string }).raw} needs a unit (mm, cm, in, pt or px)`, last!);
    const l = last as Extract<ValueToken, { type: 'number' }>;
    if (l.value < 0) this.err('the gap cannot be negative', l);
    const targets = this.ids(this.args.pos.slice(0, -1), 2, 'set-gap');
    this.emit({ op: 'setGap', targets, axis, gapPt: toPoints(l.value, l.unit as Unit) });
  }

  /** reroute [connector...]: the router plans these automatic connectors again from scratch; no targets means all of them on the page. */
  private cmdReroute(cmd: Command): void {
    this.begin(cmd);
    this.finish([]);
    this.emit(this.args.pos.length ? { op: 'reroute', targets: this.ids(this.args.pos, 1, 'reroute') } : { op: 'reroute' });
  }

  /** move-segment CONNECTOR segment=N to=DIM | by=DIM: slides one inner run of an orthogonal connector sideways. */
  private cmdMoveSegment(cmd: Command): void {
    this.begin(cmd);
    this.finish(['segment', 'to', 'by']);
    const known = this.single(cmd, 'move-segment');
    if (known.kind !== 'connector') this.err('move-segment takes a connector', cmd.span);
    if (this.has('to') === this.has('by')) this.err('give exactly one of to= and by=', cmd.span, 'to= is where the run goes, by= is how far it moves');
    const segment = this.num(this.need('segment'), 0, 511);
    if (!Number.isInteger(segment)) this.err('segment= takes a whole number', this.raw('segment')!.value);
    this.emit(this.has('to')
      ? { op: 'moveSegment', target: known.id, segment, to: this.signedDim(this.raw('to')!) }
      : { op: 'moveSegment', target: known.id, segment, by: this.signedDim(this.raw('by')!) });
  }

  /** pin-segment CONNECTOR segment=N / unpin-segment CONNECTOR segment=N: holds an inner run where it is, or lets the router choose it again. */
  private cmdPinSegment(cmd: Command): void {
    this.begin(cmd);
    this.finish(['segment']);
    const known = this.single(cmd, cmd.verb);
    if (known.kind !== 'connector') this.err(`${cmd.verb} takes a connector`, cmd.span);
    const segment = this.num(this.need('segment'), 0, 511);
    if (!Number.isInteger(segment)) this.err('segment= takes a whole number', this.raw('segment')!.value);
    this.emit({ op: 'pinSegment', target: known.id, segment, pinned: cmd.verb === 'pin-segment' });
  }

  private cmdZ(cmd: Command): void {
    const t = cmd.positionals[0];
    const to = t?.type === 'word' ? t.text : '';
    if (!['front', 'back', 'forward', 'backward'].includes(to)) this.err('z needs front, back, forward or backward', t ?? cmd.span);
    this.begin(cmd, 1);
    this.finish([]);
    this.emit({ op: 'reorder', targets: this.ids(this.args.pos, 1, 'z'), to: to as 'front' });
  }

  // ---- layer
  private cmdLayer(cmd: Command): void {
    const action = this.sub(cmd, ['add', 'set', 'assign']);
    this.begin(cmd, 1);
    const flags = ['visible', 'locked', 'printable', 'snap', 'glue'];
    const flagPatch = (): Record<string, unknown> => {
      const p: Record<string, unknown> = {};
      for (const f of flags) if (this.has(f)) p[f] = this.bool(this.raw(f)!);
      if (this.has('color')) p.colourOverride = this.colour(this.raw('color')!);
      return p;
    };
    const name = (t: ValueToken | undefined): string => {
      if (!t || (t.type !== 'string' && t.type !== 'word')) return this.err(`layer ${action} needs the layer name first`, t ?? cmd.span);
      return t.type === 'string' ? t.value : t.text;
    };
    if (action === 'add') {
      this.finish([...flags, 'color']);
      if (this.args.pos.length !== 1) this.err('layer add needs a name: layer add "Notes"', cmd.span);
      const pageId = this.pageIdForCreate();
      const layerName = name(this.args.pos[0]);
      const id = this.uuidFor();
      this.emit({ op: 'addLayer', pageId, id, name: layerName, ...flagPatch() } as Operation);
      const here = this.scene.layers.get(pageId) ?? new Map<string, string>();
      here.set(layerName, id);
      this.scene.layers.set(pageId, here);
      return;
    }
    if (action === 'set') {
      this.finish([...flags, 'color', 'name']);
      if (this.args.pos.length !== 1) this.err('layer set needs the layer name: layer set "Notes" visible=false', cmd.span);
      const layerId = this.layerId(name(this.args.pos[0]), this.args.pos[0]!);
      const patch = flagPatch();
      if (this.has('name')) patch.name = this.str(this.raw('name')!);
      if (!Object.keys(patch).length) this.err('layer set needs at least one field', cmd.span);
      this.emit({ op: 'setLayer', layerId, patch: patch as never });
      return;
    }
    this.finish(['mode']);
    const layerId = this.layerId(name(this.args.pos[0]), this.args.pos[0]!);
    const targets = this.ids(this.args.pos.slice(1), 1, 'layer assign');
    const op: Operation = { op: 'assignLayers', targets, layerIds: [layerId] };
    if (this.has('mode')) op.mode = this.enumValue(this.raw('mode')!, ['set', 'add', 'remove'] as const);
    this.emit(op);
  }

  private mapAsset(id: string): string { return this.assetRemap.get(id) ?? id; }

  // ---- asset
  private cmdAsset(cmd: Command): void {
    const action = this.sub(cmd, ['import', 'replace', 'replace-all']);
    this.begin(cmd, 1);
    if (action === 'import') {
      this.finish(['prepared']);
      if (this.args.pos.length) this.err('asset import takes prepared=<name>', this.args.pos[0]!);
      const n = this.need('prepared');
      const key = this.wordOrString(n);
      const ref = this.ctx.preparedAssetRefs?.[key];
      if (!ref) this.err(`no prepared asset called "${key}"`, n.value, `prepared assets: ${Object.keys(this.ctx.preparedAssetRefs ?? {}).join(', ') || 'none supplied'}`);
      const plan = prepareDocumentAsset({ ...this.ctx.snapshot, document: { ...this.ctx.snapshot.document, assets: [...this.ctx.snapshot.document.assets, ...this.importedAssets] } }, ref!);
      for (const op of plan.operations) { this.emit(op); if (op.op === 'registerAsset') this.importedAssets.push(op.asset); }
      this.assetRemap.set(ref!.asset.id, plan.resolvedAssetId);
      this.scene.assets.add(plan.resolvedAssetId);
      return;
    }
    if (action === 'replace-all') {
      this.finish(['from', 'to']);
      const from = this.str(this.need('from')), to = this.mapAsset(this.str(this.need('to')));
      if (!this.scene.assets.has(to)) this.err(`unknown asset "${to}"`, this.raw('to')!.value);
      this.emit({ op: 'replaceAsset', from, to });
      return;
    }
    this.finish(['to']);
    const to = this.mapAsset(this.str(this.need('to')));
    if (!this.scene.assets.has(to)) this.err(`unknown asset "${to}"`, this.raw('to')!.value);
    if (!this.args.pos.length) this.err('asset replace needs the images to change; use asset replace-all from= to= for every reference', cmd.span);
    // images that point at different assets need one operation each
    const byFrom = new Map<string, string[]>();
    for (const t of this.args.pos) {
      const k = this.target(t);
      if (k.kind !== 'image') this.err('asset replace applies to images', t);
      const from = k.assetId!;
      byFrom.set(from, [...(byFrom.get(from) ?? []), k.id]);
    }
    for (const [from, targets] of byFrom) this.emit({ op: 'replaceAsset', from, to, targets });
  }
}


/** The compiler the app hands to CommandEngine.executeScript: it allocates real UUIDs, and is only reached after the engine's cache and revision checks. */
export const drawScriptCompiler: ScriptCompiler = (script, snapshot, context) => compile(script, {
  snapshot, newUuid: () => crypto.randomUUID(),
  ...(context.pageId ? { pageId: context.pageId } : {}), ...(context.preparedAssetRefs ? { preparedAssetRefs: context.preparedAssetRefs } : {}),
});
