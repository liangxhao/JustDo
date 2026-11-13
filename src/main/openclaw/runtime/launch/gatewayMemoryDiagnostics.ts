import { createRequire } from 'node:module';
import path from 'node:path';

const requireRuntimeModule = createRequire(__filename);

export const GatewayMemoryEvent = {
  Spawn: 'spawn',
  FatalStderr: 'fatal-stderr',
  UnexpectedExit: 'unexpected-exit',
  SpawnError: 'spawn-error',
} as const;

type GatewayMemoryEvent = (typeof GatewayMemoryEvent)[keyof typeof GatewayMemoryEvent];

export type GatewayMemoryLogger = (
  event: GatewayMemoryEvent,
  exit?: { code: number | null; signal: NodeJS.Signals | null },
) => void;

export function isGatewayOutOfMemory(line: string): boolean {
  return /^FATAL ERROR: (?:.* )?Allocation failed - (?:JavaScript heap|process) out of memory\s*$/i.test(line);
}

type PerformanceInformation = {
  CommitTotal?: number | bigint;
  CommitLimit?: number | bigint;
  PageSize?: number | bigint;
};

type Koffi = {
  struct: (fields: Record<string, string>) => object;
  sizeof: (type: object) => number;
  pointer: (type: object) => object;
  out: (type: object) => object;
  load: (name: string) => {
    func: (convention: string, name: string, result: string, args: Array<object | string>) =>
      (info: PerformanceInformation, size: number) => number;
  };
};

function openMemoryQuery(runtimeRoot: string) {
  // The prepared Windows runtime already ships Koffi and its native binding for SQLite.
  const koffi = requireRuntimeModule(path.join(runtimeRoot, 'node_modules', 'koffi')) as Koffi;
  const info = koffi.struct({
    cb: 'uint32_t',
    CommitTotal: 'size_t',
    CommitLimit: 'size_t',
    CommitPeak: 'size_t',
    PhysicalTotal: 'size_t',
    PhysicalAvailable: 'size_t',
    SystemCache: 'size_t',
    KernelTotal: 'size_t',
    KernelPaged: 'size_t',
    KernelNonpaged: 'size_t',
    PageSize: 'size_t',
    HandleCount: 'uint32_t',
    ProcessCount: 'uint32_t',
    ThreadCount: 'uint32_t',
  });
  const size = koffi.sizeof(info);
  const kernel = koffi.load('kernel32.dll');
  const query = kernel.func('__stdcall', 'K32GetPerformanceInfo', 'int32_t', [
    koffi.out(koffi.pointer(info)), 'uint32_t',
  ]);
  return () => {
    const result: PerformanceInformation = {};
    if (!query(result, size)) return;
    const pageSize = Number(result.PageSize);
    const committedBytes = Number(result.CommitTotal) * pageSize;
    const commitLimitBytes = Number(result.CommitLimit) * pageSize;
    if (!Number.isSafeInteger(committedBytes) || committedBytes <= 0 ||
        !Number.isSafeInteger(commitLimitBytes) || commitLimitBytes <= 0) return;
    return { committedBytes, commitLimitBytes };
  };
}

export function createGatewayMemoryLogger(runtimeRoot: string) {
  if (process.platform !== 'win32') return;
  let query: ReturnType<typeof openMemoryQuery> | undefined;
  try {
    query = openMemoryQuery(runtimeRoot);
  } catch {
    // Sampling must remain optional even if the native dependency cannot load.
  }

  return (
    event: GatewayMemoryEvent,
    identity: { pid: number | null; processGeneration: number | null },
    exit?: Parameters<GatewayMemoryLogger>[1],
  ): void => {
    let sample: ReturnType<NonNullable<typeof query>>;
    try {
      sample = query?.();
    } catch {
      sample = undefined;
    }
    console.info(`[OpenClaw] gateway process memory ${JSON.stringify({
      event,
      ...identity,
      ...exit,
      ...(sample ?? { unavailable: query ? 'query_failed' : 'provider_unavailable' }),
    })}`);
  };
}
