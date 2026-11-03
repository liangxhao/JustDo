param([Parameter(Mandatory=$true)][string]$Executable,
      [Parameter(Mandatory=$true)][string]$FixtureRoot,
      [Parameter(Mandatory=$true)][string]$PreviewRoot,
      [Parameter(Mandatory=$true)][int]$HeroWidth,
      [Parameter(Mandatory=$true)][int]$HeroHeight,
      [Parameter(Mandatory=$true)][string]$ProductName)

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
  public static IntPtr CardBrowse;
  public static int HeroWidth, HeroHeight;
  public static int LayoutDpi;
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] public static extern IntPtr SendText(IntPtr window, uint message, IntPtr w, string text);
  [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)] public static extern IntPtr ReadText(IntPtr window, uint message, IntPtr w, StringBuilder text);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr window, ref Point point);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent, int id);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("dwmapi.dll")] public static extern int DwmFlush();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out uint value, int size);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  public static int Dpi(IntPtr window) { return LayoutDpi>0?LayoutDpi:(int)GetDpiForWindow(window); }
  public static bool SelectedMovie(string filename,IntPtr scene) {
    Rect hero;if(!GetWindowRect(scene,out hero))return false;
    int width=hero.Right-hero.Left,height=hero.Bottom-hero.Top,percent=100;
    foreach(int candidate in new int[]{200,175,150,125}) {
      if(Dpi(scene)>=96*candidate/100 && width>=HeroWidth*candidate/100 && height>=HeroHeight*candidate/100){percent=candidate;break;}
    }
    var bytes=System.IO.File.ReadAllBytes(filename);
    int selectedWidth=BitConverter.ToInt32(bytes,64),selectedHeight=BitConverter.ToInt32(bytes,68);
    LastRegion="selected AVI="+selectedWidth+"x"+selectedHeight+" expected scale="+percent+" scene="+width+"x"+height;
    return Encoding.ASCII.GetString(bytes,24,4)=="avih" && selectedWidth==HeroWidth*percent/100 && selectedHeight==HeroHeight*percent/100;
  }
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
  public static IntPtr FindOther(uint wanted,IntPtr main) {
    IntPtr found=IntPtr.Zero;
    EnumWindows((window,parameter)=>{uint pid;GetWindowThreadProcessId(window,out pid);if(pid==wanted && window!=main && IsWindowVisible(window)){found=window;return false;}return true;},IntPtr.Zero);
    return found;
  }
  public static string Text(IntPtr window) {int size=Math.Min(32767,Math.Max(0,SendMessage(window,0xE,IntPtr.Zero,IntPtr.Zero).ToInt32()))+1;var text=new StringBuilder(size);ReadText(window,0xD,(IntPtr)size,text);return text.ToString();}
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
    return client.Right>=Math.Min(560,560*(int)GetDpiForWindow(window)/96);
  }
  public static bool HasCompactCanvas(IntPtr window) {
    Rect client;if(!GetClientRect(window,out client))return false;
    int dpi=Dpi(window);
    return client.Right<=600*dpi/96+1 && client.Bottom<=460*dpi/96+1;
  }
  public static bool TintedCaption(IntPtr window) {
    uint color;
    if(DwmGetWindowAttribute(window,35,out color,4)!=0)return true;
    if(color!=0xF2E9E6){LastRegion="caption attribute="+color.ToString("X");return false;}
    Rect outer;var origin=new Point(0,0);
    if(!GetWindowRect(window,out outer) || !ClientToScreen(window,ref origin))return false;
    int captionHeight=origin.Y-outer.Top;
    if(captionHeight<4)return false;
    using(var bitmap=new Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      int y=captionHeight/2;
      foreach(int fraction in new int[]{1,2,3}) {
        var pixel=bitmap.GetPixel(bitmap.Width*fraction/4,y);
        LastRegion="caption pixel="+pixel.R+","+pixel.G+","+pixel.B;
        if(Math.Abs(pixel.R-230)>8 || Math.Abs(pixel.G-233)>8 || Math.Abs(pixel.B-242)>8)return false;
      }
      return true;
    }
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
      || !GetWindowRect(divider,out line) || !GetClientRect(page,out client) || !GetWindowRect(page,out pageRect)){LastRegion="divider not visible on page="+page;return false;}
    LastRegion="divider="+line.Left+","+line.Top+","+line.Right+","+line.Bottom+" page="+pageRect.Left+","+pageRect.Top+" width="+client.Right;
    if(line.Top!=pageRect.Top || line.Left!=pageRect.Left || line.Right-line.Left!=client.Right || line.Bottom-line.Top!=1)return false;
    using(var bitmap=new Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      foreach(int fraction in new int[]{1,2,3}) {
        int x=line.Left-outer.Left+(line.Right-line.Left)*fraction/4;
        var pixel=bitmap.GetPixel(x,line.Top-outer.Top);
        LastRegion="divider sample="+pixel.R+","+pixel.G+","+pixel.B+" fraction="+fraction;
        if(Math.Abs(pixel.R-229)>3 || Math.Abs(pixel.G-231)>3 || Math.Abs(pixel.B-237)>3)return false;
      }
      return true;
    }
  }
  public static bool FullHero(IntPtr window,IntPtr page,IntPtr scene,IntPtr title,IntPtr subtitle,IntPtr status) {
    Rect body,hero,heading,subheading,phase;
    if(!Inside(page,scene) || !Inside(page,title) || !Inside(page,subtitle) || !Inside(page,status)
      || !GetWindowRect(page,out body) || !GetWindowRect(scene,out hero) || !GetWindowRect(title,out heading)
      || !GetWindowRect(subtitle,out subheading) || !GetWindowRect(status,out phase))return false;
    int dpi=Dpi(window),width=hero.Right-hero.Left,height=hero.Bottom-hero.Top;
    LastRegion="left hero="+width+"x"+height+" heading gap="+(heading.Left-hero.Right)+" phase gap="+(phase.Top-Math.Max(hero.Bottom,subheading.Bottom));
    return width==HeroWidth*dpi/96 && height==HeroHeight*dpi/96
      && hero.Left-body.Left==28*dpi/96 && hero.Top-body.Top==8*dpi/96
      && heading.Left>=hero.Right+20*dpi/96 && heading.Right<=body.Right-28*dpi/96
      && subheading.Left==heading.Left && subheading.Right==heading.Right
      && heading.Top>=hero.Top && subheading.Top>=heading.Bottom+4*dpi/96
      && subheading.Bottom<=hero.Bottom && phase.Top>=Math.Max(hero.Bottom,subheading.Bottom)+14*dpi/96;
  }
  public static bool LogShowsTwoRows(IntPtr page,IntPtr log) {
    Rect client;if(!Inside(page,log) || !GetClientRect(log,out client))return false;
    int minimum=48*(int)GetDpiForWindow(log)/96;
    int rows=SendMessage(log,0x1028,IntPtr.Zero,IntPtr.Zero).ToInt32();
    LastRegion="log client="+client.Right+"x"+client.Bottom+" rows="+rows+" minimum height="+minimum;
    return client.Bottom>=minimum && rows>=2;
  }
  public static bool PaintedLowerOrbit(IntPtr window,IntPtr scene) {
    Rect outer,hero;if(!GetWindowRect(window,out outer) || !GetWindowRect(scene,out hero))return false;
    int width=hero.Right-hero.Left,height=hero.Bottom-hero.Top;
    int dpi=Dpi(window),percent=100;
    foreach(int candidate in new int[]{200,175,150,125}) {
      if(dpi>=96*candidate/100 && width>=HeroWidth*candidate/100 && height>=HeroHeight*candidate/100){percent=candidate;break;}
    }
    int clipWidth=HeroWidth*percent/100,clipHeight=HeroHeight*percent/100;
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
            var pixel=bitmap.GetPixel(x,y);if((pixel.R*2126+pixel.G*7152+pixel.B*722)/10000<210)count++;
          }
        if(count<=8) {
          if(!String.IsNullOrEmpty(DebugImagePath))bitmap.Save(DebugImagePath,System.Drawing.Imaging.ImageFormat.Png);
          return false;
        }
      }
      // Native BUTTON owns disabled bitmap tinting. The enabled surface must
      // blend exactly with its card; upgrade locking is asserted separately.
      if(CardBrowse!=IntPtr.Zero && IsWindowEnabled(CardBrowse)) {
        Rect button;if(!GetWindowRect(CardBrowse,out button))return false;
        int inset=Math.Max(2,2*Dpi(window)/96),y=button.Top-outer.Top+inset;
        foreach(int x in new int[]{button.Left-outer.Left+inset,button.Right-outer.Left-inset-1}) {
          if(x<0 || y<0 || x>=bitmap.Width || y>=bitmap.Height)return false;
          var pixel=bitmap.GetPixel(x,y);
          LastRegion="Browse card corner="+pixel.R+","+pixel.G+","+pixel.B;
          if(Math.Abs(pixel.R-243)>2 || Math.Abs(pixel.G-244)>2 || Math.Abs(pixel.B-248)>2)return false;
        }
      }
      if(!String.IsNullOrEmpty(path))bitmap.Save(path,System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
  }
  public static bool DirectoryPresentation(IntPtr window,IntPtr surface,IntPtr edit,IntPtr browse) {
    Rect outer,field,line,button;
    if(!GetWindowRect(window,out outer) || !GetWindowRect(surface,out field)
      || !GetWindowRect(edit,out line) || !GetWindowRect(browse,out button))return false;
    if((GetWindowLong(edit,-16)&4)!=0 || GetParent(surface)!=GetParent(edit)
      || Math.Abs(line.Top+line.Bottom-field.Top-field.Bottom)>1
      || field.Top!=button.Top || field.Bottom!=button.Bottom || !Inside(surface,edit))return false;
    DwmFlush();
    using(var bitmap=new Bitmap(outer.Right-outer.Left,outer.Bottom-outer.Top))
    using(var graphics=Graphics.FromImage(bitmap)) {
      var dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,2))return false;}finally{graphics.ReleaseHdc(dc);}
      int top=int.MaxValue,bottom=-1,count=0;
      for(int y=line.Top;y<line.Bottom;y++)for(int x=line.Left;x<line.Right;x++) {
        var pixel=bitmap.GetPixel(x-outer.Left,y-outer.Top);
        if(pixel.R<220 && pixel.G<220 && pixel.B<220){top=Math.Min(top,y);bottom=Math.Max(bottom,y);count++;}
      }
      LastRegion="Directory glyphs="+top+".."+bottom+" field="+field.Top+".."+field.Bottom;
      if(count<8 || Math.Abs(top+bottom-field.Top-field.Bottom+1)>Math.Max(4,4*Dpi(window)/96))return false;
      // Sample the fill away from the native caption and rounded corners.
      var fill=bitmap.GetPixel(button.Left-outer.Left+12*Dpi(window)/96,button.Top-outer.Top+(button.Bottom-button.Top)/2);
      LastRegion+=" Browse enabled="+IsWindowEnabled(browse)+" fill="+fill.R+","+fill.G+","+fill.B;
      if(IsWindowEnabled(browse)) {
        if(Math.Abs(fill.R-232)>3 || Math.Abs(fill.G-233)>3 || Math.Abs(fill.B-255)>3)return false;
        int ink=0;
        for(int y=button.Top;y<button.Bottom;y++)for(int x=button.Left;x<button.Right;x++) {
          var pixel=bitmap.GetPixel(x-outer.Left,y-outer.Top);
          if(pixel.B>pixel.R+40 && pixel.B>pixel.G+40 && pixel.R<160 && pixel.G<160)ink++;
        }
        return ink>8;
      }
      return Math.Abs(fill.R-fill.B)<20 && Math.Abs(fill.G-fill.B)<20;
    }
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

[InstallerSetupProbe]::DebugImagePath=Join-Path $PreviewRoot 'installer-combined-empty-region.png'
[InstallerSetupProbe]::HeroWidth=$HeroWidth
[InstallerSetupProbe]::HeroHeight=$HeroHeight
[void][InstallerSetupProbe]::SetThreadDpiAwarenessContext([IntPtr](-2))
function Assert-Condition([bool]$condition,[string]$message) { if(!$condition){throw $message} }
function Wait-For([scriptblock]$condition,[string]$message) {
  for($attempt=0;$attempt -lt 100;$attempt++){
    if(& $condition){return}
    Start-Sleep -Milliseconds 60
  }
  throw $message
}
function Read-State {
  try { return ([IO.File]::ReadAllText((Join-Path $FixtureRoot 'state.txt'))) -split '\|' }
  catch [IO.IOException] { return @() }
}
function Wait-Page([string]$kind) {
  Wait-For {
    $script:pageState=@(Read-State)
    $pageState.Count -ge 3 -and $pageState[0] -eq $kind -and [InstallerSetupProbe]::IsWindowVisible([IntPtr][long]$pageState[2])
  } "The $kind page did not appear."
}
function Native-Command([IntPtr]$window,[int]$id) {
  $button=[InstallerSetupProbe]::GetDlgItem($window,$id)
  Assert-Condition ([InstallerSetupProbe]::IsWindowEnabled($button)) "Native action $id is disabled."
  [void][InstallerSetupProbe]::PostMessage($window,0x111,[IntPtr]$id,$button)
}
function Set-Path([IntPtr]$edit,[string]$value) {
  [void][InstallerSetupProbe]::SendText($edit,0xC,[IntPtr]::Zero,$value)
  Wait-For { [InstallerSetupProbe]::Text($edit) -eq $value } 'The path editor did not keep the entered text.'
}
function Normalized-Path([string]$value) {
  if($value.IndexOf($ProductName,[StringComparison]::OrdinalIgnoreCase) -ge 0){return $value}
  return Join-Path $value $ProductName
}
function Assert-ClosedResources {
  $closed=([IO.File]::ReadAllText((Join-Path $FixtureRoot 'closed.txt'))) -split '\|'
  Assert-Condition ($closed.Count -eq 9 -and @($closed | Where-Object { $_ -ne '0' }).Count -eq 0) "The combined page retained owned fonts, images or controls ($case): $($closed -join '|')."
}
function Keyboard-Choose([IntPtr]$radio) {
  $sequencePath=Join-Path $FixtureRoot 'scope-sequence.txt'
  $before=0
  if(Test-Path -LiteralPath $sequencePath){$before=[int](([IO.File]::ReadAllText($sequencePath,[Text.Encoding]::Unicode)) -split '\|')[0]}
  $mode=if($radio -eq $all){'all'}else{'CurrentUser'}
  [void][InstallerSetupProbe]::PostMessage([InstallerSetupProbe]::GetParent($radio),0x28,$radio,[IntPtr]1)
  Wait-For { [InstallerSetupProbe]::Focused($radio) } 'A scope choice could not receive keyboard focus.'
  [void][InstallerSetupProbe]::PostMessage($radio,0x100,[IntPtr]32,[IntPtr]::Zero)
  [void][InstallerSetupProbe]::PostMessage($radio,0x101,[IntPtr]32,[IntPtr]::Zero)
  Wait-For {
    try { $observed=([IO.File]::ReadAllText($sequencePath,[Text.Encoding]::Unicode)) -split '\|' }
    catch [IO.IOException] { return $false }
    [int]$observed[0] -gt $before -and $observed[1] -eq $mode -and [InstallerSetupProbe]::SendMessage($radio,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 1
  } 'Keyboard Space did not finish the actual scope-change callback.'
}
function Assert-Font([IntPtr]$control,[int]$pixels,[int]$weight) {
  $rows=@([IO.File]::ReadAllLines((Join-Path $FixtureRoot 'dpi-fonts.txt')) | Where-Object { $_.StartsWith("$control|") })
  Assert-Condition ($rows.Count -gt 0) "No in-process font measurement was recorded for $control."
  $font=$rows[-1] -split '\|'
  $dpi=[InstallerSetupProbe]::Dpi($window)
  $face=if($case -eq 'english' -or $case -eq 'short'){'Segoe UI'}else{'Microsoft YaHei UI'}
  Assert-Condition ([int]$font[1] -eq -[math]::Floor($pixels*$dpi/96) -and [int]$font[2] -eq $weight -and $font[3] -eq '5' -and $font[8] -eq $face) "The combined page has the wrong scaled font: $($font -join '|')."
  Assert-Condition ([InstallerSetupProbe]::SendMessage($control,0x31,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq ([long]$font[9] -band 0xFFFFFFFFL)) 'The page replaced its measured font after Show.'
  Assert-Condition ([int]$font[4] -le [int]$font[7] -and [int]$font[5] -le [int]$font[6]) 'The combined heading clips its actual native font.'
}
function Assert-Painted([IntPtr[]]$controls,[string]$filename) {
  $path=if($filename){Join-Path $PreviewRoot $filename}else{$null}
  try { Wait-For { [InstallerSetupProbe]::PaintedFrame($window,$controls,$path) } 'The complete combined setup did not paint in one frame.' }
  catch { throw ('The complete combined setup did not paint in one frame: ' + [InstallerSetupProbe]::LastRegion) }
}
function Assert-DirectoryPresentation {
  try { Wait-For { [InstallerSetupProbe]::DirectoryPresentation($window,$directorySurface,$edit,$browse) } 'Directory alignment or Browse state is incorrect.' }
  catch { throw ('Directory alignment or Browse state is incorrect: ' + [InstallerSetupProbe]::LastRegion) }
}
function Assert-Setup {
  $page=[IntPtr][long]$pageState[2]
  $script:current=[IntPtr][long]$pageState[3]
  $script:all=[IntPtr][long]$pageState[4]
  $script:edit=[IntPtr][long]$pageState[5]
  $script:browse=[IntPtr][long]$pageState[6]
  $script:hint=[IntPtr][long]$pageState[7]
  $script:directorySurface=[IntPtr][long]$pageState[19]
  foreach($control in @($current,$all,$edit,$browse)){
    Assert-Condition ([InstallerSetupProbe]::Inside($page,$control)) 'A scope or directory field is not on the one combined page.'
  }
  Assert-Condition ([InstallerSetupProbe]::ColumnsSeparate($edit,$browse)) 'The combined path and Browse overlap.'
  Assert-Condition ([InstallerSetupProbe]::RowsSeparate($current,$edit) -and [InstallerSetupProbe]::RowsSeparate($all,$edit)) 'Scope choices overlap the directory field.'
  $scopeLabel=[IntPtr][long]$pageState[17]
  $folderLabel=[IntPtr][long]$pageState[18]
  if([InstallerSetupProbe]::IsWindowVisible($scopeLabel)){
    Assert-Condition ([InstallerSetupProbe]::RowsSeparate($scopeLabel,$current) -and [InstallerSetupProbe]::RowsSeparate($scopeLabel,$all)) 'The scope label overlaps its radio choices.'
  }
  Assert-Condition ([InstallerSetupProbe]::Inside($page,$folderLabel) -and [InstallerSetupProbe]::RowsSeparate($folderLabel,$edit) -and [InstallerSetupProbe]::RowsSeparate($all,$folderLabel)) 'The folder label overlaps another combined-page control.'
  Assert-Condition ([InstallerSetupProbe]::GetParent($current) -eq $page -and [InstallerSetupProbe]::GetParent($edit) -eq $page) 'The choices and editor belong to separate hidden pages.'
  Assert-Condition (([InstallerSetupProbe]::GetWindowLong($current,-16) -band 0xF) -eq 9 -and ([InstallerSetupProbe]::GetWindowLong($all,-16) -band 0xF) -eq 9) 'The merged scope controls lost native auto-radio behavior.'
  Assert-Condition ([InstallerSetupProbe]::FitsWorkArea($window) -and [InstallerSetupProbe]::HasCompactCanvas($window)) 'The combined page exceeds its work area or compact canvas.'
  Assert-Condition (([InstallerSetupProbe]::GetWindowLong($window,-16) -band 0x00020000) -ne 0 -and ([InstallerSetupProbe]::GetWindowLong($window,-16) -band 0x00010000) -eq 0) 'The setup caption lost Minimize or added Maximize.'
  Wait-For { [InstallerSetupProbe]::CaptionDivider($window,$page) } 'The combined page lost the caption separator.'
  Assert-Condition ([InstallerSetupProbe]::TintedCaption($window)) 'The combined page lost its tinted native caption.'
  $next=[InstallerSetupProbe]::GetDlgItem($window,1)
  $cancel=[InstallerSetupProbe]::GetDlgItem($window,2)
  Assert-Condition ([InstallerSetupProbe]::Inside($window,$next) -and [InstallerSetupProbe]::Inside($window,$cancel) -and [InstallerSetupProbe]::ColumnsSeparate($next,$cancel)) 'Install or Cancel is clipped or overlapped.'
  Assert-Condition ([InstallerSetupProbe]::Text($next) -match 'Install|安装') 'The combined page still requires a Next step.'
  Assert-Condition (![InstallerSetupProbe]::HasVisibleArea([InstallerSetupProbe]::GetDlgItem($window,3))) 'The merged first page still exposes Back.'
  $heading=[IntPtr][long]$pageState[10]
  $subtitle=[IntPtr][long]$pageState[11]
  $logo=[IntPtr][long]$pageState[12]
  if([InstallerSetupProbe]::IsWindowVisible($logo)){
    Assert-Condition ([InstallerSetupProbe]::RoundMark($window,$logo)) ('The combined logo is distorted: ' + [InstallerSetupProbe]::LastRegion)
    Assert-Condition ([InstallerSetupProbe]::Text($heading).Contains($ProductName) -and [InstallerSetupProbe]::Text($heading).Length -le $ProductName.Length+12) 'The combined heading lost product branding or retained boilerplate.'
    Assert-Font $heading 20 400
    Assert-Font $subtitle 14 400
    $bitmap=([IO.File]::ReadAllText((Join-Path $FixtureRoot 'dpi-bitmap.txt'))) -split '\|'
    $logoPixels=if($pageState[15] -eq '1'){48}else{64}
    Assert-Condition ([int]$bitmap[0] -eq [math]::Floor($logoPixels*[InstallerSetupProbe]::Dpi($window)/96) -and $bitmap[0] -eq $bitmap[1]) 'The combined logo is not rendered at its native pixel density.'
  }
}
$cases=@('fresh','upgrade','mixed-scope','upgrade-machine','both-all','stale-user-live-machine','recovered-location','stale-only','english','dpi125','dpi175','dpi200','forced-current','forced-all','handoff','inner','inner-denied','inner-empty','inner-relative','inner-not-ready','inner-bridge-failed','updated','compact','header-short','short','silent')
foreach($case in $cases){
  [InstallerSetupProbe]::LayoutDpi=if($case -match '^dpi(\d+)$'){96*[int]$Matches[1]/100}elseif($case -eq 'short'){288}elseif($case -eq 'header-short' -or $case -eq 'compact'){192}else{0}
  foreach($name in @('state.txt','scope-sequence.txt','elevation.txt','closed.txt','silent.txt','finished.txt','motion.txt','dpi-fonts.txt','dpi-bitmap.txt')){
    $file=Join-Path $FixtureRoot $name
    if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}
  }
  $arguments=@('/case='+$case)
  if($case -eq 'silent'){$arguments=@('/S','/case='+$case)}
  $fixtureProcess=Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru
  $window=[IntPtr]::Zero
  $watching=$false
  try {
    if($case -eq 'silent'){
      Assert-Condition ($fixtureProcess.WaitForExit(7000) -and $fixtureProcess.ExitCode -eq 0) 'Silent setup failed.'
      Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'state.txt')) -and !(Test-Path -LiteralPath (Join-Path $FixtureRoot 'motion.txt'))) 'Silent setup created a page or motion.'
      continue
    }
    if($case -like 'inner-*'){
      $rejectionExit=if($case -eq 'inner-denied'){0x666666}else{2}
      Assert-Condition ($fixtureProcess.WaitForExit(7000) -and $fixtureProcess.ExitCode -eq $rejectionExit) "A rejected handoff did not return its expected failure code ($case, actual=$($fixtureProcess.ExitCode), expected=$rejectionExit)."
      Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'finished.txt')) -and !(Test-Path -LiteralPath (Join-Path $FixtureRoot 'state.txt'))) 'A rejected inner handoff created a setup page or wrote payload files.'
      continue
    }
    Wait-For { $script:window=[InstallerSetupProbe]::Find([uint32]$fixtureProcess.Id); $window -ne [IntPtr]::Zero } 'The installer window was not created.'
    Assert-Condition ([InstallerSetupProbe]::GetAwarenessFromDpiAwarenessContext([InstallerSetupProbe]::GetWindowDpiAwarenessContext($window)) -eq 1) 'The installer is not system DPI aware.'
    $expectedMode='CurrentUser'
    $expectedPath=$null
    if($case -eq 'inner' -or $case -eq 'updated'){
      Wait-Page 'progress'
      Assert-Condition ($pageState[1] -eq '0') 'The elevated/updated instance showed the setup form again.'
      if($case -eq 'inner'){
        $expectedMode='all'
        $expectedPath=Normalized-Path (Join-Path $FixtureRoot 'selected machine')
      }else{$expectedPath=Normalized-Path (Join-Path $FixtureRoot 'fresh location')}
    } else {
      Wait-Page 'setup'
      Assert-Condition ($pageState[1] -eq '1') 'More than one setup page was materialized.'
      Assert-Setup
      $controls=@($current,$all,$edit,$browse)
      foreach($index in @(10,11,12)){
        $control=[IntPtr][long]$pageState[$index]
        if([InstallerSetupProbe]::IsWindowVisible($control)){$controls+=$control}
      }
      $preview=if($case -eq 'fresh'){'installer-combined-setup.png'}elseif($case -eq 'english'){'installer-combined-setup-english.png'}elseif($case -like 'dpi*'){"installer-combined-$case.png"}else{$null}
      Assert-Painted $controls $preview
      Assert-DirectoryPresentation
      $selectedCurrent=Join-Path $FixtureRoot 'selected current 汉字 & %value%'
      $selectedMachine=Join-Path $FixtureRoot 'selected machine'
      if($case -eq 'fresh'){
        $initialPath=[InstallerSetupProbe]::Text($edit)
        [void][InstallerSetupProbe]::PostMessage($window,0x28,$current,[IntPtr]1)
        Wait-For { [InstallerSetupProbe]::Focused($current) } 'The scope choice could not receive focus before the padding click.'
        [void][InstallerSetupProbe]::PostMessage($directorySurface,0x201,[IntPtr]1,[IntPtr]0x00020002)
        [void][InstallerSetupProbe]::PostMessage($directorySurface,0x202,[IntPtr]::Zero,[IntPtr]0x00020002)
        Wait-For { [InstallerSetupProbe]::Focused($edit) } 'Clicking the white directory padding did not focus its native edit.'
        [void][InstallerSetupProbe]::PostMessage($window,0x112,[IntPtr]0xF020,[IntPtr]::Zero)
        Wait-For { [InstallerSetupProbe]::IsIconic($window) } 'The combined setup did not minimize through its native system command.'
        [void][InstallerSetupProbe]::PostMessage($window,0x112,[IntPtr]0xF120,[IntPtr]::Zero)
        Wait-For { ![InstallerSetupProbe]::IsIconic($window) -and [InstallerSetupProbe]::IsWindowVisible($window) -and [InstallerSetupProbe]::IsWindowEnabled($window) } 'The combined setup did not restore after minimizing.'
        Assert-Condition ([InstallerSetupProbe]::Text($edit) -eq $initialPath -and [InstallerSetupProbe]::IsWindowEnabled($browse)) 'Minimizing and restoring lost the setup path or actions.'
        $moved=[InstallerSetupProbe]::MoveFromCenter($window)
        [InstallerSetupProbe]::BeginRectangleWatch($window,$moved)
        $watching=$true
        $pathLimit=[int][IO.File]::ReadAllText((Join-Path $FixtureRoot 'path-limit.txt'))
        foreach($invalid in @('', 'relative folder', (Join-Path (Join-Path $FixtureRoot 'existing-file') 'nested'), ($FixtureRoot + '\' + ('x'*($pathLimit+1))))){
          Set-Path $edit $selectedCurrent
          Set-Path $edit $invalid
          $before=[InstallerSetupProbe]::Text($hint)
          Native-Command $window 1
          Wait-For { [InstallerSetupProbe]::Text($hint).Length -gt 0 -and [InstallerSetupProbe]::Focused($edit) } "Invalid directory input did not retain the form with an inline error (length=$($invalid.Length), prefix=$($invalid.Substring(0,[Math]::Min(80,$invalid.Length))))."
          Assert-Condition ([InstallerSetupProbe]::Text($edit) -eq $invalid -and !(Test-Path -LiteralPath (Join-Path $FixtureRoot 'finished.txt'))) 'Invalid input was silently replaced or began installation.'
          if($invalid -eq ''){
            Keyboard-Choose $all
            Keyboard-Choose $current
            Wait-For { [InstallerSetupProbe]::Text($edit) -eq '' } 'Changing scope replaced an empty path draft with a default.'
          }
        }
        Set-Path $edit $selectedCurrent
        [void][InstallerSetupProbe]::PostMessage($browse,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)
        Wait-For { $script:folderDialog=[InstallerSetupProbe]::FindOther([uint32]$fixtureProcess.Id,$window); $folderDialog -ne [IntPtr]::Zero } 'The native folder picker did not open.'
        [void][InstallerSetupProbe]::PostMessage($folderDialog,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
        Wait-For { [InstallerSetupProbe]::IsWindowEnabled($window) } 'Cancelling folder selection did not return to the combined page.'
        Assert-Condition ([InstallerSetupProbe]::Text($edit) -eq $selectedCurrent) 'Cancelling folder selection changed the chosen path.'
        Keyboard-Choose $all
        Set-Path $edit $selectedMachine
        Keyboard-Choose $current
        Wait-For { [InstallerSetupProbe]::Text($edit) -eq $selectedCurrent } 'Changing scope lost the current-user path draft.'
        Keyboard-Choose $all
        Wait-For { [InstallerSetupProbe]::Text($edit) -eq $selectedMachine } 'Changing scope lost the all-users path draft.'
        Native-Command $window 1
        Wait-For { Test-Path -LiteralPath (Join-Path $FixtureRoot 'elevation.txt') } 'All-users installation did not request elevation.'
        Wait-For { [InstallerSetupProbe]::IsWindowVisible($window) -and [InstallerSetupProbe]::IsWindowEnabled($window) } 'Declining elevation did not restore the existing page.'
        Assert-Condition ([InstallerSetupProbe]::Text($edit) -eq $selectedMachine -and [InstallerSetupProbe]::SendMessage($all,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 1) 'Declining elevation lost the scope or edited path.'
        Keyboard-Choose $current
        Wait-For { [InstallerSetupProbe]::Text($edit) -eq $selectedCurrent } 'Retrying as current user lost its draft.'
      } elseif($case -in @('upgrade','both-all')){
        Assert-Condition ([InstallerSetupProbe]::IsWindowEnabled($current) -and [InstallerSetupProbe]::IsWindowEnabled($all)) 'Two real installations must permit selecting the installation scope.'
        Assert-Condition (![InstallerSetupProbe]::IsWindowEnabled($edit) -and ![InstallerSetupProbe]::IsWindowEnabled($browse)) 'The selected real installation folder was not retained.'
        $initialPath=if($case -eq 'both-all'){Join-Path $FixtureRoot 'machine existing'}else{Join-Path $FixtureRoot '已安装 软件'}
        Assert-Condition ([InstallerSetupProbe]::Text($edit) -eq $initialPath) 'The initial real installation folder was not retained.'
        Keyboard-Choose $all
        Wait-For { [InstallerSetupProbe]::Text($edit) -eq (Join-Path $FixtureRoot 'machine existing') } 'Selecting the machine installation lost its real directory.'
        Keyboard-Choose $current
        $expectedPath=Join-Path $FixtureRoot '已安装 软件'
        Wait-For { [InstallerSetupProbe]::Text($edit) -eq $expectedPath } 'Selecting the user installation lost its real directory.'
        Assert-DirectoryPresentation
      } elseif($case -in @('mixed-scope','upgrade-machine','stale-user-live-machine','recovered-location')){
        Assert-Condition (![InstallerSetupProbe]::IsWindowEnabled($current) -and ![InstallerSetupProbe]::IsWindowEnabled($all)) 'An ordinary upgrade allowed its installation scope to change.'
        Assert-Condition (![InstallerSetupProbe]::IsWindowEnabled($edit) -and ![InstallerSetupProbe]::IsWindowEnabled($browse)) 'An ordinary upgrade allowed its installation folder to change.'
        if($case -in @('upgrade-machine','stale-user-live-machine')){
          $expectedMode='all'
          $expectedPath=Join-Path $FixtureRoot 'machine existing'
          Assert-Condition ([InstallerSetupProbe]::SendMessage($all,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 1) 'The registered machine scope was not retained.'
        } else {
          $expectedPath=Join-Path $FixtureRoot '已安装 软件'
          Assert-Condition ([InstallerSetupProbe]::SendMessage($current,0xF0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 1) 'The registered current-user scope was not retained.'
        }
        Assert-Condition ([InstallerSetupProbe]::Text($edit) -eq $expectedPath) 'The locked scope did not retain its registered folder.'
        Assert-Condition ([InstallerSetupProbe]::Text([IntPtr][long]$pageState[7]) -match '原安装范围') 'The upgrade hint did not describe its retained installation scope.'
        Assert-DirectoryPresentation
        Assert-Painted $controls 'installer-directory-locked.png'
      } else {
        if($case -eq 'stale-only'){
          Assert-Condition ([InstallerSetupProbe]::IsWindowEnabled($current) -and [InstallerSetupProbe]::IsWindowEnabled($all) -and [InstallerSetupProbe]::IsWindowEnabled($edit) -and [InstallerSetupProbe]::IsWindowEnabled($browse)) 'A stale registration locked the installation target.'
        }
        Set-Path $edit $selectedCurrent
      }
      if($case -eq 'forced-current'){
        Assert-Condition (![InstallerSetupProbe]::IsWindowEnabled($all)) 'Forced current-user setup allowed an all-users selection.'
      }
      if($case -eq 'forced-all' -or $case -eq 'handoff'){
        $expectedMode='all'
        Set-Path $edit $selectedMachine
        Assert-Condition (![InstallerSetupProbe]::IsWindowEnabled($current)) 'Forced all-users setup allowed a current-user selection.'
        Native-Command $window 1
        Wait-For { Test-Path -LiteralPath (Join-Path $FixtureRoot 'elevation.txt') } 'Forced all-users setup never requested elevation.'
        if($case -eq 'handoff'){
          Assert-Condition ($fixtureProcess.WaitForExit(7000) -and $fixtureProcess.ExitCode -eq 0) 'Successful elevation handoff did not finish the outer instance.'
          Assert-Condition (!(Test-Path -LiteralPath (Join-Path $FixtureRoot 'finished.txt'))) 'The handoff outer instance wrote application files.'
          $handoff=[IO.File]::ReadAllText((Join-Path $FixtureRoot 'elevation.txt'),[Text.Encoding]::Unicode)
          Assert-Condition ($handoff -eq "$(Normalized-Path $selectedMachine)|all") 'The selected directory was not available before elevation.'
          Assert-ClosedResources
          continue
        }
        Wait-For { [InstallerSetupProbe]::IsWindowVisible($window) -and [InstallerSetupProbe]::IsWindowEnabled($window) } 'Cancelling forced elevation closed the form.'
        Assert-Condition ([InstallerSetupProbe]::Text($edit) -eq $selectedMachine -and !$fixtureProcess.HasExited) 'Cancelling forced elevation changed the path or exited.'
        Native-Command $window 2
        Assert-Condition ($fixtureProcess.WaitForExit(7000)) 'The declined-elevation form did not close on explicit Cancel.'
        Assert-ClosedResources
        continue
      }
      if(!$expectedPath){$expectedPath=Normalized-Path $selectedCurrent}
      Native-Command $window 1
      Wait-Page 'progress'
      Assert-Condition ($pageState[1] -eq '1') 'Installation passed through another scope or directory page.'
      if($watching){
        $transient=[InstallerSetupProbe]::EndRectangleWatch()
        $watching=$false
        Assert-Condition ([string]::IsNullOrEmpty($transient) -and [InstallerSetupProbe]::Rectangle($window) -eq $moved) "The window jumped after selecting Install: $transient"
      }
    }
    Wait-For { (Test-Path -LiteralPath (Join-Path $FixtureRoot 'finished.txt')) -and [InstallerSetupProbe]::IsWindowEnabled([InstallerSetupProbe]::GetDlgItem($window,1)) } 'The harmless installation section did not finish.'
    $finished=[IO.File]::ReadAllText((Join-Path $FixtureRoot 'finished.txt'),[Text.Encoding]::Unicode) -split '\|'
    Assert-Condition ($finished[0] -eq $expectedMode -and $finished[1] -eq $expectedPath) "Wrong final mode or installation directory ($case): $($finished -join '|') expected=$expectedMode|$expectedPath"
    if($case -eq 'inner'){Assert-Condition ($finished[2] -eq '1') 'The elevated inner instance skipped the occupancy preflight.'}
    Assert-Condition (![InstallerSetupProbe]::HasVisibleArea([InstallerSetupProbe]::GetDlgItem($window,3))) 'The installation result exposed Back.'
    Assert-Condition ([InstallerSetupProbe]::IsWindowVisible([IntPtr][long]$pageState[8]) -and ![InstallerSetupProbe]::IsWindowVisible([InstallerSetupProbe]::GetDlgItem([IntPtr][long]$pageState[2],1027))) 'Installation did not show its log directly or retained the details link.'
    Native-Command $window 1
    Assert-Condition ($fixtureProcess.WaitForExit(7000) -and $fixtureProcess.ExitCode -eq 0) 'The result did not close normally.'
    Assert-ClosedResources
  } catch {
    if($window -ne [IntPtr]::Zero -and !$fixtureProcess.HasExited){
      [InstallerSetupProbe]::SaveWindow($window,(Join-Path $PreviewRoot 'installer-combined-failure.png'))
    }
    throw
  } finally {
    if($watching){[void][InstallerSetupProbe]::EndRectangleWatch()}
    if(!$fixtureProcess.HasExited){Stop-Process -Id $fixtureProcess.Id -Force}
    $fixtureProcess.Dispose()
  }
}
Write-Output 'combined setup presentation checks passed'
