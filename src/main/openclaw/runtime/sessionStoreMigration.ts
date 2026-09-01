import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import {
  OpenClawSessionMigrationPhase,
  type OpenClawSessionMigrationPlan,
  type OpenClawSessionMigrationProgress,
  type OpenClawSessionMigrationResult,
} from '../../../shared/openclaw/sessionMigration';

type CliResult = { stdout: string; stderr: string };

type SessionStoreMigrationOptions = {
  stateDir: string;
  baseDir: string;
  runtimeVersion: () => string | null;
  runCli: (args: string[]) => Promise<CliResult>;
  now?: () => number;
};

type LegacySource = {
  agentId: string;
  path: string;
  size: number;
  modifiedAt: number;
  digest: string;
};

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const redactError = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .slice(0, 500);
};

const parseJsonOutput = (stdout: string): JsonRecord => {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    const value = JSON.parse(trimmed) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    const lines = trimmed.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const value = JSON.parse(lines[index]) as unknown;
        if (isRecord(value)) return value;
      } catch {
        // Keep looking for the final structured CLI record.
      }
    }
    return {};
  }
};

const findNumericField = (value: unknown, names: ReadonlySet<string>): number | undefined => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findNumericField(entry, names);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (names.has(key) && typeof entry === 'number' && Number.isFinite(entry)) return entry;
  }
  for (const entry of Object.values(value)) {
    const found = findNumericField(entry, names);
    if (found !== undefined) return found;
  }
  return undefined;
};

const writeJsonAtomic = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, filePath);
};

export class SessionStoreMigrationCoordinator extends EventEmitter {
  private readonly options: SessionStoreMigrationOptions;
  private activePlan: OpenClawSessionMigrationPlan | null = null;
  private activeSources: LegacySource[] = [];
  private operation: Promise<OpenClawSessionMigrationResult> | null = null;

  constructor(options: SessionStoreMigrationOptions) {
    super();
    this.options = options;
  }

  private sanitizeError(error: unknown): string {
    return redactError(error)
      .replaceAll(path.resolve(this.options.stateDir), '<openclaw-state>')
      .replaceAll(path.resolve(this.options.baseDir), '<openclaw-data>')
      .replace(/(?:[A-Za-z]:\\|\/)[^\s"']+/g, '[path]');
  }

  override on(
    event: 'progress',
    listener: (progress: OpenClawSessionMigrationProgress) => void,
  ): this {
    return super.on(event, listener);
  }

  private discoverSources(): LegacySource[] {
    const agentsDir = path.join(this.options.stateDir, 'agents');
    if (!fs.existsSync(agentsDir)) return [];
    const sources: LegacySource[] = [];
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const sourcePath = path.join(agentsDir, entry.name, 'sessions', 'sessions.json');
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(sourcePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      sources.push({
        agentId: entry.name,
        path: sourcePath,
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        digest: crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
      });
    }
    return sources.sort((left, right) => left.agentId.localeCompare(right.agentId));
  }

  private buildPlanId(sources: LegacySource[]): string {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify(
          sources.map(source => [source.agentId, source.size, source.modifiedAt, source.digest]),
        ),
      )
      .digest('hex')
      .slice(0, 24);
  }

  async plan(): Promise<OpenClawSessionMigrationPlan> {
    let sources: LegacySource[];
    try {
      sources = this.discoverSources();
    } catch (error) {
      const message = this.sanitizeError(error);
      this.activeSources = [];
      this.activePlan = {
        required: true,
        planId: 'legacy-store-scan-failed',
        sourceCount: 0,
        agents: [],
        phase: OpenClawSessionMigrationPhase.Failed,
        error: message,
      };
      this.emitProgress({
        phase: OpenClawSessionMigrationPhase.Failed,
        planId: this.activePlan.planId,
        completedSteps: 0,
        totalSteps: 4,
        error: message,
      });
      return this.activePlan;
    }
    if (sources.length === 0) {
      this.activeSources = [];
      this.activePlan = { required: false, sourceCount: 0, agents: [] };
      return this.activePlan;
    }
    const planId = this.buildPlanId(sources);
    if (this.activePlan?.planId === planId && this.activePlan.phase !== OpenClawSessionMigrationPhase.Failed) {
      return this.activePlan;
    }
    this.activeSources = sources;
    this.emitProgress({
      phase: OpenClawSessionMigrationPhase.Planning,
      planId,
      completedSteps: 0,
      totalSteps: 4,
    });
    try {
      const result = await this.options.runCli([
        'doctor',
        '--session-sqlite',
        'dry-run',
        '--session-sqlite-all-agents',
        '--non-interactive',
        '--json',
      ]);
      const report = parseJsonOutput(result.stdout);
      this.activePlan = {
        required: true,
        planId,
        sourceCount: sources.length,
        agents: sources.map(source => source.agentId),
        dryRun: {
          targetCount: findNumericField(report, new Set(['targetCount', 'targets'])),
          sessionCount: findNumericField(
            report,
            new Set(['sessionCount', 'sessions', 'legacyEntries']),
          ),
          transcriptCount: findNumericField(
            report,
            new Set(['transcriptCount', 'transcripts', 'events', 'validatedTranscriptEvents']),
          ),
        },
        phase: OpenClawSessionMigrationPhase.AwaitingConfirmation,
      };
      this.emitProgress({
        phase: OpenClawSessionMigrationPhase.AwaitingConfirmation,
        planId,
        completedSteps: 1,
        totalSteps: 4,
      });
    } catch (error) {
      const message = this.sanitizeError(error);
      this.activePlan = {
        required: true,
        planId,
        sourceCount: sources.length,
        agents: sources.map(source => source.agentId),
        phase: OpenClawSessionMigrationPhase.Failed,
        error: message,
      };
      this.emitProgress({
        phase: OpenClawSessionMigrationPhase.Failed,
        planId,
        completedSteps: 0,
        totalSteps: 4,
        error: message,
      });
    }
    return this.activePlan;
  }

  async confirm(planId: string, approved: boolean): Promise<OpenClawSessionMigrationResult> {
    const plan = await this.plan();
    if (!plan.required || !plan.planId || plan.planId !== planId) {
      return { success: false, error: 'The session migration plan is stale. Review it again.' };
    }
    if (!approved) {
      const progress = {
        phase: OpenClawSessionMigrationPhase.Cancelled,
        planId,
        completedSteps: 1,
        totalSteps: 4,
      } satisfies OpenClawSessionMigrationProgress;
      this.activePlan = { ...plan, phase: progress.phase };
      this.emitProgress(progress);
      return { success: false, cancelled: true, progress };
    }
    if (plan.phase === OpenClawSessionMigrationPhase.Failed) {
      return { success: false, error: plan.error ?? 'The migration dry-run failed.' };
    }
    if (this.operation) return this.operation;
    this.operation = this.execute(planId).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  private async execute(planId: string): Promise<OpenClawSessionMigrationResult> {
    const migrationDir = path.join(this.options.baseDir, 'session-migrations');
    const backupDir = path.join(migrationDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date(this.options.now?.() ?? Date.now()).toISOString().replace(/[:.]/gu, '-');
    const requestedBackupPath = path.join(backupDir, `${timestamp}-pre-v2026.8.1.tar.gz`);
    let backupPath: string | undefined;
    let importStarted = false;
    try {
      this.emitProgress({
        phase: OpenClawSessionMigrationPhase.BackingUp,
        planId,
        completedSteps: 1,
        totalSteps: 4,
      });
      const backup = parseJsonOutput(
        (
          await this.options.runCli([
            'backup',
            'create',
            '--output',
            requestedBackupPath,
            '--verify',
            '--no-include-workspace',
            '--json',
          ])
        ).stdout,
      );
      backupPath = typeof backup.archivePath === 'string' ? backup.archivePath : requestedBackupPath;
      if (backup.verified !== true || !fs.existsSync(backupPath)) {
        throw new Error('OpenClaw did not produce a verified pre-migration backup.');
      }

      this.emitProgress({
        phase: OpenClawSessionMigrationPhase.Importing,
        planId,
        completedSteps: 2,
        totalSteps: 4,
        backupPath,
      });
      importStarted = true;
      const imported = parseJsonOutput(
        (
          await this.options.runCli([
            'doctor',
            '--session-sqlite',
            'import',
            '--session-sqlite-all-agents',
            '--non-interactive',
            '--yes',
            '--json',
          ])
        ).stdout,
      );

      this.emitProgress({
        phase: OpenClawSessionMigrationPhase.Inspecting,
        planId,
        completedSteps: 3,
        totalSteps: 4,
        backupPath,
      });
      const validated = parseJsonOutput(
        (
          await this.options.runCli([
            'doctor',
            '--session-sqlite',
            'validate',
            '--session-sqlite-all-agents',
            '--non-interactive',
            '--json',
          ])
        ).stdout,
      );
      const inspected = parseJsonOutput(
        (
          await this.options.runCli([
            'doctor',
            '--session-sqlite',
            'inspect',
            '--session-sqlite-all-agents',
            '--non-interactive',
            '--json',
          ])
        ).stdout,
      );
      const remainingSources = this.discoverSources();
      if (remainingSources.length > 0) {
        throw new Error('OpenClaw left legacy session sources after import verification.');
      }

      const receiptPath = path.join(migrationDir, `${timestamp}-${planId}.receipt.json`);
      const manifestPath = path.join(migrationDir, `${timestamp}-${planId}.manifest.json`);
      writeJsonAtomic(manifestPath, {
        schemaVersion: 1,
        planId,
        runtimeVersion: this.options.runtimeVersion(),
        createdAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
        backupPath,
        sources: this.activeSources,
        dryRun: this.activePlan?.dryRun,
        import: imported,
        validate: validated,
        inspect: inspected,
      });
      writeJsonAtomic(receiptPath, {
        schemaVersion: 1,
        status: 'completed',
        planId,
        runtimeVersion: this.options.runtimeVersion(),
        backupPath,
        manifestPath,
        completedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      });
      const progress = {
        phase: OpenClawSessionMigrationPhase.Completed,
        planId,
        completedSteps: 4,
        totalSteps: 4,
        backupPath,
        receiptPath,
      } satisfies OpenClawSessionMigrationProgress;
      this.activeSources = [];
      this.activePlan = { required: false, sourceCount: 0, agents: [] };
      this.emitProgress(progress);
      return { success: true, progress };
    } catch (error) {
      let message = this.sanitizeError(error);
      if (importStarted && this.discoverSources().length < this.activeSources.length) {
        try {
          await this.options.runCli([
            'doctor',
            '--session-sqlite',
            'restore',
            '--session-sqlite-all-agents',
            '--non-interactive',
            '--yes',
            '--json',
          ]);
        } catch (restoreError) {
          message = `${message} Legacy source restoration also failed: ${this.sanitizeError(restoreError)}`.slice(
            0,
            500,
          );
        }
        if (this.discoverSources().length < this.activeSources.length) {
          message = `${message} The verified backup was retained for manual recovery.`.slice(0, 500);
        }
      }
      const progress = {
        phase: OpenClawSessionMigrationPhase.Failed,
        planId,
        completedSteps: backupPath ? 2 : 1,
        totalSteps: 4,
        ...(backupPath ? { backupPath } : {}),
        error: message,
      } satisfies OpenClawSessionMigrationProgress;
      this.activePlan = this.activePlan
        ? { ...this.activePlan, phase: progress.phase, error: message }
        : null;
      this.emitProgress(progress);
      return { success: false, progress, error: message };
    }
  }

  private emitProgress(progress: OpenClawSessionMigrationProgress): void {
    this.emit('progress', progress);
  }
}
