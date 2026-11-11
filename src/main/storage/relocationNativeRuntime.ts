import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import baseContract from '../startup/upgrade/nativeDatabaseContract.json';
import { nativeDatabaseEnvironment } from '../startup/upgrade/nativeDatabaseEnvironment';
import { admitNativeDatabaseRuntime } from '../startup/upgrade/nativeDatabaseIdentity';
import relocationContract from './relocationNativeContract.json';
import { decodeRelocationNativeFailure } from './relocationNativeFailure';
import { NATIVE_RELOCATION_SOURCE } from './relocationNativeSource';

export type ManagedPluginPathBinding = {
  location: 'registry' | 'config';
  pluginId: string;
  source: string;
  field: 'installPath' | 'sourcePath';
  relative: string;
};

export type NativeRelocationSourceFiles = {
  replaceFiles: Record<string, string>;
  excludeRelativePaths: string[];
  managedPlugins?: { paths: ManagedPluginPathBinding[]; peers: string[] };
};

export type NativeRelocationPluginPlan = NonNullable<NativeRelocationSourceFiles['managedPlugins']> & {
  sourceStateDir: string;
};

type PendingCheck = {
  id: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const ownedRelative = (relative: string): boolean =>
  Boolean(relative) &&
  !path.isAbsolute(relative) &&
  !/[\r\n\0:]/u.test(relative) &&
  relative.split(/[\\/]/u).every(part => Boolean(part) && part !== '.' && part !== '..');
const inside = (root: string, file: string): boolean => ownedRelative(path.relative(root, file));
const ownedPluginPaths = (values: unknown): values is string[] => Array.isArray(values) &&
  values.every(value => typeof value === 'string' && ownedRelative(value)) &&
  new Set(values.map(value => process.platform === 'win32' ? value.toLowerCase() : value)).size === values.length;
const ownedPluginBindings = (values: unknown): values is ManagedPluginPathBinding[] =>
  Array.isArray(values) && values.every(value => value &&
    (value.location === 'registry' || value.location === 'config') &&
    typeof value.pluginId === 'string' && typeof value.source === 'string' &&
    (value.field === 'installPath' || value.field === 'sourcePath') &&
    typeof value.relative === 'string' && ownedRelative(value.relative)) &&
  new Set(values.map(value => JSON.stringify([value.location, value.pluginId, value.field]))).size === values.length;

async function terminateOwnedTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid || !Number.isSafeInteger(child.pid))
    throw new Error('Native custody process identity is unavailable.');
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot))
      throw new Error('The system process retirement tool is unavailable.');
    await new Promise<void>((resolve, reject) =>
      execFile(
        path.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 10_000 },
        error => {
          if (error && child.exitCode === null && child.signalCode === null) reject(error);
          else resolve();
        },
      ),
    );
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

/** Source custody stays alive through locator commit. All snapshots are fresh native-owned images. */
export class NativeRelocationSource {
  private child: ChildProcess | null = null;
  private acquisition: Promise<NativeRelocationSourceFiles> | null = null;
  private acquisitionPending = false;
  private terminationPending = 0;
  private closed: Promise<void> | null = null;
  private failure: Error | null = null;
  private releasing = false;
  private held = false;
  private check: PendingCheck | undefined;

  constructor(
    private readonly options: {
      runtimeRoot: string;
      profileRoot: string;
      stateDir: string;
      configPath: string;
      snapshotDir: string;
      admit?: typeof admitNativeDatabaseRuntime;
      spawn?: typeof spawn;
      terminate?: (child: ChildProcess) => Promise<void>;
      acquireTimeoutMs?: number;
      healthTimeoutMs?: number;
      releaseTimeoutMs?: number;
    },
  ) {}

  acquire(): Promise<NativeRelocationSourceFiles> {
    if (!this.acquisition) {
      this.acquisitionPending = true;
      this.acquisition = this.start().finally(() => {
        this.acquisitionPending = false;
      });
    }
    return this.acquisition;
  }

  /** Resource retirement only. A failed/aborted operation can retire without any success proof. */
  get retirementConfirmed(): boolean {
    return !this.acquisitionPending && !this.child && this.terminationPending === 0;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    const check = this.check;
    if (!check) return;
    this.check = undefined;
    clearTimeout(check.timer);
    check.reject(this.failure);
  }

  private async start(): Promise<NativeRelocationSourceFiles> {
    if (this.releasing) throw new Error('Native relocation custody was already retired.');
    const identity = await (this.options.admit ?? admitNativeDatabaseRuntime)(this.options.runtimeRoot);
    if (identity.runtimeVersion !== relocationContract.openclawVersion)
      throw new Error('The bundled native relocation contract is unavailable.');
    const { profileRoot, stateDir, configPath, snapshotDir } = this.options;
    for (const value of [profileRoot, stateDir, configPath, snapshotDir]) {
      if (!path.isAbsolute(value) || /[\r\n\0]/u.test(value))
        throw new Error('Native relocation requires absolute paths.');
    }
    if (!inside(profileRoot, stateDir) || !inside(profileRoot, configPath))
      throw new Error('Native state must belong to the source profile.');
    if (this.releasing) throw new Error('Native relocation custody was interrupted.');
    const input = {
      identity,
      profileRoot,
      stateDir,
      configPath,
      snapshotDir,
      contract: {
        ...baseContract,
        modules: { ...baseContract.modules, ...relocationContract.modules },
      },
    };
    const child = (this.options.spawn ?? spawn)(
      identity.executable,
      ['--input-type=module', '-e', NATIVE_RELOCATION_SOURCE, JSON.stringify(input)],
      {
        cwd: identity.runtimeRoot,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: nativeDatabaseEnvironment(process.env, { stateDir, configPath }),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    this.child = child;
    let releasedReceipt = false;
    let readySettled = false;
    let resolveReady!: (files: NativeRelocationSourceFiles) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<NativeRelocationSourceFiles>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const timeout = setTimeout(
      () => {
        const error = new Error('Native relocation custody acquisition exceeded its deadline.');
        this.fail(error);
        rejectReady(error);
        void this.abort().catch(() => {});
      },
      this.options.acquireTimeoutMs ?? 30 * 60_000,
    );
    let outputBytes = 0;
    const countOutput = (chunk: string | Buffer) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > 16 * 1024 * 1024) {
        const error = new Error('Native relocation custody produced excessive output.');
        this.fail(error);
        rejectReady(error);
        void this.abort().catch(() => {});
      }
    };
    child.stdout?.on('data', countOutput);
    child.stderr?.on('data', countOutput);
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      const value = message as Record<string, unknown>;
      if (value.type === 'held') {
        const replacements = value.replaceFiles;
        const exclusions = value.excludeRelativePaths;
        const proof = value.identity as Record<string, unknown> | undefined;
        const plugins = value.managedPlugins as Record<string, unknown> | undefined;
        if (
          readySettled ||
          this.releasing ||
          proof?.runtimeBuildId !== identity.runtimeBuildId ||
          !replacements ||
          typeof replacements !== 'object' ||
          Array.isArray(replacements) ||
          Object.entries(replacements).some(
            ([relative, snapshot]) =>
              !ownedRelative(relative) ||
              typeof snapshot !== 'string' ||
              !path.isAbsolute(snapshot) ||
              !inside(snapshotDir, snapshot),
          ) ||
          !Array.isArray(exclusions) ||
          exclusions.some(relative => typeof relative !== 'string' || !ownedRelative(relative)) ||
          (plugins !== undefined && (!plugins || !ownedPluginBindings(plugins.paths) || !ownedPluginPaths(plugins.peers) ||
            plugins.peers.some(relative => !/[\\/]node_modules[\\/]openclaw$/u.test(relative))))
        ) {
          const error = new Error(
            'Native relocation custody returned an invalid snapshot receipt.',
          );
          this.fail(error);
          rejectReady(error);
          void this.abort().catch(() => {});
          return;
        }
        readySettled = true;
        clearTimeout(timeout);
        this.held = true;
        resolveReady({
          replaceFiles: replacements as Record<string, string>,
          excludeRelativePaths: exclusions as string[],
          ...(plugins ? { managedPlugins: { paths: plugins.paths as ManagedPluginPathBinding[], peers: plugins.peers as string[] } } : {}),
        });
      } else if (value.type === 'healthy' && typeof value.id === 'string') {
        const check = this.check;
        if (check?.id === value.id) {
          clearTimeout(check.timer);
          this.check = undefined;
          check.resolve();
        }
      } else if (value.type === 'released' && this.releasing) releasedReceipt = true;
      else if (value.type === 'failure') {
        const error = decodeRelocationNativeFailure('Native relocation custody failed.', value, [profileRoot, snapshotDir]);
        this.fail(error);
        rejectReady(error);
      }
    });
    child.once('error', error => {
      this.fail(error);
      rejectReady(error);
    });
    this.closed = new Promise<void>((resolve, reject) => {
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        this.child = null;
        this.held = false;
        if (!this.failure && (!this.releasing || !releasedReceipt || code !== 0 || signal))
          this.fail(new Error('Native relocation custody did not retire with a confirmed result.'));
        if (this.failure) {
          rejectReady(this.failure);
          reject(this.failure);
        } else resolve();
      });
    });
    // Child failure must be observed even while the coordinator is busy copying other files.
    void this.closed.catch(() => {});
    return ready;
  }

  async assertHeld(): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.child?.connected || !this.held || this.releasing)
      throw new Error('Native source custody is not active.');
    if (this.check) throw new Error('A native source custody check is already pending.');
    const child = this.child;
    const id = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Native relocation custody health could not be confirmed.');
        this.fail(error);
        void this.abort().catch(() => {});
      }, this.options.healthTimeoutMs ?? 10_000);
      this.check = { id, resolve, reject, timer };
      child.send({ type: 'check', id }, error => {
        if (error) this.fail(error);
      });
    });
    if (this.failure || !this.child || this.releasing)
      throw this.failure ?? new Error('Native custody changed during its health check.');
  }

  async release(): Promise<void> {
    await this.retire(false);
  }

  async abort(): Promise<void> {
    await this.retire(true);
  }

  private async retire(abort: boolean): Promise<void> {
    this.releasing = true;
    if (abort) this.fail(new Error('Native relocation custody was aborted.'));
    const child = this.child;
    if (!child) {
      if (this.failure) throw this.failure;
      return;
    }
    if (child.connected)
      child.send({ type: abort ? 'abort' : 'release' }, error => {
        if (error) this.fail(error);
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Native relocation custody retirement exceeded its deadline.');
        this.fail(error);
        this.terminationPending += 1;
        void (this.options.terminate ?? terminateOwnedTree)(child)
          .catch(() => {})
          .finally(() => {
            this.terminationPending -= 1;
          });
        reject(error);
      }, this.options.releaseTimeoutMs ?? 45_000);
    });
    try {
      await Promise.race([this.closed, timeout]);
    } finally {
      clearTimeout(timer);
    }
    if (this.failure) throw this.failure;
  }
}
