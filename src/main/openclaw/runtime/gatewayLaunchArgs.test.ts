import { describe, expect, it } from 'vitest';

import { buildGatewayLaunchArgs } from './gatewayLaunchArgs';

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
