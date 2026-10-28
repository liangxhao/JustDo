import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  AppInitializationActivity,
  AppInitializationStep,
  type StartupDowngradeConfirmation,
} from '../../../shared/app/initialization';
import {
  type StartupHistorySummary,
  StartupRoute,
  StartupStage,
} from '../../../shared/app/startup/routing';
import {
  assessStartupDelivery,
  StartupCompatibilityErrorCode,
} from '../../../shared/app/startup/versionPolicy';
import { DB_FILENAME } from '../../core/appConstants';
import {
  createHistoryBackup,
  ownedPath,
  verifyHistoryBackup,
  verifyNativeHistoryOriginals,
} from '../history/historyBackup';
import { nativeHistoryError } from '../history/historyFailure';
import {
  planLegacyHistory,
  restoreHistoryMetadata,
  stageLegacyHistory,
  verifyRestoredHistoryBindings,
} from '../history/legacyHistory';
import type { NativeHistoryOperation } from '../history/nativeHistoryRuntime';
import { classifyInstallation, type StartupDecision } from './classifyInstallation';
import {
  newStartupJournal,
  readStartupJournal,
  sameStartupIdentity,
  STARTUP_STATE_FILE,
  type StartupIdentity,
  type StartupJournal,
  startupPathExists,
  writeStartupJson,
} from './startupState';

export type NativeStartupDatabaseRuntime = {
  /** Small delivery metadata only; does not admit native storage or runtime payloads. */
  deliveryIdentity(): Promise<{ runtimeVersion: string; runtimeBuildId: string }>;
  identity(): Promise<{ runtimeVersion: string; runtimeBuildId: string }>;
  inspect(): Promise<{ needsUpgrade: boolean }>;
  upgrade(onActivity: (activity: 'nativeInspect' | 'nativeBackup' | 'nativeUpgrade' | 'nativeVerify') => void): Promise<void>;
  /** Rechecks live schemas and the routed physical inventory before preparing session proof. */
  prepareCanonical(onActivity?: (activity: 'nativeInspect' | 'nativeBackup' | 'nativeUpgrade' | 'nativeVerify') => void): Promise<void>;
};
type StartupPreparation = {
  decision: StartupDecision;
  startedAt?: number;
  identity?: StartupIdentity;
  native?: NativeStartupDatabaseRuntime;
  error?: unknown;
  downgradeConfirmation?: StartupDowngradeConfirmation;
  downgradeSourceIdentity?: StartupIdentity;
};

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
  readonly startedAt: number;
  private journal: StartupJournal;
  private readonly preparationError: unknown;
  private readonly targetIdentity?: StartupIdentity;
  private readonly native?: NativeStartupDatabaseRuntime;
  private nativeVerified = false;
  private canonicalPrepared = false;
  private readonly downgradeConfirmation?: StartupDowngradeConfirmation;
  private readonly downgradeSourceIdentity?: StartupIdentity;
  private downgradeConfirmed = false;
  private stopped = false;
  private confirmationWaiter?: { resolve: () => void; reject: (error: Error) => void };

  constructor(private readonly userData: string, prepared?: StartupPreparation) {
    this.startedAt = prepared?.startedAt ?? Date.now();
    this.targetIdentity = prepared?.identity;
    this.native = prepared?.native;
    this.downgradeConfirmation = prepared?.downgradeConfirmation;
    this.downgradeSourceIdentity = prepared?.downgradeSourceIdentity;
    try {
      if (prepared?.error) throw prepared.error;
      const decision = prepared?.decision ?? classifyInstallation(userData);
      this.route = decision.route;
      this.journal = decision.journal ?? newStartupJournal(decision.route);
    } catch (error) {
      this.route = prepared?.decision.route ?? StartupRoute.Normal;
      this.journal = newStartupJournal(this.route);
      this.preparationError = error;
    }
  }

  /** Freeze the real route before any route-bearing window, Store, config projection or Gateway admission. */
  static async prepare(userData: string, options: {
    appVersion: string;
    native: NativeStartupDatabaseRuntime;
    startedAt?: number;
  }): Promise<StartupCoordinator> {
    const startedAt = options.startedAt ?? Date.now();
    let decision: StartupDecision = { route: StartupRoute.Normal, journal: null };
    try {
      const previous = readStartupJournal(userData);
      const identity = { appVersion: options.appVersion, ...await options.native.deliveryIdentity() };
      const sourceIdentity = previous?.lastOpenedIdentity ?? previous?.completedIdentity;
      const deliveryInput = { source: sourceIdentity, target: identity };
      let delivery = assessStartupDelivery(deliveryInput);
      // A completed installation of the same runtime opens directly. Do not open
      // SQLite, scan agent folders, hash runtime payloads, or launch a preflight.
      if (previous?.stage === StartupStage.Complete && previous.completedIdentity &&
          !previous.targetIdentity && delivery.allowed &&
          previous.completedIdentity.runtimeVersion.replace(/^v/, '') === identity.runtimeVersion.replace(/^v/, '')) {
        if (!startupPathExists(path.join(userData, DB_FILENAME)))
          throw new Error('The initialized product database is missing. Existing backups have been preserved.');
        return new StartupCoordinator(userData, {
          decision: { route: StartupRoute.Normal, journal: previous }, identity,
          native: options.native, startedAt,
        });
      }
      decision = classifyInstallation(userData);
      // Maintenance paths still require the complete immutable runtime admission,
      // and cannot switch deliveries after selecting their lightweight target.
      const admittedIdentity = { appVersion: options.appVersion, ...await options.native.identity() };
      if (!sameStartupIdentity(admittedIdentity, identity))
        throw Object.assign(new Error('The application runtime changed during startup routing. Existing data has been preserved.'),
          { code: StartupCompatibilityErrorCode.VersionUnconfirmed });
      // Classification may deliberately discard an old journal when selecting the
      // JSONL path. Its completed delivery still cannot authorize a downgrade.
      if (previous && previous.stage !== StartupStage.Complete && previous.targetIdentity &&
          !sameStartupIdentity(previous.targetIdentity, identity))
        throw Object.assign(new Error('An unfinished startup transaction belongs to a different application runtime. Existing data has been preserved.'),
          { code: StartupCompatibilityErrorCode.VersionUnconfirmed });
      let inspected: { needsUpgrade: boolean } | undefined;
      let downgradeConfirmation: StartupDowngradeConfirmation | undefined;
      if (delivery.allowed === false && delivery.requiresNativeInspection) {
        // Only an exact reviewed exception may reach this read-only step. It
        // still cannot grant maintenance or publish a completed identity.
        inspected = await options.native.inspect();
        delivery = assessStartupDelivery({ ...deliveryInput, nativeCompatibilityConfirmed: true });
      }
      if (delivery.allowed === false && delivery.blockReason === StartupCompatibilityErrorCode.DowngradeBlocked && sourceIdentity) {
        const versions = ({ appVersion, runtimeVersion }: StartupIdentity) => ({ appVersion, runtimeVersion });
        downgradeConfirmation = { requestId: randomUUID(), source: versions(sourceIdentity), target: versions(identity) };
      } else if (delivery.allowed === false)
        throw Object.assign(new Error('This application delivery cannot safely open the existing data.'),
          { code: delivery.blockReason });
      if (decision.route === StartupRoute.Normal || decision.route === StartupRoute.Upgrade) {
        const pending = decision.journal?.route === StartupRoute.Upgrade &&
          decision.journal.stage !== StartupStage.Complete;
        const previousRuntimeVersion = decision.journal?.completedIdentity?.runtimeVersion;
        // App-only releases also change the manifest fingerprint through the
        // build recipe. Neither change alone requires the upgrade presentation.
        // Exact identities still fence recovery, admission and completion.
        const requiresPreparation = !previousRuntimeVersion ||
          previousRuntimeVersion.replace(/^v/, '') !== identity.runtimeVersion.replace(/^v/, '') ||
          !!downgradeConfirmation || !!decision.journal?.targetIdentity;
        if (!pending && requiresPreparation) {
          decision = { route: StartupRoute.Upgrade, journal: {
            ...newStartupJournal(StartupRoute.Upgrade),
            completedIdentity: decision.journal?.completedIdentity,
            lastOpenedIdentity: decision.journal?.lastOpenedIdentity,
            targetIdentity: identity,
          } };
        }
        // Only upgrade/recovery paths run host-native inspection. Ordinary
        // launches leave current schema/session admission to Gateway startup.
        if (!downgradeConfirmation && (pending || requiresPreparation)) inspected ??= await options.native.inspect();
        if (pending || inspected?.needsUpgrade || requiresPreparation) {
          decision = { route: StartupRoute.Upgrade, journal: decision.route === StartupRoute.Upgrade ? decision.journal : {
            ...newStartupJournal(StartupRoute.Upgrade),
            completedIdentity: decision.journal?.completedIdentity,
            lastOpenedIdentity: decision.journal?.lastOpenedIdentity,
            targetIdentity: identity,
          } };
        }
      }
      return new StartupCoordinator(userData, { decision, identity, native: options.native, startedAt,
        downgradeConfirmation, downgradeSourceIdentity: downgradeConfirmation ? sourceIdentity : undefined });
    } catch (error) {
      return new StartupCoordinator(userData, { decision, error, startedAt });
    }
  }

  get stage(): StartupStage {
    return this.journal.stage;
  }

  getDowngradeConfirmation(): StartupDowngradeConfirmation | undefined {
    return !this.stopped && !this.downgradeConfirmed && this.downgradeConfirmation
      ? structuredClone(this.downgradeConfirmation) : undefined;
  }

  confirmDowngrade(requestId: string): boolean {
    if (this.preparationError || this.stopped || this.downgradeConfirmed ||
        requestId !== this.downgradeConfirmation?.requestId) return false;
    try {
      const current = readStartupJournal(this.userData);
      if (!this.downgradeSourceIdentity || !sameStartupIdentity(
        current?.lastOpenedIdentity ?? current?.completedIdentity, this.downgradeSourceIdentity)) return false;
    } catch { return false; }
    this.downgradeConfirmed = true;
    this.confirmationWaiter?.resolve();
    this.confirmationWaiter = undefined;
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.confirmationWaiter?.reject(new Error('Startup confirmation was cancelled. Existing data has been preserved.'));
    this.confirmationWaiter = undefined;
  }

  private async waitForDowngradeConfirmation(): Promise<void> {
    if (this.stopped) throw new Error('Application startup was interrupted.');
    if (this.downgradeConfirmation && !this.downgradeConfirmed) {
      if (this.confirmationWaiter) throw new Error('Another startup confirmation wait is already active.');
      await new Promise<void>((resolve, reject) => { this.confirmationWaiter = { resolve, reject }; });
    }
    if (this.stopped) throw new Error('Application startup was interrupted.');
  }

  /** Ordinary launches delegate admission to Gateway; maintenance routes prepare native storage offline. */
  async verifyNativeReady(onActivity?: (activity: AppInitializationActivity) => void): Promise<boolean> {
    if (this.preparationError) throw this.preparationError;
    if (this.stopped) throw new Error('Application startup was interrupted.');
    if (this.route === StartupRoute.Normal) return true;
    if (!this.native || this.canonicalPrepared) return true;
    try {
      if (!this.nativeVerified) {
        const schemaReady = !(await this.native.inspect()).needsUpgrade;
        if (!schemaReady && this.route === StartupRoute.Upgrade)
          throw Object.assign(new Error('Native database readiness changed after startup routing. Existing data has been preserved.'),
            { code: StartupCompatibilityErrorCode.VersionUnconfirmed });
        if (!schemaReady) return false;
      }
      // The native certifier owns persisted session proof and pending rows. Drain
      // it in an offline child before synchronous Gateway plugin registration.
      const sessionActivities = {
        [AppInitializationActivity.NativeInspect]: AppInitializationActivity.SessionInspect,
        [AppInitializationActivity.NativeBackup]: AppInitializationActivity.SessionBackup,
        [AppInitializationActivity.NativeUpgrade]: AppInitializationActivity.SessionPrepare,
        [AppInitializationActivity.NativeVerify]: AppInitializationActivity.SessionVerify,
      } as const;
      await this.native.prepareCanonical(activity => onActivity?.(sessionActivities[activity]));
      if (this.stopped) throw new Error('Application startup was interrupted.');
      this.nativeVerified = true;
      this.canonicalPrepared = true;
      return true;
    } catch (error) {
      if (this.route === StartupRoute.Upgrade) throw error;
      console.warn('[StartupCoordinator] Native readiness was not confirmed; no completed identity will be recorded:', error);
      return false;
    }
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
    await this.waitForDowngradeConfirmation();
    // Human consent only removes the version warning. The target's actual
    // native admission remains mandatory and can still refuse the data.
    if (this.downgradeConfirmation && this.route === StartupRoute.Upgrade)
      await this.native!.inspect();
    // Record ownership before the first fresh/import/upgrade operation. An older
    // delivery must never resume stages committed by a different native runtime.
    if (this.targetIdentity && this.route !== StartupRoute.Normal && !this.journal.targetIdentity)
      this.commit(this.journal.stage, { targetIdentity: this.targetIdentity });
    if (this.route === StartupRoute.Upgrade) {
      if (!this.native || !this.targetIdentity)
        throw new Error('The native database upgrade owner is unavailable.');
      if (classifyInstallation(this.userData, false).route !== StartupRoute.Normal)
        throw new Error('The product data generation changed before database upgrade. Existing data has been preserved.');
      this.commit(StartupStage.UpgradePrepare, { targetIdentity: this.targetIdentity });
      progress.reportActivity(AppInitializationActivity.NativeInspect);
      // Reconcile unknown/interrupted outcomes from live native facts, never an old exit code.
      if ((await this.native.inspect()).needsUpgrade) {
        await this.native.upgrade(activity => progress.reportActivity(activity));
      }
      this.commit(StartupStage.UpgradeVerify);
      progress.reportActivity(AppInitializationActivity.NativeVerify);
      if ((await this.native.inspect()).needsUpgrade)
        throw new Error('Native database verification still reports an unfinished schema upgrade.');
      if (classifyInstallation(this.userData, false).route !== StartupRoute.Normal)
        throw new Error('The product data generation changed during database upgrade. Existing data has been preserved.');
      this.nativeVerified = true;
      this.commit(StartupStage.Check);
      progress.advance(AppInitializationStep.UserData, 0);
      return;
    }
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
      verifyNativeHistoryOriginals(this.userData, this.history);
      this.commit(StartupStage.Isolate, { isolatedEntries: entries });
    }
    if (this.journal.stage === StartupStage.Isolate) {
      verifyHistoryBackup(this.history);
      // A resumed isolation may already have moved openclaw into retired/.
      if (startupPathExists(path.join(this.userData, 'openclaw')))
        verifyNativeHistoryOriginals(this.userData, this.history);
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
    if (this.stopped) throw new Error('Application startup was interrupted.');
    if (this.route === StartupRoute.Upgrade &&
        (!this.nativeVerified || !this.canonicalPrepared))
      throw new Error('The application runtime has not completed its startup checks.');
    if (
      this.route === StartupRoute.Migration &&
      this.journal.stage !== StartupStage.Check &&
      this.journal.stage !== StartupStage.Complete
    )
      throw new Error('History restoration is not complete.');
    if (this.route === StartupRoute.Normal) {
      if (this.targetIdentity) {
        // Track application version ordering without claiming that this ordinary
        // opening performed native database maintenance or certification.
        if (this.journal.stage !== StartupStage.Complete || this.journal.targetIdentity ||
            !sameStartupIdentity(this.journal.lastOpenedIdentity ?? this.journal.completedIdentity, this.targetIdentity))
          this.commit(StartupStage.Complete, { lastOpenedIdentity: this.targetIdentity, targetIdentity: undefined });
      } else if (this.journal.stage !== StartupStage.Complete) {
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
    this.commit(StartupStage.Complete, this.targetIdentity && this.nativeVerified && this.canonicalPrepared
      ? { completedIdentity: this.targetIdentity, lastOpenedIdentity: this.targetIdentity, targetIdentity: undefined } : {});
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
