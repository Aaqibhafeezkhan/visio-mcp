# R25 route proposals (slice 1)

Issue #64. Builds on R19 #58 (planner, provenance), R20 #59 (stored routes, `reroute`), R21 #60 (pinned runs), R22 #61 (policy) and R26 #65 (findings). Plan: [`docs/superpowers/plans/2026-11-03-r25-route-proposals.md`](../superpowers/plans/2026-11-03-r25-route-proposals.md).

An MCP agent can now ask what rerouting connectors would do without changing the document, and then commit exactly that through `apply_operations` against the revision it read. This slice covers acceptance criteria 1 (except R24's quality score), 2 and 5. The rest of R25 stays open.

## `propose_routes`

Pass `connectorIds` (1 to 1000 connector UUIDs on one page), or `pageId` alone to consider every connector on the page. The result:

| Field | Meaning |
|---|---|
| `revision`, `pageId` | The revision the proposal was planned on, and the page. |
| `routes[]` | For each target: `points` (page points, both ends included), `provenance` and `reason` from this planning attempt, `geometryChanged`, `lengthPt` and `bends`. |
| `skipped[]` | Page scope only: connectors left out, with the reason (not orthogonal, manual, frozen, locked, on a locked layer, in a locked group). |
| `routeFindings`, `visuallyAffectedIds` | Planner findings such as `UNRESOLVED_ROUTE`, and everything the commit would redraw, including attached labels. |
| `commit` | `{ baseRevision, operations: [{ op: "reroute", targets }] }`. Present only when the drawing would change, no target is unresolved and nothing outside the targets would change. |

Apply `commit.operations` unchanged with `apply_operations` at `commit.baseRevision` and a new `transactionId`. If the document has moved on, the commit fails with `revision_conflict`. `targets` lists every target, including unchanged ones, because planning a subset can take different tracks.

**Refusals:**
- **`dependency_conflict`** with `details.connectorIds`: the commit would change a connector outside the targets. Examples: a branch joined to a target, or a connector with no stored route that settling would give one. Include those connectors in the selection.
- **`dependency_conflict`** with `details.reason: "join_not_followed"`: a connector joined to a target would be left off the target's new route. No choice of targets fixes this (see Limits).
- **`projection_failed`:** a projection the answer depends on is missing, failed, threw, belongs to another revision, or lacks a needed route. That means joins, attachments, or the current drawing of a connector with no stored route.
- **Explicit targets** that `reroute` itself refuses (manual, frozen, locked, not orthogonal) give the same error `reroute` gives.

`geometryChanged` compares points within 0.01 pt. It is not a transaction's `noChange`: a raw `reroute` still records an explicit replan even when the points don't change, as before.

## How it works

- **Same planning path as a transaction.** `CommandEngine.previewRoutes` runs one queue job: scope check, captured snapshot, then selection, planning and reporting. Planning reuses the transaction path (`planPatch` → `settleJoins` → `settleRoutes` → hard-route preflight → `settleAttachments`, now the shared `planOn` helper) and commits nothing. It doesn't touch the store, revision, history, transaction cache, status, listeners or the live ID factory.
- **Current geometry.** A stored route is what every surface draws. A connector with no stored route (an older document) is drawn from the hidden projector's memory, so its current geometry is read from the projection of the captured snapshot, before planning projects anything else.
- **Projector isolation.** The hidden projector (`MaxGraphAdapter`) remembers the routes it drew last. A proposal projects documents that are never committed, so `SnapshotProjector.isolate` saves that memory and restores it afterwards. Without that, a proposal's routes would show up in the next export of the unchanged document (the unit test's control case shows this).
- **Prerequisite.** `reroute` with explicit targets resolves each target on its own page and asks for a page only when targets are omitted. Before this, a reroute through `apply_operations` failed on any multipage document, because that tool has no page scope.

## Verification

All runs on Linux with Node 24.18.0 and .NET 10.0.403, from the worktree at the commits named. The browser tests ran in headless Chromium through Playwright, on the same config with another port.

| Test | What it shows |
|---|---|
| `src/web/tests/routeModes.test.ts` (one new) | Reroute with UUID targets on a two-page document needs no page. Unknown UUID and unknown page give `not_found`; an alias without page scope, and an untargeted reroute without a page, are still refused; frozen and locked targets are still refused. |
| `src/web/tests/routeProposals.test.ts` (19) | Committed state, history, cache, status, events and live ids are unchanged after successful, refused and failed proposals. Proposed points equal the stored route after applying `commit` through the bridge without a page scope: a detour, page scope with unchanged targets, joined branches included, a second page, a page mixing stored and unstored routes, and the Lego fixture page. Also: stale commit (`revision_conflict`), one undo, retry deduplication, both `dependency_conflict` cases, `join_not_followed`, the five projection failure modes, planner-only pages without a projector, unresolved targets and pinned runs (evidence, no commit), unchanged geometry (no commit), current geometry of unstored routes from the projection, isolation with a control, input refusals, mixed and wrong pages, ordering behind a mutation, determinism. |
| `src/web/tests/browser/route-proposals.spec.ts` (2) | On the real hidden projector: a page-scope proposal over a connector with no stored route next to an attached label leaves the projection and `get_objects` diagnostics unchanged, and the committed drawing equals the proposed points. A joined trunk is refused rather than offered a commit that detaches the branch. |
| `tests/Diagram.Mcp.Tests/ToolTests.cs` (two new, list updated) | `propose_routes` forwards `connectorIds` and `pageId` as a read without a transaction; a malformed `pageId` is refused before sending; `apply_operations` sends no page scope. |

Results are in the "Recorded results" section below.

## Limits

- **Quality terms are interim:** length and bends only. R24's route-quality score and Beautify proposals are a later slice.
- **Only reroute is previewed.** Previewing arbitrary batches, a strict `moveSegment` ("move one run, change nothing else"), and acceptance criteria 3, 4, 6 and 7 are later slices.
- **A joined trunk can't be rerouted with its branch attached.** Joins are settled before routes are stored. During a reroute the hidden projector still draws the trunk's old route, so the branch end stays where the old route was until the next edit. Observed on the real projector: a raw `reroute` straightens the trunk to y 130 and leaves the branch end at y 146.5; the next unrelated edit moves it to 130. This is existing behaviour, matching the R16 #11 acceptance that joins stay attached. `propose_routes` refuses it with `join_not_followed` rather than offering such a commit.
- **Current geometry of unstored routes** depends on the hidden projector's memory, which is per session. A proposal reports what this session draws.
- **Older documents with unstored routes on several pages.** Any transaction gives every unstored automatic connector a stored route, on every page. A proposal on one page then reports `dependency_conflict` for connectors on the other pages, and including them isn't possible because a selection stays on one page. Any ordinary edit on such a document stores those routes, after which proposals work as usual.
- **NOT RUN:** Windows, WebView2, a live MCP client, Visio and Word, and a person's review of the tool on screen.

## Recorded results

- **Web unit** (`src/web`, tree of 63ec08e): `npx vitest run` gave 69 files, 683/683 (main 663, plus 1 for the prerequisite, plus 19). `npm run typecheck`, `npm run generate:check` and `npm run build` exit 0.
- **.NET** (8c3abe8, locked restore): `dotnet test tests/Diagram.Mcp.Tests` 16/16 (main 14, plus 2); `dotnet test tests/Diagram.Contracts.Tests` 50/50. The rest of the portable solution was not changed by this slice. On Linux it has 22 known failures on main (Host 20, Ipc 2) that assert Windows behaviour.
- **Browser** (8c3abe8 plus `route-proposals.spec.ts`, full suite): 193 tests, 191 passed, 2 failed.
  - `arrange.spec.ts:113` (z-order from the context menu) also fails on main. Opening the context menu clears the selection; this is diagnosed separately and not touched here.
  - `segments.spec.ts:54` failed once (the Inspector's numeric run position did not commit on blur). It passed 5/5 when rerun alone, and in a separate full run at 8c3abe8. Treated as intermittent; the cause is not established.
  - `route-proposals.spec.ts` 2/2.
