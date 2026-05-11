/**
 * Gateway WebSocket connection manager.
 *
 * Manages the lifecycle of the OpenClaw gateway WebSocket connection:
 * - Connection establishment and handshake
 * - Auto-reconnect with exponential backoff
 * - Channel session polling
 * - Browser pre-warm
 * - Tick heartbeat watchdog (delegates to GatewayWatchdog)
 */

import { app, BrowserWindow } from 'electron';

import type {
  OpenClawChannelSessionSync,
} from '../../openclawChannelSessionSync';
import {
  isManagedSessionKey,
} from '../../openclawChannelSessionSync';
import {
  OpenClawEngineManager,
  type OpenClawGatewayConnectionInfo,
} from '../../openclawEngineManager';
import { GatewayWatchdog, type WatchdogCallbacks } from './watchdog';

const GATEWAY_READY_TIMEOUT_MS = 15_000;
const CHANNEL_SESSION_DISCOVERY_LIMIT = 200;

// Internal runtime context markers from OpenClaw
const INTERNAL_RUNTIME_CONTEXT_BEGIN = '<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>';

type GatewayEventFrame = {
  event: string;
  seq?: number;
  payload?: unknown;
};

export type GatewayClientLike = {
  start: () => void;
  stop: () => void;
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

type GatewayClientCtor = new (options: Record<string, unknown>) => GatewayClientLike;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
};

const waitWithTimeout = async (promise: Promise<void>, timeoutMs: number): Promise<void> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Gateway handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export interface ConnectionManagerCallbacks {
  handleGatewayEvent(event: GatewayEventFrame): void;
  rememberSessionKey(sessionId: string, sessionKey: string): void;
  resolveSessionIdBySessionKey(sessionKey: string): string | undefined;
  syncFullChannelHistory(sessionId: string, sessionKey: string): Promise<void>;
  incrementalChannelSync(sessionId: string, key: string): Promise<void>;
  getActiveTurns(): Map<string, unknown>;
  cleanupSessionTurn(sessionId: string): void;
  rejectTurn(sessionId: string, error: Error): void;
  updateSessionStatus(sessionId: string, status: string): void;
  emit(event: string, ...args: unknown[]): void;
  getChannelSessionSync(): OpenClawChannelSessionSync | null;
  getKnownChannelSessionIds(): Set<string>;
  getFullySyncedSessions(): Set<string>;
  getDeletedChannelKeys(): Set<string>;
  getHeartbeatSessionKeys(): Set<string>;
  getReCreatedChannelSessionIds(): Set<string>;
  getStoppedSessions(): Map<string, number>;
  /** sessionIdBySessionKey map for polling lookups */
  getSessionIdBySessionKey(): Map<string, string>;
  clearPendingMessageUpdateTimers(): void;
}

export class GatewayConnectionManager {
  private gatewayClient: GatewayClientLike | null = null;
  private gatewayClientVersion: string | null = null;
  private gatewayClientEntryPath: string | null = null;
  private pendingGatewayClient: GatewayClientLike | null = null;
  private gatewayReadyPromise: Promise<void> | null = null;
  private gatewayClientInitLock: Promise<void> | null = null;

  private gatewayReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private gatewayReconnectAttempt = 0;
  private gatewayStoppingIntentionally = false;

  private channelPollingTimer: ReturnType<typeof setInterval> | null = null;
  private browserPrewarmAttempted = false;

  private readonly watchdog: GatewayWatchdog;

  private static readonly GATEWAY_RECONNECT_MAX_ATTEMPTS = 10;
  private static readonly GATEWAY_RECONNECT_DELAYS = [2_000, 5_000, 10_000, 15_000, 30_000]; // ms
  private static readonly CHANNEL_POLL_INTERVAL_MS = 10_000;

  constructor(
    private readonly engineManager: OpenClawEngineManager,
    private readonly callbacks: ConnectionManagerCallbacks,
  ) {
    const watchdogCallbacks: WatchdogCallbacks = {
      cancelGatewayReconnect: () => this.cancelGatewayReconnect(),
      stopGatewayClient: () => this.stopGatewayClient(),
      scheduleGatewayReconnect: () => this.scheduleGatewayReconnectWithReset(),
    };
    this.watchdog = new GatewayWatchdog(watchdogCallbacks);
  }

  // ── Public API ──────────────────────────────────────────────

  getGatewayClient(): GatewayClientLike | null {
    return this.gatewayClient;
  }

  requireGatewayClient(): GatewayClientLike {
    if (!this.gatewayClient) {
      throw new Error('OpenClaw gateway client is unavailable.');
    }
    return this.gatewayClient;
  }

  async ensureReady(): Promise<void> {
    await this.ensureGatewayClientReady();
  }

  async connectGatewayIfNeeded(): Promise<void> {
    if (this.gatewayClient) {
      console.log('[ChannelSync] connectGatewayIfNeeded: gateway client already exists, skipping');
      return;
    }
    console.log('[ChannelSync] connectGatewayIfNeeded: no gateway client, initializing...');
    try {
      await this.ensureGatewayClientReady();
      console.log(
        '[ChannelSync] connectGatewayIfNeeded: gateway client ready, starting channel polling',
      );
      this.startChannelPolling();
    } catch (error) {
      console.error(
        '[ChannelSync] connectGatewayIfNeeded: failed to initialize gateway client:',
        error,
      );
      throw error;
    }
  }

  async reconnectGateway(): Promise<void> {
    console.log('[ChannelSync] reconnectGateway: tearing down old client and reconnecting...');
    this.stopGatewayClient();
    try {
      await this.ensureGatewayClientReady();
      console.log('[ChannelSync] reconnectGateway: gateway client ready, starting channel polling');
      this.startChannelPolling();
    } catch (error) {
      console.error('[ChannelSync] reconnectGateway: failed to initialize gateway client:', error);
      throw error;
    }
  }

  disconnectGatewayClient(): void {
    console.log('[ChannelSync] disconnectGatewayClient: explicitly tearing down gateway client');
    this.stopGatewayClient();
  }

  startChannelPolling(): void {
    if (!this.callbacks.getChannelSessionSync()) {
      console.warn('[ChannelSync] startChannelPolling: no channelSessionSync set, skipping');
      return;
    }
    if (this.channelPollingTimer) {
      console.log('[ChannelSync] startChannelPolling: already running, skipping');
      return;
    }

    console.log('[ChannelSync] startChannelPolling: starting periodic channel session discovery');
    void this.pollChannelSessions();
    this.channelPollingTimer = setInterval(() => {
      void this.pollChannelSessions();
    }, GatewayConnectionManager.CHANNEL_POLL_INTERVAL_MS);
  }

  stopChannelPolling(): void {
    if (this.channelPollingTimer) {
      clearInterval(this.channelPollingTimer);
      this.channelPollingTimer = null;
    }
  }

  onSystemResume(): void {
    console.log('[GatewayReconnect] system resumed from sleep');
    this.cancelGatewayReconnect();
    this.gatewayReconnectAttempt = 0;
    if (!this.gatewayClient) {
      void this.attemptGatewayReconnect();
    } else {
      this.watchdog.checkHealth();
    }
  }

  probeBrowserControlService(toolCallId: string, phase: string): void {
    const connection = this.engineManager.getGatewayConnectionInfo();
    if (!connection.port || !connection.token) {
      console.log(
        `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): no gateway connection info`,
      );
      return;
    }
    const browserControlPort = connection.port + 2;
    const token = connection.token;
    const probeStartTime = Date.now();
    console.log(
      `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): checking port ${browserControlPort} ...`,
    );

    const endpoints = [
      `http://127.0.0.1:${browserControlPort}/status`,
      `http://127.0.0.1:${browserControlPort}/`,
    ];
    for (const probeUrl of endpoints) {
      fetch(probeUrl, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })
        .then(async response => {
          const body = await response.text().catch(() => '');
          console.log(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → HTTP ${response.status} (${Date.now() - probeStartTime}ms) body=${body.slice(0, 500)}`,
          );
        })
        .catch(err => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(
            `[OpenClawRuntime] browser probe (${toolCallId}/${phase}): ${probeUrl} → FAILED (${Date.now() - probeStartTime}ms) error=${message}`,
          );
        });
    }
  }

  /** Record a tick event (called from handleGatewayEvent). */
  recordTick(): void {
    this.watchdog.recordTick();
  }

  /** Record agent activity (called from handleGatewayEvent). */
  recordAgentActivity(): void {
    this.watchdog.recordAgentActivity();
  }

  // ── Private: Connection Lifecycle ───────────────────────────

  private async ensureGatewayClientReady(): Promise<void> {
    if (this.gatewayClientInitLock) {
      await this.gatewayClientInitLock;
      return;
    }
    this.gatewayClientInitLock = this._ensureGatewayClientReadyImpl();
    try {
      await this.gatewayClientInitLock;
    } finally {
      this.gatewayClientInitLock = null;
    }
  }

  private async _ensureGatewayClientReadyImpl(): Promise<void> {
    console.log('[ChannelSync] ensureGatewayClientReady: starting engine gateway...');
    const engineStatus = await this.engineManager.startGateway();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: engine phase=',
      engineStatus.phase,
      'message=',
      engineStatus.message,
    );
    if (engineStatus.phase !== 'running') {
      const message = engineStatus.message || 'OpenClaw engine is not running.';
      throw new Error(message);
    }

    const connection = this.engineManager.getGatewayConnectionInfo();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: connection info — url=',
      connection.url ? '✓' : '✗',
      'token=',
      connection.token ? '✓' : '✗',
      'version=',
      connection.version,
      'clientEntryPath=',
      connection.clientEntryPath ? '✓' : '✗',
    );
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
    console.log(
      '[ChannelSync] ensureGatewayClientReady: needsNewClient=',
      needsNewClient,
      'hasExistingClient=',
      !!this.gatewayClient,
    );
    if (!needsNewClient && this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
      return;
    }

    this.stopGatewayClient();
    console.log(
      '[ChannelSync] ensureGatewayClientReady: creating gateway client, url=',
      connection.url,
    );
    await this.createGatewayClient(connection);
    console.log(
      '[ChannelSync] ensureGatewayClientReady: createGatewayClient returned, waiting for handshake...',
    );
    if (this.gatewayReadyPromise) {
      await waitWithTimeout(this.gatewayReadyPromise, GATEWAY_READY_TIMEOUT_MS);
    }
    console.log('[ChannelSync] ensureGatewayClientReady: gateway client created and ready');
  }

  private async createGatewayClient(connection: OpenClawGatewayConnectionInfo): Promise<void> {
    const clientEntryPath = connection.clientEntryPath;
    if (!clientEntryPath) {
      throw new Error('Gateway client entry path is not available');
    }
    const GatewayClient = await this.loadGatewayClientCtor(clientEntryPath);

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
      clientDisplayName: 'GucciAI',
      clientVersion: app.getVersion(),
      mode: 'backend',
      caps: ['tool-events'],
      role: 'operator',
      scopes: ['operator.admin'],
      onHelloOk: () => {
        console.log('[ChannelSync] GatewayClient: onHelloOk — handshake succeeded');
        this.gatewayClient = client;
        this.gatewayClientVersion = connection.version;
        this.gatewayClientEntryPath = connection.clientEntryPath;
        settleResolve();
        this.watchdog.recordTick();
        this.watchdog.start();
      },
      onConnectError: (error: Error) => {
        console.error('[ChannelSync] GatewayClient: onConnectError —', error.message);
        settleReject(error);
      },
      onClose: (_code: number, reason: string) => {
        console.log(
          '[ChannelSync] GatewayClient: onClose — code:',
          _code,
          'reason:',
          reason,
          'settled:',
          settled,
        );
        if (!settled) {
          this.pendingGatewayClient = null;
          settleReject(new Error(reason || 'OpenClaw gateway disconnected before handshake'));
          return;
        }

        if (this.gatewayStoppingIntentionally) {
          return;
        }

        console.warn('[OpenClawRuntime] gateway WS disconnected — code:', _code, 'reason:', reason);
        const disconnectedError = new Error(reason || 'OpenClaw gateway client disconnected');
        const activeTurns = this.callbacks.getActiveTurns();
        const activeSessionIds = Array.from(activeTurns.keys());
        activeSessionIds.forEach(sessionId => {
          this.callbacks.updateSessionStatus(sessionId, 'error');
          this.callbacks.emit('error', sessionId, disconnectedError.message);
          this.callbacks.cleanupSessionTurn(sessionId);
          this.callbacks.rejectTurn(sessionId, disconnectedError);
        });
        this.stopGatewayClient();
        this.gatewayReadyPromise = Promise.reject(disconnectedError);
        this.gatewayReadyPromise.catch(() => {
          // suppress unhandled rejection noise; auto-reconnect will re-establish
        });

        this.scheduleGatewayReconnect();
      },
      onEvent: (event: GatewayEventFrame) => {
        this.callbacks.handleGatewayEvent(event);
      },
    });

    this.pendingGatewayClient = client;
    client.start();
  }

  private stopGatewayClient(): void {
    this.gatewayStoppingIntentionally = true;
    this.stopChannelPolling();
    this.cancelGatewayReconnect();
    this.watchdog.stop();
    const clientToStop = this.gatewayClient ?? this.pendingGatewayClient;
    try {
      clientToStop?.stop();
    } catch (error) {
      console.warn('[OpenClawRuntime] Failed to stop gateway client:', error);
    }
    this.gatewayClient = null;
    this.pendingGatewayClient = null;
    this.gatewayClientVersion = null;
    this.gatewayClientEntryPath = null;
    this.gatewayReadyPromise = null;
    this.callbacks.getChannelSessionSync()?.clearCache();
    this.callbacks.getKnownChannelSessionIds().clear();
    this.callbacks.getHeartbeatSessionKeys().clear();
    this.callbacks.getStoppedSessions().clear();
    this.browserPrewarmAttempted = false;
    this.watchdog.reset();
    this.callbacks.clearPendingMessageUpdateTimers();
    this.gatewayStoppingIntentionally = false;
  }

  private cancelGatewayReconnect(): void {
    if (this.gatewayReconnectTimer) {
      clearTimeout(this.gatewayReconnectTimer);
      this.gatewayReconnectTimer = null;
    }
  }

  private scheduleGatewayReconnect(): void {
    if (this.gatewayReconnectAttempt >= GatewayConnectionManager.GATEWAY_RECONNECT_MAX_ATTEMPTS) {
      console.error(
        '[GatewayReconnect] max attempts reached (' +
          GatewayConnectionManager.GATEWAY_RECONNECT_MAX_ATTEMPTS +
          '), giving up. Restart the app to reconnect.',
      );
      return;
    }

    const delays = GatewayConnectionManager.GATEWAY_RECONNECT_DELAYS;
    const delay = delays[Math.min(this.gatewayReconnectAttempt, delays.length - 1)];
    this.gatewayReconnectAttempt++;

    console.log(
      `[GatewayReconnect] scheduling reconnect attempt ${this.gatewayReconnectAttempt}/${GatewayConnectionManager.GATEWAY_RECONNECT_MAX_ATTEMPTS} in ${delay}ms`,
    );

    this.gatewayReconnectTimer = setTimeout(() => {
      this.gatewayReconnectTimer = null;
      void this.attemptGatewayReconnect();
    }, delay);
  }

  /** Schedule reconnect after watchdog-triggered disconnect (resets attempt counter). */
  private scheduleGatewayReconnectWithReset(): void {
    this.gatewayReconnectAttempt = 0;
    this.scheduleGatewayReconnect();
  }

  private async attemptGatewayReconnect(): Promise<void> {
    console.log(
      `[GatewayReconnect] attempting reconnect (attempt ${this.gatewayReconnectAttempt})`,
    );
    try {
      await this.connectGatewayIfNeeded();
      console.log('[GatewayReconnect] reconnected successfully');
      this.gatewayReconnectAttempt = 0;
    } catch (error) {
      console.warn('[GatewayReconnect] reconnect failed:', error);
      this.scheduleGatewayReconnect();
    }
  }

  private async loadGatewayClientCtor(clientEntryPath: string): Promise<GatewayClientCtor> {
    const loaded = require(clientEntryPath) as Record<string, unknown>;
    const direct = loaded.GatewayClient;
    if (typeof direct === 'function') {
      return direct as GatewayClientCtor;
    }

    const exportedValues = Object.values(loaded);
    for (const candidate of exportedValues) {
      if (typeof candidate !== 'function') {
        continue;
      }
      const maybeCtor = candidate as {
        name?: string;
        prototype?: {
          start?: unknown;
          stop?: unknown;
          request?: unknown;
        };
      };
      if (maybeCtor.name === 'GatewayClient') {
        return candidate as GatewayClientCtor;
      }
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

    const exportKeysPreview = Object.keys(loaded).slice(0, 20).join(', ');
    throw new Error(
      `Invalid OpenClaw gateway client module: ${clientEntryPath} (exports: ${exportKeysPreview || 'none'})`,
    );
  }

  // ── Private: Channel Polling ────────────────────────────────

  private async pollChannelSessions(): Promise<void> {
    const channelSessionSync = this.callbacks.getChannelSessionSync();
    if (!this.gatewayClient || !channelSessionSync) {
      console.warn(
        '[ChannelSync] pollChannelSessions: skipped — gatewayClient:',
        !!this.gatewayClient,
        'channelSessionSync:',
        !!channelSessionSync,
      );
      return;
    }
    try {
      const params = { activeMinutes: 60, limit: CHANNEL_SESSION_DISCOVERY_LIMIT };
      const result = await this.gatewayClient.request('sessions.list', params);
      const sessions = (result as Record<string, unknown>)?.sessions;
      if (!Array.isArray(sessions)) {
        console.warn(
          '[ChannelSync] pollChannelSessions: sessions.list returned non-array sessions:',
          typeof sessions,
          'full result keys:',
          Object.keys(result as Record<string, unknown>),
        );
        return;
      }
      let hasNew = false;
      let channelCount = 0;
      const newSessionsToSync: Array<{ sessionId: string; sessionKey: string }> = [];
      for (const row of sessions) {
        const key = typeof row?.key === 'string' ? row.key : '';
        if (!key) continue;
        if (isRecord(row)) {
          const rowOrigin = (row as Record<string, unknown>).origin;
          if (isRecord(rowOrigin) && (rowOrigin as Record<string, unknown>).label === 'heartbeat') {
            this.callbacks.getHeartbeatSessionKeys().add(key);
            continue;
          }
        }
        const isChannel = channelSessionSync.isChannelSessionKey(key);
        if (!isChannel) continue;
        if (this.callbacks.getDeletedChannelKeys().has(key)) continue;
        if (!channelSessionSync.isCurrentBindingKey(key)) continue;
        channelCount++;
        const sessionId = channelSessionSync.resolveOrCreateSession(key);
        if (sessionId && !this.callbacks.getKnownChannelSessionIds().has(sessionId)) {
          this.callbacks.getKnownChannelSessionIds().add(sessionId);
          this.callbacks.rememberSessionKey(sessionId, key);
          hasNew = true;
          if (!this.callbacks.getFullySyncedSessions().has(sessionId)) {
            newSessionsToSync.push({ sessionId, sessionKey: key });
          }
        }
      }
      if (hasNew) {
        let notified = 0;
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('cowork:sessions:changed');
            notified++;
          }
        }
        console.log(
          '[ChannelSync] discovered',
          channelCount,
          'channel sessions, notified',
          notified,
          'windows',
        );
      }
      for (const { sessionId, sessionKey } of newSessionsToSync) {
        await this.callbacks.syncFullChannelHistory(sessionId, sessionKey);
      }

      if (channelCount > 0) {
        const syncedThisCycle = new Set<string>();
        for (const row of sessions) {
          const key = typeof row?.key === 'string' ? row.key : '';
          if (!key) continue;
          if (!channelSessionSync.isChannelSessionKey(key)) continue;
          if (this.callbacks.getDeletedChannelKeys().has(key)) continue;
          if (this.callbacks.getHeartbeatSessionKeys().has(key)) continue;
          if (!channelSessionSync.isCurrentBindingKey(key)) continue;
          const sessionId = this.callbacks.getSessionIdBySessionKey().get(key);
          if (!sessionId || !this.callbacks.getFullySyncedSessions().has(sessionId)) continue;
          if (syncedThisCycle.has(sessionId)) continue;
          syncedThisCycle.add(sessionId);
          if (this.callbacks.getActiveTurns().has(sessionId)) continue;
          try {
            await this.callbacks.incrementalChannelSync(sessionId, key);
          } catch (err) {
            console.warn('[ChannelSync] incremental sync failed for', key, err);
          }
        }
      }
    } catch (error) {
      console.error('[ChannelSync] pollChannelSessions: error during polling:', error);
    }
  }

  // ── Private: Browser Prewarm ────────────────────────────────

  private prewarmBrowserIfNeeded(connection: OpenClawGatewayConnectionInfo): void {
    if (this.browserPrewarmAttempted) return;
    if (!connection.port || !connection.token) return;
    this.browserPrewarmAttempted = true;

    const browserControlPort = connection.port + 2;
    const token = connection.token;
    console.log(
      `[OpenClawRuntime] browser pre-warm: gatewayPort=${connection.port}, browserControlPort=${browserControlPort}`,
    );
    void this.prewarmBrowserWithRetry(browserControlPort, token);
  }

  private async prewarmBrowserWithRetry(
    port: number,
    token: string,
    maxRetries = 5,
  ): Promise<void> {
    const url = `http://127.0.0.1:${port}/start?profile=openclaw`;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const startTime = Date.now();
      console.log(
        `[OpenClawRuntime] browser pre-warm attempt ${attempt}/${maxRetries} → POST http://127.0.0.1:${port}/start?profile=openclaw`,
      );

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(90_000),
        });
        const body = await response.text();
        if (response.ok) {
          console.log(
            `[OpenClawRuntime] browser pre-warm succeeded (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
          );
          return;
        }
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} returned HTTP ${response.status} (${Date.now() - startTime}ms): ${body.slice(0, 200)}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[OpenClawRuntime] browser pre-warm attempt ${attempt} failed (${Date.now() - startTime}ms): ${message}`,
        );
      }

      if (attempt < maxRetries) {
        const delayMs = Math.min(5000, 2000 * attempt);
        console.log(`[OpenClawRuntime] browser pre-warm retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    console.warn(
      '[OpenClawRuntime] browser pre-warm exhausted all retries (non-fatal, browser will start on first tool use)',
    );
  }
}
