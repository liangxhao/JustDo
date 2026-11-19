param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Prepare', 'Publish', 'Clean', 'Recover', 'DiscardStaging', 'CheckLegacyRemoval')]
  [string]$Action,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$Application,
  [Parameter(Mandatory = $true)][string]$Uninstaller,
  [Parameter(Mandatory = $true)][string]$AgentCli,
  [string]$Authentication = '',
  [string]$RegisteredVersion = '',
  [string]$InstallKey = '',
  [string]$UninstallKey = '',
  [string]$StagingSlot = ''
)

$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Output 'step=load-file-operations message=Windows PowerShell does not allow the same-volume upgrade helper.'
  exit 2
}
$Authentication = $Authentication -replace '^name:', ''
$RegisteredVersion = $RegisteredVersion -creplace '^v', ''
$StagingSlot = $StagingSlot -creplace '^slot:', ''
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($StagingSlot -ne '' -and $StagingSlot -cnotmatch '\A[01]\z') { exit 2 }
$stagingDirectories = @('.upgrade', '.upgrade-next')
$work = [IO.Path]::Combine($root, $stagingDirectories[([int]$StagingSlot)])
$incoming = [IO.Path]::Combine($work, 'new')
$backup = [IO.Path]::Combine($work, 'old')
$ready = [IO.Path]::Combine($work, 'ready')
$plan = [IO.Path]::Combine($work, 'plan')
$switching = [IO.Path]::Combine($work, 'switching')
$published = [IO.Path]::Combine($work, 'published')
$committed = [IO.Path]::Combine($work, 'committed')
$directory = [IO.FileAttributes]::Directory
$reparse = [IO.FileAttributes]::ReparsePoint
$planSizeLimit = 128KB

$payloadDirectories = [Collections.Generic.HashSet[string]]::new([string[]]@('resources', 'locales'), [StringComparer]::OrdinalIgnoreCase)
$payloadFiles = [Collections.Generic.HashSet[string]]::new([string[]]@(
  $Application, $Uninstaller, $AgentCli, $Authentication, 'electron.exe',
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll',
  'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll',
  'libGLESv2.dll', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources.pak',
  'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json',
  'vk_swiftshader.dll', 'vulkan-1.dll', '7zip-license.txt', '7zip-lgpl.txt', 'uninstallerIcon.ico'
), [StringComparer]::OrdinalIgnoreCase)

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

function Assert-PayloadName([string]$Name) {
  if ($Name -eq '' -or $Name.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
      $Name.EndsWith('.') -or $Name.EndsWith(' ') -or $Name -in $stagingDirectories -or
      $Name -match '\A(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9\u00b9\u00b2\u00b3]) *(?:\.|\z)') {
    throw "Invalid upgrade entry name: $Name"
  }
}

function Assert-OrdinaryEntry([string]$Path) {
  $attributes = Get-Attributes $Path
  if ($null -eq $attributes -or ($attributes -band $reparse) -ne 0) {
    throw "Expected an ordinary file or directory: $Path"
  }
}

function Get-StagedPayloadNames {
  Assert-Directory $incoming
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($incoming)) {
    $name = [IO.Path]::GetFileName($entry)
    Assert-PayloadName $name
    if ($payloadDirectories.Contains($name)) {
      Assert-Directory $entry
    } elseif ($payloadFiles.Contains($name)) {
      Assert-File $entry
    } else {
      Assert-OrdinaryEntry $entry
    }
    $name
  }
}

function Get-PreviousPayloadNames([string]$Path, [Collections.Generic.Dictionary[string, string]]$ReplacementNames, [switch]$Backup) {
  Assert-Directory $Path
  foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($Path)) {
    $name = [IO.Path]::GetFileName($entry)
    $replacementName = ''
    if ($payloadDirectories.Contains($name)) {
      Assert-Directory $entry
    } elseif ($payloadFiles.Contains($name)) {
      Assert-File $entry
    } elseif ($ReplacementNames.TryGetValue($name, [ref]$replacementName) -and (
        [StringComparer]::Ordinal.Equals($name, $replacementName) -or
        (Test-SamePayloadEntry $entry ([IO.Path]::Combine($Path, $replacementName))))) {
      Assert-OrdinaryEntry $entry
      if (((Get-Attributes $entry) -band $directory) -ne 0) {
        throw "An existing directory outside the program layout cannot be replaced safely: $entry"
      }
    } elseif ($Backup) {
      throw "Unexpected backup entry; its contents were preserved: $entry"
    } else {
      continue
    }
    $name
  }
}

function Test-SamePayloadEntry([string]$First, [string]$Second) {
  $attributes = Get-Attributes $Second
  if ($null -eq $attributes) { return $false }
  if (($attributes -band $reparse) -ne 0) { throw "Cannot replace a link at the staged destination: $Second" }
  $attributes = Get-Attributes $First
  return $null -ne $attributes -and ($attributes -band $reparse) -eq 0 -and
    [InstallerPayloadFiles]::Identity($First) -eq [InstallerPayloadFiles]::Identity($Second)
}

function Assert-LegacyRemovalSafe {
  $directories = [Collections.Generic.Stack[string]]::new()
  foreach ($entry in [IO.DirectoryInfo]::new($root).EnumerateFileSystemInfos()) {
    if (-not $payloadFiles.Contains($entry.Name) -and -not $payloadDirectories.Contains($entry.Name) -and
        -not [StringComparer]::OrdinalIgnoreCase.Equals($entry.Name, 'logs')) {
      throw "Unrecognized application entry: $($entry.Name). Conventional upgrade could remove it; nothing was removed."
    }
    if (($entry.Attributes -band $reparse) -ne 0) { throw "Conventional upgrade cannot safely remove a link: $($entry.FullName)" }
    $isDirectory = ($entry.Attributes -band $directory) -ne 0
    if ($isDirectory -ne (-not $payloadFiles.Contains($entry.Name))) {
      throw "Unexpected file type at $($entry.FullName). Conventional upgrade could remove it; nothing was removed."
    }
    if ($isDirectory) { $directories.Push($entry.FullName) }
  }
  while ($directories.Count -ne 0) {
    foreach ($entry in [IO.DirectoryInfo]::new("\\?\$($directories.Pop())").EnumerateFileSystemInfos()) {
      if (($entry.Attributes -band $reparse) -ne 0) { throw "Conventional upgrade cannot safely remove a link: $($entry.FullName)" }
      if (($entry.Attributes -band $directory) -ne 0) { $directories.Push($entry.FullName.Substring(4)) }
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
  Assert-PayloadName $Name
  $source = [IO.Path]::Combine($From, $Name)
  $target = [IO.Path]::Combine($To, $Name)
  Assert-Directory $From
  Assert-Directory $To
  Assert-OrdinaryEntry $source
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
  foreach ($record in @($plan, $switching, $published, $ready, $committed)) {
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
  if ($record.schema -notin @(1, 2) -or -not [StringComparer]::OrdinalIgnoreCase.Equals([string]$record.root, $root) -or
      $record.previousVersion -isnot [string]) {
    throw 'Unrecognized upgrade state.'
  }
  return $record
}

function Get-UniquePayloadNames([string[]]$Names) {
  $unique = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($name in $Names) {
    if ($unique.ContainsKey($name)) { throw "Ambiguous upgrade entry name: $name" }
    $unique.Add($name, $name)
  }
  return ,$unique
}

function Assert-SwitchEntries([object[]]$Entries) {
  $null = Get-UniquePayloadNames @($Entries | ForEach-Object { [string]$_.name })
  foreach ($entry in $Entries) {
    Assert-PayloadName ([string]$entry.name)
    if ([string]$entry.id -notmatch '\A[0-9]+\z') { throw "Invalid upgrade entry identity: $($entry.name)" }
  }
}

function Get-PayloadIdentity([string]$Path, [string]$Name) {
  Assert-PayloadName $Name
  return @{ name = $Name; id = [InstallerPayloadFiles]::Identity([IO.Path]::Combine($Path, $Name)) }
}

function Test-RegisteredPayload([string]$ExpectedVersion = $RegisteredVersion) {
  $installed = [IO.Path]::Combine($root, 'resources', '.justdo-nsis-installed')
  $resources = [IO.Path]::GetDirectoryName($installed)
  if ($null -eq (Get-Attributes $resources)) { return $false }
  Assert-Directory $resources
  if ($null -eq (Get-Attributes $installed)) { return $false }
  Assert-File $installed
  return $ExpectedVersion -match '\A[0-9]+\.[0-9]+\.[0-9]+\z' -and
    [IO.FileInfo]::new($installed).Length -le 64 -and
    [IO.File]::ReadAllText($installed).Trim() -eq $ExpectedVersion
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
      if ($PreviousVersion -eq '') {
        $uninstallRegistration.DeleteValue('DisplayVersion', $false)
      } elseif ($uninstallRegistration.GetValue('DisplayVersion') -cne $PreviousVersion) {
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
    Write-UpgradeDetail 'remove-staged-backup' (Get-UpgradeErrorMessage $_.Exception)
    exit 13
  }
}

function Write-UpgradeDetail([string]$Step, [string]$Message) {
  [Console]::Error.WriteLine("step=$Step message=" + ($Message -replace '[\x00-\x1f\x7f]+', ' '))
}

function Get-UpgradeErrorMessage([Exception]$ErrorObject) {
  while ($null -ne $ErrorObject.InnerException) { $ErrorObject = $ErrorObject.InnerException }
  if ($ErrorObject -is [ComponentModel.Win32Exception]) {
    $nativeCode = $ErrorObject.NativeErrorCode
    return "$($ErrorObject.Message) (Windows error $nativeCode): $([ComponentModel.Win32Exception]::new($nativeCode).Message)"
  }
  return $ErrorObject.Message
}

function Restore-Upgrade([switch]$DiscardOnly) {
  Assert-Directory $work
  $records = [Collections.Generic.HashSet[string]]::new([string[]]@('new', 'old', 'ready', 'plan', 'switching', 'published', 'committed'), [StringComparer]::Ordinal)
  $contents = @([IO.Directory]::EnumerateFileSystemEntries($work))
  foreach ($entry in $contents) {
    if (-not $records.Contains([IO.Path]::GetFileName($entry))) {
      throw "Unexpected entry in the upgrade staging directory; the contents were preserved: $entry"
    }
    if (($entry -ceq $incoming) -or ($entry -ceq $backup)) {
      Assert-Directory $entry
    } else {
      Assert-File $entry
    }
  }
  if ($null -eq (Get-Attributes $ready)) {
    if ($contents.Count -eq 1 -and [StringComparer]::Ordinal.Equals($contents[0], $committed)) {
      Clear-CommittedUpgrade
      return
    } elseif ($contents.Count -ne 0) {
      throw "Upgrade recovery record is missing; the contents were preserved: $work"
    }
    [IO.Directory]::Delete($work, $false)
    return
  }
  $record = Read-UpgradeRecord
  if ($null -ne (Get-Attributes $committed)) {
    Assert-File $committed
    Clear-CommittedUpgrade
    return
  }
  $wasPublished = $contents.Contains($published)
  $wasSwitching = $contents.Contains($switching)
  $hasBackup = $contents.Contains($backup)
  $backupNames = @()
  if ($hasBackup) {
    $backupNames = @([IO.Directory]::EnumerateFileSystemEntries($backup) | ForEach-Object { [IO.Path]::GetFileName($_) })
  }
  $switchPlan = $null
  if ($record.schema -eq 2 -and $contents.Contains($plan)) {
    try {
      if ([IO.FileInfo]::new($plan).Length -gt $planSizeLimit) { throw 'Upgrade plan exceeds the recovery size limit.' }
      $switchPlan = [IO.File]::ReadAllText($plan) | ConvertFrom-Json
      if ($null -eq $switchPlan.old -or $null -eq $switchPlan.new) { throw 'Invalid upgrade switch plan.' }
      Assert-SwitchEntries @($switchPlan.old)
      Assert-SwitchEntries @($switchPlan.new)
    } catch {
      if ($wasPublished -or $wasSwitching -or $backupNames.Count -ne 0 -or -not $hasBackup) { throw }
      $switchPlan = $null
    }
  }
  if ($DiscardOnly) {
    if ($wasPublished -or $wasSwitching -or $backupNames.Count -gt 0) {
      throw 'This upgrade requires recovery by the original installation user without elevation.'
    }
  }
  if (($wasSwitching -or $wasPublished) -and -not $hasBackup) {
    throw 'The upgrade backup directory is missing; the upgrade state was preserved.'
  }
  if ($hasBackup -or $null -ne $switchPlan) {
    $entries = @()
    if ($null -ne $switchPlan -or $wasSwitching -or ($record.schema -eq 2 -and ($wasPublished -or $backupNames.Count -gt 0))) {
      if (-not $contents.Contains($plan)) { throw 'The upgrade switch plan is missing; the backup was preserved.' }
      if ([IO.FileInfo]::new($plan).Length -gt $planSizeLimit) { throw 'Upgrade plan exceeds the recovery size limit.' }
      if ($record.schema -eq 2) {
        if ($null -eq $switchPlan) { throw 'Invalid upgrade switch plan.' }
        $entries = @($switchPlan.new)
        $expectedBackup = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
        foreach ($entry in $switchPlan.old) { $expectedBackup.Add([string]$entry.name, [string]$entry.id) }
        $actualBackup = [Collections.Generic.HashSet[string]]::new([string[]]$backupNames, [StringComparer]::Ordinal)
        foreach ($name in $backupNames) {
          $backupEntry = [IO.Path]::Combine($backup, $name)
          if (-not $expectedBackup.ContainsKey($name) -or
              [InstallerPayloadFiles]::Identity($backupEntry) -ne $expectedBackup[$name]) {
            throw "An upgrade backup entry is unknown or was replaced; the backup was preserved: $backupEntry"
          }
        }
        foreach ($name in $expectedBackup.Keys) {
          if (-not $actualBackup.Contains($name)) {
            $restored = [IO.Path]::Combine($root, $name)
            if ($null -eq (Get-Attributes $restored) -or
                [InstallerPayloadFiles]::Identity($restored) -ne $expectedBackup[$name]) {
              throw "An original upgrade entry is missing or was replaced; the backup was preserved: $restored"
            }
          }
        }
      } else {
        $entries = @(([IO.File]::ReadAllText($plan) | ConvertFrom-Json))
      }
      if ($entries.Count -eq 0) { throw 'Upgrade plan is empty.' }
      Assert-SwitchEntries $entries
    }
    if ($record.schema -eq 1 -and $hasBackup) {
      foreach ($entry in $entries) {
        if (-not $payloadFiles.Contains($entry.name) -and -not $payloadDirectories.Contains($entry.name)) {
          throw "Invalid legacy upgrade entry: $($entry.name)"
        }
      }
      $backupNames = @(Get-PreviousPayloadNames $backup (Get-UniquePayloadNames @()) -Backup)
    }
    if ($wasSwitching) {
      Assert-Directory $incoming
      foreach ($entry in $entries) {
        $name = [string]$entry.name
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
    foreach ($name in $backupNames) {
      Move-PayloadEntry $backup $root $name
    }
  }
  if ($wasPublished -or ($record.schema -eq 1 -and $contents.Contains($plan) -and
      (Test-RegisteredPayload $record.previousVersion))) {
    Restore-Registration $record.previousVersion
  }
  if ($wasPublished) { [IO.File]::Delete($published) }
  Clear-Upgrade
}

$step = 'validate-installation-path'
try {
  if ($InstallRoot -notmatch '\A[A-Za-z]:\\' -or $root.Length -le 3) {
    throw 'Payload upgrades require a local application directory.'
  }
  for ($ancestor = [IO.DirectoryInfo]::new($root); $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    Assert-Directory $ancestor.FullName
  }
  if ($Action -in @('Recover', 'DiscardStaging') -and $null -eq (Get-Attributes $work)) { exit 0 }
  if ($Action -eq 'CheckLegacyRemoval') {
    $step = 'check-installed-payload-for-legacy-removal'
    Assert-LegacyRemovalSafe
    exit 0
  }
  if ($Action -eq 'Prepare') {
    $step = 'check-staging-state'
    if ($null -ne (Get-Attributes $work)) { throw "Upgrade staging still exists after recovery or was created by another process: $work" }
    $step = 'check-installed-payload'
    Assert-File ([IO.Path]::Combine($root, $Application))
    Assert-File ([IO.Path]::Combine($root, $Uninstaller))
    $step = 'check-previous-uninstaller'
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
  $step = 'load-file-operations'
  try { Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'nsis-payload-files.cs')) }
  catch {
    if ($Action -eq 'Prepare') {
      $failure = $_
      Write-UpgradeDetail 'load-file-operations' $failure.Exception.Message
      exit 10
    }
    throw
  }
  switch ($Action) {
    'Prepare' {
      $step = 'create-staging-directory'
      New-Item -Path $work -ItemType Directory | Out-Null
      $step = 'write-upgrade-record'
      Write-NewRecord $ready (@{ schema = 2; root = $root; previousVersion = $RegisteredVersion } | ConvertTo-Json -Compress)
      $step = 'create-staging-subdirectories'
      [IO.Directory]::CreateDirectory($incoming) | Out-Null
      [IO.Directory]::CreateDirectory($backup) | Out-Null
    }
    'Publish' {
      $step = 'check-payload-before-switch'
      $record = Read-UpgradeRecord
      if ($record.schema -ne 2) { throw 'Recover the previous upgrade before switching a new payload.' }
      Assert-Directory $backup
      $newNames = @(Get-StagedPayloadNames)
      Assert-File ([IO.Path]::Combine($incoming, $Application))
      Assert-File ([IO.Path]::Combine($incoming, $Uninstaller))
      Assert-File ([IO.Path]::Combine($incoming, 'resources', '.justdo-nsis-installed'))
      $replacementNames = Get-UniquePayloadNames $newNames
      $oldNames = @(Get-PreviousPayloadNames $root $replacementNames)
      $null = Get-UniquePayloadNames $oldNames
      $oldEntries = @($oldNames | ForEach-Object { Get-PayloadIdentity $root $_ })
      $newEntries = @($newNames | ForEach-Object { Get-PayloadIdentity $incoming $_ })
      $step = 'write-switch-plan'
      $planJson = ConvertTo-Json -InputObject @{ old = $oldEntries; new = $newEntries } -Compress
      if ([Text.Encoding]::UTF8.GetByteCount($planJson) -gt $planSizeLimit) {
        throw 'Upgrade plan exceeds the recovery size limit.'
      }
      Write-NewRecord $plan $planJson
      $step = 'switch-payload'
      try {
        foreach ($name in $oldNames) { Move-PayloadEntry $root $backup $name }
        Write-NewRecord $switching
        foreach ($name in $newNames) { Move-PayloadEntry $incoming $root $name }
        Write-NewRecord $published
      } catch {
        $failure = $_
        try { Restore-Upgrade }
        catch { throw "$(Get-UpgradeErrorMessage $failure.Exception) Recovery needs attention: $(Get-UpgradeErrorMessage $_.Exception)" }
        throw $failure
      }
    }
    'Clean' {
      $step = 'commit-upgrade'
      $null = Read-UpgradeRecord
      Assert-File $published
      if (-not (Test-RegisteredPayload)) {
        Write-UpgradeDetail $step 'Installed payload marker does not match the registered version.'
        exit 11
      }
      Write-NewRecord $committed
      Clear-CommittedUpgrade
    }
    'Recover' {
      $step = 'restore-previous-payload'
      if ($null -ne (Get-Attributes $work)) { Restore-Upgrade }
    }
    'DiscardStaging' {
      $step = 'discard-unused-staging'
      Restore-Upgrade -DiscardOnly
    }
  }
} catch {
  Write-UpgradeDetail $step (Get-UpgradeErrorMessage $_.Exception)
  exit 2
}
exit 0
