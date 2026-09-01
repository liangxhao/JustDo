import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyGatewayConfigReloadPath,
  GatewayConfigReloadMonitor,
  parseGatewayConfigReloadPaths,
} from './gatewayConfigReloadMonitor';

describe('GatewayConfigReloadMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses changed paths from Gateway reload logs', () => {
    expect(
      parseGatewayConfigReloadPaths(
        '[reload] config change detected; evaluating reload (agents.entries, meta.lastTouchedVersion)',
      ),
    ).toEqual(['agents.entries', 'meta.lastTouchedVersion']);
  });

  it('uses OpenClaw first-match ordering for overlapping config prefixes', () => {
    expect(classifyGatewayConfigReloadPath('mcp.apps.port')).toBe('restart');
    expect(classifyGatewayConfigReloadPath('mcp.servers.local')).toBe('hot');
    expect(classifyGatewayConfigReloadPath('models.providers.builtin_models')).toBe('hot');
    expect(classifyGatewayConfigReloadPath('plugins.load.paths')).toBe('restart');
    expect(classifyGatewayConfigReloadPath('plugins.entries.ask-user.enabled')).toBe('hot');
    expect(classifyGatewayConfigReloadPath('gateway.remote.url')).toBe('dynamic');
    expect(classifyGatewayConfigReloadPath('gateway.bind')).toBe('restart');
    expect(
      classifyGatewayConfigReloadPath('plugins.installs.ask-user.installedAt'),
    ).toBe('dynamic');
  });

  it('completes immediately for dynamically-read config', async () => {
    const monitor = new GatewayConfigReloadMonitor();
    const generation = monitor.getGeneration();

    monitor.observeLine(
      '[reload] config change detected; evaluating reload (meta.lastTouchedVersion)',
    );

    await expect(monitor.waitForReloadAfter(generation)).resolves.toBe(true);
  });

  it('waits for unknown future fields instead of racing a possible restart', async () => {
    const monitor = new GatewayConfigReloadMonitor();
    const generation = monitor.getGeneration();
    monitor.observeLine(
      '[reload] config change detected; evaluating reload (futureRuntime.option)',
    );
    const result = monitor.waitForReloadAfter(generation);

    monitor.observeLine('[reload] config hot reload applied (futureRuntime.option)');

    await expect(result).resolves.toBe(true);
  });

  it('waits for hot reload completion', async () => {
    const monitor = new GatewayConfigReloadMonitor();
    const generation = monitor.getGeneration();
    monitor.observeLine(
      '[reload] config change detected; evaluating reload (models.providers.builtin_models)',
    );
    const result = monitor.waitForReloadAfter(generation);

    monitor.observeLine('[reload] config hot reload applied (models.providers.builtin_models)');

    await expect(result).resolves.toBe(true);
  });

  it('releases concurrent session waiters after the same reload completes', async () => {
    const monitor = new GatewayConfigReloadMonitor();
    const generation = monitor.getGeneration();
    const first = monitor.waitForReloadAfter(generation);
    const second = monitor.waitForReloadAfter(generation);

    monitor.observeLine(
      '[reload] config change detected; evaluating reload (agents.entries)',
    );
    monitor.observeLine('[reload] config hot reload applied (agents.entries)');

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('matches interleaved hot and restart completions to their own generations', async () => {
    vi.useFakeTimers();
    const monitor = new GatewayConfigReloadMonitor();
    const beforeRestart = monitor.getGeneration();
    monitor.observeLine(
      '[reload] config change detected; evaluating reload (gateway.bind)',
    );
    const beforeHot = monitor.getGeneration();
    monitor.observeLine(
      '[reload] config change detected; evaluating reload (agents.entries)',
    );
    const restartResult = monitor.waitForReloadAfter(beforeRestart, 100);
    const hotResult = monitor.waitForReloadAfter(beforeHot, 100);

    monitor.observeLine('[reload] config hot reload applied (agents.entries)');
    await expect(hotResult).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    await expect(restartResult).resolves.toBe(false);
  });

  it('waits for Gateway ready after OpenClaw accepts a restart-required reload', async () => {
    const monitor = new GatewayConfigReloadMonitor();
    const generation = monitor.getGeneration();
    monitor.observeLine(
      '[reload] config change detected; evaluating reload (gateway.bind)',
    );
    monitor.observeLine(
      '[reload] config change requires gateway restart (gateway.bind) — restarting now',
    );
    const result = monitor.waitForReloadAfter(generation);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    monitor.observeLine('[gateway] ready');

    await expect(result).resolves.toBe(true);
  });

  it('tracks Gateway ready independently from config reload records', async () => {
    const monitor = new GatewayConfigReloadMonitor();
    const generation = monitor.getGatewayLifecycleGeneration();
    const result = monitor.waitForGatewayReadyAfter(generation);

    monitor.observeLine('2026-08-30T14:55:15.430+08:00 [gateway] ready');

    await expect(result).resolves.toBe(true);
    expect(monitor.getGatewayLifecycleGeneration()).toBeGreaterThan(generation);
  });

  it('ignores Gateway ready text embedded in unrelated log content', async () => {
    vi.useFakeTimers();
    const monitor = new GatewayConfigReloadMonitor();
    const result = monitor.waitForGatewayReadyAfter(
      monitor.getGatewayLifecycleGeneration(),
      100,
    );

    monitor.observeLine('[ws] event preview="[gateway] ready"');
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe(false);
  });

  it('fails a Gateway ready waiter immediately when the managed process exits', async () => {
    const monitor = new GatewayConfigReloadMonitor();
    const generation = monitor.getGatewayLifecycleGeneration();
    const result = monitor.waitForGatewayReadyAfter(generation);

    monitor.observeGatewayExit();

    await expect(result).resolves.toBe(false);
  });

  it('uses the latest lifecycle event when ready and exit occur before waiting', async () => {
    const monitor = new GatewayConfigReloadMonitor();
    const beforeExit = monitor.getGatewayLifecycleGeneration();
    monitor.observeLine('[gateway] ready');
    monitor.observeGatewayExit();

    await expect(monitor.waitForGatewayReadyAfter(beforeExit)).resolves.toBe(false);

    const beforeReady = monitor.getGatewayLifecycleGeneration();
    monitor.observeGatewayExit();
    monitor.observeLine('[gateway] ready');

    await expect(monitor.waitForGatewayReadyAfter(beforeReady)).resolves.toBe(true);
  });

  it('times out while waiting for a new Gateway ready lifecycle', async () => {
    vi.useFakeTimers();
    const monitor = new GatewayConfigReloadMonitor();
    const result = monitor.waitForGatewayReadyAfter(
      monitor.getGatewayLifecycleGeneration(),
      100,
    );

    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe(false);
  });

  it('falls back when hot-only mode ignores a restart-required change', async () => {
    const monitor = new GatewayConfigReloadMonitor();
    const generation = monitor.getGeneration();
    monitor.observeLine(
      '[reload] config change detected; evaluating reload (gateway.bind)',
    );
    const result = monitor.waitForReloadAfter(generation);
    monitor.observeLine(
      '[reload] config reload requires gateway restart; hot mode ignoring (gateway.bind)',
    );

    await expect(result).resolves.toBe(false);
  });

  it('reports reload failures and timeouts', async () => {
    const failedMonitor = new GatewayConfigReloadMonitor();
    const failedGeneration = failedMonitor.getGeneration();
    failedMonitor.observeLine(
      '[reload] config change detected; evaluating reload (mcp.servers.local)',
    );
    const failedResult = failedMonitor.waitForReloadAfter(failedGeneration);
    failedMonitor.observeLine('[reload] config reload failed: invalid MCP server');
    await expect(failedResult).resolves.toBe(false);

    vi.useFakeTimers();
    const timedOutMonitor = new GatewayConfigReloadMonitor();
    const timedOutResult = timedOutMonitor.waitForReloadAfter(
      timedOutMonitor.getGeneration(),
      100,
    );
    await vi.advanceTimersByTimeAsync(100);
    await expect(timedOutResult).resolves.toBe(false);
  });
});
