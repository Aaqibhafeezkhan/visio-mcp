import type { Bounds, Element, Page, Point, Projection, Snapshot, TextBlock } from '../contracts/generated';
import { visualBounds } from '../commands/geometry';
import { parentMap } from '../commands/groups';
import { effectiveState } from '../canvas/cellMapping';
import { measureTextBox, TextMeasurementLimitError, type TextMeasurement } from './textMeasurement';
import { parsePath } from '../geometry/svgPath';
import { inspectNearAlignments, isVisibleThinRule } from './inspectAlignment';
import { passesBehind } from './routingPolicy';
import { compareElementOrder, effectiveLevel } from '../model/elementOrder';
import { inspectRoutes, intendedCrossing } from './inspectRoutes';
import { findSwimlanes, isLaneStructure, isPartOfSwimlane, lanesCrossed, membershipOf } from './swimlane';
import { containerParents, holdsEnd, isContainer, isInside } from './containers';
import { leavesUnder } from '../commands/groups';

export type Severity = 'info' | 'warning' | 'error';

export interface LayoutIssue {
  code: string;
  severity: Severity;
  elementIds: string[];
  pageId: string;
  bounds: Bounds;
  message: string;
  evidence: Record<string, unknown>;
}

export interface LayoutContext {
  /** Width in points of `text` on one line in the given font. The caller decides how: a canvas in the page, a fixed table in tests. */
  measureWidth(text: string, font: { family: string; sizePt: number; bold: boolean; italic: boolean }): number;
  /** Natural pixel size of an asset if known; images are only checked for distortion when it is. */
  assetSize?(assetId: string): { width: number; height: number } | undefined;
  /** Resolved connector routes (derived, never canonical). Without them a connector is judged by the straight line between its ends. */
  projection?: Projection;
}

export interface LayoutReport { issues: LayoutIssue[]; notes: string[] }

const EPS = 0.01;
const isBox = (e: Element): e is Exclude<Element, { kind: 'connector' } | { kind: 'group' }> => e.kind !== 'connector' && e.kind !== 'group';

const intersect = (a: Bounds, b: Bounds): Bounds | null => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width), t = Math.min(a.y + a.height, b.y + b.height);
  return r > x + EPS && t > y + EPS ? { x, y, width: r - x, height: t - y } : null;
};
const area = (b: Bounds) => b.width * b.height;
const union = (list: Bounds[]): Bounds => {
  const x = Math.min(...list.map(b => b.x)), y = Math.min(...list.map(b => b.y));
  return { x, y, width: Math.max(...list.map(b => b.x + b.width)) - x, height: Math.max(...list.map(b => b.y + b.height)) - y };
};

/** Does the segment pass through the interior of the rectangle (Liang-Barsky)? Touching the edge does not count. */
function segmentCrosses(a: Point, b: Point, r: Bounds): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  const inset = 0.5;
  const ok = clip(-dx, a.x - (r.x + inset)) && clip(dx, r.x + r.width - inset - a.x) && clip(-dy, a.y - (r.y + inset)) && clip(dy, r.y + r.height - inset - a.y);
  return ok && t1 - t0 > 1e-6;
}

// ---- text

const luminance = (hex: string): number => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/**
 * Machine-readable layout warnings for a committed snapshot. A pure read: nothing here touches the document, and measurements of text
 * are estimates (the report says so), so overflow findings carry the sizes they were judged by.
 */
export function inspectLayout(snapshot: Snapshot, ctx: LayoutContext, opts: { pageId?: string } = {}): LayoutReport {
  const issues: LayoutIssue[] = [];
  const notes = ['Text size is estimated from font metrics measured in the editor; a borderline overflow may render differently.', 'Near-alignment hints are heuristic observations of comparable peer shapes, not proof that either object should move.'];
  if (!ctx.projection) notes.push('Connector routes were not available, so crossings are judged by straight lines between the connected elements, and connector-to-connector and route-shape checks were skipped.');
  if (!ctx.assetSize) notes.push('Image sizes were not available, so picture distortion was not checked.');

  for (const page of snapshot.document.pages) {
    if (opts.pageId && page.id !== opts.pageId) continue;
    inspectPage(page, ctx, issues, notes);
  }
  issues.sort((a, b) => a.pageId.localeCompare(b.pageId) || a.code.localeCompare(b.code) || a.elementIds[0]!.localeCompare(b.elementIds[0]!));
  return { issues, notes };
}

function inspectPage(page: Page, ctx: LayoutContext, issues: LayoutIssue[], notes: string[]): void {
  const byId = new Map(page.elements.map(e => [e.id, e] as const));
  const parents = parentMap(page.elements);
  const shown = page.elements.filter(e => effectiveState(e, page.layers).visible);
  const add = (code: string, severity: Severity, ids: string[], bounds: Bounds, message: string, evidence: Record<string, unknown> = {}) =>
    issues.push({ code, severity, elementIds: ids, pageId: page.id, bounds, message, evidence });
  const pageBox: Bounds = { x: 0, y: 0, width: page.widthPt, height: page.heightPt };
  const swimlanes = findSwimlanes(page);
  const holders = containerParents(page.elements);
  /** R17: is `id` inside container `containerId` at any depth, directly or through the group that holds it? */
  const within = (id: string, containerId: string): boolean => {
    for (let x: string | undefined = id; x !== undefined; x = parents.get(x)) if (isInside(holders, x, containerId)) return true;
    return false;
  };

  for (const el of shown) {
    if (el.kind === 'group') continue;
    const box = visualBounds(el);
    if (el.kind === 'shape' && el.geometry.svgPath !== undefined) {
      const parsed = parsePath(el.geometry.svgPath);
      if (!parsed.ok) add('UNSUPPORTED_PATH', 'error', [el.id], box, parsed.error.message);
    }

    // outside the page
    const over = { left: Math.max(0, -box.x), top: Math.max(0, -box.y), right: Math.max(0, box.x + box.width - page.widthPt), bottom: Math.max(0, box.y + box.height - page.heightPt) };
    if (over.left > EPS || over.top > EPS || over.right > EPS || over.bottom > EPS) {
      const fully = !intersect(box, pageBox);
      add('OUTSIDE_PAGE', fully ? 'error' : 'warning', [el.id], box, fully ? 'The element is entirely outside the page.' : 'The element extends past the page edge.', { overhangPt: over, pageWidthPt: page.widthPt, pageHeightPt: page.heightPt });
    }

    if (isBox(el)) {
      if ((el.bounds.width < 1 || el.bounds.height < 1) && !isVisibleThinRule(el)) add('ZERO_SIZE', el.bounds.width < EPS || el.bounds.height < EPS ? 'error' : 'warning', [el.id], box, 'The element is zero or almost zero in size and will not be seen.', { widthPt: el.bounds.width, heightPt: el.bounds.height });

      const text = el.kind === 'shape' ? el.text : el.kind === 'text' ? el.text : undefined;
      if (text && text.value.trim()) textChecks(el, text, box, add, ctx, page);

      if (el.kind === 'image') {
        const nat = ctx.assetSize?.(el.assetId);
        if (nat && nat.width > 0 && nat.height > 0 && (el.fit === 'stretch' || !el.preserveAspectRatio)) {
          const want = nat.width / nat.height, got = el.bounds.width / el.bounds.height;
          if (Math.abs(got / want - 1) > 0.05) add('IMAGE_DISTORTION', 'warning', [el.id], box, 'The picture is stretched to a different aspect ratio than the original.', { naturalAspect: want, shownAspect: got });
        }
      }
    }

    if (el.kind === 'connector') connectorChecks(el, add, ctx, byId, parents, shown, page.widthPt * page.heightPt, holders);
  }
  if (holders.size || page.elements.some(isContainer)) containerChecks(page, shown, byId, parents, holders, within, add);

  const alignment = inspectNearAlignments(page, shown, parents);
  issues.push(...alignment.issues);
  if (alignment.truncated) notes.push(`Near-alignment analysis was limited on page ${page.id}: at most 50,000 pairs and 100 hints are inspected.`);

  // hidden objects that sit on layers which are themselves visible: easy to forget, so report them quietly
  for (const el of page.elements) {
    if (el.hidden && el.kind !== 'group') add('HIDDEN_OBJECT', 'info', [el.id], visualBounds(el), 'The object is hidden although its layers are visible.', {});
  }

  // a shape that sits in one lane but spills into the next: reported, since its lane is decided by its middle
  for (const el of shown) {
    if (swimlanes.length === 0) break;
    if (el.kind === 'group' || el.kind === 'connector' || isPartOfSwimlane(swimlanes, el.id)) continue;
    const box = visualBounds(el), home = membershipOf(swimlanes, box);
    if (!home) continue;
    const sw = swimlanes.find(s => s.title === home.swimlane && s.bounds.x <= box.x + box.width / 2 && box.x + box.width / 2 < s.bounds.x + s.bounds.width);
    const crossed = sw ? lanesCrossed(sw, box) : [];
    if (crossed.length > 1) add('STRADDLES_LANES', 'info', [el.id], box, 'The element spills over a lane boundary; it counts as being in the lane that holds its middle.', { lane: home.lane, lanesTouched: crossed.map(l => l.title || `lane ${l.index + 1}`) });
  }

  // overlapping shapes and pictures: sweep along x. Swim-lane structure (frame, bands, header cells, rules) is containment by design.
  const boxes = shown.filter(e => (e.kind === 'shape' || e.kind === 'image') && !isLaneStructure(e)).map(e => ({ e, b: visualBounds(e) })).sort((a, b) => a.b.x - b.b.x);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length && boxes[j]!.b.x < boxes[i]!.b.x + boxes[i]!.b.width; j++) {
      const a = boxes[i]!, b = boxes[j]!;
      const hit = intersect(a.b, b.b);
      if (!hit) continue;
      const smaller = Math.min(area(a.b), area(b.b));
      if (hit.width * hit.height >= 0.98 * smaller) continue; // one sits inside the other: a container, not a collision
      if (hit.width * hit.height < 0.1 * smaller) continue;
      if (sharesGroup(a.e.id, b.e.id, parents)) continue;
      if ((isContainer(a.e) && within(b.e.id, a.e.id)) || (isContainer(b.e) && within(a.e.id, b.e.id))) continue; // R17: a container holds its members by design
      add('OVERLAP', 'warning', [a.e.id, b.e.id].sort(), hit, 'Two shapes overlap without one containing the other.', { overlapAreaPt2: Math.round(hit.width * hit.height), fractionOfSmaller: Math.round((hit.width * hit.height / smaller) * 100) / 100 });
    }
  }

  // R26: connectors against each other and the shape of each route, judged on the routes as drawn
  if (ctx.projection) {
    const routes = new Map(Object.entries(ctx.projection.connectors).map(([id, c]) => [id, { points: c.routePoints, ...(c.routeProvenance ? { provenance: c.routeProvenance } : {}) }] as const));
    inspectRoutes(page, shown, routes, add);
  }
}

/**
 * R17 containment findings. Members that stick out of their container, elements that sit wholly inside a container without belonging to it,
 * and containers whose fill is drawn over one of their own members.
 */
function containerChecks(
  page: Page, shown: Element[], byId: ReadonlyMap<string, Element>, parents: ReadonlyMap<string, string>, holders: ReadonlyMap<string, string>,
  within: (id: string, containerId: string) => boolean,
  add: (c: string, s: Severity, ids: string[], b: Bounds, m: string, e?: Record<string, unknown>) => void,
): void {
  const visible = new Set(shown.map(e => e.id));
  const containers = shown.filter(isContainer);
  for (const c of containers) {
    const frame = c.bounds;
    for (const m of c.container.memberIds) {
      const member = byId.get(m);
      if (!member || !visible.has(m)) continue;
      const b = visualBounds(member);
      const over = { left: frame.x - b.x, top: frame.y - b.y, right: b.x + b.width - frame.x - frame.width, bottom: b.y + b.height - frame.y - frame.height };
      if (Object.values(over).some(v => v > OUTSIDE_TOLERANCE)) {
        add('MEMBER_OUTSIDE_CONTAINER', 'warning', [m, c.id], union([b, frame]), 'A member of a container extends outside it.',
          { containerId: c.id, overhangPt: Object.fromEntries(Object.entries(over).map(([k, v]) => [k, Math.max(0, Math.round(v * 100) / 100)])) });
      }
      // A filled container drawn in front of a member covers it.
      const fill = c.style.fill;
      if (fill.kind !== 'none' && (!('opacity' in fill) || fill.opacity > 0)) {
        const covered = leavesUnder(byId, m).map(id => byId.get(id)!).filter(l => visible.has(l.id) && compareElementOrder(c, l) > 0 && intersect(frame, visualBounds(l)));
        if (covered.length) add('CONTAINER_HIDES_MEMBER', 'warning', [c.id, ...covered.map(l => l.id).sort()], frame, 'A filled container is drawn in front of its own members and hides them; send it back.',
          { containerId: c.id, hiddenElementIds: covered.map(l => l.id).sort() });
      }
    }
  }
  // Whole units only (top-level elements and groups), each reported once against the smallest container that holds it. A line free at
  // both ends is drawn like a shape and only moves with a container if it is a member; a glued connector follows its shapes anyway.
  for (const el of shown) {
    if (el.kind === 'connector' && (el.from.glue !== 'none' || el.to.glue !== 'none' || el.from.join || el.to.join)) continue;
    if (parents.has(el.id) || isLaneStructure(el)) continue;
    const b = visualBounds(el);
    const around = containers.filter(c => c.id !== el.id && !within(c.id, el.id) && contains(c.bounds, b));
    if (!around.length) continue;
    const smallest = around.reduce((x, y) => (area(y.bounds) < area(x.bounds) ? y : x));
    if (within(el.id, smallest.id)) continue;
    add('UNLISTED_INSIDE_CONTAINER', 'info', [el.id, smallest.id], b, 'The element sits inside a container but is not one of its members, so it will not move with it.',
      { containerId: smallest.id, ...(holders.has(el.id) ? { memberOf: holders.get(el.id) } : {}) });
  }
}

/** A member may overhang its container by this much (points) before it is reported: imported drawings are rarely exact. */
const OUTSIDE_TOLERANCE = 2;
const freeEndInside = (c: Extract<Element, { kind: 'connector' }>, b: Bounds): boolean =>
  [c.from, c.to].some(ep => ep.glue === 'none' && !ep.join && !!ep.point && ep.point.x > b.x && ep.point.x < b.x + b.width && ep.point.y > b.y && ep.point.y < b.y + b.height);
const contains = (outer: Bounds, inner: Bounds): boolean =>
  inner.x >= outer.x - EPS && inner.y >= outer.y - EPS && inner.x + inner.width <= outer.x + outer.width + EPS && inner.y + inner.height <= outer.y + outer.height + EPS;

function sharesGroup(a: string, b: string, parents: ReadonlyMap<string, string>): boolean {
  return parents.get(a) !== undefined && parents.get(a) === parents.get(b);
}

function textChecks(el: Exclude<Element, { kind: 'connector' } | { kind: 'group' }>, text: TextBlock, box: Bounds, add: (c: string, s: Severity, ids: string[], b: Bounds, m: string, e?: Record<string, unknown>) => void, ctx: LayoutContext, page: Page): void {
  let m: TextMeasurement;
  try { m = measureTextBox(text, el.bounds.width, el.bounds.height, ctx.measureWidth); }
  catch (error) {
    if (!(error instanceof TextMeasurementLimitError)) throw error;
    add('TEXT_MEASUREMENT_LIMIT', 'warning', [el.id], box, error.message);
    return;
  }
  const availW = m.availableWidthPt, availH = m.availableHeightPt, needH = m.contentHeightPt;
  const tooWide = m.contentWidthPt > availW + 0.5;
  const tooTall = needH > availH + 0.5;
  if (tooWide || tooTall) {
    add('TEXT_OVERFLOW', 'warning', [el.id], box, tooTall ? 'The text needs more height than the element has and will be clipped.' : 'The text is wider than the element.', {
      neededWidthPt: Math.round(m.contentWidthPt * 10) / 10, availableWidthPt: Math.round(availW * 10) / 10,
      neededHeightPt: Math.round(needH * 10) / 10, availableHeightPt: Math.round(availH * 10) / 10, lines: m.lines, measured: 'estimated',
    });
  }
  // contrast against what is behind the text: the shape's own fill, or the page
  // (a gradient is judged by its worst stop: the text has to be readable wherever it falls)
  const fill = el.kind === 'shape' ? el.style.fill : undefined;
  const backs: string[] = fill?.kind === 'solid' && fill.opacity >= 0.5 ? [fill.colour]
    : fill?.kind === 'linear-gradient' ? fill.stops.filter(s => s.opacity >= 0.5).map(s => s.colour) : [];
  if (backs.length === 0) backs.push(page.background.kind === 'solid' ? page.background.colour : '#ffffff');
  const worst = backs.reduce((a, b) => (contrastRatio(text.colour, b) < contrastRatio(text.colour, a) ? b : a));
  const ratio = contrastRatio(text.colour, worst);
  if (ratio < 3) add('LOW_CONTRAST', 'warning', [el.id], box, 'The text colour is hard to read against its background.', { textColour: text.colour, backgroundColour: worst, contrastRatio: Math.round(ratio * 100) / 100, minimum: 3 });
}

function connectorChecks(
  el: Extract<Element, { kind: 'connector' }>,
  add: (c: string, s: Severity, ids: string[], b: Bounds, m: string, e?: Record<string, unknown>) => void,
  ctx: LayoutContext, byId: ReadonlyMap<string, Element>, parents: ReadonlyMap<string, string>, shown: Element[], pageArea: number, holders: ReadonlyMap<string, string>,
): void {
  const box = visualBounds(el);
  const ends: Array<{ side: 'from' | 'to'; ep: typeof el.from }> = [{ side: 'from', ep: el.from }, { side: 'to', ep: el.to }];
  // both ends free: a deliberate line (a rule, a divider), not a half-attached connector
  const freeLine = el.from.glue === 'none' && el.to.glue === 'none';
  // R16: an end joined to another connector is attached to it, so it is neither unglued nor dangling
  for (const { side, ep } of ends) {
    if (ep.join) { if (!byId.has(ep.join.connectorId)) add('DANGLING_CONNECTOR', 'error', [el.id], box, `The connector's ${side} end joins a connector that does not exist.`, { end: side, connectorId: ep.join.connectorId }); }
    else if (ep.glue === 'none') { if (!freeLine) add('UNGLUED_CONNECTOR_END', 'warning', [el.id], box, `The connector's ${side} end is not attached to a shape.`, { end: side, point: ep.point }); }
    else if (!ep.elementId || !byId.has(ep.elementId)) add('DANGLING_CONNECTOR', 'error', [el.id], box, `The connector's ${side} end points at an element that does not exist.`, { end: side, elementId: ep.elementId });
  }
  const centre = (id?: string): Point | undefined => { const t = id ? byId.get(id) : undefined; return t ? { x: t.bounds.x + t.bounds.width / 2, y: t.bounds.y + t.bounds.height / 2 } : undefined; };
  const route: Point[] = ctx.projection?.connectors[el.id]?.routePoints?.length
    ? ctx.projection.connectors[el.id]!.routePoints
    : [el.from.glue === 'none' ? el.from.point : centre(el.from.elementId), ...el.waypoints, el.to.glue === 'none' ? el.to.point : centre(el.to.elementId)].filter((p): p is Point => !!p);
  if (route.length < 2) return;
  const proj = ctx.projection?.connectors[el.id];
  const findings = proj?.routeFindings ?? [];
  for (const finding of findings) add(finding.code, finding.severity, [el.id, ...(finding.blockerIds ?? [])], box, finding.message, { ...(finding.blockerIds?.length ? { blockerIds: finding.blockerIds } : {}) });
  if (proj?.routeProvenance === 'unresolved' && !findings.some(finding => finding.code === 'UNRESOLVED_ROUTE')) add('UNRESOLVED_ROUTE', 'warning', [el.id], box, 'No clear route was found for this connector; the route shown may cross shapes or run along other connectors.', { provenance: proj.routeProvenance, ...(proj.routeReason ? { reason: proj.routeReason } : {}) });
  const softReported = new Set(findings.filter(finding => finding.code === 'ROUTING_AVOIDANCE_VIOLATION').flatMap(finding => finding.blockerIds ?? []));
  const ancestorsOfEnds = new Set<string>();
  for (const id of [el.from.elementId, el.to.elementId]) for (let p = id ? parents.get(id) : undefined; p; p = parents.get(p)) ancestorsOfEnds.add(p);
  const crossed: string[] = [], over: string[] = [], container: string[] = [], background: string[] = [];
  const level = effectiveLevel(el);
  for (const other of shown) {
    if (other.id === el.from.elementId || other.id === el.to.elementId || other.kind !== 'shape' && other.kind !== 'image') continue;
    if (other.kind === 'shape' && other.routingPolicy?.obstacle === 'passThrough') continue;
    if (softReported.has(other.id)) continue;
    if (isLaneStructure(other)) continue; // a lane is something a connector runs inside, not a shape in its way
    if (ancestorsOfEnds.has(other.id)) continue;
    // R17: a connector crosses the edge of a container that holds one of its ends, or the connector itself, to reach inside. A free end
    // has no element to belong to, so for this judgement only it is held by a container it lies inside.
    if (isContainer(other) && (holdsEnd(holders, parents, el, other.id) || isInside(holders, el.id, other.id) || freeEndInside(el, other.bounds))) continue;
    const b = visualBounds(other);
    // R23: a shape on a lower level is behind the connector; R26: a frame round one of its ends, or a page-size backdrop, is crossed on purpose
    const intended = passesBehind(other, level) ? 'over' : intendedCrossing(el, other, byId, pageArea);
    const into = intended === 'over' ? over : intended === 'container' ? container : intended === 'background' ? background : crossed;
    for (let i = 0; i + 1 < route.length; i++) if (segmentCrosses(route[i]!, route[i + 1]!, b)) { into.push(other.id); break; }
  }
  if (over.length) add('CONNECTOR_PASSES_OVER_SHAPE', 'info', [el.id, ...over.sort()], box, 'The connector runs over shapes on a lower level; they are behind it, so the route does not avoid them.',
    { passedOverElementIds: over, rule: 'lower_level', connectorLevel: level, levels: Object.fromEntries(over.map(id => [id, effectiveLevel(byId.get(id)!)])) });
  const routeFrom = ctx.projection?.connectors[el.id] ? 'resolved route' : 'straight line between ends';
  const policyOf = (id: string) => { const o = byId.get(id)!; return ('routingPolicy' in o ? o.routingPolicy?.obstacle : undefined) ?? 'automatic'; };
  if (container.length) add('CONNECTOR_CROSSES_CONTAINER', 'info', [el.id, ...container.sort()], box, 'The connector crosses the outline of a shape that holds one of its ends; it enters or leaves the container on purpose.',
    { classification: 'container_boundary', intended: true, crossedElementIds: container, routeFrom });
  if (background.length) add('CONNECTOR_CROSSES_BACKGROUND', 'info', [el.id, ...background.sort()], box, 'The connector runs over a page-size backdrop, which is decoration, not an obstacle.',
    { classification: 'background_decoration', intended: true, crossedElementIds: background, routeFrom });
  if (crossed.length) add('CONNECTOR_CROSSES_SHAPE', 'warning', [el.id, ...crossed.sort()], union([box, ...crossed.map(id => visualBounds(byId.get(id)!))]), 'The connector passes through shapes it is not attached to.',
    { crossedElementIds: crossed.sort(), routeFrom, classification: 'obstacle_crossing', intended: false, policies: Object.fromEntries(crossed.map(id => [id, policyOf(id)])), ...(proj?.routeProvenance ? { provenance: proj.routeProvenance } : {}) });
}

export { union as unionBounds };
