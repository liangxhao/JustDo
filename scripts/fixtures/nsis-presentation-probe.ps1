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
    IntPtr found=IntPtr.Zero;
    EnumChildWindows(parent,(window,parameter)=>{var name=new StringBuilder(128);GetClassName(window,name,128);if((className==null || name.ToString()==className) && (text==null || Text(window).Contains(text))){found=window;return false;}return true;},IntPtr.Zero);
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

foreach ($mode in @('complete','failed','silent')) {
  Set-Action ''
  [IO.File]::WriteAllText((Join-Path $FixtureRoot 'motion.txt'), '')
  $arguments = if ($mode -eq 'silent') { @('/S') } elseif ($mode -eq 'failed') { @('/zh') } else { @() }
  $start = @{ FilePath=$Executable; WindowStyle='Hidden'; PassThru=$true }
  if ($arguments.Count -gt 0) { $start.ArgumentList=$arguments }
  $fixtureProcess = Start-Process @start
  try {
    if ($mode -eq 'silent') {
      Assert-Condition ($fixtureProcess.WaitForExit(7000)) 'Silent fixture did not finish.'
      Assert-Condition ($fixtureProcess.ExitCode -eq 0) 'Silent fixture failed.'
      Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'silent.txt'))) -eq '|') 'Silent setup created presentation state.'
      Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'motion.txt'))) -eq '') 'Silent setup ran a decorative transition.'
      continue
    }
    $script:window = [IntPtr]::Zero
    Wait-For { $script:window=[InstallerPresentationProbe]::Find([uint32]$fixtureProcess.Id); $script:window -ne [IntPtr]::Zero } 'Fixture window was not created.'
    $script:scene = [IntPtr]::Zero
    Wait-For { $script:scene=[InstallerPresentationProbe]::Child($window,'SysAnimate32',$null); $script:scene -ne [IntPtr]::Zero -and [InstallerPresentationProbe]::SendMessage($scene,0x468,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 1 } 'Native animation did not start.'
    Assert-Condition ([InstallerPresentationProbe]::HasCaptionDrag($window)) 'The light caption lost native dragging.'
    Assert-Condition (![InstallerPresentationProbe]::IsWindowVisible([InstallerPresentationProbe]::Child($window,'SysListView32',$null))) 'Details unexpectedly expanded over the animation.'
    Start-Sleep -Milliseconds 1700
    $first = [InstallerPresentationProbe]::Pixels($scene)
    Wait-For { $first -ne [InstallerPresentationProbe]::Pixels($scene) } 'Animation pixels did not change while the install worker was busy.'
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
    $phaseText = if($mode -eq 'failed'){'文件较多时可能需要一点时间'}else{'With many files, this step can take a little time.'}
    Wait-For { [InstallerPresentationProbe]::Child($window,'Static',$phaseText) -ne [IntPtr]::Zero } 'Resource phase explanation did not update.'
    if ($mode -eq 'failed' -and $PreviewPath) {
      [InstallerPresentationProbe]::SaveWindow($window,$PreviewPath)
    }

    $details = [InstallerPresentationProbe]::Child($window,'Button',$(if($mode -eq 'failed'){'查看安装详情'}else{'Installation details'}))
    Assert-Condition ($details -ne [IntPtr]::Zero) 'Details button was not localized.'
    [void][InstallerPresentationProbe]::PostMessage($details,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
    $script:log = [InstallerPresentationProbe]::Child($window,'SysListView32',$null)
    Wait-For { [InstallerPresentationProbe]::IsWindowVisible($log) } 'Native details did not open.'
    [void][InstallerPresentationProbe]::PostMessage($log,0x115,[IntPtr]7,[IntPtr]::Zero)
    Wait-For { [InstallerPresentationProbe]::SendMessage($log,0x1027,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -gt 0 } 'Details no longer scroll.'

    # Restore an unobscured actor for the separate terminal pixel assertion.
    # The native log can append outcome records after the worker finishes.
    [void][InstallerPresentationProbe]::ShowWindow($log,0)
    [void][InstallerPresentationProbe]::ShowWindow($details,5)

    Set-Action $mode
    $terminalText = if($mode -eq 'failed'){'安装未完成'}else{'Installation complete'}
    Wait-For { [InstallerPresentationProbe]::Child($window,'Static',$terminalText) -ne [IntPtr]::Zero } 'Terminal title did not update.'
    Wait-For { [InstallerPresentationProbe]::SendMessage($scene,0x468,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 0 } 'Terminal state did not stop animation.'
    # A one-frame terminal seek is painted asynchronously after playback stops.
    Start-Sleep -Milliseconds 400
    $stopped = [InstallerPresentationProbe]::Pixels($scene)
    Start-Sleep -Milliseconds 350
    Assert-Condition ($stopped -eq [InstallerPresentationProbe]::Pixels($scene)) 'Terminal animation kept changing.'
    if ($mode -eq 'complete') {
      $finish = [InstallerPresentationProbe]::GetDlgItem($window,1)
      Wait-For { [InstallerPresentationProbe]::IsWindowVisible($finish) -and [InstallerPresentationProbe]::IsWindowEnabled($finish) } 'Finish button was not available.'
      Assert-Condition (([InstallerPresentationProbe]::Text($finish) -replace '&','') -eq 'Close') 'Close button was not localized.'
      Assert-Condition ([InstallerPresentationProbe]::SendMessage($finish,0xF6,[IntPtr]::Zero,[IntPtr]::Zero) -ne [IntPtr]::Zero) 'Primary button did not receive its modern image.'
      Assert-Condition (([InstallerPresentationProbe]::GetWindowLong($finish,-16) -band 0x80) -ne 0) 'The native result page removed the bitmap button style.'
      if ($PreviewPath) {
        Start-Sleep -Milliseconds 300
        [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-presentation-complete.png'))
      }
      [void][InstallerPresentationProbe]::PostMessage($window,0x28,$finish,[IntPtr]1)
      Wait-For { ([InstallerPresentationProbe]::SendMessage($finish,0xF2,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -band 8) -ne 0 } 'Close button could not receive keyboard focus.'
      [void][InstallerPresentationProbe]::PostMessage($finish,0x100,[IntPtr]32,[IntPtr]::Zero)
      [void][InstallerPresentationProbe]::PostMessage($finish,0x101,[IntPtr]32,[IntPtr]::Zero)
    } else {
      $failedClose = [InstallerPresentationProbe]::GetDlgItem($window,2)
      Wait-For { [InstallerPresentationProbe]::IsWindowVisible($failedClose) -and [InstallerPresentationProbe]::IsWindowEnabled($failedClose) } 'Failed setup did not offer its native Close button.'
      Assert-Condition ([InstallerPresentationProbe]::Text($failedClose) -match '取消|Cancel') 'Failure closing action lost its native caption.'
      Assert-Condition ([InstallerPresentationProbe]::SendMessage($failedClose,0xF6,[IntPtr]::Zero,[IntPtr]::Zero) -ne [IntPtr]::Zero) 'Failure Close button did not receive its image.'
      [void][InstallerPresentationProbe]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
    }
    Assert-Condition ($fixtureProcess.WaitForExit(7000)) 'Fixture did not close normally.'
    Assert-MotionTrace
    Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'callback.txt'))) -eq '8731|9317|1') 'An accepted closing transition changed its caller registers or error flag.'
    Assert-Condition (([IO.File]::ReadAllText((Join-Path $FixtureRoot 'closed.txt'))) -eq '0|0|0|0|0|0|0') 'Owned native resources were not cleared on close.'
  } finally {
    if (!$fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id -Force }
    $fixtureProcess.Dispose()
  }
}
Write-Output 'presentation checks passed'
