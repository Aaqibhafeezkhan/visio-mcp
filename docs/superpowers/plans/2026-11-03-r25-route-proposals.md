# R25 Route Proposals (slice 1) Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MCP agent see exactly what rerouting chosen connectors would do, without changing the document, and then commit that change deliberately through the existing revision-checked `apply_operations` path.

**Architecture:** One new read, `propose_routes` (`doc.proposeRoutes`). Inside one engine queue job it captures a snapshot, selects and validates targets, plans `[{op: "reroute", targets}]` through the same planning path as a transaction (`planPatch` → `settleJoins` → `settleRoutes` → hard-route preflight → `settleAttachments`) and commits nothing. When the proposal is safe it returns that exact operation with the captured revision as `baseRevision`. The planner stays `planRoutes`; there is no second planner and no proposal registry.

**Tech Stack:** TypeScript, Vitest, Playwright, C# MCP SDK, xUnit.

**Spec:** GitHub issue #64 (R25) acceptance criteria 1, 2 and 5. Contract reviewed on #64 before code. Out of scope: R24 Beautify and quality scores, arbitrary-batch preview, strict `moveSegment`, and changing what a raw `reroute` does when geometry is unchanged.

## Contract

**Input:** `documentId` and `sessionId` (envelope), plus optional `pageId` and optional `connectorIds`. No other fields are accepted.
- **`connectorIds`:** 1 to 1000 unique connector UUIDs, all on one page. Empty, duplicate, malformed or unknown IDs fail; they never widen the selection.
- **`pageId`:**
  - If given, it must exist and contain every selected connector.
  - If omitted, the page is the selected connectors' page, or the only page when `connectorIds` is also omitted.
  - A selection spread over several pages fails, and so does a page that can't be determined.
- **Page scope** (`connectorIds` omitted): every eligible connector on the page becomes a target. More than 1000 eligible connectors is `limit_exceeded`, never silently truncated.

**Eligibility:** orthogonal, automatic or guided (no waypoints, not frozen), and editable.
- **Explicit IDs:** an ineligible target fails with the transaction's own error, because it is the same planning code.
- **Page scope:** ineligible connectors are listed in `skipped` with a reason (manual, frozen, not orthogonal, locked, locked layer, locked group).
- Pinned runs, ports and sides, and protected obstacles are kept as `reroute` keeps them.

**Output:**
- `documentId`, `sessionId`, `revision` (captured), resolved `pageId`, `strategy: "reroute"`;
- `routes`: one per target, with `id`, `points` (document points), `provenance`, `reason?`, `geometryChanged`, `lengthPt` and `bends`;
- `skipped`, `routeFindings` and `visuallyAffectedIds` (attached labels included);
- `commit?`, which is `{ baseRevision, operations: [{ op: "reroute", targets }] }`. `targets` is every eligible UUID considered, including unchanged ones, because planning a subset can take different tracks.

**Before and after geometry:**
- **Before:** a target's stored route; for a connector with no stored route, the route the engine treats as drawn (`planRoutes` on the captured page, as `settleRoutes` does).
- **After:** the route the commit would store; if the plan changes nothing, the same as before.
- `geometryChanged` compares points within 0.01 pt. It is not `TransactionResult.noChange`.
- Provenance and reason come from this planning attempt.

**`commit` is offered only when all of these hold:**
- at least one target's geometry changes;
- no target is unresolved;
- no connector outside the targets would change (on any page);
- any projection that joins or attachments need was available, belonged to the planned snapshot, and had the routes they need.

**Refusals:**
- **An outside connector would change:** `dependency_conflict` with `details.connectorIds`.
- **A needed projection is missing, failed, threw, doesn't match the snapshot, or is incomplete:** `projection_failed`.
- **Nothing to commit** (no eligible targets, no geometry change, or an unresolved target): success without `commit`; findings carry the evidence.
- **Stale commit:** applying `commit` after the document moved is the existing `revision_conflict`.

**Purity:** a proposal changes none of the following:
- the store, revision, history, transaction cache, engine status or sequence;
- listeners, the live ID factory, or the live canvas;
- the hidden projector's route memory. Its planner memory is saved and restored around the proposal, so later exports and reads are the same as without the proposal.

**Prerequisite:** `reroute` with explicit targets resolves each target directly and uses the default page only when targets are omitted. Without this, an MCP caller could not commit on a multipage document, because `apply_operations` has no `pageId`. Explicit aliases still need a page scope, and an explicit `pageId` must still exist.

---

### Task 1: Explicit reroute targets need no default page

**Files:** `src/web/src/commands/planPatch.ts`; test `src/web/tests/routeModes.test.ts`.
- [ ] Failing tests on a two-page document:
  - UUID targets without `pageId` succeed;
  - an unknown UUID is `not_found`;
  - an unknown `pageId` is `not_found`;
  - an alias without page scope is `invalid_request`;
  - an omitted-targets reroute without `pageId` still asks for a page;
  - manual, frozen and locked targets are still refused.
- [ ] Resolve explicit targets first; call `defaultPage` only when targets are absent.
- [ ] Run the focused and route suites, then commit.

### Task 2: Shared planning, engine preview and projector isolation

**Files:**
- `src/web/src/commands/CommandEngine.ts`
- `src/web/src/canvas/MaxGraphAdapter.ts`
- `src/web/src/canvas/SnapshotProjector.ts`
- `src/web/src/editor/EditorModel.ts`
- `src/web/src/agentMain.ts`
- test `src/web/tests/routeProposals.test.ts`

- [ ] Move the settle chain out of `runMutation` into one helper that takes the snapshot, operations, page scope, ID factory and route source. `runMutation` keeps doing admit (scope → dedup cache → revision) first, and keeps wrapping failures in script source spans.
- [ ] Add `previewRoutes(scope, job)`. It runs one queue job: scope check, captured snapshot, then the caller's selection, planning and reporting.
  - Planning only accepts `reroute`.
  - It uses an ID factory that refuses, and a checking route source. The source records a projection that is missing, failed, thrown, mismatched or lacking a needed route.
  - It runs inside the projector's `isolate` when one is registered.
- [ ] Add route-memory save and restore on the adapter (planned routes, signature, changes and findings; restoring also forces cells to redraw). `createSnapshotProjector` exposes `isolate`, and the editor and agent hosts pass it to the engine.
- [ ] Tests:
  - the engine state listed under Purity is unchanged after a successful, refused and failed preview;
  - preview runs inside `isolate`;
  - transaction, dedup, revision-conflict and span behaviour is unchanged (existing suites).

### Task 3: `doc.proposeRoutes`

**Files:**
- `src/web/src/bridge/proposeRoutes.ts` (new)
- `src/web/src/bridge/engineHandlers.ts`
- test `src/web/tests/routeProposals.test.ts`

- [ ] Input validation, page resolution, eligibility, report building and the commit decision, per the contract above.
- [ ] Tests:
  - preview points equal the geometry stored after applying `commit` through the `doc.apply` handler (no `pageId`, as `apply_operations` sends it). Cover a detour, a stressed page, pinned runs, joined branches inside the selection with an attached label, legacy connectors with no stored route, and a second page.
  - a joined branch outside the selection is `dependency_conflict`, and so is a legacy connector that settlement would write;
  - each projection failure mode is `projection_failed`, while planner-only pages need no projector;
  - an unresolved target gets no commit;
  - no geometry change and no eligible targets give no commit;
  - a stale commit is `revision_conflict`;
  - the commit is one undoable transaction, and a retry with the same `transactionId` returns the original result;
  - input errors (empty, duplicate, over-limit, malformed, unknown field, mixed or wrong page);
  - two proposals in a row are deterministic, and a proposal queued after a mutation sees it.

### Task 4: MCP tool and host allowlist

**Files:**
- `src/Diagram.Mcp/DiagramTools.cs`
- `src/Diagram.App/LiveControl.cs`
- test `tests/Diagram.Mcp.Tests/ToolTests.cs`

- [ ] `propose_routes` forwards `connectorIds` and `pageId` to `doc.proposeRoutes` with the read deadline. It invents no transaction. It is listed with the other tools, and its description gives units, the read-only behaviour and how to commit.
- [ ] Add `doc.proposeRoutes` to `LiveControl`'s offered methods.

### Task 5: Real projector, documentation and evidence

**Files:**
- `src/web/tests/browser/route-proposals.spec.ts`
- `README.md`
- `docs/m5/R25-route-proposals.md`

- [ ] Browser test on the real hidden projector: a legacy connector next to an attached label. Projection and `get_objects` diagnostics are identical before and after a proposal, and proposal points equal the committed geometry.
- [ ] Short README section; evidence report with commands, results and limits. Windows, WebView2, Visio and owner sign-off are NOT RUN on this host.
