/**
 * Gateway tick heartbeat watchdog.
 *
 * Monitors the gateway WebSocket connection health by tracking tick events.
 * If no tick is received within the timeout window and no agent activity is
 * detected, triggers a reconnect.
 */

export interface WatchdogCallbacks {
  cancelGatewayReconnect(): void;
  stopGatewayClient(): void;
  scheduleGatewayReconnect(): void;
}

export class GatewayWatchdog {
  private lastTickTimestamp = 0;
  private lastAgentActivityTimestamp = 0;
  private tickWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly TICK_WATCHDOG_INTERVAL_MS = 60_000; // check every 60s
  private static readonly TICK_TIMEOUT_MS = 90_000; // 3 tick cycles (30s each) without response → dead
  /** Agent activity within this window proves connection is alive even without tick. */
  private static readonly AGENT_ACTIVITY_ALIVE_WINDOW_MS = 60_000; // 60s

  constructor(private readonly callbacks: WatchdogCallbacks) {}

  start(): void {
    this.stop();
    console.log('[TickWatchdog] started');
    this.tickWatchdogTimer = setInterval(() => {
      this.checkHealth();
    }, GatewayWatchdog.TICK_WATCHDOG_INTERVAL_MS);
  }

  stop(): void {
    if (this.tickWatchdogTimer) {
      clearInterval(this.tickWatchdogTimer);
      this.tickWatchdogTimer = null;
    }
  }

  recordTick(): void {
    this.lastTickTimestamp = Date.now();
  }

  recordAgentActivity(): void {
    this.lastAgentActivityTimestamp = Date.now();
  }

  reset(): void {
    this.lastTickTimestamp = 0;
    this.lastAgentActivityTimestamp = 0;
  }

  checkHealth(): void {
    if (this.lastTickTimestamp <= 0) return;
    const now = Date.now();
    const tickElapsed = now - this.lastTickTimestamp;
    const agentElapsed = now - this.lastAgentActivityTimestamp;

    // If we received agent events recently, the connection is alive even without tick.
    // This handles the case where tick events are dropped due to dropIfSlow during heavy activity.
    if (agentElapsed <= GatewayWatchdog.AGENT_ACTIVITY_ALIVE_WINDOW_MS) {
      // Connection is alive — update tick timestamp to prevent false timeout trigger
      this.lastTickTimestamp = now;
      console.log(
        `[TickWatchdog] tick missing for ${Math.round(tickElapsed / 1000)}s but agent activity detected (${Math.round(agentElapsed / 1000)}s ago) — connection is alive, suppressing reconnect`,
      );
      return;
    }

    if (tickElapsed <= GatewayWatchdog.TICK_TIMEOUT_MS) return;

    console.warn(
      `[TickWatchdog] no tick received for ${Math.round(tickElapsed / 1000)}s (threshold: ${GatewayWatchdog.TICK_TIMEOUT_MS / 1000}s) and no agent activity for ${Math.round(agentElapsed / 1000)}s — connection is likely dead, triggering reconnect`,
    );
    this.callbacks.cancelGatewayReconnect();
    this.callbacks.stopGatewayClient();
    // Reset reconnect attempt counter since we're starting fresh
    this.callbacks.scheduleGatewayReconnect();
  }
}
