import { expect, test, vi } from 'vitest';

import {
  applyOpenClawCliNetworkMode,
  OpenClawCliNetworkMode,
} from './openclawEngineManager';

test('keeps the inherited CLI environment when outbound proxy mode is not requested', () => {
  const baseEnv = { PATH: 'base' };
  const buildNetworkEnvironment = vi.fn();

  expect(
    applyOpenClawCliNetworkMode(
      baseEnv,
      OpenClawCliNetworkMode.Inherit,
      buildNetworkEnvironment,
    ),
  ).toBe(baseEnv);
  expect(buildNetworkEnvironment).not.toHaveBeenCalled();
});

test('builds an isolated proxy environment for an opted-in CLI command', () => {
  const baseEnv = { PATH: 'base' };
  const proxyEnv = { ...baseEnv, HTTPS_PROXY: 'http://proxy.example' };
  const buildNetworkEnvironment = vi.fn().mockReturnValue(proxyEnv);

  expect(
    applyOpenClawCliNetworkMode(
      baseEnv,
      OpenClawCliNetworkMode.OutboundProxy,
      buildNetworkEnvironment,
    ),
  ).toBe(proxyEnv);
  expect(buildNetworkEnvironment).toHaveBeenCalledWith(baseEnv);
});
