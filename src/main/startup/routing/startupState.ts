import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  type StartupHistorySummary,
  StartupRoute,
  StartupStage,
} from '../../../shared/app/startup/routing';

export const STARTUP_STATE_FILE = 'startup-state.json';
export type StartupIdentity = {
  appVersion: string;
  runtimeVersion: string;
  runtimeBuildId: string;
};

export function isStartupIdentity(value: unknown): value is StartupIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as StartupIdentity;
  return [identity.appVersion, identity.runtimeVersion].every(
    version => typeof version === 'string' && version.length > 0 && version.length <= 128,
  ) && typeof identity.runtimeBuildId === 'string' && /^[a-f0-9]{64}$/.test(identity.runtimeBuildId);
}

export function sameStartupIdentity(left: StartupIdentity | undefined, right: StartupIdentity): boolean {
  return !!left && left.appVersion === right.appVersion &&
    left.runtimeVersion === right.runtimeVersion && left.runtimeBuildId === right.runtimeBuildId;
}
export function startupPathExists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
export type StartupJournal = {
  version: 1;
  generation: 'native-sqlite';
  route: StartupRoute;
  stage: StartupStage;
  transactionId: string;
  startedAt: number;
  isolatedEntries?: string[];
  historySummary?: StartupHistorySummary;
  completedIdentity?: StartupIdentity;
  /** Last application opening; not a native database maintenance receipt. */
  lastOpenedIdentity?: StartupIdentity;
  targetIdentity?: StartupIdentity;
};

/** Atomic, durable phase boundary; no credentials, configuration or transcript body. */
export function writeStartupJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

export function readStartupJournal(userData: string): StartupJournal | null {
  const file = path.join(userData, STARTUP_STATE_FILE);
  if (!startupPathExists(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as StartupJournal;
  if (
    value.version !== 1 ||
    value.generation !== 'native-sqlite' ||
    !Object.values(StartupRoute).includes(value.route) ||
    !Object.values(StartupStage).includes(value.stage) ||
    !/^[a-f0-9-]{36}$/.test(value.transactionId) ||
    !Number.isFinite(value.startedAt) ||
    (value.completedIdentity !== undefined && !isStartupIdentity(value.completedIdentity)) ||
    (value.lastOpenedIdentity !== undefined && !isStartupIdentity(value.lastOpenedIdentity)) ||
    (value.targetIdentity !== undefined && !isStartupIdentity(value.targetIdentity)) ||
    (value.route === StartupRoute.Upgrade && value.stage !== StartupStage.Complete &&
      !isStartupIdentity(value.targetIdentity)) ||
    (value.historySummary !== undefined &&
      (!value.historySummary ||
        Array.isArray(value.historySummary) ||
        [
          'conversations',
          'cachedConversations',
          'unavailableConversations',
          'nativeSessions',
          'missingTranscripts',
        ].some(key => {
          const count = value.historySummary![key as keyof StartupHistorySummary];
          return !Number.isSafeInteger(count) || count < 0;
        }) ||
        (value.historySummary.unavailableWorkspaces !== undefined &&
          (!Number.isSafeInteger(value.historySummary.unavailableWorkspaces) ||
            value.historySummary.unavailableWorkspaces < 0)))) ||
    (value.isolatedEntries !== undefined &&
      (!Array.isArray(value.isolatedEntries) ||
        value.isolatedEntries.some(
          name =>
            typeof name !== 'string' ||
            name === '.' ||
            name === '..' ||
            name === 'backups' ||
            name === 'logs' ||
            name === STARTUP_STATE_FILE ||
            path.basename(name) !== name,
        )))
  ) {
    throw new Error('Invalid startup recovery record. Existing data has been preserved.');
  }
  return value;
}

export function newStartupJournal(route: StartupRoute): StartupJournal {
  return {
    version: 1,
    generation: 'native-sqlite',
    route,
    stage: route === StartupRoute.Migration ? StartupStage.Backup
      : route === StartupRoute.Upgrade ? StartupStage.UpgradePrepare : StartupStage.Initialize,
    transactionId: randomUUID(),
    startedAt: Date.now(),
  };
}
