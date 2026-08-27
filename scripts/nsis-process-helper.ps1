param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Find', 'Wait', 'Stop', 'StopLegacyPython', 'StageRuntimes', 'RestoreRuntimes')]
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
  $helperPid = $PID

  function Get-InstalledProcesses {
    @(
      Get-CimInstance Win32_Process | Where-Object {
        try {
          $_.ProcessId -ne $helperPid -and
          $_.ProcessId -ne $callerPid -and
          -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
          [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
            $installRoot,
            [StringComparison]::OrdinalIgnoreCase
          )
        } catch {
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
      Get-CimInstance Win32_Process | Where-Object {
        try {
          $executablePath = [IO.Path]::GetFullPath($_.ExecutablePath)
          $_.ProcessId -ne $helperPid -and
          $_.ProcessId -ne $callerPid -and
          -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
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

  $managedRuntimeNames = @('cfmind', 'mingit', 'python-win')
  $installDirectory = $installRoot.TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $runtimeStagingRoot = "$installDirectory.justdo-runtime-staging"

  function Assert-SafeRuntimeStagingRoot {
    if (Test-Path -LiteralPath $runtimeStagingRoot) {
      $stagingItem = Get-Item -LiteralPath $runtimeStagingRoot -Force
      if (-not $stagingItem.PSIsContainer) {
        throw 'Runtime staging target exists but is not a directory.'
      }
      if (($stagingItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Runtime staging directory must not be a reparse point.'
      }
    }
  }

  function Restore-StagedRuntimes {
    Assert-SafeRuntimeStagingRoot
    if (-not (Test-Path -LiteralPath $runtimeStagingRoot)) { return @() }

    $restored = [Collections.Generic.List[string]]::new()
    foreach ($runtimeName in $managedRuntimeNames) {
      $stagedPath = Join-Path $runtimeStagingRoot $runtimeName
      if (-not (Test-Path -LiteralPath $stagedPath)) { continue }
      $destinationPath = Join-Path (Join-Path $installDirectory 'resources') $runtimeName
      if (Test-Path -LiteralPath $destinationPath) {
        throw "Runtime restore destination already exists: $runtimeName"
      }
      [IO.Directory]::CreateDirectory((Split-Path -Parent $destinationPath)) | Out-Null
      Move-Item -LiteralPath $stagedPath -Destination $destinationPath
      $restored.Add($runtimeName)
    }

    $unknownEntries = @(Get-ChildItem -LiteralPath $runtimeStagingRoot -Force)
    if ($unknownEntries.Count -gt 0) {
      throw 'Runtime staging directory contains unexpected entries.'
    }
    Remove-Item -LiteralPath $runtimeStagingRoot -Force
    return $restored.ToArray()
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
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
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
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      }
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $remaining = @(Get-LegacyPythonProcesses)
        if ($remaining.Count -eq 0) {
          Write-Output "matched=$($matched.Count) remaining=0"
          exit 0
        }
        $remaining | ForEach-Object {
          Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Milliseconds 250
      }
      $remaining = @(Get-LegacyPythonProcesses)
      Write-Output "matched=$($matched.Count) remaining=$($remaining.Count)"
      exit 1
    }
    'StageRuntimes' {
      # Recover a prior interrupted staging operation first. Moving whole
      # directories beside $INSTDIR is same-volume and avoids the old
      # electron-builder uninstaller walking tens of thousands of runtime files.
      [void](Restore-StagedRuntimes)
      [IO.Directory]::CreateDirectory($runtimeStagingRoot) | Out-Null
      Assert-SafeRuntimeStagingRoot
      $moved = [Collections.Generic.List[string]]::new()
      try {
        foreach ($runtimeName in $managedRuntimeNames) {
          $sourcePath = Join-Path (Join-Path $installDirectory 'resources') $runtimeName
          if (-not (Test-Path -LiteralPath $sourcePath)) { continue }
          $destinationPath = Join-Path $runtimeStagingRoot $runtimeName
          if (Test-Path -LiteralPath $destinationPath) {
            throw "Runtime staging destination already exists: $runtimeName"
          }
          Move-Item -LiteralPath $sourcePath -Destination $destinationPath
          $moved.Add($runtimeName)
        }
      } catch {
        for ($index = $moved.Count - 1; $index -ge 0; $index--) {
          $runtimeName = $moved[$index]
          $stagedPath = Join-Path $runtimeStagingRoot $runtimeName
          $sourcePath = Join-Path (Join-Path $installDirectory 'resources') $runtimeName
          if ((Test-Path -LiteralPath $stagedPath) -and -not (Test-Path -LiteralPath $sourcePath)) {
            Move-Item -LiteralPath $stagedPath -Destination $sourcePath
          }
        }
        throw
      }
      if ($moved.Count -eq 0) {
        Remove-Item -LiteralPath $runtimeStagingRoot -Force
      }
      Write-Output "staged=$($moved -join ',')"
      exit 0
    }
    'RestoreRuntimes' {
      $restored = @(Restore-StagedRuntimes)
      Write-Output "restored=$($restored -join ',')"
      exit 0
    }
  }
} catch {
  # Keep diagnostics single-line and path-free so NSIS can record the failure
  # without exposing command lines or process metadata.
  $exceptionType = $_.Exception.GetType().FullName
  $hresult = $_.Exception.HResult
  Write-Output "error-type=$exceptionType hresult=$hresult category=$($_.CategoryInfo.Category)"
  exit 2
}
