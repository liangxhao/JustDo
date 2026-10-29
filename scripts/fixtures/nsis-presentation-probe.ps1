param([Parameter(Mandatory=$true)][string]$Executable,
      [Parameter(Mandatory=$true)][string]$FixtureRoot,
      [string]$PreviewPath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class InstallerPresentationProbe {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public static IntPtr Find(uint wanted) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window, parameter)=>{uint pid;GetWindowThreadProcessId(window,out pid);if(pid==wanted && Text(window).Contains("Installer presentation fixture")){found=window;return false;}return true;},IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr window) {var text=new StringBuilder(512);GetWindowText(window,text,512);return text.ToString();}
  public static bool HasCaptionDrag(IntPtr window) {
    Rect rect;GetWindowRect(window,out rect);
    int x=rect.Left+(rect.Right-rect.Left)/2,y=rect.Top+12;
    return SendMessage(window,0x84,IntPtr.Zero,new IntPtr((y<<16)|(x&65535))).ToInt64()==2;
  }
  public static IntPtr Child(IntPtr parent, string className, string text) {
    return Child(parent,className,text,false);
  }
  public static IntPtr Child(IntPtr parent, string className, string text, bool visibleOnly) {
    IntPtr found=IntPtr.Zero;
    EnumChildWindows(parent,(window,parameter)=>{var name=new StringBuilder(128);GetClassName(window,name,128);if((!visibleOnly || IsWindowVisible(window)) && (className==null || name.ToString()==className) && (text==null || Text(window).Contains(text))){found=window;return false;}return true;},IntPtr.Zero);
    return found;
  }
  public static string Pixels(IntPtr window) {
    IntPtr parent=GetAncestor(window,2);
    Rect rect,outer;GetWindowRect(window,out rect);GetWindowRect(parent,out outer);
    using(var bitmap=new System.Drawing.Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=System.Drawing.Graphics.FromImage(bitmap)) {
      IntPtr dc=graphics.GetHdc();try{if(!PrintWindow(parent,dc,2))throw new Exception("PrintWindow failed");}finally{graphics.ReleaseHdc(dc);}
      using(var region=bitmap.Clone(new System.Drawing.Rectangle(rect.Left-outer.Left,rect.Top-outer.Top,rect.Right-rect.Left,rect.Bottom-rect.Top),bitmap.PixelFormat))
      using(var stream=new System.IO.MemoryStream()) {region.Save(stream,System.Drawing.Imaging.ImageFormat.Bmp);using(var hash=System.Security.Cryptography.SHA256.Create()){return BitConverter.ToString(hash.ComputeHash(stream.ToArray()));}}
    }
  }
  public static void SaveWindow(IntPtr window, string path) {
    Rect rect;GetWindowRect(window,out rect);
    using(var bitmap=new System.Drawing.Bitmap(rect.Right-rect.Left,rect.Bottom-rect.Top))
    using(var graphics=System.Drawing.Graphics.FromImage(bitmap)) {
      IntPtr dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,2))throw new Exception("PrintWindow failed");}finally{graphics.ReleaseHdc(dc);}
      bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);
    }
  }
  public static bool DetailsBelow(IntPtr parent, IntPtr log, IntPtr explanation, IntPtr steps) {
    Rect outer,list,copy,step;
    return GetWindowRect(parent,out outer) && GetWindowRect(log,out list)
      && GetWindowRect(explanation,out copy) && GetWindowRect(steps,out step)
      && list.Top >= copy.Bottom + 4 && list.Bottom <= step.Top - 4
      && list.Bottom - list.Top >= 60 && list.Left >= outer.Left && list.Right <= outer.Right;
  }
  public static bool MinimalDetailsBelow(IntPtr parent, IntPtr log, IntPtr progress) {
    Rect outer,list,bar;
    return GetWindowRect(parent,out outer) && GetWindowRect(log,out list)
      && GetWindowRect(progress,out bar) && list.Top >= bar.Bottom + 4
      && list.Bottom <= outer.Bottom - 30 && list.Bottom - list.Top >= 30
      && list.Left >= outer.Left && list.Right <= outer.Right;
  }
  public static bool SeparateResultButtons(IntPtr parent, IntPtr open, IntPtr close) {
    Rect outer,primary,secondary;
    return GetWindowRect(parent,out outer) && GetWindowRect(open,out primary)
      && GetWindowRect(close,out secondary) && secondary.Right + 4 <= primary.Left
      && secondary.Left >= outer.Left && primary.Right <= outer.Right
      && primary.Top == secondary.Top && primary.Bottom <= outer.Bottom;
  }
  public static bool StyledLog(IntPtr log, int dpi) {
    Rect client;
    if (!GetClientRect(log,out client)) return false;
    var column=SendMessage(log,0x101D,IntPtr.Zero,IntPtr.Zero).ToInt64();
    var header=SendMessage(log,0x101F,IntPtr.Zero,IntPtr.Zero);
    return SendMessage(header,0x1200,IntPtr.Zero,IntPtr.Zero).ToInt64()==1
      && column <= client.Right && column >= client.Right - Math.Max(36,36*dpi/96)
      && (GetWindowLong(log,-16)&0x00100000)==0
      && (GetWindowLong(log,-16)&0x0040)!=0
      && (SendMessage(log,0x1037,IntPtr.Zero,IntPtr.Zero).ToInt64()&0x14001)==0x14000
      && SendMessage(log,0x1023,IntPtr.Zero,IntPtr.Zero).ToInt64()==0x695547;
  }
}
'@

function Assert-Condition([bool]$condition, [string]$message) {
  if (!$condition) { throw $message }
}
function Wait-For([scriptblock]$condition, [string]$message) {
  for ($attempt=0; $attempt -lt 70; $attempt++) {
    if (& $condition) { return }
    Start-Sleep -Milliseconds 100
  }
  throw $message
}
function Set-Action([string]$action) {
  [IO.File]::WriteAllText((Join-Path $FixtureRoot 'action.txt'), $action)
}
function Assert-MotionTrace {
  $rows = @([IO.File]::ReadAllLines((Join-Path $FixtureRoot 'motion.txt')) | ForEach-Object {
    [pscustomobject]@{ Cells = ($_ -split '\|') }
  })
  $ends = @($rows | Where-Object { $_.Cells[0] -eq 'END' })
  Assert-Condition ($ends.Count -eq 2) ('Open and accepted Close must each finish exactly once: ' + ([IO.File]::ReadAllText((Join-Path $FixtureRoot 'motion.txt'))))
  $openEnd = @($ends | Where-Object { $_.Cells[1] -eq 'open' })[0].Cells
  $closeEnd = @($ends | Where-Object { $_.Cells[1] -eq 'close' })[0].Cells
  Assert-Condition (([int]$openEnd[2] -band 0x80000) -eq 0 -and ([int]$closeEnd[2] -band 0x80000) -eq 0) 'A temporary layered window style leaked.'
  Assert-Condition ($openEnd[7] -eq '1' -and $closeEnd[7] -eq '0') 'Open must be visible; Close must hide before restoring opacity.'
  Assert-Condition (($openEnd[3..6] -join '|') -eq ($closeEnd[3..6] -join '|')) 'Closing did not restore the original rectangle.'
  foreach ($kind in @('open','close')) {
    $frames = @($rows | Where-Object { $_.Cells[0] -eq 'FRAME' -and $_.Cells[1] -eq $kind })
    Assert-Condition ($frames.Count -ge 3) "$kind did not produce intermediate native frames."
    for ($index=0; $index -lt $frames.Count; $index++) {
      $frame = $frames[$index].Cells
      Assert-Condition ($frame[7] -eq '1') 'Could not read back real native opacity.'
      Assert-Condition ($frame[5] -eq $openEnd[5] -and $frame[6] -eq $openEnd[6]) 'Motion resized the actual controls/window.'
      if ($index -gt 0) {
        $previous = $frames[$index-1].Cells
        if ($kind -eq 'open') {
          Assert-Condition ([int]$frame[2] -ge [int]$previous[2] -and [int]$frame[4] -le [int]$previous[4]) 'Opening opacity/position reversed direction.'
        } else {
          Assert-Condition ([int]$frame[2] -le [int]$previous[2] -and [int]$frame[4] -ge [int]$previous[4]) 'Closing opacity/position reversed direction.'
        }
      }
    }
    $first = $frames[0].Cells
    $last = $frames[-1].Cells
    if ($kind -eq 'open') {
      Assert-Condition ([int]$first[2] -lt 128 -and $last[2] -eq '255' -and [int]$first[4] -gt [int]$last[4]) 'Opening did not fade and rise into place.'
    } else {
      Assert-Condition ([int]$first[2] -gt 200 -and $last[2] -eq '0' -and [int]$first[4] -lt [int]$last[4]) 'Closing did not fade and settle downward.'
    }
  }
}

foreach ($mode in @('complete','close','failed','short','silent')) {
  $isChinese = $mode -eq 'failed' -or $mode -eq 'close'
  Set-Action ''
  foreach ($marker in @('blocked-worker.txt','blocked-worker-result.txt','blocked.txt','callback.txt','terminal.txt','open-request.txt','log-spacing.txt')) {
    $markerPath = Join-Path $FixtureRoot $marker
    if (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath }
  }
  [IO.File]::WriteAllText((Join-Path $FixtureRoot 'motion.txt'), '')
  $arguments = if ($mode -eq 'silent') { @('/S') } elseif ($isChinese) { @('/zh') } elseif ($mode -eq 'short') { @('/short') } else { @() }
  $start = @{ FilePath=$Executable; WindowStyle='Hidden'; PassThru=$true }
  if ($arguments.Count -gt 0) { $start.ArgumentList=$arguments }
  $fixtureProcess = Start-Process @start
  try {
    if ($mode -eq 'silent') {
      Assert-Condition ($fixtureProcess.WaitForExit(7000)) 'Silent fixture did not finish.'
      Assert-Condition ($fixtureProcess.ExitCode -eq 0) 'Silent fixture failed.'
      Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'silent.txt'))) -eq '|') 'Silent setup created presentation state.'
      Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'motion.txt'))) -eq '') 'Silent setup ran a decorative transition.'
      Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'open-request.txt'))) 'Silent setup invoked the interactive Open action.'
      Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'log-spacing.txt'))) 'Silent setup created log presentation resources.'
      continue
    }
    $script:window = [IntPtr]::Zero
    Wait-For { $script:window=[InstallerPresentationProbe]::Find([uint32]$fixtureProcess.Id); $script:window -ne [IntPtr]::Zero } 'Fixture window was not created.'
    $script:scene = [IntPtr]::Zero
    Wait-For { $script:scene=[InstallerPresentationProbe]::Child($window,'SysAnimate32',$null); $script:scene -ne [IntPtr]::Zero -and ($mode -eq 'short' -or [InstallerPresentationProbe]::SendMessage($scene,0x468,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 1) } 'Native animation did not start.'
    Assert-Condition ([InstallerPresentationProbe]::HasCaptionDrag($window)) 'The light caption lost native dragging.'
    Assert-Condition (![InstallerPresentationProbe]::IsWindowVisible([InstallerPresentationProbe]::Child($window,'SysListView32',$null))) 'Details unexpectedly expanded over the animation.'
    Start-Sleep -Milliseconds 1700
    if ($mode -ne 'short') {
      $first = [InstallerPresentationProbe]::Pixels($scene)
      Wait-For { $first -ne [InstallerPresentationProbe]::Pixels($scene) } 'Animation pixels did not change while the install worker was busy.'
    }
    $elapsedPrefix = if($isChinese){'已用时 '}else{'Elapsed '}
    $elapsed = [InstallerPresentationProbe]::Child($window,'Static',$elapsedPrefix)
    Assert-Condition ($elapsed -ne [IntPtr]::Zero) 'Elapsed label was not created.'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $FixtureRoot 'blocked-worker.txt')) 'Worker did not enter its synchronous operation.'
    Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'blocked-worker-result.txt'))) 'Synchronous operation finished before the clock probe.'
    $elapsedBefore = [InstallerPresentationProbe]::Text($elapsed)
    Wait-For { [InstallerPresentationProbe]::Text($elapsed) -ne $elapsedBefore } 'Elapsed time froze while the worker stopped polling.'
    Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'blocked-worker-result.txt'))) 'Elapsed time updated only after the worker resumed.'
    Wait-For { Test-Path -LiteralPath (Join-Path $FixtureRoot 'blocked-worker-result.txt') } 'Worker did not finish its synchronous operation.'
    Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'blocked-worker-result.txt'))) -eq 'clock-worker-canary|1') 'The clock changed worker registers or its NSIS error flag.'
    Set-Action 'blocked-close'
    Wait-For { Test-Path -LiteralPath (Join-Path $FixtureRoot 'blocked.txt') } 'The write-protected close probe did not run.'
    Set-Action 'resources'
    Wait-For {
      try { ([IO.File]::ReadAllText((Join-Path $FixtureRoot 'blocked.txt'))) -eq '4217|1|' } catch [IO.IOException] { $false }
    } 'The close guard changed errors, a register, or the closed state.'
    [void][InstallerPresentationProbe]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    Assert-Condition (!$fixtureProcess.HasExited -and [InstallerPresentationProbe]::IsWindowVisible($window)) 'A write-protected close hid or ended setup.'
    Set-Action 'resources'
    $phaseText = if($isChinese){'文件较多时可能需要一点时间'}else{'With many files, this step can take a little time.'}
    Wait-For { [InstallerPresentationProbe]::Child($window,'Static',$phaseText) -ne [IntPtr]::Zero } 'Resource phase explanation did not update.'
    if ($mode -eq 'failed' -and $PreviewPath) {
      [InstallerPresentationProbe]::SaveWindow($window,$PreviewPath)
    }

    $details = [InstallerPresentationProbe]::Child($window,'Button',$(if($isChinese){'查看安装详情'}else{'Installation details'}))
    Assert-Condition ($details -ne [IntPtr]::Zero) 'Details button was not localized.'
    Assert-Condition ([InstallerPresentationProbe]::IsWindowVisible($details) -and [InstallerPresentationProbe]::IsWindowEnabled($details)) 'Details action was unavailable.'
    # Dispatch the native BN_CLICKED command without taking foreground focus.
    # BM_CLICK is documented to be unreliable for an inactive dialog.
    [void][InstallerPresentationProbe]::PostMessage($window,0x111,[IntPtr]1027,$details)
    $script:log = [InstallerPresentationProbe]::Child($window,'SysListView32',$null)
    try {
      Wait-For { [InstallerPresentationProbe]::IsWindowVisible($log) } 'Native details did not open.'
    } catch {
      if ($PreviewPath) { [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-presentation-details-failure.png')) }
      Write-Output "Details button=$details log=$log visible=$([InstallerPresentationProbe]::IsWindowVisible($log)) style=$([InstallerPresentationProbe]::GetWindowLong($log,-16))"
      throw
    }
    $logDpi = if($mode -eq 'short'){288}else{[int][InstallerPresentationProbe]::GetDpiForWindow($window)}
    Assert-Condition ([InstallerPresentationProbe]::StyledLog($log,$logDpi)) 'Details kept a narrow column, gridlines, horizontal scrolling or the wrong text style.'
    $spacing = ([IO.File]::ReadAllText((Join-Path $FixtureRoot 'log-spacing.txt'))) -split '\|'
    Assert-Condition ($spacing[0] -eq [string][int][math]::Floor(8*$logDpi/96) -and $spacing[1] -eq [string][int][math]::Floor(24*$logDpi/96) -and $spacing[2] -eq '1') 'Native log inset/row spacing did not scale.'
    $explanation = [InstallerPresentationProbe]::Child($window,'Static',$phaseText)
    $steps = [InstallerPresentationProbe]::Child($window,'Static',$(if($isChinese){'检查占用'}else{'Check location'}))
    $workingTitle = [InstallerPresentationProbe]::Child($window,'Static',$(if($isChinese){'正在安装'}else{'Installing '}),$true)
    if ($mode -eq 'short') {
      $progress = [InstallerPresentationProbe]::Child($window,'msctls_progress32',$null,$true)
      Assert-Condition ([InstallerPresentationProbe]::MinimalDetailsBelow($window,$log,$progress)) 'Short layout overlaps progress or puts details outside the window.'
      Assert-Condition (![InstallerPresentationProbe]::IsWindowVisible($explanation) -and ![InstallerPresentationProbe]::IsWindowVisible($steps)) 'Short layout retained overlapping secondary rows.'
    } else {
      Assert-Condition ([InstallerPresentationProbe]::DetailsBelow($window,$log,$explanation,$steps)) 'Details overlap the explanation or steps instead of opening below.'
      Assert-Condition ([InstallerPresentationProbe]::IsWindowVisible($scene)) 'Details hid the illustration.'
      Assert-Condition ([InstallerPresentationProbe]::IsWindowVisible($workingTitle)) 'Details hid the installation title.'
    }
    if ($mode -eq 'failed' -and $PreviewPath) {
      [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-presentation-details.png'))
    }
    if ($mode -eq 'short' -and $PreviewPath) {
      [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-presentation-short.png'))
    }
    [void][InstallerPresentationProbe]::PostMessage($log,0x115,[IntPtr]7,[IntPtr]::Zero)
    Wait-For { [InstallerPresentationProbe]::SendMessage($log,0x1027,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -gt 0 } 'Details no longer scroll.'

    # Keep the terminal screenshot collapsed after testing the details layout.
    [void][InstallerPresentationProbe]::ShowWindow($log,0)
    [void][InstallerPresentationProbe]::ShowWindow($details,5)

    Set-Action $(if($mode -eq 'short' -or $mode -eq 'close'){'complete'}else{$mode})
    $terminalText = if($mode -eq 'failed'){'安装未完成'}elseif($isChinese){'安装完成'}else{'Installation complete'}
    Wait-For { [InstallerPresentationProbe]::Child($window,'Static',$terminalText) -ne [IntPtr]::Zero } 'Terminal title did not update.'
    Wait-For { [InstallerPresentationProbe]::SendMessage($scene,0x468,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 0 } 'Terminal state did not stop animation.'
    # A one-frame terminal seek is painted asynchronously after playback stops.
    Start-Sleep -Milliseconds 400
    $elapsedStopped = [InstallerPresentationProbe]::Text($elapsed)
    if ($mode -ne 'short') { $stopped = [InstallerPresentationProbe]::Pixels($scene) }
    Start-Sleep -Milliseconds 1100
    if ($mode -ne 'short') {
      Assert-Condition ($stopped -eq [InstallerPresentationProbe]::Pixels($scene)) 'Terminal animation kept changing.'
    }
    Assert-Condition ($elapsedStopped -eq [InstallerPresentationProbe]::Text($elapsed)) 'Elapsed time kept advancing after a terminal result.'
    if ($mode -ne 'failed') {
      $finish = [InstallerPresentationProbe]::GetDlgItem($window,1)
      $close = [InstallerPresentationProbe]::GetDlgItem($window,2)
      Wait-For { [InstallerPresentationProbe]::IsWindowVisible($finish) -and [InstallerPresentationProbe]::IsWindowEnabled($finish) } 'Finish button was not available.'
      Wait-For { [InstallerPresentationProbe]::IsWindowVisible($close) -and [InstallerPresentationProbe]::IsWindowEnabled($close) } 'Successful setup did not enable its separate Close action.'
      Assert-Condition (([InstallerPresentationProbe]::Text($finish) -replace '&','') -eq $(if($isChinese){'打开应用'}else{'Open app'})) 'Open button was not localized.'
      Assert-Condition (([InstallerPresentationProbe]::Text($close) -replace '&','') -eq $(if($isChinese){'关闭'}else{'Close'})) 'Close button was not localized after the native completion callback.'
      Assert-Condition ([InstallerPresentationProbe]::SeparateResultButtons($window,$finish,$close)) 'The Open and Close buttons overlap or leave the window.'
      Assert-Condition ([InstallerPresentationProbe]::Child($window,'Static',$(if($isChinese){'写入完成'}else{'Files written'})) -ne [IntPtr]::Zero) 'The completed step still says Write files.'
      Assert-Condition ([InstallerPresentationProbe]::SendMessage($finish,0xF6,[IntPtr]::Zero,[IntPtr]::Zero) -ne [IntPtr]::Zero) 'Primary button did not receive its modern image.'
      Assert-Condition (([InstallerPresentationProbe]::GetWindowLong($finish,-16) -band 0x80) -ne 0) 'The native result page removed the bitmap button style.'
      if (($mode -eq 'complete' -or $mode -eq 'close') -and $PreviewPath) {
        Start-Sleep -Milliseconds 300
        [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-presentation-complete.png'))
      }
      if ($mode -eq 'short') {
        [void][InstallerPresentationProbe]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
      } else {
        $action = if($mode -eq 'close'){$close}else{$finish}
        [void][InstallerPresentationProbe]::PostMessage($window,0x28,$action,[IntPtr]1)
        Wait-For { ([InstallerPresentationProbe]::SendMessage($action,0xF2,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -band 8) -ne 0 } 'Result action could not receive keyboard focus.'
        [void][InstallerPresentationProbe]::PostMessage($action,0x100,[IntPtr]32,[IntPtr]::Zero)
        [void][InstallerPresentationProbe]::PostMessage($action,0x101,[IntPtr]32,[IntPtr]::Zero)
      }
    } else {
      $failedClose = [InstallerPresentationProbe]::GetDlgItem($window,2)
      Wait-For { [InstallerPresentationProbe]::IsWindowVisible($failedClose) -and [InstallerPresentationProbe]::IsWindowEnabled($failedClose) } 'Failed setup did not offer its native Close button.'
      Assert-Condition ([InstallerPresentationProbe]::Text($failedClose) -match '取消|Cancel') 'Failure closing action lost its native caption.'
      Assert-Condition ([InstallerPresentationProbe]::SendMessage($failedClose,0xF6,[IntPtr]::Zero,[IntPtr]::Zero) -ne [IntPtr]::Zero) 'Failure Close button did not receive its image.'
      [void][InstallerPresentationProbe]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
    }
    Assert-Condition ($fixtureProcess.WaitForExit(7000)) 'Fixture did not close normally.'
    Assert-Condition ($fixtureProcess.ExitCode -eq $(if($mode -eq 'failed'){2}else{0})) 'Closing a successful result changed the installation exit code.'
    Assert-MotionTrace
    if ($mode -eq 'close' -or $mode -eq 'short') {
      Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'callback.txt'))) 'Close incorrectly entered the Open/success callback.'
    } else {
      Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'callback.txt'))) -eq '8731|9317|1') 'An accepted closing transition changed its caller registers or error flag.'
    }
    if ($mode -eq 'complete') {
      Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'open-request.txt'))) -eq "fixture://installed-application|open|`r`n") 'Open did not issue exactly one current-user shell request.'
    } else {
      Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'open-request.txt'))) 'Close or failure opened the application.'
    }
    Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'terminal.txt'))) -eq $(if($mode -eq 'failed'){'failed|0'}else{'success|0'})) 'Closing lost the terminal result or retained a launch request.'
    Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'closed.txt'))) -eq '0|0|0|0|0|0|0|0|0') 'Owned native resources were not cleared on close.'
  } finally {
    if (!$fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id -Force }
    $fixtureProcess.Dispose()
  }
}
Write-Output 'presentation checks passed'
