import type { Element, Page, Snapshot } from '../contracts/generated';
import { ancestorsOf, leavesUnder, parentMap } from '../commands/groups';
import { containerAncestors, containerDescendants, containerParents } from '../layout/containers';

/**
 * Groups are not drawn as cells of their own: the canvas holds the members, and a group is "selected" when all of its members are.
 * These helpers translate between the two views. The model keeps the canvas view (leaf ids); the user-facing view collapses
 * complete groups into one object.
 */

/** What a page's group structure looks like, built once per (frozen) page so a selection of hundreds of ids does not rebuild it for each id. */
interface PageIndex { page: Page; parents: Map<string, string>; byId: Map<string, Element>; holders: Map<string, string> }
const pageIndexes = new WeakMap<Page, PageIndex>();
const owners = new WeakMap<Snapshot['document'], Map<string, Page>>();

const indexOf = (page: Page): PageIndex => {
  let index = pageIndexes.get(page);
  if (!index) pageIndexes.set(page, index = { page, parents: parentMap(page.elements), byId: new Map(page.elements.map(e => [e.id, e] as const)), holders: containerParents(page.elements) });
  return index;
};

/** The first page holding the element (an id is unique in a document, so this is the only one). */
const indexHolding = (snapshot: Snapshot, id: string): PageIndex | undefined => {
  let byElement = owners.get(snapshot.document);
  if (!byElement) {
    owners.set(snapshot.document, byElement = new Map());
    for (const page of snapshot.document.pages) for (const e of page.elements) if (!byElement.has(e.id)) byElement.set(e.id, page);
  }
  const page = byElement.get(id);
  return page && indexOf(page);
};

/** Clicking a member selects its whole top-level group, so the group moves, copies and deletes as one. */
export function expandToGroups(snapshot: Snapshot, ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => { if (!seen.has(id)) { seen.add(id); out.push(id); } };
  for (const id of ids) {
    const index = indexHolding(snapshot, id);
    if (!index) continue;
    const top = ancestorsOf(index.parents, id).at(-1);
    if (!top) { add(id); continue; }
    for (const leaf of leavesUnder(index.byId, top)) add(leaf);
  }
  return out;
}

/** The selection as the user means it: every group whose members are all selected stands for them, and its parent group does too when it is complete. */
export function collapseToGroups(snapshot: Snapshot, ids: readonly string[]): string[] {
  const chosen = new Set(ids);
  const complete = new Map<string, boolean>(); // per group: are all its leaves selected (many members share the same ancestors)
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const index = indexHolding(snapshot, id);
    if (!index) continue;
    // highest ancestor whose every leaf is selected
    let pick = id;
    for (const g of ancestorsOf(index.parents, id)) {
      let whole = complete.get(g);
      if (whole === undefined) complete.set(g, whole = leavesUnder(index.byId, g).every(l => chosen.has(l)));
      if (whole) pick = g;
    }
    if (!seen.has(pick)) { seen.add(pick); out.push(pick); }
  }
  // a group already chosen covers its own members that were also listed
  return out.filter(id => {
    const index = indexHolding(snapshot, id);
    return !index || !ancestorsOf(index.parents, id).some(a => seen.has(a));
  });
}

/** Every leaf under the given targets (a leaf stands for itself). */
export function leavesOfTargets(snapshot: Snapshot, targets: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of targets) {
    const index = indexHolding(snapshot, t);
    if (index) out.push(...leavesUnder(index.byId, t));
  }
  return out;
}

/** R17: the containers that hold an element at any depth, reached through the element itself or the groups above it. */
function enclosing(index: PageIndex, id: string): string[] {
  const out: string[] = [];
  for (const x of [id, ...ancestorsOf(index.parents, id)]) out.push(...containerAncestors(index.holders, x));
  return out;
}

/**
 * R17: drops targets that already move with another target: anything inside a selected container (or inside a container under a
 * selected group). Moving, nudging, aligning or deleting the container takes care of them, so acting on them too would do it twice.
 */
export function outermostTargets(snapshot: Snapshot, targets: readonly string[]): string[] {
  const chosen = new Set(targets);
  const covered = (index: PageIndex, c: string) => chosen.has(c) || ancestorsOf(index.parents, c).some(g => chosen.has(g));
  return targets.filter(id => {
    const index = indexHolding(snapshot, id);
    return !index || !enclosing(index, id).some(c => covered(index, c));
  });
}

/** R17: the leaves that travel with the given targets because they are inside one of them (a container), at any depth. */
export function carriedLeaves(snapshot: Snapshot, targets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of targets) {
    const index = indexHolding(snapshot, t);
    if (!index) continue;
    for (const leaf of leavesUnder(index.byId, t)) for (const d of containerDescendants(index.byId, leaf)) for (const l of leavesUnder(index.byId, d)) out.add(l);
  }
  for (const t of targets) out.delete(t);
  return [...out];
}

/** R17: connectors that are not members but are glued at both ends to what a container carries; the engine moves them whole with it. */
export function carriedConnectors(snapshot: Snapshot, targets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of targets) {
    const index = indexHolding(snapshot, t);
    const inside = carriedLeaves(snapshot, [t]);
    if (!index || !inside.length) continue;
    const moving = new Set([t, ...leavesUnder(index.byId, t), ...inside]);
    for (const e of index.byId.values()) if (e.kind === 'connector' && !moving.has(e.id) && e.from.elementId && e.to.elementId && moving.has(e.from.elementId) && moving.has(e.to.elementId)) out.add(e.id);
  }
  return [...out];
}

export type { Element };
