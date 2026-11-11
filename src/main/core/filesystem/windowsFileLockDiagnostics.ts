import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';

export type WindowsLockingProcess = {
  name: string;
  pid: number;
  serviceName?: string;
};

export type WindowsLockDiagnosticResult = {
  available: boolean;
  processes: WindowsLockingProcess[];
};

const RESTART_MANAGER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class JustDoRestartManager {
  private const int CCH_RM_MAX_APP_NAME = 255;
  private const int CCH_RM_MAX_SVC_NAME = 63;

  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UNIQUE_PROCESS {
    public int dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }

  public enum RM_APP_TYPE {
    RmUnknownApp = 0,
    RmMainWindow = 1,
    RmOtherWindow = 2,
    RmService = 3,
    RmExplorer = 4,
    RmConsole = 5,
    RmCritical = 1000
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_APP_NAME + 1)]
    public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = CCH_RM_MAX_SVC_NAME + 1)]
    public string strServiceShortName;
    public RM_APP_TYPE ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)]
    public bool bRestartable;
  }

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmStartSession(out uint sessionHandle, int sessionFlags, string sessionKey);

  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  public static extern int RmRegisterResources(
    uint sessionHandle,
    uint fileCount,
    string[] fileNames,
    uint applicationCount,
    RM_UNIQUE_PROCESS[] applications,
    uint serviceCount,
    string[] serviceNames);

  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(
    uint sessionHandle,
    out uint processInfoNeeded,
    ref uint processInfoCount,
    [In, Out] RM_PROCESS_INFO[] affectedApps,
    ref uint rebootReasons);

  [DllImport("rstrtmgr.dll")]
  public static extern int RmEndSession(uint sessionHandle);
}

public static class JustDoHandleScanner {
  private const int SystemExtendedHandleInformation = 64;
  private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
  private const uint ProcessDuplicateHandle = 0x0040;
  private const uint DuplicateSameAccess = 0x00000002;
  private const uint FileTypeDisk = 0x0001;

  [StructLayout(LayoutKind.Sequential)]
  private struct SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX {
    public IntPtr Object;
    public IntPtr UniqueProcessId;
    public IntPtr HandleValue;
    public uint GrantedAccess;
    public ushort CreatorBackTraceIndex;
    public ushort ObjectTypeIndex;
    public uint HandleAttributes;
    public uint Reserved;
  }

  public sealed class LockingProcess {
    public string name { get; set; }
    public int pid { get; set; }
    public string serviceName { get; set; }
  }

  [DllImport("ntdll.dll")]
  private static extern int NtQuerySystemInformation(
    int systemInformationClass,
    IntPtr systemInformation,
    int systemInformationLength,
    out int returnLength);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool DuplicateHandle(
    IntPtr sourceProcessHandle,
    IntPtr sourceHandle,
    IntPtr targetProcessHandle,
    out IntPtr targetHandle,
    uint desiredAccess,
    bool inheritHandle,
    uint options);

  [DllImport("kernel32.dll")]
  private static extern IntPtr GetCurrentProcess();

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll")]
  private static extern uint GetFileType(IntPtr handle);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandle(
    IntPtr fileHandle,
    [Out] StringBuilder filePath,
    uint filePathLength,
    uint flags);

  private static string NormalizePath(string value) {
    if (String.IsNullOrWhiteSpace(value)) return String.Empty;
    if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) {
      value = @"\\" + value.Substring(8);
    } else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) {
      value = value.Substring(4);
    }
    return value.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
  }

  private static bool IsWithinTarget(string candidate, string target, bool exact) {
    if (candidate.Equals(target, StringComparison.OrdinalIgnoreCase)) return true;
    return !exact && candidate.StartsWith(target + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
  }

  public static bool Find(string targetPath, int priorityPid, bool exact, Action<LockingProcess> report) {
    string target = NormalizePath(Path.GetFullPath(targetPath));
    int bufferLength = 1024 * 1024;
    IntPtr buffer = IntPtr.Zero;
    var processHandles = new Dictionary<int, IntPtr>();
    var matches = new Dictionary<int, LockingProcess>();
    try {
      int status;
      int requiredLength;
      do {
        if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
        buffer = Marshal.AllocHGlobal(bufferLength);
        status = NtQuerySystemInformation(
          SystemExtendedHandleInformation, buffer, bufferLength, out requiredLength);
        if (status == StatusInfoLengthMismatch) {
          bufferLength = Math.Max(bufferLength * 2, requiredLength + 65536);
        }
      } while (status == StatusInfoLengthMismatch);
      if (status != 0) return false;

      long handleCount = Marshal.ReadIntPtr(buffer).ToInt64();
      int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
      IntPtr currentProcess = GetCurrentProcess();
      int scannerPid = Process.GetCurrentProcess().Id;
      // Report the application's own handles before unrelated path queries can stall.
      for (int pass = 0; pass < 2; pass++) {
        long offset = IntPtr.Size * 2L;
        for (long index = 0; index < handleCount; index++, offset += entrySize) {
          IntPtr entryPointer = new IntPtr(buffer.ToInt64() + offset);
          var entry = (SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(
            entryPointer, typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
          int pid;
          try { pid = checked((int)entry.UniqueProcessId.ToInt64()); }
          catch { continue; }
          if (pid <= 0 || pid == scannerPid || matches.ContainsKey(pid) ||
              ((pass == 0) != (pid == priorityPid))) continue;

          IntPtr sourceProcess;
          if (!processHandles.TryGetValue(pid, out sourceProcess)) {
            sourceProcess = OpenProcess(ProcessDuplicateHandle, false, pid);
            processHandles[pid] = sourceProcess;
          }
          if (sourceProcess == IntPtr.Zero) continue;

          IntPtr duplicate;
          if (!DuplicateHandle(
            sourceProcess, entry.HandleValue, currentProcess, out duplicate,
            0, false, DuplicateSameAccess)) continue;
          try {
            if (GetFileType(duplicate) != FileTypeDisk) continue;
            var pathBuffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(duplicate, pathBuffer, (uint)pathBuffer.Capacity, 0);
            if (length == 0 || length >= pathBuffer.Capacity) continue;
            if (!IsWithinTarget(NormalizePath(pathBuffer.ToString()), target, exact)) continue;

            string name;
            try { name = Process.GetProcessById(pid).ProcessName; }
            catch { name = "PID " + pid; }
            matches[pid] = new LockingProcess { name = name, pid = pid, serviceName = "" };
            report(matches[pid]);
          } finally {
            CloseHandle(duplicate);
          }
        }
      }
      return true;
    } finally {
      foreach (IntPtr processHandle in processHandles.Values) {
        if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
      }
      if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
    }
  }
}
'@

$reported = New-Object 'System.Collections.Generic.HashSet[int]'
$emitProcess = {
  param($entry)
  if ($reported.Add([int]$entry.pid)) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $entry -Compress))
    [Console]::Out.Flush()
  }
}

$handle = 0
$sessionStarted = $false
try {
  $key = [Guid]::NewGuid().ToString('N')
  $started = [JustDoRestartManager]::RmStartSession([ref]$handle, 0, $key)
  if ($started -ne 0) { throw "RmStartSession failed: $started" }
  $sessionStarted = $true
  $resources = [string[]]@($env:JUSTDO_LOCK_TARGET)
  $registered = [JustDoRestartManager]::RmRegisterResources(
    $handle, $resources.Length, $resources, 0, $null, 0, $null)
  if ($registered -ne 0) { throw "RmRegisterResources failed: $registered" }

  $needed = 0
  $count = 0
  $rebootReasons = 0
  $result = [JustDoRestartManager]::RmGetList(
    $handle, [ref]$needed, [ref]$count, $null, [ref]$rebootReasons)
  if ($result -eq 234) {
    $apps = New-Object JustDoRestartManager+RM_PROCESS_INFO[] $needed
    $count = $needed
    $result = [JustDoRestartManager]::RmGetList(
      $handle, [ref]$needed, [ref]$count, $apps, [ref]$rebootReasons)
  }
  if ($result -ne 0) {
    $count = 0
    $apps = @()
  }

  $restartManagerProcesses = @($apps | Select-Object -First $count | ForEach-Object {
    [pscustomobject]@{
      name = $_.strAppName
      pid = $_.Process.dwProcessId
      serviceName = $_.strServiceShortName
    }
  })
  foreach ($entry in $restartManagerProcesses) { & $emitProcess $entry }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
} finally {
  if ($sessionStarted) { [void][JustDoRestartManager]::RmEndSession($handle) }
}

# Restart Manager does not support directory resources; its failure must not skip handles.
try {
  $report = [System.Action[JustDoHandleScanner+LockingProcess]] {
    param($entry)
    & $emitProcess $entry
  }
  $complete = [JustDoHandleScanner]::Find($env:JUSTDO_LOCK_TARGET, [int]$env:FILE_LOCK_PRIORITY_PID, ($env:FILE_LOCK_EXACT_PATH -eq '1'), $report)
  if ($complete) { [Console]::Out.WriteLine('{"complete":true}') }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
}
`;

const resolveWindowsPowerShell = (): string => {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return systemRoot
    ? path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
};

export const findWindowsLockingProcesses = async (
  targetPath: string,
  options: { signal?: AbortSignal; exact?: boolean } = {},
): Promise<WindowsLockDiagnosticResult> => {
  if (process.platform !== 'win32' || options.signal?.aborted) return { available: false, processes: [] };

  const resolvedTarget = path.resolve(targetPath);
  try {
    fs.lstatSync(resolvedTarget);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Let native publication validate absent destinations without starting a
    // scanner. Absence is not proof of no locks: Windows can hide a directory
    // pending deletion, so retain an unknown diagnostic result.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { available: false, processes: [] };
  }

  let lookupTarget = resolvedTarget;
  if (!options.exact) {
    try { lookupTarget = fs.realpathSync.native(resolvedTarget); } catch { /* Keep inaccessible aliases unknown. */ }
  }

  const encodedCommand = Buffer.from(RESTART_MANAGER_SCRIPT, 'utf16le').toString('base64');
  type LookupResult = { stdout: string; stderr: string; error?: Error };
  const result = await new Promise<LookupResult>(resolve => {
    let reported: LookupResult | undefined;
    let closed = false;
    const finish = () => { if (closed && reported) resolve(reported); };
    try {
      const child = childProcess.execFile(
        resolveWindowsPowerShell(),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            JUSTDO_LOCK_TARGET: lookupTarget,
            FILE_LOCK_PRIORITY_PID: String(process.pid),
            FILE_LOCK_EXACT_PATH: options.exact ? '1' : '0',
          },
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        (error, stdout, stderr) => {
          reported = { stdout, stderr, ...(error ? { error } : {}) };
          finish();
        },
      );
      // AbortError can reach execFile's callback before the owned child closes.
      child.once('close', () => { closed = true; finish(); });
    } catch (error) {
      resolve({ stdout: '', stderr: '', error: error instanceof Error ? error : new Error('Lock lookup could not start.') });
    }
  });
  if (options.signal?.aborted) return { available: false, processes: [] };
  // Each complete line is independent evidence. A later timeout cannot erase it.
  const entries: unknown[] = [];
  let completed = false;
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as unknown;
      if (entry && typeof entry === 'object' && !Array.isArray(entry) &&
          Object.keys(entry).length === 1 && (entry as { complete?: unknown }).complete === true) completed = true;
      else entries.push(entry);
    } catch { /* A killed lookup can leave a truncated final record. */ }
  }
  const processes = entries
    .filter((entry): entry is Record<string, unknown> & { name: string; pid: number } => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      return typeof record.name === 'string' && !!record.name.trim() &&
        typeof record.pid === 'number' && Number.isSafeInteger(record.pid) && record.pid > 0;
    })
    .map(entry => ({
      name: entry.name.trim(),
      pid: entry.pid,
      ...(typeof entry.serviceName === 'string' && entry.serviceName.trim()
        ? { serviceName: entry.serviceName.trim() }
        : {}),
    }));
  const uniqueProcesses = [...new Map(processes.map(owner => [owner.pid, owner])).values()];
  const available = uniqueProcesses.length > 0 || (!result.error && completed);
  if (result.error || !available) {
    console.warn('[WindowsFileLockDiagnostics] Lock owner lookup incomplete:', {
      code: (result.error as NodeJS.ErrnoException | undefined)?.code,
      detail: result.stderr.trim().slice(0, 2048) || 'no completed scan',
      observedProcesses: uniqueProcesses.length,
    });
  }
  return { available, processes: uniqueProcesses };
};
