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
  public static string LastRegion;
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr window, IntPtr rect, IntPtr region, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  public static IntPtr Find(uint wanted) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window, parameter)=>{uint pid;GetWindowThreadProcessId(window,out pid);if(pid==wanted && Text(window).Contains("Installer presentation fixture")){found=window;return false;}return true;},IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr window) {var text=new StringBuilder(512);GetWindowText(window,text,512);return text.ToString();}
  public static string Rectangle(IntPtr window) {
    Rect rect;if(!GetWindowRect(window,out rect))throw new Exception("Cannot read the real installer rectangle before closing.");
    return rect.Left+"|"+rect.Top+"|"+(rect.Right-rect.Left)+"|"+(rect.Bottom-rect.Top);
  }
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
  public static bool DetailsBelow(IntPtr parent, IntPtr page, IntPtr log, IntPtr explanation, IntPtr details, int minimumRows) {
    Rect outer,body,list,copy,action;
    if(!GetWindowRect(parent,out outer) || !GetWindowRect(page,out body) || !GetWindowRect(log,out list)
      || !GetWindowRect(explanation,out copy) || !GetWindowRect(details,out action))return false;
    if(list.Top<copy.Bottom+4 || list.Bottom>body.Bottom-4 || list.Left<outer.Left || list.Right>outer.Right
      || SendMessage(log,0x1028,IntPtr.Zero,IntPtr.Zero).ToInt64()<minimumRows)return false;
    if(IsWindowVisible(details) && list.Bottom>action.Top-4)return false;
    foreach(int id in new int[]{1,2}) {
      var button=GetDlgItem(parent,id);
      if(IsWindowVisible(button)) {
        Rect bounds;if(!GetWindowRect(button,out bounds) || list.Bottom>bounds.Top-4)return false;
      }
    }
    return true;
  }
  public static bool FooterLayout(IntPtr parent, IntPtr page, IntPtr log, IntPtr details, IntPtr[] steps) {
    Rect client,list,action;
    var origin=new Point();
    if(steps.Length!=3 || !GetClientRect(parent,out client) || !ClientToScreen(parent,ref origin)
      || !GetWindowRect(log,out list) || !GetWindowRect(details,out action) || GetParent(details)!=page)return false;
    int gap=Math.Max(4,4*(int)GetDpiForWindow(parent)/96),actionsBottom=list.Bottom;
    if(IsWindowVisible(details)) {
      if(action.Top<list.Bottom+gap)return false;
      actionsBottom=Math.Max(actionsBottom,action.Bottom);
    }
    foreach(int id in new int[]{1,2}) {
      var button=GetDlgItem(parent,id);
      if(!IsWindowVisible(button))continue;
      Rect bounds;if(!GetWindowRect(button,out bounds))return false;
      if(bounds.Top<list.Bottom+gap)return false;
      if(IsWindowVisible(details) && action.Left<bounds.Right && action.Right>bounds.Left && action.Top<bounds.Bottom && action.Bottom>bounds.Top)return false;
      actionsBottom=Math.Max(actionsBottom,bounds.Bottom);
    }
    Rect previous=new Rect();
    for(int index=0;index<steps.Length;index++) {
      Rect step;
      if(GetParent(steps[index])!=parent || !IsWindowVisible(steps[index]) || !GetWindowRect(steps[index],out step)
        || step.Right<=step.Left || step.Bottom<=step.Top || step.Top<actionsBottom+gap
        || step.Left<origin.X+gap || step.Right>origin.X+client.Right-gap || step.Bottom>origin.Y+client.Bottom-gap)return false;
      if(index>0 && (previous.Right+gap>step.Left || previous.Top!=step.Top || previous.Bottom!=step.Bottom))return false;
      previous=step;
    }
    return true;
  }
  public static bool FilledBusyDetails(IntPtr parent, IntPtr log, IntPtr firstStep) {
    Rect outer,list,client,step;
    if(!GetWindowRect(parent,out outer) || !GetWindowRect(log,out list) || !GetClientRect(log,out client)
      || !GetWindowRect(firstStep,out step))return false;
    int dpi=(int)GetDpiForWindow(parent),gap=step.Top-list.Bottom;
    if(gap<4*dpi/96 || gap>10*dpi/96+1)return false;
    // Rows four and five occupy the old action area, below the terminal log's
    // 82-pixel height. Real glyphs here also prove its old region was replaced.
    int top=list.Top-outer.Top+84*dpi/96,bottom=list.Top-outer.Top+client.Bottom-4*dpi/96;
    int left=list.Left-outer.Left+8*dpi/96,right=list.Left-outer.Left+client.Right-8*dpi/96;
    using(var bitmap=new System.Drawing.Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=System.Drawing.Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(parent,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      int groups=0,last=-1000,count=0;
      for(int y=top;y<bottom;y++) {
        int row=0;
        for(int x=left;x<right;x++) {
          var pixel=bitmap.GetPixel(x,y);
          if(pixel.R<180 && pixel.G<180 && pixel.B<190)row++;
        }
        if(row>=3) {
          if(y-last>Math.Max(3,3*dpi/96))groups++;
          last=y;count+=row;
        }
      }
      LastRegion="busy log="+client.Right+"x"+client.Bottom+" extra row groups="+groups+" glyph pixels="+count+" footer gap="+gap;
      return groups>=2 && count>=20;
    }
  }
  public static bool StepColor(IntPtr parent, IntPtr step, int rgb) {
    Rect outer,control;
    if(!IsWindowVisible(step) || !GetWindowRect(parent,out outer) || !GetWindowRect(step,out control))return false;
    int inset=Math.Max(8,8*(int)GetDpiForWindow(parent)/96);
    using(var bitmap=new System.Drawing.Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=System.Drawing.Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(parent,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      foreach(int x in new int[]{control.Left-outer.Left+inset,control.Right-outer.Left-inset-1}) {
        var pixel=bitmap.GetPixel(x,(control.Top+control.Bottom)/2-outer.Top);
        LastRegion="step "+Text(step)+" pixel="+pixel.R+","+pixel.G+","+pixel.B+" expected="+rgb.ToString("X6");
        if(Math.Abs(pixel.R-((rgb>>16)&255))>3 || Math.Abs(pixel.G-((rgb>>8)&255))>3 || Math.Abs(pixel.B-(rgb&255))>3)return false;
      }
      return true;
    }
  }
  public static bool PaintedResultActions(IntPtr parent, IntPtr primary, IntPtr secondary) {
    Rect outer;if(!GetWindowRect(parent,out outer))return false;
    int inset=Math.Max(8,8*(int)GetDpiForWindow(parent)/96);
    using(var bitmap=new System.Drawing.Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=System.Drawing.Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(parent,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      foreach(var button in new IntPtr[]{primary,secondary}) {
        Rect control;if(!IsWindowVisible(button) || !GetWindowRect(button,out control))return false;
        var pixel=bitmap.GetPixel(control.Left-outer.Left+inset,(control.Top+control.Bottom)/2-outer.Top);
        LastRegion="result button "+Text(button)+" pixel="+pixel.R+","+pixel.G+","+pixel.B;
        if(button==primary) {
          if(pixel.B<=pixel.R+60 || pixel.B<=pixel.G+60)return false;
        } else if(pixel.R<220 || pixel.R>248 || pixel.G<220 || pixel.G>248 || pixel.B<225 || pixel.B>250)return false;
      }
      return true;
    }
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
function Save-CloseStart([IntPtr]$window) {
  [IO.File]::WriteAllText((Join-Path $FixtureRoot 'close-start.txt'),[InstallerPresentationProbe]::Rectangle($window))
}
function Assert-StepColors([IntPtr]$window,[int]$check,[int]$write,[int]$done,[string]$stage) {
  $colors=@($check,$write,$done)
  for ($index=0; $index -lt 3; $index++) {
    $control=[IntPtr][long]$footerState[$index]
    $color=$colors[$index]
    Wait-For { [InstallerPresentationProbe]::StepColor($window,$control,$color) } "The $stage footer step $index did not paint its state background."
  }
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
  $closeStart=[IO.File]::ReadAllText((Join-Path $FixtureRoot 'close-start.txt'))
  $closeEndRectangle=$closeEnd[3..6] -join '|'
  if ($closeStart -ne $closeEndRectangle -and $PreviewPath) {
    $diagnostic="mode=$mode`r`nopen=$($openEnd[3..6] -join '|')`r`nclose-start=$closeStart`r`nclose-end=$closeEndRectangle`r`n"+[IO.File]::ReadAllText((Join-Path $FixtureRoot 'motion.txt'))
    [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PreviewPath) 'installer-footer-motion-failure.txt'),$diagnostic)
  }
  # A user may drag the installer after entry. Compare exit restoration with
  # an independent native snapshot taken just before its accepted close.
  Assert-Condition ($closeStart -eq $closeEndRectangle) "Closing did not restore its actual starting rectangle ($mode): start=$closeStart close=$closeEndRectangle."
  Assert-Condition (($openEnd[5..6] -join '|') -eq ($closeEnd[5..6] -join '|')) 'The installer dimensions changed between opening and closing.'
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
  foreach ($marker in @('blocked-worker.txt','blocked-worker-result.txt','blocked.txt','callback.txt','terminal.txt','open-request.txt','log-spacing.txt','footer.txt','close-start.txt')) {
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
    # The movie starts before the native entrance finishes moving the HWND.
    # Sample caption hit tests and geometry only after its real completion.
    Wait-For {
      try { [IO.File]::ReadAllText((Join-Path $FixtureRoot 'motion.txt')).Contains('END|open|') }
      catch [IO.IOException] { $false }
    } 'Opening motion did not finish.'
    Wait-For {
      try {
        $script:footerState=([IO.File]::ReadAllText((Join-Path $FixtureRoot 'footer.txt'))) -split '\|'
        $footerState.Count -eq 6 -and @($footerState | Where-Object { $_ -eq '' -or $_ -eq '0' }).Count -eq 0
      } catch [IO.IOException] { $false }
    } 'Native footer controls were not published.'
    $footerSteps=[IntPtr[]]@($footerState[0..2] | ForEach-Object { [IntPtr][long]$_ })
    $installPage=[IntPtr][long]$footerState[4]
    if ($mode -eq 'short') {
      foreach ($step in $footerSteps) {
        Assert-Condition (![InstallerPresentationProbe]::IsWindowVisible($step)) 'The minimal installer exposed a footer step.'
      }
    } else {
      Assert-StepColors $window 0xEBEDFF 0xF0F2F7 0xF0F2F7 'checking'
    }
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

    $details = [IntPtr][long]$footerState[3]
    Assert-Condition ($details -ne [IntPtr]::Zero) 'Details button was not localized.'
    $detailsCaption=[InstallerPresentationProbe]::Text($details)
    Assert-Condition ($detailsCaption -match $(if($isChinese){'详情'}else{'details'})) 'Details button was not localized.'
    Assert-Condition ([InstallerPresentationProbe]::GetParent($details) -eq $installPage) 'Details left the native install page and changed its command routing.'
    $detailsVisible=[InstallerPresentationProbe]::IsWindowVisible($details)
    $detailsEnabled=[InstallerPresentationProbe]::IsWindowEnabled($details)
    $existingLog=[InstallerPresentationProbe]::Child($window,'SysListView32',$null)
    if ((!$detailsVisible -or !$detailsEnabled) -and $PreviewPath) {
      [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-details-action-failure.png'))
    }
    Assert-Condition ($detailsVisible -and $detailsEnabled) "Details action was unavailable ($mode): visible=$detailsVisible enabled=$detailsEnabled logVisible=$([InstallerPresentationProbe]::IsWindowVisible($existingLog)) caption=$detailsCaption."
    # Deliver the real button's BN_CLICKED notification to its native parent.
    # BM_CLICK is documented to be unreliable for an inactive dialog.
    [void][InstallerPresentationProbe]::PostMessage([InstallerPresentationProbe]::GetParent($details),0x111,[IntPtr]1027,$details)
    $script:log = [InstallerPresentationProbe]::Child($window,'SysListView32',$null)
    try {
      Wait-For { [InstallerPresentationProbe]::IsWindowVisible($log) } 'Native details did not open.'
    } catch {
      if ($PreviewPath) { [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-presentation-details-failure.png')) }
      Write-Output "Details button=$details log=$log visible=$([InstallerPresentationProbe]::IsWindowVisible($log)) style=$([InstallerPresentationProbe]::GetWindowLong($log,-16))"
      throw
    }
    Wait-For { ![InstallerPresentationProbe]::IsWindowVisible($details) } 'Native details did not retain their one-way reveal behavior.'
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
      Assert-StepColors $window 0xEAF5EE 0xEBEDFF 0xF0F2F7 'writing'
      Assert-Condition ([InstallerPresentationProbe]::DetailsBelow($window,$installPage,$log,$explanation,$details,5)) 'Busy details overlap visible controls or show fewer than five complete rows.'
      Assert-Condition ([InstallerPresentationProbe]::FooterLayout($window,$installPage,$log,$details,$footerSteps)) 'The footer steps are not in a separate root row below the details and buttons.'
      Assert-Condition ([InstallerPresentationProbe]::IsWindowVisible($scene)) 'Details hid the illustration.'
      Assert-Condition ([InstallerPresentationProbe]::IsWindowVisible($workingTitle)) 'Details hid the installation title.'
    }
    if ($mode -eq 'failed' -and $PreviewPath) {
      [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-presentation-details.png'))
      [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-footer-details.png'))
    }
    if ($mode -eq 'short' -and $PreviewPath) {
      [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-presentation-short.png'))
    }
    [void][InstallerPresentationProbe]::PostMessage($log,0x115,[IntPtr]7,[IntPtr]::Zero)
    Wait-For { [InstallerPresentationProbe]::SendMessage($log,0x1027,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -gt 0 } 'Details no longer scroll.'
    if ($mode -ne 'short') {
      Wait-For { [InstallerPresentationProbe]::FilledBusyDetails($window,$log,$footerSteps[0]) } 'Busy details left the old action area blank or clipped their fourth and fifth rows.'
      if ($mode -eq 'failed' -and $PreviewPath) {
        [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-expanded-details.png'))
      }
    }

    # Exercise both native visibility states when terminal actions appear.
    $keepExpanded=$mode -eq 'failed'
    if (!$keepExpanded) {
      [void][InstallerPresentationProbe]::ShowWindow($log,0)
      [void][InstallerPresentationProbe]::ShowWindow($details,5)
    }

    Set-Action $(if($mode -eq 'short' -or $mode -eq 'close'){'complete'}else{$mode})
    $terminalText = if($mode -eq 'failed'){'安装未完成'}elseif($isChinese){'安装完成'}else{'Installation complete'}
    Wait-For { [InstallerPresentationProbe]::Child($window,'Static',$terminalText) -ne [IntPtr]::Zero } 'Terminal title did not update.'
    if ($mode -ne 'short') {
      if ($mode -eq 'failed') {
        Assert-StepColors $window 0xEAF5EE 0xFFF0F1 0xF0F2F7 'failed'
      } else {
        Assert-StepColors $window 0xEAF5EE 0xEAF5EE 0xEAF5EE 'complete'
      }
      Assert-Condition ([InstallerPresentationProbe]::IsWindowVisible($log) -eq $keepExpanded) 'Resizing terminal details changed their native visibility state.'
      Assert-Condition ([InstallerPresentationProbe]::DetailsBelow($window,$installPage,$log,$explanation,$details,3)) 'Terminal details overlap visible actions or show fewer than three complete rows.'
      Wait-For { [InstallerPresentationProbe]::FooterLayout($window,$installPage,$log,$details,$footerSteps) } 'The result buttons or details overlap the final footer steps.'
      if ($keepExpanded) {
        Assert-Condition (![InstallerPresentationProbe]::IsWindowVisible($details)) 'Resizing terminal details re-showed the native one-way link.'
        Assert-Condition ([InstallerPresentationProbe]::SendMessage($log,0x1027,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -gt 0) 'Resizing terminal details reset their scroll position.'
        [void][InstallerPresentationProbe]::PostMessage($log,0x115,[IntPtr]6,[IntPtr]::Zero)
        Wait-For { [InstallerPresentationProbe]::SendMessage($log,0x1027,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 0 } 'Resized terminal details could not scroll to their beginning.'
        [void][InstallerPresentationProbe]::PostMessage($log,0x115,[IntPtr]7,[IntPtr]::Zero)
        Wait-For { [InstallerPresentationProbe]::SendMessage($log,0x1027,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -gt 0 } 'Resized terminal details could not scroll to their end.'
      }
    }
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
      # The native page extends under these root-owned buttons to retain its
      # details link. Repaint both surfaces to expose sibling-clipping mistakes.
      [void][InstallerPresentationProbe]::RedrawWindow($installPage,[IntPtr]::Zero,[IntPtr]::Zero,0x185)
      [void][InstallerPresentationProbe]::RedrawWindow($window,[IntPtr]::Zero,[IntPtr]::Zero,0x185)
      Wait-For { [InstallerPresentationProbe]::PaintedResultActions($window,$finish,$close) } 'A native page repaint erased the root Open or Close action.'
      if (($mode -eq 'complete' -or $mode -eq 'close') -and $PreviewPath) {
        Start-Sleep -Milliseconds 300
        [InstallerPresentationProbe]::SaveWindow($window,(Join-Path (Split-Path -Parent $PreviewPath) 'installer-presentation-complete.png'))
      }
      if ($mode -eq 'short') {
        Save-CloseStart $window
        [void][InstallerPresentationProbe]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
      } else {
        $action = if($mode -eq 'close'){$close}else{$finish}
        [void][InstallerPresentationProbe]::PostMessage($window,0x28,$action,[IntPtr]1)
        Wait-For { ([InstallerPresentationProbe]::SendMessage($action,0xF2,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -band 8) -ne 0 } 'Result action could not receive keyboard focus.'
        Save-CloseStart $window
        [void][InstallerPresentationProbe]::PostMessage($action,0x100,[IntPtr]32,[IntPtr]::Zero)
        [void][InstallerPresentationProbe]::PostMessage($action,0x101,[IntPtr]32,[IntPtr]::Zero)
      }
    } else {
      $failedClose = [InstallerPresentationProbe]::GetDlgItem($window,2)
      Wait-For { [InstallerPresentationProbe]::IsWindowVisible($failedClose) -and [InstallerPresentationProbe]::IsWindowEnabled($failedClose) } 'Failed setup did not offer its native Close button.'
      Assert-Condition ([InstallerPresentationProbe]::Text($failedClose) -match '取消|Cancel') 'Failure closing action lost its native caption.'
      Assert-Condition ([InstallerPresentationProbe]::SendMessage($failedClose,0xF6,[IntPtr]::Zero,[IntPtr]::Zero) -ne [IntPtr]::Zero) 'Failure Close button did not receive its image.'
      Save-CloseStart $window
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
