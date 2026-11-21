# Coordination

Read [docs/development/issue-workflow.md](docs/development/issue-workflow.md) before starting development or acceptance work.

- GitHub Issues owns scope, dependencies, agent ownership and handovers; Project 3's Status field owns workflow state. `IMPLEMENTATION_PROGRESS.md` is historical evidence and an issue index. Temporary `status:*` labels are retired.
- Pull current main, read the issue, Project Status and recent comments, and check for an existing claim before editing. Claim work with an agent label, Project Status and comment naming the branch/scope; read the issue back to detect overlapping claims.
- Use an isolated feature branch. Coordinate overlapping shared files/contracts through the issue; do not silently take over another agent's work.
- Preserve the R/A/H work ID in issue titles. Link commits, verification results, repository evidence, remaining limits and handovers in the issue.
- Close only when acceptance criteria and intended integration are verified. Distinguish automated, historical and fresh manual evidence. Do not update a duplicate Markdown status table.
- If GitHub access is unavailable, report the coordination blocker rather than assuming an issue is unclaimed.

## Acceptance testing

An agent can perform functional acceptance checks by operating a computer or VM and directly assessing the visible result using computer vision or similar tools. Exercise the behavior being checked and record the operator, environment, method, observations and evidence. Logs or file contents alone do not establish what appeared on screen; inspect the live output when the check requires it.

When several outcomes are functionally acceptable but choosing among them depends on preference, run the check, gather evidence showing the alternatives, and ask the human operator which outcome they prefer so the result can be tuned.
