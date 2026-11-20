# A03 cross-environment acceptance matrix

Status: NOT RUN  
Issue: https://github.com/rp2839/visio-mcp/issues/16

This matrix defines a repeatable second-environment check. Existing I52 evidence covers one Windows/Office environment; this document does not imply that a second machine has been tested.

## Existing reference environment

The repository's acceptance records identify the following reference setup. Confirm values against the exact build being compared; records span more than one session and must not be treated as one newly captured environment.

| Component | Recorded reference |
|---|---|
| OS | Windows 11 Enterprise, 10.0.26300 |
| Processor | 4 logical processors |
| .NET | 10.0.13 |
| WebView2 | 155.0.4283.62 |
| Visio | 16.0, build 20430 (definition-of-done evidence) |
| Word | Installed; exact edition/build not recorded in the cited session |
| Scope | Editor, MCP, export/reopen and Word/Visio acceptance |

## Environment B: second machine / Office build

Do not fill unknown values from assumptions. Capture them on the machine used for the run.

| Field | Actual value |
|---|---|
| Machine identifier (non-personal label) | NOT RUN |
| Test date/time and time zone | NOT RUN |
| Tester | NOT RUN |
| Windows edition, version and build | NOT RUN |
| CPU model and logical processor count | NOT RUN |
| RAM | NOT RUN |
| Display resolution and scaling | NOT RUN |
| .NET SDK and runtime versions | NOT RUN |
| WebView2 runtime version | NOT RUN |
| Visio edition, version and build | NOT RUN |
| Word edition, version and build | NOT RUN |
| Installed fonts relevant to fixture | NOT RUN |
| Repository commit / application build | NOT RUN |
| Build configuration | NOT RUN |
| Evidence directory / links | NOT RUN |

## Practical test matrix

Run the same supported fixture and workflow on the reference environment and Environment B. Use a fresh fixture copy on each machine. Record results and evidence per row; do not compare screenshots pixel-for-pixel when fonts, DPI, or Office builds differ.

| ID | Area | Scenario | Required observation | Environment B result | Evidence |
|---|---|---|---|---|---|
| A03-01 | Editor | Launch app and open/create standard acceptance document | Startup, page rendering and environment-specific warnings | NOT RUN | |
| A03-02 | Editor | Add, edit, move and delete supported shapes and text | Operations complete without lost edits or unexpected UI errors | NOT RUN | |
| A03-03 | Editor | Grid, snapping, guides and inspector styling | Controls work; note font substitutions, layout and DPI effects | NOT RUN | |
| A03-04 | MCP | Connect using documented local MCP workflow and read document summary/objects | MCP connects and returns current document state | NOT RUN | |
| A03-05 | MCP | Apply one supported edit and read back changed state | Intended change commits and unrelated objects remain unchanged | NOT RUN | |
| A03-06 | Export | Export standard supported fixture to VSDX | Export completes; record warnings, duration and file size | NOT RUN | |
| A03-07 | Reopen | Reopen exported VSDX in the application | Supported objects and stable identities reopen; record loss notices | NOT RUN | |
| A03-08 | Visio | Open exported VSDX in Visio | Record repair prompts, warnings, editability and font substitutions | NOT RUN | |
| A03-09 | Visio | Edit a supported shape, move a glued endpoint and save a copy | Edits persist and connector remains attached | NOT RUN | |
| A03-10 | Word | Embed/activate drawing, edit, save, close and reopen | Embedded object activates and edit persists after reopening | NOT RUN | |
| A03-11 | Fonts | Compare text-heavy fixture across environments | Record font substitutions, wrapping, clipping and line-break differences | NOT RUN | |
| A03-12 | Repeatability | Repeat smoke workflow after clean application restart | Record intermittent failures separately from first-run behavior | NOT RUN | |

## Environment capture commands

Run on a disposable test environment. Retain exact command, working directory, exit code and output.

    Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, CsSystemType
    Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores, NumberOfLogicalProcessors
    Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory
    dotnet --info

Capture Visio and Word versions through File > Account > About and record the complete version/build. Capture the installed WebView2 runtime version from its application/runtime details.

Run the repository's supported automated suites from the same commit as the application build. Retain command output and test reports. Automated Office runs are not human-observed manual passes.

## Result vocabulary

- PASS: scenario ran on Environment B and met its stated outcome.
- FAIL: scenario ran and did not meet its outcome; include reproduction details.
- NOT RUN: required software/hardware was unavailable, permission was missing, or evidence is insufficient.
- NOT APPLICABLE: only when the scenario genuinely does not apply, with an explanation.

An unavailable Office edition/build is NOT RUN, not PASS. A skipped test is NOT RUN. Automated success does not prove a person observed the UI or repair prompts.

## Cross-environment comparison

| Dimension | Reference environment observation | Environment B observation | Difference / impact |
|---|---|---|---|
| Editor launch and rendering | Existing evidence only; no new comparison | NOT RUN | |
| Shape/text editing | Existing automated and partial manual evidence | NOT RUN | |
| MCP connection and operations | Existing automated evidence | NOT RUN | |
| VSDX export/reopen | Existing automated and Office evidence | NOT RUN | |
| Visio repair prompt and editability | Current-build manual observation incomplete | NOT RUN | |
| Word embed/activate/save/reopen | Current-build manual observation incomplete | NOT RUN | |
| Font substitution and text wrapping | Not compared across machines | NOT RUN | |
| Performance / hardware sensitivity | Existing figures from one machine only | NOT RUN | |

Do not claim pixel identity across machines. Compare semantic content, supported object behavior, stable IDs, connector attachment, persistence, and documented font/layout differences.

## Session summary

| Outcome | Count |
|---|---:|
| PASS | 0 |
| FAIL | 0 |
| NOT RUN | 12 |

### Deviations and failures

For each failed or skipped row, record scenario ID, exact environment, steps, expected/actual result, logs, screenshots, and reproducibility. Keep Environment B results separate from reference-machine results.

### Sign-off

- Environment B identified: NO
- Second-machine/Office smoke pass completed: NO
- Commit/build tested: NOT RUN
- Remaining limitations: Environment B and all matrix scenarios remain NOT RUN until executed on a second supported environment.

This matrix defines scope and captures results; it is not evidence that another machine or Office build has been tested.
