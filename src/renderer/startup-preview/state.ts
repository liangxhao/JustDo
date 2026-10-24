import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
} from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { StartupCompatibilityErrorCode } from '@shared/app/startup/versionPolicy';
import { captureStartupFailure, StartupFailureSource } from '@shared/app/startupFailure';

export const PreviewFailureKind = {
  Generic: 'generic',
  Downgrade: 'downgrade',
  VersionUnknown: 'versionUnknown',
  DataUnsupported: 'dataUnsupported',
} as const;
export type PreviewFailureKind = (typeof PreviewFailureKind)[keyof typeof PreviewFailureKind];
export const PREVIEW_DOWNGRADE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const failureCodes = {
  [PreviewFailureKind.Generic]: undefined,
  [PreviewFailureKind.Downgrade]: StartupCompatibilityErrorCode.DowngradeBlocked,
  [PreviewFailureKind.VersionUnknown]: StartupCompatibilityErrorCode.VersionUnconfirmed,
  [PreviewFailureKind.DataUnsupported]: StartupCompatibilityErrorCode.NativeSchemaUnsupported,
};

export type PreviewOptions = {
  route: StartupRoute;
  language: 'zh' | 'en';
  theme: 'light' | 'dark';
};

export function parsePreviewOptions(search: string): PreviewOptions {
  const query = new URLSearchParams(search);
  const defaults: PreviewOptions = { route: StartupRoute.Fresh, language: 'zh', theme: 'light' };
  const allowed = {
    route: Object.values(StartupRoute),
    language: ['zh', 'en'],
    theme: ['light', 'dark'],
  };
  for (const [key, value] of query) {
    if (
      !Object.prototype.hasOwnProperty.call(allowed, key) ||
      query.getAll(key).length !== 1 ||
      !(allowed[key as keyof typeof allowed] as readonly string[]).includes(value)
    )
      throw new Error(
        'Invalid startup preview options. Profiles and arbitrary paths are not accepted.',
      );
  }
  return { ...defaults, ...Object.fromEntries(query) } as PreviewOptions;
}

const setupSteps = [
  AppInitializationStep.UserData,
  AppInitializationStep.Runtime,
  AppInitializationStep.Configuration,
  AppInitializationStep.Engine,
];

export function previewSteps(route: StartupRoute): AppInitializationStep[] {
  if (route === StartupRoute.Migration)
    return [
      AppInitializationStep.Backup,
      ...setupSteps.slice(0, 3),
      AppInitializationStep.History,
      AppInitializationStep.Engine,
    ];
  if (route === StartupRoute.Upgrade) return [AppInitializationStep.DatabaseUpgrade, ...setupSteps];
  return [...setupSteps];
}

const activities: Record<AppInitializationStep, AppInitializationActivity> = {
  [AppInitializationStep.Backup]: AppInitializationActivity.HistoryBackup,
  [AppInitializationStep.History]: AppInitializationActivity.HistoryImport,
  [AppInitializationStep.DatabaseUpgrade]: AppInitializationActivity.NativeInspect,
  [AppInitializationStep.UserData]: AppInitializationActivity.UserDirectory,
  [AppInitializationStep.Runtime]: AppInitializationActivity.Python,
  [AppInitializationStep.Configuration]: AppInitializationActivity.StartupSettings,
  [AppInitializationStep.Engine]: AppInitializationActivity.EngineStart,
  [AppInitializationStep.Complete]: AppInitializationActivity.Finalize,
};

/** Synthetic presentation facts only. This never classifies or prepares an installation. */
export function createPreviewState(
  options: PreviewOptions,
  index: number,
  phase: AppInitializationState['phase'],
  startedAt: number,
  nativeActivity: AppInitializationActivity = AppInitializationActivity.NativeInspect,
  failureKind: PreviewFailureKind = PreviewFailureKind.Generic,
  activityStartedAt = startedAt,
): AppInitializationState {
  const steps = previewSteps(options.route);
  if (!Number.isInteger(index) || index < 0 || index >= steps.length)
    throw new Error('Invalid preview step.');
  const awaitingDowngrade =
    phase === AppInitializationPhase.Failed && failureKind === PreviewFailureKind.Downgrade;
  const presentationPhase = awaitingDowngrade ? AppInitializationPhase.Preparing : phase;
  const complete = presentationPhase === AppInitializationPhase.Ready;
  const failure =
    presentationPhase === AppInitializationPhase.Failed
      ? captureStartupFailure(
          StartupFailureSource.Main,
          Object.assign(
            new Error(
              options.language === 'zh'
                ? '模拟错误：此演练没有打开任何用户数据。'
                : 'Simulated error: this rehearsal has not opened any user data.',
            ),
            { code: failureCodes[failureKind] },
          ),
          {},
          Date.now(),
        )
      : undefined;
  return {
    route: options.route,
    firstLaunch: options.route !== StartupRoute.Normal,
    phase: presentationPhase,
    step: complete ? AppInitializationStep.Complete : steps[index],
    completedSteps: complete ? steps.length : index,
    totalSteps: steps.length,
    activity: complete
      ? AppInitializationActivity.Finalize
      : steps[index] === AppInitializationStep.DatabaseUpgrade
        ? nativeActivity
        : activities[steps[index]],
    startedAt,
    activityStartedAt,
    updatedAt: Date.now(),
    userDataPath:
      options.language === 'zh'
        ? '演练数据（仅内存，无真实目录）'
        : 'Rehearsal data (memory only; no real directory)',
    ...(failure ? { error: failure.error.message, failure } : {}),
    ...(awaitingDowngrade
      ? {
          downgradeConfirmation: {
            requestId: PREVIEW_DOWNGRADE_REQUEST_ID,
            source: { appVersion: '2027.1.1', runtimeVersion: '2027.1.1' },
            target: { appVersion: '2026.10.20', runtimeVersion: '2026.10.6' },
          },
        }
      : {}),
    ...(options.route === StartupRoute.Migration && complete
      ? {
          historySummary: {
            conversations: 12,
            cachedConversations: 2,
            unavailableConversations: 1,
            nativeSessions: 14,
            missingTranscripts: 1,
            unavailableWorkspaces: 2,
          },
          historyBackupPath:
            options.language === 'zh'
              ? '模拟备份位置（无真实文件）'
              : 'Simulated backup location (no real files)',
        }
      : {}),
  };
}

/** A frozen, intentionally partial browser fixture; it grants no Main/IPC capabilities. */
export function installPreviewBridge(
  target: Pick<Window, 'electron'>,
  development: boolean,
  options: PreviewOptions,
  notify: (action: string) => void,
  now = Date.now(),
  getLanguage: () => PreviewOptions['language'] = () => options.language,
) {
  if (!development || target.electron !== undefined)
    throw new Error(
      'Startup preview requires development mode and a browser without an Electron bridge.',
    );
  const state = createPreviewState(options, 0, AppInitializationPhase.Preparing, now);
  const controls = Object.freeze({
    isMaximized: async () => false,
    onStateChanged: () => () => {},
    minimize: () => notify('minimize'),
    toggleMaximize: () => notify('maximize'),
    close: () => notify('close'),
    showSystemMenu: () => notify('systemMenu'),
  });
  const bridge = Object.freeze({
    platform: 'win32',
    window: controls,
    initialization: Object.freeze({
      firstLaunch: state.firstLaunch,
      route: options.route,
      entryStartedAt: now,
      isTransientWindow: false,
      getState: async () => ({ ...state }),
      onChanged: () => () => {},
      relaunch: async () => {
        notify('restart');
      },
      confirmDowngrade: async (request: { requestId: string }) => {
        if (request.requestId !== PREVIEW_DOWNGRADE_REQUEST_ID) return { confirmed: false };
        notify('confirmDowngrade');
        return { confirmed: true };
      },
      openSupport: async () => {
        notify('support');
        return { success: true };
      },
    }),
    log: Object.freeze({
      getPath: async () => (getLanguage() === 'zh' ? '演练无日志文件' : 'No log file in rehearsal'),
    }),
  });
  Object.defineProperty(target, 'electron', { value: bridge, configurable: true });
  return () => {
    if (target.electron === (bridge as unknown)) Reflect.deleteProperty(target, 'electron');
  };
}
