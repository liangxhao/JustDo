import { describe, expect, it } from 'vitest';

import {
  buildGatewayLaunchArgs,
  buildGatewayLaunchEnvironment,
  hasExtensionBrowserProfile,
} from './gatewayLaunchArgs';

describe('hasExtensionBrowserProfile', () => {
  it('detects an extension-driven profile', () => {
    expect(
      hasExtensionBrowserProfile({
        browser: { profiles: { chrome: { driver: 'extension' } } },
      }),
    ).toBe(true);
    expect(hasExtensionBrowserProfile({ browser: { profiles: {} } })).toBe(false);
  });
});

describe('buildGatewayLaunchEnvironment', () => {
  it('starts browser control eagerly for extension mode while preserving the base environment', () => {
    expect(
      buildGatewayLaunchEnvironment({
        PATH: 'runtime-bin',
        OPENCLAW_EAGER_BROWSER_CONTROL_SERVER: '0',
      }, { eagerBrowserControl: true }),
    ).toEqual({
      PATH: 'runtime-bin',
      OPENCLAW_EAGER_BROWSER_CONTROL_SERVER: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    });
  });

  it('does not opt other browser modes into eager control startup', () => {
    expect(
      buildGatewayLaunchEnvironment({ PATH: 'runtime-bin' }, { eagerBrowserControl: false }),
    ).toEqual({
      PATH: 'runtime-bin',
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
