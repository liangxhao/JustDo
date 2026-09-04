import fs from 'fs';

import type { BuiltinModelCredential } from './builtinModelCredential';

const DEFAULT_WATCH_INTERVAL_MS = 1_000;
const REFRESH_DEBOUNCE_MS = 200;
const EXPIRY_REFRESH_MARGIN_MS = 14_000;
const ERROR_RETRY_MS = 5_000;

type WatchFile = (
  filePath: string,
  options: { interval: number; persistent: boolean },
  listener: (current: fs.Stats, previous: fs.Stats) => void,
) => void;

type UnwatchFile = (
  filePath: string,
  listener: (current: fs.Stats, previous: fs.Stats) => void,
) => void;

type BuiltinModelCredentialMonitorDependencies = {
  userInfoPath: string;
  refresh: () => Promise<BuiltinModelCredential | null>;
  onError?: (error: unknown) => void;
  watchIntervalMs?: number;
  watchFile?: WatchFile;
  unwatchFile?: UnwatchFile;
};

export const resolveBuiltinModelCredentialExpiryDelayMs = (
  credential: BuiltinModelCredential,
  nowMs = Date.now(),
): number => Math.max(0, credential.expiresAt * 1_000 - nowMs - EXPIRY_REFRESH_MARGIN_MS);

export class BuiltinModelCredentialMonitor {
  private readonly watchFile: WatchFile;
  private readonly unwatchFile: UnwatchFile;
  private started = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTail: Promise<void> = Promise.resolve();

  private readonly fileListener = (): void => {
    this.scheduleRefresh(REFRESH_DEBOUNCE_MS);
  };

  constructor(private readonly dependencies: BuiltinModelCredentialMonitorDependencies) {
    this.watchFile = dependencies.watchFile ?? fs.watchFile.bind(fs);
    this.unwatchFile = dependencies.unwatchFile ?? fs.unwatchFile.bind(fs);
  }

  start(initialCredential: BuiltinModelCredential | null): void {
    if (this.started) return;
    this.started = true;
    this.watchFile(
      this.dependencies.userInfoPath,
      {
        interval: this.dependencies.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS,
        persistent: false,
      },
      this.fileListener,
    );
    this.scheduleExpiryRefresh(initialCredential);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unwatchFile(this.dependencies.userInfoPath, this.fileListener);
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.debounceTimer = null;
    this.expiryTimer = null;
  }

  private scheduleRefresh(delayMs: number): void {
    if (!this.started) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.enqueueRefresh();
    }, delayMs);
  }

  private enqueueRefresh(): void {
    const refresh = async (): Promise<void> => {
      if (!this.started) return;
      try {
        const credential = await this.dependencies.refresh();
        if (this.started) this.scheduleExpiryRefresh(credential);
      } catch (error) {
        this.dependencies.onError?.(error);
        this.scheduleRefresh(ERROR_RETRY_MS);
      }
    };
    this.refreshTail = this.refreshTail.then(refresh, refresh);
  }

  private scheduleExpiryRefresh(credential: BuiltinModelCredential | null): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!credential || !this.started) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.enqueueRefresh();
    }, resolveBuiltinModelCredentialExpiryDelayMs(credential));
  }
}
