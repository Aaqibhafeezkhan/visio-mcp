# R24 Aesthetic Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan sequentially, one agent on the feature branch. Stop at the review checkpoints below. Subagents may perform read-only reviews of completed tasks, but do not delegate implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic aesthetic route scoring, explicit crossing policy, and a read-only Beautify preview that commits the accepted route set atomically with one undo.

**Architecture:** Reuse R26's merged connector-contact geometry as a shared pure module. Preserve R19's ordinary planner and ordering. Explicit Beautify uses a separate bounded aesthetic profile, including occupied-run grid tracks and lexicographic crossing costs. Preview sends exact proposed route points plus base revision; the engine validates and commits those exact points atomically without a second search or coordinate rounding.

**Tech Stack:** TypeScript, React, JSON Schema, generated TypeScript/C# contracts, Vitest, Playwright, .NET contract and Windows tests.

**Spec:** `docs/design/R24-aesthetic-routing.md`; issue #63.

## Global Constraints

- PR #90 (R26) is merged; the branch must include merge commit `81a1a80ccb6ea9653fc2b06dbf59fe7c56f32e3c` or its descendant before implementation.
- Preserve R19 ordinary routing exactly, including after setting crossing policies: 1 quality point per point of route length, 24 per bend, current shared-run cost, and connector-ID ordering.
- Keep R26 diagnostics unchanged: 4 pt near-miss and shape-clearance threshold, 2 pt short-run threshold, 0.5 pt overlap tolerance, 10 pt alongside minimum. Beautify's target track spacing is 6 pt.
- Only explicit Beautify uses aesthetic costs or priority ordering. Use lexicographic `(policyCrossings, qualityPoints)` inside A* and 80,000 expanded states per target search.
- Hard constraints, Frozen routes, locked elements/layers, static ports, R16 joins and R21 constraints always win; skip infeasible targets and continue. Unprocessed target routes remain occupied; a failed Manual conversion is reverted.
- Send exact proposed route points and base revision in one undoable transaction. Set the engine-owned `routing.beautified: true` marker before route settling, so the transaction's ordinary replan keeps the clear route. Commit validates and applies those points; no route re-search or rounded hash comparison.
- Optional fields preserve existing document serialization and schema version 1; generate TS/C# contracts from JSON Schema.
- Do not modify `IMPLEMENTATION_PROGRESS.md`; GitHub issue #63 is the status/ownership record.

## Review Focus

- PR #90 is merged; preserve its finding codes, evidence and 4 pt diagnostic threshold while extracting shared contact classification.
- A route can overlap its own adjacent search edges at grid nodes; count a geometric contact once using merged intervals and R26's endpoint tolerance.
- A candidate may improve crossing count while worsening path length or deviation; compare the lexicographic score and hysteresis exactly as specified.
- A target can be infeasible while another is routable; retain the failed target's advisory and still apply the feasible subset.
- Preview and commit preserve exact route points. Preview uses canonical measured label rectangles; commit validates submitted paths against the unchanged base revision and hard constraints without rerunning route search.
- The aesthetic A* grid includes occupied-run coordinates ±6 pt only when their segment bounds intersect the legacy search envelope plus one track spacing. Occupied routes must not enlarge that envelope. Record expanded states, grid cells and peak memory on 60/60.
- Crossing costs are lexicographic inside A*, not only in finished-route ranking. A no-crossing detour beats a shorter route with one crossing.
- Track-quality benefits exceed deviation cost: a 100 pt overlapping pair must separate to 6 pt.
- Shape-clearance and short-route scoring thresholds align with R26 at 4 pt and 2 pt.

---

## File map

- Create `src/web/src/layout/routeContacts.ts`: shared pure connector-contact classification extracted from R26.
- Modify `src/web/src/layout/inspectRoutes.ts`: adapt shared contacts to existing stable diagnostics and evidence.
- Create `src/web/src/layout/routeQuality.ts`: the R24 score types, constants, deterministic metrics and score function.
- Modify `src/web/src/layout/obstacleRoute.ts` and `routePlanner.ts`: opt-in search costs, target-only Beautify planning, and persistent marked-route retention; leave ordinary planning unchanged.
- Modify `contracts/document.schema.json` and `contracts/protocol.schema.json`: add the engine-owned `routing.beautified: true` field and the `beautified` route provenance enum; regenerate TS/C# DTOs. Task 3 adds the remaining policy and operation schemas.
- Modify `contracts/operations.schema.json`: optional document/connector crossing policy, routing priority, required side and Beautify operations.
- Modify `src/web/src/commands/planPatch.ts`, `CommandEngine.ts`, and `commands/routes.ts`: validate policy and required-side requests, carry exact proposed routes and base revision in an atomic Beautify plan, set the engine-owned marker before route settling, validate without replanning, and bypass broad hard-route preflight only for skipped targets with no mutation.
- Create `src/web/src/editor/beautifyPreview.ts` and `src/web/src/components/BeautifyDialog.tsx`; modify `EditorModel.ts`, `components/PageCanvas.tsx`, and `editor/appCommands.ts` for preview overlay, stale state, accept/cancel and menu entry.
- Modify `src/Diagram.Mcp/OperationCatalog.cs` and `src/Diagram.Mcp/DiagramTools.cs` in Task 5. Describe exact proposed routes for eligible Automatic connectors without conversion to Manual, and state that the engine persists the Beautified marker.

- Add focused tests beside route planner, operations, editor and browser behavior; update `docs/m5/R24-aesthetic-routing.md` with exact results and remaining limits.

### Task 1: Extract shared R26 connector-contact classifier

**Files:**
- Create: `src/web/src/layout/routeContacts.ts`
- Modify: `src/web/src/layout/inspectRoutes.ts`
- Test: `src/web/tests/inspectRoutes.test.ts`
- Test: `src/web/tests/routeContacts.test.ts`

**Interfaces:**
- Consumes: routes `{ connectorId: string; points: readonly Point[]; mode: RouteMode; joinConnectorIds: readonly string[] }[]`.
- Produces: `classifyRouteContacts(routes): RouteContact[]`; each contact has sorted connector IDs, both segment indices, `classification`, and a point, overlap interval or gap as appropriate. R26 maps these values to its existing finding codes/evidence.

- [ ] Add `routeContacts.test.ts` cases for perpendicular crossings regardless of hop rendering, collinear overlap, T-join, endpoint contact, shared-end overlap, near miss at 3.99 pt, not-near-miss at 4 pt, endpoint tolerance, declared R16 joins, and adjacent segments that touch only at a route vertex; verify stable output under input order reversal. Test the separate 6 pt Beautify track target in Task 2.
- [ ] Run `npm --prefix src/web test -- tests/routeContacts.test.ts` and confirm the new classifier tests fail before the module exists.
- [ ] Move only pure segment/contact geometry from R26 `inspectRoutes.ts` to `routeContacts.ts`; retain `NEAR_PT=4`, `OVERLAP_PT=0.5`, `ALONGSIDE_PT=10`, and `SHORT_PT=2`. Export `TRACK_SPACING_PT=6` as a planner target, separate from diagnostic thresholds.
- [ ] Adapt `inspectRoutes` to map returned contacts to unchanged R26 codes, thresholds and evidence; preserve the R26 expected fixture byte-for-byte.
- [ ] Run `npm --prefix src/web test -- tests/routeContacts.test.ts tests/inspectRoutes.test.ts tests/routePlanner.test.ts` and `npm --prefix src/web run typecheck`; expect all focused tests and typecheck to pass.
- [ ] Commit `refactor: share route contact classification`.

### Task 2: Add deterministic opt-in route quality scoring

**Files:**
- Create: `src/web/src/layout/routeQuality.ts`
- Modify: `src/web/src/layout/obstacleRoute.ts`
- Modify: `src/web/src/layout/routePlanner.ts`
- Test: `src/web/tests/routeQuality.test.ts`
- Test: `src/web/tests/routePlanner.test.ts`
- Test: `src/web/tests/inspectRoutes.test.ts` for visible provenance

**Interfaces:**
- Consumes: `RouteQualityInput { route, previous?, otherRoutes, labelRects, obstacleRects, crossingsPolicy }`.
- Produces: `scoreRoute(input): { policyCrossings: number; qualityPoints: number }`; `planRoutes` gains optional `beautifyTargets?: ReadonlySet<string>` and `costProfile?: 'legacy' | 'aesthetic'`. No arguments means the exact current R19 behavior.

- [ ] Test each fixed score term: route length, bend, crossing, overlap, near-miss deficit, label intersection, clearance deficit in the 8–12 pt band, short-run deficit and reversal; assert weights and units from the spec.
- [ ] Test symmetric route deviation with collinear-interval merging, its 0.1-points/pt weight, 48-point hysteresis boundary, and lexicographic policy-crossing comparison.
- [ ] Test shape-clearance scoring for routes with 8–12 pt clearance; keep the diagnostic threshold at 4 pt and document why the aesthetic cost uses a wider band.
- [ ] Add the two-connector 100 pt overlapping-run regression: Beautify must separate them by 6 pt. Fail if deviation/hysteresis prevents the move.
- [ ] Add an A* regression proving a long route with no crossing beats a shorter route with one crossing.
- [ ] Add a contract test for the engine-owned `routing.beautified: true` marker and regenerated `beautified` route-provenance DTOs.
- [ ] Run `npm --prefix src/web test -- tests/routeQuality.test.ts` and confirm failure.
- [ ] Implement pure `scoreRoute`, lexicographic A* cost `(policyCrossings, qualityPoints)`, deterministic completed-path costs, and priority/difficulty/span/ID ordering for Beautify. Reuse measured text bounds for all visible text/connector labels.
- [ ] Make `storedRoute` return `beautified` provenance for marked routes. Let ordinary planning keep a marked route whenever it is clear, bypassing only the 48 pt straightening rule; allow normal elastic/repair/reroute behavior when endpoints move or obstacles block it, preserving the marker.
- [ ] Add aesthetic-only x/y grid lines at each occupied route run coordinate ±6 pt only when that segment intersects the original search envelope expanded by 6 pt; never expand that envelope from occupied routes. Keep the current grid and cost arithmetic unchanged for ordinary routing. Record expanded states, grid cells and peak memory for 60/60 and denser fixtures; do not exceed 80,000 per search.
- [ ] Charge a crossing on the search edge containing its point or at that edge's far endpoint, never at its starting endpoint. This half-open edge rule counts each crossing once without path history. Ensure a no-crossing detour always beats a crossing route; `allow` leaves the crossing component at zero.
- [ ] Test that marked-route provenance appears in `inspect_layout` findings.
- [ ] Add planner tests proving PSGL/Lego/R05 routes and change IDs remain unchanged with absent and configured policies across ordinary edits; only explicit Beautify uses policy/priority. Verify 6 pt tracks, long crossing-free detour, 100 pt overlap case, stable 80,000-state skips, and that a clear stored route marked `beautified` survives ordinary planning despite the 48 pt straighten rule.
- [ ] Add a transaction regression that starts with an Automatic connector carrying the engine marker, moves an unrelated shape, and verifies the route points and marker remain unchanged. Verify a blocked marked route can still be repaired without clearing the marker.
- [ ] Run `npm --prefix src/web test -- tests/routeQuality.test.ts tests/routePlanner.test.ts tests/routeModes.test.ts` and `npm --prefix src/web run typecheck`; expect all pass.
- [ ] Commit `feat: score aesthetic connector routes`.
- [ ] **Review checkpoint 1:** stop for user review. Report byte-identical ordinary baselines, overlap and crossing-free detour tests, marked-route retention after an unrelated edit, and 60/60 expanded-state/grid-size/peak-memory results.

### Task 3: Add optional routing policy and required-side contracts

**Files:**
- Modify: `contracts/document.schema.json`
- Modify: `contracts/operations.schema.json`
- Modify: `contracts/protocol.schema.json`
- Generate: `src/web/src/contracts/generated.ts`, `src/Diagram.Core.Contracts/Generated/Contracts.g.cs`
- Modify: `src/web/src/commands/planPatch.ts`
- Modify: `src/web/src/commands/CommandEngine.ts`
- Test: `src/web/tests/contracts.test.ts`
- Test: `src/web/tests/routePlanner.test.ts`
- Test: `src/web/tests/inspectRoutes.test.ts` for visible provenance

**Interfaces:**
- Consumes: `routingDefaults.crossing?: 'avoid'|'allow'`, connector `routingPolicy.crossing?: 'avoid'|'allow'`, `routingPolicy.priority?: -100..100`, endpoint `requiredSide?: north|east|south|west`.
- Produces: `setRoutingDefaults` and `beautify` operation DTOs. Static ports on a contradictory required side fail `invalid_request` with `details.reason='routing_side_conflict'`, connector ID and endpoint. An unreachable required side returns `ROUTE_REQUIRED_SIDE_UNRESOLVED`.

- [x] Add contract tests for valid defaults, overrides, priorities at -100/100, rejected out-of-range values, required sides, invalid static-port conflicts, and rejection of connector-only policy fields on shapes/text.
- [x] Run focused schema/operation tests and confirm the new fields/operations are rejected before schema edits.
- [x] Split shared element `RoutingPolicy` from connector-only `ConnectorRoutingPolicy`; extend document/connector/endpoint schemas and add `ROUTE_REQUIRED_SIDE_UNRESOLVED` to `contracts/protocol.schema.json`. Add `setRoutingDefaults` and `beautify` operation schemas with base revision and explicit proposed route points; regenerate TS/C# contracts using `npm --prefix src/web run generate`.
- [x] Implement `setRoutingDefaults` as one document diff. It affects future explicit Beautify calls only; prove an unrelated ordinary edit changes only its edited connector. Validate `requiredSide` against fixed ports during operation planning and apply hard-route preflight to explicit constraints.
- [ ] Add UI-accessible connector fields in Task 6; do not change line style/colour semantics.
- [x] Run focused contract, transaction, route-planner and MCP inspection tests (128 passed), `npm --prefix src/web run generate:check`, and `npm --prefix src/web run typecheck`; all pass.
- [ ] Commit `feat: add connector crossing policies and priority`.

### Task 4: Implement exact, read-only Beautify planning

**Files:**
- Create: `src/web/src/editor/beautifyPreview.ts`
- Modify: `src/web/src/layout/routePlanner.ts`
- Test: `src/web/tests/beautifyPreview.test.ts`

**Interfaces:**
- Produces: `buildBeautifyPreview(document, pageId, targetIds, options): Promise<BeautifyPreview>` with `baseRevision`, sorted `targets`, exact `proposedRoutes`, `skipped`, and `changedCount`. Preview passes the canonical measured label rectangles to the planner.

- [x] Test preview route count and exact proposed points, deterministic ordering, selected-only versus page materialization, Manual/Frozen/locked skips, shared label measurements, and no document/advisory mutation.
- [x] Test that one infeasible or budget-exhausted connector is skipped while a feasible target still receives a proposed route.
- [x] Run `npm --prefix src/web test -- tests/beautifyPreview.test.ts` and confirm failure.
- [x] Implement the preview using one document snapshot and the Task 2 planner profile; skip unchanged/unfeasible targets and retain their exact current route/advisory.
- [x] Test exact proposal serialization and deterministic target ordering; no coordinate rounding is used in the preview-to-commit path.
- [x] Run the focused suite and typecheck; expect all pass.
- [x] Commit `feat: plan revision-bound beautification previews`.

### Task 5: Commit Beautify atomically and add editor preview

**Files:**
- Modify: `src/web/src/commands/planPatch.ts`
- Modify: `src/web/src/commands/CommandEngine.ts`
- Modify: `src/web/src/editor/EditorModel.ts`
- Create: `src/web/src/components/BeautifyDialog.tsx`
- Modify: `src/web/src/components/PageCanvas.tsx`
- Modify: `src/web/src/editor/appCommands.ts`
- Modify: `src/Diagram.Mcp/OperationCatalog.cs` and `src/Diagram.Mcp/DiagramTools.cs`

- Test: `src/web/tests/beautify.test.ts`
- Test: label-sensitive preview and exact transaction commit
- Test: `src/web/tests/browser/beautify.spec.ts`

**Interfaces:**
- Consumes: the exact Task 4 preview and `beautify` operation with its base revision and exact proposed route points.
- Produces: one `TransactionResult` whose `changed`/`routeChanges` list contains only committed target IDs; the existing transaction stack provides exact undo/redo.

- [x] Add engine tests for stale revision rejection, invalid proposed-route rejection, exact preview-to-commit point equality including a nearby measured label, target-only commit, one undo/redo, explicit Manual-to-Automatic conversion, and Frozen/locked skips.
- [x] Add a transaction test with one newly infeasible target and one feasible target; assert the infeasible route is untouched, the feasible one commits, and broad R22 preflight does not reject the batch.
- [x] Run `npm --prefix src/web test -- tests/beautify.test.ts` and confirm failure.
- [x] Implement `beautify` apply so base revision and all proposed paths are validated before any diff; apply supplied points directly; add upserts only for changed eligible routes and avoid unresolved updates for skipped targets.
- [x] Add `Preview Beautify` in Arrange menu and selected/page dialog; draw exact candidate paths, changed count and skip reasons; disable acceptance on stale snapshot and close without mutation on cancel.

- [x] Update MCP descriptions to explain that callers may set exact proposed points on eligible Automatic connectors without converting them to Manual; the transaction sets the engine-owned marker.
- [x] Add Playwright coverage for no-side-effect preview, page/selection scope, exact preview overlay, stale revision, accepted undo, skipped Manual recovery and continuing past infeasible targets.
- [x] Run `npm --prefix src/web test -- tests/beautify.test.ts tests/beautifyPreview.test.ts` and `npm --prefix src/web run test:browser -- tests/browser/beautify.spec.ts`; expect all pass.
- [x] Commit `feat: add previewed beautify command`.
- [x] **Review checkpoint 2:** stop for user review after the full Beautify flow passes end-to-end, including exact proposal commit and persistent marker behavior.

### Task 6: Add routing policy controls

**Files:**
- Modify: `src/web/src/components/Inspector.tsx`
- Modify: `src/web/src/components/Toolbar.tsx` or the document settings dialog
- Modify: `src/web/src/editor/appCommands.ts`

- Test: policy controls and ordinary-edit compatibility

- [ ] Add controls for document/connector crossing policy, priority and endpoint required side. Route all edits through the existing transaction path.
- [ ] Prove that setting a policy followed by an unrelated ordinary edit preserves every other route.

- [ ] Commit `feat: expose routing policy controls`.

### Task 7: Verify regressions, documentation and platform contracts

**Files:**
- Modify: `docs/m5/R24-aesthetic-routing.md`
- Test: route, inspect, browser, transaction, contract and fixture suites above
- No tracker-file edits.

**Interfaces:**
- Produces: reproducible R24 acceptance evidence and a clear list of `PASS`, `FAIL`, or `NOT RUN` for real Visio and dense fixtures.

- [x] Compare ordinary-routing PSGL, Lego, R05 baselines and R26 expected diagnostics against the merged #90 baseline; no diagnostic threshold changes are expected.
- [x] Run `npm --prefix src/web test`, `npm --prefix src/web run typecheck`, `npm --prefix src/web run generate:check`, and `npm --prefix src/web run build`.
- [x] Run `dotnet test Diagram.Portable.slnx --configuration Release`; run `dotnet test Diagram.Windows.slnx --configuration Release` and real Visio acceptance separately when available.
- [x] Run the 60/60 and denser deterministic routing fixtures, record expanded-state counts, route changes, and preview wall-clock measurements; verify no route exceeds 80,000 expanded states.
- [x] Run native Visio import/export round-trip coverage with non-default crossing policy, priority, requiredSide and beautified marker. Confirm route geometry survives, identify the dropped metadata, and document that loss of the marker restores normal straightening behavior after import.
- [x] Record implementation commits, test totals, Visio round-trip behavior, manual Visio status and remaining dynamic-anchor/fan-out limits in `docs/m5/R24-aesthetic-routing.md` and issue #63.

- [x] Run full web and portable .NET suites again if any preceding edit changes code; commit `test: record R24 aesthetic routing evidence`.
- [x] **Review checkpoint 3:** stop for final user review after the complete regression suite, Visio round-trip, and evidence commit.

## Self-review

- Every R24 issue scope item is covered by score terms, policies, shared contact analysis, preview or an explicit limit (dynamic glue-anchor symmetry and named-port creation).
- R26 stays the source of contact semantics and thresholds; its public finding codes and fixtures remain stable.
- Ordinary route planning and target ordering remain unchanged for every policy configuration; only explicit Beautify uses aesthetic scoring and priority ordering.
- Preview routes are committed exactly against their base revision; R22's broad preflight cannot turn one skipped target into a failed multi-target Beautify.
- Native Visio preserves route geometry while dropping unsupported R24 policy metadata and the beautified marker, as verified by round-trip tests.
- PR #90 is merged and is present in the feature branch before implementation begins.
