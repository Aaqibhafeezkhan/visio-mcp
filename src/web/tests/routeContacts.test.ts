import { describe, expect, it } from 'vitest';
import { classifyRouteContacts } from '../src/layout/routeContacts';
import type { RouteContactRoute } from '../src/layout/routeContacts';

const route = (connectorId: string, points: readonly { x: number; y: number }[], extra: Partial<RouteContactRoute> = {}): RouteContactRoute => ({
  connectorId, points, mode: 'automatic', joinConnectorIds: [], ...extra,
});
const contacts = (a: RouteContactRoute, b: RouteContactRoute) => classifyRouteContacts([a, b]);
const kinds = (a: RouteContactRoute, b: RouteContactRoute) => contacts(a, b).map(contact => contact.classification);

describe('shared route contact geometry', () => {
  it('detects a perpendicular crossing without depending on line-hop rendering', () => {
    const horizontal = route('h', [{ x: 0, y: 100 }, { x: 300, y: 100 }]);
    const vertical = route('v', [{ x: 150, y: 0 }, { x: 150, y: 200 }]);
    expect(contacts(vertical, horizontal)).toMatchObject([{ connectorIds: ['h', 'v'], segments: [0, 0], classification: 'crossing', point: { x: 150, y: 100 } }]);
  });

  it('classifies collinear overlap and reports shared-end overlap separately', () => {
    const a = route('a', [{ x: 0, y: 10 }, { x: 300, y: 10 }], { fromElementId: 'left', toElementId: 'right' });
    const b = route('b', [{ x: 100, y: 10 }, { x: 400, y: 10 }]);
    expect(contacts(a, b).find(contact => contact.classification === 'collinear_overlap')).toMatchObject({ overlap: { from: 100, to: 300, length: 200 } });
    const shared = route('c', [{ x: 0, y: 10 }, { x: 300, y: 10 }], { fromElementId: 'left' });
    const branch = route('d', [{ x: 0, y: 10 }, { x: 200, y: 10 }], { fromElementId: 'left' });
    expect(kinds(shared, branch)).toContain('collinear_shared_end');
  });

  it('distinguishes a declared T-join from an unjoined endpoint contact', () => {
    const trunk = route('trunk', [{ x: 0, y: 50 }, { x: 300, y: 50 }]);
    const branch = route('branch', [{ x: 150, y: 50 }, { x: 150, y: 200 }], { joinConnectorIds: ['trunk'] });
    expect(contacts(trunk, branch)).toMatchObject([{ classification: 't_join', connectorIds: ['branch', 'trunk'], end: 'from', point: { x: 150, y: 50 } }]);
    expect(kinds(trunk, route('stub', branch.points))).toContain('endpoint_contact');
  });

  it('does not call route-vertex contacts crossings, and respects endpoint tolerance', () => {
    const bent = route('a', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const throughVertex = route('b', [{ x: 100, y: -100 }, { x: 100, y: 100 }]);
    expect(kinds(bent, throughVertex)).not.toContain('crossing');
    const nearEnd = route('c', [{ x: 99.6, y: -50 }, { x: 99.6, y: 50 }]);
    expect(kinds(route('flat', [{ x: 0, y: 0 }, { x: 100, y: 0 }]), nearEnd)).not.toContain('crossing');
  });

  it('keeps the R26 near-miss boundary strict at 4 pt', () => {
    const a = route('a', [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(kinds(a, route('b', [{ x: 0, y: 3.99 }, { x: 100, y: 3.99 }]))).toContain('parallel_near_miss');
    expect(kinds(a, route('c', [{ x: 0, y: 4 }, { x: 100, y: 4 }]))).not.toContain('parallel_near_miss');
  });

  it('does not classify declared joins as accidental contacts and is stable under route and segment input order', () => {
    const a = route('a', [{ x: 0, y: 20 }, { x: 300, y: 20 }]);
    const b = route('b', [{ x: 150, y: 20 }, { x: 150, y: 100 }], { joinConnectorIds: ['a'] });
    expect(contacts(a, b).filter(contact => contact.classification !== 'endpoint_contact').map(contact => contact.classification)).toEqual(['t_join']);
    const x = route('x', [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const y = route('y', [{ x: 50, y: -50 }, { x: 50, y: 50 }, { x: 150, y: 50 }]);
    expect(classifyRouteContacts([x, y])).toEqual(classifyRouteContacts([y, x]));
  });
});
