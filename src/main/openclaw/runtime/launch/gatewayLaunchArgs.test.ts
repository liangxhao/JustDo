import { describe, expect, it } from 'vitest';

import { buildGatewayLaunchArgs, buildGatewayLaunchEnvironment } from './gatewayLaunchArgs';

describe('buildGatewayLaunchEnvironment', () => {
  it('strips inherited built-in credentials regardless of Windows casing', () => {
    const env = buildGatewayLaunchEnvironment(
      {
        JUSTDO_APIKEY_BUILTIN_MODELS: 'old-secret',
        justdo_apikey_builtin_models: 'old-secret',
        PATH: 'runtime-bin',
      },
      { appStartedAtMs: 1 },
    );
    expect(Object.keys(env).some(key => key.toUpperCase() === 'JUSTDO_APIKEY_BUILTIN_MODELS')).toBe(
      false,
    );
    expect(env.PATH).toBe('runtime-bin');
  });

  it('preserves the base environment without legacy browser startup flags', () => {
    expect(
      buildGatewayLaunchEnvironment(
        {
          PATH: 'runtime-bin',
        },
        { appStartedAtMs: 1_800_000_000_000, platform: 'linux' },
      ),
    ).toEqual({
      PATH: 'runtime-bin',
      OPENCLAW_DISABLE_BONJOUR: '1',
      OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_SKIP_CHANNELS: '1',
      JUSTDO_APP_STARTED_AT_MS: '1800000000000',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    });
  });

  it('replaces a stale app-start boundary', () => {
    expect(
      buildGatewayLaunchEnvironment(
        {
          PATH: 'runtime-bin',
          JUSTDO_APP_STARTED_AT_MS: '1',
        },
        { appStartedAtMs: 1_800_000_000_000, platform: 'linux' },
      ),
    ).toEqual({
      PATH: 'runtime-bin',
      OPENCLAW_DISABLE_BONJOUR: '1',
      OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_SKIP_CHANNELS: '1',
      JUSTDO_APP_STARTED_AT_MS: '1800000000000',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    });
  });
});

describe('Windows Gateway file watching', () => {
  it('uses native polling options without modifying the host environment', () => {
    const inherited = { PATH: 'runtime-bin' };

    const env = buildGatewayLaunchEnvironment(inherited, {
      appStartedAtMs: 1,
      platform: 'win32',
    });

    expect(env.CHOKIDAR_USEPOLLING).toBe('true');
    expect(env).not.toHaveProperty('CHOKIDAR_INTERVAL');
    expect(inherited).toEqual({ PATH: 'runtime-bin' });
  });

  it('replaces inherited polling settings and Windows casing aliases', () => {
    const env = buildGatewayLaunchEnvironment(
      {
        CHOKIDAR_USEPOLLING: 'false',
        chokidar_usepolling: '0',
        CHOKIDAR_INTERVAL: '1',
        chokidar_interval: '2',
      },
      { appStartedAtMs: 1, platform: 'win32' },
    );

    expect(env.CHOKIDAR_USEPOLLING).toBe('true');
    expect(env).not.toHaveProperty('CHOKIDAR_INTERVAL');
    expect(env).not.toHaveProperty('chokidar_usepolling');
    expect(env).not.toHaveProperty('chokidar_interval');
  });

  it.each(['linux', 'darwin'] as const)('preserves watcher settings on %s', platform => {
    const env = buildGatewayLaunchEnvironment(
      { CHOKIDAR_USEPOLLING: 'false', CHOKIDAR_INTERVAL: '250' },
      { appStartedAtMs: 1, platform },
    );

    expect(env.CHOKIDAR_USEPOLLING).toBe('false');
    expect(env.CHOKIDAR_INTERVAL).toBe('250');
  });
});

describe('buildGatewayLaunchArgs', () => {
  it('omits verbose mode for a packaged app', () => {
    expect(
      buildGatewayLaunchArgs({
        port: 42871,
        token: 'gateway-token',
        isPackaged: true,
      }),
    ).toEqual(['gateway', '--bind', 'loopback', '--port', '42871', '--token', 'gateway-token']);
  });

  it('enables verbose mode for development diagnostics', () => {
    expect(
      buildGatewayLaunchArgs({
        port: 42871,
        token: 'gateway-token',
        isPackaged: false,
      }),
    ).toContain('--verbose');
  });
});
