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
- A harmless MCP operation is available for the same-user control, such as `doc.summary`.

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

While still signed in as User A, use the configured MCP client to call the harmless `doc.summary` operation against the running application.

Record the client identity, operation, timestamp and outcome. The expected result is a successful response. If this control fails, stop: the cross-user result is inconclusive until the normal connection works.

### 4. Attempt access as User B

Sign out of User A or switch to User B without stopping the application in User A's session. Open PowerShell as User B.

Record:

```powershell
whoami
whoami /user
whoami /logonid
```

Confirm that User B's SID differs from User A's SID. Use the exact pipe name copied in step 2 and run this probe. It sends the protocol handshake only; it does not issue a document operation.

```powershell
param(
    [Parameter(Mandatory = $true)]
    [string] $PipeName
)

$client = [System.IO.Pipes.NamedPipeClientStream]::new(
    '.',
    $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut
)

try {
    $client.Connect(3000)

    $hello = [System.Text.Encoding]::UTF8.GetBytes(
        '{"protocolVersion":1,"kind":"request","requestId":"a01-probe","method":"app.hello","params":{"protocolVersion":1,"clientLabel":"A01-cross-user-probe"}}'
    )

    $header = [System.BitConverter]::GetBytes([uint32] $hello.Length)
    $client.Write($header, 0, $header.Length)
    $client.Write($hello, 0, $hello.Length)
    $client.Flush()

    $replyHeader = New-Object byte[] 4
    $read = $client.Read($replyHeader, 0, 4)

    if ($read -eq 0) {
        'REFUSED: server closed the connection before accepting the handshake.'
    }
    elseif ($read -ne 4) {
        'INCONCLUSIVE: received a partial frame header.'
    }
    else {
        $length = [System.BitConverter]::ToUInt32($replyHeader, 0)
        if ($length -gt 32768) {
            'INCONCLUSIVE: unexpected oversized handshake response.'
        }
        else {
            $payload = New-Object byte[] ([int] $length)
            $offset = 0
            while ($offset -lt $payload.Length) {
                $count = $client.Read($payload, $offset, $payload.Length - $offset)
                if ($count -eq 0) { break }
                $offset += $count
            }

            if ($offset -eq 0) {
                'REFUSED: server closed the connection without a handshake response.'
            }
            else {
                $response = [System.Text.Encoding]::UTF8.GetString($payload, 0, $offset)
                "RESPONSE: $response"
            }
        }
    }
}
catch [System.UnauthorizedAccessException] {
    'REFUSED: Windows denied access to the named pipe.'
}
catch [System.IO.IOException] {
    "REFUSED: named-pipe connection failed: $($_.Exception.Message)"
}
catch {
    "INCONCLUSIVE: unexpected probe error: $($_.Exception.GetType().FullName)"
}
finally {
    $client.Dispose()
}
```

Example invocation:

```powershell
.\Test-A01-PipeAccess.ps1 -PipeName 'agentic-diagram.v1.<owner-SID>.<logon-session-LUID>'
```

For a one-off run, save the script above as `Test-A01-PipeAccess.ps1` before invoking it. Do not paste passwords or credentials into the script or issue evidence.

Expected result for User B: Windows denies the connection, or the application closes the connection before returning a successful `app.hello` handshake. A successful handshake is a failure of this acceptance check and must be investigated.

### 5. Repeat and preserve evidence

- Repeat the User B attempt once to rule out a transient result.
- Return to User A and repeat the same-user control while the same application instance is still running.
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
| User A same-user control | NOT RUN |
| User B first attempt | NOT RUN |
| User B repeat attempt | NOT RUN |
| Evidence location | None collected |

## Current status

**NOT RUN.** This contribution prepares the repeatable procedure, but no second Windows account or Windows desktop session was available in the implementation environment. No cross-user refusal or same-user success is claimed. The acceptance check remains open until a person runs the procedure on Windows and records the actual identities, versions and observations above.

## Related evidence

- [A01 issue](https://github.com/rp2839/visio-mcp/issues/14)
- [M0 results](../m0/results.md), which records the original second-user check as NOT RUN
- [IPC peer tests](../../tests/Diagram.Ipc.Tests/PeerTests.cs), including the same-user ACL/session control
- [Pipe server](../../src/Diagram.Ipc/PipeServer.cs), which applies the current-user-only pipe option and validates peer identity
- [Pipe naming and logon-session identity](../../src/Diagram.Ipc/Handshake.cs)
