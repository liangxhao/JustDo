import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import { parsePlanModeState } from '../../../plan-mode/contracts/state';
import { OpenClawExtensionId } from '../../../runtime-services/contracts/native-ids';
import { buildCoworkSessionKey } from '../../../runtime-services/contracts/session-key';
import { normalizeAgentTeamLaunchText } from '../../prompt/agentTeamLaunchText';
import { AGENT_TEAM_MODE, recognizeAgentTeamMode } from '../../prompt/agentTeamPrompt';
import type { TeamHostStore as CoworkStore } from '../ports';
import type { TeamHostRouter as CoworkEngineRouter } from '../ports';

const PREFIX = 'agentTeam.launch.receipt.';
const RPC = {
  INSPECT: 'agentTeam.launch.inspect',
  REGISTER: 'agentTeam.launch.register',
  CANCEL: 'agentTeam.launch.cancel',
  ABANDON: 'agentTeam.launch.abandon',
  RELEASE: 'agentTeam.launch.release',
  CONFIRM: 'agentTeam.launch.confirm',
} as const;
type Mode = 'collaboration' | 'discussion';
type State =
  'pending' | 'verified' | 'attempted' | 'launched' | 'cancelled' | 'released' | 'unknown';
const STATES: readonly string[] = [
  'pending',
  'verified',
  'attempted',
  'launched',
  'cancelled',
  'released',
  'unknown',
];
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
  promptSha256: string;
  mode: Mode;
  state: State;
  lifecycleRevision?: string | null;
  expectedGeneration: number;
  generation: number;
  localGeneration: number;
  registerAcknowledged: boolean;
  submissionStarted: boolean;
  wholeSettled: boolean;
  cancelRequested: boolean;
  abandonRequested: boolean;
  releaseRequested: boolean;
  confirmReceiptId?: string;
}
interface Dependencies {
  getStore: () => Pick<
    CoworkStore,
    | 'getSession'
    | 'getSessionByNativeKey'
    | 'getGoalExecutionSnapshot'
    | 'getSessionRunByClientTurnId'
  >;
  getDatabase: () => Database.Database;
  getRouter: () => Pick<CoworkEngineRouter, 'prepareSession' | 'getSessionRuntimeStatus'>;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
}
interface Loaded {
  receipt: LaunchReceipt;
  raw: string;
}
interface NativeInspection {
  state?: unknown;
  generation?: unknown;
  wholeSettled?: unknown;
  launch?: unknown;
}
const fields = [
  'version',
  'sessionId',
  'sessionKey',
  'nativeSessionId',
  'clientTurnId',
  'promptSha256',
  'mode',
  'state',
  'lifecycleRevision',
  'expectedGeneration',
  'generation',
  'localGeneration',
  'registerAcknowledged',
  'submissionStarted',
  'wholeSettled',
  'cancelRequested',
  'abandonRequested',
  'releaseRequested',
  'confirmReceiptId',
];
function parseReceipt(value: unknown, sessionId: string): LaunchReceipt {
  if (
    !record(value) ||
    Object.keys(value).some(key => !fields.includes(key)) ||
    value.version !== 1 ||
    value.sessionId !== sessionId ||
    !id(value.sessionKey) ||
    !id(value.nativeSessionId) ||
    !id(value.clientTurnId) ||
    typeof value.promptSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.promptSha256) ||
    !['discussion', 'collaboration'].includes(String(value.mode)) ||
    !STATES.includes(String(value.state)) ||
    ['expectedGeneration', 'generation', 'localGeneration'].some(
      key => !Number.isSafeInteger(value[key]) || Number(value[key]) < 0,
    ) ||
    [
      'registerAcknowledged',
      'submissionStarted',
      'wholeSettled',
      'cancelRequested',
      'abandonRequested',
      'releaseRequested',
    ].some(key => typeof value[key] !== 'boolean') ||
    !(
      value.lifecycleRevision === undefined ||
      value.lifecycleRevision === null ||
      id(value.lifecycleRevision)
    ) ||
    !(value.confirmReceiptId === undefined || id(value.confirmReceiptId))
  )
    throw new Error('teamLaunchUnconfirmed');
  return value as unknown as LaunchReceipt;
}

/** Product operation identities and terminal facts only; native OpenClaw owns all input text. */
export class AgentTeamLaunchCoordinator {
  private readonly preparing = new Map<string, { clientTurnId: string; token: number }>();
  private readonly cancellations = new Map<string, number>();
  private readonly reconciling = new Set<string>();
  constructor(private readonly deps: Dependencies) {}

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
  private write(receipt: LaunchReceipt, expected?: Loaded): boolean {
    const db = this.deps.getDatabase();
    const raw = JSON.stringify(receipt);
    if (!expected)
      return (
        db
          .prepare('INSERT OR IGNORE INTO kv(key,value,updated_at) VALUES(?,?,?)')
          .run(PREFIX + receipt.sessionId, raw, Date.now()).changes === 1
      );
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
      current.receipt.promptSha256 !== receipt.promptSha256 ||
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
  private source(sessionId: string) {
    const store = this.deps.getStore();
    const source = store.getSession(sessionId);
    if (
      !source ||
      source.external ||
      source.nativeParentSessionId ||
      store.getGoalExecutionSnapshot(sessionId)
    )
      throw new Error('teamLaunchContractUnavailable');
    return source;
  }
  private async idle(sessionId: string): Promise<boolean> {
    const status = await this.deps.getRouter().getSessionRuntimeStatus(sessionId, {
      includeSubagents: true,
      forceRefresh: true,
      fullScan: true,
    });
    return status.known && !status.running && !status.mainRunning && !status.subagentRunning;
  }
  private params(receipt: LaunchReceipt) {
    return {
      sessionKey: receipt.sessionKey,
      nativeSessionId: receipt.nativeSessionId,
      clientTurnId: receipt.clientTurnId,
    };
  }
  private matches(
    receipt: LaunchReceipt,
    inspected: NativeInspection,
  ): inspected is NativeInspection & { launch: Record<string, unknown>; generation: number } {
    const launch = inspected.launch;
    return (
      record(launch) &&
      Number.isSafeInteger(inspected.generation) &&
      inspected.generation === receipt.expectedGeneration + 1 &&
      launch.generation === inspected.generation &&
      launch.sessionKey === receipt.sessionKey &&
      launch.nativeSessionId === receipt.nativeSessionId &&
      launch.clientTurnId === receipt.clientTurnId &&
      launch.promptSha256 === receipt.promptSha256 &&
      launch.mode === receipt.mode &&
      (receipt.lifecycleRevision === undefined ||
        launch.lifecycleRevision === receipt.lifecycleRevision) &&
      (launch.lifecycleRevision === null || id(launch.lifecycleRevision)) &&
      STATES.includes(String(launch.state))
    );
  }
  private async inspect(receipt: LaunchReceipt): Promise<NativeInspection> {
    return this.deps.requestGateway(RPC.INSPECT, {
      sessionKey: receipt.sessionKey,
      nativeSessionId: receipt.nativeSessionId,
    });
  }
  private async cleanupIdle(receipt: LaunchReceipt, neverSubmitted: boolean): Promise<boolean> {
    if (!(await this.idle(receipt.sessionId))) return false;
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

  async register(input: {
    sessionId: string;
    clientTurnId: string;
    prompt: string;
    assertCurrent?: () => void;
  }): Promise<LaunchReceipt | undefined> {
    const selected = recognizeAgentTeamMode(input.prompt);
    if (!selected) return;
    const nativePrompt = normalizeAgentTeamLaunchText(input.prompt);
    if (nativePrompt === undefined) throw new Error('teamLaunchContractUnavailable');
    if (!id(input.clientTurnId)) throw new Error('teamLaunchUnconfirmed');
    input.assertCurrent?.();
    const source = this.source(input.sessionId);
    const mode: Mode = selected === AGENT_TEAM_MODE.GROUP ? 'discussion' : 'collaboration';
    const digest = createHash('sha256').update(nativePrompt).digest('hex');
    const previous = this.load(input.sessionId);
    if (previous && previous.receipt.state !== 'released') {
      if (
        previous.receipt.clientTurnId === input.clientTurnId &&
        previous.receipt.promptSha256 === digest &&
        previous.receipt.mode === mode &&
        previous.receipt.registerAcknowledged &&
        !['unknown', 'cancelled'].includes(previous.receipt.state)
      )
        return previous.receipt;
      throw new Error('teamLaunchUnconfirmed');
    }
    if (
      previous?.receipt.clientTurnId === input.clientTurnId ||
      this.preparing.has(input.sessionId)
    )
      throw new Error('teamLaunchUnconfirmed');
    const token = this.cancellations.get(input.sessionId) ?? 0;
    this.preparing.set(input.sessionId, { clientTurnId: input.clientTurnId, token });
    const assertCurrent = () => {
      input.assertCurrent?.();
      const current = this.source(input.sessionId);
      if (
        (this.cancellations.get(input.sessionId) ?? 0) !== token ||
        current.agentId !== source.agentId ||
        current.cwd !== source.cwd ||
        current.permissionMode !== source.permissionMode ||
        current.nativeSessionKey !== source.nativeSessionKey
      )
        throw new Error('teamLaunchUnconfirmed');
    };
    let pending: LaunchReceipt | undefined;
    try {
      assertCurrent();
      if (!(await this.idle(input.sessionId))) throw new Error('teamFeatureBusy');
      assertCurrent();
      const prepared = await this.deps.getRouter().prepareSession(input.sessionId);
      assertCurrent();
      if (
        prepared.sessionKey !==
          (source.nativeSessionKey ?? buildCoworkSessionKey(source.id, source.agentId)) ||
        !id(prepared.gatewaySessionId)
      )
        throw new Error('teamLaunchUnconfirmed');
      const described = await this.deps.requestGateway<{ session?: Record<string, unknown> }>(
        'sessions.describe',
        { key: prepared.sessionKey },
      );
      assertCurrent();
      const native = described.session;
      if (
        !native ||
        native.sessionId !== prepared.gatewaySessionId ||
        native.goal != null ||
        native.permissionMode === 'read-only'
      )
        throw new Error('teamLaunchContractUnavailable');
      const plan = Array.isArray(native.pluginExtensions)
        ? native.pluginExtensions.find(
            value =>
              record(value) &&
              value.pluginId === OpenClawExtensionId.PLAN_MODE &&
              value.namespace === 'state',
          )
        : undefined;
      if (
        record(plan) &&
        (parsePlanModeState(plan.value).enabled ||
          (record(plan.value) && plan.value.awaitingReview))
      )
        throw new Error('teamLaunchContractUnavailable');
      const inspection = await this.deps.requestGateway<NativeInspection>(RPC.INSPECT, {
        sessionKey: prepared.sessionKey,
        nativeSessionId: prepared.gatewaySessionId,
      });
      assertCurrent();
      if (
        !Number.isSafeInteger(inspection.generation) ||
        Number(inspection.generation) < 0 ||
        !['absent', 'released'].includes(String(inspection.state))
      )
        throw new Error('teamLaunchUnconfirmed');
      if (!(await this.idle(input.sessionId))) throw new Error('teamFeatureBusy');
      assertCurrent();
      pending = {
        version: 1,
        sessionId: source.id,
        sessionKey: prepared.sessionKey,
        nativeSessionId: prepared.gatewaySessionId,
        clientTurnId: input.clientTurnId,
        promptSha256: digest,
        mode,
        state: 'pending',
        expectedGeneration: Number(inspection.generation),
        generation: Number(inspection.generation),
        localGeneration: token,
        registerAcknowledged: false,
        submissionStarted: false,
        wholeSettled: false,
        cancelRequested: false,
        abandonRequested: false,
        releaseRequested: false,
      };
      if (!this.write(pending, previous)) throw new Error('teamLaunchUnconfirmed');
      assertCurrent();
      const registered = await this.deps.requestGateway<Record<string, unknown>>(RPC.REGISTER, {
        ...this.params(pending),
        promptSha256: digest,
        mode,
        expectedGeneration: pending.expectedGeneration,
      });
      assertCurrent();
      if (
        registered.state !== 'pending' ||
        registered.nativeSessionId !== pending.nativeSessionId ||
        !(registered.lifecycleRevision === null || id(registered.lifecycleRevision)) ||
        registered.generation !== pending.expectedGeneration + 1
      )
        throw new Error('teamLaunchUnconfirmed');
      return this.update(pending, {
        registerAcknowledged: true,
        generation: Number(registered.generation),
        lifecycleRevision: registered.lifecycleRevision as string | null,
      });
    } catch (error) {
      if (pending) {
        try {
          this.update(pending, { state: 'unknown' });
        } catch {
          /* Stop or a replaced operation owns its newer receipt. */
        }
      }
      throw error;
    } finally {
      if (this.preparing.get(input.sessionId)?.token === token)
        this.preparing.delete(input.sessionId);
    }
  }

  /** This local CAS records a send boundary; it grants no tool or peer authority. */
  markSubmissionStarted(sessionId: string, clientTurnId: string): void {
    const loaded = this.load(sessionId);
    if (!loaded) return;
    const receipt = loaded.receipt;
    if (
      receipt.clientTurnId !== clientTurnId ||
      !receipt.registerAcknowledged ||
      receipt.cancelRequested ||
      !['pending', 'verified', 'attempted', 'launched'].includes(receipt.state)
    )
      throw new Error('teamLaunchUnconfirmed');
    this.update(receipt, { submissionStarted: true });
  }

  /**
   * The owning sender must have irrevocably closed its send continuation before
   * calling this. Empty history alone cannot prove that a late send is impossible.
   * Native abandon independently requires exact input absence and dispatcher idle.
   */
  async abortBeforeSend(sessionId: string, clientTurnId: string): Promise<boolean> {
    const loaded = this.load(sessionId);
    if (!loaded) return true;
    const receipt = loaded.receipt;
    if (receipt.clientTurnId !== clientTurnId) return false;
    if (receipt.state === 'released') return true;
    const timing = this.deps.getStore().getSessionRunByClientTurnId(clientTurnId);
    if (
      receipt.wholeSettled ||
      receipt.state === 'launched' ||
      (timing?.sessionId === sessionId &&
        (timing.acceptedAt !== undefined || timing.rootRunId !== undefined))
    )
      return false;
    this.update(receipt, { submissionStarted: false });
    await this.cancel(sessionId, clientTurnId);
    return this.load(sessionId)?.receipt.state === 'released';
  }

  observeExecution(payload: unknown): void {
    if (
      !record(payload) ||
      payload.stream !== 'lifecycle' ||
      !id(payload.sessionKey) ||
      !id(payload.runId) ||
      !record(payload.data) ||
      payload.data.executionSettled !== true ||
      !['end', 'error'].includes(String(payload.data.phase))
    )
      return;
    const rows = this.deps
      .getDatabase()
      .prepare('SELECT key,value FROM kv WHERE key LIKE ?')
      .all(PREFIX + '%') as Array<{ key: string; value: string }>;
    for (const row of rows) {
      try {
        const receipt = parseReceipt(JSON.parse(row.value), row.key.slice(PREFIX.length));
        if (
          receipt.state !== 'released' &&
          receipt.sessionKey === payload.sessionKey &&
          receipt.clientTurnId === payload.runId &&
          payload.sessionId === receipt.nativeSessionId
        )
          this.update(receipt, { wholeSettled: true });
      } catch {
        /* Unreadable metadata cannot become terminal evidence. */
      }
    }
  }

  async confirm(input: {
    sessionKey: string;
    sourceRunId: string;
    mode: Mode;
    receiptId: string;
  }): Promise<void> {
    const session = this.deps.getStore().getSessionByNativeKey(input.sessionKey);
    // Managed source keys are also valid before a native-key mapping has been saved.
    const sessionId = session?.id ?? input.sessionKey.split(':').at(-1);
    if (!sessionId) return;
    const loaded = this.load(sessionId);
    if (!loaded) return;
    const receipt = loaded.receipt;
    const timing = this.deps.getStore().getSessionRunByClientTurnId(receipt.clientTurnId);
    if (
      receipt.sessionKey !== input.sessionKey ||
      receipt.mode !== input.mode ||
      !id(input.receiptId) ||
      (input.sourceRunId !== receipt.clientTurnId &&
        !(timing?.sessionId === receipt.sessionId && timing.rootRunId === input.sourceRunId)) ||
      !receipt.registerAcknowledged ||
      receipt.cancelRequested ||
      ['unknown', 'cancelled', 'released'].includes(receipt.state) ||
      receipt.confirmReceiptId
    )
      return;
    const pending = this.update(receipt, { confirmReceiptId: input.receiptId });
    try {
      const result = await this.deps.requestGateway<{ state?: unknown }>(RPC.CONFIRM, {
        ...this.params(pending),
        mode: input.mode,
        receiptId: input.receiptId,
      });
      if (result.state !== 'launched') throw new Error('teamLaunchUnconfirmed');
      this.update(pending, { state: 'launched' });
    } catch {
      try {
        this.update(pending, { state: 'unknown' });
      } catch {
        /* Stop wins. */
      }
    }
  }

  async cancel(sessionId: string, expectedClientTurnId?: string): Promise<void> {
    const loaded = this.load(sessionId);
    const preparing = this.preparing.get(sessionId);
    const currentClientTurnId =
      preparing?.clientTurnId ??
      (loaded?.receipt.state !== 'released' ? loaded?.receipt.clientTurnId : undefined);
    if (expectedClientTurnId && currentClientTurnId !== expectedClientTurnId) return;
    this.cancellations.set(sessionId, (this.cancellations.get(sessionId) ?? 0) + 1);
    if (!loaded || loaded.receipt.state === 'released') return;
    const receipt = loaded.receipt;
    const cancelled = {
      ...receipt,
      localGeneration: receipt.localGeneration + 1,
      state: 'cancelled' as const,
      cancelRequested: true,
    };
    if (!this.write(cancelled, loaded)) throw new Error('teamLaunchUnconfirmed');
    if (!receipt.cancelRequested) {
      try {
        const result = await this.deps.requestGateway<{ state?: unknown }>(
          RPC.CANCEL,
          this.params(cancelled),
        );
        if (result.state !== 'cancelled' && result.state !== 'released')
          throw new Error('teamLaunchUnconfirmed');
        this.update(cancelled, { state: result.state });
      } catch {
        try {
          this.update(cancelled, { state: 'unknown' });
        } catch {
          /* Another Stop owns the receipt. */
        }
      }
    }
    if (!cancelled.submissionStarted) await this.releaseIfSettled(sessionId);
  }

  /** No elapsed-time or product status inference: exact native identity plus whole-run and cleanup evidence. */
  async releaseIfSettled(sessionId: string): Promise<boolean> {
    const loaded = this.load(sessionId);
    if (!loaded || loaded.receipt.state === 'released') return true;
    if (this.preparing.has(sessionId) || this.reconciling.has(sessionId)) return false;
    this.reconciling.add(sessionId);
    let receipt = loaded.receipt;
    try {
      const inspected = await this.inspect(receipt);
      this.current(receipt);
      if (this.matches(receipt, inspected)) {
        receipt = this.update(receipt, {
          lifecycleRevision: inspected.launch.lifecycleRevision as string | null,
          generation: Number(inspected.generation),
          ...(inspected.wholeSettled === true ? { wholeSettled: true } : {}),
        });
        if (inspected.launch.state === 'released') {
          this.update(receipt, { state: 'released' });
          return true;
        }
      } else if (!(
        inspected.state === 'absent' && inspected.generation === receipt.expectedGeneration
      ))
        return false;
      if (!(await this.cleanupIdle(receipt, !receipt.submissionStarted && !receipt.wholeSettled)))
        return false;
      this.current(receipt);
      if (!receipt.submissionStarted && !receipt.wholeSettled && !receipt.abandonRequested) {
        if (
          this.matches(receipt, inspected) &&
          !['pending', 'cancelled'].includes(String(inspected.launch.state))
        )
          return false;
        receipt = this.update(receipt, { abandonRequested: true });
        const result = await this.deps.requestGateway<{ state?: unknown }>(RPC.ABANDON, {
          ...this.params(receipt),
          neverSubmitted: true,
          expectedGeneration: receipt.expectedGeneration,
          promptSha256: receipt.promptSha256,
          mode: receipt.mode,
          ...(receipt.lifecycleRevision !== undefined
            ? { lifecycleRevision: receipt.lifecycleRevision }
            : {}),
        });
        if (result.state !== 'released') throw new Error('teamLaunchUnconfirmed');
        this.update(receipt, { state: 'released' });
        return true;
      }
      if (
        !this.matches(receipt, inspected) ||
        inspected.wholeSettled !== true ||
        !receipt.wholeSettled ||
        receipt.releaseRequested
      )
        return false;
      receipt = this.update(receipt, { releaseRequested: true });
      const result = await this.deps.requestGateway<{ state?: unknown }>(RPC.RELEASE, {
        ...this.params(receipt),
        executionSettled: true,
        dispatchCleanupComplete: true,
      });
      if (result.state !== 'released') throw new Error('teamLaunchUnconfirmed');
      this.update(receipt, { state: 'released' });
      return true;
    } catch {
      try {
        this.update(receipt, { state: 'unknown' });
      } catch {
        /* A cancellation/replacement owns current state. */
      }
      return false;
    } finally {
      this.reconciling.delete(sessionId);
    }
  }
}
