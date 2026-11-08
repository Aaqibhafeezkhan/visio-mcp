import { describe, expect, it } from 'vitest';
import { isAestheticImprovement, scoreRoute } from '../src/layout/routeQuality';
import type { RouteQualityInput } from '../src/layout/routeQuality';
import type { V } from '../src/layout/orthogonalRoute';

const base = (route: V[], extra: Partial<RouteQualityInput> = {}): RouteQualityInput => ({ route, otherRoutes: [], labelRects: [], obstacleRects: [], crossingsPolicy: 'avoid', ...extra });

describe('aesthetic route score (R24)', () => {
  it('charges 1 point per unit of route length and 24 per bend', () => {
    const score = scoreRoute(base([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }]));
    expect(score.terms).toMatchObject({ routeLength: 30, bends: 24 });
    expect(score.qualityPoints).toBe(54);
  });

  it('counts policy crossings lexicographically and lets allow zero the crossing component', () => {
    const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const otherRoutes = [{ connectorId: 'vertical', points: [{ x: 50, y: -20 }, { x: 50, y: 20 }] }];
    expect(scoreRoute(base(route, { otherRoutes })).policyCrossings).toBe(1);
    expect(scoreRoute(base(route, { otherRoutes, crossingsPolicy: 'allow' })).policyCrossings).toBe(0);
  });

  it('scores only contacts between the candidate and other connectors', () => {
    const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const otherRoutes = [
      { connectorId: 'vertical', points: [{ x: 50, y: 20 }, { x: 50, y: 80 }] },
      { connectorId: 'horizontal', points: [{ x: 20, y: 50 }, { x: 80, y: 50 }] },
      { connectorId: 'overlap-a', points: [{ x: 20, y: 100 }, { x: 80, y: 100 }] },
      { connectorId: 'overlap-b', points: [{ x: 30, y: 100 }, { x: 70, y: 100 }] },
    ];
    const score = scoreRoute(base(route, { otherRoutes }));
    expect(score.policyCrossings).toBe(0);
    expect(score.terms.overlap).toBe(0);
  });

  it('charges 20 points per point of collinear overlap', () => {
    const score = scoreRoute(base([{ x: 0, y: 0 }, { x: 100, y: 0 }], { otherRoutes: [{ connectorId: 'other', points: [{ x: 20, y: 0 }, { x: 80, y: 0 }] }] }));
    expect(score.terms.overlap).toBe(1200);
  });

  it('scores near-track deficit against the 6 pt placement target', () => {
    const score = scoreRoute(base([{ x: 0, y: 0 }, { x: 100, y: 0 }], { otherRoutes: [{ connectorId: 'other', points: [{ x: 0, y: 4 }, { x: 100, y: 4 }] }] }));
    expect(score.terms.nearMiss).toBe(400);
  });

  it('charges 500 points for intersecting one measured label rectangle', () => {
    const score = scoreRoute(base([{ x: 0, y: 0 }, { x: 100, y: 0 }], { labelRects: [{ x: 40, y: -5, width: 20, height: 10 }] }));
    expect(score.terms.labels).toBe(500);
  });

  it('scores non-end shape clearance only inside the 8 to 12 pt band', () => {
    const route = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const atTen = scoreRoute(base(route, { obstacleRects: [{ x: 20, y: 10, width: 60, height: 30 }] }));
    const atFour = scoreRoute(base(route, { obstacleRects: [{ x: 20, y: 4, width: 60, height: 30 }] }));
    expect(atTen.terms.clearance).toBe(240);
    expect(atFour.terms.clearance).toBe(0);
  });

  it('charges 20 points per point of a run shorter than 2 pt', () => {
    const score = scoreRoute(base([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 10 }]));
    expect(score.terms.shortRuns).toBe(20);
  });

  it('charges 100 points for a route reversal after a turn', () => {
    const score = scoreRoute(base([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]));
    expect(score.terms.reversals).toBe(100);
  });

  it('measures symmetric changed run length after merging collinear intervals', () => {
    const current = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const candidate = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 10 }];
    const score = scoreRoute(base(candidate, { previous: current }));
    expect(score.terms.deviation).toBe(11);
  });

  it('uses crossing count before quality and requires a 48 point same-crossing improvement', () => {
    const current = { policyCrossings: 1, qualityPoints: 500 };
    expect(isAestheticImprovement({ policyCrossings: 0, qualityPoints: 900 }, current)).toBe(true);
    expect(isAestheticImprovement({ policyCrossings: 2, qualityPoints: 100 }, current)).toBe(false);
    expect(isAestheticImprovement({ policyCrossings: 1, qualityPoints: 452 }, current)).toBe(true);
    expect(isAestheticImprovement({ policyCrossings: 1, qualityPoints: 453 }, current)).toBe(false);
  });
});
