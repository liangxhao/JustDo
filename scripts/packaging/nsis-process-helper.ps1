param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Find', 'Wait', 'Stop', 'StopLegacyPython')]
  [string]$Action,

  [ValidateRange(1, 120)]
  [int]$MaxAttempts = 120
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

  function Test-AppExecutableLocked {
    if ([string]::IsNullOrWhiteSpace($appProcessName)) { return $false }
    $appExecutablePath = Join-Path $installRoot "$appProcessName.exe"
    if (-not (Test-Path -LiteralPath $appExecutablePath)) { return $false }
    try {
      $stream = [IO.File]::Open(
        $appExecutablePath,
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
        try {
          $executablePath = $process.Path
          if ([string]::IsNullOrWhiteSpace($executablePath) -and
              -not [string]::IsNullOrWhiteSpace($appProcessName) -and
              $process.ProcessName -ieq $appProcessName) {
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
          if (-not [string]::IsNullOrWhiteSpace($appProcessName) -and
              $process.ProcessName -ieq $appProcessName -and
              (Test-AppExecutableLocked)) {
            throw
          }
          $false
        }
      }
    )
  }

  function Test-PathChainContainsReparsePoint {
    param(
      [Parameter(Mandatory = $true)]
      [string]$RootPath,

      [Parameter(Mandatory = $true)]
      [string]$CandidatePath
    )

    try {
      $normalizedRoot = [IO.Path]::GetFullPath($RootPath).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
      )
      $rootPrefix = $normalizedRoot + [IO.Path]::DirectorySeparatorChar
      $normalizedCandidate = [IO.Path]::GetFullPath($CandidatePath)
      if (-not $normalizedCandidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }

      $currentPath = $normalizedRoot
      $currentItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
      if (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        return $true
      }

      $relativePath = $normalizedCandidate.Substring($rootPrefix.Length)
      $segments = @(
        $relativePath -split '[\\/]' | Where-Object {
          -not [string]::IsNullOrWhiteSpace($_)
        }
      )
      foreach ($segment in $segments) {
        $currentPath = Join-Path $currentPath $segment
        $currentItem = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
        if (($currentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          return $true
        }
      }

      return $false
    } catch {
      # Missing/inaccessible path components cannot be proven to remain inside
      # the managed tree. Fail closed and leave optional cleanup to a later run.
      return $true
    }
  }

  function Get-LegacyPythonProcesses {
    $userDataPath = [Environment]::GetEnvironmentVariable('JUSTDO_USER_DATA_ROOT', 'Process')
    if ([string]::IsNullOrWhiteSpace($userDataPath)) { return @() }

    $userDataRoot = [IO.Path]::GetFullPath($userDataPath).TrimEnd(
      [IO.Path]::DirectorySeparatorChar,
      [IO.Path]::AltDirectorySeparatorChar
    )
    $legacyPythonRoot =
      [IO.Path]::GetFullPath((Join-Path $userDataRoot 'runtimes\python-win')).TrimEnd(
        [IO.Path]::DirectorySeparatorChar,
        [IO.Path]::AltDirectorySeparatorChar
      ) + [IO.Path]::DirectorySeparatorChar

    @(
      Get-Process -ErrorAction Stop | Where-Object {
        try {
          $executablePath = [IO.Path]::GetFullPath($_.Path)
          $_.Id -ne $helperPid -and
          $_.Id -ne $callerPid -and
          -not [string]::IsNullOrWhiteSpace($_.Path) -and
          $executablePath.StartsWith(
            $legacyPythonRoot,
            [StringComparison]::OrdinalIgnoreCase
          ) -and
          -not (Test-PathChainContainsReparsePoint -RootPath $userDataRoot -CandidatePath $executablePath)
        } catch {
          $false
        }
      }
    )
  }

  switch ($Action) {
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
    'StopLegacyPython' {
      # This directory was managed by older releases and is no longer used by
      # the installed application. Stop only executables inside that exact
      # tree; never match every python.exe on the machine.
      $matched = @(Get-LegacyPythonProcesses)
      $matched | ForEach-Object {
        Stop-MatchedProcess $_
      }
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $remaining = @(Get-LegacyPythonProcesses)
        if ($remaining.Count -eq 0) {
          Write-Output "matched=$($matched.Count) remaining=0"
          exit 0
        }
        $remaining | ForEach-Object {
          Stop-MatchedProcess $_
        }
        Start-Sleep -Milliseconds 250
      }
      $remaining = @(Get-LegacyPythonProcesses)
      Write-Output "matched=$($matched.Count) remaining=$($remaining.Count)"
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
  # fall back to an exclusive-open probe of the installed executable. This
  # keeps a genuinely locked application blocking the upgrade without making
  # WMI/process API health a prerequisite for installation. Locks on any other
  # installed file are still reported by the old-version removal/copy step.
  if ($Action -in @('Find', 'Wait', 'Stop') -and
      -not [string]::IsNullOrWhiteSpace($installRoot)) {
    $locked = Test-AppExecutableLocked
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
