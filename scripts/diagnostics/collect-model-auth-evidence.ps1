[CmdletBinding()]
param(
  [string[]]$LogPaths = @(),
  [string]$ErrorTime = '',
  [ValidatePattern('^[+-](?:0\d|1[0-4]):[0-5]\d$')][string]$SourceUtcOffset = '+08:00',
  [ValidateRange(1, 1440)][int]$MinutesBefore = 30,
  [ValidateRange(1, 1440)][int]$MinutesAfter = 5,
  [ValidateRange(4, 64)][int]$MaxKiB = 16,
  [string]$OutputDirectory = [Environment]::GetFolderPath('Desktop')
)

# Standalone Windows PowerShell 5.1 / PowerShell 7 collector. Only the selected
# files are read. Output contains normalized, allowlisted facts, never raw lines.
$ErrorActionPreference = 'Stop'
$culture = [Globalization.CultureInfo]::InvariantCulture
$offset = [TimeSpan]::Parse($SourceUtcOffset.TrimStart([char]'+'), $culture)
if ($SourceUtcOffset.StartsWith('-') -and $offset.Ticks -gt 0) { $offset = $offset.Negate() }
if ([Math]::Abs($offset.TotalHours) -gt 14) { throw 'SourceUtcOffset must be within 14 hours of UTC.' }
$newline = [string][char]13 + [char]10
$utf8 = [Text.UTF8Encoding]::new($false)
$lineLimit = 65536
$candidateLimit = 4096
$isoPattern = '\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})'

function New-AllowedSet([string]$Values) {
  $set = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($value in ($Values -split '\s+')) { if ($value) { [void]$set.Add($value) } }
  return ,$set
}
$events = New-AllowedSet @'
exchange.started exchange.succeeded exchange.failed exchange.unavailable exchange.superseded
monitor.started monitor.stopped refresh.triggered refresh.completed refresh.retry-scheduled
application.queued application.started application.completed application.superseded application.failed
config-sync.queued config-sync.started config-sync.completed config-sync.failed
snapshot.published snapshot.publication-failed snapshot.revoked snapshot.revocation-failed snapshot.observed
reload.started reload.acknowledged reload.failed reload.superseded recovery.failed startup.failed notification.failed
discovery.started discovery.succeeded discovery.failed discovery.optional-http-rejected request_credentials_rejected
'@
$reasons = New-AllowedSet @'
config-invalid endpoint-missing login-missing login-too-large login-invalid-json login-invalid-fields login-read-failed
login-suspended url-invalid device-unavailable network-failure request-timeout http-rejected response-unreadable
response-empty response-too-large response-invalid-json response-invalid-shape credential-invalid identity-unavailable
identity-changed generation-changed config-application-failed snapshot-invalid snapshot-write-failed snapshot-revoke-failed
reload-failed reload-ack-invalid recovery-failed missing_provider_config missing_auth_session invalid_auth_session
invalid_auth_type invalid_configured_route provider_mismatch route_mismatch secret_resolution_failed invalid_resolved_credential
'@
$codes = New-AllowedSet @'
unknown ENOENT EACCES EPERM EBUSY ENOSPC EROFS EIO EMFILE ENFILE EISDIR ENOTDIR EINVAL ENOTFOUND EAI_AGAIN
ECONNREFUSED ECONNRESET ETIMEDOUT EHOSTUNREACH ENETUNREACH EADDRNOTAVAIL EPIPE ECONNABORTED ENOTCONN
UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_BODY_TIMEOUT UND_ERR_SOCKET CERT_HAS_EXPIRED
ERR_TLS_CERT_ALTNAME_INVALID DEPTH_ZERO_SELF_SIGNED_CERT SELF_SIGNED_CERT_IN_CHAIN UNABLE_TO_VERIFY_LEAF_SIGNATURE
UNABLE_TO_GET_ISSUER_CERT_LOCALLY ERR_SSL_WRONG_VERSION_NUMBER UNAVAILABLE CLIENT_TIMEOUT FORBIDDEN INVALID_REQUEST UNAUTHORIZED
SECRET_PROVIDER_PATH_SECURITY_UNVERIFIABLE SECRET_PROVIDER_INVALID SECRET_PROVIDER_NOT_CONFIGURED SECRET_PROVIDER_UNAVAILABLE
SECRET_REF_NOT_FOUND SECRET_REF_POLICY_DENIED SECRET_REF_INVALID SECRET_REF_REDACTED_VALUE SECRET_REF_PROVIDER_ERROR SECRET_REF_PROVIDER_CONTRACT
'@
$resolverCodes = New-AllowedSet (($codes -join ' ') + ' MODULE_NOT_FOUND ERR_MODULE_NOT_FOUND ERR_PACKAGE_PATH_NOT_EXPORTED ERR_REQUIRE_ESM')
$stringFields = [ordered]@{
  reason = $reasons; errorCode = $codes; networkCode = $codes; configErrorCode = $codes; resolverCode = $resolverCodes
  resolverStage = (New-AllowedSet 'sdk_load secret_ref')
  resolverReason = (New-AllowedSet 'invalid_request snapshot_missing snapshot_read_failed snapshot_invalid session_mismatch auth_type_mismatch credential_expired')
  credentialCode = (New-AllowedSet 'invalid-account invalid-token-format invalid-jwt-json invalid-lifetime-policy unsupported-algorithm missing-subject account-mismatch missing-issuer missing-token-id audience-mismatch invalid-timestamps issued-in-future lifetime-exceeded invalid-lifetime expiry-too-far expired-or-expiring expires-in-mismatch')
  authType = (New-AllowedSet 'jwt api-key none'); stage = (New-AllowedSet 'url device request response credential identity')
  trigger = (New-AllowedSet 'deadline login-file-change error-retry login-retry')
  syncReason = (New-AllowedSet 'auth-login auth-logout other'); basis = (New-AllowedSet 'snapshot_observation')
  fileKind = (New-AllowedSet 'snapshot resolver launcher')
  snapshotState = (New-AllowedSet 'valid missing read-failed too-large not-regular-file invalid-format decrypt-failed invalid-payload expired invalid-session invalid-auth-type')
  configState = (New-AllowedSet 'read missing read-failed too-large not-regular-file invalid')
  sessionMatch = (New-AllowedSet 'matches mismatch not-checked'); authTypeMatch = (New-AllowedSet 'matches mismatch not-checked')
  nativeFailureReason = (New-AllowedSet 'not-provided'); triggerKind = (New-AllowedSet 'provider-degraded owner-unavailable')
  ackState = (New-AllowedSet 'accepted invalid'); gatewayPhase = (New-AllowedSet 'uninstalled ready starting running stopping error')
  discoveryStage = (New-AllowedSet 'models model-info'); ownerState = (New-AllowedSet 'cold stale')
}
$numberFields = @('generation','backgroundRevision','httpStatus','elapsedMs','expiresInSeconds','refreshInMs','queueWaitMs','latenessMs','retryDelayMs','processGeneration','lifecycleGeneration','remainingSeconds','attempt','maxAttempts','timeoutMs','warningCount','chatModelCount','embeddingModelCount')
$boolFields = @('background','refreshCatalog','credentialPresent','waitingForApplication','waitingForForeground','replacedPending','success','configSynced','requireApplication','changed','willRetry','builtinOwner','memoryOwner')
$failureEvents = New-AllowedSet 'exchange.failed application.failed config-sync.failed snapshot.publication-failed snapshot.revocation-failed reload.failed recovery.failed startup.failed discovery.failed request_credentials_rejected native.provider-degraded native.owner-unavailable'

function Convert-LogTime($Value) {
  if ($Value -is [DateTimeOffset]) { return $Value }
  if ($Value -is [DateTime]) {
    if ($Value.Kind -ne [DateTimeKind]::Unspecified) { return [DateTimeOffset]$Value }
    $Value = $Value.ToString('yyyy-MM-ddTHH:mm:ss.fffffff', $culture)
  }
  if ($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})?$') { return $null }
  if ($Value -notmatch '(?:Z|[+-]\d{2}:\d{2})$') { $Value += $SourceUtcOffset }
  $result = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse($Value, $culture, [Globalization.DateTimeStyles]::None, [ref]$result)) { return $result }
  return $null
}
function Format-Time([DateTimeOffset]$Value) { return $Value.ToOffset($offset).ToString('o', $culture) }

function Project-Facts($InputObject) {
  $facts = [ordered]@{}
  foreach ($name in $stringFields.Keys) {
    $value = $InputObject.$name
    if ($value -is [string] -and $stringFields[$name].Contains($value)) { $facts[$name] = $value }
  }
  foreach ($name in $numberFields) {
    $value = $InputObject.$name
    if (($value -is [int] -or $value -is [long] -or $value -is [double] -or $value -is [decimal]) -and
        -not [double]::IsNaN([double]$value) -and -not [double]::IsInfinity([double]$value)) { $facts[$name] = $value }
  }
  foreach ($name in $boolFields) { if ($InputObject.$name -is [bool]) { $facts[$name] = $InputObject.$name } }
  return $facts
}
function New-Record([DateTimeOffset]$Time, [string]$Event, $Facts, [string]$Source) {
  $projected = Project-Facts $Facts
  $rank = 0
  if ($failureEvents.Contains($Event)) { $rank = 3 }
  elseif ($Event -eq 'exchange.unavailable' -and $projected.reason -in @('config-invalid','login-too-large','login-invalid-json','login-invalid-fields','login-read-failed')) { $rank = 2 }
  elseif ($Event -eq 'config-sync.completed' -and $projected.success -eq $false) { $rank = 2 }
  elseif ($Event -eq 'snapshot.observed' -and $projected.snapshotState -and $projected.snapshotState -ne 'valid') { $rank = 2 }
  return [pscustomobject]@{ Time = $Time; Event = $Event; Facts = $projected; Source = $Source; Rank = $rank }
}

# Known log frames are admitted at their beginning, not by searching task text.
function Get-TextFrame([string]$Text, $FallbackTime) {
  $time = $FallbackTime
  if ($Text -match '^\[(?<stamp>\d{4}-\d{2}-\d{2}[ T][^\]]+)\]\s+\[(?:info|warn|error|debug|log|stdout|stderr)\]\s*') {
    $time = Convert-LogTime $Matches.stamp
    $Text = $Text.Substring($Matches[0].Length)
  }
  $Text = $Text -replace '^\[OpenClaw (?:stdout|stderr)\]\s*', ''
  if ($Text -match ('^(?<stamp>' + $isoPattern + ')\s+')) {
    $time = Convert-LogTime $Matches.stamp
    $Text = $Text.Substring($Matches[0].Length)
  }
  return [pscustomobject]@{ Time = $time; Text = $Text }
}
function Get-LogFrames([string]$Line) {
  $frames = [Collections.Generic.List[object]]::new()
  if ($Line.TrimStart().StartsWith('{')) {
    try { $native = ConvertFrom-Json -InputObject $Line -ErrorAction Stop } catch { return ,$frames }
    $time = Convert-LogTime $native.time
    if ($null -eq $time) { $time = Convert-LogTime $native._meta.date }
    $subsystem = $null
    foreach ($nameValue in @($native._meta.name, $native.'0')) {
      if ($nameValue -isnot [string]) { continue }
      if ($nameValue -in @('secrets','reload','ws','plugins','diagnostic','agents','agent/embedded')) { $subsystem = $nameValue; break }
      if ($nameValue.StartsWith('{')) {
        try { $nameObject = ConvertFrom-Json -InputObject $nameValue -ErrorAction Stop } catch { continue }
        if ($nameObject.subsystem -in @('secrets','reload','ws','plugins','diagnostic','agents','agent/embedded')) { $subsystem = $nameObject.subsystem; break }
      }
    }
    foreach ($candidate in @($native.message, $native.'0', $native.'1')) {
      if ($candidate -isnot [string]) { continue }
      $frame = Get-TextFrame $candidate $time
      if ($subsystem -and $frame.Text -notmatch '^\[(?:secrets|reload|ws|plugins|diagnostic|agents|agent/embedded|BuiltinModelAuth)\]') {
        $frame.Text = '[' + $subsystem + '] ' + $frame.Text
      }
      $frames.Add($frame)
    }
  } else { $frames.Add((Get-TextFrame $Line $null)) }
  return ,$frames
}
function Emit-Pending($Context) {
  if ($null -ne $Context.Pending) {
    $pending = $Context.Pending
    $Context.Pending = $null
    & $Context.Sink (New-Record $pending.Time $pending.Event $pending.Facts $pending.Source) $Context.State
  }
}
function Read-LegacyFields([string]$Line, $Pending) {
  if ($Line -match '^\s*(?<key>stage|reason|networkCode|credentialCode|errorCode|gatewayPhase)\s*:\s*["''](?<value>[^"'']{1,128})["'']\s*,?\s*$') {
    $key = $Matches.key; $value = $Matches.value
    if ($key -eq 'reason') {
      if ($value -match '^Token exchange HTTP (?<status>\d{3})$') { $Pending.Facts.httpStatus = [int]$Matches.status; $Pending.Facts.reason = 'http-rejected' }
      elseif ($value -eq 'Token exchange timed out') { $Pending.Facts.reason = 'request-timeout' }
    } elseif ($stringFields.Contains($key) -and $stringFields[$key].Contains($value)) { $Pending.Facts[$key] = $value }
  } elseif ($Line -match '^\s*(?<key>httpStatus|attempt|maxAttempts|elapsedMs|timeoutMs)\s*:\s*(?<value>\d{1,12})\s*,?\s*$') {
    $Pending.Facts[$Matches.key] = [long]$Matches.value
  } elseif ($Line -match '^\s*(?<key>willRetry)\s*:\s*(?<value>true|false)\s*,?\s*$') {
    $Pending.Facts[$Matches.key] = $Matches.value -eq 'true'
  }
}
function Process-LogLine([string]$Line, [int]$LineNumber, $Context) {
  if ($null -ne $Context.Pending) {
    if ($Line -match '^\[\d{4}-\d{2}-\d{2}[ T]|^\d{4}-\d{2}-\d{2}T|^\s*\{') { Emit-Pending $Context }
    else {
      $Context.Pending.Lines++
      Read-LegacyFields $Line $Context.Pending
      if ($Line -match '^\s*\}\s*$' -or $Context.Pending.Lines -ge 32) { Emit-Pending $Context }
      return
    }
  }
  if ($Line -notmatch 'BuiltinModelAuth|BuiltinModelTokenExchange|SECRETS_|Secret owner |secrets\.reload|syncOpenClawConfig|config (?:hot reload applied|change detected)') { return }
  $emitted = @{}
  $candidate = $false; $supported = $false; $malformed = $false
  $frames = Get-LogFrames $Line
  if ($frames.Count -eq 0 -and $Line.TrimStart().StartsWith('{')) { $Context.State.MalformedCandidates++; return }
  foreach ($frame in $frames) {
    $text = $frame.Text
    if ($text -match '^\[(?:BuiltinModelAuth|BuiltinModelTokenExchange|OpenClaw|secrets|ws|reload|plugins|diagnostic|agents|agent/embedded)\]') { $candidate = $true }
    if ($null -eq $frame.Time) { if ($candidate) { $malformed = $true }; continue }
    $event = $null; $facts = @{}
    if ($text.StartsWith('[BuiltinModelAuth] ')) {
      try { $parsed = ConvertFrom-Json -InputObject $text.Substring(19) -ErrorAction Stop } catch { $malformed = $true; continue }
      if ($parsed.event -isnot [string] -or -not $events.Contains($parsed.event)) { continue }
      $event = $parsed.event; $facts = $parsed
    } elseif ($text -match '^\[secrets\]\s+\[SECRETS_PROVIDER_DEGRADED\]\s+exec:justdo_login:') {
      $event = 'native.provider-degraded'
      $facts = @{ builtinOwner = $text.Contains('provider:builtin_models'); memoryOwner = $text.Contains('capability:memory-provider:main') }
      if ($text -match '\bcold\b|"state"\s*:\s*"cold"') { $facts.ownerState = 'cold' }
      elseif ($text -match '\bstale\b|"state"\s*:\s*"stale"') { $facts.ownerState = 'stale' }
    } elseif ($text -match '^\[(?:plugins|diagnostic|agents|secrets|agent/embedded)\]\s+(?:Secret owner |plugin tool failed |lane task error:|embedded run .*?(?:error|failed))' -and
        $text -match 'Secret owner (?<owner>provider:builtin_models|capability:memory-provider:main) is configured but unavailable \(secret provider failed\)') {
      $event = 'native.owner-unavailable'; $facts = @{ builtinOwner = $Matches.owner -eq 'provider:builtin_models'; memoryOwner = $Matches.owner -eq 'capability:memory-provider:main' }
    } elseif ($text -match '^\[ws\].*?\bres\s+\u2713\s+secrets\.reload\s+(?<ms>\d{1,12})ms\b') {
      $event = 'native.reload-acknowledged'; $facts = @{ elapsedMs = [long]$Matches.ms; ackState = 'accepted' }
    } elseif ($text -match '^\[reload\]\s+config change detected; evaluating reload') { $event = 'native.config-reload-started' }
    elseif ($text -match '^\[reload\]\s+config hot reload applied') { $event = 'native.config-reload-applied' }
    elseif ($text -match '^\[secrets\]\s+\[SECRETS_RELOADER_RECOVERED\]') { $event = 'native.reloader-recovered' }
    elseif ($text -match '^\[OpenClaw\]\s+syncOpenClawConfig: called') { $event = 'native.config-sync-called' }
    elseif ($text -match '^\[BuiltinModelTokenExchange\]\s+exchange failed:\s*\{\s*$' -or
      $text -match '^\[OpenClaw\]\s+Failed to refresh managed model provider credentials \(secrets\.reload\):\s*\{\s*$') {
      $event = if ($text.StartsWith('[BuiltinModelTokenExchange]')) { 'exchange.failed' } else { 'reload.failed' }
      $Context.Pending = [pscustomobject]@{ Time = $frame.Time; Event = $event; Facts = @{}; Source = $Context.Alias + ':' + $LineNumber; Lines = 0 }
      $supported = $true
      continue
    }
    if ($event) {
      $record = New-Record $frame.Time $event $facts ($Context.Alias + ':' + $LineNumber)
      $key = $record.Time.UtcDateTime.Ticks.ToString($culture) + ':' + $event + ':' + (ConvertTo-Json -InputObject $record.Facts -Compress -Depth 4)
      $supported = $true
      if (-not $emitted.ContainsKey($key)) { $emitted[$key] = $true; & $Context.Sink $record $Context.State }
    }
  }
  if ($malformed) { $Context.State.MalformedCandidates++ }
  elseif ($candidate -and -not $supported) { $Context.State.UnsupportedCandidates++ }
}

# Chunked reading skips overlong records without allocating their complete text.
function Scan-SelectedFiles($Files, $State, [scriptblock]$Sink) {
  for ($fileIndex = 0; $fileIndex -lt $Files.Count; $fileIndex++) {
    $reader = $null; $stream = $null
    $context = [pscustomobject]@{ Alias = 'F' + ($fileIndex + 1); Pending = $null; State = $State; Sink = $Sink }
    try {
      $stream = [IO.FileStream]::new($Files[$fileIndex], [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::UTF8, $true)
      $buffer = [char[]]::new(8192); $builder = [Text.StringBuilder]::new(); $oversized = $false; $lineNumber = 0
      while (($count = $reader.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $chunk = [string]::new($buffer, 0, $count); $position = 0
        while ($position -lt $chunk.Length) {
          $end = $chunk.IndexOf([char]10, $position); $hasNewline = $end -ge 0
          if (-not $hasNewline) { $end = $chunk.Length }
          $length = $end - $position
          if (-not $oversized) {
            if ($builder.Length + $length -gt $lineLimit) { $oversized = $true; [void]$builder.Clear() }
            elseif ($length -gt 0) { [void]$builder.Append($chunk, $position, $length) }
          }
          if ($hasNewline) {
            $lineNumber++; $State.InputLines++
            if ($oversized) { $State.OversizedLines++; Emit-Pending $context }
            else { Process-LogLine ($builder.ToString().TrimEnd([char]13)) $lineNumber $context }
            [void]$builder.Clear(); $oversized = $false
          }
          $position = $end + 1
        }
      }
      if ($builder.Length -gt 0 -or $oversized) {
        $lineNumber++; $State.InputLines++
        if ($oversized) { $State.OversizedLines++ } else { Process-LogLine ($builder.ToString().TrimEnd([char]13)) $lineNumber $context }
      }
      Emit-Pending $context
    } catch { $State.ReadFailures++ }
    finally { if ($null -ne $reader) { $reader.Dispose() } elseif ($null -ne $stream) { $stream.Dispose() } }
  }
}

if ($LogPaths.Count -eq 0) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = [Windows.Forms.OpenFileDialog]::new()
    try {
      $dialog.Title = 'Select received application or Gateway log files (multiple allowed)'
      $dialog.Filter = 'Log files|*.log;*.txt;*.jsonl;*.old'
      $dialog.Multiselect = $true
      if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { return }
      $LogPaths = @($dialog.FileNames)
    } finally { $dialog.Dispose() }
  } catch { throw 'File selection is unavailable. Supply individual files with -LogPaths.' }
}
$files = [Collections.Generic.List[string]]::new()
foreach ($inputPath in $LogPaths) {
  try { $item = Get-Item -LiteralPath $inputPath -ErrorAction Stop } catch { throw 'A selected input file is unavailable.' }
  if ($item.PSIsContainer -or $item.Extension -notin @('.log','.txt','.jsonl','.old')) { throw 'Select individual .log, .txt, .jsonl or .old files.' }
  if (-not $files.Contains($item.FullName)) { $files.Add($item.FullName) }
}
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { $OutputDirectory = $env:TEMP }
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) { throw 'OutputDirectory must be an existing directory.' }

$firstPass = [pscustomobject]@{ InputLines = 0; OversizedLines = 0; ReadFailures = 0; RecognizedRecords = 0; MalformedCandidates = 0; UnsupportedCandidates = 0; FirstFailure = $null; LastFailure = $null; Latest = $null }
Scan-SelectedFiles $files $firstPass {
  param($record, $state)
  $state.RecognizedRecords++
  if ($null -eq $state.Latest -or $record.Time -gt $state.Latest.Time) { $state.Latest = $record }
  if ($record.Rank -ge 2) {
    if ($null -eq $state.FirstFailure -or $record.Time -lt $state.FirstFailure.Time) { $state.FirstFailure = $record }
    if ($null -eq $state.LastFailure -or $record.Time -gt $state.LastFailure.Time) { $state.LastFailure = $record }
  }
}
$anchor = $null; $anchorMode = 'no-failure'
if ($ErrorTime) {
  $anchor = Convert-LogTime $ErrorTime
  if ($null -eq $anchor) { throw 'ErrorTime must be an ISO date/time or yyyy-MM-dd HH:mm:ss.' }
  $anchorMode = 'specified'
} elseif ($null -ne $firstPass.LastFailure) { $anchor = $firstPass.LastFailure.Time; $anchorMode = 'latest-failure' }
$from = $null; $to = $null
if ($null -ne $anchor) { $from = $anchor.AddMinutes(-$MinutesBefore); $to = $anchor.AddMinutes($MinutesAfter) }
$secondPass = [pscustomobject]@{
  InputLines = 0; OversizedLines = 0; ReadFailures = 0; RecognizedRecords = 0; MalformedCandidates = 0; UnsupportedCandidates = 0; From = $from; To = $to; Anchor = $anchor
  Observations = 0; CandidateLimited = $false; Candidates = @{}; Slots = @{}
}
if ($null -ne $anchor) {
  Scan-SelectedFiles $files $secondPass {
    param($record, $state)
    $state.RecognizedRecords++
    if ($record.Time -lt $state.From -or $record.Time -gt $state.To) { return }
    $state.Observations++
    $key = $record.Time.UtcDateTime.Ticks.ToString($culture) + ':' + $record.Event + ':' + (ConvertTo-Json -InputObject $record.Facts -Compress -Depth 4)
    $entry = $state.Candidates[$key]
    if ($null -eq $entry -and $state.Slots.ContainsKey($record.Event)) {
      foreach ($slot in @($state.Slots[$record.Event].First, $state.Slots[$record.Event].Nearest, $state.Slots[$record.Event].Last, $state.Slots[$record.Event].Before, $state.Slots[$record.Event].After)) {
        if ($null -ne $slot -and $slot.Key -eq $key) { $entry = $slot; break }
      }
    }
    if ($null -ne $entry) {
      $entry.RecordCount++
      if ($entry.Sources.Count -lt 4 -and -not $entry.Sources.Contains($record.Source)) { $entry.Sources.Add($record.Source) }
      return
    }
    $sources = [Collections.Generic.List[string]]::new(); $sources.Add($record.Source)
    $entry = [pscustomobject]@{ Key = $key; Time = $record.Time; Event = $record.Event; Facts = $record.Facts; Rank = $record.Rank; RecordCount = 1; Sources = $sources; Priority = 0; Distance = [Math]::Abs(($record.Time - $state.Anchor).TotalMilliseconds) }
    if ($state.Candidates.Count -lt $candidateLimit) { $state.Candidates[$key] = $entry } else { $state.CandidateLimited = $true }
    if (-not $state.Slots.ContainsKey($entry.Event)) { $state.Slots[$entry.Event] = [pscustomobject]@{ First = $entry; Nearest = $entry; Last = $entry; Before = $null; After = $null } }
    $slots = $state.Slots[$entry.Event]
    if ($entry.Time -lt $slots.First.Time) { $slots.First = $entry }
    if ($entry.Distance -lt $slots.Nearest.Distance) { $slots.Nearest = $entry }
    if ($entry.Time -gt $slots.Last.Time) { $slots.Last = $entry }
    if ($entry.Time -le $state.Anchor -and ($null -eq $slots.Before -or $entry.Time -gt $slots.Before.Time)) { $slots.Before = $entry }
    if ($entry.Time -ge $state.Anchor -and ($null -eq $slots.After -or $entry.Time -lt $slots.After.Time)) { $slots.After = $entry }
  }
}
$pool = @{}
foreach ($entry in $secondPass.Candidates.Values) { $pool[$entry.Key] = $entry }
foreach ($slots in $secondPass.Slots.Values) {
  $slots.Nearest.Priority = [Math]::Max($slots.Nearest.Priority, 3)
  $slots.First.Priority = [Math]::Max($slots.First.Priority, 2); $slots.Last.Priority = [Math]::Max($slots.Last.Priority, 2)
  if ($slots.Nearest.Event -in @('native.provider-degraded','native.owner-unavailable','snapshot.observed')) { $slots.Nearest.Priority = 8 }
  if ($slots.Nearest.Event -in @('exchange.succeeded','snapshot.published','reload.acknowledged','native.reload-acknowledged')) {
    $priority = if ($slots.Nearest.Event -in @('exchange.succeeded','snapshot.published')) { 7 } else { 6 }
    foreach ($entry in @($slots.Before,$slots.After)) { if ($null -ne $entry) { $entry.Priority = [Math]::Max($entry.Priority, $priority) } }
  }
  foreach ($entry in @($slots.First,$slots.Nearest,$slots.Last,$slots.Before,$slots.After)) { if ($null -ne $entry) { $pool[$entry.Key] = $entry } }
}
$earliest = @($pool.Values | Where-Object { $_.Rank -ge 2 } | Sort-Object Time | Select-Object -First 1)
if ($earliest.Count -gt 0) { $earliest[0].Priority = 9 }
$header = @('Model authentication evidence; normalized observations only.', ('Anchor: ' + $(if ($anchor) { Format-Time $anchor } else { 'none' })), ('Anchor mode: ' + $anchorMode),
  ('Window: ' + $(if ($anchor) { (Format-Time $from) + ' through ' + (Format-Time $to) } else { 'none' })), ('Input files: ' + $files.Count),
  ('First failure: ' + $(if ($firstPass.FirstFailure) { (Format-Time $firstPass.FirstFailure.Time) + ' event=' + $firstPass.FirstFailure.Event } else { 'none' })),
  'Only allowlisted facts are retained. Missing records do not prove absence.', 'recordCount counts log records and mirrors, not independent failures.') -join $newline
$header += $newline
$budget = $MaxKiB * 1024 - 3 - $utf8.GetByteCount($header) - 1024
$selected = [Collections.Generic.List[object]]::new()
foreach ($entry in ($pool.Values | Sort-Object @{ Expression = 'Priority'; Descending = $true }, Distance, Time)) {
  $row = [ordered]@{ event = $entry.Event; time = (Format-Time $entry.Time); recordCount = $entry.RecordCount; sources = @($entry.Sources.ToArray()) }
  foreach ($name in $entry.Facts.Keys) { $row[$name] = $entry.Facts[$name] }
  $json = ConvertTo-Json -InputObject $row -Compress -Depth 4
  $bytes = $utf8.GetByteCount($json + $newline)
  if ($bytes -le $budget) { $selected.Add([pscustomobject]@{ Time = $entry.Time; Json = $json }); $budget -= $bytes }
}
$truncated = $firstPass.OversizedLines -gt 0 -or $firstPass.ReadFailures -gt 0 -or $secondPass.OversizedLines -gt 0 -or $secondPass.ReadFailures -gt 0 -or $secondPass.CandidateLimited -or $selected.Count -lt $pool.Count
$footer = @(('Rows written: ' + $selected.Count), ('Truncated: ' + $truncated.ToString().ToLowerInvariant()), ('Input lines: ' + $firstPass.InputLines),
  ('Oversized lines skipped: ' + $firstPass.OversizedLines), ('Read failures: ' + $firstPass.ReadFailures), ('Window observations: ' + $secondPass.Observations),
  ('Recognized records: ' + $firstPass.RecognizedRecords), ('Malformed candidates: ' + $firstPass.MalformedCandidates), ('Unsupported candidates: ' + $firstPass.UnsupportedCandidates),
  ('Second pass recognized records: ' + $secondPass.RecognizedRecords), ('Second pass malformed candidates: ' + $secondPass.MalformedCandidates), ('Second pass unsupported candidates: ' + $secondPass.UnsupportedCandidates),
  ('Second pass oversized lines skipped: ' + $secondPass.OversizedLines), ('Second pass read failures: ' + $secondPass.ReadFailures),
  ('Candidate records: ' + $pool.Count), ('Candidate limit reached: ' + $secondPass.CandidateLimited.ToString().ToLowerInvariant()), ('Output limit bytes: ' + ($MaxKiB * 1024))) -join $newline
$body = @($selected | Sort-Object Time | ForEach-Object { $_.Json }) -join $newline
$content = $header + $(if ($body) { $body + $newline } else { '' }) + $footer + $newline
if ($utf8.GetByteCount($content) + 3 -gt $MaxKiB * 1024) { throw 'The normalized report exceeded its output limit.' }
$report = Join-Path $OutputDirectory ('model-auth-evidence-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.txt')
[IO.File]::WriteAllText($report, $content, [Text.UTF8Encoding]::new($true))
Write-Host ('Report saved: ' + $report)
