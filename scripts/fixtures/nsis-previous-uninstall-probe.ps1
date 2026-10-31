param([Parameter(Mandatory=$true)][string]$Executable,
      [Parameter(Mandatory=$true)][string]$FixtureRoot)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PreviousRemovalProbe {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent, int id);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public static IntPtr Find(uint wanted) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window, parameter)=>{uint pid;GetWindowThreadProcessId(window,out pid);if(pid==wanted && IsWindowVisible(window)){found=window;return false;}return true;},IntPtr.Zero);
    return found;
  }
}
'@

function Assert-Condition([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Wait-Condition([scriptblock]$Condition, [string]$Message) {
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 20
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $Message
}

foreach ($case in @('exit', 'launch', 'success')) {
  foreach ($name in @('result.txt', 'terminal.txt', 'events.txt', 'new-files-written.txt')) {
    $filePath = Join-Path $FixtureRoot $name
    if (Test-Path -LiteralPath $filePath) { Remove-Item -LiteralPath $filePath }
  }
  $process = Start-Process -FilePath $Executable -ArgumentList "/case=$case" -WindowStyle Hidden -PassThru
  try {
    Wait-Condition { $script:window = [PreviousRemovalProbe]::Find($process.Id); $script:window -ne [IntPtr]::Zero } 'The directory page never appeared.'
    $next = [PreviousRemovalProbe]::GetDlgItem($window, 1)
    Assert-Condition ([PreviousRemovalProbe]::IsWindowEnabled($next)) 'Install action was disabled.'
    [PreviousRemovalProbe]::PostMessage($window, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
    $resultPath = Join-Path $FixtureRoot 'result.txt'
    Wait-Condition {
      try { $script:result = [IO.File]::ReadAllText($resultPath); return $script:result.Contains('|') }
      catch [IO.IOException] { return $false }
    } 'The worker did not reach a native result.'
    $process.Refresh()
    Assert-Condition (-not $process.HasExited) "Setup exited instead of retaining the $case result."
    Assert-Condition ([PreviousRemovalProbe]::IsWindowVisible($window)) "The $case result was hidden."
    $events = [IO.File]::ReadAllText((Join-Path $FixtureRoot 'events.txt'))
    $wroteFiles = Test-Path -LiteralPath (Join-Path $FixtureRoot 'new-files-written.txt')
    if ($case -eq 'success') {
      Assert-Condition ($result -eq 'success|0') "Unexpected success result: $result"
      Assert-Condition $wroteFiles 'A successful previous uninstall did not continue.'
      Assert-Condition ($events.Contains('result=success exit=0')) 'Successful removal was not logged.'
      Wait-Condition { [PreviousRemovalProbe]::IsWindowEnabled([PreviousRemovalProbe]::GetDlgItem($window, 1)) } 'The success result did not become actionable.'
      [PreviousRemovalProbe]::PostMessage($window, 0x0111, [IntPtr]1, [IntPtr]::Zero) | Out-Null
    } else {
      Assert-Condition ($result.StartsWith('failed|')) "Unexpected failure result: $result"
      Assert-Condition (-not $wroteFiles) "Setup wrote new files after the $case failure."
      if ($case -eq 'exit') {
        Assert-Condition ($events.Contains('root=SHELL_CONTEXT result=failed reason=uninstaller-exit exit=17')) 'The real child exit code was lost.'
      } else {
        Assert-Condition ($events.Contains('root=HKEY_CURRENT_USER result=failed reason=uninstaller-launch')) 'The launch error was lost during logging.'
      }
      $cancel = [PreviousRemovalProbe]::GetDlgItem($window, 2)
      Wait-Condition { [PreviousRemovalProbe]::IsWindowEnabled($cancel) } 'The failed result could not be dismissed.'
      [PreviousRemovalProbe]::PostMessage($window, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    }
    Assert-Condition ($process.WaitForExit(5000)) 'The result did not close after its explicit user action.'
    $terminal = [IO.File]::ReadAllText((Join-Path $FixtureRoot 'terminal.txt'))
    Assert-Condition ($terminal -eq $(if ($case -eq 'success') {'success'} else {'failed'})) "Wrong terminal: $terminal"
    if ($case -ne 'success') { Assert-Condition ($process.ExitCode -ne 0) 'Failed removal returned a successful exit code.' }
  } finally {
    $process.Refresh()
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    $process.Dispose()
  }
}
Write-Output 'previous removal failure checks passed'
