# Work coordination through GitHub Issues

GitHub Issues owns work scope, ownership, dependencies and handovers for Codex, Claude and human contributors. The [Project's Status field](https://github.com/users/rp2839/projects/3/views/1) owns workflow state.
[IMPLEMENTATION_PROGRESS.md](../../IMPLEMENTATION_PROGRESS.md) preserves completed package history and a stable-ID-to-issue index.
Designs, compatibility reports and acceptance evidence stay versioned in the repository; link to them from the issue.

## Find and claim work

1. Pull the latest main and read the relevant open issue, dependencies and recent comments before changing files. Search for an existing issue before creating a new one.
2. Preserve work IDs in titles, for example `[R08b] Route orthogonal connectors around other shapes`. GitHub issue numbers are separate IDs.
3. Check that nobody has already claimed the work. Post a claim naming Codex or Claude, the branch, intended scope and likely shared files. Add exactly one `agent:codex` or `agent:claude` label and set Project Status to **In progress**.
4. Read the issue back before editing. Issue claims are a coordination convention, not an atomic lock: if two claims overlap, resolve ownership and scope first.
5. Use a feature branch such as `codex/r05-regression` or the other contributor's normal branch convention. Share contract/schema changes explicitly in the issue before implementing changes that affect another active task.

Assignees represent actual GitHub users. Do not invent separate agent accounts when both agents use the owner's account; agent labels identify the current implementer.
Acceptance criteria migrated from proposals are scope/checklists, not approval of an implementation design. Existing design-review requirements still apply.

## Workflow states

Use the Project's single Status field. Temporary `status:*` labels were retired after board setup; do not maintain a second status in labels or Markdown.

| State | Meaning |
|---|---|
| Backlog | Proposed or unclaimed work; no implied design approval |
| Ready | Scope agreed and dependencies satisfied; available to claim |
| In progress | A contributor is actively working; see claim comment |
| In review | Concrete implementation or acceptance evidence is ready for review |
| Done | Criteria met, remaining limits recorded, integrated as intended and issue closed |

Area labels are `area:reproduction`, `area:acceptance` and `area:reliability`. Keep the GitHub open/closed state consistent with Project Status.
If blocked, retain the actual work state, add native blocking dependencies where possible, and explain the blocker in a comment. Completed historical packages can be referenced through their repository reports without manufacturing open issues for them.

The user created [Project 3](https://github.com/users/rp2839/projects/3/views/1). Workflow: **Backlog → Ready → In progress → In review → Done**.
Verified through the signed-in browser on 2026-10-18: all 21 migrated issues are present. During setup Claude claimed R12 (#7); its claim was preserved as In progress, leaving 20 items in Backlog and none in To triage. [Board snapshot](project-backlog.png). This is migration evidence, not a live status table.
The existing enabled auto-add workflow collects new/updated open issues from `rp2839/visio-mcp`; the enabled item-added workflow now sets Status to Backlog.
The extra To triage option from the user's Project template remains available, but Backlog is the agreed intake state.
The API credential still lacks Projects scope, so use the authenticated browser for Project reads/updates where available.
If only Project access is unavailable, check current issue claims, retain the agent label, and post the requested state/handover with **Project update pending** in the issue. A contributor with Project access applies it; this does not block implementation after ownership is checked. These are handover requests, not a second maintained status register. Do not recreate `status:*` labels.
If Issues itself is unavailable, report the coordination blocker rather than assuming work is unclaimed.

## Review, handover and completion

Before review, record:

- The branch and commit/PR links, what changed and the reason.
- Exact verification commands and results; link repository evidence and distinguish historical runs from fresh tests.
- Remaining work, compatibility limits and manual checks marked PASS, FAIL or NOT RUN. Scripted automation (COM, browser or UI-automation tests) is not manual sign-off; live operation of the real application or Office windows by a person or an agent counts only when recorded under the [live acceptance policy](../acceptance/definition-of-done.md#live-acceptance-policy) with operator, method, environment, build and uncertainty.
- Any overlap with another issue and which agent should pick up the next step.

Before closing, verify the acceptance checklist, preserve relevant evidence in the repository, and confirm integration. Scope remaining work into linked follow-ups rather than hiding it in a completion comment.
For a handover, record the current commit, outstanding checks and next action; release the agent label if nobody is continuing immediately.
Current issue status must not depend on either agent's chat history.

## Migration record — 2026-10-18

Migrated 13 open reproduction packages (R05, R08b/R08c, R09–R18) and eight acceptance/reliability follow-ups (A01–A06, H01–H02).
R08 had already been delivered on main and was retained as completed history. All migrated issues started unclaimed in Backlog.
Native blocking links: R16 depends on R12, R17 on R09, and R18 on R10. Links to completed dependencies remain in issue bodies and source reports.
The I52 automated MCP portion remains signed off; migration does not reopen the entire I52 package or claim that its remaining manual/security checks passed.

[All open work](https://github.com/rp2839/visio-mcp/issues?q=is%3Aissue%20is%3Aopen) ·
[Project board](https://github.com/users/rp2839/projects/3/views/1)
