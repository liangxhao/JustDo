import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { app } from 'electron';

const LOOPBACK = '127.0.0.1';
const NETWORK_SERVICE = 'network.mojom.NetworkService';
const START_TIMEOUT_MS = 5_000;
const LOOKUP_TIMEOUT_MS = 1_000;

const lookupScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.Runtime.InteropServices;

public static class BrowserTransportOwner {
  private const int AddressFamilyIpv4 = 2;
  private const int TcpTableOwnerPidConnections = 4;
  private const int TcpStateEstablished = 5;
  private const int LoopbackAddress = 0x0100007f;
  private const uint InsufficientBuffer = 122;
  private const uint ProcessQueryLimitedInformation = 0x1000;
  private const long FileTimeUnixEpoch = 116444736000000000L;

  [DllImport("iphlpapi.dll")]
  private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order,
    int family, int tableClass, uint reserved);

  [DllImport("kernel32.dll")]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint pid);

  [DllImport("kernel32.dll")]
  private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit,
    out long kernel, out long user);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  private static int FindPid(int clientPort, int relayPort) {
    int size = 0;
    if (GetExtendedTcpTable(IntPtr.Zero, ref size, false, AddressFamilyIpv4,
        TcpTableOwnerPidConnections, 0) != InsufficientBuffer) return 0;
    for (int attempt = 0; attempt < 3; attempt++) {
      IntPtr table = Marshal.AllocHGlobal(size);
      try {
        uint result = GetExtendedTcpTable(table, ref size, false, AddressFamilyIpv4,
          TcpTableOwnerPidConnections, 0);
        if (result == InsufficientBuffer) continue;
        if (result != 0) return 0;

        int entries = Marshal.ReadInt32(table);
        int pid = 0;
        for (int index = 0; index < entries; index++) {
          // MIB_TCPTABLE_OWNER_PID starts with a DWORD count and six DWORDs per row.
          IntPtr row = IntPtr.Add(table, 4 + index * 24);
          if (Marshal.ReadInt32(row, 0) != TcpStateEstablished ||
              Marshal.ReadInt32(row, 4) != LoopbackAddress ||
              Port(Marshal.ReadInt32(row, 8)) != clientPort ||
              Marshal.ReadInt32(row, 12) != LoopbackAddress ||
              Port(Marshal.ReadInt32(row, 16)) != relayPort) continue;
          int match = Marshal.ReadInt32(row, 20);
          if (pid != 0 && pid != match) return 0;
          pid = match;
        }
        return pid;
      } finally { Marshal.FreeHGlobal(table); }
    }
    return 0;
  }

  private static int Port(int value) { return ((value & 255) << 8) | ((value >> 8) & 255); }

  public static string Find(int clientPort, int relayPort) {
    int pid = FindPid(clientPort, relayPort);
    if (pid <= 0) return "unknown";
    IntPtr process = OpenProcess(ProcessQueryLimitedInformation, false, (uint)pid);
    if (process == IntPtr.Zero) return "unknown";
    try {
      long creation, exit, kernel, user;
      if (!GetProcessTimes(process, out creation, out exit, out kernel, out user) ||
          creation < FileTimeUnixEpoch || FindPid(clientPort, relayPort) != pid) return "unknown";
      long creationMicros = (creation - FileTimeUnixEpoch) / 10;
      return pid.ToString(CultureInfo.InvariantCulture) + " " +
        creationMicros.ToString(CultureInfo.InvariantCulture);
    } finally { CloseHandle(process); }
  }
}
'@
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::ReadLine())) {
  $result = 'unknown'
  try {
    $ports = $line.Split(' ')
    $result = [BrowserTransportOwner]::Find([int]$ports[0], [int]$ports[1])
  } catch {}
  [Console]::Out.WriteLine($result)
}
`;

type LookupProcess = {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<void>;
  resolveLine?: (line: string | null) => void;
};

function currentNetworkService(): Electron.ProcessMetric | undefined {
  const metrics = app.getAppMetrics();
  const brandedBrowser = metrics.some(
    metric => metric.type === 'Browser' && metric.pid === process.pid,
  );
  const services = metrics.filter(
    metric =>
      metric.type === 'Utility' &&
      metric.serviceName === NETWORK_SERVICE &&
      Number.isFinite(metric.creationTime),
  );
  return brandedBrowser && services.length === 1 ? services[0] : undefined;
}

function validPort(port: number | undefined): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535;
}

/** Authorizes a paused IPv4 loopback socket against this Electron browser's live Network Service. */
export class BrowserTransportOwner {
  private worker?: LookupProcess;
  private queue = Promise.resolve();
  private retirement?: Promise<void>;
  private stopping = false;

  authorize(socket: Socket): Promise<boolean> {
    const { remoteAddress, remotePort, localAddress, localPort } = socket;
    if (
      process.platform !== 'win32' ||
      this.stopping ||
      socket.destroyed ||
      remoteAddress !== LOOPBACK ||
      localAddress !== LOOPBACK ||
      !validPort(remotePort) ||
      !validPort(localPort)
    )
      return Promise.resolve(false);

    const result = this.queue
      .then(async () => {
        if (this.stopping || socket.destroyed) return false;
        const service = currentNetworkService();
        if (!service) return false;
        const worker = this.worker ?? (await this.start());
        if (!worker || this.stopping || socket.destroyed) return false;
        const pending = this.readLine(worker, LOOKUP_TIMEOUT_MS);
        worker.child.stdin.write(`${remotePort} ${localPort}\n`);
        const reply = await pending;
        if (!reply || this.stopping || socket.destroyed) return false;
        const match = /^(\d+) (\d+)$/.exec(reply);
        if (!match || Number(match[1]) !== service.pid) return false;

        const confirmed = currentNetworkService();
        // Electron's floating-point milliseconds may round at the microsecond boundary.
        return (
          confirmed?.pid === service.pid &&
          confirmed.creationTime === service.creationTime &&
          Math.abs(Number(match[2]) - Math.round(service.creationTime * 1_000)) <= 1
        );
      })
      .catch(() => false);
    this.queue = result.then(() => {});
    return result;
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.worker) this.retire(this.worker);
    return this.queue.then(() => this.retirement);
  }

  private async start(): Promise<LookupProcess | undefined> {
    await this.retirement;
    if (this.stopping) return;
    const executable = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const child = spawn(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(lookupScript, 'utf16le').toString('base64'),
      ],
      { windowsHide: true },
    );
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    const worker: LookupProcess = { child, exited };
    this.worker = worker;
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    lines.on('line', line => worker.resolveLine?.(line));
    child.stdin.on('error', () => this.retire(worker));
    child.on('error', () => this.retire(worker));
    void exited.then(() => {
      lines.close();
      this.retire(worker);
    });
    if ((await this.readLine(worker, START_TIMEOUT_MS)) === 'ready') return worker;
    this.retire(worker);
  }

  private readLine(worker: LookupProcess, timeoutMs: number): Promise<string | null> {
    return new Promise(resolve => {
      const timer = setTimeout(() => this.retire(worker), timeoutMs);
      worker.resolveLine = line => {
        clearTimeout(timer);
        worker.resolveLine = undefined;
        resolve(line);
      };
    });
  }

  private retire(worker: LookupProcess): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    worker.resolveLine?.(null);
    worker.child.stdin.end();
    const timer = setTimeout(() => worker.child.kill(), LOOKUP_TIMEOUT_MS);
    this.retirement = worker.exited.then(() => clearTimeout(timer));
  }
}
