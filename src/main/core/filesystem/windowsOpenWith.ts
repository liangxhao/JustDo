import { execFile } from 'child_process';
import path from 'path';

const OPEN_WITH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class NativeOpenWith {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct OpenAsInfo {
    [MarshalAs(UnmanagedType.LPWStr)] public string File;
    [MarshalAs(UnmanagedType.LPWStr)] public string Class;
    public uint Flags;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  private static extern int SHOpenWithDialog(IntPtr owner, ref OpenAsInfo info);

  public static int Show(string filePath, string ownerHandle) {
    const uint OAIF_EXEC = 0x00000004;
    var info = new OpenAsInfo { File = filePath, Class = null, Flags = OAIF_EXEC };
    return SHOpenWithDialog(new IntPtr(Int64.Parse(ownerHandle)), ref info);
  }
}
'@
$hresult = [NativeOpenWith]::Show([string]$payload.filePath, [string]$payload.ownerHandle)
@{ hresult = $hresult } | ConvertTo-Json -Compress
`;

// Node's windowsHide also sets SW_HIDE for GUI windows. Start the native caller
// without a console or that inherited show flag so the chooser remains visible.
const OPEN_WITH_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$info.Arguments = '-NoLogo -NoProfile -NonInteractive -STA -EncodedCommand ' + $payload.chooserCommand
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
$info.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $info
[void]$child.Start()
$child.StandardInput.WriteLine(($payload | ConvertTo-Json -Compress))
$child.StandardInput.Close()
$stdout = $child.StandardOutput.ReadToEndAsync()
$stderr = $child.StandardError.ReadToEndAsync()
$child.WaitForExit()
[Console]::Out.Write($stdout.Result)
[Console]::Error.Write($stderr.Result)
exit $child.ExitCode
`;

const CANCELLED_HRESULT = -2147023673; // HRESULT_FROM_WIN32(ERROR_CANCELLED)

/** Resolves when the system chooser closes, including an ordinary user cancellation. */
export const showWindowsOpenWithDialog = (
  filePath: string,
  ownerHandle?: Buffer,
): Promise<void> => {
  const owner = !ownerHandle
    ? '0'
    : ownerHandle.length >= 8
      ? ownerHandle.readBigUInt64LE().toString()
      : ownerHandle.readUInt32LE().toString();
  const executable = path.win32.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const command = Buffer.from(OPEN_WITH_BOOTSTRAP, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', command],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024, timeout: 0 },
      (error, stdout) => {
        if (error) {
          reject(new Error('Windows app chooser could not run.'));
          return;
        }
        let result: unknown;
        try {
          result = JSON.parse(stdout.trim());
        } catch {
          reject(new Error('Windows app chooser returned an invalid response.'));
          return;
        }
        const hresult =
          result && typeof result === 'object' && 'hresult' in result ? result.hresult : undefined;
        if (
          typeof hresult !== 'number' ||
          !Number.isInteger(hresult) ||
          hresult < -2147483648 ||
          hresult > 2147483647
        ) {
          reject(new Error('Windows app chooser returned an invalid response.'));
        } else if (hresult < 0 && hresult !== CANCELLED_HRESULT) {
          reject(
            new Error(`Windows app chooser failed (HRESULT 0x${(hresult >>> 0).toString(16)}).`),
          );
        } else {
          resolve();
        }
      },
    );
    // Process launch/exit failures are reported by execFile's callback.
    child.stdin?.on('error', () => {});
    child.stdin?.end(
      JSON.stringify({
        filePath,
        ownerHandle: owner,
        chooserCommand: Buffer.from(OPEN_WITH_SCRIPT, 'utf16le').toString('base64'),
      }),
    );
  });
};
