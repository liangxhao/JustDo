param([Parameter(Mandatory=$true)][string]$Executable,
      [Parameter(Mandatory=$true)][string]$FixtureRoot,
      [Parameter(Mandatory=$true)][string]$PreviewRoot)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Text;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
public class InstallerSetupProbe {
  public static string DebugImagePath, LastRegion;
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] public static extern IntPtr SendText(IntPtr window, uint message, IntPtr w, string text);
  [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] public static extern IntPtr ReadText(IntPtr window, uint message, IntPtr w, StringBuilder text);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
  [StructLayout(LayoutKind.Sequential)] public struct GuiInfo {
    public int Size, Flags;
    public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
    public Rect CaretRect;
  }
  public static IntPtr Find(uint wanted) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window,parameter)=>{uint pid;GetWindowThreadProcessId(window,out pid);if(pid==wanted && Text(window).Contains("Installer setup fixture")){found=window;return false;}return true;},IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr window) {var text=new StringBuilder(2048);ReadText(window,0xD,(IntPtr)2048,text);return text.ToString();}
  public static bool Focused(IntPtr window) {
    uint pid;var thread=GetWindowThreadProcessId(window,out pid);
    var info=new GuiInfo();info.Size=Marshal.SizeOf(info);
    return GetGUIThreadInfo(thread,ref info) && info.Focus==window;
  }
  public static bool Inside(IntPtr parent, IntPtr child) {
    Rect outer,inner;
    return child!=IntPtr.Zero && IsWindowVisible(child) && GetWindowRect(parent,out outer)
      && GetWindowRect(child,out inner) && inner.Right>inner.Left && inner.Bottom>inner.Top
      && inner.Left>=outer.Left && inner.Right<=outer.Right && inner.Top>=outer.Top && inner.Bottom<=outer.Bottom;
  }
  public static bool RowsSeparate(IntPtr first, IntPtr second) {
    Rect a,b;return GetWindowRect(first,out a) && GetWindowRect(second,out b)
      && (a.Bottom+4<=b.Top || b.Bottom+4<=a.Top);
  }
  public static bool ColumnsSeparate(IntPtr first, IntPtr second) {
    Rect a,b;return GetWindowRect(first,out a) && GetWindowRect(second,out b)
      && (a.Right+4<=b.Left || b.Right+4<=a.Left);
  }
  public static bool FitsWorkArea(IntPtr window) {
    Rect rect;var info=new MonitorInfo();info.Size=Marshal.SizeOf(info);
    return GetWindowRect(window,out rect) && GetMonitorInfo(MonitorFromWindow(window,2),ref info)
      && rect.Left>=info.Work.Left && rect.Top>=info.Work.Top && rect.Right<=info.Work.Right && rect.Bottom<=info.Work.Bottom;
  }
  public static bool HasModernWidth(IntPtr window) {
    Rect client;if(!GetClientRect(window,out client))return false;
    return client.Right>=Math.Min(620,620*(int)GetDpiForWindow(window)/96);
  }
  public static bool HasVisibleArea(IntPtr window) {
    Rect rect;return IsWindowVisible(window) && GetWindowRect(window,out rect) && rect.Right>rect.Left && rect.Bottom>rect.Top;
  }
  public static string Rectangle(IntPtr window) {
    Rect rect;if(!GetWindowRect(window,out rect))return "unavailable";
    return rect.Left+"|"+rect.Top+"|"+rect.Right+"|"+rect.Bottom;
  }
  public static string MoveFromCenter(IntPtr window) {
    Rect rect;var info=new MonitorInfo();info.Size=Marshal.SizeOf(info);
    if(!GetWindowRect(window,out rect) || !GetMonitorInfo(MonitorFromWindow(window,2),ref info))
      throw new Exception("Cannot read the setup window or its monitor.");
    int x=Math.Min(info.Work.Right-(rect.Right-rect.Left)-8,rect.Left+62);
    int y=Math.Min(info.Work.Bottom-(rect.Bottom-rect.Top)-8,rect.Top+38);
    if(x==rect.Left && y==rect.Top)throw new Exception("No room to move the setup window for the navigation regression.");
    // The native caption hit-test is checked separately. This reproduces the
    // resulting position of a user drag without commandeering the mouse.
    if(!SetWindowPos(window,IntPtr.Zero,x,y,0,0,0x15))throw new Exception("Cannot move the native setup window.");
    return Rectangle(window);
  }
  static Thread rectangleWatch;
  static volatile bool watching;
  static string rectangleFailure;
  public static void BeginRectangleWatch(IntPtr window,string expected) {
    rectangleFailure=null;watching=true;
    rectangleWatch=new Thread(()=>{
      while(watching) {
        string actual=Rectangle(window);
        if(actual!=expected && rectangleFailure==null)rectangleFailure=actual;
        Thread.Sleep(4);
      }
    });
    rectangleWatch.IsBackground=true;rectangleWatch.Start();
  }
  public static string EndRectangleWatch() {
    watching=false;
    if(rectangleWatch!=null){rectangleWatch.Join(1000);rectangleWatch=null;}
    return rectangleFailure;
  }
  public static bool RoundMark(IntPtr window,IntPtr logo) {
    Rect outer,inner;if(!GetWindowRect(window,out outer) || !GetWindowRect(logo,out inner))return false;
    using(var bitmap=new Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      int minX=bitmap.Width,minY=bitmap.Height,maxX=-1,maxY=-1;
      for(int y=inner.Top-outer.Top;y<inner.Bottom-outer.Top;y++)
        for(int x=inner.Left-outer.Left;x<inner.Right-outer.Left;x++) {
          var pixel=bitmap.GetPixel(x,y);
          if(pixel.R<150 && pixel.G<150 && pixel.B<150){minX=Math.Min(minX,x);maxX=Math.Max(maxX,x);minY=Math.Min(minY,y);maxY=Math.Max(maxY,y);}
        }
      int width=maxX-minX+1,height=maxY-minY+1;
      double aspect=height>0?(double)width/height:0;
      LastRegion="painted mark="+width+"x"+height+" control="+(inner.Right-inner.Left)+"x"+(inner.Bottom-inner.Top);
      return aspect>=0.9 && aspect<=1.1 && width>=(inner.Right-inner.Left)*0.65 && height>=(inner.Bottom-inner.Top)*0.65;
    }
  }
  public static bool CaptionDivider(IntPtr window,IntPtr page) {
    var divider=GetDlgItem(page,12351);
    Rect outer,line,client,pageRect;
    if(divider==IntPtr.Zero || !IsWindowVisible(divider) || !GetWindowRect(window,out outer)
      || !GetWindowRect(divider,out line) || !GetClientRect(page,out client) || !GetWindowRect(page,out pageRect))return false;
    if(line.Top!=pageRect.Top || line.Left!=pageRect.Left || line.Right-line.Left!=client.Right || line.Bottom-line.Top!=1)return false;
    using(var bitmap=new Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      foreach(int fraction in new int[]{1,2,3}) {
        int x=line.Left-outer.Left+(line.Right-line.Left)*fraction/4;
        var pixel=bitmap.GetPixel(x,line.Top-outer.Top);
        if(Math.Abs(pixel.R-229)>3 || Math.Abs(pixel.G-231)>3 || Math.Abs(pixel.B-237)>3)return false;
      }
      return true;
    }
  }
  public static bool FullHero(IntPtr window,IntPtr page,IntPtr scene,IntPtr title,IntPtr subtitle) {
    Rect hero,heading,subheading;
    if(!Inside(page,scene) || !Inside(page,title) || !Inside(page,subtitle)
      || !GetWindowRect(scene,out hero) || !GetWindowRect(title,out heading) || !GetWindowRect(subtitle,out subheading))return false;
    int width=hero.Right-hero.Left,height=hero.Bottom-hero.Top;
    return width>=224 && height>=180 && heading.Top>=hero.Bottom+4 && subheading.Top>=heading.Bottom;
  }
  public static bool PaintedLowerOrbit(IntPtr window,IntPtr scene) {
    Rect outer,hero;if(!GetWindowRect(window,out outer) || !GetWindowRect(scene,out hero))return false;
    int width=hero.Right-hero.Left,height=hero.Bottom-hero.Top;
    int dpi=(int)GetDpiForWindow(window);
    int percent=dpi>=168 && width>=448 && height>=360?200:(dpi>=120 && width>=336 && height>=270?150:100);
    int clipWidth=224*percent/100,clipHeight=180*percent/100;
    int left=hero.Left-outer.Left+(width-clipWidth)/2,top=hero.Top-outer.Top+(height-clipHeight)/2;
    using(var bitmap=new Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      int count=0;
      for(int y=top+clipHeight*7/10;y<top+clipHeight;y++)
        for(int x=left;x<left+clipWidth;x++) {
          var pixel=bitmap.GetPixel(x,y);
          if(pixel.B-pixel.R>=50 && pixel.G-pixel.R>=15)count++;
        }
      LastRegion="lower blue orbit pixels="+count+" clip="+clipWidth+"x"+clipHeight+" native="+width+"x"+height;
      return count>=5;
    }
  }
  public static void SaveWindow(IntPtr window,string path) {
    Rect rect;GetWindowRect(window,out rect);
    using(var bitmap=new Bitmap(rect.Right-rect.Left,rect.Bottom-rect.Top))
    using(var graphics=Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,2))throw new Exception("PrintWindow failed");}finally{graphics.ReleaseHdc(dc);}
      bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);
    }
  }
  public static bool PaintedFrame(IntPtr window,IntPtr[] controls,string path) {
    Rect outer;if(!GetWindowRect(window,out outer))return false;
    DwmFlush();
    using(var bitmap=new Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      foreach(var child in controls) {
        Rect inner;if(!GetWindowRect(child,out inner))return false;
        LastRegion="outer="+outer.Left+","+outer.Top+","+outer.Right+","+outer.Bottom+" child="+inner.Left+","+inner.Top+","+inner.Right+","+inner.Bottom;
        int count=0;
        for(int y=Math.Max(0,inner.Top-outer.Top);y<Math.Min(bitmap.Height,inner.Bottom-outer.Top) && count<=8;y++)
          for(int x=Math.Max(0,inner.Left-outer.Left);x<Math.Min(bitmap.Width,inner.Right-outer.Left) && count<=8;x++) {
            var pixel=bitmap.GetPixel(x,y);if(pixel.R<210 && pixel.G<210 && pixel.B<210)count++;
          }
        if(count<=8) {
          if(!String.IsNullOrEmpty(DebugImagePath))bitmap.Save(DebugImagePath,System.Drawing.Imaging.ImageFormat.Png);
          return false;
        }
      }
      if(!String.IsNullOrEmpty(path))bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
  }
  public static bool SaveScreen(IntPtr window,string path) {
    if(GetForegroundWindow()!=window)return false;
    Rect rect;if(!GetWindowRect(window,out rect))return false;
    DwmFlush();
    using(var bitmap=new Bitmap(rect.Right-rect.Left,rect.Bottom-rect.Top))
    using(var graphics=Graphics.FromImage(bitmap)) {
      graphics.CopyFromScreen(rect.Left,rect.Top,0,0,bitmap.Size);
      bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
  }
}
'@
[InstallerSetupProbe]::DebugImagePath=Join-Path $PreviewRoot 'installer-setup-empty-region.png'

function Assert-Condition([bool]$condition,[string]$message) {
  if (!$condition) { throw $message }
}
function Wait-For([scriptblock]$condition,[string]$message) {
  for ($attempt=0; $attempt -lt 80; $attempt++) {
    if (& $condition) { return }
    Start-Sleep -Milliseconds 75
  }
  throw $message
}
function Read-State {
  try { return ([IO.File]::ReadAllText((Join-Path $FixtureRoot 'state.txt'))) -split '\|' }
  catch [IO.IOException] { return @() }
}
function Wait-Page([string]$kind,[int]$visit) {
  try {
    Wait-For {
      $script:pageState = @(Read-State)
      $pageState.Count -ge 2 -and $pageState[0] -eq $kind -and $pageState[1] -eq [string]$visit -and
        ($kind -eq 'progress' -or ($pageState.Count -ge 3 -and [InstallerSetupProbe]::IsWindowVisible([IntPtr][long]$pageState[2])))
    } "The $kind page (visit $visit) did not appear."
  } catch {
    Write-Output "Last native state: $($pageState -join '|')"
    if ($pageState.Count -ge 3) { Write-Output "Page visible: $([InstallerSetupProbe]::IsWindowVisible([IntPtr][long]$pageState[2]))" }
    throw
  }
}
function Native-Command([IntPtr]$window,[int]$id) {
  $button = [InstallerSetupProbe]::GetDlgItem($window,$id)
  Assert-Condition ([InstallerSetupProbe]::IsWindowEnabled($button)) "Native navigation button $id is disabled."
  [void][InstallerSetupProbe]::PostMessage($window,0x111,[IntPtr]$id,$button)
}
function Keyboard-Choose([IntPtr]$window,[IntPtr]$radio) {
  [void][InstallerSetupProbe]::SetForegroundWindow($window)
  [void][InstallerSetupProbe]::PostMessage([InstallerSetupProbe]::GetParent($radio),0x28,$radio,[IntPtr]1)
  Wait-For { [InstallerSetupProbe]::Focused($radio) } 'A native radio could not receive keyboard focus.'
  [void][InstallerSetupProbe]::PostMessage($radio,0x100,[IntPtr]32,[IntPtr]::Zero)
  [void][InstallerSetupProbe]::PostMessage($radio,0x101,[IntPtr]32,[IntPtr]::Zero)
  Wait-For { [InstallerSetupProbe]::SendMessage($radio,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 1 } 'Keyboard Space did not select the native radio.'
}
function Assert-NativeMode([IntPtr]$window) {
  $page=[IntPtr][long]$pageState[2]
  $all = [IntPtr][long]$pageState[3]
  $current = [IntPtr][long]$pageState[4]
  $next = [InstallerSetupProbe]::GetDlgItem($window,1)
  Assert-Condition ([InstallerSetupProbe]::HasModernWidth($window)) 'Setup retained its narrow legacy window.'
  Assert-Condition ([InstallerSetupProbe]::Inside($page,$all) -and [InstallerSetupProbe]::Inside($page,$current)) 'Mode radios are clipped or hidden.'
  Assert-Condition ([InstallerSetupProbe]::RowsSeparate($all,$current)) 'Mode choice rows overlap.'
  Assert-Condition (([InstallerSetupProbe]::GetWindowLong($all,-16) -band 0xF) -eq 9 -and ([InstallerSetupProbe]::GetWindowLong($current,-16) -band 0xF) -eq 9) 'Setup replaced the native auto-radio controls.'
  $nextStyle=[InstallerSetupProbe]::GetWindowLong($next,-16)
  $nextImage=[InstallerSetupProbe]::SendMessage($next,0xF6,[IntPtr]::Zero,[IntPtr]::Zero)
  Assert-Condition ($pageState[7] -eq '0' -and $pageState[8] -eq '1') "Styling changed the native radio user data: current=$($pageState[7]) all=$($pageState[8])."
  # Native BCM_SETSHIELD itself can toggle BS_BITMAP or assign an internal
  # image. The presentation must own no Next bitmap and retain native text.
  Assert-Condition ($pageState[6] -eq '0' -and [InstallerSetupProbe]::Text($next).Length -gt 0) "Mode Next no longer retains native text/UAC-shield drawing: style=$nextStyle image=$nextImage."
  Assert-Footer $window
  Assert-Condition ([InstallerSetupProbe]::RowsSeparate($all,$next)) 'Mode radios overlap the footer.'
}
function Assert-Footer([IntPtr]$window) {
  $next=[InstallerSetupProbe]::GetDlgItem($window,1)
  $cancel=[InstallerSetupProbe]::GetDlgItem($window,2)
  $back=[InstallerSetupProbe]::GetDlgItem($window,3)
  Assert-Condition ([InstallerSetupProbe]::FitsWorkArea($window)) 'Setup extends outside the actual monitor work area.'
  Assert-Condition ([InstallerSetupProbe]::Inside($window,$next) -and [InstallerSetupProbe]::Inside($window,$cancel)) 'Next or Cancel is clipped.'
  Assert-Condition ([InstallerSetupProbe]::ColumnsSeparate($next,$cancel)) 'Next and Cancel overlap.'
  if ([InstallerSetupProbe]::IsWindowVisible($back)) {
    Assert-Condition ([InstallerSetupProbe]::Inside($window,$back) -and [InstallerSetupProbe]::ColumnsSeparate($back,$next)) 'Back is clipped or overlaps Next.'
  }
}
function Assert-Heading([IntPtr]$page,[int]$offset) {
  Assert-Condition ([InstallerSetupProbe]::CaptionDivider($window,$page)) 'The light caption is not separated from the page by a painted full-width hairline.'
  if ($case -ne 'short') {
    foreach ($index in @($offset,($offset+1),($offset+2))) {
      $control=[IntPtr][long]$pageState[$index]
      Assert-Condition ([InstallerSetupProbe]::Inside($page,$control)) 'A setup heading, subtitle or brand mark is hidden behind its native page.'
    }
    Assert-Condition ([InstallerSetupProbe]::RoundMark($window,[IntPtr][long]$pageState[$offset+2])) ('The visible brand mark is squeezed or undersized: ' + [InstallerSetupProbe]::LastRegion)
  }
}
function Assert-PaintedPage([IntPtr]$window,[int[]]$indices,[string]$preview) {
  $controls=[IntPtr[]]@($indices | ForEach-Object { [IntPtr][long]$pageState[$_] })
  $path=if($preview){Join-Path $PreviewRoot $preview}else{$null}
  try {
    Wait-For { [InstallerSetupProbe]::PaintedFrame($window,$controls,$path) } "The $case $($pageState[0]) page (visit $($pageState[1])) did not naturally paint all decoration in one frame."
  } catch {
    Write-Output "Last unpainted region: $([InstallerSetupProbe]::LastRegion)"
    throw
  }
}
function Assert-Directory([IntPtr]$window,[string]$preview) {
  $page=[IntPtr][long]$pageState[2]
  $edit=[IntPtr][long]$pageState[3]
  $browse=[IntPtr][long]$pageState[4]
  $label=[IntPtr][long]$pageState[9]
  Assert-Condition ([InstallerSetupProbe]::Inside($page,$edit) -and [InstallerSetupProbe]::Inside($page,$browse)) 'The directory field or Browse button is clipped.'
  Assert-Condition ([InstallerSetupProbe]::ColumnsSeparate($edit,$browse)) 'The directory field and Browse overlap.'
  Assert-Condition ([InstallerSetupProbe]::Inside($page,$label)) 'The directory field label is clipped or hidden.'
  Assert-Footer $window
  Assert-Heading $page 6
  $indices=if($case -eq 'short'){@(9)}else{@(6,7,8,9)}
  Assert-PaintedPage $window $indices $preview
}

foreach ($case in @('fresh','upgrade','short','silent')) {
  $rectangleWatching=$false
  $movedRectangle=$null
  foreach ($marker in @('state.txt','elevation.txt','shield.txt','reset.txt','closed.txt','silent.txt','finished.txt','motion.txt')) {
    $markerPath=Join-Path $FixtureRoot $marker
    if (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath }
  }
  $arguments=@('/case='+$case)
  if ($case -eq 'silent') { $arguments=@('/S','/case='+$case) }
  # The enclosing runner is hidden. Do not pass SW_HIDE as GUI STARTUPINFO:
  # Windows can then ignore the installer's first native ShowWindow request.
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$Executable
  $start.Arguments=$arguments -join ' '
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $fixtureProcess=[Diagnostics.Process]::Start($start)
  $script:window=[IntPtr]::Zero
  try {
    if ($case -eq 'silent') {
      Assert-Condition ($fixtureProcess.WaitForExit(7000)) 'Silent setup fixture did not finish.'
      Assert-Condition ($fixtureProcess.ExitCode -eq 0) 'Silent setup fixture failed.'
      $resources=([IO.File]::ReadAllText((Join-Path $FixtureRoot 'silent.txt'))) -split '\|'
      Assert-Condition ($resources.Count -eq 12 -and @($resources | Where-Object { $_ -ne '' -and $_ -ne '0' }).Count -eq 0) 'Silent setup created decoration resources.'
      Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'state.txt'))) 'Silent setup visited a wizard page.'
      Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'motion.txt'))) 'Silent setup animated a hidden wizard.'
      continue
    }
    Wait-For { $script:window=[InstallerSetupProbe]::Find([uint32]$fixtureProcess.Id); $window -ne [IntPtr]::Zero } 'Setup fixture window was not created.'
    Wait-Page 'mode' 1
    Assert-NativeMode $window
    Assert-Heading ([IntPtr][long]$pageState[2]) 9
    $indices=if($case -eq 'short'){@(9)}else{@(9,10,11)}
    $preview=if($case -eq 'fresh'){'installer-setup-mode.png'}else{$null}
    Assert-PaintedPage $window $indices $preview
    $all=[IntPtr][long]$pageState[3]
    $current=[IntPtr][long]$pageState[4]
    Assert-Condition ([InstallerSetupProbe]::SendMessage($current,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 1) 'Current-user mode stopped being the default.'
    if ($case -eq 'fresh') {
      Keyboard-Choose $window $all
      Assert-Condition ([InstallerSetupProbe]::SendMessage($current,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 0) 'The native radio group retained two checked choices.'
      Wait-For { (Test-Path -LiteralPath (Join-Path $FixtureRoot 'shield.txt')) -and [IO.File]::ReadAllText((Join-Path $FixtureRoot 'shield.txt')).Contains('on') } 'Selecting all users lost the upstream elevation-shield request.'
      Wait-For { [InstallerSetupProbe]::SendMessage([InstallerSetupProbe]::GetDlgItem($window,1),0xF6,[IntPtr]::Zero,[IntPtr]::Zero) -ne [IntPtr]::Zero } 'Native all-users Next did not expose its elevation image.'
      Assert-NativeMode $window
      Native-Command $window 1
      Wait-For { Test-Path -LiteralPath (Join-Path $FixtureRoot 'elevation.txt') } 'The fixture did not exercise the bounded elevation-denied branch.'
      Assert-Condition ((Read-State)[0] -eq 'mode' -and [InstallerSetupProbe]::IsWindowVisible($window)) 'Denied elevation left the native mode page.'
      Keyboard-Choose $window $current
      $movedRectangle=[InstallerSetupProbe]::MoveFromCenter($window)
      [InstallerSetupProbe]::BeginRectangleWatch($window,$movedRectangle)
      $rectangleWatching=$true
    }
    Native-Command $window 1
    Wait-Page 'directory' 1
    $edit=[IntPtr][long]$pageState[3]
    $browse=[IntPtr][long]$pageState[4]
    $preview=if($case -eq 'upgrade'){'installer-setup-upgrade.png'}elseif($case -eq 'short'){'installer-setup-short.png'}else{'installer-setup-directory.png'}
    Assert-Directory $window $preview
    if ($case -ne 'upgrade') {
      Assert-Condition ([InstallerSetupProbe]::IsWindowEnabled($edit) -and [InstallerSetupProbe]::IsWindowEnabled($browse)) 'Fresh-install directory controls were disabled.'
      Assert-Condition ([InstallerSetupProbe]::SendMessage($browse,0xF6,[IntPtr]::Zero,[IntPtr]::Zero) -ne [IntPtr]::Zero) 'Browse did not receive its shared rounded-button image.'
      if ($case -eq 'fresh') {
        Native-Command $window 3
        Wait-Page 'mode' 2
        Assert-NativeMode $window
        Assert-Heading ([IntPtr][long]$pageState[2]) 9
        Assert-PaintedPage $window @(9,10,11) 'installer-setup-mode-back.png'
        Native-Command $window 1
        Wait-Page 'directory' 2
        $edit=[IntPtr][long]$pageState[3]
        Assert-Directory $window 'installer-setup-directory-back.png'
        Assert-Condition ([InstallerSetupProbe]::IsWindowEnabled($edit)) 'Back navigation lost the editable fresh-install directory.'
      }
      [void][InstallerSetupProbe]::SendText($edit,0xC,[IntPtr]::Zero,(Join-Path $FixtureRoot 'selected location'))
      Assert-Condition ([InstallerSetupProbe]::Text($edit) -eq (Join-Path $FixtureRoot 'selected location')) 'The native directory field did not accept an edited location.'
    } else {
      Assert-Condition (![InstallerSetupProbe]::IsWindowEnabled($edit) -and ![InstallerSetupProbe]::IsWindowEnabled($browse)) 'Styling re-enabled a locked upgrade location.'
      Assert-Condition ([InstallerSetupProbe]::Text($edit) -eq (Join-Path $FixtureRoot '已安装 软件')) 'The locked upgrade location changed.'
      # Screen capture is optional: Windows can deny foreground activation in
      # an unattended desktop. Required pixel checks use the native window.
      [void][InstallerSetupProbe]::SaveScreen($window,(Join-Path $PreviewRoot 'installer-setup-upgrade-screen.png'))
    }
    Native-Command $window 1
    Wait-Page 'progress' 1
    if ($rectangleWatching) {
      $transientRectangle=[InstallerSetupProbe]::EndRectangleWatch()
      $rectangleWatching=$false
      Assert-Condition ([string]::IsNullOrEmpty($transientRectangle)) "Navigation briefly moved or resized a dragged setup window: expected=$movedRectangle observed=$transientRectangle."
      Assert-Condition ([InstallerSetupProbe]::Rectangle($window) -eq $movedRectangle) 'Entering installation did not preserve the dragged window rectangle.'
    }
    Assert-Condition ([InstallerSetupProbe]::CaptionDivider($window,[IntPtr][long]$pageState[2])) 'The installation page lost the shared caption divider.'
    $reset=([IO.File]::ReadAllText((Join-Path $FixtureRoot 'reset.txt'))) -split '\|'
    Assert-Condition ($reset.Count -eq 17 -and @($reset[0..14] | Where-Object { $_ -ne '0' }).Count -eq 0 -and $reset[15] -eq $reset[16]) 'Setup kept owned resources, navigation images or its font when entering progress.'
    Wait-For { (Test-Path -LiteralPath (Join-Path $FixtureRoot 'finished.txt')) -and [InstallerSetupProbe]::IsWindowEnabled([InstallerSetupProbe]::GetDlgItem($window,1)) } 'The harmless fixture install section did not finish.'
    $nativeBack=[InstallerSetupProbe]::GetDlgItem($window,3)
    Assert-Condition ($nativeBack -ne [IntPtr]::Zero -and ![InstallerSetupProbe]::HasVisibleArea($nativeBack) -and ![InstallerSetupProbe]::IsWindowEnabled($nativeBack)) 'The completed installation page exposed a legacy Back button or changed its native disabled state.'
    if ($case -eq 'fresh') {
      $progressPage=[IntPtr][long]$pageState[2]
      $scene=[IntPtr][long]$pageState[3]
      Assert-Condition ([InstallerSetupProbe]::FullHero($window,$progressPage,$scene,[IntPtr][long]$pageState[4],[IntPtr][long]$pageState[5])) 'The installation window clips the complete orbit canvas or overlaps it with the title.'
      # Seek a real native AVI frame whose blue head reaches the lower orbit.
      # Checking geometry alone would not catch clipping inside SysAnimate32.
      [void][InstallerSetupProbe]::SendMessage($scene,0x465,[IntPtr]1,[IntPtr]0x00540054)
      Wait-For { [InstallerSetupProbe]::PaintedLowerOrbit($window,$scene) } ('The lower blue orbit was not painted in the native player: ' + [InstallerSetupProbe]::LastRegion)
      [InstallerSetupProbe]::SaveWindow($window,(Join-Path $PreviewRoot 'installer-setup-orbit-frame.png'))
    }
    $installed=[IO.File]::ReadAllText((Join-Path $FixtureRoot 'finished.txt'),[Text.Encoding]::Unicode)
    $expected=if($case -eq 'upgrade'){Join-Path $FixtureRoot '已安装 软件'}else{Join-Path $FixtureRoot 'selected location'}
    Assert-Condition ($installed -eq $expected) "Presentation changed the selected native installation path ($case): actual=$installed expected=$expected."
    Native-Command $window 1
    Assert-Condition ($fixtureProcess.WaitForExit(7000)) 'Setup did not close after the harmless fixture section.'
    Assert-Condition ($fixtureProcess.ExitCode -eq 0) 'Setup fixture returned a failure.'
    $motions=[IO.File]::ReadAllLines((Join-Path $FixtureRoot 'motion.txt'))
    Assert-Condition (($motions -join '|') -eq 'open|close') ('The wizard must enter once and must not replay window motion during page navigation: ' + ($motions -join '|'))
    $closed=([IO.File]::ReadAllText((Join-Path $FixtureRoot 'closed.txt'))) -split '\|'
    Assert-Condition ($closed.Count -eq 12 -and @($closed | Where-Object { $_ -ne '0' }).Count -eq 0) 'Setup decoration resources were not cleared on GUI end.'
  } catch {
    if ($window -ne [IntPtr]::Zero -and !$fixtureProcess.HasExited) {
      [void][InstallerSetupProbe]::SaveScreen($window,(Join-Path $PreviewRoot 'installer-setup-failure-screen.png'))
      [InstallerSetupProbe]::SaveWindow($window,(Join-Path $PreviewRoot 'installer-setup-failure.png'))
    }
    throw
  } finally {
    if ($rectangleWatching) { [void][InstallerSetupProbe]::EndRectangleWatch() }
    if (!$fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id -Force }
    $fixtureProcess.Dispose()
  }
}
Write-Output 'setup presentation checks passed'
