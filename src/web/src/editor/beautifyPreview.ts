import type { DiagramDocument, Element } from '../contracts/generated';
import { effectiveState } from '../canvas/cellMapping';
import { lockedJoinDependents } from '../commands/joins';
import { BUDGET } from '../layout/obstacleRoute';
import { planRoutes, type PlannedRoute } from '../layout/routePlanner';
import type { TextWidthMeasurer } from '../layout/textMeasurement';

export interface BeautifyPreviewRoute { id: string; points: Array<{ x: number; y: number }> }
export interface BeautifyPreviewSkipped { id: string; reason: string }
export interface BeautifyPreview {
  baseRevision: number;
  pageId: string;
  /** Eligible targets in stable id order. */
  targets: string[];
  /** Exact, unrounded routes that an explicit Beautify commit can apply. */
  proposedRoutes: BeautifyPreviewRoute[];
  skipped: BeautifyPreviewSkipped[];
  changedCount: number;
}
export interface BeautifyPreviewOptions {
  measureWidth?: TextWidthMeasurer;
  previous?: ReadonlyMap<string, PlannedRoute>;
}

const connector = (element: Element) => element.kind === 'connector';
const samePoints = (a: readonly { x: number; y: number }[], b: readonly { x: number; y: number }[]) =>
  a.length === b.length && a.every((p, i) => p.x === b[i]!.x && p.y === b[i]!.y);

/** Builds a read-only Beautify proposal from one immutable document revision. */
export async function buildBeautifyPreview(
  document: DiagramDocument,
  pageId: string,
  targetIds?: readonly string[],
  options: BeautifyPreviewOptions = {},
): Promise<BeautifyPreview> {
  const page = document.pages.find(item => item.id === pageId);
  if (!page) throw new Error(`Page ${pageId} was not found`);

  const byId = new Map(page.elements.map(element => [element.id, element]));
  const requested = targetIds === undefined
    ? page.elements.filter(connector).map(element => element.id)
    : [...new Set(targetIds)];
  const skipped: BeautifyPreviewSkipped[] = [];
  const targets: string[] = [];

  for (const id of requested.sort()) {
    const element = byId.get(id);
    if (!element || !connector(element)) { skipped.push({ id, reason: 'not an orthogonal connector on this page' }); continue; }
    if (element.route !== 'orthogonal') { skipped.push({ id, reason: 'only orthogonal connectors can be beautified' }); continue; }
    if (element.waypoints.length) { skipped.push({ id, reason: 'manual connectors are not eligible for Beautify' }); continue; }
    if (element.routing?.mode === 'frozen') { skipped.push({ id, reason: 'frozen connectors keep their stored route' }); continue; }
    if (element.routing?.constraints?.length) { skipped.push({ id, reason: 'guided connectors keep their pinned runs' }); continue; }
    const state = effectiveState(element, page.layers);
    if (!state.visible) { skipped.push({ id, reason: 'hidden connectors are not eligible for Beautify' }); continue; }
    if (state.locked) { skipped.push({ id, reason: 'connector or assigned layer is locked' }); continue; }
    if (lockedJoinDependents(page, id).length) { skipped.push({ id, reason: 'a locked connector is joined to this one' }); continue; }
    targets.push(id);
  }

  const base = planRoutes({
    elements: page.elements, layers: page.layers, pageArea: page.widthPt * page.heightPt,
    ...(options.previous ? { previous: options.previous } : {}),
    ...(options.measureWidth ? { measureWidth: options.measureWidth } : {}),
  });
  const planned = targets.length ? planRoutes({
    elements: page.elements, layers: page.layers, pageArea: page.widthPt * page.heightPt,
    previous: base.routes, beautifyTargets: new Set(targets), costProfile: 'aesthetic',
    beautifyCrossingDefault: document.routingDefaults?.crossing ?? 'avoid',
    ...(options.measureWidth ? { measureWidth: options.measureWidth } : {}),
  }) : base;

  const proposedRoutes: BeautifyPreviewRoute[] = [];
  for (const id of targets) {
    const route = planned.routes.get(id), current = base.routes.get(id);
    if (!route || !current) { skipped.push({ id, reason: 'no routable path was found' }); continue; }
    if (route.provenance === 'unresolved') { skipped.push({ id, reason: route.reason ?? 'route is unresolved' }); continue; }
    if (samePoints(route.points, current.points)) {
      const stats = planned.aestheticStats?.get(id);
      skipped.push({ id, reason: stats && stats.expandedStates >= BUDGET ? 'search budget exhausted; the current route was retained' : 'no aesthetic improvement was found; the current route was retained' });
      continue;
    }
    proposedRoutes.push({ id, points: route.points.map(point => ({ x: point.x, y: point.y })) });
  }

  return { baseRevision: document.revision, pageId, targets, proposedRoutes, skipped: skipped.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), changedCount: proposedRoutes.length };
}
