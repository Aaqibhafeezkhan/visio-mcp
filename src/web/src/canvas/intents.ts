import type { Bounds, Element, Endpoint, Operation, Page, Point, Snapshot } from '../contracts/generated';
import { visualBounds, unionBounds } from '../commands/geometry';
import { anchorsOf, guideCorrection, layersSnap, type GuideSnapOptions } from './guideSnapping';
import { carriedLeaves, collapseToGroups, leavesOfTargets, outermostTargets } from './selection';
import { containerParents, isContainer, isInside as isInsideContainer } from '../layout/containers';
import { parentMap } from '../commands/groups';

/**
 * Pure translation from what the user did on the canvas into canonical operations. Snapping happens here, in the interaction
 * planner, so the committed coordinates are the snapped ones and the canvas never makes a second, hidden adjustment.
 */

export type Intent =
  | { type: 'move'; ids: string[]; dx: number; dy: number }
  | { type: 'resize'; id: string; bounds: Bounds }
  | { type: 'rotate'; id: string; deltaDeg: number }
  | { type: 'bend'; id: string; waypoints: Point[] }
  | { type: 'reconnect'; id: string; end: 'from' | 'to'; elementId?: string; point?: Point; join?: { connectorId: string; position: number } }
  | { type: 'text'; id: string; value: string }
  | { type: 'connect'; from: string; to: string };

export interface SnapContext { enabled: boolean; spacingPt: number }

export function pageOf(snapshot: Snapshot, pageId?: string): Page {
  const pages = snapshot.document.pages;
  return (pageId ? pages.find(p => p.id === pageId) : undefined) ?? pages[0]!;
}

export function findElement(snapshot: Snapshot, id: string): Element | undefined {
  for (const p of snapshot.document.pages) for (const e of p.elements) if (e.id === id) return e;
  return undefined;
}

/** An element snaps only if the page grid snaps and every layer it belongs to allows snapping. */
export function snapContextFor(page: Page, element: Element | undefined): SnapContext {
  const layersAllow = !element || element.layerIds.every(id => page.layers.find(l => l.id === id)?.snap !== false);
  return { enabled: page.grid.snap && layersAllow && page.grid.spacingPt > 0, spacingPt: page.grid.spacingPt };
}

export const snap = (v: number, ctx: SnapContext): number => (ctx.enabled ? Math.round(v / ctx.spacingPt) * ctx.spacingPt : v);
const round = (v: number, places = 9) => Math.round(v * 10 ** places) / 10 ** places;

/** Connectors that are positioned entirely by their glued endpoints move with their shapes, not by themselves. */
const movesByItself = (e: Element) => e.kind !== 'connector' || e.from.glue === 'none' || e.to.glue === 'none' || e.waypoints.length > 0;

export function moveOperations(snapshot: Snapshot, ids: string[], dx: number, dy: number, guides?: GuideSnapOptions): Operation[] {
  // R17: whatever is inside a moved container goes with it, so only the outermost objects are moved
  const elements = outermostTargets(snapshot, ids).map(id => findElement(snapshot, id)).filter((e): e is Element => !!e && movesByItself(e));
  if (!elements.length || (dx === 0 && dy === 0)) return []; // no movement is no edit, however far from the grid the element sits
  // Snap the lead element's top-left to the grid and move everything by the same corrected delta, so relative layout is kept.
  const lead = elements.find(e => e.kind !== 'connector') ?? elements[0]!;
  const ctx = snapContextFor(pageContaining(snapshot, lead.id), lead);
  const page = pageContaining(snapshot, lead.id);
  const allowGuides = elements.every(e => layersSnap(page,e));
  const boxes=elements.filter(e=>e.kind!=='connector').map(visualBounds);
  const extent=unionBounds(boxes.length?boxes:[lead.bounds]);
  const moved={...extent,x:extent.x+dx,y:extent.y+dy};
  const gx=allowGuides?guideCorrection(page,'x',anchorsOf(moved,'x'),guides):undefined;
  const gy=allowGuides?guideCorrection(page,'y',anchorsOf(moved,'y'),guides):undefined;
  const sdx=round(gx===undefined?snap(lead.bounds.x+dx,ctx)-lead.bounds.x:dx+gx);
  const sdy=round(gy===undefined?snap(lead.bounds.y+dy,ctx)-lead.bounds.y:dy+gy);
  if (sdx === 0 && sdy === 0) return [];
  return elements.map(e => ({ op: 'move', target: e.id, delta: { xPt: sdx, yPt: sdy } }));
}

export function pageContaining(snapshot: Snapshot, id: string): Page {
  return snapshot.document.pages.find(p => p.elements.some(e => e.id === id)) ?? snapshot.document.pages[0]!;
}

export function resizeOperations(snapshot: Snapshot, id: string, bounds: Bounds, guides?: GuideSnapOptions): Operation[] {
  const el = findElement(snapshot, id);
  if (!el || el.kind === 'connector') return [];
  const b0 = el.bounds;
  if (b0.x === bounds.x && b0.y === bounds.y && b0.width === bounds.width && b0.height === bounds.height) return []; // unchanged is not an edit
  const ctx = snapContextFor(pageContaining(snapshot, id), el);
  const x = snap(bounds.x, ctx), y = snap(bounds.y, ctx);
  const right = snap(bounds.x + bounds.width, ctx), bottom = snap(bounds.y + bounds.height, ctx);
  const next = ctx.enabled && right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  const page = pageContaining(snapshot,id);
  if (layersSnap(page,el)) {
    // Resize only the changed edge; a centre target adjusts that edge by twice the correction.
    for (const axis of ['x','y'] as const) {
      const size = axis === 'x' ? 'width' : 'height';
      const startChanged = bounds[axis] !== b0[axis];
      const endChanged = bounds[axis]+bounds[size] !== b0[axis]+b0[size];
      if (!startChanged && !endChanged) continue;
      const vb = visualBounds({...el,bounds} as Element);
      const points = el.rotationDeg === 0 ? anchorsOf(bounds,axis).filter((_,i)=>i===1||(i===0&&startChanged)||(i===2&&endChanged)) : anchorsOf(vb,axis);
      const correction=guideCorrection(page,axis,points,guides);
      if (correction === undefined) continue;
      // At nonzero rotation retain the resized rectangle and translate its visual extent to the guide.
      if (el.rotationDeg !== 0) { next[axis]=bounds[axis]+correction;next[size]=bounds[size];continue; }
      const edgePoints = [bounds[axis],bounds[axis]+bounds[size]];
      const edgeCorrection=guideCorrection(page,axis,startChanged&&endChanged?edgePoints:[edgePoints[startChanged?0:1]!],guides);
      const delta = edgeCorrection === correction ? correction : 2*correction;
      const start = startChanged ? bounds[axis]+delta : bounds[axis];
      const end = endChanged ? bounds[axis]+bounds[size]+delta : bounds[axis]+bounds[size];
      if(end>start){next[axis]=start;next[size]=end-start;}
    }
  }
  if(el.rotationDeg !== 0 && layersSnap(page,el)) {
    const finalVisual=visualBounds({...el,bounds:next} as Element);
    next.x += guideCorrection(page,'x',anchorsOf(finalVisual,'x'),guides)??0;
    next.y += guideCorrection(page,'y',anchorsOf(finalVisual,'y'),guides)??0;
  }
  const rounded = { x: round(next.x), y: round(next.y), width: round(next.width), height: round(next.height) };
  const same = rounded.x === el.bounds.x && rounded.y === el.bounds.y && rounded.width === el.bounds.width && rounded.height === el.bounds.height;
  return same ? [] : [{ op: 'resize', target: id, bounds: rounded }];
}

export function rotateOperations(snapshot: Snapshot, id: string, deltaDeg: number): Operation[] {
  const el = findElement(snapshot, id);
  if (!el || el.kind === 'connector' || el.kind === 'group') return [];
  const delta = round(deltaDeg, 2);
  return delta === 0 ? [] : [{ op: 'rotate', target: id, deltaDeg: delta }];
}

export function intentOperations(snapshot: Snapshot, intent: Intent, guides?: GuideSnapOptions): Operation[] {
  switch (intent.type) {
    case 'move': {
      const moves = moveOperations(snapshot, intent.ids, intent.dx, intent.dy, guides);
      const first = moves[0];
      return first?.op === 'move' ? [...moves, ...membershipAfterDrag(snapshot, moves.map(m => (m as { target: string }).target), first.delta.xPt, first.delta.yPt)] : moves;
    }
    case 'resize': return resizeOperations(snapshot, intent.id, intent.bounds, guides);
    case 'rotate': return rotateOperations(snapshot, intent.id, intent.deltaDeg);
    case 'bend': return [{ op: 'set', target: intent.id, patch: { waypoints: intent.waypoints.map(p => ({ x: round(p.x, 3), y: round(p.y, 3) })) } }];
    case 'reconnect': {
      if (intent.join) return [{ op: 'set', target: intent.id, patch: { [intent.end]: { glue: 'none', join: { connector: intent.join.connectorId, position: round(intent.join.position, 4) } } } }];
      const endpoint: Endpoint = intent.elementId ? { elementId: intent.elementId, glue: 'dynamic' } : { point: intent.point ?? { x: 0, y: 0 }, glue: 'none' };
      return [{ op: 'set', target: intent.id, patch: { [intent.end]: endpoint } }];
    }
    case 'text': return [{ op: 'set', target: intent.id, patch: { text: { value: intent.value } } }];
    case 'connect': return [{ op: 'createConnector', from: { elementId: intent.from, glue: 'dynamic' }, to: { elementId: intent.to, glue: 'dynamic' }, route: 'orthogonal' }];
  }
}

/**
 * Delete the selection, taking attached connectors with their shapes and not deleting a connector twice. A group whose members are all
 * selected is deleted as one object, members included; members of a partly selected group are removed from it.
 */
export function deleteOperations(snapshot: Snapshot, ids: string[]): Operation[] {
  // R17: a container goes with everything inside it (as in Visio), so what it holds is not deleted a second time
  const targets = outermostTargets(snapshot, collapseToGroups(snapshot, ids));
  const doomed = new Set([...leavesOfTargets(snapshot, targets), ...carriedLeaves(snapshot, targets)]);
  const ops: Operation[] = [];
  for (const id of targets) {
    const el = findElement(snapshot, id);
    if (!el) continue;
    if (el.kind === 'connector') {
      const covered = [el.from, el.to].some(ep => ep.elementId && doomed.has(ep.elementId));
      if (!covered) ops.push({ op: 'delete', target: id });
    } else if (el.kind === 'group') ops.push({ op: 'delete', target: id, children: 'delete', withConnectors: true });
    else if (isContainer(el) && el.container.memberIds.length) ops.push({ op: 'delete', target: id, members: 'delete', withConnectors: true });
    else ops.push({ op: 'delete', target: id, withConnectors: true });
  }
  return ops;
}

export function nudgeOperations(snapshot: Snapshot, ids: string[], dx: number, dy: number): Operation[] {
  return outermostTargets(snapshot, ids).map(id => findElement(snapshot, id)).filter((e): e is Element => !!e && movesByItself(e) && !e.locked)
    .map(e => ({ op: 'move', target: e.id, delta: { xPt: dx, yPt: dy } }) as Operation);
}

/**
 * R17: dropping something wholly inside a container makes it a member of the smallest one, and dragging a member completely clear of its
 * container takes it out (it then belongs to that container's own container, if any). Only top-level objects take part, since a container
 * and its members share a group; locked containers are left alone. The changes join the move's transaction, so one undo reverses both.
 */
export function membershipAfterDrag(snapshot: Snapshot, moved: readonly string[], dx: number, dy: number): Operation[] {
  if (!moved.length) return [];
  const page = pageContaining(snapshot, moved[0]!);
  const groupParents = parentMap(page.elements);
  const holders = containerParents(page.elements);
  const byId = new Map(page.elements.map(e => [e.id, e] as const));
  const locked = (e: Element) => e.locked || e.layerIds.some(l => page.layers.find(x => x.id === l)?.locked);
  const top = (id: string) => { let x = id; for (let p = groupParents.get(x); p !== undefined; p = groupParents.get(p)) x = p; return x; };
  const units = [...new Set(moved.map(top))].filter(id => {
    const e = byId.get(id);
    return e && !groupParents.has(id) && (e.kind !== 'connector' || (e.from.glue === 'none' && e.to.glue === 'none' && !e.from.join && !e.to.join));
  });
  const travelling = new Set([...units, ...leavesOfTargets(snapshot, units), ...carriedLeaves(snapshot, units)]);
  for (const id of [...travelling]) for (let p = groupParents.get(id); p !== undefined; p = groupParents.get(p)) travelling.add(p);
  const candidates = page.elements.filter(e => isContainer(e) && !travelling.has(e.id) && !groupParents.has(e.id) && !locked(e));
  const inside = (o: Bounds, i: Bounds) => i.x >= o.x && i.y >= o.y && i.x + i.width <= o.x + o.width && i.y + i.height <= o.y + o.height;
  const clear = (a: Bounds, b: Bounds) => a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
  const adds = new Map<string, string[]>(), removes = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const id of units) {
    const b0 = visualBounds(byId.get(id)!), box = { ...b0, x: b0.x + dx, y: b0.y + dy };
    const now = holders.get(id);
    const current = now === undefined ? undefined : byId.get(now);
    // still touching its container: it stays, unless it was dropped wholly into a container inside that one
    const staying = current !== undefined && !clear(current.bounds, box);
    const deeper = (c: Element) => now !== undefined && isInsideContainer(holders, c.id, now);
    const home = candidates.filter(c => inside(c.bounds, box) && (!staying || deeper(c))).sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height)[0];
    if (home && home.id !== now) push(adds, home.id, id);
    else if (staying) continue;
    else if (!home) {
      // a removed member passes up to the next container, so it leaves each one it now lies clear of, up to the first it still touches
      for (let c = current; c !== undefined && clear(c.bounds, box) && !travelling.has(c.id) && !locked(c); c = byId.get(holders.get(c.id) ?? '')) push(removes, c.id, id);
    }
  }
  const depth = (id: string) => { let n = 0; for (let p = holders.get(id); p !== undefined; p = holders.get(p)) n++; return n; };
  return [
    ...[...removes].sort(([a], [b]) => depth(b) - depth(a)).map(([container, remove]) => ({ op: 'contain', container, remove }) as Operation),
    ...[...adds].map(([container, add]) => ({ op: 'contain', container, add }) as Operation),
  ];
}
