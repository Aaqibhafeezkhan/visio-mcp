# Definition of done (spec section 27) against evidence

Recorded 2026-10-18. Each criterion names the evidence that was actually produced, then says what it does **not** show.
"Evidenced" means a test or recorded run observed it on this machine (Windows 11, Visio 16.0 build 20430, Word, WebView2 155). It does not mean a person
sat at the application: where a criterion says "manual" or "usable" in the spec, the caveat column says how far the evidence goes.

## Live acceptance policy

Owner decision, 2026-11-20: the project's manual functional checks may be conducted by an agent on the live system. This applies from that date to every place the project asks for a manual test or for a person to perform one: this document, the [Visio and Word checklist](visio-word-checklist.md), the specification's "manual" acceptance wording, work packages and issues such as A02 ([#15](https://github.com/rp2839/visio-mcp/issues/15)), and acceptance records. A person is not required for functional checks: a basic functional check needs access to a Windows desktop (for example over remote desktop) and a visual assessment of the result, and an agent can do both. It changes who may perform a check, not what any earlier statement said: dated results and the wording of earlier documents stay as written. A person decides where the answer is a subjective aesthetic judgment (for example whether a layout or visual style is acceptable); an agent can assess basic outcomes. When a person makes such a judgment, record who decided, when, and what they were shown.

- **What counts as a live check.** An operator, a person or an agent, uses the running application, Visio or Word on the identified build and visually assesses the result on that system: looking at the screen, directly or through captures taken during the check. How the state was produced does not matter. Mouse and keyboard input, a command, a tool, a script or an API or COM call all qualify, including when the same command or call produced the state that was then inspected. What makes the check live is that the operator actually looked at the result and judged it.
- **What stays supporting automation.** Results nobody visually assessed: automated assertions, API, COM or object-model output read only as data, and unattended or deterministic runs (prerecorded or replayed UI test suites, generated screenshots) judged by their own assertions. They support a result but are not described as a visual assessment.
- **PASS** means the operator performed the check on the identified build and observed the stated outcome. If part of the outcome was not observed (for example a mode with no visible indicator), say what was inferred and from what, and do not claim more than was seen.
- **Record, for every result:** the operator (a named person, or the agent and seat), the method (what was done and how the result was observed), what was and was not observed, the environment (Windows, Visio, Word, .NET and display), the build (exact commit or version; write "unknown" rather than assume the latest commit), and a link to evidence appropriate to the check. A result whose build is unknown keeps that limit and cannot support a current-build PASS.
- **A Visio repair prompt** seen when a live run opens an export fails that live step, which requires none. Record the prompt's exact text. It is a new, dated live result: the dated WA-02 automation result (Visio opened with alerts suppressed) keeps its recorded outcome and method.
- **Provenance is kept.** Agent evidence is never relabelled as a person's, or the reverse. Past results keep the operator they actually had: the earlier M0 G1 checks stay human checks and the I52 Office runs stay automated. No earlier automated or partial result becomes a pass under this policy; items 18 and 19 below stay open until a current-build run is recorded under it.

Original I52 suite record: web unit 289, browser 43, Contracts 24, Host 119, Ipc 17, Mcp 13, Visio 124, Windows 33 (run one at a time). All pass in that record.
The later pull and fresh MCP sign-off run are recorded below and in [verification-summary.json](evidence/I52/mcp-signoff/verification-summary.json).
The §23 demonstration is [evidence/DEMO](evidence/DEMO) (49 checks in `tools/demo/verify-demo.mjs`, all pass); timings are in [performance.md](performance.md).

| # | Criterion | Status | Evidence | What it does not show |
|---|---|---|---|---|
| 1 | Windows desktop application starts and shows a usable page-oriented editor | Evidenced, with caveat | `BridgeTests.AppStartsReadyWithA4Snapshot`, `EditorRendersAnAppliedChangeInTheRealShell` (screenshot in `docs/m1/evidence`); every Windows test starts the real shell; demo step 1 and 3 (`step03-editor.png`) | Usability was judged by scripted use and screenshots, not by a person working in the window |
| 2 | Add, edit and delete shapes, text, connectors and PNG/JPG/BMP/SVG images | Evidenced | `editor.spec.ts`: manual_edit_without_llm, real double-click text editing/duplicate, "group, drag, ungroup and delete", "each picture format becomes an independent image object with its own hash"; vitest transactions | |
| 3 | Move, resize, rotate, multi-select, align/distribute, z-order, undo/redo | Evidenced | `arrange.spec.ts` (align, distribute, gap, z order, refusal with too few objects), `editor.spec.ts`, `arrange.test.ts`, `history.test.ts` (one batch one undo; only the head undoes) | |
| 4 | Basic layers can be created, hidden and locked | Evidenced | `pages-layers-assets.spec.ts` "layers: add, rename, assign, visible, locked, print, delete, and the flags really change what can be done"; WA-09 (layers survive a Visio save) | |
| 5 | Grid, snap and alignment guides are usable | Evidenced | `editor.spec.ts` "grid toggle, snapping and alignment guides" | Guide behaviour while dragging was checked by automation, not by feel |
| 6 | Shape fill, line and text properties are editable | Evidenced | Browser: `editor.spec.ts` (fill colour, text, position, angle, locked); `inspector-styling.spec.ts` (A04, #17) drives the inspector's own controls: connector line colour, width, dash (dashed, dotted, dash-dot, solid), start and end arrowhead kind and size; shape line colour, width, dash, font family and font size; and the shared line colour with several shapes selected. Each change is checked for the committed value, what the canvas draws, one revision, exact undo and redo, and that no other object changes. Demo step 6 changes a fill the same way in the real WebView2 page | Rendering is checked on the editor's SVG canvas in Chromium (the browser suite), not in WebView2 or Visio; fill opacity, line opacity, bold/italic/underline, alignment and wrap are not covered by this spec |
| 7 | Connectors remain attached when connected shapes move | Evidenced | `editor.spec.ts` "connector glue follows a moved shape and survives projection rebuilds"; in Visio: WA-04 and demo step 12 (all three connectors keep two connections and follow the moved shape) | |
| 8 | Every element has a stable ID | Evidenced | Canonical contract (UUID per element), `contracts.test.ts`; demo verifier "every element has a stable UUID" | |
| 9 | DrawScript can create and incrementally modify the live page | Evidenced | `script.spec.ts` (script drawer: validate, run, undo; later changes protect earlier ones), `script.test.ts`, `LiveControlTests.ScriptCreateRunsOnceAndShowsTheOperationsItBecame`; demo steps 2 and 9 are DrawScript (`tools/demo/scenario.drawscript`) | |
| 10 | MCP can read current semantic state | Evidenced | `LiveControlTests.ReadsShowTheCurrentCanonicalStore`, `get_document_summary`/`get_objects`/`get_changes` in the demo | |
| 11 | MCP can apply atomic incremental operations against a base revision | Evidenced | `LiveControlTests.AStaleRevisionAfterAHumanEditIsRefusedAndTheHumanWorkStaysUntouched`, `ReconnectAfterALostCommittedReplyReturnsTheIdenticalResult`, `ChangedPayloadWithTheSameTransactionIdConflicts`; demo step 7 (stale write refused with `revision_conflict`, recovered through `get_changes`) | |
| 12 | MCP can return a PNG/JPEG render of the page or region | Evidenced | `render.spec.ts` (clean/debug, revision-labelled, jpeg, region), `LiveControlTests.VisualLoopInspectRenderOneObjectPatchLeavesTheRestExact`; demo step 4 (`step04-preview.png`) | Fonts are not pinned across machines; images are compared by revision and content, not pixel identity |
| 13 | MCP can report simple layout defects | Evidenced, with caveat | `inspect_layout` (overlap, outside page, clipped text, dangling and unglued connectors, low contrast, zero size, distortion); `layout.test.ts`; `render.spec.ts` "layout inspection in the real editor" | R05 adds conservative `NEAR_ALIGNMENT` hints for comparable visible peer boxes, with measured offsets and explicit heuristic guidance. The updated demo asserts the planted CRM/ERP offset. See [R05 evidence and limits](../m5/R05-regression.md); this is not a general alignment solver. |
| 14 | Asset library lets an LLM select a known logo by stable asset ID | Evidenced | `AssetLibraryLiveTests`, `assetVersions.test.ts`, `pages-layers-assets.spec.ts` (pictures); demo steps 8 and 9 (`list_assets` query "ESG Global" returns `asset:esg-global-primary`; one image object changes) | The library import dialog was driven by tests, not clicked by a person (I50 gap 1) |
| 15 | Supported drawings save as editable `.vsdx` | Evidenced | `export_document`; I40 mapping and hostile-fixture suites (`HostileFixtureTests`, Visio.Tests 124); WA-02; demo step 10 (`architecture-demo.vsdx`) | Only the mapped subset is editable; `docs/vsdx-compatibility.md` lists what is lossy or unsupported |
| 16 | Supported `.vsdx` drawings can be reopened into the application | Evidenced | I40 importer; WA-06, WA-11; demo step 14 (the app's own file, and the file Visio saved) | Hostile and unsupported content is reported (`compatibility_loss` needs consent), not reproduced |
| 17 | Stable IDs survive app, to VSDX, to Visio save, to app | Evidenced | WA-06 and WA-07 (a Visio duplicate carries the same UUID; the importer repairs it); demo step 14: all 10 ids resolve after Visio saved the file, and the human's fill colour survives | |
| 18 | Exported VSDX passes **manual** Visio editability tests | Automated PASS; earlier G1 manual PASS; current full manual pass open | WA-02 to WA-09 and demo steps 11 and 12 drive Visio 16.0 through its own object model (open, edit text, fill and position, duplicate, group resize, layers, glue); M0 G1 records the user as manual checker | The current I52 run is automated. Visio was opened with alerts suppressed, so "no repair prompt" is inferred from a clean open, not seen in this run. Image replacement through Visio's UI is unavailable in this build (recorded in M0) |
| 19 | Exported VSDX can be embedded and activated in Word | Automated PASS; earlier G1 manual PASS | WA-10 and demo step 13: embedded as `Visio.Drawing`, activated, a shape edited, Word saved, reopened, reactivated, the edit persisted; earlier M0 G1 records human embedding/activation/save checks | The current I52 run did not have a person watching Word's in-place editing window. A person opening the document on another workstation is still a worthwhile spot check |
| 20 | A one-object agent correction leaves all unrelated objects unchanged | Evidenced | vitest `one_logo_patch_changes_one_object_and_leaves_19_byte_identical`; `VisualLoopInspectRenderOneObjectPatchLeavesTheRestExact`; demo verifier steps 5, 7 and 9 compare every unnamed object byte for byte between saved snapshots | |

## The fourteen steps of spec section 23
Run by `DemoTests.TheFourteenStepArchitectureDiagramDemonstration` through a real stdio MCP client, the real pipe and the real editor; checked from the
saved snapshots by `node tools/demo/verify-demo.mjs`. Step 11 to 13 ran on this very document, in Visio 16.0 and Word.

| Step | Result | Notes |
|---|---|---|
| 1 Blank A4 landscape page | PASS | 841.9 x 595.3 pt, no elements |
| 2 Four labelled blocks, connectors, annotations (and a logo) through MCP | PASS | one atomic `execute_script`, 10 objects |
| 3 The UI visibly updates | PASS | every label found on the canvas; `step03-editor.png` |
| 4 PNG preview; the agent notices one alignment problem | PASS | the defect was planted (ERP 4 mm lower than CRM); found from bounds, see item 13 |
| 5 Align only the affected elements | PASS | one object changed; the other nine byte-identical |
| 6 Human drags one element and changes one fill colour | PASS | real mouse events and the inspector, in WebView2; a scripted human, not a person |
| 7 The agent reads the changes since its revision and preserves the human edit | PASS | stale write refused, `get_changes` named both objects as GUI edits, both stay byte-identical |
| 8 The human asks for a logo swap from the local library | PASS | `list_assets` found `asset:esg-global-primary` |
| 9 Only that image object changes | PASS | one object changed; position and size unchanged |
| 10 Saves as `.vsdx` | PASS | 7 KB, not lossy |
| 11 Opens in Visio with editable objects | PASS | all 10 objects are Visio shapes with their UUID; text edited through Visio |
| 12 Moving a connected shape keeps its connector attached | PASS | 3 of 3 connectors keep two connections |
| 13 Embedded in Word, activatable and editable | PASS | embed, activate, edit, save, reopen, reactivate |
| 14 Reopened in the POC; agent ids resolve | PASS | the app's own export and the file Visio saved: all ids resolve; Visio's edits and the human's fill arrive |

## Open items and risks

These descriptions preserve the acceptance snapshot. Current work status and ownership live in GitHub Issues:
[second-user isolation A01](https://github.com/rp2839/visio-mcp/issues/14),
[manual pass A02](https://github.com/rp2839/visio-mcp/issues/15),
[additional environments A03](https://github.com/rp2839/visio-mcp/issues/16),
[inspector UI coverage A04](https://github.com/rp2839/visio-mcp/issues/17),
[test-harness pause A05](https://github.com/rp2839/visio-mcp/issues/18),
[performance measurement gaps A06](https://github.com/rp2839/visio-mcp/issues/21),
[repeat recovery H01](https://github.com/rp2839/visio-mcp/issues/19),
[library cleanup H02](https://github.com/rp2839/visio-mcp/issues/20), and
[layout/regression R05](https://github.com/rp2839/visio-mcp/issues/1).

1. **The M0 second-Windows-user pipe check is still open (NOT RUN).** Nothing here tests that another Windows user cannot reach the pipe; only the
   same-user ACL and ownership checks from M0 and I30 were run.
2. **A complete manual pass on the current build is not recorded.** The earlier [M0 G1 results](../m0/results.md) explicitly record the user as manual
   checker for Visio editability, connector movement, and Word embedding/activation/save. The screenshot reproduction sessions also include real user review
   of agent-created output. These are useful human evidence, but do not prove every current editor gesture or dialog: the WPF consent window, recovery dialog
   and library import dialog in the I52 suite were exercised through automation only. See the supplementary sign-off below. A current-build pass can now be
   recorded by a person or by an agent on the live system, under the [live acceptance policy](#live-acceptance-policy); until one is recorded this item stays open.
3. **Alignment diagnostics are conservative heuristics** (item 13). R05 detects nearby comparable peer boxes; grouped, rotated, custom-vector and free-text arrangements remain outside this check. See [R05](../m5/R05-regression.md).
4. **Thread-pool starvation when a test process launches a child** (A05, [shim-startup-pause.md](shim-startup-pause.md)): not a freeze of the application and not specific to the shim; it scales with machine load (2 s at about 70 % busy, 5 s at 96 %) and the product never launches a process. The exact mechanism was not isolated.
5. **Performance gaps found by A06 (#21, [performance.md](performance.md)):** a page preview with eight 6-megapixel pictures takes 1.4 to 1.5 s against the 1 s preferred target; `.vsdx` export refuses a document whose pictures exceed 64 MiB in all (reported as `internal_error`); selecting and dragging all 500 elements stalls the display for about 0.65 s at release. None was profiled.
6. **One machine and one Office version.** Visio 16.0 build 20430 and the installed Word; no other builds.
7. Library picture bytes were not garbage-collected on a schedule (I51 gap 4; scheduled by H02, [#20](https://github.com/rp2839/visio-mcp/issues/20)). (I51 gap 3, a recovered session offered again after another crash, was closed by H01: [m5 results](../m5/results.md).)
8. Connector `bounds` in the canonical document are authored fallback geometry, not the live extent (design decision; `visualBounds` carries the extent). An
   agent reading stored connector bounds after moving a glued shape sees the old values.

## Verdict
Every criterion has actual evidence. Sixteen are evidenced as written; items 1, 13, 18 and 19 are evidenced with the stated limits (no complete current-build manual checklist,
conservative alignment hints, Office driven by automation and not by hand). The proof-of-concept meets the specification as far as
this evidence reaches; it does not claim the open M0 second-user pipe check, which is **not run**, and the "manual" tests in items 18 and 19 remain to be
done on the current build, by a person or by an agent on the live system under the [live acceptance policy](#live-acceptance-policy); the earlier G1 manual results remain valid evidence for the version tested there.

## Supplementary MCP and screenshot-reproduction sign-off (2026-10-18)

Latest GitHub main was pulled cleanly to `9ec82c3`, including the rotated-outline connector fix and Claude's I52 manual-test artifacts.
The [evidence index](evidence/I52/mcp-signoff/README.md) separates last night's agent-driven reproductions, fresh automated checks on this source,
and earlier human Office checks. **The MCP acceptance portion is signed off for the supported subset**, subject to the existing layout and compatibility limits.
Fresh verification passed: **301 frontend, 47 browser and 331 .NET tests**, with typecheck/build/contracts checks and **49/49 demo assertions**.
The five archived screenshot drawings passed native Visio verification of **248 shapes, unique stable IDs and 117 text objects** across their target pages.

| Criterion | Supplementary result | Evidence and limits |
|---|---|---|
| 1, 2, 6 | PASS for agent-driven creation, text and styling; partial human usability evidence | Five screenshot reproductions were created and reviewed in conversation; the user explicitly approved the compatibility-decision result. This is not a manual checklist of all editor controls. |
| 8, 15 | PASS for the saved screenshot drawings' native object structure and stable IDs | Archived original VSDX files and fresh native-Visio inspection in [screenshot-file-verification.json](evidence/I52/mcp-signoff/screenshot-file-verification.json); expected labels and distinct `User.AgentId` values are checked. This is not a manual edit test or a pixel-equivalence claim. |
| 10, 11, 12, 13, 20 | PASS within their stated scope | Original repository-diagram MCP requests/results show semantic read, atomic edits, PNG render, layout inspection and export; real MCP/editor regression tests and the 49-check demo verify scoped reads, revision conflict handling and preservation of unrelated objects. Existence of a VSDX alone is not used to claim transaction preservation. R05 subsequently adds bounded near-alignment hints; see its separate evidence and limits. |
| 9, 14, 16, 17, 19 | PASS by existing automated demonstration, supplemented by a fresh run | DrawScript, approved-asset swap, native reopening/ID retention, and Word embedding/activation/edit persistence are exercised by the real-stack tests. The screenshot drawings alone do not prove these behaviors. |
| 18, 19 manual qualifier | Earlier G1 manual PASS; current I52 full manual pass remains open | [M0 G1](../m0/results.md) records human checks and native files. The newer screenshot files and automated Office runs strengthen native-format evidence but do not establish that a person repeated every current-build Office step. |

The supplied [I52 editor screenshot](evidence/I52/Screenshot%202026-10-18%20135209.png) and [five-object drawing](evidence/I52/test1.diagram.json)
record an additional manual editor scenario involving rotation, connectors, a picture and inspector styling. They are retained as scenario evidence;
the screenshot alone does not certify all usability criteria or independently establish when the rotated-outline defect was fixed.

No changes to I52 performance targets, the unrun second-user pipe test, or the remaining recovery/cleanup gaps are implied by this sign-off.
