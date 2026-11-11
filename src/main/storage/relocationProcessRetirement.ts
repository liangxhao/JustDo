import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SHUTDOWN_BUDGET_MS } from '../../shared/app/shutdownPolicy';

type ProcessIdentity = { pid: number; creationTime: number };
type RunningStorageProcess = { pid: number; name?: string };

export class StorageProcessesStillRunningError extends Error {
  constructor(readonly processes: readonly RunningStorageProcess[]) {
    super('An application process is still retiring.');
  }
}

export function findStorageProcessIdentity(pid: number): ProcessIdentity | null {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('Process identity is unavailable.');
  const executable = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = `
    $ErrorActionPreference='Stop'
    try { $p=[System.Diagnostics.Process]::GetProcessById(${pid}) }
    catch [System.ArgumentException] { 'null'; exit }
    ConvertTo-Json -Compress @{pid=$p.Id;creationTime=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()}
  `;
  const identity = JSON.parse(
    execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 15_000,
      encoding: 'utf8',
    }),
  );
  if (identity === null) return null;
  if (identity.pid !== pid || !Number.isFinite(identity.creationTime) || identity.creationTime <= 0)
    throw new Error('Process identity is unavailable.');
  return identity;
}

export function readStorageProcessIdentity(pid: number): ProcessIdentity {
  const identity = findStorageProcessIdentity(pid);
  if (!identity) throw new Error('Process identity is unavailable.');
  return identity;
}

/** Snapshot only Electron-owned children and the bundled runtime, never detached user apps. */
export function captureStorageProcesses(
  appProcesses: readonly ProcessIdentity[],
  bundledNode: string,
  gatewayPid?: number | null,
): ProcessIdentity[] {
  const script = `
    $ErrorActionPreference = 'Stop'
    Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1')
    $root = [System.Diagnostics.Process]::GetProcessById(${process.pid})
    $rootTime = ([DateTimeOffset]$root.StartTime).ToUnixTimeMilliseconds()
    $snapshot = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,ExecutablePath)
    $children = $snapshot | Group-Object -Property ParentProcessId -AsHashTable -AsString
    $byPid = $snapshot | Group-Object -Property ProcessId -AsHashTable -AsString
    $seen = [System.Collections.Generic.HashSet[int]]::new()
    $owners = [System.Collections.Generic.List[object]]::new()
    function Add-Owner($child, $after, $exact) {
      if (!$child -or $child.ProcessId -eq $PID -or $child.ProcessId -eq $root.Id) { return }
      if (!$child.CreationDate) { throw 'Could not identify a related process.' }
      $created = ([DateTimeOffset]$child.CreationDate).ToUnixTimeMilliseconds()
      if ($created -lt $after -or ($null -ne $exact -and $created -ne $exact)) { return }
      if ($seen.Add([int]$child.ProcessId)) {
        $owners.Add(@{pid=[int]$child.ProcessId;creationTime=$created})
      }
    }
    foreach ($entry in (ConvertFrom-Json $env:STORAGE_PROCESS_OWNERS)) {
      Add-Owner ($byPid[[string]$entry.pid] | Select-Object -First 1) $rootTime ([Math]::Truncate($entry.creationTime))
    }
    foreach ($child in $children[[string]$root.Id]) {
      if ($child.ExecutablePath -ieq $env:STORAGE_RUNTIME_NODE -or $child.ProcessId -eq [int]$env:STORAGE_GATEWAY_PID) {
        Add-Owner $child $rootTime $null
      }
    }
    for ($index = 0; $index -lt $owners.Count; $index++) {
      if ($owners.Count -ge 256) { throw 'Too many related processes to retire.' }
      $parent = $owners[$index]
      foreach ($child in $children[[string]$parent.pid]) {
        Add-Owner $child $parent.creationTime $null
      }
    }
    $owners.Add(@{pid=$root.Id;creationTime=$rootTime})
    ConvertTo-Json -Compress -InputObject @($owners | Sort-Object { $_.creationTime })
  `;
  return JSON.parse(runForcedStoragePowerShell(script, {
    STORAGE_PROCESS_OWNERS: JSON.stringify(appProcesses),
    STORAGE_RUNTIME_NODE: bundledNode,
    STORAGE_GATEWAY_PID: String(gatewayPid ?? 0),
  })) as ProcessIdentity[];
}

/** The old Main may only terminate identities observed in its own live process snapshot. */
export function terminateStorageProcesses(processes: readonly ProcessIdentity[]): void {
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class StorageProcessRetirement {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process,
    out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  public static void Stop(int pid, long creationTime) {
    var process = OpenProcess(0x1001, false, pid);
    if (process == IntPtr.Zero) return;
    try {
      long creation, exit, kernel, user;
      if (GetProcessTimes(process, out creation, out exit, out kernel, out user) &&
          creation / 10000 - 11644473600000L == creationTime)
        TerminateProcess(process, 1);
    } finally {
      CloseHandle(process);
    }
  }
}
'@
    foreach ($entry in (ConvertFrom-Json $env:STORAGE_PROCESS_OWNERS)) {
      if ($entry.pid -ne ${process.pid} -and $entry.pid -ne $PID) {
        [StorageProcessRetirement]::Stop($entry.pid, $entry.creationTime)
      }
    }
  `;
  runForcedStoragePowerShell(script, { STORAGE_PROCESS_OWNERS: JSON.stringify(processes) });
}

function runForcedStoragePowerShell(script: string, environment: Record<string, string>): string {
  if (process.platform !== 'win32') throw new Error('Process tree retirement requires Windows.');
  const executable = path.join(
    process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  return execFileSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...environment },
    windowsHide: true,
    timeout: SHUTDOWN_BUDGET_MS.forceExitObservation,
    encoding: 'utf8',
  });
}

export async function waitForForcedStorageRetirement(processes: readonly ProcessIdentity[]): Promise<void> {
  const deadline = Date.now() + SHUTDOWN_BUDGET_MS.forceExitObservation;
  for (;;) {
    try {
      await assertStorageProcessesRetired(processes, Math.max(1, deadline - Date.now()));
      return;
    } catch (error) {
      if (!(error instanceof StorageProcessesStillRunningError) || Date.now() >= deadline) throw error;
      await delay(Math.min(250, deadline - Date.now()));
    }
  }
}

export async function assertStorageProcessesRetired(
  processes: readonly ProcessIdentity[],
  timeoutMs = SHUTDOWN_BUDGET_MS.forceExitObservation,
): Promise<void> {
  if (process.platform !== 'win32')
    throw new Error('Offline relocation requires Windows process retirement checks.');
  const pids = [...new Set(processes.map(item => item.pid))];
  if (!pids.length || pids.length > 256 || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0))
    throw new Error('Process identities are unavailable.');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot))
    throw new Error('System process inspection is unavailable.');
  const executable = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  // Only validated numeric identities enter the fixed script; no user paths or commands are evaluated.
  const script = `
    $ErrorActionPreference='Stop'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $result=@()
    foreach($idValue in @(${pids.join(',')})){
      try{$p=[System.Diagnostics.Process]::GetProcessById($idValue)}catch [System.ArgumentException]{continue}
      $name=$null
      try{$name=$p.ProcessName}catch{}
      $result+=@{pid=$idValue;name=$name;creationTime=([DateTimeOffset]$p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()}
    }
    ConvertTo-Json -Compress -InputObject @($result)
  `;
  const output = await new Promise<string>((resolve, reject) =>
    execFile(
      executable,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' },
      (error, stdout) =>
        error ? reject(new Error('Process retirement could not be confirmed.')) : resolve(stdout),
    ),
  );
  const live: Array<ProcessIdentity & { name?: unknown }> = JSON.parse(output);
  if (!Array.isArray(live)) throw new Error('Invalid process inspection.');
  const confirmed: RunningStorageProcess[] = [];
  let mayStillBeRunning = false;
  for (const row of live) {
    if (!row || !Number.isSafeInteger(row.pid) || !Number.isFinite(row.creationTime))
      throw new Error('Invalid process identity.');
    if (processes.some(original =>
      original.pid === row.pid && Math.trunc(original.creationTime) === row.creationTime
    )) {
      const name = typeof row.name === 'string' && !/[\\/]/u.test(row.name)
        ? row.name.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').trim().slice(0, 128)
        : '';
      confirmed.push({ pid: row.pid, ...(name ? { name } : {}) });
    } else if (processes.some(original =>
      original.pid === row.pid && Math.abs(original.creationTime - row.creationTime) < 1000
    )) {
      // Preserve the retirement fence without identifying a possibly reused PID as the old owner.
      mayStillBeRunning = true;
    }
  }
  if (confirmed.length) throw new StorageProcessesStillRunningError(confirmed);
  if (mayStillBeRunning) throw new Error('An application process is still retiring.');
}
