# R24 aesthetic routing evidence

> Every result above "Integration with main" is **historical**: it was recorded on the feature branch before it was merged with main (including the native Visio and Windows results). Only the last section is fresh evidence for the integrated head.

## Task 2 checkpoint — 2026-10-24

Task 2 implementation and the 60-shape / 60-connector performance blocker are ready for review. The initial page-wide
Beautify attempt took 121 seconds. Profiling by inspection found that grid preprocessing tested every grid node and edge
against every obstacle, then rescanned every earlier route segment and label for each candidate edge. Those scans are
now restricted by sorted coordinate indexes and rectangle-local grid ranges. The ordinary route path is unchanged.

The final deterministic 60/60 run completed all 60 target searches in **6,415 ms** (planner time; 7.68 s total Vitest
process duration). It expanded **2,607,811 states total**, with a maximum of **80,000 expanded states for one search**;
the maximum grid was **58,600 cells**, and maximum estimated peak working memory was **7,602,570 bytes**. The 80,000
state limit is inclusive: a search stops before expanding a state beyond the limit. The test asserts all 60 searches,
the per-search state bound and completion under 30 seconds.

## Verification

- `npm --prefix src/web test -- tests/routeQuality.test.ts tests/routePlanner.test.ts` — **48 passed**. This includes
  exact stress-route snapshot comparison, unrelated-edit route retention, the 100 pt overlap separation, and the
  crossing-free detour regression.
- `npm --prefix src/web test -- tests/routePlanner.test.ts -t "all opt-in searches" --silent=false` — **60/60 passed**;
  2,607,811 total expanded states, max 80,000 per search, 58,600 maximum grid cells, 7,602,570 bytes maximum estimated
  peak memory, 6,415 ms measured planner time (7.68 s total Vitest process duration).
- `npm --prefix src/web run typecheck` — **passed** after the final indexing and tolerance adjustments.
- The ordinary-routing stress fixture matches its committed snapshot byte for byte. The full PSGL/Lego regression suite
  has not been run as part of this Task 2 checkpoint.
- Visio native round-trip verification is not applicable to this checkpoint’s web-only search-preprocessing change and
  remains part of the later final acceptance run.

## Performance implementation notes

- Obstacle rectangles mark only the grid coordinate spans they intersect, preserving the open-interior boundary rules.
- Occupied route segments are sorted by axis coordinate for crossing, overlap and near-track queries. Previous-route
  runs and text-label candidates use the same bounded lookup approach.
- The A* budget check no longer records an artificial 80,001st expanded state.
- No denser-than-60/60 fixture has been measured yet. The 60/60 acceptance test protects elapsed time, expansion limit,
  grid size, and estimated memory for this deterministic workload.

## Task 7 acceptance — 2026-10-26

### Native Visio routing metadata and geometry

- **PASS — round-trip regression:** `StructuralTests.R24RoutingMetadataLossIsReportedAndAutomaticGeometryRoundTrips` verifies the four exported connector points against the VSDX geometry rows, then imports the package and verifies the exact advisory coordinates return on an Automatic connector with no waypoints.
- **PASS — explicit loss diagnostics:** export reports `routingDefaults.crossing`, `routingPolicy.crossing`, `routingPolicy.priority`, `from.requiredSide`, `to.requiredSide`, and `routing.beautified` as `ROUTING_POLICY_NOT_NATIVE` informational diagnostics. The crossing defaults, connector policy, required sides and Beautified marker are absent after import. The route advisory is carried in `AgentAdvisory`, so the next planner pass has the same route geometry while the missing marker permits normal straightening.
- **PASS — normal straightening after marker loss:** the web planner regression `allows normal straightening when Visio import preserves advisory geometry but drops the Beautified marker` confirms that an imported unmarked detour is eligible for the normal 48 pt straightening rule.

### Regression and stress results

- **PASS — R05 pinned reference:** `ReferenceFixtureRegressionTests.SixtyTwoObjectsPreserveSemanticsAndDetectVisibleRegressionsThroughMcpAndNativeVisio` passed. It checked the committed editor/Visio screenshot hashes, 62 object identities and semantics, and native Visio save/reopen through MCP.
- **PASS — PSGL/Lego diagnostic fixtures:** the browser `route-diagnostics.spec.ts` checks the `psgl-swimlane` and `lego-infra` fixture findings and matched the expected R26 codes in the full browser suite (196 passed after Task 6).
- **NOT RUN — owner Lego file:** `C:\Dev\vsdx\Lego Infrastructure - v2.vsdx` is not present, so `LegoJunctionTests` returns without exercising the owner’s drawing.
- **PASS — 60/60 deterministic Beautify searches:** 60 searched; max 80,000 expansions per search; 1,219,378 total expansions; max 47,200 grid cells; max estimated peak memory 6,317,119 bytes; 5,414 ms planner time.
- **PASS — denser 60/90 deterministic workload:** 90 searched; max 80,000 expansions per search; 3,275,703 total expansions; max 71,896 grid cells; max estimated peak memory 8,418,364 bytes; 41,350 ms planner time. Both workloads stay within the 80,000 per-search cap.

### Verification

- `pnpm exec vitest run` — **725 passed** after the marker-loss regression was added.
- `pnpm run typecheck`, `pnpm run generate:check`, and `pnpm run build` — **passed**. Build retains the existing maxgraph `eval` and large-chunk warnings. The full Playwright suite passed **196/196** after Task 6; Task 7 reran the three PSGL/Lego diagnostic tests and all passed.
- `dotnet test Diagram.Portable.slnx --configuration Release` — **490 passed** across contract, IPC, MCP, host, and Visio projects.
- `dotnet test tests/Diagram.Visio.Tests/Diagram.Visio.Tests.csproj --configuration Release --filter FullyQualifiedName~VisioAcceptanceTests` — **4 passed** using Microsoft Visio **16.0 build 20430**; exported files opened without repair and Visio save/reopen preserved the recorded identities and geometry.
- `dotnet test tests/Diagram.Windows.Tests/Diagram.Windows.Tests.csproj --configuration Release --filter FullyQualifiedName~ReferenceFixtureRegressionTests` — **1 passed**.
- The first full Windows solution run reported `FrameTests.ThirtyTwoMiBCap` failing because its process-wide allocation counter observed two allocations from concurrent tests. The test passed alone (1/1). The Windows UI test host then ran without results for about 12 minutes and was interrupted; the full Windows suite is therefore **NOT RUN to completion**.

### Remaining acceptance limits

The owner Lego VSDX file is unavailable here, and the full Windows UI suite did not complete. The targeted R05 and real-Visio checks passed. The broader editor/browser suite passed after Task 6; the final Task 7 web rerun passed 725/725.

## Integration with main 3bb1228 (fresh, Linux)

Feature head 05523b0 merged with origin/main 3bb1228 (R17 containers, H03 validators, H04 menu selection, R25 route proposals, A01 probe corrections) by merge commit cb736e3; feature commits are unchanged. Final candidate: see the build report in the mission slice for the exact SHA.

**Conflicts and how they were resolved.** `CommandEngine.ts`: main moved the join/route/attachment settling into the shared `planOn` (R25), where R24 had it inline. R24's exact-route rule (a Beautify plan stores exact routes, so route settling and the hard-route preflight are skipped) and its required-side findings are now inside `planOn`, so transactions and R25 route proposals still plan through one chain. `planPatch.ts`: container fit settling (R17) runs before the plan is built; Beautify's exact routes are attached after it. `generated.ts` and `validators.generated.js` were regenerated from the schema, not merged by hand; all 35 operations (including Beautify, SetRoutingDefaults, Reroute, MoveSegment, PinSegment and Contain) are in the validator and tag maps and pass the union coverage guard.

**New test:** `beautify.test.ts` - with a fitting container on the page, a Beautify commit changes only the target, leaves the container unchanged, and one undo restores both.

| Check (Linux, Node via npm) | Result |
|---|---|
| `npx vitest run` | 78 files, 787/787 (786 at the merge, plus the new test; `beautify.test.ts` alone 11/11) |
| `npm run typecheck`, `npm run generate:check`, `npm run build` | pass |
| 60/60 Beautify workload (`routePlanner.test.ts`, `-t workload`) | 60 searched, max 80,000 expansions per search, 1,219,378 total, max 47,200 grid cells, max 6,317,119 estimated bytes, 5,228 ms |
| Denser 60/90 workload (same run) | 90 searched, max 80,000 per search, 3,275,703 total, max 71,896 grid cells, max 8,418,364 estimated bytes, 19,925 ms |
| Full browser suite (Playwright, config copy on port 5394) | 200 tests: 199 passed, 1 failed (`segments.spec.ts:54`, see below) |
| `portable-check.sh` (.NET 10.0.403) | Mcp 16/16, Contracts 50/50, Visio 179/179; Host 20 and Ipc 2 failures equal the Linux baseline of 22, no new failures |

The expansion, grid and memory counts equal the historical Windows run exactly, which is expected from a deterministic planner; the elapsed times are this machine's. No threshold was changed.

`segments.spec.ts:54` (the Inspector's numeric run position did not commit on blur) failed once in the full suite and passed 36/36 over six runs of the whole file afterwards. The same test is recorded as intermittent in the R25 evidence; its cause is not established. `arrange.spec.ts:113`, the known Linux failure, passed in this run.

**NOT RUN (fresh):** native Visio and Windows acceptance, `VisioAcceptanceTests`, the owner Lego VSDX drawing, Windows WebView2, a live MCP client. The 196/196 browser and 4/4 Visio 16.0 results above remain historical.

**Locked joined branches (review finding at bc964bf).** Settling a joined end after Beautify moved an unselected locked branch. Ordinary edits behave the same way on main (moving the trunk's shape moves a locked tap's end); that policy is unchanged and not part of this PR. For the new Beautify path, R24's hard rule that locked content stays untouched now holds: the preview skips a connector with a reason (`a locked connector is joined to this one`) when a locked connector is joined to it, directly or through other joined connectors, and `beautify` refuses atomically with `lockedConnectorIds` in the details if a hand-made commit includes one. "Locked" is the planner's rule: the connector, an assigned layer, or a locked group above it. Unlocked branches still follow. Tests in `joins.test.ts` cover the three lock kinds (byte-identical branch, intact join, unchanged document and revision on refusal), a locked branch two joins down, and an unlocked branch following; removing the commit guard, the preview skip, the ancestor rule or the transitive walk each fails them.
