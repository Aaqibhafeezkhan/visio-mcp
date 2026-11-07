# R17 nested containers: implementation and evidence

Issue #12. Design: [docs/design/R17-nested-containers.md](../design/R17-nested-containers.md) (approved 2026-10-24). Branch `claude/r17-nested-containers`.

## Stage 1: contract, engine, MCP and DrawScript

**What it delivers:**
- **Contract:** an optional `ShapeElement.container { memberIds, fit?, marginPt? }`. `schemaVersion` stays at 1. Operations gain `createShape.container`, the `contain` operation, the `set` patch `container` (with `null` to disband) and `delete.members`. The TypeScript, C# and validators are regenerated.
- **Engine (`commands/planPatch.ts`, helpers in `layout/containers.ts`):**
  - Moving or arranging a container carries every member at every depth. A connector glued at both ends inside moves whole with its stored route, without being planned again.
  - Resizing a container never touches its members.
  - Containers with `grow` or `fit` settle innermost first, in the same transaction.
  - Deleting a container with members needs `members: delete | keep`.
  - `contain` re-parents an element when adding it, and moves it up a level when removing it.
  - Duplicate and duplicate-page keep the structure. A duplicated member joins its container.
  - Rotating a container with members is refused, as is moving one when anything inside it is locked.
  - The final validation refuses a member on another page, a member of two containers, cycles, and a container in a different group from its members.
- **Ingress:** documents that are opened, replaced or recovered are checked against the same rules.
- **Reads:** `get_document_summary` and `get_objects` add a derived `containerId` to members. The summary shows a container's members and settings.
- **Clipboard:** copying a container copies what is inside it, and paste restores the membership.
- **DrawScript:** `container=` and `margin=` on `add shape` and `set`, the `contain … add|remove|disband` command, and `delete … members=`.
- **MCP:** operation guidance and the operation example.
- **VSDX:** an interim `container_not_native` export warning until stage 4.

**Verification (fresh, on this branch):**
| Check | Result |
|---|---|
| `npx vitest run` (web) | 668/668 pass, including `tests/containers.test.ts` (20) |
| Mutation check: break member carrying, then the fit settle | 6 and 2 container tests fail respectively, then pass again when restored |
| `npx tsc --noEmit`, `npm run generate:check`, `vite build` | pass |
| `npx playwright test` (browser) | 188/188 pass |
| `dotnet test Diagram.Portable.slnx` | 490/490 pass (contracts 50, host 224, IPC 33, MCP 14, Visio 169) |
| Manual editor or Visio check | NOT RUN: there is no editor UI until stage 3, and no native export until stage 4 |

## Stage 2: layout inspection and routing

**What it delivers (`layout/inspectLayout.ts`, `layout/routingPolicy.ts`):**
- **`OVERLAP`:** no longer reported between a container and anything inside it at any depth. Overlapping members and partly overlapping sibling containers are still reported.
- **`CONNECTOR_CROSSES_SHAPE`:** no longer reported for a container that holds the connector, one of its glued ends, or one of its free end points. Lines through unrelated containers are still reported.
- **New findings:**
  - `MEMBER_OUTSIDE_CONTAINER` (warning, more than 2 pt of overhang);
  - `UNLISTED_INSIDE_CONTAINER` (info, against the smallest container; free lines count, glued connectors do not);
  - `CONTAINER_HIDES_MEMBER` (warning, when a filled container is drawn in front of its own member).
- **Routing:** the legacy obstacle guess skips a declared container that has members, so a container whose only member is a text box is passed through as a guessed one is. An explicit `routingPolicy` still decides first. R22 (#61) owns the visible policy.

**Lego acceptance (`tests/legoContainers.test.ts`, on the R15 reproduction in `artifacts/lego-infra/ops.json`):**
- **Method:** the 24 shapes that wholly hold another shape are declared containers. The inspector's own `UNLISTED_INSIDE_CONTAINER` findings fill them; labels that straddle a frame edge go to the frame they mostly sit in.
- **Structure:** 132 members, nested four deep (public cloud > tenant > component > contents). Moving the outermost frame carries 102 elements, including 40 free lines, by exactly the same amount.
- **`CONNECTOR_CROSSES_SHAPE`:** 62 → 28 on the branch (47 → 28 after merging R26; see below). No remaining crossing involves a container that a line starts or ends inside. The 28 left are free polylines through ordinary shapes, which is the R12 free-line limitation, not containment.
- **`OVERLAP`:** 29 → 25, plus 3 `MEMBER_OUTSIDE_CONTAINER`. Most of the 25 are real geometry that containment cannot express. For example, the "AWS to Corona Site VPN" box spans two frames, and an element belongs to one container. Labels also overlap icons. These are reported on purpose.

**Verification (fresh):**
| Check | Result |
|---|---|
| `npx vitest run` (web) | 676/676 pass (`containerInspection.test.ts` 7, `legoContainers.test.ts` 1, `containers.test.ts` 20) |
| Mutation check: disable the overlap skip, the crossing skip, then the router pass-through | 1 inspection test fails for each, then passes again when restored |
| `npx tsc --noEmit` | pass |
| `npx playwright test` | 188/188 pass |
| .NET | not re-run: stage 2 changes no C# |

## Stage 3: editor

**What it delivers:**
- **Commands:** Arrange > Make container, Add to container, Remove from container and Disband container. They come from the shared `arrangeActions`, so the menu, context menu, command palette and Arrange panel all show them.
  - Make container draws a frame round the selection, 12 pt margin, `fit: "grow"`, behind its members. It joins the container they shared, if any, and is selected afterwards.
- **Inspector:** a Container section with fit, margin, member count and Disband. A member shows which container it is inside, with Remove from container.
- **Canvas (`canvas/intents.ts`, `canvas/selection.ts`, `MaxGraphAdapter.ts`):**
  - Dragging, nudging, aligning or deleting a container together with things inside it acts on the container once.
  - The Delete key deletes a container with its contents (decision 2).
  - Group includes a container's contents.
  - Members move with the frame in the live drag preview.
  - Drag-in and drag-out membership (decision 3) joins the move's transaction.
  - The canvas routing signature includes whether a container has members, so routes re-plan when membership changes.
- **Screenshot:** `artifacts/r17-containers/editor-nested-containers.png` (nested containers selected in the editor, with the inspector's Container section).

**Verification (fresh):**
| Check | Result |
|---|---|
| `npx vitest run` | 680/680 pass (`containerEditing.test.ts` 4: outermost targets, drag in/out rules, locked containers, one-step undo) |
| `npx playwright test` | 189/189 pass. `containers.spec.ts` drives the real editor: rubber band, Arrange > Make container, drag the frame (members in the drag preview, one revision, members moved by the same delta), drop a shape in, drag a member out, inspector fit and Disband, undo, Delete |
| Mutation check: disable the drag-preview override | the browser test fails, then passes again when restored |
| `npx tsc --noEmit`, `vite build` | pass |
| Manual check in the editor by the owner | NOT RUN |

**Limits:** no drop-target highlight while dragging. Rotating a container with members is refused, so the angle field reports it.

## Stage 4: Visio export and import

**Feasibility check, before export code:** done in Visio 16.0 build 20430 (`tools/probe-visio-containers.ps1`). A master-less shape with `User.msvStructureType = "Container"` is a native Visio container, so no fallback was needed. Details are in the design note's VSDX section.

**What it delivers:**
- **Exporter (`NativeVsdxExporter.cs`):** container user cells (structure type, resize 0/1/2, margin in inches) and the `Relationships` cell in Visio's own direct form, plus `User.AgentContainer` on members. The stage-1 `container_not_native` warning is gone.
- **Importer (`NativeVsdxImporter.cs`):**
  - containers and their settings;
  - membership in both the direct and every-depth forms;
  - Visio's extra members, resolved in a fixed order: the editor's recorded choice, then ordinary membership over edge, then innermost, then smallest with a note;
  - containers from Visio's own stencil, imported as container frames with their heading text.

**Verification (fresh):**
| Check | Result |
|---|---|
| `ContainerVsdxTests` (6) | Exact XML for nested containers; round trip of members, nesting, fit and margin; the every-depth form; the editor's choice, then innermost, then edge; a tie between containers that aren't nested goes to the smaller, with a note; Microsoft's stencil sample imports as containers nested 3+ deep (uses `C:/Dev/vsdx`; skipped if absent) |
| `ContainerVisioAcceptanceTests` (real Visio) | Visio reports both containers, direct members (`GetMemberShapes(16)`), all depths, resize = grow, margin 12/72 in. After a Visio save and re-import, the members and fit are unchanged |
| `LegoContainerVisioTests` (real Visio) | The four-level Lego export (`artifacts/r17-containers/lego-containers.document.json`): all 24 containers in Visio, and all 132 exported memberships confirmed. Visio added 7 of its own (edge, or mostly inside a frame). After Visio saves, the editor re-imports every exported membership, plus the 1 shape Visio put in a container where the editor had none |
| `dotnet test Diagram.Portable.slnx` | 498/498 pass (Visio tests 177, run against the installed Visio) |
| `npx vitest run`, `generate:check` | 680/680 pass, contract check pass |
| Windows suite (`Diagram.Windows.slnx`) | NOT RUN at stage 4; run after the review fixes (below) |
| Manual in Visio: drag a container and see its members follow | NOT RUN. Hidden automation cannot show it (Visio moves members only interactively). File for the check: `artifacts/r17-containers/lego-containers.vsdx` |

**Limits:**
- Visio's stencil heading styles are not kept.
- Visio may add shapes to containers when it opens a file. The editor keeps its own choice while Visio agrees.
- Members-follow-drag in Visio needs the owner's interactive check.

## Merged with R26 (main at 81a1a80)

R26 (#65) adds its own rule to layout inspection: a frame drawn round a connector's end is crossed on purpose, whether or not it is declared. With both changes:
- the Lego baseline is 47 `CONNECTOR_CROSSES_SHAPE` rather than 62;
- declaring the containers takes it to 28. The free ends and lines that only containment explains are removed; the rest are R12 free polylines through ordinary shapes.

The conflict was resolved in `inspectLayout.ts` (both `pageArea` and the container map are passed to `connectorChecks`) and in `EditorModel.ts` (imports). Fresh after the merge: web vitest 695/695, Playwright 192/192, `dotnet test Diagram.Portable.slnx` 498/498 (Visio tests against the installed Visio).

## Review fixes (PR #93)

The review on PR #93 found these; each fix has a test that fails without it.
- **Dragging a member clear of nested containers** now takes it out of every container it lies clear of, up to the first it still touches. Before, it was handed up to the outer container, which then grew to swallow it when set to grow.
- **A container fitted to a single straight line** keeps at least 1 pt of width and height. Before, it could be committed with zero height, and the document then failed validation.
- **A container created with members** (the editor's Make container, or `createShape` with members) is stacked by the engine just behind its lowest member. Before, the editor sent it, and every container above it, to the back of the page, behind a page background.
- **A Visio file whose containers claim each other in a loop** keeps them nested one way, with a `container_cycle_dropped` note, rather than failing to load.
- **The drag preview** now also carries a connector glued at both ends to what a container carries, as the engine moves it. Covered by a unit test of the carried set; the on-screen preview was not checked by hand.

Recorded as limits rather than changed:
- A fit is worked out before connector routes are planned, so a free orthogonal member that the router then moves can be left outside until the next edit. `MEMBER_OUTSIDE_CONTAINER` reports it. This is in the design note.
- Routing passes through declared containers, but inspection still reports an unrelated connector crossing one. This was noted on #61 for R22 to settle.

| Check | Result |
|---|---|
| `npx vitest run`, `npm run typecheck` | 699/699 pass, typecheck clean |
| `npx playwright test` | 192/192 pass |
| `dotnet test Diagram.Portable.slnx` | 498/498 pass. In a run beside Playwright, the Visio test `GlueFollowsMovesAndGroupsScaleInVisio` failed once; it passed alone, and so did the whole Visio project (178/178) |
| `dotnet test Diagram.Windows.slnx` | Pass: Windows tests 184 passed, 13 skipped; the other projects as above |
| Manual checks in the editor and in Visio | NOT RUN |

## Remaining work

- Owner's manual checks: the editor (stage 3), and Visio dragging a container in `artifacts/r17-containers/lego-containers.vsdx`.
- Follow-up: a drop-target highlight while dragging into a container.
- Follow-up: swim-lanes as containers, which Visio's cross-functional lists need (R09).
