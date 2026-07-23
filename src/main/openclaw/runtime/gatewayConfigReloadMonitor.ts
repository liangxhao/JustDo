export type GatewayConfigReloadOutcome = 'applied' | 'failed';

type ReloadRecord = {
  generation: number;
  changedPaths: string[];
  outcome: GatewayConfigReloadOutcome | null;
  restartAccepted: boolean;
};

export type GatewayConfigReloadKind = 'dynamic' | 'hot' | 'restart';

type ReloadRule = {
  prefix: string;
  kind: GatewayConfigReloadKind;
};

// Keep this ordered to match OpenClaw's first-match BASE_RELOAD_RULES followed
// by BASE_RELOAD_RULES_TAIL. More-specific rules must precede their parents.
const RELOAD_RULES: ReloadRule[] = [
  { prefix: 'gateway.remote', kind: 'dynamic' },
  { prefix: 'gateway.reload', kind: 'dynamic' },
  { prefix: 'gateway.channelHealthCheckMinutes', kind: 'hot' },
  { prefix: 'gateway.channelStaleEventThresholdMinutes', kind: 'hot' },
  { prefix: 'gateway.channelMaxRestartsPerHour', kind: 'hot' },
  { prefix: 'diagnostics.stuckSessionWarnMs', kind: 'dynamic' },
  { prefix: 'diagnostics.stuckSessionAbortMs', kind: 'dynamic' },
  { prefix: 'diagnostics.memoryPressureSnapshot', kind: 'hot' },
  { prefix: 'hooks.gmail', kind: 'hot' },
  { prefix: 'hooks', kind: 'hot' },
  { prefix: 'agents.defaults.heartbeat', kind: 'hot' },
  { prefix: 'agents.defaults.models', kind: 'hot' },
  { prefix: 'agents.defaults.model', kind: 'hot' },
  { prefix: 'models.pricing', kind: 'restart' },
  { prefix: 'models', kind: 'hot' },
  { prefix: 'auth.cooldowns', kind: 'hot' },
  { prefix: 'agents.list', kind: 'hot' },
  { prefix: 'agent.heartbeat', kind: 'hot' },
  { prefix: 'cron', kind: 'hot' },
  { prefix: 'mcp', kind: 'hot' },
  { prefix: 'plugins.load', kind: 'restart' },
  { prefix: 'plugins.installs', kind: 'restart' },
  { prefix: 'meta', kind: 'dynamic' },
  { prefix: 'identity', kind: 'dynamic' },
  { prefix: 'wizard', kind: 'dynamic' },
  { prefix: 'logging', kind: 'dynamic' },
  { prefix: 'agents', kind: 'dynamic' },
  { prefix: 'tools', kind: 'dynamic' },
  { prefix: 'bindings', kind: 'dynamic' },
  { prefix: 'audio', kind: 'dynamic' },
  { prefix: 'agent', kind: 'dynamic' },
  { prefix: 'routing', kind: 'dynamic' },
  { prefix: 'messages', kind: 'dynamic' },
  { prefix: 'session', kind: 'dynamic' },
  { prefix: 'talk', kind: 'dynamic' },
  { prefix: 'skills', kind: 'dynamic' },
  { prefix: 'secrets', kind: 'dynamic' },
  { prefix: 'plugins', kind: 'hot' },
  { prefix: 'tui', kind: 'dynamic' },
  { prefix: 'ui', kind: 'dynamic' },
  { prefix: 'gateway', kind: 'restart' },
  { prefix: 'discovery', kind: 'restart' },
];

const GATEWAY_RESTART_COMPLETION_TIMEOUT_MS = 10 * 60_000;

const matchesPrefix = (configPath: string, prefix: string): boolean =>
  configPath === prefix || configPath.startsWith(`${prefix}.`);

export const classifyGatewayConfigReloadPath = (
  configPath: string,
): GatewayConfigReloadKind => {
  if (/^plugins\.installs\..+\.(installedAt|resolvedAt)$/.test(configPath)) {
    return 'dynamic';
  }
  return (
    RELOAD_RULES.find(rule => matchesPrefix(configPath, rule.prefix))?.kind ?? 'restart'
  );
};

export const parseGatewayConfigReloadPaths = (line: string): string[] | null => {
  const match = line.match(/config change detected; evaluating reload \((.+)\)/);
  if (!match?.[1]) {
    return null;
  }
  return match[1]
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
};

const parseCompletionPaths = (line: string): string[] => {
  const match = line.match(/\(([^()]*)\)\s*$/);
  return match?.[1]
    ? match[1]
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
    : [];
};

export class GatewayConfigReloadMonitor {
  private generation = 0;
  private readonly records: ReloadRecord[] = [];
  private readonly listeners = new Set<() => void>();

  getGeneration(): number {
    return this.generation;
  }

  observeLine(line: string): void {
    const changedPaths = parseGatewayConfigReloadPaths(line);
    if (changedPaths) {
      const record: ReloadRecord = {
        generation: ++this.generation,
        changedPaths,
        outcome: changedPaths.every(
          configPath => classifyGatewayConfigReloadPath(configPath) === 'dynamic',
        )
          ? 'applied'
          : null,
        restartAccepted: false,
      };
      this.records.push(record);
      this.notify();
      return;
    }

    if (line.includes('config reload requires gateway restart; hot mode ignoring')) {
      this.completePending('failed', parseCompletionPaths(line), 'restart');
      return;
    }

    if (line.includes('config change requires gateway restart')) {
      const record = this.findPendingRecord(
        parseCompletionPaths(line),
        'restart',
      );
      if (record) {
        // OpenClaw owns both immediate and workload-deferred in-process
        // restarts. Keep waiting for its next ready marker, but do not let the
        // sync service schedule a second competing hard restart.
        record.restartAccepted = true;
        this.notify();
      }
      return;
    }

    if (line.includes('[gateway] ready')) {
      let completed = false;
      for (const record of this.records) {
        if (!record.outcome && record.restartAccepted) {
          record.outcome = 'applied';
          completed = true;
        }
      }
      if (completed) {
        this.notify();
      }
      return;
    }

    if (
      line.includes('config hot reload applied') ||
      line.includes('config change applied (dynamic reads:')
    ) {
      this.completePending('applied', parseCompletionPaths(line), 'hot');
      return;
    }

    if (
      line.includes('config reload failed') ||
      line.includes('config hot-reload disabled') ||
      line.includes('config reload disabled') ||
      line.includes('no SIGUSR1 listener found; restart skipped') ||
      line.includes('gateway startup failed:')
    ) {
      this.completePending('failed');
    }
  }

  waitForReloadAfter(generation: number, timeoutMs = 15_000): Promise<boolean> {
    const getCurrentRecord = (): ReloadRecord | undefined =>
      this.records.find(candidate => candidate.generation > generation);
    const resolveCurrent = (): boolean | null => {
      const outcome = getCurrentRecord()?.outcome;
      return outcome ? outcome === 'applied' : null;
    };

    const current = resolveCurrent();
    if (current !== null) {
      return Promise.resolve(current);
    }

    return new Promise(resolve => {
      let settled = false;
      let usingRestartTimeout = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (result: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.delete(onChange);
        resolve(result);
      };
      const armTimer = (delayMs: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(false), delayMs);
        timer.unref?.();
      };
      const onChange = () => {
        const result = resolveCurrent();
        if (result !== null) {
          finish(result);
          return;
        }
        if (!usingRestartTimeout && getCurrentRecord()?.restartAccepted) {
          usingRestartTimeout = true;
          armTimer(GATEWAY_RESTART_COMPLETION_TIMEOUT_MS);
        }
      };
      armTimer(timeoutMs);
      this.listeners.add(onChange);
      onChange();
    });
  }

  private findPendingRecord(
    completionPaths: string[] = [],
    expectedKind?: Exclude<GatewayConfigReloadKind, 'dynamic'>,
  ): ReloadRecord | undefined {
    const pending = this.records.filter(candidate => !candidate.outcome);
    if (completionPaths.length > 0) {
      const exact = pending.find(candidate =>
        completionPaths.some(completionPath =>
          candidate.changedPaths.some(
            changedPath =>
              changedPath === completionPath ||
              changedPath.startsWith(`${completionPath}.`) ||
              completionPath.startsWith(`${changedPath}.`),
          ),
        ),
      );
      if (exact) {
        return exact;
      }
    }
    if (expectedKind) {
      const sameKind = pending.find(candidate =>
        candidate.changedPaths.some(
          configPath => classifyGatewayConfigReloadPath(configPath) === expectedKind,
        ),
      );
      if (sameKind) {
        return sameKind;
      }
    }
    return pending[0];
  }

  private completePending(
    outcome: GatewayConfigReloadOutcome,
    completionPaths: string[] = [],
    expectedKind?: Exclude<GatewayConfigReloadKind, 'dynamic'>,
  ): void {
    const record = this.findPendingRecord(completionPaths, expectedKind);
    if (!record) {
      return;
    }
    record.outcome = outcome;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
