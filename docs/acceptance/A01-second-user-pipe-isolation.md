# A01: second-Windows-user named-pipe isolation

## Purpose

Verify that a process running as a different Windows user cannot connect to the application's MCP named pipe, while a process running as the owning user can connect successfully.

The application creates its pipe with `PipeOptions.CurrentUserOnly` and also checks the connecting peer's user SID and logon-session ID after receiving the first frame. The pipe name is scoped to the owner SID, logon session and protocol version:

`agentic-diagram.v1.<owner-SID>.<logon-session-LUID-in-hex>`

The existing `Diagram.Ipc.Tests.PeerTests.SameUserSessionOnly` test verifies the current-user ACL and same-user/same-session control. It does not substitute for the second-user test below.

## Preconditions

- A Windows machine with the current application build and its MCP shim installed.
- Two distinct local or domain Windows accounts, referred to as **User A** and **User B**.
- Permission to sign in as both accounts. Do not share passwords or other credentials.
- The application is launched and remains running in User A's interactive session.
- This repository's `tools/probe-a01-pipe-access.ps1`, placed where both users can read it (this checkout, or a copy in a shared folder such as `C:\Users\Public\A01`). Commands below use `<path to>` for that folder; run them with the script's full path, so the current directory does not matter. If PowerShell's execution policy blocks the script, run it as `powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<path to>\probe-a01-pipe-access.ps1' -PipeName '...'` and record that. It is written for Windows PowerShell 5.1 (`powershell.exe`) and PowerShell 7 (`pwsh.exe`); so far it has run only under PowerShell 7.6.9 on Linux, so note which one you use. It needs no other install and does not change the application.
- Optional extra control: the configured MCP client can call the public `get_document_summary` tool (the harmless read-only tool; `doc.summary` is the internal bridge method behind it, not a tool name).

## Procedure

### 1. Record the environment as User A

Sign in as User A and open PowerShell. Record the following without recording credentials:

```powershell
whoami
whoami /user
whoami /logonid
[Environment]::OSVersion.Version
dotnet --info
```

Record the application and shim versions from their installed executable file properties (FileVersion/ProductVersion), and note the full executable paths. If the shim is hosted by `dotnet.exe`, record the shim assembly/package version from the installed application or MCP client configuration as well.

Keep the application running.

### 2. Identify the pipe name

In User A's PowerShell session, list the application's pipe name:

```powershell
Get-ChildItem \\.\pipe\ |
  Where-Object { $_.Name -like 'agentic-diagram.v1.*' } |
  Select-Object -ExpandProperty Name
```

Copy the exact pipe name for the test. It contains the owner SID and logon-session identifier; it is not a credential. Do not use a pipe name from a different application run or logon session.

### 3. Run the same-user success control

While still signed in as User A, run the exact probe you will give User B, against the exact pipe name from step 2:

```powershell
& '<path to>\probe-a01-pipe-access.ps1' -PipeName '<exact pipe name from step 2>'
```

The expected output is `RESULT: ACCEPTED - app.hello succeeded ...` and exit code 0. Record the output and the time. If it is anything else, stop: the User B result means nothing until this probe succeeds as User A. Do not substitute a different tool for this control; User B must run the same script against the same name.

Optionally also call `get_document_summary` from the configured MCP client and record the client, time and outcome.

### 4. Attempt access as User B

Switch to User B **without signing out of User A**: use Windows **Switch user** (Start menu, account picture, then User B), or Win+L and then choose User B. Signing out of User A closes the application you are testing. Open PowerShell as User B in that second session.

Record:

```powershell
whoami
whoami /user
whoami /logonid
```

Confirm that User B's SID differs from User A's SID. Run the same probe with the same pipe name:

```powershell
& '<path to>\probe-a01-pipe-access.ps1' -PipeName '<exact pipe name from step 2>'
```

The probe sends `app.hello` only, never a document operation. It waits at most 5 seconds in total (`-TimeoutMs` changes that), reads whole frames, prints one `RESULT:` line and exits 0, 10 or 20:

| Result | Exit | Meaning |
|---|---|---|
| `ACCEPTED` | 0 | The server returned a successful `app.hello` response (`kind` `response`, matching `requestId`, `result.protocolVersion` 1, a `connectionId`). |
| `REFUSED` | 10 | Windows itself denied the connection (`UnauthorizedAccessException` from `Connect`). Only this is demonstrated identity denial. |
| `INCONCLUSIVE` | 20 | Anything else: timeout, pipe missing or busy, the server closing without a reply, a partial or malformed frame, an error reply, or any other I/O error. |

The application also closes a connection without a reply when the peer's SID or logon session differs (`PipeServer.PeerIsSameUserAndSession`), and the pipe is created current-user-only. A silent close looks the same as a crash or a restart, so the probe reports it as `INCONCLUSIVE`, not `REFUSED`.

Expected result for User B: `REFUSED`. `INCONCLUSIVE` does not pass or fail the check: rerun it, then diagnose (is the application still running as User A; does the User A probe still succeed; is this the same pipe name). `ACCEPTED` for User B is a failure of this acceptance check and must be investigated.

### 5. Repeat and preserve evidence

- Repeat the User B attempt once to rule out a transient result.
- Switch back to User A and run the same probe again while the same application instance is still running. It must still print `ACCEPTED`: a User B attempt must not have broken the owner's access.
- Record timestamps and the exact output for both attempts.
- Capture screenshots or sanitized console output if useful. Redact machine names or account details if they are sensitive; retain enough information to distinguish the two SIDs.
- Do not record passwords, tokens, or other credentials.

## Result record

Fill this table only after the checks have actually been performed.

| Field | Observation |
|---|---|
| Date/time and timezone | NOT RUN |
| Windows edition/build | NOT RUN |
| User A identity and SID | NOT RUN |
| User A logon-session ID | NOT RUN |
| User B identity and SID | NOT RUN |
| User B logon-session ID | NOT RUN |
| Application version and executable path | NOT RUN |
| MCP shim version and executable/assembly path | NOT RUN |
| Pipe name used | NOT RUN |
| User A probe before User B (exact output) | NOT RUN |
| User B first attempt | NOT RUN |
| User B repeat attempt | NOT RUN |
| User A probe after User B (exact output) | NOT RUN |
| Evidence location | None collected |

## Current status

**NOT RUN.** No second Windows account or Windows desktop session was available in the implementation environment. No cross-user refusal or same-user success on Windows is claimed. The acceptance check (issue [#99](https://github.com/rp2839/visio-mcp/issues/99)) stays open until a person runs the procedure on Windows and records the actual identities, versions and observations above.

### Probe verification (simulated, not Windows evidence)

`tools/verify-a01-pipe-probe.ps1` runs the probe against scripted fake pipe servers and checks its classification: a reply sent in small pieces is `ACCEPTED`; no reply, a cut-short header or body, a zero-length or oversized frame, invalid JSON, an error reply, a reply for another request, a server that stalls (deadline), and a missing pipe are all `INCONCLUSIVE`; a wrapped `UnauthorizedAccessException` is `REFUSED` and other connect errors are not. Run it with `pwsh -File tools/verify-a01-pipe-probe.ps1`. It cannot test Windows ACL behaviour.

## Related evidence

- [A01 issue #14](https://github.com/rp2839/visio-mcp/issues/14) (closed, documentation delivery) and [#99](https://github.com/rp2839/visio-mcp/issues/99) (outstanding acceptance)
- [Probe script](../../tools/probe-a01-pipe-access.ps1) and its [simulated verification](../../tools/verify-a01-pipe-probe.ps1)
- [Frame codec](../../src/Diagram.Ipc/FrameCodec.cs): 4-byte little-endian length, then UTF-8 JSON
- [M0 results](../m0/results.md), which records the original second-user check as NOT RUN
- [IPC peer tests](../../tests/Diagram.Ipc.Tests/PeerTests.cs), including the same-user ACL/session control
- [Pipe server](../../src/Diagram.Ipc/PipeServer.cs), which applies the current-user-only pipe option and validates peer identity
- [Pipe naming and logon-session identity](../../src/Diagram.Ipc/Handshake.cs)
