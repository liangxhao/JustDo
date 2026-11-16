import { EXECUTION_ADMISSION_MAINTENANCE_METHOD, type ExecutionAdmissionReceipt } from '@runtime-services/sdk/admission';
import type Database from 'better-sqlite3';

const PREFIX = 'agentTeam.launch.receipt.';
const STATES = ['pending', 'verified', 'attempted', 'launched', 'cancelled', 'released', 'unknown'] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;

interface LaunchReceipt {
  version: 1;
  sessionId: string;
  sessionKey: string;
  nativeSessionId: string;
  clientTurnId: string;
  state: (typeof STATES)[number];
  lifecycleRevision?: string | null;
  generation: number;
  localGeneration: number;
  submissionStarted: boolean;
  wholeSettled: boolean;
  cancelRequested: boolean;
  executionAdmission?: { id: string; generation: number };
}

interface Dependencies {
  getDatabase: () => Database.Database;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
}

interface Loaded {
  receipt: LaunchReceipt;
  raw: string;
}

function parseReceipt(value: unknown, sessionId: string): LaunchReceipt {
  if (!record(value) || value.version !== 1 || value.sessionId !== sessionId ||
      !id(value.sessionKey) || !id(value.nativeSessionId) || !id(value.clientTurnId) ||
      !STATES.some(state => value.state === state) ||
      ['generation', 'localGeneration'].some(key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0) ||
      ['submissionStarted', 'wholeSettled', 'cancelRequested']
        .some(key => typeof value[key] !== 'boolean') ||
      (value.lifecycleRevision !== undefined && value.lifecycleRevision !== null && !id(value.lifecycleRevision)) ||
      (value.executionAdmission !== undefined && (!record(value.executionAdmission) || !id(value.executionAdmission.id) ||
        !Number.isSafeInteger(value.executionAdmission.generation) || Number(value.executionAdmission.generation) < 1)))
    throw new Error('teamLaunchUnconfirmed');
  return value as unknown as LaunchReceipt;
}

/** Reconcile existing launch receipts after the composer stopped creating new ones. */
export class AgentTeamLaunchCoordinator {
  private readonly reconciling = new Set<string>();
  constructor(private readonly deps: Dependencies) {}
  protectedSessionIds(): string[] {
    const rows = this.deps
      .getDatabase()
      .prepare('SELECT key,value FROM kv WHERE key LIKE ?')
      .all(PREFIX + '%') as { key: string; value: string }[];
    return rows.flatMap(row => {
      const sessionId = row.key.slice(PREFIX.length);
      try {
        return parseReceipt(JSON.parse(row.value), sessionId).state === 'released'
          ? []
          : [sessionId];
      } catch {
        return [sessionId];
      }
    });
  }
  hasReadableReceipt(sessionId: string): boolean {
    try {
      return this.load(sessionId) !== undefined;
    } catch {
      return false;
    }
  }

  private load(sessionId: string): Loaded | undefined {
    const row = this.deps
      .getDatabase()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(PREFIX + sessionId) as { value: string } | undefined;
    if (!row) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      throw new Error('teamLaunchUnconfirmed');
    }
    return { receipt: parseReceipt(parsed, sessionId), raw: row.value };
  }
  private write(receipt: LaunchReceipt, expected: Loaded): boolean {
    const db = this.deps.getDatabase();
    const raw = JSON.stringify(receipt);
    return (
      db
        .prepare('UPDATE kv SET value = ?,updated_at = ? WHERE key = ? AND value = ?')
        .run(raw, Date.now(), PREFIX + receipt.sessionId, expected.raw).changes === 1
    );
  }
  private current(receipt: LaunchReceipt): Loaded {
    const current = this.load(receipt.sessionId);
    if (
      !current ||
      current.receipt.clientTurnId !== receipt.clientTurnId ||
      current.receipt.nativeSessionId !== receipt.nativeSessionId ||
      current.receipt.sessionKey !== receipt.sessionKey ||
      current.receipt.localGeneration !== receipt.localGeneration
    )
      throw new Error('teamLaunchUnconfirmed');
    return current;
  }
  private update(receipt: LaunchReceipt, change: Partial<LaunchReceipt>): LaunchReceipt {
    const current = this.current(receipt);
    const next = { ...current.receipt, ...change };
    if (!this.write(next, current)) throw new Error('teamLaunchUnconfirmed');
    return next;
  }
  private async readExecutionAdmission(receipt: LaunchReceipt): Promise<ExecutionAdmissionReceipt> {
    const result = await this.deps.requestGateway<{ receipt?: ExecutionAdmissionReceipt }>(EXECUTION_ADMISSION_MAINTENANCE_METHOD, {
      operation: 'inspect', sessionKey: receipt.sessionKey, sessionId: receipt.nativeSessionId, runId: receipt.clientTurnId,
      ...(receipt.lifecycleRevision === undefined ? {} : { lifecycleRevision: receipt.lifecycleRevision }),
    });
    const value = result.receipt;
    if (!value || value.version !== 2 || value.sessionKey !== receipt.sessionKey || value.sessionId !== receipt.nativeSessionId ||
        value.runId !== receipt.clientTurnId || !id(value.id) || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
        value.owner?.pluginId !== 'agent-team' || !['held', 'revoked', 'released'].includes(value.state) ||
        (receipt.executionAdmission && (value.id !== receipt.executionAdmission.id || value.generation !== receipt.executionAdmission.generation)) ||
        (receipt.lifecycleRevision !== undefined && value.lifecycleRevision !== receipt.lifecycleRevision))
      throw new Error('teamLaunchUnconfirmed');
    return value;
  }
  private async maintain(enrolled: ExecutionAdmissionReceipt, operation: 'revoke' | 'cleanup' | 'release' | 'abandon',
    evidence: { receiptId?: string; neverSubmitted?: true } = {}): Promise<ExecutionAdmissionReceipt['state']> {
    const result = await this.deps.requestGateway<{ receipt?: ExecutionAdmissionReceipt }>(EXECUTION_ADMISSION_MAINTENANCE_METHOD, {
      operation, sessionKey: enrolled.sessionKey, sessionId: enrolled.sessionId, lifecycleRevision: enrolled.lifecycleRevision,
      runId: enrolled.runId, id: enrolled.id, generation: enrolled.generation, ...evidence,
    });
    if (!result.receipt || result.receipt.id !== enrolled.id || result.receipt.generation !== enrolled.generation)
      throw new Error('teamLaunchUnconfirmed');
    return result.receipt.state;
  }
  private async cleanupIdle(receipt: LaunchReceipt, neverSubmitted: boolean): Promise<boolean> {
    const { session } = await this.deps.requestGateway<{ session?: Record<string, unknown> }>(
      'sessions.describe', { key: receipt.sessionKey },
    );
    if (!session || session.key !== receipt.sessionKey || session.sessionId !== receipt.nativeSessionId ||
        session.lifecycleRevision !== receipt.lifecycleRevision || session.hasActiveRun !== false ||
        (session.hasActiveSubagentRun !== undefined && session.hasActiveSubagentRun !== false))
      return false;
    this.current(receipt);
    const history = await this.deps.requestGateway<Record<string, unknown>>('chat.history', {
      sessionKey: receipt.sessionKey,
      limit: 1,
      inputRunIds: [receipt.clientTurnId],
    });
    this.current(receipt);
    const receipts = history.inputReceipts;
    const consumptions = history.inputConsumptions;
    const knownReceipts =
      Array.isArray(receipts) &&
      Array.isArray(consumptions) &&
      (neverSubmitted
        ? receipts.length === 0 && consumptions.length === 0
        : receipts.every(
            value =>
              record(value) &&
              value.runId === receipt.clientTurnId &&
              ((value.state === 'consumed' && id(value.consumedByEventId)) ||
                (value.state === 'pending' && value.cancelled === true)),
          ) &&
          consumptions.every(
            value =>
              record(value) &&
              value.runId === receipt.clientTurnId &&
              id(value.consumedByEventId) &&
              receipts.some(
                other =>
                  record(other) &&
                  other.state === 'consumed' &&
                  other.consumedByEventId === value.consumedByEventId,
              ),
          ));
    return (
      record(history.sessionInfo) &&
      history.sessionInfo.sessionId === receipt.nativeSessionId &&
      history.sessionInfo.hasActiveRun === false &&
      record(history.pendingInputs) &&
      history.pendingInputs.total === 0 &&
      Array.isArray(history.pendingInputs.items) &&
      history.pendingInputs.items.length === 0 &&
      knownReceipts
    );
  }

  async cancel(sessionId: string): Promise<void> {
    const loaded = this.load(sessionId);
    if (!loaded || loaded.receipt.state === 'released' || loaded.receipt.cancelRequested) return;
    const cancelled: LaunchReceipt = {
      ...loaded.receipt,
      localGeneration: loaded.receipt.localGeneration + 1,
      state: 'cancelled',
      cancelRequested: true,
    };
    if (!this.write(cancelled, loaded)) throw new Error('teamLaunchUnconfirmed');
    try {
      const enrolled = await this.readExecutionAdmission(cancelled);
      this.current(cancelled);
      const result = await this.maintain(enrolled, 'revoke');
      if (result !== 'revoked' && result !== 'released') throw new Error('teamLaunchUnconfirmed');
      this.update(cancelled, { state: result === 'revoked' ? 'cancelled' : 'released' });
    } catch {
      this.recordUnknown(cancelled);
    }
  }

  async releaseIfSettled(sessionId: string): Promise<boolean> {
    const loaded = this.load(sessionId);
    if (!loaded || loaded.receipt.state === 'released') return true;
    if (this.reconciling.has(sessionId)) return false;

    this.reconciling.add(sessionId);
    let receipt = loaded.receipt;
    try {
      const enrolled = await this.readExecutionAdmission(receipt);
      this.current(receipt);
      if (enrolled.state === 'released') {
        this.update(receipt, { state: 'released' });
        return true;
      }
      const terminal = enrolled.sourceTerminal;
      const settled = terminal?.executionSettled === true &&
        terminal.runId === receipt.clientTurnId && terminal.sessionId === receipt.nativeSessionId &&
        (terminal.phase === 'end' || terminal.phase === 'error');
      const abandon = !settled && !receipt.wholeSettled && !receipt.submissionStarted &&
        !enrolled.verified && !enrolled.effectIssued;
      if (!abandon && !settled) return false;

      receipt = this.update(receipt, {
        lifecycleRevision: enrolled.lifecycleRevision,
        executionAdmission: { id: enrolled.id, generation: enrolled.generation },
        ...(settled ? { wholeSettled: true } : {}),
      });
      if (!await this.cleanupIdle(receipt, abandon)) return false;
      if (abandon) {
        if (await this.maintain(enrolled, 'abandon', { neverSubmitted: true }) !== 'released')
          throw new Error('teamLaunchUnconfirmed');
      } else {
        const receiptId = `${receipt.clientTurnId}:${receipt.generation}:dispatcher-cleanup`;
        if (enrolled.cleanupReceipt?.id !== receiptId) await this.maintain(enrolled, 'cleanup', { receiptId });
        if (await this.maintain(enrolled, 'release', { receiptId }) !== 'released')
          throw new Error('teamLaunchUnconfirmed');
      }
      this.update(receipt, { state: 'released' });
      return true;
    } catch {
      this.recordUnknown(receipt);
      return false;
    } finally {
      this.reconciling.delete(sessionId);
    }
  }

  private recordUnknown(receipt: LaunchReceipt): void {
    try {
      const current = this.current(receipt);
      if (current.receipt.state !== 'unknown') this.write({ ...current.receipt, state: 'unknown' }, current);
    } catch {
      /* A concurrent cancellation or reconciliation owns the local receipt. */
    }
  }
}
