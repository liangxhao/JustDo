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
        '[reload] config change detected; evaluating reload (agents.list, meta.lastTouchedAt)',
      ),
    ).toEqual(['agents.list', 'meta.lastTouchedAt']);
  });

  it('uses OpenClaw first-match ordering for overlapping config prefixes', () => {
    expect(classifyGatewayConfigReloadPath('models.pricing.enabled')).toBe('restart');
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
      '[reload] config change detected; evaluating reload (agents.defaults.sandbox.mode)',
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
      '[reload] config change detected; evaluating reload (agents.list)',
    );
    monitor.observeLine('[reload] config hot reload applied (agents.list)');

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
      '[reload] config change detected; evaluating reload (agents.list)',
    );
    const restartResult = monitor.waitForReloadAfter(beforeRestart, 100);
    const hotResult = monitor.waitForReloadAfter(beforeHot, 100);

    monitor.observeLine('[reload] config hot reload applied (agents.list)');
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
