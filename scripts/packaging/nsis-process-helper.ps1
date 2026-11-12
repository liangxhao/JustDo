param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Find', 'Wait', 'Stop', 'RequestQuit')]
  [string]$Action,

  [ValidateRange(1, 1200)]
  [int]$MaxAttempts = 120,

  [ValidatePattern('^[A-Za-z]+\.exe$')]
  [string]$BrowserAuthenticationExecutable
)

$ErrorActionPreference = 'Stop'

try {
  $installPath = [Environment]::GetEnvironmentVariable('JUSTDO_INSTALL_ROOT', 'Process')
  $installRoot =
    [IO.Path]::GetFullPath($installPath).TrimEnd(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    ) + [IO.Path]::DirectorySeparatorChar
  $callerPid = [int][Environment]::GetEnvironmentVariable('JUSTDO_CALLER_PID', 'Process')
  $appProcessName = [Environment]::GetEnvironmentVariable('JUSTDO_APP_PROCESS_NAME', 'Process')
  $installedExecutables = @{}
  if (-not [string]::IsNullOrWhiteSpace($appProcessName)) {
    $installedExecutables[$appProcessName] = Join-Path $installRoot "$appProcessName.exe"
  }
  if ($BrowserAuthenticationExecutable) {
    $authenticationProcessName = [IO.Path]::GetFileNameWithoutExtension($BrowserAuthenticationExecutable)
    if (-not $installedExecutables.ContainsKey($authenticationProcessName)) {
      $installedExecutables[$authenticationProcessName] = Join-Path $installRoot $BrowserAuthenticationExecutable
    }
  }
  $helperPid = $PID

  function Stop-MatchedProcess($process) {
    try {
      $process.Kill()
    } catch {
      [Console]::Error.WriteLine(
        "action=$Action operation=terminate-process pid=$($process.Id) detail=$($_.Exception.ToString()) script-stack=$($_.ScriptStackTrace)"
      )
    }
  }

  function Test-ExecutableLocked([string]$executablePath) {
    if (-not (Test-Path -LiteralPath $executablePath)) { return $false }
    try {
      $stream = [IO.File]::Open(
        $executablePath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::None
      )
      $stream.Dispose()
      return $false
    } catch {
      # PowerShell wraps static .NET failures in MethodInvocationException.
      # Inspect the underlying IOException to distinguish locks from ACL errors.
      $lockException = $_.Exception
      while ($null -ne $lockException.InnerException) {
        $lockException = $lockException.InnerException
      }
      $win32Code = $lockException.HResult -band 0xFFFF
      return $win32Code -eq 32 -or $win32Code -eq 33
    }
  }

  function Get-InstalledProcesses {
    @(
      Get-Process -ErrorAction Stop | Where-Object {
        $process = $_
        $installedExecutable = $null
        try {
          $processName = $process.ProcessName
          if ($processName) { $installedExecutable = $installedExecutables[$processName] }
          $executablePath = $process.Path
          if ([string]::IsNullOrWhiteSpace($executablePath) -and $installedExecutable) {
            throw 'Application process path is unavailable.'
          }
          $process.Id -ne $helperPid -and
          $process.Id -ne $callerPid -and
          -not [string]::IsNullOrWhiteSpace($executablePath) -and
          [IO.Path]::GetFullPath($executablePath).StartsWith(
            $installRoot,
            [StringComparison]::OrdinalIgnoreCase
          )
        } catch {
          # A same-named application whose path cannot be inspected must not be
          # silently treated as closed. Other protected system processes are
          # irrelevant and remain safely ignored.
          if ($installedExecutable -and (Test-ExecutableLocked $installedExecutable)) {
            throw
          }
          $false
        }
      }
    )
  }

  function Request-InstalledQuit($process, $deadline) {
    $pipe = $null
    try {
      # Connect only to an already running Main. Never launch an EXE to discover
      # support: legacy builds can treat a control argument as an ordinary start.
      if ($deadline.ElapsedMilliseconds -ge 5000) { return $false }
      $pipe = [IO.Pipes.NamedPipeClientStream]::new(
        '.', "desktop-installer-shutdown-$($process.Id)",
        [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous,
        [Security.Principal.TokenImpersonationLevel]::Identification
      )
      $pipe.Connect(100)
      $request = [Text.Encoding]::ASCII.GetBytes("quit-for-update`n")
      $write = $pipe.WriteAsync($request, 0, $request.Length)
      if (-not $write.Wait(1000)) { return $false }
      [void]$write.GetAwaiter().GetResult()
      $ack = [Text.Encoding]::ASCII.GetBytes("accepted`n")
      $buffer = New-Object byte[] $ack.Length
      $offset = 0
      while ($offset -lt $buffer.Length) {
        $remaining = [Math]::Min(1000, 5000 - $deadline.ElapsedMilliseconds)
        if ($remaining -le 0) { return $false }
        $read = $pipe.ReadAsync($buffer, $offset, $buffer.Length - $offset)
        if (-not $read.Wait([int]$remaining)) { return $false }
        $count = $read.GetAwaiter().GetResult()
        if ($count -eq 0) { return $false }
        $offset += $count
      }
      return [Text.Encoding]::ASCII.GetString($buffer) -ceq "accepted`n"
    } catch {
      # No endpoint, access denied, or no valid ACK means unsupported, never
      # permission to start a replacement process or proof that this one exited.
      return $false
    } finally {
      if ($null -ne $pipe) { $pipe.Dispose() }
    }
  }

  switch ($Action) {
    'RequestQuit' {
      $processes = @(Get-InstalledProcesses)
      if ($processes.Count -eq 0) { exit 1 }
      $appExecutablePath = Join-Path $installRoot "$appProcessName.exe"
      $accepted = $false
      $deadline = [Diagnostics.Stopwatch]::StartNew()
      foreach ($process in $processes) {
        if ($process.Path -ieq $appExecutablePath -and
            (Request-InstalledQuit $process $deadline)) {
          $accepted = $true
        }
      }
      if ($accepted) { exit 0 }
      exit 3
    }
    'Find' {
      if ((Get-InstalledProcesses).Count -gt 0) { exit 0 }
      exit 1
    }
    'Wait' {
      for ($attempt = 0; $attempt -lt $MaxAttempts; $attempt++) {
        if ((Get-InstalledProcesses).Count -eq 0) { exit 0 }
        Start-Sleep -Milliseconds 500
      }
      exit 1
    }
    'Stop' {
      Get-InstalledProcesses | ForEach-Object {
        Stop-MatchedProcess $_
      }
      for ($attempt = 0; $attempt -lt 15; $attempt++) {
        if ((Get-InstalledProcesses).Count -eq 0) { exit 0 }
        Start-Sleep -Milliseconds 500
      }
      exit 1
    }
  }
} catch {
  $failure = $_
  $exceptionType = $failure.Exception.GetType().FullName
  $hresult = $failure.Exception.HResult
  $detail = ($failure.Exception.ToString() + ' ' + $failure.ScriptStackTrace) -replace '[\r\n]+', ' '
  Write-Output "error-type=$exceptionType hresult=$hresult category=$($failure.CategoryInfo.Category) detail=$detail"
  # Process inventory is only an optimization before the installer performs
  # the real filesystem replacement. If Windows denies process enumeration,
  # fall back to an exclusive-open probe of the installed executables. This
  # keeps a genuinely locked application blocking the upgrade without making
  # WMI/process API health a prerequisite for installation. Locks on any other
  # installed file are still reported by the old-version removal/copy step.
  if ($Action -in @('Find', 'Wait', 'Stop') -and
      -not [string]::IsNullOrWhiteSpace($installRoot)) {
    $locked = $false
    foreach ($executablePath in $installedExecutables.Values) {
      if (Test-ExecutableLocked $executablePath) { $locked = $true; break }
    }
    Write-Output "fallback=executable-lock-probe locked=$locked"
    if ($Action -eq 'Find') {
      if ($locked) { exit 0 }
      exit 1
    }
    if ($locked) { exit 1 }
    exit 0
  }

  exit 2
}
