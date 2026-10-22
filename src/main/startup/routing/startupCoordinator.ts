import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  AppInitializationActivity,
  AppInitializationStep,
} from '../../../shared/app/initialization';
import {
  type StartupHistorySummary,
  StartupRoute,
  StartupStage,
} from '../../../shared/app/startup/routing';
import { createHistoryBackup, ownedPath, verifyHistoryBackup } from '../history/historyBackup';
import { nativeHistoryError } from '../history/historyFailure';
import {
  planLegacyHistory,
  restoreHistoryMetadata,
  stageLegacyHistory,
  verifyRestoredHistoryBindings,
} from '../history/legacyHistory';
import type { NativeHistoryOperation } from '../history/nativeHistoryRuntime';
import { classifyInstallation } from './classifyInstallation';
import {
  newStartupJournal,
  STARTUP_STATE_FILE,
  type StartupJournal,
  startupPathExists,
  writeStartupJson,
} from './startupState';

type Progress = {
  advance: (step: AppInitializationStep, completedSteps: number) => void;
  reportActivity: (activity: AppInitializationActivity) => void;
  setHistorySummary: (summary: StartupHistorySummary, backupPath?: string) => void;
};
type NativeReport = {
  targets?: {
    agentId: string;
    sqliteEntries: number;
    dbStats?: { integrityCheck?: string };
    issues?: { code?: string }[];
  }[];
};

/** Owns the single startup transaction. Initialization never opens a legacy product DB. */
export class StartupCoordinator {
  readonly route: StartupRoute;
  readonly startedAt = Date.now();
  private journal: StartupJournal;
  private readonly preparationError: unknown;

  constructor(private readonly userData: string) {
    try {
      const decision = classifyInstallation(userData);
      this.route = decision.route;
      this.journal = decision.journal ?? newStartupJournal(decision.route);
    } catch (error) {
      this.route = StartupRoute.Fresh;
      this.journal = newStartupJournal(this.route);
      this.preparationError = error;
    }
  }

  get stage(): StartupStage {
    return this.journal.stage;
  }

  private get history(): string {
    return ownedPath(this.userData, path.join('backups', this.journal.transactionId, 'history'));
  }

  getHistoryBackupDirectory(): string | null {
    return this.route === StartupRoute.Migration &&
      startupPathExists(path.join(this.history, 'manifest.json'))
      ? this.history
      : null;
  }

  private summarizeWorkspaces(
    db: Database.Database,
    summary: StartupHistorySummary,
  ): StartupHistorySummary {
    const rows = db
      .prepare(
        `SELECT s.cwd FROM cowork_sessions s JOIN history_session_bindings h
      ON h.session_id=s.id WHERE h.transaction_id=?`,
      )
      .all(this.journal.transactionId) as { cwd: string }[];
    return {
      ...summary,
      unavailableWorkspaces: rows.filter(row => {
        try {
          return !path.isAbsolute(row.cwd) || !fs.statSync(row.cwd).isDirectory();
        } catch {
          return true;
        }
      }).length,
    };
  }

  private commit(stage: StartupStage, extra: Partial<StartupJournal> = {}): void {
    const next = { ...this.journal, ...extra, stage };
    writeStartupJson(path.join(this.userData, STARTUP_STATE_FILE), next);
    this.journal = next;
  }

  async prepareBeforeStore(progress: Progress): Promise<void> {
    if (this.preparationError) throw this.preparationError;
    if (this.route !== StartupRoute.Migration) {
      if (this.route === StartupRoute.Fresh) this.commit(StartupStage.Initialize);
      return;
    }
    if (this.journal.stage === StartupStage.Backup) {
      progress.advance(AppInitializationStep.Backup, 0);
      this.commit(StartupStage.Backup);
      if (startupPathExists(this.history)) {
        // A partial or completed snapshot without the Isolate commit is unconfirmed.
        // Retain it and recapture current input: the old app may have written again,
        // and a partial directory may contain files no longer in the active source.
        await fs.promises.rename(
          this.history,
          ownedPath(
            this.userData,
            path.join('backups', this.journal.transactionId, `history-uncommitted-${randomUUID()}`),
          ),
        );
      }
      await createHistoryBackup(this.userData, this.history);
      // Resolve schema/identity conflicts while the active legacy environment is intact.
      writeStartupJson(
        path.join(this.history, 'import-plan.json'),
        planLegacyHistory(this.history),
      );
      const entries = fs
        .readdirSync(this.userData)
        .filter(
          name =>
            name !== 'backups' &&
            name !== 'logs' &&
            name !== STARTUP_STATE_FILE &&
            !['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'].includes(name) &&
            !name.startsWith(`${STARTUP_STATE_FILE}.`),
        );
      this.commit(StartupStage.Isolate, { isolatedEntries: entries });
    }
    if (this.journal.stage === StartupStage.Isolate) {
      verifyHistoryBackup(this.history);
      const retired = ownedPath(
        this.userData,
        path.join('backups', this.journal.transactionId, 'retired'),
      );
      fs.mkdirSync(retired, { recursive: true });
      for (const name of this.journal.isolatedEntries ?? []) {
        const source = ownedPath(this.userData, name, true);
        const destination = ownedPath(retired, name, true);
        if (startupPathExists(source) && startupPathExists(destination))
          throw new Error(
            'Startup isolation found a conflicting destination. No data was overwritten.',
          );
        if (startupPathExists(source)) await fs.promises.rename(source, destination);
        else if (!startupPathExists(destination))
          throw new Error('An isolated source entry is missing.');
      }
      this.commit(StartupStage.Initialize);
    }
    progress.advance(AppInitializationStep.UserData, 0);
  }

  /** After current bundled resources/defaults are ready, with all Gateway admission still closed. */
  async restoreHistory(
    db: Database.Database,
    stateDir: string,
    progress: Progress,
    runNative: (mode: NativeHistoryOperation, planFile?: string) => Promise<string>,
  ): Promise<void> {
    if (this.route !== StartupRoute.Migration) return;
    if (this.journal.stage === StartupStage.Check) {
      verifyHistoryBackup(this.history);
      verifyRestoredHistoryBindings(
        db,
        planLegacyHistory(this.history),
        this.journal.transactionId,
      );
      if (this.journal.historySummary)
        progress.setHistorySummary(
          this.summarizeWorkspaces(db, this.journal.historySummary),
          this.history,
        );
      return;
    }
    progress.advance(AppInitializationStep.History, 4);
    const planFile = path.join(this.history, 'import-plan.json');
    verifyHistoryBackup(this.history);
    const plan = planLegacyHistory(this.history);
    writeStartupJson(planFile, plan);
    if (this.journal.stage === StartupStage.Initialize) this.commit(StartupStage.StageHistory);
    if (this.journal.stage === StartupStage.StageHistory) {
      stageLegacyHistory(this.history, stateDir, plan);
      this.commit(StartupStage.ImportHistory);
    }
    progress.setHistorySummary(plan.summary, this.history);
    if (this.journal.stage === StartupStage.ImportHistory) {
      progress.reportActivity(AppInitializationActivity.HistoryImport);
      const imported = JSON.parse(await runNative('import')) as NativeReport;
      if (
        !Array.isArray(imported.targets) ||
        imported.targets.some(target =>
          target.issues?.some(
            issue =>
              issue.code !== 'transcript_missing' && issue.code !== 'legacy_index_informational',
          ),
        )
      )
        throw nativeHistoryError(
          'The native importer reported an unresolved history issue. The backup has been preserved.',
          imported,
        );
      const report = JSON.parse(await runNative('inspect')) as NativeReport;
      const expected = new Map(
        plan.agents.map(agent => [agent.agentId, new Set(Object.keys(agent.entries))]),
      );
      for (const row of plan.conversations) {
        if (!expected.has(row.agentId)) expected.set(row.agentId, new Set());
        expected.get(row.agentId)!.add(row.sessionKey);
      }
      for (const [agentId, keys] of expected) {
        const target = report.targets?.find(entry => entry.agentId === agentId);
        if (
          !target ||
          target.sqliteEntries !== keys.size ||
          target.dbStats?.integrityCheck !== 'ok' ||
          target.issues?.some(
            issue =>
              issue.code !== 'transcript_missing' && issue.code !== 'legacy_index_informational',
          )
        )
          throw nativeHistoryError(
            'Native history verification failed. The backup and recovery stage have been preserved.',
            target,
          );
      }
      this.commit(StartupStage.RestoreMetadata);
    }
    if (this.journal.stage === StartupStage.RestoreMetadata) {
      const verified = JSON.parse(await runNative('verify', planFile)) as {
        verified?: boolean;
        conversations?: number;
        entries?: number;
      };
      if (
        verified.verified !== true ||
        verified.conversations !== plan.conversations.length ||
        verified.entries !==
          plan.summary.nativeSessions +
            plan.conversations.filter(
              row =>
                !plan.agents.some(
                  agent => agent.agentId === row.agentId && agent.entries[row.sessionKey],
                ),
            ).length
      )
        throw new Error('The native history identity verification did not complete.');
      writeStartupJson(path.join(this.history, 'native-verification.json'), verified);
      progress.reportActivity(AppInitializationActivity.HistoryMetadata);
      restoreHistoryMetadata(db, plan, this.journal.transactionId);
      const historySummary = this.summarizeWorkspaces(db, plan.summary);
      this.commit(StartupStage.Check, { historySummary });
      progress.setHistorySummary(historySummary, this.history);
    }
  }

  complete(): void {
    if (this.preparationError) throw this.preparationError;
    if (
      this.route === StartupRoute.Migration &&
      this.journal.stage !== StartupStage.Check &&
      this.journal.stage !== StartupStage.Complete
    )
      throw new Error('History restoration is not complete.');
    if (this.route === StartupRoute.Normal) {
      if (this.journal.stage !== StartupStage.Complete) {
        try {
          this.commit(StartupStage.Complete);
        } catch (error) {
          console.warn(
            '[StartupCoordinator] Could not record current generation; read-only detection remains available:',
            error,
          );
        }
      }
      return;
    }
    this.commit(StartupStage.Complete);
    if (this.route === StartupRoute.Migration) {
      // Temporary isolation is a same-volume rename, not a retained full-profile backup.
      const retired = ownedPath(
        this.userData,
        path.join('backups', this.journal.transactionId, 'retired'),
      );
      try {
        fs.rmSync(retired, { recursive: true, force: true });
      } catch (error) {
        console.warn('[StartupCoordinator] Could not remove retired settings:', error);
      }
    }
  }
}
