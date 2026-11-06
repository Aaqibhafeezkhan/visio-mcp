import type {
  Asset, Attachment, Bounds, ConnectorElement, DiagramDocument, Element, Endpoint, EndpointInput, GroupElement, ImageElement, Layer, LineStyle,
  Operation, Page, PathAnchor, Point, RouteChange, ShapeElement, ShapeStyle, TextBlock, TextElement,
} from '../contracts/generated';
import { canonicalSerialize } from '../model/canonical';
import { fail, ok, type Result } from '../model/result';
import { toPoints } from '../model/validate';
import { computeArrange, planZ, type ArrangeItem, type ArrangeOp } from './arrange';
import { emptyDiffBody, type DiffBody } from './diff';
import {
  centreOf, isRightAngle, mapConnectorPoints, mapRouting, rotatePoint, rotateRect, scaleRect, translateBounds, unionBounds, visualBounds,
  type PointMap,
} from './geometry';
import { ancestorsOf, groupBoundsFrom, leavesUnder } from './groups';
import { lookupTarget } from './resolveTarget';
import { pointOnRoute } from './pathAnchor';
import { parsePath } from '../geometry/svgPath';
import { isOutlinePreset, PRESET_PORTS } from '../geometry/presetOutlines';
import { paintProblem } from '../model/paint';
import { planRoutes } from '../layout/routePlanner';
import { addressOf, moveSegment, readdress, segmentsOf, type RunConstraint } from '../layout/routeSegments';
import { readDocumentDefaults, textDefaults } from '../model/documentDefaults';
import { compareElementOrder, effectiveLevel } from '../model/elementOrder';
import { containerAncestors, containerParents, isContainer, type ContainerShape } from '../layout/containers';

export interface PlanContext {
  newId(): string;
  /** Page scope of the request; defaults to the only page of a one-page document. */
  pageId?: string;
}

export interface Plan {
  forward: DiffBody;
  inverse: DiffBody;
  created: string[];
  changed: string[];
  deleted: string[];
  changedPageIds: string[];
  changedLayerIds: string[];
  changedAssetIds: string[];
  visuallyAffectedIds: string[];
  description: string;
  noChange: boolean;
  /** R20: connectors whose stored route is forgotten by this plan, so the router plans them from scratch. */
  freshRoutes?: string[];
  /** R20: filled by settleRoutes. */
  routeChanges?: RouteChange[];
  /** R22: policy-aware route findings used by transaction preflight. */
  routeFindings?: import('../contracts/generated').RouteFinding[];
}

const DEFAULT_SHAPE_STYLE: ShapeStyle = {
  fill: { kind: 'solid', colour: '#ffffff', opacity: 1 }, stroke: { kind: 'solid', colour: '#333333', opacity: 1 },
  strokeWidthPt: 1, dash: 'solid', lineCap: 'butt', lineJoin: 'miter',
};
const DEFAULT_LINE_STYLE: LineStyle = { colour: '#334155', widthPt: 1, dash: 'solid', startArrow: 'none', endArrow: 'block' };
const SHAPE_ONLY_STYLE = ['fill', 'stroke', 'strokeWidthPt', 'lineCap', 'lineJoin'];
const LINE_ONLY_STYLE = ['colour', 'widthPt', 'startArrow', 'endArrow', 'startArrowSize', 'endArrowSize'];
/** R17: the least width or height a container fitted to its members takes. */
const MIN_FIT_PT = 1;

type PatchObj = Record<string, unknown>;
type Hit = { page: Page; pageIdx: number; index: number; element: Element };
type RectElement = ShapeElement | TextElement | ImageElement;

class Failure extends Error {
  constructor(readonly result: Result<never>) { super('plan failure'); }
}
function stop(code: Parameters<typeof fail>[0], message: string, details?: Record<string, unknown>): never {
  throw new Failure(fail(code, message, details ? { details } : {}));
}
/** An invalid_request that names the rule broken, so callers can react without parsing the message. */
function refuse(reason: string, message: string, details: Record<string, unknown> = {}): never {
  return stop('invalid_request', message, { reason, ...details });
}

const merge = <T extends object>(base: T, patch: PatchObj): T => ({ ...base, ...(patch as Partial<T>) });
/** Text patches: `insetsPt` merges per side, null (or a new uniform paddingPt) returns to the uniform margin. */
function mergeText(base: TextBlock, patch: PatchObj): TextBlock {
  const { insetsPt, ...rest } = patch;
  const next: TextBlock = { ...base, ...(rest as Partial<TextBlock>) };
  if (insetsPt === null || (insetsPt === undefined && 'paddingPt' in rest)) delete next.insetsPt;
  else if (insetsPt !== undefined) { const pad = base.paddingPt; next.insetsPt = { top: pad, right: pad, bottom: pad, left: pad, ...base.insetsPt, ...(insetsPt as object) }; }
  if (next.orientation === 'horizontal') delete next.orientation;
  return next;
}
const plusZero = (n: number): number => n + 0; // turns -0 into 0, so right-angle maths never leaves a negative zero behind
const sameBounds = (a: Bounds, b: Bounds): boolean => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const storedLevel = (level: number | undefined): { level?: number } => level === undefined || level === 0 ? {} : { level };
function withStoredLevel<T extends Element>(element: T, level: number): T {
  const next = { ...element } as T & { level?: number };
  if (level === 0) delete next.level; else next.level = level;
  return next;
}
type ContainerData = NonNullable<ShapeElement['container']>;
/** Container settings in their single stored form: fit "none" and a zero margin are the defaults and are not written. */
function withContainerSettings(base: ContainerData, patch: { fit?: ContainerData['fit']; marginPt?: number }): ContainerData {
  const next: ContainerData = { ...base, memberIds: [...base.memberIds] };
  if (patch.fit !== undefined) { if (patch.fit === 'none') delete next.fit; else next.fit = patch.fit; }
  if (patch.marginPt !== undefined) { if (patch.marginPt === 0) delete next.marginPt; else next.marginPt = patch.marginPt; }
  return next;
}

/** Plans a batch against `doc` without touching it. All-or-nothing: any failure returns an error and no plan. */
export function planPatch(doc: DiagramDocument, operations: Operation[], ctx: PlanContext): Result<Plan> {
  try {
    return ok(new Planner(doc, ctx).run(operations));
  } catch (e) {
    if (e instanceof Failure) return e.result;
    throw e;
  }
}

interface Transform {
  /** Applied to shapes, text and images. */
  rect(el: RectElement): RectElement;
  /** Applied to free connector endpoints and waypoints. */
  point: PointMap;
}

class Planner {
  /** Connectors whose stored route this plan forgets (route mode reset, reroute). */
  private fresh = new Set<string>();
  private pages: Page[];
  private assets: Asset[];
  private readonly origElements = new Map<string, { pageId: string; index: number; element: Element }>();
  private readonly origAssets = new Map<string, { index: number; asset: Asset }>();
  /** child id to its group's id. Kept in step with every structural change so ancestors are always at hand. */
  private readonly parents = new Map<string, string>();
  /** Elements written by the operation in progress; their ancestor groups get fresh derived bounds afterwards. */
  private touched = new Set<string>();
  /** Everything written by the batch so far; containers that grow or fit settle around these at the end. */
  private readonly allTouched = new Set<string>();
  private readonly scopePageId: string | undefined;

  constructor(private readonly doc: DiagramDocument, private readonly ctx: PlanContext) {
    this.pages = doc.pages.slice();
    this.assets = doc.assets.slice();
    doc.assets.forEach((asset, index) => this.origAssets.set(asset.id, { index, asset }));
    for (const p of doc.pages) {
      p.elements.forEach((element, index) => {
        this.origElements.set(element.id, { pageId: p.id, index, element });
        if (element.kind === 'group') for (const c of element.childIds) this.parents.set(c, element.id);
      });
    }
    this.scopePageId = ctx.pageId ?? (doc.pages.length === 1 ? doc.pages[0]!.id : undefined);
    if (ctx.pageId && !doc.pages.some(p => p.id === ctx.pageId)) stop('not_found', `page ${ctx.pageId} does not exist`);
  }

  // ---------------------------------------------------------------- lookup helpers
  private pageIndex(pageId: string): number {
    const i = this.pages.findIndex(p => p.id === pageId);
    if (i < 0) stop('not_found', `page ${pageId} does not exist`);
    return i;
  }

  private findById(id: string): Hit | undefined {
    for (let pi = 0; pi < this.pages.length; pi++) {
      const index = this.pages[pi]!.elements.findIndex(e => e.id === id);
      if (index >= 0) return { page: this.pages[pi]!, pageIdx: pi, index, element: this.pages[pi]!.elements[index]! };
    }
    return undefined;
  }

  private store(pageIdx: number, index: number, element: Element): void {
    const page = this.pages[pageIdx]!;
    const elements = page.elements.slice();
    elements[index] = element;
    this.pages[pageIdx] = { ...page, elements };
    this.touched.add(element.id);
  }

  /** Replaces an element wherever it is, by id. */
  private put(element: Element): void {
    const hit = this.findById(element.id)!;
    this.store(hit.pageIdx, hit.index, element);
  }

  private byIdMap(pageIdx: number): Map<string, Element> {
    return new Map(this.pages[pageIdx]!.elements.map(e => [e.id, e] as const));
  }

  private defaultPage(pageId: string | undefined): number {
    const id = pageId ?? this.scopePageId;
    if (!id) return stop('invalid_request', 'this request needs a pageId: the document has more than one page');
    return this.pageIndex(id);
  }

  /** UUID first, then page-scoped alias, then exact display name. Ambiguous names are reported, never guessed. */
  private resolve(ref: string, pageId?: string): Hit {
    const r = lookupTarget(this.pages, ref, pageId ?? this.scopePageId);
    if (!r.ok) return stop(r.code, r.message, r.details);
    const page = this.pages[r.pageIdx]!;
    return { page, pageIdx: r.pageIdx, index: r.index, element: page.elements[r.index]! };
  }

  /** Resolves a list of targets that must sit on one page and may not include both a group and one of its descendants. */
  private resolveSet(targets: readonly string[]): { pageIdx: number; ids: string[] } {
    const hits = targets.map(t => this.resolve(t, this.ctx.pageId));
    const pageIdx = hits[0]!.pageIdx;
    if (hits.some(h => h.pageIdx !== pageIdx)) refuse('mixed_pages', 'the targets are not all on the same page');
    const ids = hits.map(h => h.element.id);
    if (new Set(ids).size !== ids.length) refuse('duplicate_target', 'the same element is targeted twice');
    const chosen = new Set(ids);
    for (const id of ids) {
      const above = ancestorsOf(this.parents, id).find(a => chosen.has(a));
      if (above) refuse('ancestor_and_descendant_selection', 'a group and one of its own members are both targeted', { group: above, member: id });
    }
    return { pageIdx, ids };
  }

  private layerLocked(page: Page, el: Element): boolean {
    return el.layerIds.some(id => page.layers.find(l => l.id === id)?.locked);
  }

  private assertEditable(page: Page, el: Element, what: string): void {
    if (el.locked || this.layerLocked(page, el)) stop('locked_target', `${el.id} is locked: ${what} refused`, { target: el.id });
    for (const a of ancestorsOf(this.parents, el.id)) {
      const g = page.elements.find(e => e.id === a);
      if (g && (g.locked || this.layerLocked(page, g))) stop('locked_target', `${el.id} belongs to locked group ${a}: ${what} refused`, { target: el.id, group: a });
    }
  }

  /** The element and everything beneath it must be free to change. */
  private assertSubtreeEditable(pageIdx: number, rootId: string, what: string): void {
    const page = this.pages[pageIdx]!;
    const byId = this.byIdMap(pageIdx);
    this.assertEditable(page, byId.get(rootId)!, what);
    for (const id of this.descendants(byId, rootId)) {
      const el = byId.get(id)!;
      if (el.locked || this.layerLocked(page, el)) stop('locked_target', `${id} is locked: ${what} refused`, { target: id });
    }
  }

  /**
   * What moves with an element: the element, everything under it if it is a group and, through containers, every member at every depth
   * (with everything under those members). `containers` says whether a container with members was among them.
   */
  private carried(byId: ReadonlyMap<string, Element>, rootId: string): { ids: Set<string>; containers: boolean } {
    const ids = new Set<string>();
    let containers = false;
    const queue = [rootId];
    while (queue.length) {
      const id = queue.pop()!;
      const el = byId.get(id);
      if (!el || ids.has(id)) continue;
      ids.add(id);
      if (el.kind === 'group') queue.push(...el.childIds);
      if (isContainer(el) && el.container.memberIds.length) { containers = true; queue.push(...el.container.memberIds); }
    }
    return { ids, containers };
  }

  /** The element and everything that moves with it must be free to change. */
  private assertCarriedEditable(pageIdx: number, rootId: string, what: string): void {
    const page = this.pages[pageIdx]!;
    const byId = this.byIdMap(pageIdx);
    this.assertEditable(page, byId.get(rootId)!, what);
    for (const id of this.carried(byId, rootId).ids) {
      const el = byId.get(id)!;
      if (el.locked || this.layerLocked(page, el)) stop('locked_target', `${id} is locked: ${what} refused`, { target: id });
    }
  }

  /** Every element under a group, nested groups included, not the root itself. */
  private descendants(byId: ReadonlyMap<string, Element>, rootId: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([rootId]);
    const walk = (id: string) => {
      const el = byId.get(id);
      if (el?.kind !== 'group') return;
      for (const c of el.childIds) if (!seen.has(c)) { seen.add(c); out.push(c); walk(c); }
    };
    walk(rootId);
    return out;
  }

  private assertFinite(n: number, what: string): void {
    if (!Number.isFinite(n)) stop('invalid_request', `${what} must be a finite number`);
  }

  private assertLayers(page: Page, layerIds: readonly string[]): void {
    for (const l of layerIds) if (!page.layers.some(x => x.id === l)) stop('invalid_request', `unknown layer ${l} on page ${page.name}`, { layerId: l });
  }

  private assertAlias(page: Page, alias: string, selfId: string | undefined): void {
    if (page.elements.some(e => e.alias === alias && e.id !== selfId)) stop('invalid_request', `alias "${alias}" is already used on page ${page.name}`, { alias });
  }

  private assertAsset(assetId: string): void {
    if (!this.assets.some(a => a.id === assetId)) stop('invalid_request', `unknown asset ${assetId}`, { assetId });
  }

  private assertPositive(b: Bounds, id: string): void {
    for (const [k, v] of Object.entries(b)) this.assertFinite(v, `bounds.${k}`);
    if (!(b.width > 0 && b.height > 0)) stop('invalid_request', `element ${id} must have a positive width and height`, { target: id });
  }

  // ---------------------------------------------------------------- endpoint handling
  private endpointPoint(ep: Endpoint | EndpointInput, resolvedId?: string): Point {
    if (ep.glue === 'none') return ep.point ?? this.joinPoint(ep as Endpoint);
    const hit = this.findById(resolvedId ?? (ep as Endpoint).elementId!)!;
    return centreOf(hit.element.bounds);
  }

  /** Where a joined end starts out: the place on the target's straight-line route; the engine then moves it onto the drawn route. */
  private joinPoint(ep: Endpoint): Point {
    const hit = ep.join && this.findById(ep.join.connectorId);
    if (!hit || hit.element.kind !== 'connector') return { x: 0, y: 0 };
    const c = hit.element as ConnectorElement;
    const pts = [c.from.point ?? this.endpointPoint(c.from), ...c.waypoints, c.to.point ?? this.endpointPoint(c.to)];
    return pointOnRoute(pts, ep.join!.position, 0)?.point ?? pts[0]!;
  }

  private resolveJoin(input: NonNullable<EndpointInput['join']>, pageId: string, selfId: string): NonNullable<Endpoint['join']> {
    const hit = this.resolve(input.connector, pageId);
    if (hit.page.id !== pageId) stop('invalid_request', 'a connector can only join a connector on its own page');
    if (hit.element.kind !== 'connector') stop('invalid_request', `${input.connector} is not a connector: only a connector can be joined`);
    if (hit.element.id === selfId) stop('invalid_request', 'a connector cannot join itself');
    // A chain of joins is fine; a loop (this joins that, that already joins this, directly or through others) has no place to stand.
    const seen = new Set<string>();
    for (let c: ConnectorElement | undefined = hit.element as ConnectorElement; c && !seen.has(c.id);) {
      seen.add(c.id);
      if ([c.from, c.to].some(ep => ep.join?.connectorId === selfId)) stop('invalid_request', 'these connectors would join each other in a loop');
      const next: string | undefined = [c.from, c.to].find(ep => ep.join)?.join?.connectorId;
      const n: { element: Element } | undefined = next ? this.findById(next) : undefined;
      c = n && n.element.kind === 'connector' ? n.element as ConnectorElement : undefined;
    }
    const position = input.position ?? 0.5;
    this.assertFinite(position, 'position');
    if (position < 0 || position > 1) stop('invalid_request', `position ${position} is outside 0 to 1 (the fraction of the connector's length from its start)`);
    return { connectorId: hit.element.id, position };
  }

  private resolveEndpoint(input: EndpointInput, pageId: string, selfId: string): Endpoint {
    if (input.join) {
      if (input.glue !== 'none' || input.point || input.elementId !== undefined || input.port !== undefined) stop('invalid_request', 'a joined end has glue none and no point, elementId or port');
      const join = this.resolveJoin(input.join, pageId, selfId);
      const ep: Endpoint = { glue: 'none', join };
      ep.point = this.joinPoint(ep);
      return ep;
    }
    if (input.glue === 'none') {
      if (!input.point || input.elementId !== undefined || input.port !== undefined) stop('invalid_request', 'a free endpoint needs a point and no elementId or port');
      const point = input.point;
      this.assertFinite(point.x, 'point.x'); this.assertFinite(point.y, 'point.y');
      return { point: { ...point }, glue: 'none' };
    }
    if (!input.elementId || input.point) stop('invalid_request', 'a glued endpoint needs an elementId and no point');
    const hit = this.resolve(input.elementId!, pageId);
    if (hit.page.id !== pageId) stop('invalid_request', 'a connector can only attach to elements on its own page');
    if (hit.element.kind === 'connector' || hit.element.id === selfId) stop('invalid_request', 'a connector cannot attach to a connector or to itself');
    if ((hit.element.kind === 'shape' || hit.element.kind === 'text') && hit.element.attachment?.connectorId === selfId) stop('invalid_request', 'a connector cannot be glued to an element that rides on it');
    const ep: Endpoint = { elementId: hit.element.id, glue: input.glue };
    if (input.port !== undefined) ep.port = input.port;
    if (input.preferredSide != null) ep.preferredSide = input.preferredSide;
    return ep;
  }

  /** An attachment to a connector on the same page: the connector may be named by alias or id, and may be one created earlier in the batch. */
  private resolveAttachment(input: { connector: string; position?: number; offsetPt?: number }, pageId: string, selfId: string): Attachment {
    const hit = this.resolve(input.connector, pageId);
    if (hit.page.id !== pageId) stop('invalid_request', 'an element can only attach to a connector on its own page');
    if (hit.element.kind !== 'connector') stop('invalid_request', `${input.connector} is not a connector: only a connector can carry attached elements`);
    if (hit.element.id === selfId) stop('invalid_request', 'an element cannot attach to itself');
    if (hit.element.from.elementId === selfId || hit.element.to.elementId === selfId) stop('invalid_request', 'an element cannot ride a connector that is glued to it');
    return { connectorId: hit.element.id, ...this.anchorOf(input) };
  }

  private anchorOf(input: { position?: number; offsetPt?: number }): PathAnchor {
    const position = input.position ?? 0.5, offsetPt = input.offsetPt ?? 0;
    this.assertFinite(position, 'position'); this.assertFinite(offsetPt, 'offsetPt');
    if (position < 0 || position > 1) stop('invalid_request', `position ${position} is outside 0 to 1 (the fraction of the connector's length from its start)`);
    return { position, offsetPt };
  }

  private connectorBounds(from: Endpoint, to: Endpoint, waypoints: readonly Point[]): Bounds {
    const pts = [this.endpointPoint(from), this.endpointPoint(to), ...waypoints];
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }

  // ---------------------------------------------------------------- batch
  run(operations: Operation[]): Plan {
    for (const [index, op] of operations.entries()) {
      this.touched = new Set();
      try {
        this.apply(op);
        this.refreshGroups();
        for (const id of this.touched) this.allTouched.add(id);
      } catch (e) {
        // Say which operation failed, so a script can point at the line it came from.
        if (e instanceof Failure && !e.result.ok) e.result.error.details = { ...e.result.error.details, operationIndex: index };
        throw e;
      }
    }
    this.finalValidate();
    this.settleContainerFits();
    return this.buildPlan(operations);
  }

  private nextZ(page: Page): number {
    return page.elements.reduce((m, e) => Math.max(m, e.zIndex), 0) + 1;
  }

  private newElementId(requested: string | undefined): string {
    const id = requested ?? this.ctx.newId();
    if (this.findById(id) || this.origElements.has(id)) stop('invalid_request', `element id ${id} already exists`, { id });
    return id;
  }

  private addElement(pageIdx: number, el: Element): void {
    const page = this.pages[pageIdx]!;
    this.pages[pageIdx] = { ...page, elements: [...page.elements, el] };
    this.touched.add(el.id);
  }

  private removeElements(pageIdx: number, doomed: ReadonlySet<string>): void {
    const page = this.pages[pageIdx]!;
    this.pages[pageIdx] = { ...page, elements: page.elements.filter(e => !doomed.has(e.id)) };
    // A removed member leaves its group; the group is rewritten and so reported. An emptied group is refused at the end.
    for (const id of doomed) {
      const parent = this.parents.get(id);
      this.parents.delete(id);
      if (!parent || doomed.has(parent)) continue;
      const g = this.findById(parent)!.element as GroupElement;
      this.put({ ...g, childIds: g.childIds.filter(c => !doomed.has(c)) });
    }
    // A removed member leaves its container, which is rewritten and so reported. An empty container is still a container.
    for (const c of this.pages[pageIdx]!.elements) {
      if (!isContainer(c) || !c.container.memberIds.some(m => doomed.has(m))) continue;
      this.put({ ...c, container: { ...c.container, memberIds: c.container.memberIds.filter(m => !doomed.has(m)) } });
    }
  }

  /** Recomputes the derived bounds of every group above (or among) the elements the last operation wrote. */
  private refreshGroups(): void {
    const groups = new Set<string>();
    for (const id of this.touched) {
      const hit = this.findById(id);
      if (!hit) { for (const a of ancestorsOf(this.parents, id)) groups.add(a); continue; }
      if (hit.element.kind === 'group') groups.add(id);
      for (const a of ancestorsOf(this.parents, id)) groups.add(a);
    }
    for (const gid of groups) {
      const hit = this.findById(gid);
      if (!hit || hit.element.kind !== 'group' || hit.element.childIds.length === 0) continue;
      const byId = this.byIdMap(hit.pageIdx);
      const bounds = groupBoundsFrom(byId, hit.element);
      const leaves = leavesUnder(byId, gid).map(id => byId.get(id)!).sort(compareElementOrder);
      const top = leaves[leaves.length - 1]!;
      const derivedLevel = storedLevel(effectiveLevel(top));
      if (!sameBounds(bounds, hit.element.bounds) || hit.element.zIndex !== top.zIndex || hit.element.level !== derivedLevel.level) {
        this.store(hit.pageIdx, hit.index, withStoredLevel({ ...hit.element, zIndex: top.zIndex, bounds }, effectiveLevel(top)));
      }
    }
  }

  // ---------------------------------------------------------------- transforms of whole subtrees
  /** Applies `xf` to every leaf under `rootId` (the element itself when it is a leaf). Connector bounds are recomputed afterwards. */
  private transformSubtree(pageIdx: number, rootId: string, xf: Transform): void {
    const byId = this.byIdMap(pageIdx);
    const leaves = leavesUnder(byId, rootId).map(id => byId.get(id)!);
    for (const el of leaves) {
      if (el.kind === 'connector' || el.kind === 'group') continue;
      this.put(xf.rect(el));
    }
    for (const el of leaves) {
      if (el.kind !== 'connector') continue;
      const next = mapConnectorPoints(el, xf.point);
      next.bounds = this.connectorBounds(next.from, next.to, next.waypoints);
      this.put(next);
    }
  }

  private translateSubtree(pageIdx: number, rootId: string, dx: number, dy: number): void {
    const shift: PointMap = p => ({ x: p.x + dx, y: p.y + dy });
    const carried = this.carried(this.byIdMap(pageIdx), rootId);
    if (!carried.containers) {
      this.transformSubtree(pageIdx, rootId, { rect: el => ({ ...el, bounds: translateBounds(el.bounds, dx, dy) }) as RectElement, point: shift });
      return;
    }
    // R17: a container carries its members at every depth. A connector carried, or glued at both ends to carried elements, moves whole:
    // its stored route travels with it rather than being planned again.
    for (const id of carried.ids) {
      const el = this.findById(id)!.element;
      if (el.kind !== 'connector' && el.kind !== 'group') this.put({ ...el, bounds: translateBounds(el.bounds, dx, dy) } as Element);
    }
    const inside = (c: ConnectorElement) => carried.ids.has(c.id) || (!!c.from.elementId && !!c.to.elementId && carried.ids.has(c.from.elementId) && carried.ids.has(c.to.elementId));
    for (const el of this.pages[pageIdx]!.elements) {
      if (el.kind !== 'connector' || !inside(el)) continue;
      const next = mapConnectorPoints(el, shift);
      next.bounds = this.connectorBounds(next.from, next.to, next.waypoints);
      this.put(next);
    }
  }

  /** Moves a container's members up into its own container, or to the top level. keepSelf leaves the container listed where it was (disband). */
  private releaseMembers(c: ContainerShape, keepSelf: boolean): void {
    const parentId = containerParents(this.findById(c.id)!.page.elements).get(c.id);
    if (parentId === undefined) return;
    const p = this.findById(parentId)!.element as ContainerShape;
    const memberIds = p.container.memberIds.flatMap(m => (m === c.id ? (keepSelf ? [c.id, ...c.container.memberIds] : c.container.memberIds) : [m]));
    this.put({ ...p, container: { ...p.container, memberIds } });
  }

  /**
   * R17: a container created with members goes just behind the lowest of them on its level, so it hides none of them and stays in front of
   * what lay below them, a page background included. When no stacking value is free there, the smaller side moves apart to make one.
   */
  private stackBehindMembers(pageIdx: number, id: string): void {
    const byId = this.byIdMap(pageIdx);
    const c = byId.get(id) as ContainerShape;
    const inside = new Set(c.container.memberIds.flatMap(m => leavesUnder(byId, m)));
    const peers = this.pages[pageIdx]!.elements.filter(e => e.kind !== 'group' && e.id !== id && effectiveLevel(e) === effectiveLevel(c)).sort(compareElementOrder);
    const first = peers.findIndex(e => inside.has(e.id));
    if (first < 0) return; // its members are all on other levels, which decide
    const below = peers.slice(0, first), above = peers.slice(first);
    const top = below.length ? below.at(-1)!.zIndex : -Infinity, bottom = above[0]!.zIndex;
    let z = bottom - 1;
    if (top >= z) {
      if (below.length <= above.length) for (const e of below) this.put({ ...e, zIndex: e.zIndex - (top - bottom + 2) });
      else { for (const e of above) this.put({ ...e, zIndex: e.zIndex + (top - bottom + 2) }); z = top + 1; }
    }
    this.put({ ...this.findById(id)!.element, zIndex: z });
  }

  /** Appends members to a container. An element already in another container moves here; one already here keeps its place. */
  private addMembers(pageIdx: number, containerId: string, targets: readonly string[]): void {
    const pageId = this.pages[pageIdx]!.id;
    const ids = targets.map(t => {
      const hit = this.resolve(t, pageId);
      if (hit.pageIdx !== pageIdx) refuse('container_member_other_page', `${hit.element.id} is on another page: a container holds elements on its own page`, { container: containerId, member: hit.element.id });
      if (hit.element.id === containerId) refuse('container_cycle', 'a container cannot contain itself', { target: containerId });
      return hit.element.id;
    });
    if (new Set(ids).size !== ids.length) refuse('duplicate_target', 'the same element is added twice', { container: containerId });
    const parents = containerParents(this.pages[pageIdx]!.elements);
    for (const id of ids) {
      const old = parents.get(id);
      if (old === undefined || old === containerId) continue;
      const o = this.findById(old)!.element as ContainerShape;
      this.assertEditable(this.pages[pageIdx]!, o, 'release a member');
      this.put({ ...o, container: { ...o.container, memberIds: o.container.memberIds.filter(m => m !== id) } });
    }
    const c = this.findById(containerId)!.element as ContainerShape;
    const fresh = ids.filter(id => !c.container.memberIds.includes(id));
    if (fresh.length) this.put({ ...c, container: { ...c.container, memberIds: [...c.container.memberIds, ...fresh] } });
  }

  private resizeGroup(pageIdx: number, g: GroupElement, patch: Partial<Bounds>): void {
    const gb = g.bounds;
    const nb: Bounds = { ...gb, ...patch };
    this.assertPositive(nb, g.id);
    if (!(gb.width > 0 && gb.height > 0)) refuse('degenerate_group', 'a group with no width or height cannot be scaled', { target: g.id });
    const sx = nb.width / gb.width, sy = nb.height / gb.height;
    const uniform = Math.abs(sx - sy) <= 1e-12 * Math.max(sx, sy);
    const byId = this.byIdMap(pageIdx);
    if (!uniform) {
      const skewed = leavesUnder(byId, g.id).map(id => byId.get(id)!).filter(e => e.kind !== 'connector' && e.kind !== 'group' && !isRightAngle(e.rotationDeg));
      if (skewed.length) refuse('nonuniform_group_scale', 'a group holding members turned by other than a right angle can only be scaled uniformly', { target: g.id, members: skewed.map(e => e.id) });
    }
    const shiftX = nb.x - gb.x, shiftY = nb.y - gb.y;
    this.transformSubtree(pageIdx, g.id, {
      rect: el => {
        const scaled = scaleRect(el.bounds, el.rotationDeg, { x: gb.x, y: gb.y }, sx, sy);
        return { ...el, bounds: translateBounds(scaled, shiftX, shiftY) } as RectElement;
      },
      point: p => ({ x: nb.x + (p.x - gb.x) * sx, y: nb.y + (p.y - gb.y) * sy }),
    });
  }

  private rotateGroup(pageIdx: number, g: GroupElement, deltaDeg: number, pivot: Point | undefined): void {
    const centre = pivot ?? centreOf(g.bounds);
    this.assertFinite(centre.x, 'pivot.xPt'); this.assertFinite(centre.y, 'pivot.yPt');
    this.transformSubtree(pageIdx, g.id, {
      rect: el => {
        const r = rotateRect(el.bounds, el.rotationDeg, centre, deltaDeg);
        return { ...el, bounds: { ...r.bounds, x: plusZero(r.bounds.x), y: plusZero(r.bounds.y) }, rotationDeg: plusZero(r.rotationDeg) } as RectElement;
      },
      point: p => { const q = rotatePoint(p, centre, deltaDeg); return { x: plusZero(q.x), y: plusZero(q.y) }; },
    });
  }

  /** Removes a group but keeps its members, which move up into the group's own parent if it has one. */
  private dissolveGroup(g: GroupElement): void {
    const parent = this.parents.get(g.id);
    const pageIdx = this.findById(g.id)!.pageIdx;
    for (const c of g.childIds) { if (parent) this.parents.set(c, parent); else this.parents.delete(c); }
    this.parents.delete(g.id);
    this.pages[pageIdx] = { ...this.pages[pageIdx]!, elements: this.pages[pageIdx]!.elements.filter(e => e.id !== g.id) };
    if (parent) {
      const p = this.findById(parent)!.element as GroupElement;
      this.put({ ...p, childIds: p.childIds.flatMap(c => (c === g.id ? g.childIds : [c])) });
    }
  }

  // ---------------------------------------------------------------- operations
  private apply(op: Operation): void {
    switch (op.op) {
      case 'createShape': {
        const pageIdx = this.defaultPage(op.pageId);
        const page = this.pages[pageIdx]!;
        const id = this.newElementId(op.id);
        if (op.alias) this.assertAlias(page, op.alias, undefined);
        const layerIds = op.layerIds ?? [];
        this.assertLayers(page, layerIds);
        if (op.style) for (const k of Object.keys(op.style)) if (LINE_ONLY_STYLE.includes(k)) stop('invalid_request', `style.${k} does not apply to a shape`);
        const el: ShapeElement = {
          id, kind: 'shape', layerIds: [...layerIds], zIndex: this.nextZ(page), locked: false, hidden: false,
          ...storedLevel(op.level),
          bounds: { ...op.bounds }, rotationDeg: op.rotationDeg ?? 0, metadata: {},
          geometry: merge({ preset: 'rectangle' } as ShapeElement['geometry'], (op.geometry ?? {}) as PatchObj),
          style: merge(DEFAULT_SHAPE_STYLE, (op.style ?? {}) as PatchObj),
        };
        const bad = paintProblem(el.style.fill, 'fill') ?? paintProblem(el.style.stroke, 'stroke'); if (bad) stop('invalid_request', bad);
        if (op.alias) el.alias = op.alias;
        if (op.name !== undefined) el.name = op.name;
        if (op.text) el.text = mergeText(textDefaults(this.doc), op.text as PatchObj);
        if (op.attachment) el.attachment = this.resolveAttachment(op.attachment, page.id, id);
        if (op.ports) el.ports = op.ports.map(p => ({ ...p }));
        else if (isOutlinePreset(el.geometry.preset)) el.ports = PRESET_PORTS[el.geometry.preset].map(p => ({ ...p })); // a flowchart symbol starts with its own connection points
        this.assertPositive(el.bounds, id);
        this.assertFinite(el.rotationDeg, 'rotationDeg');
        if (el.geometry.svgPath !== undefined) { const parsed = parsePath(el.geometry.svgPath); if (!parsed.ok) stop('invalid_request', parsed.error.message); }
        if (op.container) el.container = withContainerSettings({ memberIds: [] }, op.container);
        this.addElement(pageIdx, el);
        if (op.container?.memberIds?.length) { this.addMembers(pageIdx, id, op.container.memberIds); this.stackBehindMembers(pageIdx, id); }
        return;
      }
      case 'createText': {
        const pageIdx = this.defaultPage(op.pageId);
        const page = this.pages[pageIdx]!;
        const id = this.newElementId(op.id);
        if (op.alias) this.assertAlias(page, op.alias, undefined);
        const layerIds = op.layerIds ?? [];
        this.assertLayers(page, layerIds);
        const el: TextElement = {
          id, kind: 'text', layerIds: [...layerIds], zIndex: this.nextZ(page), locked: false, hidden: false,
          ...storedLevel(op.level),
          bounds: { ...op.bounds }, rotationDeg: op.rotationDeg ?? 0, metadata: {}, text: mergeText(textDefaults(this.doc), op.text as PatchObj),
        };
        if (op.alias) el.alias = op.alias;
        if (op.name !== undefined) el.name = op.name;
        if (op.attachment) el.attachment = this.resolveAttachment(op.attachment, page.id, id);
        this.assertPositive(el.bounds, id);
        this.assertFinite(el.rotationDeg, 'rotationDeg');
        this.addElement(pageIdx, el);
        return;
      }
      case 'createImage': {
        const pageIdx = this.defaultPage(op.pageId);
        const page = this.pages[pageIdx]!;
        const id = this.newElementId(op.id);
        if (op.alias) this.assertAlias(page, op.alias, undefined);
        const layerIds = op.layerIds ?? [];
        this.assertLayers(page, layerIds);
        this.assertAsset(op.assetId);
        const el: ImageElement = {
          id, kind: 'image', layerIds: [...layerIds], zIndex: this.nextZ(page), locked: false, hidden: false,
          ...storedLevel(op.level),
          bounds: { ...op.bounds }, rotationDeg: op.rotationDeg ?? 0, metadata: {}, assetId: op.assetId,
          fit: op.fit ?? 'contain', opacity: op.opacity ?? 1, preserveAspectRatio: op.preserveAspectRatio ?? true,
        };
        if (op.alias) el.alias = op.alias;
        if (op.name !== undefined) el.name = op.name;
        this.assertPositive(el.bounds, id);
        this.assertFinite(el.rotationDeg, 'rotationDeg');
        this.addElement(pageIdx, el);
        return;
      }
      case 'createConnector': {
        const pageIdx = this.defaultPage(op.pageId);
        const page = this.pages[pageIdx]!;
        const id = this.newElementId(op.id);
        if (op.alias) this.assertAlias(page, op.alias, undefined);
        const layerIds = op.layerIds ?? [];
        this.assertLayers(page, layerIds);
        if (op.style) for (const k of Object.keys(op.style)) if (SHAPE_ONLY_STYLE.includes(k)) stop('invalid_request', `style.${k} does not apply to a connector`);
        const from = this.resolveEndpoint(op.from, page.id, id);
        const to = this.resolveEndpoint(op.to, page.id, id);
        const waypoints = (op.waypoints ?? []).map(p => ({ ...p }));
        for (const p of waypoints) { this.assertFinite(p.x, 'waypoint.x'); this.assertFinite(p.y, 'waypoint.y'); }
        const el: ConnectorElement = {
          id, kind: 'connector', layerIds: [...layerIds], zIndex: this.nextZ(page), locked: false, hidden: false,
          ...storedLevel(op.level ?? effectiveLevel(page.elements.find(e => e.id === (from.join?.connectorId ?? from.elementId)) ?? { level: 0 } as Element)),
          bounds: this.connectorBounds(from, to, waypoints), rotationDeg: 0, metadata: {}, from, to,
          route: op.route ?? 'straight', waypoints, style: merge(DEFAULT_LINE_STYLE, (op.style ?? {}) as PatchObj),
        };
        if (op.alias) el.alias = op.alias;
        if (op.name !== undefined) el.name = op.name;
        if (op.label) el.label = mergeText(textDefaults(this.doc), op.label as PatchObj);
        if (op.labelAnchor) el.labelAnchor = this.anchorOf(op.labelAnchor);
        if (op.hops && op.hops !== 'none') el.hops = op.hops;
        this.addElement(pageIdx, el);
        if (op.routing) this.applyRouting(pageIdx, id, op.routing.mode);
        return;
      }
      case 'set': return this.applySet(op.target, op.patch as PatchObj);
      case 'move': {
        const { page, pageIdx, index, element } = this.resolve(op.target, this.ctx.pageId);
        this.assertFinite(op.delta.xPt, 'delta.xPt'); this.assertFinite(op.delta.yPt, 'delta.yPt');
        const { xPt: dx, yPt: dy } = op.delta;
        if (element.kind === 'group' || (isContainer(element) && element.container.memberIds.length)) {
          this.assertCarriedEditable(pageIdx, element.id, 'move');
          return this.translateSubtree(pageIdx, element.id, dx, dy);
        }
        this.assertEditable(page, element, 'move');
        if (element.kind === 'connector') {
          const freeFrom = element.from.glue === 'none', freeTo = element.to.glue === 'none';
          if (!freeFrom && !freeTo && element.waypoints.length === 0) return stop('invalid_request', 'a glued connector is positioned by its endpoints', { target: element.id });
          const shift = (ep: Endpoint): Endpoint => (ep.glue === 'none' ? { ...ep, point: { x: ep.point!.x + dx, y: ep.point!.y + dy } } : ep);
          const next: ConnectorElement = { ...element, from: shift(element.from), to: shift(element.to), waypoints: element.waypoints.map(p => ({ x: p.x + dx, y: p.y + dy })) };
          if (element.routing) next.routing = mapRouting(element.routing, p => ({ x: p.x + dx, y: p.y + dy }));
          next.bounds = this.connectorBounds(next.from, next.to, next.waypoints);
          this.store(pageIdx, index, next);
          return;
        }
        this.store(pageIdx, index, { ...element, bounds: { ...element.bounds, x: element.bounds.x + dx, y: element.bounds.y + dy } } as Element);
        return;
      }
      case 'resize': {
        const { page, pageIdx, index, element } = this.resolve(op.target, this.ctx.pageId);
        if (element.kind === 'group') {
          this.assertSubtreeEditable(pageIdx, element.id, 'resize');
          return this.resizeGroup(pageIdx, element, op.bounds);
        }
        this.assertEditable(page, element, 'resize');
        if (element.kind === 'connector') return stop('invalid_request', 'connector bounds are derived, not resized', { target: element.id });
        const bounds = { ...element.bounds, ...op.bounds };
        this.assertPositive(bounds, element.id);
        this.store(pageIdx, index, { ...element, bounds } as Element);
        return;
      }
      case 'rotate': {
        const { page, pageIdx, index, element } = this.resolve(op.target, this.ctx.pageId);
        if (element.kind === 'connector') { this.assertEditable(page, element, 'rotate'); return stop('invalid_request', 'connectors have no rotation', { target: element.id }); }
        if (element.kind === 'group') {
          this.assertSubtreeEditable(pageIdx, element.id, 'rotate');
          if (op.angleDeg !== undefined) refuse('group_rotation_requires_delta', 'a group has no orientation of its own: rotate it by deltaDeg', { target: element.id });
          this.assertFinite(op.deltaDeg!, 'deltaDeg');
          return this.rotateGroup(pageIdx, element, op.deltaDeg!, op.pivot ? { x: op.pivot.xPt, y: op.pivot.yPt } : undefined);
        }
        this.assertEditable(page, element, 'rotate');
        if (isContainer(element) && element.container.memberIds.length) refuse('container_rotation', 'a container with members cannot be rotated: rotate its members, or group the container with them and rotate the group', { target: element.id });
        if (op.pivot) return stop('invalid_request', 'pivot applies only to groups');
        const angle = op.angleDeg !== undefined ? op.angleDeg : element.rotationDeg + op.deltaDeg!;
        this.assertFinite(angle, 'rotation');
        this.store(pageIdx, index, { ...element, rotationDeg: angle } as Element);
        return;
      }
      case 'delete': return this.applyDelete(op);
      case 'setPage': {
        const idx = this.defaultPage(op.pageId);
        const page = this.pages[idx]!;
        const p = op.patch;
        const next: Page = { ...page };
        if (p.name !== undefined) next.name = p.name;
        if (p.widthPt !== undefined) next.widthPt = p.widthPt;
        if (p.heightPt !== undefined) next.heightPt = p.heightPt;
        if (p.background !== undefined) { const bad = paintProblem(p.background, 'background'); if (bad) stop('invalid_request', bad); next.background = p.background; }
        if (p.grid) next.grid = { ...page.grid, ...p.grid };
        if (p.guides !== undefined) {
          if (new Set(p.guides.map(g => g.id)).size !== p.guides.length) stop('invalid_request', 'duplicate guide id');
          next.guides = p.guides.map(g => ({ ...g }));
        }
        this.assertFinite(next.widthPt, 'widthPt'); this.assertFinite(next.heightPt, 'heightPt');
        this.pages[idx] = next;
        return;
      }
      case 'registerAsset': {
        const existing = this.assets.find(a => a.id === op.asset.id);
        if (existing) {
          if (canonicalSerialize(existing) !== canonicalSerialize(op.asset)) stop('invalid_request', `asset ${op.asset.id} already exists with different content`, { assetId: op.asset.id });
          return;
        }
        this.assets = [...this.assets, { ...op.asset, tags: [...op.asset.tags] }];
        return;
      }
      case 'group': return this.applyGroup(op);
      case 'ungroup': {
        const hit = this.resolve(op.target, this.ctx.pageId);
        if (hit.element.kind !== 'group') refuse('not_a_group', `${hit.element.id} is not a group`, { target: hit.element.id });
        this.assertEditable(hit.page, hit.element, 'ungroup');
        return this.dissolveGroup(hit.element as GroupElement);
      }
      case 'contain': return this.applyContain(op);
      case 'duplicate': return this.applyDuplicate(op);
      case 'align': case 'distribute': case 'setGap': return this.applyArrange(op);
      case 'reorder': return this.applyReorder(op.targets, op.to);
      case 'reroute': return this.applyReroute(op.targets);
      case 'moveSegment': return this.applyMoveSegment(op);
      case 'pinSegment': return this.applyPinSegment(op);
      case 'addPage': return this.applyAddPage(op);
      case 'reorderPage': {
        const from = this.pageIndex(op.pageId);
        const pages = this.pages.slice();
        const [moved] = pages.splice(from, 1);
        pages.splice(Math.min(op.index, pages.length), 0, moved!);
        this.pages = pages;
        return;
      }
      case 'duplicatePage': return this.applyDuplicatePage(op);
      case 'deletePage': {
        const idx = this.pageIndex(op.pageId);
        for (const e of this.pages[idx]!.elements) this.parents.delete(e.id);
        this.pages = this.pages.filter((_, i) => i !== idx);
        return;
      }
      case 'addLayer': {
        const pageIdx = this.defaultPage(op.pageId);
        const page = this.pages[pageIdx]!;
        const layerId = op.id ?? this.ctx.newId();
        if (page.layers.some(l => l.id === layerId)) stop('invalid_request', `layer id ${layerId} already exists`, { id: layerId });
        const layer: Layer = {
          id: layerId, name: op.name, visible: op.visible ?? true, locked: op.locked ?? false, printable: op.printable ?? true,
          snap: op.snap ?? true, glue: op.glue ?? true,
        };
        if (op.colourOverride) layer.colourOverride = op.colourOverride;
        this.pages[pageIdx] = { ...page, layers: [...page.layers, layer] };
        return;
      }
      case 'setLayer': {
        for (let pi = 0; pi < this.pages.length; pi++) {
          const page = this.pages[pi]!;
          const at = page.layers.findIndex(l => l.id === op.layerId);
          if (at < 0) continue;
          this.pages[pi] = { ...page, layers: page.layers.map((l, i) => (i === at ? merge(l, op.patch as PatchObj) : l)) };
          return;
        }
        return stop('not_found', `no layer ${op.layerId}`, { layerId: op.layerId });
      }
      case 'assignLayers': return this.applyAssignLayers(op.targets, op.layerIds, op.mode ?? 'add');
      case 'deleteLayer': {
        for (let pi = 0; pi < this.pages.length; pi++) {
          const page = this.pages[pi]!;
          if (!page.layers.some(l => l.id === op.layerId)) continue;
          this.pages[pi] = { ...page, layers: page.layers.filter(l => l.id !== op.layerId) };
          page.elements.forEach(e => {
            if (!e.layerIds.includes(op.layerId)) return;
            this.put({ ...e, layerIds: e.layerIds.filter(l => l !== op.layerId) });
          });
          return;
        }
        return stop('not_found', `no layer ${op.layerId}`, { layerId: op.layerId });
      }
      case 'setAsset': {
        const at = this.assets.findIndex(a => a.id === op.assetId);
        if (at < 0) return stop('not_found', `no asset ${op.assetId}`, { assetId: op.assetId });
        const next = { ...this.assets[at]!, ...(op.patch as PatchObj) } as Asset;
        if (op.patch.tags) next.tags = [...op.patch.tags];
        this.assets = this.assets.map((a, i) => (i === at ? next : a));
        return;
      }
      case 'removeAsset': {
        if (!this.assets.some(a => a.id === op.assetId)) return stop('not_found', `no asset ${op.assetId}`, { assetId: op.assetId });
        const users = this.pages.flatMap(p => p.elements.filter((e): e is ImageElement => e.kind === 'image' && e.assetId === op.assetId));
        if (users.length) stop('dependency_conflict', `asset ${op.assetId} is still used by ${users.length} image(s): replace those references first`, { assetId: op.assetId, elementIds: users.map(u => u.id) });
        this.assets = this.assets.filter(a => a.id !== op.assetId);
        return;
      }
      case 'replaceAsset': {
        this.assertAsset(op.to);
        if (!this.assets.some(a => a.id === op.from)) stop('not_found', `no asset ${op.from}`, { assetId: op.from });
        const targets: Hit[] = op.targets
          ? op.targets.map(t => this.resolve(t, this.ctx.pageId))
          : this.pages.flatMap((page, pageIdx) => page.elements
            .map((element, index) => ({ page, pageIdx, index, element }))
            .filter(h => h.element.kind === 'image' && h.element.assetId === op.from));
        for (const h of targets) {
          if (h.element.kind !== 'image' || h.element.assetId !== op.from) refuse('not_a_reference', `${h.element.id} does not reference ${op.from}`, { target: h.element.id });
          this.assertEditable(h.page, h.element, 'replace its asset');
        }
        for (const h of targets) this.put({ ...(this.findById(h.element.id)!.element as ImageElement), assetId: op.to });
        return;
      }
    }
  }

  private applyDelete(op: Extract<Operation, { op: 'delete' }>): void {
    const hit = this.resolve(op.target, this.ctx.pageId);
    const el = hit.element;
    this.assertEditable(hit.page, el, 'delete');
    if (op.children !== undefined && el.kind !== 'group') refuse('children_only_for_groups', 'children applies only when the target is a group', { target: el.id });
    if (op.members !== undefined && !isContainer(el)) refuse('members_only_for_containers', 'members applies only when the target is a container', { target: el.id });
    const doomed = new Set<string>([el.id]);
    if (isContainer(el) && el.container.memberIds.length) {
      if (!op.members) refuse('container_delete_requires_choice', 'deleting a container with members needs an explicit choice: members "delete" or "keep"', { target: el.id });
      if (op.members === 'keep') this.releaseMembers(el, false);
      else {
        this.assertCarriedEditable(hit.pageIdx, el.id, 'delete');
        for (const d of this.carried(this.byIdMap(hit.pageIdx), el.id).ids) doomed.add(d);
      }
    }
    if (el.kind === 'group') {
      if (!op.children) refuse('group_delete_requires_choice', 'deleting a group needs an explicit choice: children "delete" or "ungroup"', { target: el.id });
      if (op.children === 'ungroup') return this.dissolveGroup(el);
      this.assertSubtreeEditable(hit.pageIdx, el.id, 'delete');
      for (const d of this.descendants(this.byIdMap(hit.pageIdx), el.id)) doomed.add(d);
    }
    const page = this.pages[hit.pageIdx]!;
    const attached = (c: ConnectorElement) => doomed.has(c.from.elementId ?? '') || doomed.has(c.to.elementId ?? '');
    if (op.withConnectors) {
      for (const c of page.elements) {
        if (c.kind !== 'connector' || doomed.has(c.id) || !attached(c)) continue;
        this.assertEditable(page, c, 'delete');
        doomed.add(c.id);
      }
    }
    this.removeElements(hit.pageIdx, doomed);
  }

  private applyGroup(op: Extract<Operation, { op: 'group' }>): void {
    const { pageIdx, ids } = this.resolveSet(op.targets);
    for (const id of ids) {
      const parent = this.parents.get(id);
      if (parent) refuse('already_grouped', `${id} already belongs to group ${parent}: ungroup it first`, { target: id, group: parent });
    }
    const page = this.pages[pageIdx]!;
    const gid = this.newElementId(op.id);
    if (op.alias) this.assertAlias(page, op.alias, undefined);
    const byId = this.byIdMap(pageIdx);
    const top = ids.flatMap(i => leavesUnder(byId, i)).map(l => byId.get(l)!).sort(compareElementOrder).at(-1)!;
    const g: GroupElement = {
      id: gid, kind: 'group', layerIds: [], zIndex: top.zIndex, ...storedLevel(effectiveLevel(top)), locked: false, hidden: false, bounds: { x: 0, y: 0, width: 0, height: 0 },
      rotationDeg: 0, metadata: {}, childIds: [...ids],
    };
    if (op.alias) g.alias = op.alias;
    if (op.name !== undefined) g.name = op.name;
    byId.set(gid, g);
    g.bounds = groupBoundsFrom(byId, g);
    this.addElement(pageIdx, g);
    for (const c of ids) this.parents.set(c, gid);
  }

  /** Adds members to a container shape (which becomes a container if it was not one) and removes others, which move up a level. */
  private applyContain(op: Extract<Operation, { op: 'contain' }>): void {
    const hit = this.resolve(op.container, this.ctx.pageId);
    const el = hit.element;
    if (el.kind !== 'shape') refuse('container_must_be_shape', `${el.id} is a ${el.kind}: only a shape can be a container`, { target: el.id });
    this.assertEditable(hit.page, el, 'change its members');
    if (!isContainer(el)) this.put({ ...el, container: { memberIds: [] } });
    if (op.remove) {
      const ids = op.remove.map(t => this.resolve(t, hit.page.id).element.id);
      const c = this.findById(el.id)!.element as ContainerShape;
      for (const id of ids) if (!c.container.memberIds.includes(id)) refuse('not_a_member', `${id} is not a member of container ${c.id}`, { container: c.id, member: id });
      const both = op.add?.map(t => this.resolve(t, hit.page.id).element.id).find(id => ids.includes(id));
      if (both) refuse('duplicate_target', `${both} is both added and removed`, { container: c.id, member: both });
      this.put({ ...c, container: { ...c.container, memberIds: c.container.memberIds.filter(m => !ids.includes(m)) } });
      const parentId = containerParents(this.pages[hit.pageIdx]!.elements).get(c.id);
      if (parentId !== undefined) { // a removed member stays inside the container's own container
        const p = this.findById(parentId)!.element as ContainerShape;
        this.put({ ...p, container: { ...p.container, memberIds: [...p.container.memberIds, ...ids] } });
      }
    }
    if (op.add) this.addMembers(hit.pageIdx, el.id, op.add);
  }

  private applyArrange(op: ArrangeOp): void {
    const { pageIdx, ids } = this.resolveSet(op.targets);
    const items: ArrangeItem[] = ids.map((id, order) => {
      this.assertCarriedEditable(pageIdx, id, op.op);
      const el = this.findById(id)!.element;
      if (el.kind === 'connector' && el.from.glue !== 'none' && el.to.glue !== 'none' && el.waypoints.length === 0) {
        refuse('connector_positioned_by_endpoints', 'a connector glued at both ends is positioned by the shapes it joins', { target: id });
      }
      return { id, box: visualBounds(el), order };
    });
    const shifts = computeArrange(items, op);
    if (!shifts.ok) throw new Failure(shifts);
    for (const i of items) {
      const s = shifts.value.get(i.id)!;
      if (s.dx !== 0 || s.dy !== 0) this.translateSubtree(pageIdx, i.id, s.dx, s.dy);
    }
  }

  private applyReorder(targets: readonly string[], to: 'front' | 'back' | 'forward' | 'backward'): void {
    const { pageIdx, ids } = this.resolveSet(targets);
    for (const id of ids) this.assertSubtreeEditable(pageIdx, id, 'reorder');
    const byId = this.byIdMap(pageIdx);
    const block = new Set(ids.flatMap(i => leavesUnder(byId, i)));
    const entries = this.pages[pageIdx]!.elements.filter(e => e.kind !== 'group').map((e, order) => ({ id: e.id, z: e.zIndex, order, level: effectiveLevel(e) }));
    const changes = new Map<string, number>();
    const pageMin = Math.min(...entries.map(e => e.z)), pageMax = Math.max(...entries.map(e => e.z));
    const levels = new Set([...block].map(id => effectiveLevel(byId.get(id)!)));
    for (const level of levels) {
      const levelEntries = entries.filter(e => e.level === level);
      const levelBlock = new Set(levelEntries.filter(e => block.has(e.id)).map(e => e.id));
      if (!levelBlock.size) continue;
      const scoped = planZ(levelEntries, levelBlock, to);
      if (to === 'front' && scoped.size) {
        [...levelBlock].sort((a, b) => byId.get(a)!.zIndex - byId.get(b)!.zIndex).forEach((id, i) => changes.set(id, pageMax + 1 + i));
      } else if (to === 'back' && scoped.size) {
        [...levelBlock].sort((a, b) => byId.get(a)!.zIndex - byId.get(b)!.zIndex).forEach((id, i) => changes.set(id, pageMin - levelBlock.size + i));
      } else for (const [id, z] of scoped) changes.set(id, z);
    }
    for (const [id, z] of changes) this.put({ ...byId.get(id)!, zIndex: z });
    // a group stacks with its topmost member
    const after = this.byIdMap(pageIdx);
    const groups = new Set<string>();
    for (const id of changes.keys()) for (const a of ancestorsOf(this.parents, id)) groups.add(a);
    for (const gid of groups) {
      const g = after.get(gid) as GroupElement;
      const top = leavesUnder(after, gid).map(l => after.get(l)!).sort(compareElementOrder).at(-1)!;
      if (top.zIndex !== g.zIndex || g.level !== storedLevel(effectiveLevel(top)).level) this.put(withStoredLevel({ ...g, zIndex: top.zIndex }, effectiveLevel(top)));
    }
  }

  private applyAssignLayers(targets: readonly string[], layerIds: readonly string[], mode: 'set' | 'add' | 'remove'): void {
    const { pageIdx, ids } = this.resolveSet(targets);
    this.assertLayers(this.pages[pageIdx]!, layerIds);
    for (const id of ids) {
      const hit = this.findById(id)!;
      this.assertEditable(hit.page, hit.element, 'change its layers');
      const current = hit.element.layerIds;
      const next = mode === 'set' ? [...layerIds]
        : mode === 'add' ? [...current, ...layerIds.filter(l => !current.includes(l))]
          : current.filter(l => !layerIds.includes(l));
      if (next.length === current.length && next.every((l, i) => l === current[i])) continue;
      this.put({ ...hit.element, layerIds: next });
    }
  }

  private applyDuplicate(op: Extract<Operation, { op: 'duplicate' }>): void {
    const { pageIdx, ids } = this.resolveSet(op.targets);
    if (op.as !== undefined && ids.length !== 1) refuse('alias_needs_single_target', 'as= names one copy, so duplicate exactly one target', { count: ids.length });
    const page = this.pages[pageIdx]!;
    if (op.as) this.assertAlias(page, op.as, undefined);
    const dx = op.offset?.xPt ?? 0, dy = op.offset?.yPt ?? 0;
    this.assertFinite(dx, 'offset.xPt'); this.assertFinite(dy, 'offset.yPt');
    const byId = this.byIdMap(pageIdx);

    // The set to copy: each target plus everything beneath a group or inside a container, in the page's own order.
    const wanted = new Set<string>();
    for (const id of ids) for (const d of this.carried(byId, id).ids) wanted.add(d);
    const homes = containerParents(page.elements);
    const source = page.elements.filter(e => wanted.has(e.id));
    if (op.id !== undefined && ids.length !== 1) refuse('id_needs_single_target', 'id= names one copy, so duplicate exactly one target', { count: ids.length });
    const idMap = new Map(source.map(e => [e.id, this.newElementId(e.id === ids[0] ? op.id : undefined)] as const));
    const shiftPoint: PointMap = p => ({ x: p.x + dx, y: p.y + dy });
    const remapEnd = (ep: Endpoint, connectorId: string): Endpoint => {
      if (ep.join) { // joins the copied connector, or stays where it is put when that connector is not copied
        const to = idMap.get(ep.join.connectorId);
        const { join: _released, ...free } = ep;
        return to ? { ...ep, join: { ...ep.join, connectorId: to }, point: shiftPoint(ep.point!) } : { ...free, point: shiftPoint(ep.point!) };
      }
      if (ep.glue === 'none') return { ...ep, point: shiftPoint(ep.point!) };
      const copy = idMap.get(ep.elementId!);
      if (copy) return { ...ep, elementId: copy };
      if (!op.keepExternalLinks) refuse('connector_has_external_ends', `connector ${connectorId} is attached outside the copied set: include its elements or set keepExternalLinks`, { connectorId });
      return ep;
    };

    let z = this.nextZ(page);
    const ordered = source.slice().sort(compareElementOrder);
    const zOf = new Map(ordered.filter(e => e.kind !== 'group').map(e => [e.id, z++] as const));
    const copies: Element[] = [];
    const taken = new Set(page.elements.map(e => e.alias).filter((a): a is string => !!a));
    if (op.as) taken.add(op.as);
    for (const e of source) {
      const copy: Record<string, unknown> = { ...e, id: idMap.get(e.id)!, layerIds: [...e.layerIds], metadata: { ...e.metadata } };
      delete copy.alias;
      if (op.as && e.id === ids[0]) copy.alias = op.as;
      else if (op.keepAliases && e.alias) { copy.alias = uniqueAlias(e.alias, taken); taken.add(copy.alias as string); }
      if (e.kind === 'group') {
        copy.childIds = e.childIds.map(c => idMap.get(c)!);
        copy.zIndex = Math.max(...leavesUnder(byId, e.id).map(l => zOf.get(l)!));
        copy.bounds = translateBounds(e.bounds, dx, dy);
      } else {
        copy.zIndex = zOf.get(e.id)!;
        copy.bounds = translateBounds(e.bounds, dx, dy);
        if ((e.kind === 'shape' || e.kind === 'text') && e.attachment) { // rides the copied connector, or lands where it is put when the connector is not copied
          const to = idMap.get(e.attachment.connectorId);
          if (to) copy.attachment = { ...e.attachment, connectorId: to }; else delete copy.attachment;
        }
        if (isContainer(e)) copy.container = { ...e.container, memberIds: e.container.memberIds.map(m => idMap.get(m)!) };
        if (e.kind === 'connector') {
          copy.from = remapEnd(e.from, e.id);
          copy.to = remapEnd(e.to, e.id);
          copy.waypoints = e.waypoints.map(shiftPoint);
          if (e.routing) copy.routing = mapRouting(e.routing, shiftPoint);
        }
      }
      copies.push(copy as unknown as Element);
    }
    for (const c of copies) {
      this.addElement(pageIdx, c);
      if (c.kind === 'group') for (const child of c.childIds) this.parents.set(child, c.id);
    }
    // A copied member joins its original's container, next to the original, when that container is not copied itself. A copy is never
    // put into a group, so it joins only a container at the top level.
    for (const id of ids) {
      const home = homes.get(id);
      if (home === undefined || wanted.has(home) || this.parents.has(home)) continue;
      const c = this.findById(home)!.element as ContainerShape;
      const memberIds = c.container.memberIds.flatMap(m => (m === id ? [m, idMap.get(id)!] : [m]));
      this.put({ ...c, container: { ...c.container, memberIds } });
    }
  }

  private applyAddPage(op: Extract<Operation, { op: 'addPage' }>): void {
    const id = op.id ?? this.ctx.newId();
    if (this.pages.some(p => p.id === id)) stop('invalid_request', `page id ${id} already exists`, { id });
    const page: Page = {
      id, name: op.name, widthPt: op.widthPt ?? toPoints(297, 'mm'), heightPt: op.heightPt ?? toPoints(210, 'mm'),
      background: { kind: 'solid', colour: '#ffffff', opacity: 1 }, grid: { ...readDocumentDefaults(this.doc).defaults.grid }, guides: [],
      layers: [{ id: this.ctx.newId(), name: 'Layer 1', visible: true, locked: false, printable: true, snap: true, glue: true }],
      elements: [],
    };
    const pages = this.pages.slice();
    pages.splice(Math.min(op.index ?? pages.length, pages.length), 0, page);
    this.pages = pages;
  }

  private applyDuplicatePage(op: Extract<Operation, { op: 'duplicatePage' }>): void {
    const at = this.pageIndex(op.pageId);
    const src = this.pages[at]!;
    const id = op.id ?? this.ctx.newId();
    if (this.pages.some(p => p.id === id)) stop('invalid_request', `page id ${id} already exists`, { id });
    const layerMap = new Map(src.layers.map(l => [l.id, this.ctx.newId()] as const));
    const idMap = new Map(src.elements.map(e => [e.id, this.newElementId(undefined)] as const));
    const end = (ep: Endpoint): Endpoint => (ep.join ? { ...ep, join: { ...ep.join, connectorId: idMap.get(ep.join.connectorId) ?? ep.join.connectorId } } : ep.glue === 'none' ? ep : { ...ep, elementId: idMap.get(ep.elementId!)! });
    const elements = src.elements.map(e => {
      const copy: Record<string, unknown> = { ...e, id: idMap.get(e.id)!, layerIds: e.layerIds.map(l => layerMap.get(l)!) };
      if (e.kind === 'group') copy.childIds = e.childIds.map(c => idMap.get(c)!);
      if (e.kind === 'connector') { copy.from = end(e.from); copy.to = end(e.to); }
      if ((e.kind === 'shape' || e.kind === 'text') && e.attachment) copy.attachment = { ...e.attachment, connectorId: idMap.get(e.attachment.connectorId)! };
      if (isContainer(e)) copy.container = { ...e.container, memberIds: e.container.memberIds.map(m => idMap.get(m)!) };
      return copy as unknown as Element;
    });
    const page: Page = {
      ...src, id, name: op.name ?? `${src.name} copy`, guides: src.guides.map(g => ({ ...g, id: this.ctx.newId() })),
      layers: src.layers.map(l => ({ ...l, id: layerMap.get(l.id)! })), elements,
    };
    for (const e of elements) if (e.kind === 'group') for (const c of e.childIds) this.parents.set(c, e.id);
    const pages = this.pages.slice();
    pages.splice(at + 1, 0, page);
    this.pages = pages;
  }

  private applySet(target: string, patch: PatchObj): void {
    const { page, pageIdx, index, element } = this.resolve(target, this.ctx.pageId);
    const keys = Object.keys(patch);
    if (!(keys.length === 1 && keys[0] === 'locked')) this.assertEditable(page, element, 'edit');
    const next: Record<string, unknown> = { ...element };
    let routingMode: string | undefined;
    const need = (cond: boolean, key: string) => { if (!cond) stop('invalid_request', `patch.${key} does not apply to a ${element.kind}`, { target: element.id, key }); };

    for (const [key, value] of Object.entries(patch)) {
      switch (key) {
        case 'name':
          if (value === null) delete next.name; else next.name = value;
          break;
        case 'alias':
          if (value === null) delete next.alias;
          else { this.assertAlias(page, value as string, element.id); next.alias = value; }
          break;
        case 'locked': next.locked = value; break;
        case 'hidden': next.hidden = value; break;
        case 'layerIds': this.assertLayers(page, value as string[]); next.layerIds = [...(value as string[])]; break;
        case 'level': {
          const level = value as number;
          if (!Number.isInteger(level) || level < -127 || level > 127) stop('invalid_request', 'level must be an integer from -127 through 127', { target: element.id, level });
          if (element.kind !== 'group') {
            if (level === 0) delete next.level;
            else next.level = level;
            if (level !== effectiveLevel(element)) next.zIndex = this.nextZ(page);
          }
          break;
        }
        case 'metadata': next.metadata = { ...element.metadata, ...(value as Record<string, string>) }; break;
        case 'style': {
          need(element.kind === 'shape' || element.kind === 'connector', key);
          const forbidden = element.kind === 'shape' ? LINE_ONLY_STYLE : SHAPE_ONLY_STYLE;
          for (const k of Object.keys(value as object)) if (forbidden.includes(k)) stop('invalid_request', `style.${k} does not apply to a ${element.kind}`, { target: element.id });
          next.style = merge((element as ShapeElement | ConnectorElement).style as object, value as PatchObj);
          if (element.kind === 'shape') { const s = next.style as ShapeElement['style']; const bad = paintProblem(s.fill, 'fill') ?? paintProblem(s.stroke, 'stroke'); if (bad) stop('invalid_request', bad, { target: element.id }); }
          break;
        }
        case 'text': {
          need(element.kind === 'shape' || element.kind === 'text' || element.kind === 'connector', key);
          if (element.kind === 'connector') { next.label = mergeText(element.label ?? textDefaults(this.doc), value as PatchObj); break; } // a connector's text is its label
          const base = (element as ShapeElement | TextElement).text ?? textDefaults(this.doc);
          next.text = mergeText(base, value as PatchObj);
          break;
        }
        case 'geometry': {
          need(element.kind === 'shape', key); next.geometry = merge((element as ShapeElement).geometry, value as PatchObj);
          const path = (next.geometry as ShapeElement['geometry']).svgPath;
          if (path !== undefined) { const parsed = parsePath(path); if (!parsed.ok) stop('invalid_request', parsed.error.message); }
          break;
        }
        case 'ports': need(element.kind === 'shape', key); next.ports = (value as ShapeElement['ports'])!.map(p => ({ ...p })); break;
        case 'assetId': need(element.kind === 'image', key); this.assertAsset(value as string); next.assetId = value; break;
        case 'fit': case 'opacity': case 'preserveAspectRatio': need(element.kind === 'image', key); next[key] = value; break;
        case 'attachment': {
          need(element.kind === 'shape' || element.kind === 'text', key);
          if (value === null) delete next.attachment; else next.attachment = this.resolveAttachment(value as { connector: string }, page.id, element.id);
          break;
        }
        case 'labelAnchor': {
          need(element.kind === 'connector', key);
          if (value === null) delete next.labelAnchor; else next.labelAnchor = this.anchorOf({ ...((element as ConnectorElement).labelAnchor ?? {}), ...(value as object) });
          break;
        }
        case 'route': need(element.kind === 'connector', key); next.route = value; if (value !== 'orthogonal') delete next.routing; break;
        case 'hops': need(element.kind === 'connector', key); if (value === 'none') delete next.hops; else next.hops = value; break;
        case 'waypoints':
          need(element.kind === 'connector', key);
          if (element.kind === 'connector' && element.routing?.mode === 'frozen' && !('routing' in patch)) refuse('route_frozen', 'the route of this connector is frozen: set routing.mode to automatic or manual before editing its waypoints', { target: element.id });
          next.waypoints = (value as Point[]).map(p => ({ ...p }));
          delete next.routing; // waypoints make the route manual (or, when empty, automatic); a stored route no longer applies
          break;
        case 'routing': need(element.kind === 'connector', key); routingMode = (value as { mode: string }).mode; break;
        case 'container': {
          need(element.kind === 'shape', key);
          if (value === null) { // disband: the shape stays, its members move up a level
            if (isContainer(element)) { this.releaseMembers(element, true); delete next.container; }
            break;
          }
          next.container = withContainerSettings(isContainer(element) ? element.container : { memberIds: [] }, value as { fit?: ContainerData['fit']; marginPt?: number });
          break;
        }
        case 'routingPolicy':
          need(element.kind === 'shape' || element.kind === 'text' || element.kind === 'connector', key);
          if (value === null) delete next.routingPolicy; else next.routingPolicy = { ...(('routingPolicy' in element && element.routingPolicy) || {}), ...(value as PatchObj) };
          break;
        case 'from': case 'to': {
          need(element.kind === 'connector', key);
          const ep = value as Endpoint;
          next[key] = this.resolveEndpoint(ep as EndpointInput, page.id, element.id);
          break;
        }
        default: stop('invalid_request', `unknown patch field ${key}`);
      }
    }
    if (element.kind === 'connector' && ('from' in patch || 'to' in patch || 'waypoints' in patch)) {
      const c = next as unknown as ConnectorElement;
      next.bounds = this.connectorBounds(c.from, c.to, c.waypoints);
    }
    if (element.kind === 'group' && 'level' in patch) this.moveGroupToLevel(pageIdx, element, patch.level as number);
    this.store(pageIdx, index, next as unknown as Element);
    if (routingMode) this.applyRouting(pageIdx, element.id, routingMode);
  }

  /** Moves every descendant leaf by the same amount, validating the whole subtree before writing any member. */
  private moveGroupToLevel(pageIdx: number, group: GroupElement, target: number): void {
    this.assertSubtreeEditable(pageIdx, group.id, 'change its level');
    const delta = target - effectiveLevel(group);
    if (delta === 0) return;
    const byId = this.byIdMap(pageIdx);
    const leaves = leavesUnder(byId, group.id).map(id => byId.get(id)!);
    const moved = leaves.map(leaf => ({ leaf, level: effectiveLevel(leaf) + delta }));
    const invalid = moved.find(x => x.level < -127 || x.level > 127);
    if (invalid) refuse('level_out_of_range', `moving group ${group.id} would put member ${invalid.leaf.id} outside level -127 through 127`, { groupId: group.id, memberId: invalid.leaf.id, level: invalid.level });
    for (const { leaf, level } of moved) this.put(withStoredLevel(leaf, level));
  }

  // ---------------------------------------------------------------- route modes (R20)
  /** The route the router draws for a connector in the document as it stands in this plan, anchors included. */
  private drawnRoute(pageIdx: number, id: string): Point[] {
    const page = this.pages[pageIdx]!;
    const route = planRoutes({ elements: page.elements, layers: page.layers, pageArea: page.widthPt * page.heightPt }).routes.get(id);
    if (!route) stop('invalid_request', 'this connector has no route to keep', { target: id });
    return route.points.map(p => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
  }

  /**
   * automatic: forget waypoints and the stored route; the router plans again. manual: keep the route as drawn now as waypoints.
   * frozen: keep the route as drawn now and never replace it. Only `frozen` is stored as a mode; the others follow from the waypoints.
   */
  private applyRouting(pageIdx: number, id: string, mode: string): void {
    const index = this.pages[pageIdx]!.elements.findIndex(e => e.id === id);
    const el = this.pages[pageIdx]!.elements[index];
    if (!el || el.kind !== 'connector') stop('invalid_request', 'routing applies to connectors', { target: id });
    this.assertEditable(this.pages[pageIdx]!, el, 'edit');
    if (el.route !== 'orthogonal') stop('invalid_request', 'route modes apply to orthogonal connectors', { target: id });
    if (mode === 'guided') refuse('routing_mode_unavailable', 'a route becomes guided when you pin a run: drag a run, or use pinSegment', { target: id, mode });
    const frozen = el.routing?.mode === 'frozen', manual = !frozen && el.waypoints.length > 0;
    const next: ConnectorElement = { ...el };
    if (mode === 'automatic') {
      next.waypoints = [];
      delete next.routing;
      this.fresh.add(id);
    } else if (mode === 'manual') {
      if (manual) return;
      const pts = this.drawnRoute(pageIdx, id);
      const inner = pts.slice(1, -1);
      next.waypoints = inner.length ? inner : [{ x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 }]; // a straight run still needs one point to be manual
      delete next.routing;
    } else {
      if (frozen) return;
      next.routing = { mode: 'frozen', advisory: this.drawnRoute(pageIdx, id) };
      next.waypoints = [];
    }
    next.bounds = this.connectorBounds(next.from, next.to, next.waypoints);
    this.store(pageIdx, index, next);
  }

  /**
   * Slides one inner run of the drawn route sideways. An automatic (or guided) connector pins that run: only it is held, and the
   * router still plans the rest. A manual connector keeps its waypoints, and a frozen one stays frozen with the moved route. The runs
   * that leave a port are refused.
   */
  private applyMoveSegment(op: Extract<Operation, { op: 'moveSegment' }>): void {
    const hit = this.resolve(op.target, this.ctx.pageId);
    const el = hit.element;
    if (el.kind !== 'connector' || el.route !== 'orthogonal') stop('invalid_request', 'moveSegment applies to orthogonal connectors', { target: el.id });
    this.assertEditable(hit.page, el, 'edit');
    if ((op.to === undefined) === (op.by === undefined)) stop('invalid_request', 'give exactly one of to and by', { target: el.id });
    const drawn = this.drawnRoute(hit.pageIdx, el.id);
    const seg = segmentsOf(drawn).find(s => s.index === op.segment);
    const target = op.to ?? (seg ? seg.coord + op.by! : 0);
    const moved = moveSegment(drawn, op.segment, target);
    if (!moved.ok) {
      if (moved.code === 'no_movement') return;
      refuse(moved.code, moved.message, { target: el.id, segment: op.segment });
    }
    const points = moved.points.map(p => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
    const next: ConnectorElement = { ...el };
    if (el.routing?.mode === 'frozen') next.routing = { mode: 'frozen', advisory: points };
    else if (el.waypoints.length) {
      const inner = points.slice(1, -1);
      next.waypoints = inner.length ? inner : [{ x: (points[0]!.x + points[1]!.x) / 2, y: (points[0]!.y + points[1]!.y) / 2 }];
      delete next.routing;
    } else {
      const addr = addressOf(drawn, op.segment)!;
      const held = (el.routing?.constraints ?? []).filter(c => !(c.axis === addr.axis && c.index === addr.index)).map(c => ({ axis: c.axis, at: c.at }));
      held.push({ axis: addr.axis, at: Math.round(target * 1000) / 1000 });
      next.routing = { constraints: readdress(points, held), advisory: points };
    }
    next.bounds = this.connectorBounds(next.from, next.to, next.waypoints);
    this.store(hit.pageIdx, hit.index, next);
  }

  /** Holds one inner run of an automatic route where it is now, or lets the router choose it again. */
  private applyPinSegment(op: Extract<Operation, { op: 'pinSegment' }>): void {
    const hit = this.resolve(op.target, this.ctx.pageId);
    const el = hit.element;
    if (el.kind !== 'connector' || el.route !== 'orthogonal') stop('invalid_request', 'pinSegment applies to orthogonal connectors', { target: el.id });
    this.assertEditable(hit.page, el, 'edit');
    if (el.waypoints.length || el.routing?.mode === 'frozen') refuse('route_not_automatic', 'only an automatic route has runs to pin: a manual or frozen route is already held as drawn', { target: el.id });
    const drawn = this.drawnRoute(hit.pageIdx, el.id);
    const addr = addressOf(drawn, op.segment);
    if (!addr) {
      const why = segmentsOf(drawn).find(s => s.index === op.segment);
      refuse(why ? 'segment_fixed' : 'segment_missing', why?.fixedReason ?? `the route has no run ${op.segment}`, { target: el.id, segment: op.segment });
    }
    const current = el.routing?.constraints ?? [];
    const others: RunConstraint[] = current.filter(c => !(c.axis === addr.axis && c.index === addr.index));
    const was = others.length !== current.length;
    if (op.pinned === was) return;
    const constraints = op.pinned ? [...others, { axis: addr.axis, index: addr.index, at: Math.round(addr.coord * 1000) / 1000 }] : others;
    const routing: NonNullable<ConnectorElement['routing']> = { advisory: drawn.map(p => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 })) };
    if (constraints.length) routing.constraints = constraints;
    this.store(hit.pageIdx, hit.index, { ...el, routing });
  }

  /** Forgets the stored route of automatic orthogonal connectors so the router plans them from scratch. Explicit, undoable, reports what changed. */
  private applyReroute(targets: readonly string[] | undefined): void {
    const pageIdx = this.defaultPage(this.ctx.pageId);
    const explicit = !!targets;
    const hits = explicit ? targets!.map(t => this.resolve(t, this.ctx.pageId)) : this.pages[pageIdx]!.elements.map((element, index) => ({ page: this.pages[pageIdx]!, pageIdx, index, element }));
    for (const { pageIdx: pi, index, element } of hits) {
      if (element.kind !== 'connector' || element.route !== 'orthogonal') {
        if (explicit) stop('invalid_request', 'only orthogonal connectors can be rerouted', { target: element.id });
        continue;
      }
      if (element.routing?.mode === 'frozen' || element.waypoints.length > 0) {
        if (explicit) refuse('route_not_automatic', 'the route of this connector is frozen or manual: set routing.mode to automatic first', { target: element.id });
        continue;
      }
      this.assertEditable(this.pages[pi]!, element, 'edit');
      const next: ConnectorElement = { ...element };
      delete next.routing;
      if (element.routing?.constraints?.length) next.routing = { constraints: element.routing.constraints }; // pinned runs survive a re-route
      this.fresh.add(element.id);
      this.store(pi, index, next);
    }
  }

  // ---------------------------------------------------------------- validation and diffing
  private finalValidate(): void {
    if (this.pages.length === 0) refuse('last_page', 'a document keeps at least one page');
    for (const page of this.pages) {
      const ids = new Set(page.elements.map(e => e.id));
      const claimed = new Map<string, string>();
      for (const el of page.elements) {
        if (el.kind === 'connector') {
          const missing = [el.from, el.to].filter(ep => ep.glue !== 'none' && !ids.has(ep.elementId!));
          if (missing.length) stop('dependency_conflict', `connector ${el.id} would lose an endpoint`, { connectorIds: [el.id], elementIds: missing.map(m => m.elementId) });
        }
        if (el.kind === 'group') {
          if (el.childIds.length === 0) refuse('empty_group', `group ${el.id} would be left with no members: ungroup or delete it explicitly`, { groupId: el.id });
          const missing = el.childIds.filter(c => !ids.has(c));
          if (missing.length) stop('dependency_conflict', `group ${el.id} would lose a child`, { groupIds: [el.id], elementIds: missing });
          for (const c of el.childIds) {
            if (claimed.has(c)) refuse('already_grouped', `${c} is a member of two groups`, { target: c });
            claimed.set(c, el.id);
          }
        }
        if (el.kind === 'image' && !this.assets.some(a => a.id === el.assetId)) stop('invalid_request', `image ${el.id} references unknown asset ${el.assetId}`);
      }
      for (const id of claimed.keys()) {
        const seen = new Set<string>();
        for (let p = claimed.get(id); p !== undefined; p = claimed.get(p)) {
          if (seen.has(p) || p === id) refuse('group_cycle', 'groups cannot contain themselves', { target: id });
          seen.add(p);
        }
      }
      this.validateContainers(page, ids);
    }
  }

  /** R17: members on the container's page, one container each, no cycles, and a container shares its group parent with its members. */
  private validateContainers(page: Page, ids: ReadonlySet<string>): void {
    const contained = new Map<string, string>();
    for (const el of page.elements) {
      if (!isContainer(el)) continue;
      for (const m of el.container.memberIds) {
        if (m === el.id) refuse('container_cycle', `container ${el.id} cannot contain itself`, { target: el.id });
        if (!ids.has(m)) {
          if (this.findById(m)) refuse('container_member_other_page', `container ${el.id} lists ${m}, which is on another page`, { container: el.id, member: m });
          stop('dependency_conflict', `container ${el.id} would lose a member`, { containerIds: [el.id], elementIds: [m] });
        }
        const other = contained.get(m);
        if (other !== undefined) refuse('already_contained', `${m} is a member of two containers`, { target: m, containers: [other, el.id] });
        contained.set(m, el.id);
        if (this.parents.get(m) !== this.parents.get(el.id)) {
          refuse('container_split', `container ${el.id} and its member ${m} must be in the same group, or both in none: group or ungroup them together`, { container: el.id, member: m });
        }
      }
    }
    for (const id of contained.keys()) {
      const seen = new Set<string>();
      for (let p = contained.get(id); p !== undefined; p = contained.get(p)) {
        if (seen.has(p) || p === id) refuse('container_cycle', 'containers cannot contain themselves, directly or through another container', { target: id });
        seen.add(p);
      }
    }
  }

  /**
   * R17: containers that grow or fit settle after the batch around what it changed, innermost first, so a container that grows can make its
   * own container grow. Explicit resizes come first: a growing container pushed smaller than its members is pushed back out.
   */
  private settleContainerFits(): void {
    this.touched = new Set();
    for (const page of this.pages) {
      if (!page.elements.some(e => isContainer(e) && e.container.fit !== undefined)) continue;
      const parents = containerParents(page.elements);
      const dirty = new Set<string>();
      const mark = (id: string) => { dirty.add(id); for (const a of containerAncestors(parents, id)) dirty.add(a); };
      for (const id of this.allTouched) { mark(id); for (const g of ancestorsOf(this.parents, id)) mark(g); }
      const depth = (id: string) => containerAncestors(parents, id).length;
      const order = [...dirty].filter(id => {
        const el = page.elements.find(e => e.id === id);
        return isContainer(el) && el.container.fit !== undefined && el.container.memberIds.length > 0;
      }).sort((a, b) => depth(b) - depth(a));
      for (const id of order) {
        const hit = this.findById(id)!;
        const c = hit.element as ContainerShape;
        const margin = c.container.marginPt ?? 0;
        const inner = unionBounds(c.container.memberIds.map(m => visualBounds(this.findById(m)!.element)));
        // members that are only lines can span no width or height, but a shape needs a positive size: the hug keeps MIN_FIT_PT about its centre
        const w = Math.max(inner.width + 2 * margin, MIN_FIT_PT), h = Math.max(inner.height + 2 * margin, MIN_FIT_PT);
        const hug: Bounds = { x: inner.x + inner.width / 2 - w / 2, y: inner.y + inner.height / 2 - h / 2, width: w, height: h };
        const bounds = c.container.fit === 'fit' ? hug : unionBounds([c.bounds, hug]);
        if (!sameBounds(bounds, c.bounds)) this.store(hit.pageIdx, hit.index, { ...c, bounds });
      }
    }
    this.refreshGroups();
  }

  private buildPlan(operations: Operation[]): Plan {
    const forward = emptyDiffBody();
    const inverse = emptyDiffBody();
    const created: string[] = [], changed: string[] = [], deleted: string[] = [];
    const finalById = new Map<string, { pageId: string; index: number; element: Element }>();
    for (const p of this.pages) p.elements.forEach((element, index) => finalById.set(element.id, { pageId: p.id, index, element }));

    for (const [id, f] of finalById) {
      const o = this.origElements.get(id);
      if (!o) { created.push(id); continue; }
      if (o.element !== f.element && canonicalSerialize(o.element) !== canonicalSerialize(f.element)) changed.push(id);
    }
    for (const id of this.origElements.keys()) if (!finalById.has(id)) deleted.push(id);

    // ---- pages: created, deleted, reordered, edited
    const origPageIds = this.doc.pages.map(p => p.id);
    const finalPageIds = this.pages.map(p => p.id);
    const createdPages = finalPageIds.filter(p => !origPageIds.includes(p));
    const deletedPages = origPageIds.filter(p => !finalPageIds.includes(p));
    const survivingOrder = (ids: string[], other: string[]) => ids.filter(i => other.includes(i)).join('|');
    const reordered = survivingOrder(origPageIds, finalPageIds) !== survivingOrder(finalPageIds, origPageIds);
    const structural = createdPages.length > 0 || deletedPages.length > 0 || reordered;
    const meta = (p: Page) => ({ id: p.id, name: p.name, widthPt: p.widthPt, heightPt: p.heightPt, background: p.background, grid: p.grid, guides: p.guides });
    const changedPageIds: string[] = [];
    if (structural) {
      // Every page is restated at its index, in ascending order, so replay (forward, undo, redo) reproduces the order exactly.
      this.pages.forEach((page, index) => forward.upserts.pages.push({ index, page: meta(page) }));
      this.doc.pages.forEach((page, index) => inverse.upserts.pages.push({ index, page: meta(page) }));
      for (const id of deletedPages) forward.deletes.pageIds.push(id);
      for (const id of createdPages) inverse.deletes.pageIds.push(id);
      for (const id of [...createdPages, ...deletedPages]) changedPageIds.push(id);
      for (const page of this.pages) {
        if (createdPages.includes(page.id)) page.layers.forEach((layer, index) => forward.upserts.layers.push({ pageId: page.id, layer, index }));
      }
      for (const page of this.doc.pages) {
        if (deletedPages.includes(page.id)) page.layers.forEach((layer, index) => inverse.upserts.layers.push({ pageId: page.id, layer, index }));
      }
    }
    for (const page of this.pages) {
      const orig = this.doc.pages.find(p => p.id === page.id);
      if (!orig) continue;
      const edited = canonicalSerialize(meta(orig)) !== canonicalSerialize(meta(page));
      if (edited) {
        if (!structural) { forward.upserts.pages.push({ page: meta(page) }); inverse.upserts.pages.push({ page: meta(orig) }); }
        changedPageIds.push(page.id);
      } else if (reordered && !changedPageIds.includes(page.id)) {
        changedPageIds.push(page.id);
      }
    }

    // ---- layers of pages that survive
    const changedLayerIds: string[] = [];
    for (const page of this.pages) {
      const orig = this.doc.pages.find(p => p.id === page.id);
      if (!orig) continue;
      const before = new Map(orig.layers.map((l, index) => [l.id, { l, index }] as const));
      const after = new Map(page.layers.map((l, index) => [l.id, { l, index }] as const));
      page.layers.forEach((layer, index) => {
        const o = before.get(layer.id);
        if (!o) { forward.upserts.layers.push({ pageId: page.id, layer, index }); inverse.deletes.layerIds.push(layer.id); changedLayerIds.push(layer.id); }
        else if (o.l !== layer && canonicalSerialize(o.l) !== canonicalSerialize(layer)) {
          forward.upserts.layers.push({ pageId: page.id, layer }); inverse.upserts.layers.push({ pageId: page.id, layer: o.l }); changedLayerIds.push(layer.id);
        }
      });
      orig.layers.forEach((layer, index) => {
        if (after.has(layer.id)) return;
        forward.deletes.layerIds.push(layer.id); inverse.upserts.layers.push({ pageId: page.id, layer, index }); changedLayerIds.push(layer.id);
      });
    }

    // ---- elements
    const createdSorted = created.map(id => finalById.get(id)!).sort((a, b) => a.index - b.index);
    for (const c of createdSorted) forward.upserts.elements.push({ pageId: c.pageId, index: c.index, element: c.element });
    for (const id of changed) {
      const f = finalById.get(id)!;
      forward.upserts.elements.push({ pageId: f.pageId, element: f.element });
      inverse.upserts.elements.push({ pageId: f.pageId, element: this.origElements.get(id)!.element });
    }
    const deletedSorted = deleted.map(id => this.origElements.get(id)!).sort((a, b) => a.index - b.index);
    for (const d of deletedSorted) {
      forward.deletes.elementIds.push(d.element.id);
      inverse.upserts.elements.push({ pageId: d.pageId, index: d.index, element: d.element });
    }
    inverse.deletes.elementIds.push(...createdSorted.map(c => c.element.id));

    // ---- assets. Undoing a removal re-appends, so later assets are removed and restored in order to keep the catalogue order exact.
    const finalAssets = new Map(this.assets.map(a => [a.id, a] as const));
    const changedAssetIds: string[] = [];
    for (const a of this.assets) {
      const o = this.origAssets.get(a.id);
      if (!o) { forward.upserts.assets.push(a); inverse.deletes.assetIds.push(a.id); changedAssetIds.push(a.id); }
      else if (o.asset !== a && canonicalSerialize(o.asset) !== canonicalSerialize(a)) { forward.upserts.assets.push(a); inverse.upserts.assets.push(o.asset); changedAssetIds.push(a.id); }
    }
    const removed = [...this.origAssets.values()].filter(o => !finalAssets.has(o.asset.id));
    if (removed.length) {
      const first = Math.min(...removed.map(o => o.index));
      for (const o of removed) { forward.deletes.assetIds.push(o.asset.id); changedAssetIds.push(o.asset.id); }
      const tail = [...this.origAssets.values()].filter(o => o.index >= first).sort((a, b) => a.index - b.index);
      for (const o of tail) {
        if (finalAssets.has(o.asset.id) && !inverse.deletes.assetIds.includes(o.asset.id)) inverse.deletes.assetIds.push(o.asset.id);
        const already = inverse.upserts.assets.findIndex(x => x.id === o.asset.id);
        if (already >= 0) inverse.upserts.assets.splice(already, 1);
        inverse.upserts.assets.push(o.asset);
      }
    }

    // Connectors whose route changes because an attached element moved are affected visually, but are not rewritten.
    const visually = new Set<string>([...created, ...changed]);
    const touched = new Set<string>([...changed, ...deleted]);
    for (const p of this.pages) for (const el of p.elements) {
      if (el.kind === 'connector' && (touched.has(el.from.elementId ?? '') || touched.has(el.to.elementId ?? ''))) visually.add(el.id);
    }
    for (const id of deleted) visually.delete(id);

    const noChange = isNothing(forward);
    const description = operations.map(o => o.op).join(', ').slice(0, 1000);
    return {
      forward, inverse, created, changed, deleted, changedPageIds, changedLayerIds, changedAssetIds,
      visuallyAffectedIds: [...visually], description, noChange, freshRoutes: [...this.fresh],
    };
  }
}

function uniqueAlias(alias: string, taken: ReadonlySet<string>): string {
  if (!taken.has(alias)) return alias;
  let n = 2;
  while (taken.has(`${alias}-${n}`)) n++;
  return `${alias}-${n}`;
}

function isNothing(d: DiffBody): boolean {
  return !d.upserts.elements.length && !d.upserts.assets.length && !d.upserts.pages.length && !d.upserts.layers.length &&
    !d.deletes.elementIds.length && !d.deletes.assetIds.length && !d.deletes.pageIds.length && !d.deletes.layerIds.length;
}
