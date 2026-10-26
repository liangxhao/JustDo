import { type ChildProcess, execFile, spawn } from 'node:child_process';
import path from 'node:path';

import { StartupCompatibilityErrorCode } from '../../../shared/app/startup/versionPolicy';
import contract from './nativeDatabaseContract.json';
import { nativeDatabaseEnvironment } from './nativeDatabaseEnvironment';
import {
  admitNativeDatabaseRuntime,
  type NativeDatabaseDeliveryIdentity,
  type NativeDatabaseRuntimeIdentity,
  readNativeDatabaseDeliveryIdentity,
} from './nativeDatabaseIdentity';
import { NATIVE_DATABASE_UPGRADE_SOURCE } from './nativeDatabaseUpgradeSource';

export type NativeDatabaseUpgradeActivity = 'nativeInspect' | 'nativeBackup' | 'nativeUpgrade' | 'nativeVerify';
export type NativeDatabaseInventoryEntry = {
  agentId: string | null; path: string; realPath: string; dev: string; ino: string;
};
type NativeDatabaseResult = {
  needsUpgrade: boolean; verified: boolean; inventory: NativeDatabaseInventoryEntry[];
};
const activities = new Set<NativeDatabaseUpgradeActivity>(['nativeInspect', 'nativeBackup', 'nativeUpgrade', 'nativeVerify']);
// Advice only: these codes cannot grant maintenance authority or turn a failure into success.
const nativeFailureCodes = [
  StartupCompatibilityErrorCode.NativeSchemaUnsupported,
  'ENOSPC', 'EDQUOT', 'EBUSY', 'EAGAIN', 'ETXTBSY', 'EACCES', 'EPERM', 'EROFS',
  'SQLITE_FULL', 'SQLITE_BUSY', 'SQLITE_BUSY_RECOVERY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE', 'SQLITE_LOCKED_VTAB',
  'SQLITE_READONLY', 'SQLITE_READONLY_RECOVERY', 'SQLITE_READONLY_CANTLOCK', 'SQLITE_READONLY_ROLLBACK',
  'SQLITE_READONLY_DBMOVED', 'SQLITE_READONLY_CANTINIT', 'SQLITE_READONLY_DIRECTORY',
  'SQLITE_CANTOPEN', 'SQLITE_CANTOPEN_NOTEMPDIR', 'SQLITE_CANTOPEN_ISDIR', 'SQLITE_CANTOPEN_FULLPATH',
  'SQLITE_CANTOPEN_CONVPATH', 'SQLITE_CANTOPEN_DIRTYWAL', 'SQLITE_CANTOPEN_SYMLINK',
];
async function terminateOwnedChildTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (!child.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0)
    throw new Error('The native database child identity is unavailable for retirement.');
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('The system process retirement tool is unavailable.');
    await new Promise<void>((resolve, reject) => execFile(path.join(systemRoot, 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, killSignal: 'SIGKILL' }, error => {
        if (error && child.exitCode === null && child.signalCode === null) reject(error);
        else resolve();
      }));
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}

/** One offline child owns inspection/maintenance and is joined before Gateway admission or application exit. */
export class NativeDatabaseUpgradeRuntime {
  private child: ChildProcess | null = null;
  private operation: Promise<NativeDatabaseResult> | null = null;
  private admission: Promise<NativeDatabaseRuntimeIdentity> | null = null;
  private inventory: NativeDatabaseInventoryEntry[] | undefined;
  private stopped = false;
  private abortOperation: (() => void) | null = null;
  private retirementFailure: Error | null = null;

  constructor(private readonly deps: {
    getRuntimeRoot: () => string | null;
    stateDir: string;
    configPath: string;
    gatewayStopped: () => boolean;
    // Injection keeps tests isolated; maintenance retains immutable runtime admission and native spawn.
    admit?: typeof admitNativeDatabaseRuntime;
    readDeliveryIdentity?: typeof readNativeDatabaseDeliveryIdentity;
    spawn?: typeof spawn;
    terminate?: (child: ChildProcess) => Promise<void>;
    inspectTimeoutMs?: number;
    upgradeTimeoutMs?: number;
    abortGraceMs?: number;
    retirementObservationMs?: number;
  }) {}

  private admitted(): Promise<NativeDatabaseRuntimeIdentity> {
    if (this.retirementFailure) return Promise.reject(this.retirementFailure);
    if (this.stopped) return Promise.reject(new Error('Native database startup was interrupted.'));
    if (!this.admission) {
      const root = this.deps.getRuntimeRoot();
      if (!root) return Promise.reject(new Error('The bundled native database runtime is unavailable.'));
      this.admission = (this.deps.admit ?? admitNativeDatabaseRuntime)(root);
    }
    return this.admission;
  }

  async identity(): Promise<{ runtimeVersion: string; runtimeBuildId: string }> {
    const identity = await this.admitted();
    if (this.stopped) throw new Error('Native database startup was interrupted.');
    return { runtimeVersion: identity.runtimeVersion, runtimeBuildId: identity.runtimeBuildId };
  }

  async deliveryIdentity(): Promise<NativeDatabaseDeliveryIdentity> {
    if (this.retirementFailure) throw this.retirementFailure;
    if (this.stopped) throw new Error('Native database startup was interrupted.');
    const root = this.deps.getRuntimeRoot();
    if (!root) throw new Error('The bundled native runtime is unavailable.');
    const identity = await (this.deps.readDeliveryIdentity ?? readNativeDatabaseDeliveryIdentity)(root);
    if (this.retirementFailure) throw this.retirementFailure;
    if (this.stopped) throw new Error('Native database startup was interrupted.');
    return identity;
  }

  async inspect(): Promise<{ needsUpgrade: boolean }> {
    const result = await this.run('inspect');
    if (result.verified !== !result.needsUpgrade) throw new Error('Native database inspection returned an unconfirmed readiness result.');
    this.inventory = result.inventory;
    return { needsUpgrade: result.needsUpgrade };
  }

  async upgrade(onActivity: (activity: NativeDatabaseUpgradeActivity) => void = () => {}): Promise<void> {
    const result = await this.run('upgrade', onActivity);
    if (result.needsUpgrade || !result.verified) throw new Error('Native database upgrade was not verified.');
    this.inventory = result.inventory;
  }

  async prepareCanonical(onActivity: (activity: NativeDatabaseUpgradeActivity) => void = () => {}): Promise<void> {
    const result = await this.run('prepare', onActivity);
    if (result.needsUpgrade || !result.verified) throw new Error('Native session canonical validation was not verified.');
    this.inventory = result.inventory;
  }

  private run(
    operation: 'inspect' | 'upgrade' | 'prepare',
    onActivity?: (activity: NativeDatabaseUpgradeActivity) => void,
  ): Promise<NativeDatabaseResult> {
    if (this.retirementFailure) return Promise.reject(this.retirementFailure);
    if (this.operation || this.child) return Promise.reject(new Error('Another native database operation is active.'));
    const startedAt = Date.now();
    console.info('[NativeDatabaseStartup] Operation started:', operation);
    const running = this.execute(operation, onActivity).finally(() => {
      console.info('[NativeDatabaseStartup] Operation retired:', { operation, elapsedMs: Date.now() - startedAt,
        retirementConfirmed: !this.child });
      if (!this.child) this.abortOperation = null;
      if (this.operation === running) this.operation = null;
    });
    this.operation = running;
    return running;
  }

  private async execute(
    operation: 'inspect' | 'upgrade' | 'prepare',
    onActivity?: (activity: NativeDatabaseUpgradeActivity) => void,
  ): Promise<NativeDatabaseResult> {
    if (this.stopped || !this.deps.gatewayStopped())
      throw new Error('Native database maintenance requires a stopped Gateway.');
    const identity = await this.admitted();
    if (this.stopped || !this.deps.gatewayStopped())
      throw new Error('Native database startup admission changed.');
    const input = { runtimeRoot: identity.runtimeRoot, stateDir: this.deps.stateDir,
      configPath: this.deps.configPath, identity, contract, operation,
      unsupportedCode: StartupCompatibilityErrorCode.NativeSchemaUnsupported,
      nativeFailureCodes,
      ...(operation !== 'inspect' && this.inventory ? { expectedInventory: this.inventory } : {}) };
    return await new Promise<NativeDatabaseResult>((resolve, reject) => {
      const child = (this.deps.spawn ?? spawn)(identity.executable,
        ['--input-type=module', '-e', NATIVE_DATABASE_UPGRADE_SOURCE, JSON.stringify(input)], {
          cwd: identity.runtimeRoot, env: nativeDatabaseEnvironment(process.env, this.deps),
          windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
      this.child = child;
      let receipt: NativeDatabaseResult | undefined;
      let failure: Error | undefined;
      let outputBytes = 0;
      let closed = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let retirementTimer: ReturnType<typeof setTimeout> | undefined;
      let forced: Promise<void> | undefined;
      const requestAbort = (): void => {
        if (closed || forceTimer) return;
        if (child.connected) child.send({ type: 'abort' }, error => {
          if (error && !closed) failure ??= new Error('Native database cancellation could not be delivered.');
        });
        forceTimer = setTimeout(() => {
          failure ??= new Error('Native database maintenance required forced retirement; its result remains unconfirmed.');
          forced = (this.deps.terminate ?? terminateOwnedChildTree)(child).catch(error => {
            failure = new AggregateError([failure, error], 'Native database child retirement failed.');
          });
        }, this.deps.abortGraceMs ?? 30_000);
        retirementTimer = setTimeout(() => {
          this.retirementFailure ??= new Error('Native database process retirement could not be confirmed; application restart is required.');
          // Retain child custody and permanently block new operations. A deadline is never a join receipt.
          reject(this.retirementFailure);
        }, (this.deps.abortGraceMs ?? 30_000) + (this.deps.retirementObservationMs ?? 15_000));
      };
      this.abortOperation = requestAbort;
      const deadline = setTimeout(() => {
        failure ??= new Error('Native database maintenance exceeded its observation deadline; its result remains unconfirmed.');
        requestAbort();
      }, operation === 'inspect' ? (this.deps.inspectTimeoutMs ?? 120_000) : (this.deps.upgradeTimeoutMs ?? 30 * 60_000));
      const countOutput = (chunk: Buffer | string): void => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > 16 * 1024 * 1024) {
          failure ??= new Error('Native database maintenance produced too much output.');
          requestAbort();
        }
      };
      child.stdout?.on('data', countOutput);
      child.stderr?.on('data', countOutput);
      child.on('message', message => {
        if (!message || typeof message !== 'object' || !('type' in message)) return;
        const value = message as Record<string, unknown>;
        if (value.type === 'activity' && activities.has(value.activity as NativeDatabaseUpgradeActivity)) {
          try { onActivity?.(value.activity as NativeDatabaseUpgradeActivity); }
          catch (error) { failure ??= error instanceof Error ? error : new Error('Native upgrade progress owner failed.'); requestAbort(); }
        } else if (value.type === 'failure') {
          failure ??= Object.assign(new Error(typeof value.message === 'string' ? value.message.slice(0, 1000) : 'Native database maintenance failed.'),
            typeof value.code === 'string' && nativeFailureCodes.includes(value.code) ? { code: value.code } : {});
        } else if (value.type === 'result') {
          const proof = value.identity as Record<string, unknown> | undefined;
          if (receipt || value.operation !== operation || proof?.runtimeVersion !== identity.runtimeVersion ||
              proof.runtimeBuildId !== identity.runtimeBuildId || typeof value.needsUpgrade !== 'boolean' ||
              typeof value.verified !== 'boolean' || !Array.isArray(value.inventory) ||
              value.inventory.some(row => !row || typeof row !== 'object' ||
                !(row.agentId === null || typeof row.agentId === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.agentId)) ||
                !['path', 'realPath'].every(field => typeof row[field] === 'string' && path.isAbsolute(row[field]) && !/[\r\n\0]/u.test(row[field])) ||
                !['dev', 'ino'].every(field => typeof row[field] === 'string' && /^[1-9]\d*$/u.test(row[field]))) ||
              new Set(value.inventory.map(row => `${row.dev}:${row.ino}`)).size !== value.inventory.length) {
            failure ??= new Error('Native database maintenance returned an invalid receipt.');
          } else receipt = { needsUpgrade: value.needsUpgrade, verified: value.verified,
            inventory: value.inventory as NativeDatabaseInventoryEntry[] };
        }
      });
      child.once('error', error => { failure ??= error; });
      // The receipt alone is insufficient: accepted native workers and database closes must retire first.
      child.once('close', async (code, signal) => {
        closed = true;
        clearTimeout(deadline);
        clearTimeout(forceTimer);
        if (this.child === child) this.child = null;
        this.abortOperation = null;
        await forced;
        clearTimeout(retirementTimer);
        if (this.stopped) reject(new Error('Native database startup was interrupted; its result remains unconfirmed.'));
        else if (!this.deps.gatewayStopped()) reject(new Error('Gateway ownership changed during native database maintenance.'));
        else if (failure) reject(failure);
        else if (code !== 0 || signal || !receipt)
          reject(new Error('Native database maintenance did not retire with a confirmed result.'));
        else resolve(receipt);
      });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortOperation?.();
    await this.operation?.catch((): void => {});
    if (this.retirementFailure) throw this.retirementFailure;
    if (this.child) throw new Error('Native database child retirement remains unconfirmed.');
  }
}
