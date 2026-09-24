import { app } from 'electron';

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import { coworkLog } from '../../cowork/coworkLogger';
import { GoalContinuationCoordinator } from '../../openclaw/goals/goalContinuationCoordinator';
import {
  OpenClawEngineManager,
  type OpenClawGatewayConnectionInfo,
} from '../../openclaw/runtime/openclawEngineManager';
import {
  GATEWAY_READY_TIMEOUT_MS,
  OPENCLAW_GATEWAY_TOOL_EVENTS_CAP,
  waitWithTimeout,
} from '../gateway/helpers';
import type {
  GatewayClientCtor,
  GatewayClientLike,
  GatewayEventFrame,
  SessionTurn,
} from '../gateway/types';
import {
  AGENT_ACTIVITY_ALIVE_WINDOW_MS,
  AUTOMATION_PERMISSION_POLICY_ID,
  GATEWAY_CONNECT_RETRY_DELAYS,
  GATEWAY_RECONNECT_DELAYS,
  TICK_TIMEOUT_MS,
  TICK_WATCHDOG_INTERVAL_MS,
} from './runtimeAdapterSupport';
export interface RuntimeGatewayConnectionContext {
  gatewayClient: GatewayClientLike | null;
  readonly ensureGatewayClientReady: () => Promise<void>;
  automationPermissionVerifiedGeneration: number;
  gatewayClientGeneration: number;
  readonly requireGatewayClient: () => GatewayClientLike;
  readonly stopGatewayClient: () => void;
  gatewayReconnectAttempt: number;
  readonly scheduleGatewayReconnect: () => void;
  readonly ensureAutomationPermissionPolicyReady: () => Promise<void>;
  gatewayClientInitLock: Promise<void> | null;
  readonly _ensureGatewayClientReadyImpl: () => Promise<void>;
  readonly engineManager: OpenClawEngineManager;
  gatewayClientVersion: string | null;
  gatewayClientEntryPath: string | null;
  gatewayReadyPromise: Promise<void> | null;
  readonly createGatewayClient: (connection: OpenClawGatewayConnectionInfo) => Promise<void>;
  readonly loadGatewayClientCtor: (clientEntryPath: string) => Promise<GatewayClientCtor>;
  pendingGatewayClient: GatewayClientLike | null;
  readonly intentionallyStoppedGatewayClients: WeakSet<object>;
  readonly emit: (eventName: string | symbol, ...args: unknown[]) => boolean;
  lastTickTimestamp: number;
  readonly startTickWatchdog: () => void;
  readonly handleGatewayReady: (generation: number) => Promise<void>;
  readonly reconcilePendingApprovals: (expectedGeneration?: number) => Promise<void>;
  readonly reconcilePendingAskUserInteractions: (generation: number) => Promise<void>;
  gatewayStoppingIntentionally: boolean;
  readonly activeTurns: Map<string, SessionTurn>;
  readonly disconnectedSessionIds: Set<string>;
  readonly cleanupGatewayClientState: () => void;
  readonly handleGatewayEvent: (event: GatewayEventFrame) => void;
  readonly goalContinuationCoordinator: GoalContinuationCoordinator;
  readonly cancelGoalRecovery: () => void;
  readonly dismissAllAskUserInteractions: () => void;
  readonly cancelGatewayReconnect: () => void;
  readonly stopTickWatchdog: () => void;
  readonly invalidateRuntimeSessionSnapshot: () => void;
  readonly stoppedSessions: Map<string, number>;
  readonly clearAllCompactionInFlight: () => void;
  lastAgentActivityTimestamp: number;
  readonly subscribeGatewaySessions: () => Promise<void>;
  readonly recoverActiveGoals: (
    generation: number,
    options?: { stopGoalsCreatedBeforeMs?: number },
  ) => Promise<void>;
  readonly initialGatewayGoalRecoveryPending: boolean;
  readonly appStartedAtMs: number;
  tickWatchdogTimer: NodeJS.Timeout | null;
  readonly checkTickHealth: () => void;
  readonly attemptGatewayReconnect: () => Promise<void>;
  gatewayReconnectTimer: NodeJS.Timeout | null;
  readonly connectGatewayIfNeeded: () => Promise<void>;
}

export async function connectGatewayIfNeeded(this: RuntimeGatewayConnectionContext): Promise<void> {
  if (this.gatewayClient) return;
  await this.ensureGatewayClientReady();
}

export async function ensureAutomationPermissionPolicyReady(
  this: RuntimeGatewayConnectionContext,
): Promise<void> {
  if (this.automationPermissionVerifiedGeneration === this.gatewayClientGeneration) return;
  const generation = this.gatewayClientGeneration;
  const client = this.requireGatewayClient();
  const result = await client.request<{ loaded?: unknown; policyId?: unknown }>(
    'automationPermission.info',
  );
  if (result.loaded !== true || result.policyId !== AUTOMATION_PERMISSION_POLICY_ID) {
    throw new Error('OpenClaw automation permission policy is unavailable.');
  }
  if (generation !== this.gatewayClientGeneration || client !== this.gatewayClient) {
    throw new Error('OpenClaw Gateway connection changed');
  }
  this.automationPermissionVerifiedGeneration = generation;
}

export async function reconnectGateway(this: RuntimeGatewayConnectionContext): Promise<void> {
  this.stopGatewayClient();
  try {
    await this.ensureGatewayClientReady();
    this.gatewayReconnectAttempt = 0;
  } catch (error) {
    this.scheduleGatewayReconnect();
    throw error;
  }
}

export function disconnectGatewayClient(this: RuntimeGatewayConnectionContext): void {
  this.stopGatewayClient();
}

export async function ensureGatewayClientReady(
  this: RuntimeGatewayConnectionContext,
): Promise<void> {
  if (this.gatewayClient) {
    await this.ensureAutomationPermissionPolicyReady();
    return;
  }

  if (this.gatewayClientInitLock) {
    await this.gatewayClientInitLock;
    await this.ensureAutomationPermissionPolicyReady();
    return;
  }
  this.gatewayClientInitLock = this._ensureGatewayClientReadyImpl();
  try {
    await this.gatewayClientInitLock;
    await this.ensureAutomationPermissionPolicyReady();
  } finally {
    this.gatewayClientInitLock = null;
  }
}

export async function _ensureGatewayClientReadyImpl(
  this: RuntimeGatewayConnectionContext,
): Promise<void> {
  const engineStatus = await this.engineManager.startGateway();
  if (engineStatus.phase !== 'running') {
    throw new Error(engineStatus.message || 'OpenClaw engine is not running.');
  }

  const connection = this.engineManager.getGatewayConnectionInfo();
  const missing: string[] = [];
  if (!connection.url) missing.push('url');
  if (!connection.token) missing.push('token');
  if (!connection.version) missing.push('version');
  if (!connection.clientEntryPath) missing.push('clientEntryPath');
  if (missing.length > 0) {
    throw new Error(
      `OpenClaw gateway connection info is incomplete (missing: ${missing.join(', ')})`,
    );
  }

  const needsNewClient =
    !this.gatewayClient ||
    this.gatewayClientVersion !== connection.version ||
    this.gatewayClientEntryPath !== connection.clientEntryPath;

  if (!needsNewClient && this.gatewayReadyPromise) {
    await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
    return;
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < GATEWAY_CONNECT_RETRY_DELAYS.length; attempt++) {
    this.stopGatewayClient();
    try {
      await this.createGatewayClient(connection);
      if (this.gatewayReadyPromise) {
        await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
      }
      return;
    } catch (error) {
      lastError = error;
      const delay = GATEWAY_CONNECT_RETRY_DELAYS[attempt];
      if (attempt < GATEWAY_CONNECT_RETRY_DELAYS.length - 1) {
        coworkLog(
          'WARN',
          'OpenClawRuntime',
          `Gateway client handshake failed; retrying in ${delay}ms`,
          { error: String(error) },
        );
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function createGatewayClient(
  this: RuntimeGatewayConnectionContext,
  connection: OpenClawGatewayConnectionInfo,
): Promise<void> {
  const generation = this.gatewayClientGeneration;
  const clientEntryPath = connection.clientEntryPath;
  if (!clientEntryPath) throw new Error('Gateway client entry path is not available');
  const GatewayClient = await this.loadGatewayClientCtor(clientEntryPath);
  if (generation !== this.gatewayClientGeneration) {
    throw new Error('Gateway client initialization was superseded');
  }

  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  let settled = false;

  this.gatewayReadyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const settleResolve = () => {
    if (settled) return;
    settled = true;
    resolveReady?.();
  };
  const settleReject = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectReady?.(error);
  };

  const client = new GatewayClient({
    url: connection.url,
    token: connection.token,
    clientDisplayName: PRODUCT_NAME,
    clientVersion: app.getVersion(),
    mode: 'backend',
    caps: [OPENCLAW_GATEWAY_TOOL_EVENTS_CAP],
    role: 'operator',
    scopes: [
      'operator.admin',
      'operator.read',
      'operator.write',
      'operator.approvals',
      'operator.questions',
    ],
    // JustDo authenticates this loopback backend client with the managed
    // gateway token. Avoid OpenClaw creating a second device identity under
    // the Electron main process's default ~/.openclaw state directory.
    deviceIdentity: null,
    onHelloOk: () => {
      const isExpectedClient =
        generation === this.gatewayClientGeneration &&
        this.pendingGatewayClient === client &&
        !this.intentionallyStoppedGatewayClients.has(client);
      if (!isExpectedClient) {
        this.intentionallyStoppedGatewayClients.add(client);
        client.stop();
        return;
      }
      this.gatewayClient = client;
      this.pendingGatewayClient = null;
      this.gatewayClientVersion = connection.version;
      this.gatewayClientEntryPath = connection.clientEntryPath;
      settleResolve();
      // Native plugin change events cannot arrive while the Gateway is offline.
      // Invalidate the Workboard once the replacement client is actually usable
      // so its renderer clears stale disconnect errors and reloads canonical data.
      this.emit('workboardChanged', {});
      this.lastTickTimestamp = Date.now();
      this.startTickWatchdog();
      void this.handleGatewayReady(generation);
      void this.reconcilePendingApprovals(generation);
      void this.reconcilePendingAskUserInteractions(generation);
    },
    onConnectError: (error: Error) => settleReject(error),
    onClose: (_code: number, reason: string) => {
      const isCurrentClient = this.gatewayClient === client || this.pendingGatewayClient === client;
      if (!isCurrentClient || this.intentionallyStoppedGatewayClients.has(client)) {
        return;
      }
      if (!settled) {
        this.pendingGatewayClient = null;
        settleReject(new Error(reason || 'OpenClaw gateway disconnected before handshake'));
        if (!this.gatewayStoppingIntentionally) {
          this.scheduleGatewayReconnect();
        }
        return;
      }
      if (this.gatewayStoppingIntentionally) return;

      const disconnectedError = new Error(reason || 'OpenClaw gateway client disconnected');
      for (const sessionId of this.activeTurns.keys()) {
        // Transport loss does not prove that the Gateway run failed.
        this.disconnectedSessionIds.add(sessionId);
      }
      // Connection is already closed — don't call client.stop() which would
      // reject all pending requests with "gateway client stopped" noise.
      // Just clean up internal state and schedule reconnect.
      this.cleanupGatewayClientState();
      this.gatewayReadyPromise = Promise.reject(disconnectedError);
      this.gatewayReadyPromise.catch(() => {});
      this.scheduleGatewayReconnect();
    },
    onEvent: (event: GatewayEventFrame) => this.handleGatewayEvent(event),
  });

  this.pendingGatewayClient = client;
  client.start();
}

export function stopGatewayClient(this: RuntimeGatewayConnectionContext): void {
  this.goalContinuationCoordinator.clear();
  this.cancelGoalRecovery();
  this.dismissAllAskUserInteractions();
  this.gatewayClientGeneration++;
  this.gatewayStoppingIntentionally = true;
  this.cancelGatewayReconnect();
  this.stopTickWatchdog();
  const clientToStop = this.gatewayClient ?? this.pendingGatewayClient;
  if (clientToStop) {
    this.intentionallyStoppedGatewayClients.add(clientToStop);
  }
  try {
    clientToStop?.stop();
  } catch (error) {
    coworkLog('WARN', 'OpenClawRuntime', 'Failed to stop gateway client', {
      error: String(error),
    });
  }
  this.gatewayClient = null;
  this.pendingGatewayClient = null;
  this.gatewayClientVersion = null;
  this.gatewayClientEntryPath = null;
  this.gatewayReadyPromise = null;
  this.invalidateRuntimeSessionSnapshot();
  this.stoppedSessions.clear();
  this.clearAllCompactionInFlight();
  this.lastTickTimestamp = 0;
  this.lastAgentActivityTimestamp = 0;
  this.gatewayStoppingIntentionally = false;
}

export async function subscribeGatewaySessions(
  this: RuntimeGatewayConnectionContext,
): Promise<void> {
  const client = this.gatewayClient;
  if (!client) return;
  try {
    await client.request('sessions.subscribe', {});
  } catch (error) {
    coworkLog('WARN', 'OpenClawRuntime', 'Failed to subscribe to Gateway session events', {
      error: String(error),
    });
  }
}

export async function handleGatewayReady(
  this: RuntimeGatewayConnectionContext,
  generation: number,
): Promise<void> {
  await this.subscribeGatewaySessions();
  if (generation === this.gatewayClientGeneration) this.emit('gatewayReady');
  await this.recoverActiveGoals(generation, {
    stopGoalsCreatedBeforeMs: this.initialGatewayGoalRecoveryPending
      ? this.appStartedAtMs
      : undefined,
  });
}

export function cleanupGatewayClientState(this: RuntimeGatewayConnectionContext): void {
  this.goalContinuationCoordinator.clear();
  this.cancelGoalRecovery();
  this.dismissAllAskUserInteractions();
  this.cancelGatewayReconnect();
  this.stopTickWatchdog();
  this.gatewayClient = null;
  this.pendingGatewayClient = null;
  this.gatewayClientVersion = null;
  this.gatewayClientEntryPath = null;
  this.gatewayReadyPromise = null;
  this.invalidateRuntimeSessionSnapshot();
  this.stoppedSessions.clear();
  this.clearAllCompactionInFlight();
  this.lastTickTimestamp = 0;
  this.lastAgentActivityTimestamp = 0;
}

export async function loadGatewayClientCtor(
  this: RuntimeGatewayConnectionContext,
  clientEntryPath: string,
): Promise<GatewayClientCtor> {
  const loaded = require(clientEntryPath) as Record<string, unknown>;
  const direct = loaded.GatewayClient;
  if (typeof direct === 'function') return direct as GatewayClientCtor;

  for (const candidate of Object.values(loaded)) {
    if (typeof candidate !== 'function') continue;
    const maybeCtor = candidate as {
      name?: string;
      prototype?: { start?: unknown; stop?: unknown; request?: unknown };
    };
    if (maybeCtor.name === 'GatewayClient') return candidate as GatewayClientCtor;
    const proto = maybeCtor.prototype;
    if (
      proto &&
      typeof proto.start === 'function' &&
      typeof proto.stop === 'function' &&
      typeof proto.request === 'function'
    ) {
      return candidate as GatewayClientCtor;
    }
  }

  throw new Error(`Invalid OpenClaw gateway client module: ${clientEntryPath}`);
}

export function startTickWatchdog(this: RuntimeGatewayConnectionContext): void {
  this.stopTickWatchdog();
  this.tickWatchdogTimer = setInterval(() => this.checkTickHealth(), TICK_WATCHDOG_INTERVAL_MS);
}

export function stopTickWatchdog(this: RuntimeGatewayConnectionContext): void {
  if (this.tickWatchdogTimer) {
    clearInterval(this.tickWatchdogTimer);
    this.tickWatchdogTimer = null;
  }
}

export function checkTickHealth(this: RuntimeGatewayConnectionContext): void {
  if (this.lastTickTimestamp <= 0) return;
  const now = Date.now();
  if (this.activeTurns.size > 0) {
    this.lastTickTimestamp = now;
    return;
  }
  if (now - this.lastAgentActivityTimestamp <= AGENT_ACTIVITY_ALIVE_WINDOW_MS) {
    this.lastTickTimestamp = now;
    return;
  }
  if (now - this.lastTickTimestamp <= TICK_TIMEOUT_MS) return;
  this.cancelGatewayReconnect();
  this.stopGatewayClient();
  this.gatewayReconnectAttempt = 0;
  this.scheduleGatewayReconnect();
}

export function onSystemResume(this: RuntimeGatewayConnectionContext): void {
  this.cancelGatewayReconnect();
  this.gatewayReconnectAttempt = 0;
  if (!this.gatewayClient) {
    void this.attemptGatewayReconnect();
  } else {
    this.checkTickHealth();
  }
}

export function cancelGatewayReconnect(this: RuntimeGatewayConnectionContext): void {
  if (this.gatewayReconnectTimer) {
    clearTimeout(this.gatewayReconnectTimer);
    this.gatewayReconnectTimer = null;
  }
}

export function scheduleGatewayReconnect(this: RuntimeGatewayConnectionContext): void {
  if (this.gatewayReconnectTimer) return;
  const delays = GATEWAY_RECONNECT_DELAYS;
  const delay = delays[Math.min(this.gatewayReconnectAttempt, delays.length - 1)];
  this.gatewayReconnectAttempt++;
  this.gatewayReconnectTimer = setTimeout(() => {
    this.gatewayReconnectTimer = null;
    void this.attemptGatewayReconnect();
  }, delay);
}

export async function attemptGatewayReconnect(
  this: RuntimeGatewayConnectionContext,
): Promise<void> {
  try {
    await this.connectGatewayIfNeeded();
    this.gatewayReconnectAttempt = 0;
  } catch {
    this.scheduleGatewayReconnect();
  }
}
