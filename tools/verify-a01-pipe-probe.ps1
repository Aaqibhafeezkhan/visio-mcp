<#
.SYNOPSIS
Checks how tools/probe-a01-pipe-access.ps1 classifies a handshake against scripted fake pipe servers.

.DESCRIPTION
This is a simulation. It proves the probe's classification, deadlines and partial-frame handling; it is not evidence about Windows
account isolation. On Linux the .NET named pipe is a Unix socket, so the REFUSED case uses a socket file the user cannot open
instead of a Windows access denial. Run with PowerShell 7 (`pwsh -File tools/verify-a01-pipe-probe.ps1`); exits 1 on any failure.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'probe-a01-pipe-access.ps1')

$okReply = '{"protocolVersion":1,"kind":"response","requestId":"a01-probe","result":{"protocolVersion":1,"connectionId":"c1","clientLabel":"Client 1","capabilities":["doc.requests"]}}'

$failures = 0
function Check([string] $label, [string] $expected, $outcome, [int] $maxMs = 0, [int] $elapsedMs = 0, [string] $why = '') {
    $pass = $outcome.Result -eq $expected -and $outcome.Detail -match $why -and ($maxMs -eq 0 -or $elapsedMs -le $maxMs)
    if (-not $pass) { $script:failures++ }
    '{0} {1,-52} want {2,-12} got {3,-12} {4} ({5} ms)' -f ($(if ($pass) { 'PASS' } else { 'FAIL' })), $label, $expected, $outcome.Result, $outcome.Detail, $elapsedMs
}

# Each case runs a fake server that accepts one connection, reads the hello frame, then does `Act`.
$cases = @(
    @{ Label = 'success reply sent three bytes at a time'; Why = 'app.hello succeeded'; Want = 'ACCEPTED'; Act = { param($p) Send-Frame $p (Json $using:okReply) -chunk 3 } }
    @{ Label = 'success reply split mid-header and mid-body'; Why = 'app.hello succeeded'; Want = 'ACCEPTED'; Act = { param($p) Send-Frame $p (Json $using:okReply) -chunk 7 } }
    @{ Label = 'close without any reply'; Why = 'without replying'; Want = 'INCONCLUSIVE'; Act = { param($p) } }
    @{ Label = 'reply header cut short'; Why = '2 of 4 header'; Want = 'INCONCLUSIVE'; Act = { param($p) $p.Write([byte[]] (1, 0), 0, 2); $p.Flush() } }
    @{ Label = 'body shorter than declared, then close'; Why = 'of 200 reply bytes'; Want = 'INCONCLUSIVE'; Act = { param($p) Send-Frame $p (Json '{"kind":"resp') -declared 200 } }
    @{ Label = 'zero-length frame'; Why = 'implausible reply length 0'; Want = 'INCONCLUSIVE'; Act = { param($p) Send-Frame $p ([byte[]] @()) } }
    @{ Label = 'oversized declared length'; Why = 'implausible reply length 99999999'; Want = 'INCONCLUSIVE'; Act = { param($p) Send-Frame $p (Json '{}') -declared 99999999 } }
    @{ Label = 'body is not JSON'; Why = 'not valid JSON'; Want = 'INCONCLUSIVE'; Act = { param($p) Send-Frame $p (Json 'not json at all') } }
    @{ Label = 'error reply (unsupported_version)'; Why = 'unsupported_version'; Want = 'INCONCLUSIVE'; Act = { param($p) Send-Frame $p (Json '{"protocolVersion":1,"kind":"response","requestId":"a01-probe","error":{"code":"unsupported_version","message":"protocol 1 is not supported"}}') } }
    @{ Label = 'reply for a different request id'; Why = 'not a recognised'; Want = 'INCONCLUSIVE'; Act = { param($p) Send-Frame $p (Json ($using:okReply -replace 'a01-probe', 'other')) } }
    @{ Label = 'server never answers (deadline 600 ms)'; Why = 'timed out waiting for the reply header'; Want = 'INCONCLUSIVE'; Act = { param($p) Start-Sleep -Seconds 8 }; Max = 3000 }
    @{ Label = 'server stalls after half a frame (deadline 600 ms)'; Why = 'timed out waiting for the reply body'; Want = 'INCONCLUSIVE'; Act = { param($p) $p.Write([byte[]] (50, 0, 0, 0, 123), 0, 5); $p.Flush(); Start-Sleep -Seconds 8 }; Max = 3000 }
)

$n = 0
foreach ($case in $cases) {
    $name = "a01-verify-$PID-$((++$n))"
    $ps = [powershell]::Create()
    [void] $ps.AddScript({
        param($name, $actText, $okReply)
        function Json([string] $s) { [System.Text.Encoding]::UTF8.GetBytes($s) }
        function Send-Frame($pipe, [byte[]] $body, [int] $declared = -1, [int] $chunk = 0) {
            if ($declared -lt 0) { $declared = $body.Length }
            $bytes = [byte[]] (@(($declared -band 255), (($declared -shr 8) -band 255), (($declared -shr 16) -band 255), (($declared -shr 24) -band 255)) + $body)
            if ($chunk -le 0) { $chunk = $bytes.Length }
            for ($i = 0; $i -lt $bytes.Length; $i += $chunk) {
                $count = [Math]::Min($chunk, $bytes.Length - $i)
                $pipe.Write($bytes, $i, $count); $pipe.Flush()
                if ($chunk -lt $bytes.Length) { Start-Sleep -Milliseconds 30 }
            }
        }
        $server = [System.IO.Pipes.NamedPipeServerStream]::new($name, 'InOut', 1, 'Byte', 'None')
        try {
            $server.WaitForConnection()
            $head = New-Object byte[] 4
            [void] $server.Read($head, 0, 4)
            $rest = New-Object byte[] ($head[0] + 256 * $head[1])
            $got = 0; while ($got -lt $rest.Length) { $got += $server.Read($rest, $got, $rest.Length - $got) }
            & ([scriptblock]::Create($actText)) $server
        } finally { $server.Dispose() }
    }).AddArgument($name).AddArgument(($case.Act.ToString() -replace '\$using:okReply', '$okReply')).AddArgument($okReply)
    $handle = $ps.BeginInvoke()
    Start-Sleep -Milliseconds 300
    $clock = [System.Diagnostics.Stopwatch]::StartNew()
    $outcome = Invoke-A01PipeProbe $name $(if ($case.Max) { 600 } else { 3000 })
    $clock.Stop()
    Check $case.Label $case.Want $outcome $(if ($case.Max) { $case.Max } else { 0 }) ([int] $clock.ElapsedMilliseconds) $case.Why
    try { $ps.Stop() } catch { }
    $ps.Dispose()
}

# No server at all: the connect deadline applies.
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$outcome = Invoke-A01PipeProbe "a01-verify-$PID-missing" 600
Check 'pipe does not exist (deadline 600 ms)' 'INCONCLUSIVE' $outcome 3000 ([int] $clock.ElapsedMilliseconds) 'no connection within'

# The REFUSED branch needs a real UnauthorizedAccessException, which Windows raises from Connect on an ACL denial and Linux does not
# for a pipe. Feed the classifier one captured the way PowerShell delivers it (wrapped by a .NET method call). Simulated.
if ($IsLinux) {
    $file = Join-Path ([System.IO.Path]::GetTempPath()) "a01-verify-$PID.txt"
    Set-Content $file x; chmod 000 $file
    try { try { [System.IO.File]::OpenRead($file).Dispose() } catch { $wrapped = $_.Exception } } finally { Remove-Item $file -Force }
    Check ("wrapped $($wrapped.GetType().Name) around $($wrapped.InnerException.GetType().Name)") 'REFUSED' (ConvertFrom-A01ConnectError $wrapped 1000) 0 0 'denied access'
}
Check 'other connect error is not an identity denial' 'INCONCLUSIVE' (ConvertFrom-A01ConnectError ([System.Net.Sockets.SocketException]::new(13)) 1000) 0 0 'connect failed'
Check 'connect timeout' 'INCONCLUSIVE' (ConvertFrom-A01ConnectError ([System.TimeoutException]::new()) 1000) 0 0 'no connection within'

if ($failures) { "FAILED: $failures case(s)"; exit 1 }
'ALL PASSED (simulated servers; not native Windows evidence)'
