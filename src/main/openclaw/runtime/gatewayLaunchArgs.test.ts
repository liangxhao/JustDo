import { describe, expect, it } from 'vitest';

import { buildGatewayLaunchArgs, buildGatewayLaunchEnvironment } from './gatewayLaunchArgs';

describe('buildGatewayLaunchEnvironment', () => {
  it('preserves the base environment without legacy browser startup flags', () => {
    expect(
      buildGatewayLaunchEnvironment(
        {
          PATH: 'runtime-bin',
        },
        { appStartedAtMs: 1_800_000_000_000 },
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
        { appStartedAtMs: 1_800_000_000_000 },
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

describe('buildGatewayLaunchArgs', () => {
  it('omits verbose mode for a packaged app', () => {
    expect(
      buildGatewayLaunchArgs({
        port: 42871,
        token: 'gateway-token',
        isPackaged: true,
      }),
    ).toEqual([
      'gateway',
      '--bind',
      'loopback',
      '--port',
      '42871',
      '--token',
      'gateway-token',
    ]);
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
