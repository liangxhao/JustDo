import type { BrowserWindow } from 'electron';
import { type AppUpdater, autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';

import type {
  AppReleaseHistory,
  AppReleaseHistoryResult,
  AppUpdateActionResult,
  AppUpdateCheckFrequency,
  AppUpdateErrorCode,
  AppUpdatePreferences,
  AppUpdateState,
} from '../../shared/appUpdate';
import {
  AppUpdateCheckFrequency as CheckFrequency,
  AppUpdateIpc,
  DEFAULT_APP_UPDATE_CHECK_FREQUENCY,
} from '../../shared/appUpdate';
import appUpdateConfig from '../../shared/appUpdateConfig.json';
import { log } from './logger';

const STARTUP_CHECK_DELAY_MS = 10_000;
const SCHEDULED_CHECK_HOUR = 10;

type AutoUpdateServiceOptions = {
  currentVersion: string;
  enabled: boolean;
  getWindows: () => BrowserWindow[];
  installAfterCleanup: (install: () => void) => void;
  recoverAfterInstallFailure: () => void;
  getCheckFrequency: () => unknown;
  setCheckFrequency: (frequency: AppUpdateCheckFrequency) => void;
  getLastAutomaticCheckAt: () => unknown;
  setLastAutomaticCheckAt: (checkedAt: number) => void;
  releaseHistoryUrl?: string;
  fetchReleaseHistory?: (requestUrl: string, init?: RequestInit) => Promise<Response>;
  updater?: AppUpdater;
};

const RELEASE_HISTORY_TIMEOUT_MS = 10_000;
const {
  maxBytes: MAX_RELEASE_HISTORY_BYTES,
  maxEntries: MAX_RELEASE_HISTORY_ENTRIES,
  maxReleaseDateLength: MAX_RELEASE_DATE_LENGTH,
  maxReleaseNotesLength: MAX_RELEASE_NOTES_LENGTH,
} = appUpdateConfig.releaseHistory;
const UPDATE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseReleaseHistory = (value: unknown): AppReleaseHistory | undefined => {
  if (!isObjectRecord(value) || value.schemaVersion !== 1) return undefined;
  if (
    typeof value.latestVersion !== 'string' ||
    !UPDATE_VERSION_PATTERN.test(value.latestVersion) ||
    !Array.isArray(value.releases) ||
    value.releases.length === 0 ||
    value.releases.length > MAX_RELEASE_HISTORY_ENTRIES
  ) {
    return undefined;
  }

  const releases = value.releases.map(entry => {
    if (
      !isObjectRecord(entry) ||
      typeof entry.version !== 'string' ||
      !UPDATE_VERSION_PATTERN.test(entry.version) ||
      typeof entry.releaseDate !== 'string' ||
      entry.releaseDate.length > MAX_RELEASE_DATE_LENGTH ||
      !Number.isFinite(Date.parse(entry.releaseDate)) ||
      typeof entry.releaseNotes !== 'string' ||
      entry.releaseNotes.length > MAX_RELEASE_NOTES_LENGTH
    ) {
      return undefined;
    }
    return {
      version: entry.version,
      releaseDate: entry.releaseDate,
      releaseNotes: entry.releaseNotes,
    };
  });
  if (releases.some(entry => entry === undefined)) return undefined;

  const validatedReleases = releases as AppReleaseHistory['releases'];
  if (validatedReleases[0].version !== value.latestVersion) return undefined;
  const versions = new Set<string>();
  for (let index = 0; index < validatedReleases.length; index += 1) {
    const release = validatedReleases[index];
    if (versions.has(release.version)) return undefined;
    versions.add(release.version);
    if (
      index > 0 &&
      Date.parse(validatedReleases[index - 1].releaseDate) < Date.parse(release.releaseDate)
    ) {
      return undefined;
    }
  }
  return {
    schemaVersion: 1,
    latestVersion: value.latestVersion,
    releases: validatedReleases,
  };
};

const readResponseTextWithLimit = async (
  response: Response,
  maxBytes: number,
): Promise<string | undefined> => {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return undefined;
  if (!response.body) {
    const body = await response.text();
    return Buffer.byteLength(body, 'utf8') <= maxBytes ? body : undefined;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
};

export const normalizeAppUpdateCheckFrequency = (value: unknown): AppUpdateCheckFrequency =>
  value === CheckFrequency.Never || value === CheckFrequency.Weekly
    ? value
    : DEFAULT_APP_UPDATE_CHECK_FREQUENCY;

export const resolveNextAutomaticUpdateCheckAt = ({
  frequency,
  lastCheckAt,
  now,
}: {
  frequency: AppUpdateCheckFrequency;
  lastCheckAt: unknown;
  now: number;
}): number | undefined => {
  if (frequency === CheckFrequency.Never) return undefined;

  const mostRecentCheckTime = new Date(now);
  mostRecentCheckTime.setHours(SCHEDULED_CHECK_HOUR, 0, 0, 0);
  const intervalDays = frequency === CheckFrequency.Weekly ? 7 : 1;

  if (frequency === CheckFrequency.Weekly) {
    const daysSinceMonday = (mostRecentCheckTime.getDay() + 6) % 7;
    mostRecentCheckTime.setDate(mostRecentCheckTime.getDate() - daysSinceMonday);
  }
  if (mostRecentCheckTime.getTime() > now) {
    mostRecentCheckTime.setDate(mostRecentCheckTime.getDate() - intervalDays);
  }

  const normalizedLastCheckAt =
    typeof lastCheckAt === 'number' && Number.isFinite(lastCheckAt) ? lastCheckAt : undefined;
  if (
    normalizedLastCheckAt === undefined ||
    normalizedLastCheckAt < mostRecentCheckTime.getTime()
  ) {
    return now + STARTUP_CHECK_DELAY_MS;
  }

  const nextCheckTime = new Date(mostRecentCheckTime);
  nextCheckTime.setDate(nextCheckTime.getDate() + intervalDays);
  return nextCheckTime.getTime();
};

const normalizeReleaseNotes = (releaseNotes: UpdateInfo['releaseNotes']): string | undefined => {
  if (typeof releaseNotes === 'string') {
    return releaseNotes.trim() || undefined;
  }
  if (!Array.isArray(releaseNotes)) {
    return undefined;
  }

  const notes = releaseNotes
    .map(note => note.note?.trim())
    .filter((note): note is string => Boolean(note));
  return notes.length > 0 ? notes.join('\n\n') : undefined;
};

export class AutoUpdateService {
  private readonly updater!: AppUpdater;
  private state: AppUpdateState;
  private checkPromise: Promise<AppUpdateState> | null = null;
  private downloadPromise: Promise<AppUpdateActionResult> | null = null;
  private installRequested = false;
  private automaticCheckTimer: NodeJS.Timeout | null = null;
  private nextAutomaticCheckAt: number | undefined;
  private lastAutomaticCheckAt: number | undefined;
  private releaseHistoryPromise: Promise<AppReleaseHistoryResult> | null = null;

  constructor(private readonly options: AutoUpdateServiceOptions) {
    this.state = {
      revision: 0,
      phase: options.enabled ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
    };

    if (!options.enabled) return;

    this.updater = options.updater ?? autoUpdater;
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowDowngrade = false;
    this.updater.allowPrerelease = false;
    this.updater.logger = log;
    this.bindUpdaterEvents();
  }

  getState(): AppUpdateState {
    return { ...this.state };
  }

  getPreferences(): AppUpdatePreferences {
    return {
      supported: this.options.enabled,
      checkFrequency: normalizeAppUpdateCheckFrequency(this.options.getCheckFrequency()),
      ...(this.nextAutomaticCheckAt !== undefined
        ? { nextCheckAt: this.nextAutomaticCheckAt }
        : {}),
    };
  }

  setCheckFrequency(value: unknown): AppUpdatePreferences {
    const frequency = normalizeAppUpdateCheckFrequency(value);
    this.options.setCheckFrequency(frequency);
    this.scheduleAutomaticChecks();
    return this.getPreferences();
  }

  getReleaseHistory(): Promise<AppReleaseHistoryResult> {
    if (this.releaseHistoryPromise) return this.releaseHistoryPromise;
    if (!this.options.enabled || !this.options.releaseHistoryUrl) {
      return Promise.resolve({ success: false });
    }

    const fetchReleaseHistory = this.options.fetchReleaseHistory ?? globalThis.fetch;
    this.releaseHistoryPromise = fetchReleaseHistory(this.options.releaseHistoryUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(RELEASE_HISTORY_TIMEOUT_MS),
    })
      .then(async response => {
        if (!response.ok) return { success: false };
        const body = await readResponseTextWithLimit(response, MAX_RELEASE_HISTORY_BYTES);
        if (body === undefined) return { success: false };
        const history = parseReleaseHistory(JSON.parse(body));
        if (!history) return { success: false };
        return { success: true, history };
      })
      .catch(error => {
        console.error('[AutoUpdate] Failed to load release history:', error);
        return { success: false };
      })
      .finally(() => {
        this.releaseHistoryPromise = null;
      });
    return this.releaseHistoryPromise;
  }

  scheduleAutomaticChecks(): void {
    if (this.automaticCheckTimer) {
      clearTimeout(this.automaticCheckTimer);
      this.automaticCheckTimer = null;
    }
    this.nextAutomaticCheckAt = undefined;
    if (!this.options.enabled) return;

    const frequency = normalizeAppUpdateCheckFrequency(this.options.getCheckFrequency());
    const now = Date.now();
    const nextCheckAt = resolveNextAutomaticUpdateCheckAt({
      frequency,
      lastCheckAt: this.readLastAutomaticCheckAt(),
      now,
    });
    if (nextCheckAt === undefined) return;

    this.nextAutomaticCheckAt = nextCheckAt;
    this.automaticCheckTimer = setTimeout(
      () => {
        this.automaticCheckTimer = null;
        this.nextAutomaticCheckAt = undefined;
        const checkedAt = Date.now();
        this.lastAutomaticCheckAt = checkedAt;
        try {
          this.options.setLastAutomaticCheckAt(checkedAt);
        } catch (error) {
          console.error('[AutoUpdate] Failed to persist automatic update check time:', error);
        }
        this.scheduleAutomaticChecks();
        void this.checkForUpdates();
      },
      Math.max(0, nextCheckAt - now),
    );
    this.automaticCheckTimer.unref();
  }

  checkForUpdates(): Promise<AppUpdateState> {
    if (!this.options.enabled) {
      return Promise.resolve(this.getState());
    }
    if (this.checkPromise) {
      return this.checkPromise;
    }
    if (
      this.state.phase === 'available' ||
      this.state.phase === 'downloading' ||
      this.state.phase === 'downloaded'
    ) {
      return Promise.resolve(this.getState());
    }

    this.setState({
      phase: 'checking',
      currentVersion: this.options.currentVersion,
    });
    console.log('[AutoUpdate] Checking for updates...');

    this.checkPromise = this.updater
      .checkForUpdates()
      .then(() => this.getState())
      .catch(error => {
        this.handleError('CHECK_FAILED', error);
        return this.getState();
      })
      .finally(() => {
        this.checkPromise = null;
      });
    return this.checkPromise;
  }

  downloadUpdate(): Promise<AppUpdateActionResult> {
    if (!this.options.enabled) {
      return Promise.resolve({
        success: false,
        state: this.getState(),
        errorCode: 'DOWNLOAD_FAILED',
      });
    }
    if (this.downloadPromise) return this.downloadPromise;

    const canDownload =
      this.state.phase === 'available' ||
      (this.state.phase === 'error' &&
        this.state.errorCode === 'DOWNLOAD_FAILED' &&
        Boolean(this.state.availableVersion));
    if (!canDownload) {
      return Promise.resolve({
        success: false,
        state: this.getState(),
        errorCode: 'DOWNLOAD_FAILED',
      });
    }

    console.log('[AutoUpdate] Update download requested by the user.');
    this.setState({
      ...this.state,
      phase: 'downloading',
      downloadPercent: 0,
      errorCode: undefined,
    });

    let downloadTask: Promise<string[]>;
    try {
      downloadTask = this.updater.downloadUpdate();
    } catch (error) {
      this.handleError('DOWNLOAD_FAILED', error);
      return Promise.resolve({
        success: false,
        state: this.getState(),
        errorCode: 'DOWNLOAD_FAILED',
      });
    }

    this.downloadPromise = downloadTask
      .then(() => {
        if (this.state.phase === 'downloading') {
          this.setState({
            ...this.state,
            phase: 'downloaded',
            downloadPercent: undefined,
          });
        }
        const state = this.getState();
        return state.phase === 'downloaded'
          ? { success: true, state }
          : { success: false, state, errorCode: 'DOWNLOAD_FAILED' as const };
      })
      .catch(error => {
        if (this.state.phase !== 'error' || this.state.errorCode !== 'DOWNLOAD_FAILED') {
          this.handleError('DOWNLOAD_FAILED', error);
        }
        return {
          success: false,
          state: this.getState(),
          errorCode: 'DOWNLOAD_FAILED' as const,
        };
      })
      .finally(() => {
        this.downloadPromise = null;
      });
    return this.downloadPromise;
  }

  quitAndInstall(): AppUpdateActionResult {
    if (this.state.phase !== 'downloaded' || this.installRequested) {
      return {
        success: false,
        state: this.getState(),
        errorCode: 'INSTALL_FAILED',
      };
    }

    this.installRequested = true;
    console.log('[AutoUpdate] Update installation requested; cleaning up before restart.');
    this.options.installAfterCleanup(() => {
      try {
        this.updater.quitAndInstall(false, true);
      } catch (error) {
        this.handleInstallFailure(error);
      }
    });

    return { success: true, state: this.getState() };
  }

  private bindUpdaterEvents(): void {
    this.updater.on('checking-for-update', () => {
      this.setState({
        phase: 'checking',
        currentVersion: this.options.currentVersion,
      });
    });
    this.updater.on('update-available', info => {
      console.log(`[AutoUpdate] Update available: ${info.version}`);
      this.setState(this.stateFromUpdateInfo('available', info));
    });
    this.updater.on('update-not-available', info => {
      console.log('[AutoUpdate] Current version is up to date.');
      this.setState(this.stateFromUpdateInfo('up-to-date', info, false));
    });
    this.updater.on('download-progress', progress => {
      this.handleDownloadProgress(progress);
    });
    this.updater.on('update-downloaded', info => {
      console.log(`[AutoUpdate] Update downloaded: ${info.version}`);
      this.setState(this.stateFromUpdateInfo('downloaded', info));
    });
    this.updater.on('error', error => {
      if (this.installRequested) {
        this.handleInstallFailure(error);
        return;
      }
      this.handleError(
        this.downloadPromise || this.state.phase === 'downloading'
          ? 'DOWNLOAD_FAILED'
          : 'CHECK_FAILED',
        error,
      );
    });
  }

  private readLastAutomaticCheckAt(): unknown {
    try {
      const storedValue = this.options.getLastAutomaticCheckAt();
      if (
        typeof storedValue === 'number' &&
        Number.isFinite(storedValue) &&
        (this.lastAutomaticCheckAt === undefined || storedValue > this.lastAutomaticCheckAt)
      ) {
        this.lastAutomaticCheckAt = storedValue;
      }
      return this.lastAutomaticCheckAt ?? storedValue;
    } catch (error) {
      console.error('[AutoUpdate] Failed to read automatic update check time:', error);
      return this.lastAutomaticCheckAt;
    }
  }

  private handleInstallFailure(error: unknown): void {
    this.installRequested = false;
    this.handleError('INSTALL_FAILED', error);
    try {
      this.options.recoverAfterInstallFailure();
    } catch (recoveryError) {
      console.error(
        '[AutoUpdate] Failed to restart after update installation error:',
        recoveryError,
      );
    }
  }

  private stateFromUpdateInfo(
    phase: AppUpdateState['phase'],
    info: UpdateInfo,
    includeAvailableVersion = true,
  ): Omit<AppUpdateState, 'revision'> {
    return {
      phase,
      currentVersion: this.options.currentVersion,
      ...(includeAvailableVersion ? { availableVersion: info.version } : {}),
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    };
  }

  private handleDownloadProgress(progress: ProgressInfo): void {
    const downloadPercent = Math.max(0, Math.min(100, progress.percent));
    this.setState({
      ...this.state,
      phase: 'downloading',
      downloadPercent,
      errorCode: undefined,
    });
  }

  private handleError(errorCode: AppUpdateErrorCode, error: unknown): void {
    console.error('[AutoUpdate] Update operation failed:', error);
    this.setState({
      ...this.state,
      phase: 'error',
      errorCode,
      downloadPercent: undefined,
    });
  }

  private setState(state: Omit<AppUpdateState, 'revision'>): void {
    this.state = { ...state, revision: this.state.revision + 1 };
    for (const window of this.options.getWindows()) {
      if (window.isDestroyed()) continue;
      try {
        window.webContents.send(AppUpdateIpc.StateChanged, this.getState());
      } catch (error) {
        console.error('[AutoUpdate] Failed to notify renderer:', error);
      }
    }
  }
}
