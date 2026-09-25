param(
  [Parameter(Mandatory = $true)]
  [string]$Names,
  [switch]$RequireDesktopUser
)

$ErrorActionPreference = 'Stop'

# A directly elevated uninstaller has no UAC outer process to route through.
# Only remove its profile data when that account owns this session's desktop.
# Failure is limited to optional data cleanup; uninstalling the app continues.
if ($RequireDesktopUser) {
  try {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $currentSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
    $desktopOwners = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'explorer.exe' AND SessionId = $currentSession" | ForEach-Object {
      (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid
    } | Where-Object { $_ } | Select-Object -Unique)
    if ($desktopOwners.Count -ne 1 -or $desktopOwners[0] -ne $currentSid) {
      throw 'The desktop account differs from the elevated account or is unavailable.'
    }
  } catch {
    [Console]::Error.WriteLine('User data was preserved because the desktop account could not be confirmed.')
    exit 3
  }
}

function Remove-SafeTree {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not [IO.Directory]::Exists($Path) -and -not [IO.File]::Exists($Path)) { return }

  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if ($item.PSIsContainer) {
      [IO.Directory]::Delete($item.FullName, $false)
    } else {
      [IO.File]::Delete($item.FullName)
    }
    return
  }

  if (-not $item.PSIsContainer) {
    [IO.File]::SetAttributes($item.FullName, [IO.FileAttributes]::Normal)
    [IO.File]::Delete($item.FullName)
    return
  }

  foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($item.FullName)) {
    Remove-SafeTree -Path $child
  }
  [IO.Directory]::Delete($item.FullName, $false)
}

$validatedNames = @(($Names -split '\|') | Select-Object -Unique | ForEach-Object {
  if ($_ -notmatch '\A[A-Za-z0-9._-]{1,64}\z' -or $_ -in '.', '..') {
    throw "Unsafe application data directory name: $_"
  }
  $_
})

$failures = [Collections.Generic.List[string]]::new()
foreach ($basePath in @($env:APPDATA, $env:LOCALAPPDATA)) {
  if ([string]::IsNullOrWhiteSpace($basePath)) {
    $failures.Add('<missing user data base>')
    continue
  }

  $baseFullPath = [IO.Path]::GetFullPath($basePath).TrimEnd('\')
  foreach ($name in $validatedNames) {
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($baseFullPath, $name))
    if (-not [string]::Equals([IO.Path]::GetDirectoryName($target), $baseFullPath, [StringComparison]::OrdinalIgnoreCase)) {
      $failures.Add($target)
      continue
    }

    try {
      Remove-SafeTree -Path $target
    } catch {
      $failures.Add($target)
    }
  }
}

if ($failures.Count -gt 0) {
  [Console]::Error.WriteLine(($failures | Select-Object -Unique) -join [Environment]::NewLine)
  exit 2
}

exit 0
