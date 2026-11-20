# Visio and Word acceptance checklist (I41)

How to run: `dotnet test tests/Diagram.Windows.Tests --filter OfficeAcceptance`. The test drives the installed Visio and Word through their own automation interfaces (not library reopening), starts the real application and a real MCP client, and writes `docs/acceptance/evidence/WA-xx/result.json` plus screenshots and files. A machine without Visio or Word records `NOT RUN` and passes nothing. Results by date: `WA-results-<date>.md`.

The scenario is spec section 23, steps 10 to 14, on a drawing made through MCP: four labelled blocks with three glued connectors, an annotation, a grouped pair, a picture, and two layers with one block in both.

| ID | Scenario | Pass condition |
|---|---|---|
| WA-01 | Record Windows, Visio, .NET versions | versions written to `result.json` |
| WA-02 | `export_document` writes a .vsdx; Visio opens it | no repair prompt; every canvas object has a Visio shape carrying its full UUID in `User.AgentId`; screenshot |
| WA-03 | Edit text, fill and position of exported shapes in Visio | edits accepted through Visio's own object model |
| WA-04 | Move a connected shape in Visio | connector keeps both connections and its end follows the shape; screenshot |
| WA-05 | Picture: independent object, bytes hash kept; picture replaced outside the app with stale User cells | Visio shows a picture shape with the host's SHA-256; reopening a swapped package reports `picture_replaced` and does not apply the old provenance |
| WA-06 | Visio saves; the application opens the saved file | every pre-export UUID resolves via `get_objects`; text, fill, move and glue edits made in Visio are kept; identity report recorded |
| WA-07 | Duplicate a shape in Visio (copies the UUID) | the importer gives every object a unique id; the original keeps its id |
| WA-08 | Resize a group in Visio | members scale in Visio and in the application after reopening |
| WA-09 | One shape in two layers; hide a layer | membership kept through a Visio save; policy: a shape may belong to several layers |
| WA-10 | Word: embed, activate, edit, save, reopen, reactivate | OLE object is `Visio.Drawing.15`; activation exposes the drawing; an edit made while embedded persists after Word saves and reopens |
| WA-11 | Unsupported or lossy content stays visible | a stencil-master shape drawn in Visio opens as an ordinary shape and the report names it (`master_inlined`); lossy export refusal is covered by the `compatibility_loss` tests |
| WA-12 | Native segment of the demonstration, steps 10 to 14 | rows for steps 10, 11, 12, 13, 14 each PASS |

Not part of this suite: spec steps 1 to 9 (done in I12 to I31; the logo swap is I50), and checks that need live operation of the windows (the results file says what was not observed that way). This suite is automation. Live manual checks, by a person or by an agent operating the live system, follow the [live acceptance policy](definition-of-done.md#live-acceptance-policy); a person is needed only for subjective aesthetic judgments.
