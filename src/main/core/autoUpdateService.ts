import type { BrowserWindow } from 'electron';
import { type AppUpdater, autoUpdater, type ProgressInfo, type UpdateInfo } from 'electron-updater';

import type {
  AppUpdateActionResult,
  AppUpdateErrorCode,
  AppUpdateState,
} from '../../shared/appUpdate';
import { AppUpdateIpc } from '../../shared/appUpdate';
import { log } from './logger';

const STARTUP_CHECK_DELAY_MS = 10_000;

type AutoUpdateServiceOptions = {
  currentVersion: string;
  enabled: boolean;
  getWindows: () => BrowserWindow[];
  installAfterCleanup: (install: () => void) => void;
  recoverAfterInstallFailure: () => void;
  updater?: AppUpdater;
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
  private installRequested = false;

  constructor(private readonly options: AutoUpdateServiceOptions) {
    this.state = {
      revision: 0,
      phase: options.enabled ? 'idle' : 'unsupported',
      currentVersion: options.currentVersion,
    };

    if (!options.enabled) return;

    this.updater = options.updater ?? autoUpdater;
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowDowngrade = false;
    this.updater.allowPrerelease = false;
    this.updater.logger = log;
    this.bindUpdaterEvents();
  }

  getState(): AppUpdateState {
    return { ...this.state };
  }

  scheduleStartupCheck(): void {
    if (!this.options.enabled) return;
    const timer = setTimeout(() => {
      void this.checkForUpdates();
    }, STARTUP_CHECK_DELAY_MS);
    timer.unref();
  }

  checkForUpdates(): Promise<AppUpdateState> {
    if (!this.options.enabled) {
      return Promise.resolve(this.getState());
    }
    if (this.checkPromise) {
      return this.checkPromise;
    }
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded') {
      return Promise.resolve(this.getState());
    }

    this.setState({
      phase: 'checking',
      currentVersion: this.options.currentVersion,
    });
    console.log('[AutoUpdate] Checking for updates...');

    this.checkPromise = this.updater
      .checkForUpdates()
      .then(result => {
        const downloadPromise = result?.downloadPromise;
        if (downloadPromise) {
          void downloadPromise.catch(error => {
            // electron-updater normally emits `error` before rejecting this
            // promise. Consume the rejection and only provide a fallback when
            // an updater implementation rejects without emitting the event.
            if (this.state.phase !== 'error') {
              this.handleError('CHECK_FAILED', error);
            }
          });
        }
        return this.getState();
      })
      .catch(error => {
        this.handleError('CHECK_FAILED', error);
        return this.getState();
      })
      .finally(() => {
        this.checkPromise = null;
      });
    return this.checkPromise;
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
      this.handleError('CHECK_FAILED', error);
    });
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
