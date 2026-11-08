import type { ConnectorElement, Element, ShapeElement } from '../contracts/generated';

/**
 * R17 containers, read-only. A container is a shape with an explicit, ordered list of direct members; members may be containers in turn,
 * so containers form a forest. Membership is stored, never guessed from geometry. The planner, layout inspection and the router all read
 * containment through these helpers.
 */

export type ContainerShape = ShapeElement & { container: NonNullable<ShapeElement['container']> };

export const isContainer = (el: Element | undefined): el is ContainerShape => el?.kind === 'shape' && el.container !== undefined;

/** member id to the id of the container that lists it. A valid document lists each element at most once. */
export function containerParents(elements: readonly Element[]): Map<string, string> {
  const parents = new Map<string, string>();
  for (const e of elements) if (isContainer(e)) for (const m of e.container.memberIds) parents.set(m, e.id);
  return parents;
}

/** The id of the container that lists `id`, if any. */
export function containerOf(elements: readonly Element[], id: string): string | undefined {
  return containerParents(elements).get(id);
}

/** Enclosing containers, nearest first. */
export function containerAncestors(parents: ReadonlyMap<string, string>, id: string): string[] {
  const out: string[] = [];
  for (let p = parents.get(id); p !== undefined; p = parents.get(p)) {
    if (out.includes(p) || p === id) break; // defensive: a cycle never ends the walk
    out.push(p);
  }
  return out;
}

/** Every member at every depth below a container (members of nested containers included), not the container itself. Document order of discovery. */
export function containerDescendants(byId: ReadonlyMap<string, Element>, rootId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (id: string) => {
    const el = byId.get(id);
    if (!isContainer(el)) return;
    for (const m of el.container.memberIds) if (!seen.has(m) && byId.has(m)) { seen.add(m); out.push(m); walk(m); }
  };
  walk(rootId);
  return out;
}

/** Is `id` inside container `containerId` at any depth? */
export const isInside = (parents: ReadonlyMap<string, string>, id: string, containerId: string): boolean =>
  containerAncestors(parents, id).includes(containerId);

/**
 * Does the container hold an end of this connector, directly or through a nested container? A glued end counts through the element it is
 * glued to (or that element's group, when the group is the member).
 */
export function holdsEnd(parents: ReadonlyMap<string, string>, groupParents: ReadonlyMap<string, string>, connector: ConnectorElement, containerId: string): boolean {
  return [connector.from, connector.to].some(ep => {
    if (!ep.elementId) return false;
    for (let id: string | undefined = ep.elementId; id !== undefined; id = groupParents.get(id)) if (isInside(parents, id, containerId)) return true;
    return false;
  });
}
