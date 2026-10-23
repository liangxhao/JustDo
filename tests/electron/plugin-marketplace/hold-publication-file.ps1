param(
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Ready,
  [Parameter(Mandatory=$true)][string]$Release,
  [Parameter(Mandatory=$true)][string]$Closed,
  [int]$ShareMode = 3,
  [int]$MaxHoldMs = 30000
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$handle = $null
$timedOut = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PublicationLockHandle {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFileW(
    string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
    uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);
}
'@
  # FILE_READ_ATTRIBUTES, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS. The
  # no-delete experiment uses share 3; the delete-pending control uses share 7.
  $handle = [PublicationLockHandle]::CreateFileW($Target, 0x80, $ShareMode, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
  if ($handle.IsInvalid) {
    throw New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $data = @{ success=$true; pid=$PID; target=$Target; shareMode=$ShareMode; sharesDelete=(($ShareMode -band 4) -ne 0); access=0x80 }
  [IO.File]::WriteAllText($Ready, (ConvertTo-Json -InputObject $data -Compress), $utf8)
  $deadline = [DateTime]::UtcNow.AddMilliseconds($MaxHoldMs)
  while (-not (Test-Path -LiteralPath $Release)) {
    if ([DateTime]::UtcNow -ge $deadline) { $timedOut=$true; break }
    Start-Sleep -Milliseconds 20
  }
} catch {
  $data = @{ success=$false; pid=$PID; target=$Target; error=$_.Exception.Message }
  [IO.File]::WriteAllText($Ready, (ConvertTo-Json -InputObject $data -Compress), $utf8)
  throw
} finally {
  if ($null -ne $handle) { $handle.Dispose() }
  $data = @{ pid=$PID; timedOut=$timedOut; released=(Test-Path -LiteralPath $Release) }
  [IO.File]::WriteAllText($Closed, (ConvertTo-Json -InputObject $data -Compress), $utf8)
}
