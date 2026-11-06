import { WrappedSvgText } from './WrappedSvgText';
import {
  Cell, EdgeHandler, Geometry, Graph, InternalEvent, Point, RubberBandHandler, VertexHandler, VertexHandlerConfig, getDefaultPlugins,
  type EventSource, type InternalMouseEvent, type SelectionCellsHandler, type SelectionHandler,
} from '@maxgraph/core';
import type { Element, Snapshot } from '../contracts/generated';
import { canonicalSerialize } from '../model/canonical';
import { ok, type Result } from '../model/result';
import type { AdapterCallbacks, CanvasAdapter, Tool, ViewportInfo } from './CanvasAdapter';
import { findJoinTarget, type DrawnRoute } from './joinTarget';
import { compareElementOrder } from '../model/elementOrder';
import { edgeStyle, effectiveState, labelOf, registerCustomShapes, vertexStyle } from './cellMapping';
import { planRoutes, type PlannedRoute, type RouteChange } from '../layout/routePlanner';
import { installGestureHooks } from './gestureHooks';
import { pageOf } from './intents';
import { carriedConnectors, carriedLeaves } from './selection';

const MARGIN_PT = 40;
const PX_PER_PT = 96 / 72; // 100% zoom
export const DEFAULT_SCALE = PX_PER_PT;

type Rect = { x: number; y: number; width: number; height: number };

/**
 * The only module that knows maxGraph. It translates UUIDs to cells internally and never hands a cell to the rest of the app.
 * maxGraph's own edit paths (move, resize, rotate, bend, reconnect, label) are replaced by ones that emit an intent instead of
 * changing its model: the canvas model changes only when the engine commits and the new snapshot is projected.
 */
export class MaxGraphAdapter implements CanvasAdapter {
  readonly graph: Graph;
  private readonly world: HTMLDivElement;
  private readonly sheet: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly frames: HTMLDivElement;
  private projecting = false;
  private tool: Tool = { kind: 'select' };
  private readonly shown = new Map<string, string>(); // element id -> serialized projection key, to skip unchanged cells
  private pageWidth = 841.89;
  private pageHeight = 595.28;
  private space = false;
  /** Ctrl (or Cmd) was held when the pointer last went down: select one member of a group instead of the whole group. */
  private toggleHeld = false;
  private disposed = false;
  private connectSource: Cell | null = null;
  private readonly cleanups: Array<() => void> = [];

  constructor(private readonly container: HTMLElement, private readonly cb: AdapterCallbacks, private readonly assetUrl: (assetId: string) => string) {
    registerCustomShapes();
    VertexHandlerConfig.rotationEnabled = true;
    container.style.position = 'relative';
    container.style.overflow = 'auto';
    container.addEventListener('contextmenu', e => e.preventDefault());

    this.world = document.createElement('div');
    this.world.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    this.sheet = document.createElement('div');
    this.sheet.dataset.testid = 'page-sheet';
    this.sheet.style.cssText = 'position:absolute;box-shadow:0 1px 6px rgba(15,23,42,.35);';
    this.world.appendChild(this.sheet);
    container.appendChild(this.world);

    this.graph = new Graph(container, undefined, [...getDefaultPlugins(), RubberBandHandler]);
    // maxGraph's svg is an in-flow element, which paints below the positioned page sheet. Lift it above the sheet.
    const svg = container.querySelector(':scope > svg') as SVGElement | null;
    if (svg) Object.assign(svg.style, { position: 'absolute', zIndex: '1', overflow: 'visible' });
    this.overlay = document.createElement('div');
    this.overlay.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:5;';
    container.appendChild(this.overlay);
    this.frames = document.createElement('div');
    this.frames.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:4;';
    container.appendChild(this.frames);

    const g = this.graph;
    g.cellRenderer.defaultTextShape = WrappedSvgText;
    g.setPanning(true);
    g.setCellsCloneable(false);
    g.setConnectable(false);
    g.setAllowDanglingEdges(true);
    g.setDisconnectOnMove(false);
    g.setHtmlLabels(false);
    g.setGridEnabled(false);
    g.setEnterStopsCellEditing(false);
    g.view.setTranslate(MARGIN_PT, MARGIN_PT);
    g.view.scale = DEFAULT_SCALE;
    const panning = g.getPlugin('PanningHandler') as { isForcePanningEvent: (me: InternalMouseEvent) => boolean; useLeftButtonForPanning: boolean } | undefined;
    if (panning) panning.isForcePanningEvent = me => this.space || (me.getEvent() as MouseEvent).button === 1;

    for (const type of ['pointerdown', 'mousedown'] as const) container.addEventListener(type, e => { this.toggleHeld = e.ctrlKey || e.metaKey; }, true);

    const selectionHandler = g.getPlugin<SelectionHandler>('SelectionHandler');
    if (selectionHandler) {
      selectionHandler.guidesEnabled = true;
      const createGuide = selectionHandler.createGuide.bind(selectionHandler);
      selectionHandler.createGuide = () => {
        const guide = createGuide(); const paint = guide.move.bind(guide);
        guide.move = (bounds, delta, gridEnabled, clone) => {
          const raw = delta.clone(); paint(bounds, delta, gridEnabled, clone); return raw;
        };
        return guide;
      };
      // R17: a container's members travel with it during the drag, so the live preview shows what the drop will commit
      const getCells = selectionHandler.getCells.bind(selectionHandler);
      selectionHandler.getCells = (initial: Cell) => {
        const cells = getCells(initial);
        if (!this.projected) return cells;
        const ids = new Set(cells.map(c => c.getId() ?? ''));
        const model = this.graph.getDataModel();
        const carried = [...carriedLeaves(this.projected, [...ids]), ...carriedConnectors(this.projected, [...ids])];
        const extra = carried.filter(id => !ids.has(id)).map(id => model.getCell(id)).filter((c): c is Cell => !!c && this.graph.isCellMovable(c));
        return [...cells, ...extra];
      };
    }
    this.installEditRedirects();
    const uninstallGestures = installGestureHooks(g, n => { if (!this.projecting) cb.onGesture(n); });
    this.cleanups.push(uninstallGestures);

    g.getSelectionModel().addListener(InternalEvent.CHANGE, () => { if (!this.projecting) cb.onSelection(this.getSelection(), { subSelect: this.toggleHeld }); });
    g.addMouseListener({
      mouseDown: (_s: EventSource, me: InternalMouseEvent) => this.mouseDown(me),
      mouseMove: (_s: EventSource, me: InternalMouseEvent) => this.mouseMove(me),
      mouseUp: (_s: EventSource, me: InternalMouseEvent) => this.mouseUp(me),
    });

    const onScroll = () => cb.onViewport(this.getViewport());
    container.addEventListener('scroll', onScroll);
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.graph.view.scale * Math.pow(1.0015, -e.deltaY), { x: e.clientX, y: e.clientY });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) this.space = true;
      if (e.key === 'Escape') { this.graph.escape(e); this.connectSource = null; this.drawConnectLine(null); }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.code === 'Space') this.space = false; };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    this.cleanups.push(
      () => container.removeEventListener('scroll', onScroll), () => container.removeEventListener('wheel', onWheel),
      () => document.removeEventListener('keydown', onKeyDown), () => document.removeEventListener('keyup', onKeyUp),
    );
    this.layoutWorld();
  }

  // ------------------------------------------------------------------ edits become intents
  private installEditRedirects(): void {
    const g = this.graph as unknown as Record<string, unknown>;
    const idOf = (c: Cell) => c.getId() ?? '';
    const emit = this.cb.onIntent.bind(this.cb);
    const live = () => !this.projecting && !this.disposed;

    g.moveCells = (cells: Cell[], dx: number, dy: number) => {
      if (live() && (dx !== 0 || dy !== 0)) emit({ type: 'move', ids: cells.map(idOf), dx, dy });
      return cells;
    };
    g.resizeCell = (cell: Cell, bounds: Rect) => {
      if (live()) emit({ type: 'resize', id: idOf(cell), bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } });
      return cell;
    };
    g.labelChanged = (cell: Cell, value: unknown) => {
      if (live()) emit({ type: 'text', id: idOf(cell), value: typeof value === 'string' ? value : String((value as { textContent?: string })?.textContent ?? value ?? '') });
      return cell;
    };

    // Handler-level apply points (prototype patches are global, so route through the live adapter).
    const adapter = this;
    (VertexHandler.prototype as unknown as Record<string, unknown>).rotateCell = function (this: { state: { cell: Cell } }, cell: Cell, angle: number, parent?: Cell) {
      if (!parent && angle !== 0 && adapter.activeFor(this)) emit({ type: 'rotate', id: idOf(cell), deltaDeg: angle });
    };
    const edgeProto = EdgeHandler.prototype as unknown as Record<string, unknown>;
    edgeProto.changePoints = function (this: object, edge: Cell, points: Point[]) {
      if (adapter.activeFor(this)) emit({ type: 'bend', id: idOf(edge), waypoints: points.map(p => ({ x: p.x, y: p.y })) });
      return edge;
    };
    edgeProto.connect = function (this: { isSource: boolean }, edge: Cell, terminal: Cell | null, isSource: boolean) {
      if (adapter.activeFor(this) && terminal) emit({ type: 'reconnect', id: idOf(edge), end: isSource ? 'from' : 'to', elementId: idOf(terminal) });
      return edge;
    };
    edgeProto.changeTerminalPoint = function (this: object, edge: Cell, point: Point, isSource: boolean) {
      if (adapter.activeFor(this)) {
        const join = adapter.joinTargetAt(idOf(edge), { x: point.x, y: point.y });
        emit({ type: 'reconnect', id: idOf(edge), end: isSource ? 'from' : 'to', point: { x: point.x, y: point.y }, ...(join ? { join } : {}) });
      }
      return edge;
    };
  }

  /** R16: a connector end dropped on another connector's line joins it there. Tolerance is a few screen pixels, whatever the zoom. */
  joinTargetAt(selfId: string, at: { x: number; y: number }): { connectorId: string; position: number } | null {
    const view = this.graph.view, s = view.scale, t = view.translate;
    const routes: DrawnRoute[] = [];
    for (const el of this.pageElements.values()) {
      if (el.kind !== 'connector' || el.hidden) continue;
      const cell = this.graph.getDataModel().getCell(el.id);
      const state = cell && view.getState(cell);
      const pts = ((state && state.absolutePoints) ?? []).filter((p): p is Point => !!p).map(p => ({ x: p.x / s - t.x, y: p.y / s - t.y }));
      if (pts.length > 1) routes.push({ id: el.id, route: pts });
    }
    const loops = (candidate: string): boolean => {
      const seen = new Set<string>();
      for (let id: string | undefined = candidate; id && !seen.has(id); ) {
        if (id === selfId) return true;
        seen.add(id);
        const c = this.pageElements.get(id);
        id = c && c.kind === 'connector' ? [c.from, c.to].find(ep => ep.join)?.join?.connectorId : undefined;
      }
      return false;
    };
    return findJoinTarget(routes, selfId, at, 8 / s, loops);
  }

  private activeFor(handler: object): boolean {
    const h = handler as { graph?: Graph };
    return !this.disposed && !this.projecting && h.graph === this.graph;
  }

  // ------------------------------------------------------------------ projection
  /** The page shown. A page that no longer exists falls back to the first. */
  pageId: string | undefined;

  /** The snapshot last projected, for questions about structure (R17 containers) that the cells alone cannot answer. */
  private projected: Snapshot | undefined;

  project(snapshot: Snapshot, pageId: string | undefined = this.pageId): Result<void> {
    if (this.disposed) return ok(undefined);
    this.projected = snapshot;
    const page = pageOf(snapshot, pageId);
    this.pageId = page.id;
    const selected = this.getSelection();
    this.projecting = true;
    const model = this.graph.getDataModel();
    model.beginUpdate();
    try {
      this.pageWidth = page.widthPt;
      this.pageHeight = page.heightPt;
      this.graph.setGridSize(page.grid.spacingPt);
      this.graph.setGridEnabled(false); // preserve raw pointer deltas for canonical guide precedence and layer settings
      this.paintSheet(page.background, page.grid);

      const wanted = new Map<string, Element>();
      for (const e of page.elements) if (e.kind !== 'group') wanted.set(e.id, e);
      this.pageElements = wanted;
      this.pageLayers = page.layers;
      // R19: a change that can affect a route (a shape moved, a connector edited) asks the planner again. The planner keeps every
      // route that is still valid, so a nudge elsewhere leaves unrelated connectors exactly where they were. Stacking order does not
      // affect routes, so it is not part of the signature.
      const sig = canonicalSerialize([...wanted.values()].map(e => e.kind === 'connector'
        ? { id: e.id, f: e.from, t: e.to, w: e.waypoints, r: e.route, g: e.routing, rp: e.routingPolicy, label: e.label, anchor: e.labelAnchor, sw: e.style.widthPt }
        : { id: e.id, b: e.bounds, rot: e.rotationDeg, h: e.hidden, l: e.layerIds, k: e.kind, rp: 'routingPolicy' in e ? e.routingPolicy : undefined,
          fi: e.kind === 'shape' ? [e.style.fill.kind, e.style.stroke.kind, e.style.strokeWidthPt, e.text, (e.container?.memberIds.length ?? 0) > 0] : e.kind === 'text' ? e.text : 0 }).concat(page.layers.map(l => ({ id: l.id, v: l.visible })) as never[]), );
      if (sig !== this.routingSig) {
        this.routingSig = sig;
        const plan = planRoutes({ elements: [...wanted.values()], layers: page.layers, pageArea: this.pageWidth * this.pageHeight, previous: this.planned });
        this.planned = plan.routes;
        this.routeChanges = plan.changes;
        this.routeFindings = plan.routeFindings;
        for (const c of plan.changes) this.shown.delete(c.id);
      }
      const parent = this.graph.getDefaultParent();

      for (const child of [...parent.getChildren()]) {
        const id = child.getId();
        if (id && !wanted.has(id)) { model.remove(child); this.shown.delete(id); }
      }
      const byOrder = [...wanted.values()].sort(compareElementOrder);
      for (const el of byOrder) if (el.kind !== 'connector' && el.kind !== 'group') this.upsertVertex(el, page.layers);
      for (const el of byOrder) if (el.kind === 'connector') this.upsertEdge(el, page.layers);

      // Stacking follows the shared (level, zIndex) order: vertices and connectors are interleaved.
      byOrder.forEach((el, i) => {
        const cell = model.getCell(el.id);
        if (cell && parent.getChildAt(i) !== cell) model.add(parent, cell, i);
      });
    } finally {
      model.endUpdate();
      this.projecting = false;
    }
    this.redrawHops();
    this.restoreSelection(selected);
    this.layoutWorld();
    return ok(undefined);
  }

  /** A hop depends on the other connectors, which may have moved while this one did not change, so a hopping connector is always repainted. */
  private redrawHops(): void {
    const model = this.graph.getDataModel();
    for (const el of this.pageElements.values()) {
      if (el.kind !== 'connector' || el.hops !== 'arc') continue;
      const cell = model.getCell(el.id);
      const state = cell && this.graph.view.getState(cell);
      if (state) this.graph.cellRenderer.redraw(state, true);
    }
  }

  private restoreSelection(ids: string[]): void {
    const model = this.graph.getDataModel();
    const cells = ids.map(id => model.getCell(id)).filter((c): c is Cell => !!c);
    // Projection updates cells in place, so an unchanged selection is already right; setting it again would rebuild the handlers of every selected cell.
    const now = this.graph.getSelectionCells() as Cell[];
    if (now.length === cells.length && now.every((c, i) => c === cells[i])) return;
    this.projecting = true;
    try { this.graph.setSelectionCells(cells); } finally { this.projecting = false; }
  }

  private keyFor(el: Element, state: { visible: boolean; locked: boolean }): string {
    return canonicalSerialize({ el, state, asset: el.kind === 'image' ? this.assetUrl(el.assetId) : null });
  }

  private upsertVertex(el: Exclude<Element, { kind: 'connector' } | { kind: 'group' }>, layers: readonly import('../contracts/generated').Layer[]): void {
    const model = this.graph.getDataModel();
    const state = effectiveState(el, layers);
    const key = this.keyFor(el, state);
    let cell = model.getCell(el.id);
    if (cell && this.shown.get(el.id) === key) return;
    const style = vertexStyle(el, state.locked, this.assetUrl);
    const value = labelOf(el);
    if (!cell) {
      cell = new Cell(value, new Geometry(el.bounds.x, el.bounds.y, el.bounds.width, el.bounds.height), style);
      cell.setVertex(true);
      cell.setId(el.id);
      model.add(this.graph.getDefaultParent(), cell);
    } else {
      model.setGeometry(cell, new Geometry(el.bounds.x, el.bounds.y, el.bounds.width, el.bounds.height));
      model.setStyle(cell, style);
      model.setValue(cell, value);
    }
    model.setVisible(cell, state.visible);
    this.shown.set(el.id, key);
  }

  private pageElements = new Map<string, Element>();
  private pageLayers: readonly import('../contracts/generated').Layer[] = [];
  private routingSig = '';
  /** R19: the routes the planner chose for the page shown, and what changed in the last planning pass. */
  private planned: ReadonlyMap<string, PlannedRoute> = new Map();
  private routeChanges: RouteChange[] = [];
  private routeFindings: import('../contracts/generated').RouteFinding[] = [];
  routePlan(): { routes: ReadonlyMap<string, PlannedRoute>; changes: readonly RouteChange[] } { return { routes: this.planned, changes: this.routeChanges }; }

  /** Connectors a hopping connector does not hop: the ones it is joined to or that join it, because those meet it on purpose. */
  private hopIgnoreOf(el: Extract<Element, { kind: 'connector' }>): string[] {
    const ids = new Set<string>();
    for (const ep of [el.from, el.to]) if (ep.join) ids.add(ep.join.connectorId);
    for (const o of this.pageElements.values()) if (o.kind === 'connector' && [o.from, o.to].some(ep => ep.join?.connectorId === el.id)) ids.add(o.id);
    return [...ids].sort();
  }

  private upsertEdge(el: Extract<Element, { kind: 'connector' }>, layers: readonly import('../contracts/generated').Layer[]): void {
    const model = this.graph.getDataModel();
    const state = effectiveState(el, layers);
    const key = this.keyFor(el, state) + [el.from.elementId, el.to.elementId].map(id => (id ? this.shown.get(id) ?? '' : '')).join('|') + (el.hops === 'arc' ? this.hopIgnoreOf(el).join(',') : '');
    let cell = model.getCell(el.id);
    if (cell && this.shown.get(el.id) === key) return;
    const geo = new Geometry();
    geo.relative = true;
    geo.points = el.waypoints.map(p => new Point(p.x, p.y));
    if (el.labelAnchor) { geo.x = el.labelAnchor.position * 2 - 1; geo.y = -el.labelAnchor.offsetPt; } // maxGraph: x runs -1 (start) to 1 (end) along the line; its y is positive to the left of travel, ours to the right
    if (el.from.glue === 'none' && el.from.point) geo.setTerminalPoint(new Point(el.from.point.x, el.from.point.y), true);
    if (el.to.glue === 'none' && el.to.point) geo.setTerminalPoint(new Point(el.to.point.x, el.to.point.y), false);
    const style = edgeStyle(el, state.locked, this.hopIgnoreOf(el));
    if (el.route === 'orthogonal') {
      const r = this.planned.get(el.id);
      if (r) {
        geo.points = r.points.slice(1, -1).map(p => new Point(p.x, p.y));
        delete style.edgeStyle; // the route is explicit, so maxGraph draws the polyline as given
        for (const [fix, x, y, per] of [[r.fixed.from, 'exitX', 'exitY', 'exitPerimeter'], [r.fixed.to, 'entryX', 'entryY', 'entryPerimeter']] as const) {
          delete style[x]; delete style[y];
          if (fix) { style[x] = fix.x; style[y] = fix.y; style[per] = fix.perimeter; }
        }
      }
    }
    if (!cell) {
      cell = new Cell(labelOf(el), geo, style);
      cell.setEdge(true);
      cell.setId(el.id);
      model.add(this.graph.getDefaultParent(), cell);
    } else {
      model.setGeometry(cell, geo);
      model.setStyle(cell, style);
      model.setValue(cell, labelOf(el));
    }
    model.setTerminal(cell, el.from.glue !== 'none' && el.from.elementId ? model.getCell(el.from.elementId) : null, true);
    model.setTerminal(cell, el.to.glue !== 'none' && el.to.elementId ? model.getCell(el.to.elementId) : null, false);
    model.setVisible(cell, state.visible);
    this.shown.set(el.id, key);
  }

  // ------------------------------------------------------------------ page sheet, grid and zoom
  private paintSheet(background: import('../contracts/generated').Paint, grid: { visible: boolean; spacingPt: number }): void {
    const s = this.graph.view.scale;
    const sheet = this.sheet;
    sheet.style.background = background.kind === 'solid' ? background.colour : '#ffffff';
    sheet.style.backgroundImage = grid.visible
      ? 'radial-gradient(circle, rgba(100,116,139,.55) 0.9px, transparent 1.1px)'
      : 'none';
    this.gridSpacing = grid.spacingPt;
    sheet.style.backgroundSize = `${grid.spacingPt * s}px ${grid.spacingPt * s}px`;
    sheet.dataset.grid = grid.visible ? 'on' : 'off';
  }

  private layoutWorld(): void {
    const s = this.graph.view.scale;
    this.world.style.width = `${(this.pageWidth + MARGIN_PT * 2) * s}px`;
    this.world.style.height = `${(this.pageHeight + MARGIN_PT * 2) * s}px`;
    Object.assign(this.sheet.style, { left: `${MARGIN_PT * s}px`, top: `${MARGIN_PT * s}px`, width: `${this.pageWidth * s}px`, height: `${this.pageHeight * s}px` });
    this.sheet.style.backgroundSize = `${this.gridSpacing * s}px ${this.gridSpacing * s}px`;
    this.cb.onViewport(this.getViewport());
  }
  private gridSpacing = 14.17;

  setZoom(scale: number, anchorClient?: { x: number; y: number }): void {
    const next = Math.min(8, Math.max(0.1, scale));
    const c = this.container;
    const rect = c.getBoundingClientRect();
    const ax = anchorClient ? anchorClient.x - rect.left : c.clientWidth / 2;
    const ay = anchorClient ? anchorClient.y - rect.top : c.clientHeight / 2;
    const old = this.graph.view.scale;
    const modelX = (c.scrollLeft + ax) / old - MARGIN_PT;
    const modelY = (c.scrollTop + ay) / old - MARGIN_PT;
    this.graph.view.setScale(next);
    this.layoutWorld();
    c.scrollLeft = (modelX + MARGIN_PT) * next - ax;
    c.scrollTop = (modelY + MARGIN_PT) * next - ay;
    this.cb.onViewport(this.getViewport());
  }

  zoomToFit(): void {
    const c = this.container;
    const s = Math.min(c.clientWidth / (this.pageWidth + MARGIN_PT * 2), c.clientHeight / (this.pageHeight + MARGIN_PT * 2));
    this.graph.view.setScale(s);
    this.layoutWorld();
    c.scrollLeft = 0;
    c.scrollTop = 0;
    this.cb.onViewport(this.getViewport());
  }

  getViewport(): ViewportInfo {
    return {
      scale: this.graph.view.scale, scrollLeft: this.container.scrollLeft, scrollTop: this.container.scrollTop,
      marginPt: MARGIN_PT, pageWidthPt: this.pageWidth, pageHeightPt: this.pageHeight,
    };
  }

  // ------------------------------------------------------------------ selection and tools
  getSelection(): string[] {
    return (this.graph.getSelectionCells() as Cell[]).map(c => c.getId()).filter((id): id is string => !!id);
  }

  setSelection(ids: string[]): void { this.restoreSelection(ids); }
  reveal(id: string): void {
    const cell=this.graph.getDataModel().getCell(id);
    if(cell)this.graph.scrollCellToVisible(cell,true);
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    const g = this.graph;
    const select = tool.kind === 'select';
    g.setCellsSelectable(select);
    g.setCellsMovable(select);
    g.setCellsResizable(select);
    g.setCellsEditable(select);
    if (!select) g.clearSelection();
    this.connectSource = null;
    this.drawConnectLine(null);
    this.container.style.cursor = select ? '' : 'crosshair';
  }

  private toModel(me: InternalMouseEvent): Point {
    const e = me.getEvent() as MouseEvent;
    const rect = this.container.getBoundingClientRect();
    const s = this.graph.view.scale;
    return new Point((e.clientX - rect.left + this.container.scrollLeft) / s - MARGIN_PT, (e.clientY - rect.top + this.container.scrollTop) / s - MARGIN_PT);
  }

  private mouseDown(me: InternalMouseEvent): void {
    if (this.tool.kind === 'connector') {
      const c = me.getCell();
      this.connectSource = c && c.isVertex() ? c : null;
      if (this.connectSource) me.consume();
    }
  }

  private mouseMove(me: InternalMouseEvent): void {
    if (this.tool.kind === 'connector' && this.connectSource) {
      const state = this.graph.view.getState(this.connectSource);
      if (state) {
        const e = me.getEvent() as MouseEvent;
        const rect = this.container.getBoundingClientRect();
        this.drawConnectLine({ x1: state.getCenterX(), y1: state.getCenterY(), x2: e.clientX - rect.left + this.container.scrollLeft, y2: e.clientY - rect.top + this.container.scrollTop });
      }
    }
  }

  private mouseUp(me: InternalMouseEvent): void {
    if (this.tool.kind === 'connector') {
      const src = this.connectSource;
      this.connectSource = null;
      this.drawConnectLine(null);
      const target = me.getCell();
      if (src && target && target.isVertex() && target !== src) this.cb.onIntent({ type: 'connect', from: src.getId()!, to: target.getId()! });
    } else if (this.tool.kind === 'place' && !me.isConsumed() && (me.getEvent() as MouseEvent).button === 0) {
      this.cb.onPlace(this.tool.what, this.toModel(me));
    }
  }

  private drawConnectLine(l: { x1: number; y1: number; x2: number; y2: number } | null): void {
    this.overlay.innerHTML = '';
    if (!l) return;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(this.container.scrollWidth));
    svg.setAttribute('height', String(this.container.scrollHeight));
    const line = document.createElementNS(ns, 'line');
    for (const [k, v] of Object.entries({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, stroke: '#2563eb', 'stroke-width': 2, 'stroke-dasharray': '6 4' })) line.setAttribute(k, String(v));
    svg.appendChild(line);
    this.overlay.appendChild(svg);
  }

  // ------------------------------------------------------------------ test support (read-only)
  centerOf(id: string): { x: number; y: number } {
    const cell = this.graph.getDataModel().getCell(id);
    const state = cell && this.graph.view.getState(cell);
    if (!cell || !state) throw new Error(`no cell ${id}`);
    const rect = this.container.getBoundingClientRect();
    if (cell.isEdge()) {
      const pts = state.absolutePoints as Array<Point | null>;
      const mid = pts[Math.floor(pts.length / 2)] ?? pts[0]!;
      const a = pts[Math.floor((pts.length - 1) / 2)] ?? mid;
      return { x: rect.left + ((a!.x + mid!.x) / 2) - this.container.scrollLeft, y: rect.top + ((a!.y + mid!.y) / 2) - this.container.scrollTop };
    }
    return { x: rect.left + state.getCenterX() - this.container.scrollLeft, y: rect.top + state.getCenterY() - this.container.scrollTop };
  }

  handleOf(id: string, which: 'rotate' | 'se' | 'bend'): { x: number; y: number } {
    const cell = this.graph.getDataModel().getCell(id);
    const handler = cell && ((this.graph.getPlugin('SelectionCellsHandler') as SelectionCellsHandler).getHandler(cell) as any);
    if (!handler) throw new Error(`no handler for ${id}: select it first`);
    const shape = which === 'rotate' ? handler.rotationShape : which === 'se' ? handler.sizers[7] : handler.bends[1];
    if (!shape) throw new Error(`no ${which} handle on ${id}`);
    const b = shape.bounds;
    const rect = this.container.getBoundingClientRect();
    return { x: rect.left + b.x + b.width / 2 - this.container.scrollLeft, y: rect.top + b.y + b.height / 2 - this.container.scrollTop };
  }

  /** Connector routes and visual bounds as maxGraph resolved them for the snapshot just projected. Derived data: never written back. */
  readProjection(snapshot: Snapshot, pageId?: string): import('../contracts/generated').Projection {
    const connectors: import('../contracts/generated').Projection['connectors'] = {};
    const s = this.graph.view.scale;
    const t = this.graph.view.translate;
    const page = pageOf(snapshot, pageId);
    for (const el of page.elements) {
      if (el.kind !== 'connector') continue;
      const cell = this.graph.getDataModel().getCell(el.id);
      const state = cell && this.graph.view.getState(cell);
      const pts = ((state && state.absolutePoints) ?? []).filter((p): p is Point => !!p).map(p => ({ x: p.x / s - t.x, y: p.y / s - t.y }));
      if (!pts.length) continue;
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      const planned = this.planned.get(el.id);
      const findings = this.routeFindings.filter(finding => finding.elementId === el.id);
      connectors[el.id] = { routePoints: pts, visualBounds: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, ...(planned ? { routeProvenance: planned.provenance, ...(planned.reason ? { routeReason: planned.reason } : {}) } : {}), ...(findings.length ? { routeFindings: findings } : {}) };
    }
    return { documentId: snapshot.documentId, sessionId: snapshot.sessionId, revision: snapshot.revision, connectors, groupVisualBounds: {} };
  }

  sheetRect(): { x: number; y: number; width: number; height: number } {
    const r = this.sheet.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  /** Scrolls so the object is in view (without recentring, unlike reveal; used when the keyboard moves to an object that is off screen). */
  ensureVisible(id: string): void {
    const cell = this.graph.getDataModel().getCell(id);
    if (cell) this.graph.scrollCellToVisible(cell, false);
  }

  startTextEdit(id: string): void {
    const cell = this.graph.getDataModel().getCell(id);
    if (cell) this.graph.startEditingAtCell(cell);
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.cleanups) c();
    this.graph.destroy();
    this.world.remove();
    this.overlay.remove();
    this.frames.remove();
  }

  /** Dashed frames around the selected groups. Groups have no cell of their own, so this is the only sign that the members belong together. */
  setGroupFrames(boxes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): void {
    this.frames.replaceChildren();
    const s = this.graph.view.scale;
    for (const b of boxes) {
      const d = document.createElement('div');
      d.className = 'group-frame';
      d.dataset.testid = 'group-frame';
      d.style.cssText = `position:absolute;box-sizing:border-box;left:${(b.x + MARGIN_PT) * s}px;top:${(b.y + MARGIN_PT) * s}px;width:${b.width * s}px;height:${b.height * s}px;border:1px dashed #2563eb;`;
      this.frames.appendChild(d);
    }
  }
}
