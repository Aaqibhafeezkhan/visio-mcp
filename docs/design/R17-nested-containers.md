# R17 nested containers: design proposal

Status: **approved for implementation** (owner accepted all four recommendations, 2026-10-24)<br>
Issue: [#12 — R17 nested containers](https://github.com/rp2839/visio-mcp/issues/12)<br>
Branch: `claude/r17-nested-containers`<br>
Evidence that motivates it: [R15 Lego comparison](../m5/R15-lego-infrastructure-comparison.md) (four nesting levels drawn as 14 loose rectangles; 29 OVERLAP and 62 CONNECTOR_CROSSES_SHAPE, mostly false), [R09 swim-lane](../m5/R09-swimlane.md) "Not done".

## Summary

A container is an ordinary shape that also has an explicit, ordered list of member elements. Moving the container moves its members, including the members of any containers nested inside it. Resizing it never scales them. A container can optionally grow to keep its members inside. Membership is stored, not guessed from geometry. Engine and MCP edits never change membership as a side effect; only explicit operations do. Layout inspection, the router and the VSDX exporter read the same membership. In Visio it becomes a native container (`User.msvStructureType = "Container"` plus the `Relationships` cell).

## Why not groups

Groups already nest and move as a block, but they are the wrong model here:

| | Group | Container |
|---|---|---|
| Visual | none of its own (derived bounds) | a real shape: outline, fill, heading text |
| Resize | scales every child | changes only the frame; members keep their size and position |
| Selection and editing | a block; children are reached through the group | members stay top-level objects and are selected, edited and connected directly |
| Visio | `Type="Group"`; children scale with the group | native container; members are independent shapes |

The swim-lane component (R09) stays a group in R17. Converting lanes to containers, which Visio's cross-functional lists need, is a later follow-up that can build on this design.

## Canonical contract

`ShapeElement` gains one optional property. Shapes without it behave exactly as they do now. `schemaVersion` stays at 1, following the same optional-field reasoning as R29.

```jsonc
"container": {
  "memberIds": ["<uuid>", ...],          // direct members only, in order; may be empty
  "fit": "none" | "grow" | "fit",        // optional; absent = "none" (decision 1)
  "marginPt": 0..500                      // optional; inner clearance used by grow/fit
}
```

Invariants, validated at every ingress (open, MCP replace, recovery, paste) and by the planner:

1. Members are elements on the same page. Allowed kinds: shape, text, image, group and connector. A member may itself be a container, which gives nesting.
2. **Single direct parent:** an element appears in at most one container's `memberIds`. Containers form an acyclic forest; a container never contains itself, even indirectly.
3. **Group consistency:** a container and its direct members have the same group parent (both top level, or both children of the same group). A group can be a member as a whole; one child of a group cannot be a member on its own. This keeps the group transforms and the container transforms from fighting.
4. Membership is explicit. A member may lie partly or wholly outside its container's bounds. Inspection reports that (see below), but it does not break the document.

Read tools add a derived `containerId` (the direct parent) to each member in `get_objects` and `get_document_summary`. The summary also lists each page's container tree.

## Behaviour

**Move.** Moving a container translates the container and every descendant member by the same delta. For a connector, that means its free ends, waypoints and stored advisory route. Glued ends follow their shapes as usual. A connector whose two glued ends are both inside the moved container (transitively) has its whole stored route translated. It is not replanned, so R19's "keep the valid route" holds and the route keeps its provenance. A connector with one end inside goes through the normal R19/R20 settle: elastic, then repair, with a Frozen route kept and flagged if it cannot follow. Moving a member alone moves only that member, and it stays a member.

**Resize.** Resizing a container changes only its bounds; members are never scaled or moved. This is the main difference from a group, and it matches Visio.

**Fit (settle step).** After a transaction changes a container or any of its descendants, containers with `fit` set are settled from the innermost outwards:
- `grow`: the new bounds are the union of the requested bounds and every member's visual bounds plus `marginPt`. The container expands and never shrinks.
- `fit`: the new bounds are exactly the members' visual bounds plus `marginPt`.
- `none`: the bounds are left as they are.

Settling a nested container can make its parent grow in turn. This runs as part of the same transaction, alongside the join, route and attachment settles. Its changes are in the transaction's `changed` list and undo with it. An explicit resize of a `grow` container to smaller than its contents is therefore pushed back out to fit, as in Visio. To shrink one, set `fit: "none"` first, which can be done in the same transaction.

**Delete.** This follows the existing group rule, so deleting needs an explicit choice. `delete` of a container requires `members: "delete" | "keep"`:
- `delete` removes the whole subtree.
- `keep` removes only the frame. Its members move up into its parent container, or become top level if it had none.

Deleting a member removes it from `memberIds`. An empty container is valid, unlike an empty group.

**Locks.** Moving a container whose subtree includes a locked element is refused, the same as `assertSubtreeEditable` for groups. A locked container's members can still be edited on their own.

**Duplicate, copy and paste.** Duplicating or copying a container includes its subtree, with new ids and the same structure. A duplicated member alone joins its original container. A member pasted on its own arrives at top level, unless the editor pastes it into a container (see the editor section).

**Group and ungroup.** A `group` operation that would separate a container from any of its direct members is refused with `container_split`. Ungrouping keeps all memberships.

**Stacking (R29).** Changing membership does not restack anything. A container created with members (`createShape` with `container.memberIds`, which the editor's "Make container" uses) is stacked just behind the lowest of them on its level, so it stays in front of whatever lay below them, such as a page background or its own container. When no stacking value is free there, the smaller side moves apart to make one. When a container with a non-transparent fill draws above one of its members (by `(level, zIndex)`), inspection reports `CONTAINER_HIDES_MEMBER`.

**Attachments (R13).** An element attached to a connector follows the connector even when it is also a container member. The attachment settle runs after the container translation.

## Operations, MCP and DrawScript

- `createShape.container`: creates a container, optionally with `memberIds`.
- New `contain { container: Target, add?: Target[], remove?: Target[] }`. Adding an element that already belongs to another container moves it, and both containers appear in `changed`. Removing an element that is not a member is refused.
- `set` patch `container: { fit?, marginPt? }` changes the settings. `container: null` disbands the container: the shape stays and its members move up, as with `delete members:"keep"` but keeping the frame. Membership lists change only through `contain`, so there is one way to edit them.
- `move` and `resize` get no new parameters. Their container behaviour follows from the rules above and is described in the MCP tool text.
- DrawScript: `add shape ... container=grow margin=12pt` (`container=none|grow|fit` makes the shape a container), `set <shape> container=fit margin=4pt`, `contain <container> add a b c`, `contain <container> remove d`, `contain <container> disband`, `delete <container> members=keep|delete`.

Error codes: `container_cycle`, `container_split`, `container_member_other_page`, `container_delete_requires_choice`, `members_only_for_containers`, `container_must_be_shape`, `already_contained`, `container_rotation`, `not_a_member`.

## Layout inspection

Intended containment no longer produces warnings. Real defects are still reported.

- No `OVERLAP` between a container and any of its descendants. Members of the same container that overlap each other, and sibling containers that partly overlap, are still reported.
- No `CONNECTOR_CROSSES_SHAPE` for a connector crossing the boundary of a container that holds one of its ends (transitively), or that holds the connector itself. A free end belongs to no element, so for this judgement only it counts as held by a container whose bounds it lies inside. Membership itself never changes. Crossings of containers that hold neither end are reported as they are today, according to the router's policy for that container.
- New `MEMBER_OUTSIDE_CONTAINER` (warning): a member's visual bounds extend past its container's bounds by more than 2 pt. This is the same tolerance as the lane check; imported drawings are rarely exact.
- New `UNLISTED_INSIDE_CONTAINER` (info): an element lies wholly inside a container's bounds but is not a member of it or its descendants. It is reported once, against the smallest such container. Whole units count: top-level elements, groups, and lines free at both ends; a glued connector follows its shapes anyway. This helps an agent convert a flat drawing such as Lego into real containers.
- New `CONTAINER_HIDES_MEMBER` (warning), as above.
- The current geometric heuristic (0.98 containment counts as not a collision) stays for shapes that are not declared containers, so existing documents keep the same reports.

## Routing boundary

This section answers the 2026-10-20 comment on #12. R17 provides one read-only helper module, `layout/containers.ts`, with `containerOf`, `isContainer`, `descendantsOf` and `holdsEnd(connector, container)`. The router and R22 use these; R17 changes no routing policy.

- **Default obstacle behaviour.** Without an explicit `routingPolicy`, a declared container is treated the way the current `selectObstacles` treats a guessed container: connectors pass through it. Level-0 and Lego-style documents therefore route as before. R22 (#61) owns making that a visible policy (forbidden, avoid, pass-through, gateway). R23 (#62) still applies first: a container on a lower level is passed through.
- **Connectors when a container moves or resizes.** See Move above. With both ends inside, the route moves rigidly with the container. With one end inside, the R19/R20 rules apply. A resize moves no member and so no glued end; any resulting crossings go through the normal route settle.

## Editor

- Arrange menu:
  - **Make container from selection** creates a frame around the selection's bounds plus a margin, behind the selection, with `fit: "grow"`.
  - **Add to container** and **Remove from container**.
  - **Disband container**.
- Inspector: a Container section with fit, margin and the member count.
- Dragging a selection moves the container's subtree once. Members whose container is also selected are dropped from the drag set, as for groups.
- **Drag in and out (decision 3):** dropping a top-level object wholly inside a container adds it to the smallest such container. A member dragged completely clear of its container leaves it. A member still touching its container stays, unless it was dropped wholly into a container nested inside that one. Locked containers are left alone. The editor emits explicit `contain` operations in the move's transaction, so one undo reverses both. Engine and MCP edits never do this implicitly. A drop target is not highlighted yet.
- **Dragging a container:** the members join maxGraph's drag preview, so they visibly move with the frame before the drop.

## VSDX export and import

**Feasibility result (Visio 16.0 build 20430, 2026-10-24; reproduce with `tools/probe-visio-containers.ps1`).** Visio treats a plain, master-less shape as a container when it has `User.msvStructureType = "Container"`: `GetContainers` finds it and `AddMember` works. Membership added through Visio's API is written as direct membership. `msvSDContainerResize` 0/1/2 reads back as Visio's resize-as-needed setting 0/1/2, and the margin cell is in inches. The native form is therefore used, and the fallback is not needed.

**Export, as Visio itself writes it:**
- **Container:** user cells `msvStructureType = "Container"`, `msvSDContainerResize` (`none`/`grow`/`fit` → 0/1/2) and `msvSDContainerMargin` in inches. Its `Relationships` cell is `SUM(DEPENDSON(1, <direct member sheets>))`.
- **Member:** its `Relationships` cell is `SUM(DEPENDSON(4, <container sheet>))`. A nested container carries both parts. A member also carries `User.AgentContainer`, which names the editor's container (see below).
- **Visio's reading:** Visio follows the nesting. `GetMemberShapes(0)` and `MemberOfContainers` report every depth, and `GetMemberShapes(16)` reports direct members.

**Visio adds members of its own accord.** On opening the Lego export, Visio also listed:
- shapes resting on a container's edge (a boundary relationship, `DEPENDSON` 7 to 10, beside 4);
- shapes lying mostly inside another container's frame.

So after Visio saves, a shape can be listed by two containers that aren't nested.

**Import:**
- **Shapes and settings:** a shape with `msvStructureType = "Container"` becomes a container, and the resize and margin cells map back to `fit` and `marginPt`.
- **A member's direct container is chosen in this order:**
  1. the container named in `User.AgentContainer`, while Visio still lists the member there;
  2. otherwise, ordinary membership over resting on an edge;
  3. then the innermost claimant (this handles both the direct form and the every-depth form a drag in Visio writes);
  4. then, for containers that aren't nested, the smallest one, with a `container_member_ambiguous` note.
- **Group mismatch:** a member in a different group from its container is skipped, with a note.
- **Visio's stencil containers:** a container from Visio's own stencil is a group of frame and heading parts. It becomes one container frame: the group's box, line and fill, plus the heading text. A `container_master_simplified` note says the stencil's heading style is not kept.

## Acceptance evidence plan

- **Unit:** each invariant and error code; nested move translating every level, including free and advisory connector geometry; resize leaving members untouched; `grow` and `fit` settling innermost first; delete `keep` and `delete`; contain re-parenting; duplicate, copy and paste; group refusal; undo and redo of each as one step; an unchanged legacy document producing identical reports and bytes.
- **Inspection:** a Lego-shaped fixture showing the false OVERLAP and CROSSES warnings gone and real ones kept (overlapping members, a sibling straddle, a member outside its container).
- **Four-level Lego build:** build the four-level Lego containers (public cloud > tenant > component frames) from `artifacts/lego-infra/ops.json` plus `contain` operations; move the outer frame; check every level moves and that routes inside are kept. This ran through the engine the MCP server calls (`tests/legoContainers.test.ts`); a separate real-server run was not made.
- **Visio:** export, open in Visio, confirm the native containers move their members and the nesting reads back. Then a Visio round trip.
- **Manual:** marked NOT RUN until the owner checks the editor and Visio.

## Delivery stages

1. Contract, engine (move, resize, fit, delete, contain, duplicate, group rules), undo, MCP and DrawScript.
2. Inspection and the routing helper.
3. Editor commands, inspector and drag behaviour.
4. VSDX export and import with Visio verification; the feasibility check in that section comes first, so the export design can change before code is written.

## Settled during stage 1

- **Rotation:** rotating a container that has members is refused (`container_rotation`). To turn a container and its contents together, group them and rotate the group. Rotating a container's members one at a time is unchanged.
- **Empty containers:** deleting a container with no members needs no `members` choice.
- **Margin:** an absent `marginPt` means 0. Fit `none` and margin 0 are not stored, so each setting has a single stored form.
- **Where the fit settle runs:** at the end of the planned batch, before the engine's join, route and attachment settles. An element that rides a connector (R13) and is also a container member can therefore leave its container's grow bounds one edit behind. Inspection's `MEMBER_OUTSIDE_CONTAINER` reports this, and the next edit catches up. In the same way, a fit is worked out before connector routes are planned, so a free orthogonal connector that is a member counts with its route before the edit; if the router then moves it, the container can be left short of it until the next edit, and `MEMBER_OUTSIDE_CONTAINER` reports it. A fitted container keeps at least 1 pt of width and height, since members that are only straight lines can span none.
- **Copy and paste:** groups are not copied, so a group inside a copied container is listed in the pasted container by its leaves. Membership is restored by `contain` operations at the end of the paste.
- **Export before stage 4:** a container exports as plain shapes with a `container_not_native` warning, so the membership loss is reported rather than silent.

## Decisions (owner, 2026-10-24)

1. **Default `fit`:** absent, meaning `"none"`, for engine and MCP creation; `"grow"` for the editor's "Make container".
2. **Editor Delete key on a container:** deletes the container with its contents. The engine always requires the explicit `members` choice.
3. **Drag-in and drag-out membership in the editor:** yes, in stage 3, emitted as explicit `contain` operations.
4. **Lego source file:** `C:/Dev/vsdx/Lego Infrastructure - v2.vsdx`. It contains **no** Visio containers: its frames are plain rectangles and its relationship cells are empty. Import of real containers is therefore verified against the Microsoft sample above. The Lego file stays the target for the four-level build and for a Visio export of it with real containers. Neither customer file is copied into the repository.
