# A02 current-build manual acceptance session

Status: NOT RUN  
Issue: https://github.com/rp2839/visio-mcp/issues/15

This record is for a person's observations on one identified build. Automated tests and historical M0 G1 results are supporting evidence only; they do not satisfy this current-build manual session.

## Session identity

| Field | Value |
|---|---|
| Session date/time and time zone | NOT RUN |
| Tester | NOT RUN |
| Repository commit / build identifier | NOT RUN |
| Build configuration | NOT RUN |
| Windows edition and version/build | NOT RUN |
| .NET SDK/runtime | NOT RUN |
| WebView2 runtime | NOT RUN |
| Visio edition, version and build | NOT RUN |
| Word edition, version and build | NOT RUN |
| Display resolution and scaling | NOT RUN |
| Evidence directory / links | NOT RUN |

Record the exact commit used for the running application. Do not substitute the latest repository commit if the tested binary was built from another revision.

## Result rules

Use exactly one result for each row: PASS means the named person performed the interaction on the identified build and observed the stated outcome; FAIL means it was performed and did not meet the condition; NOT RUN means it was not performed, the required application was unavailable, or evidence is insufficient.

Do not mark an item PASS based only on browser tests, UI automation, COM automation, generated screenshots, or a previous acceptance session.

## A. Editor interaction

| ID | Manual action | Pass condition | Result | Observation / evidence |
|---|---|---|---|---|
| A02-01 | Launch the application and create a new blank document/page | Editor opens and the new page is visible and usable | NOT RUN | |
| A02-02 | Add a shape, move it, resize it, rotate it, then delete it | Each operation behaves as expected | NOT RUN | |
| A02-03 | Add and edit shape text, commit the edit, then select another object | Text commits without loss or a stuck edit mode | NOT RUN | |
| A02-04 | Toggle grid and snapping; drag an object near a grid position | Grid visibility and snapping behave consistently | NOT RUN | |
| A02-05 | Drag an object near another object's alignment edge/centre | Alignment guides appear and disappear at the appropriate times | NOT RUN | |
| A02-06 | Use inspector controls for fill, line colour/width, font/size and position | Controls reflect selection and update only the intended object | NOT RUN | |
| A02-07 | Select multiple objects and change a shared inspector property | Only the intended selection changes; mixed values are clear | NOT RUN | |

## B. Consent, recovery and library dialogs

| ID | Manual action | Pass condition | Result | Observation / evidence |
|---|---|---|---|---|
| A02-08 | Trigger an export requiring compatibility/loss consent | Dialog explains the loss; cancel preserves source; explicit consent proceeds | NOT RUN | |
| A02-09 | Open recovery flow with a safely prepared recovery entry | Entry is identified; offered action behaves as stated; dismissal is safe | NOT RUN | |
| A02-10 | Open library import and inspect choices | Asset/source and choices are understandable; cancel does not import; confirm imports intended asset | NOT RUN | |

If a recovery fixture cannot be prepared safely, record NOT RUN and explain why. Do not manufacture a crash in a user's working environment.

## C. Visio round trip

Use a disposable drawing and preserve the original export.

| ID | Manual action | Pass condition | Result | Observation / evidence |
|---|---|---|---|---|
| A02-11 | Export to VSDX and open in the installed Visio UI | Record whether a repair prompt appears; capture exact text if present | NOT RUN | |
| A02-12 | Edit text, fill and position of supported exported shapes in Visio | Supported objects are editable and edits are visible | NOT RUN | |
| A02-13 | Move a shape connected by a glued connector | Connector remains attached at both ends and follows the shape | NOT RUN | |
| A02-14 | Save the drawing in Visio under a new filename | Save completes; warnings and compatibility prompts are recorded | NOT RUN | |

## D. Word embed and reopen

| ID | Manual action | Pass condition | Result | Observation / evidence |
|---|---|---|---|---|
| A02-15 | Embed the saved Visio drawing in a new disposable Word document | Word inserts the drawing as an embedded object | NOT RUN | |
| A02-16 | Activate the embedded drawing and edit a supported shape | Embedded object activates and the change is visible | NOT RUN | |
| A02-17 | Save and close Word; reopen the document and reactivate the drawing | Embedded drawing remains available and the edit persists | NOT RUN | |

## Session summary

| Outcome | Count |
|---|---:|
| PASS | 0 |
| FAIL | 0 |
| NOT RUN | 17 |

### Failures and deviations

For each failure, record the step ID, reproduction steps, expected and actual result, exact build/environment, and evidence link.

### Evidence index

| Evidence | Link / path | Related steps |
|---|---|---|
| Environment capture | NOT RUN | All |
| Screenshots / recordings | NOT RUN | |
| Original VSDX export | NOT RUN | A02-11 to A02-14 |
| Visio-saved VSDX | NOT RUN | A02-14 |
| Word document before/after reopen | NOT RUN | A02-15 to A02-17 |
| Automated test report (supporting only) | NOT RUN | |

## Sign-off

- Tester: NOT RUN
- Date: NOT RUN
- Commit/build tested: NOT RUN
- Manual session complete: NO
- Remaining limitations: All steps remain NOT RUN until a person performs and records them on the current build.

This template is not evidence of a successful manual acceptance pass. Update rows only from the tester's direct observations.
