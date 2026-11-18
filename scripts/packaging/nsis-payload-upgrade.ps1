param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Prepare', 'Publish', 'Clean', 'Recover')]
  [string]$Action,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$Application,
  [Parameter(Mandatory = $true)][string]$Uninstaller,
  [string]$Authentication = '',
  [string]$RegisteredVersion = '',
  [string]$InstallKey = '',
  [string]$UninstallKey = ''
)

$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  if ($Action -eq 'Prepare') { exit 10 }
  exit 2
}
$Authentication = $Authentication -replace '^name:', ''
$RegisteredVersion = $RegisteredVersion -replace '^v', ''
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$work = [IO.Path]::Combine($root, '.upgrade')
$incoming = [IO.Path]::Combine($work, 'new')
$backup = [IO.Path]::Combine($work, 'old')
$ready = [IO.Path]::Combine($work, 'ready')
$plan = [IO.Path]::Combine($work, 'plan')
$switching = [IO.Path]::Combine($work, 'switching')
$published = [IO.Path]::Combine($work, 'published')
$committed = [IO.Path]::Combine($work, 'committed')
$directory = [IO.FileAttributes]::Directory
$reparse = [IO.FileAttributes]::ReparsePoint

$payloadDirectories = @('resources', 'locales')
$payloadFiles = @(
  $Application, $Uninstaller, $Authentication, 'electron.exe', 'justdo-cli.exe',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll',
  'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll',
  'libGLESv2.dll', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources.pak',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json',
  'vk_swiftshader.dll', 'vulkan-1.dll', '7zip-license.txt', '7zip-lgpl.txt', 'uninstallerIcon.ico'
)

function Get-Attributes([string]$Path) {
  try { return [IO.File]::GetAttributes($Path) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
}

function Assert-Directory([string]$Path) {
  $attributes = Get-Attributes $Path
  if (($attributes -band ($directory -bor $reparse)) -ne $directory) {
    throw "Expected a directory without a reparse point: $Path"
  }
}

function Assert-File([string]$Path) {
  $attributes = Get-Attributes $Path
  if ($null -eq $attributes -or ($attributes -band ($directory -bor $reparse)) -ne 0) {
    throw "Expected an ordinary file: $Path"
  }
}

function Get-PayloadEntries([string]$Path, [bool]$InstallDirectory) {
  Assert-Directory $Path
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Path)) {
    $name = [IO.Path]::GetFileName($entry)
    if ($InstallDirectory -and ($name -ieq 'logs' -or $name -ieq '.upgrade')) {
      Assert-Directory $entry
    } elseif ($name -in $payloadDirectories) {
      Assert-Directory $entry
      $name
    } elseif ($name -in $payloadFiles) {
      Assert-File $entry
      $name
    } else {
      throw "Unrecognized application entry: $name"
    }
  }
}

function Write-NewRecord([string]$Path, [string]$Value = '') {
  $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $file.Write($bytes, 0, $bytes.Length)
    $file.Flush($true)
  } finally {
    $file.Dispose()
  }
}

function Move-PayloadEntry([string]$From, [string]$To, [string]$Name) {
  $source = [IO.Path]::Combine($From, $Name)
  $target = [IO.Path]::Combine($To, $Name)
  Assert-Directory $From
  Assert-Directory $To
  if ($Name -in $payloadDirectories) {
    Assert-Directory $source
  } elseif ($Name -in $payloadFiles) {
    Assert-File $source
  } else {
    throw "Invalid upgrade entry: $Name"
  }
  [InstallerPayloadFiles]::Rename($source, $target)
}

function Remove-UpgradeDirectory([string]$Path) {
  if ($null -eq (Get-Attributes $Path)) { return }
  Assert-Directory $work
  Assert-Directory $Path
  [InstallerPayloadFiles]::DeleteStagedTree("\\?\$root", "\\?\$work", "\\?\$Path")
}

function Clear-Upgrade {
  Remove-UpgradeDirectory $incoming
  Remove-UpgradeDirectory $backup
  foreach ($record in @($plan, $switching, $published, $committed, $ready)) {
    if ($null -ne (Get-Attributes $record)) {
      Assert-File $record
      [IO.File]::Delete($record)
    }
  }
  [IO.Directory]::Delete($work, $false)
}

function Read-UpgradeRecord {
  Assert-Directory $work
  Assert-File $ready
  if ([IO.FileInfo]::new($ready).Length -gt 4096) { throw 'Invalid upgrade record.' }
  $record = [IO.File]::ReadAllText($ready) | ConvertFrom-Json
  if ($record.schema -ne 1 -or $record.root -ne $root -or
      $record.previousVersion -notmatch '\A[0-9]+\.[0-9]+\.[0-9]+\z') {
    throw 'Unrecognized upgrade state.'
  }
  return $record
}

function Test-RegisteredPayload {
  $installed = [IO.Path]::Combine($root, 'resources', '.justdo-nsis-installed')
  Assert-Directory ([IO.Path]::GetDirectoryName($installed))
  if ($null -eq (Get-Attributes $installed)) { return $false }
  Assert-File $installed
  return $RegisteredVersion -match '\A[0-9]+\.[0-9]+\.[0-9]+\z' -and
    [IO.FileInfo]::new($installed).Length -le 64 -and
    [IO.File]::ReadAllText($installed).Trim() -eq $RegisteredVersion
}

function Restore-Registration([string]$PreviousVersion) {
  if ($InstallKey -eq '' -or $UninstallKey -eq '') { return }
  $view = if ([Environment]::Is64BitOperatingSystem) { 'Registry64' } else { 'Default' }
  $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser', $view)
  try {
    $installRegistration = $hive.OpenSubKey($InstallKey)
    $uninstallRegistration = $hive.OpenSubKey($UninstallKey, $true)
    try {
      if ($null -eq $installRegistration -or $null -eq $uninstallRegistration -or
          [IO.Path]::GetFullPath([string]$installRegistration.GetValue('InstallLocation')).TrimEnd('\') -ne $root) {
        throw 'The original installation registration has changed.'
      }
      if ($uninstallRegistration.GetValue('DisplayVersion') -ne $PreviousVersion) {
        $uninstallRegistration.SetValue('DisplayVersion', $PreviousVersion, 'String')
      }
    } finally {
      if ($null -ne $installRegistration) { $installRegistration.Dispose() }
      if ($null -ne $uninstallRegistration) { $uninstallRegistration.Dispose() }
    }
  } finally { $hive.Dispose() }
}

function Clear-CommittedUpgrade {
  try { Clear-Upgrade }
  catch {
    [Console]::Error.WriteLine(($_.Exception.Message -replace '[\r\n]+', ' '))
    exit 13
  }
}

function Restore-Upgrade {
  Assert-Directory $work
  if ($null -eq (Get-Attributes $ready)) {
    [IO.Directory]::Delete($work, $false)
    return
  }
  $record = Read-UpgradeRecord
  if ($null -ne (Get-Attributes $committed)) {
    Assert-File $committed
    Clear-CommittedUpgrade
    return
  }
  if ($null -ne (Get-Attributes $published)) {
    Assert-File $published
    [IO.File]::Delete($published)
  }
  if ($null -ne (Get-Attributes $backup)) {
    Assert-Directory $backup
    if ($null -ne (Get-Attributes $switching)) {
      Assert-File $switching
      Assert-File $plan
      Assert-Directory $incoming
      if ([IO.FileInfo]::new($plan).Length -gt 8192) { throw 'Invalid upgrade plan.' }
      $entries = [IO.File]::ReadAllText($plan) | ConvertFrom-Json
      if ($entries.Count -eq 0 -or $entries.Count -gt ($payloadFiles.Count + $payloadDirectories.Count)) {
        throw 'Invalid upgrade plan.'
      }
      foreach ($entry in $entries) {
        $name = [string]$entry.name
        if ($name -notin $payloadFiles -and $name -notin $payloadDirectories) { throw 'Invalid upgrade name.' }
        $staged = [IO.Path]::Combine($incoming, $name)
        $visible = [IO.Path]::Combine($root, $name)
        if ($null -eq (Get-Attributes $staged)) {
          if ([InstallerPayloadFiles]::Identity($visible) -ne $entry.id) {
            throw "A published entry was replaced during upgrade: $name"
          }
          Move-PayloadEntry $root $incoming $name
        } elseif ([InstallerPayloadFiles]::Identity($staged) -ne $entry.id) {
          throw "A staged entry was replaced during upgrade: $name"
        }
      }
      [IO.File]::Delete($switching)
    }
    foreach ($name in @(Get-PayloadEntries $backup $false)) {
      Move-PayloadEntry $backup $root $name
    }
  }
  Restore-Registration $record.previousVersion
  Clear-Upgrade
}

try {
  if ($InstallRoot -notmatch '\A[A-Za-z]:\\' -or $root.Length -le 3) {
    throw 'Payload upgrades require a local application directory.'
  }
  for ($ancestor = [IO.DirectoryInfo]::new($root); $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    Assert-Directory $ancestor.FullName
  }
  if ($Action -eq 'Prepare') {
    if ($null -ne (Get-Attributes $work)) { throw "Upgrade state already exists: $work" }
    $null = @(Get-PayloadEntries $root $true)
    Assert-File ([IO.Path]::Combine($root, $Application))
    Assert-File ([IO.Path]::Combine($root, $Uninstaller))
    if (-not (Test-RegisteredPayload) -or [version]$RegisteredVersion -lt [version]'2026.11.5') { exit 10 }
    # NSIS can leave a manual uninstall running in a copied executable after
    # its original launcher exits. The installer guards the original image.
    foreach ($process in @(Get-Process -Name 'Un_?' -ErrorAction SilentlyContinue)) {
      $processPath = $process.Path
      if ($processPath -and [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($processPath)) -match '\A~nsuA?\.tmp\z' -and
          $process.FileVersionInfo.ProductName -eq [IO.Path]::GetFileNameWithoutExtension($Application)) {
        throw 'The previous uninstaller is still running.'
      }
    }
  }
  try { Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'nsis-payload-files.cs')) }
  catch {
    if ($Action -eq 'Prepare') { exit 10 }
    throw
  }
  switch ($Action) {
    'Prepare' {
      New-Item -Path $work -ItemType Directory | Out-Null
      Write-NewRecord $ready (@{ schema = 1; root = $root; previousVersion = $RegisteredVersion } | ConvertTo-Json -Compress)
      [IO.Directory]::CreateDirectory($incoming) | Out-Null
      [IO.Directory]::CreateDirectory($backup) | Out-Null
    }
    'Publish' {
      $null = Read-UpgradeRecord
      Assert-Directory $backup
      Assert-File ([IO.Path]::Combine($root, $Application))
      Assert-File ([IO.Path]::Combine($root, $Uninstaller))
      $oldNames = @(Get-PayloadEntries $root $true)
      $newNames = @(Get-PayloadEntries $incoming $false)
      Assert-File ([IO.Path]::Combine($incoming, $Application))
      Assert-File ([IO.Path]::Combine($incoming, $Uninstaller))
      Assert-File ([IO.Path]::Combine($incoming, 'resources', '.justdo-nsis-installed'))
      $entries = @($newNames | ForEach-Object {
        @{ name = $_; id = [InstallerPayloadFiles]::Identity([IO.Path]::Combine($incoming, $_)) }
      })
      Write-NewRecord $plan (ConvertTo-Json -InputObject $entries -Compress)
      try {
        foreach ($name in $oldNames) { Move-PayloadEntry $root $backup $name }
        Write-NewRecord $switching
        foreach ($name in $newNames) { Move-PayloadEntry $incoming $root $name }
        Write-NewRecord $published
      } catch {
        $failure = $_
        Restore-Upgrade
        throw $failure
      }
    }
    'Clean' {
      $null = Read-UpgradeRecord
      Assert-File $published
      if (-not (Test-RegisteredPayload)) { exit 11 }
      Write-NewRecord $committed
      Clear-CommittedUpgrade
    }
    'Recover' {
      if ($null -ne (Get-Attributes $work)) { Restore-Upgrade }
    }
  }
} catch {
  [Console]::Error.WriteLine(($_.Exception.Message -replace '[\r\n]+', ' '))
  exit 2
}
exit 0
