<#
.SYNOPSIS
A01: connect to the application's MCP named pipe, send app.hello and classify what happened. Sends no document operation.

.DESCRIPTION
Prints one line `RESULT: <ACCEPTED|REFUSED|INCONCLUSIVE> - <evidence>` and exits 0, 10 or 20 for those results.
  ACCEPTED      the server answered app.hello with a success response (this user may use the pipe).
  REFUSED       Windows itself denied the connection (UnauthorizedAccessException from Connect). Nothing else counts.
  INCONCLUSIVE  anything else: timeout, pipe not found or busy, a close or EOF after the hello, a partial or malformed frame,
                an error reply, or any other I/O error. None of these shows who was refused or why.
The server also closes without a reply when the peer's SID or logon session differs (PipeServer.PeerIsSameUserAndSession), but
that close looks the same as a crash, so it is reported as INCONCLUSIVE, never REFUSED.

Every blocking call has a deadline (-TimeoutMs covers the whole probe). Written for Windows PowerShell 5.1 and PowerShell 7; verified only on PowerShell 7.6.9 on Linux.
Framing follows src/Diagram.Ipc/FrameCodec.cs: 4-byte little-endian length, then that many bytes of UTF-8 JSON.
#>
param(
    [string] $PipeName,
    [ValidateRange(1, 600000)] [int] $TimeoutMs = 5000
)

# Maps an exception from Connect to a result. PowerShell wraps exceptions from .NET method calls, so look through the inner exceptions.
function ConvertFrom-A01ConnectError([System.Exception] $e, [int] $TimeoutMs) {
    while ($e.InnerException -and $e -isnot [System.UnauthorizedAccessException] -and $e -isnot [System.TimeoutException]) { $e = $e.InnerException }
    if ($e -is [System.UnauthorizedAccessException]) { return [pscustomobject]@{ Result = 'REFUSED'; Detail = 'Windows denied access to the named pipe.' } }
    if ($e -is [System.TimeoutException]) { return [pscustomobject]@{ Result = 'INCONCLUSIVE'; Detail = "no connection within $TimeoutMs ms (pipe missing or busy)." } }
    [pscustomobject]@{ Result = 'INCONCLUSIVE'; Detail = "connect failed: $($e.GetType().Name): $($e.Message)" }
}

# True only if the task finishes before the whole-probe deadline. Once the deadline has passed nothing is waited for, not even a task
# that has already finished, so a reply trickling in cannot extend the probe.
function Wait-A01Task([System.Threading.Tasks.Task] $task, [System.Diagnostics.Stopwatch] $clock, [int] $TimeoutMs) {
    $ms = $TimeoutMs - [int] $clock.ElapsedMilliseconds
    ($ms -gt 0) -and $task.Wait($ms)
}

function Invoke-A01PipeProbe([string] $PipeName, [ValidateRange(1, 600000)] [int] $TimeoutMs) {
    $result = { param($r, $d) [pscustomobject]@{ Result = $r; Detail = $d } }
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    # Asynchronous so Dispose cannot block behind a read that never returns.
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    try {
        try { $client.Connect($TimeoutMs) }
        catch { return ConvertFrom-A01ConnectError $_.Exception $TimeoutMs }

        $hello = [System.Text.Encoding]::UTF8.GetBytes('{"protocolVersion":1,"kind":"request","requestId":"a01-probe","method":"app.hello","params":{"protocolVersion":1,"clientLabel":"A01-pipe-probe"}}')
        $len = $hello.Length
        $frame = [byte[]] (@(($len -band 255), (($len -shr 8) -band 255), (($len -shr 16) -band 255), (($len -shr 24) -band 255)) + $hello)
        $write = $client.WriteAsync($frame, 0, $frame.Length)
        if (-not (Wait-A01Task $write $clock $TimeoutMs)) { return & $result 'INCONCLUSIVE' 'timed out sending app.hello.' }

        # Read exactly $count bytes within the remaining deadline; $null on timeout, a short array on EOF.
        $readExactly = {
            param([int] $count)
            $buffer = New-Object byte[] $count
            $got = 0
            while ($got -lt $count) {
                $task = $client.ReadAsync($buffer, $got, $count - $got)
                if (-not (Wait-A01Task $task $clock $TimeoutMs)) { return $null }
                if ($task.Result -eq 0) { break }
                $got += $task.Result
            }
            $bytes = New-Object byte[] $got
            [Array]::Copy($buffer, $bytes, $got)
            , $bytes
        }

        $header = & $readExactly 4
        if ($null -eq $header) { return & $result 'INCONCLUSIVE' 'timed out waiting for the reply header.' }
        if ($header.Count -eq 0) { return & $result 'INCONCLUSIVE' 'server closed the pipe without replying. This does not show why.' }
        if ($header.Count -lt 4) { return & $result 'INCONCLUSIVE' "pipe closed after $($header.Count) of 4 header bytes." }
        $length = [uint32] $header[0] + ([uint32] $header[1] -shl 8) + ([uint32] $header[2] -shl 16) + ([uint32] $header[3] -shl 24)
        if ($length -eq 0 -or $length -gt 32768) { return & $result 'INCONCLUSIVE' "implausible reply length $length." }

        $payload = & $readExactly ([int] $length)
        if ($null -eq $payload) { return & $result 'INCONCLUSIVE' "timed out waiting for the reply body ($length bytes declared)." }
        if ($payload.Count -lt $length) { return & $result 'INCONCLUSIVE' "pipe closed after $($payload.Count) of $length reply bytes." }

        try { $reply = [System.Text.Encoding]::UTF8.GetString([byte[]] $payload) | ConvertFrom-Json }
        catch { return & $result 'INCONCLUSIVE' 'reply is not valid JSON.' }
        if ($reply.kind -eq 'response' -and $reply.requestId -eq 'a01-probe' -and $null -eq $reply.error -and $reply.result.protocolVersion -eq 1 -and $reply.result.connectionId) {
            return & $result 'ACCEPTED' "app.hello succeeded (protocol $($reply.result.protocolVersion), connection $($reply.result.connectionId))."
        }
        if ($reply.error) { return & $result 'INCONCLUSIVE' "server answered with error $($reply.error.code): $($reply.error.message)" }
        return & $result 'INCONCLUSIVE' 'reply is not a recognised app.hello success response.'
    }
    catch { return & $result 'INCONCLUSIVE' "$($_.Exception.GetType().Name): $($_.Exception.Message)" }
    finally { $client.Dispose() }
}

# Dot-sourcing (`. .\probe-a01-pipe-access.ps1`) loads the function without probing; the verification script relies on it.
if ($MyInvocation.InvocationName -ne '.') {
    if (-not $PipeName) { throw 'Pass -PipeName <exact pipe name>.' }
    $outcome = Invoke-A01PipeProbe $PipeName $TimeoutMs
    "RESULT: $($outcome.Result) - $($outcome.Detail)"
    exit @{ ACCEPTED = 0; REFUSED = 10; INCONCLUSIVE = 20 }[$outcome.Result]
}
