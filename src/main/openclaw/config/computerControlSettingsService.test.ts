import { describe, expect, test, vi } from 'vitest';

import { buildComputerControlPatch, withComputerControlPolicy } from './computerControlConfig';
import { ComputerControlSettingsService } from './computerControlSettingsService';

const config = (enabled: boolean, tools: Record<string, unknown> = {}) => ({
  plugins: {
    allow: ['browser', 'cua-computer'],
    entries: { 'cua-computer': { enabled, config: { driverPath: 'existing' } } },
  },
  tools,
  models: { providers: { private: { apiKey: 'test-only-key' } } },
});

describe('computer control switch', () => {
  test('reads the combined choice without exposing native configuration', async () => {
    const request = vi.fn().mockResolvedValue({
      valid: true,
      hash: 'revision',
      config: config(true, { deny: ['computer'] }),
    });
    const isToolAdmitted = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const service = new ComputerControlSettingsService(request, () => true, isToolAdmitted);
    expect(await service.get()).toEqual({ success: true, enabled: false });
    request.mockResolvedValue({ valid: true, hash: 'revision', config: config(true) });
    expect(await service.get()).toEqual({ success: true, enabled: true });
    const blocked = config(true);
    request.mockResolvedValue({
      valid: true,
      hash: 'revision',
      config: {
        ...blocked,
        plugins: { ...blocked.plugins, deny: ['cua-computer'] },
      },
    });
    expect(await service.get()).toEqual({ success: true, enabled: false });
  });

  test('enables provider and native tool in one guarded write while preserving other policy', async () => {
    const source = config(false, {
      profile: 'coding',
      alsoAllow: ['operator-tool'],
      deny: ['exec', 'computer'],
      sandbox: { tools: { deny: ['computer'] } },
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ valid: true, hash: 'revision', config: source })
      .mockResolvedValueOnce({ ok: true });
    const service = new ComputerControlSettingsService(
      request,
      () => true,
      async () => true,
    );
    expect(await service.setEnabled(true)).toEqual({ success: true, enabled: true });
    expect(request).toHaveBeenCalledTimes(2);
    const [method, payload] = request.mock.calls[1];
    expect(method).toBe('config.patch');
    expect(payload.baseHash).toBe('revision');
    expect(payload.replacePaths).toContain('tools.deny');
    expect(JSON.parse(payload.raw)).toEqual({
      plugins: {
        allow: ['browser', 'cua-computer'],
        entries: { 'cua-computer': { enabled: true } },
      },
      tools: { deny: ['exec'], alsoAllow: ['operator-tool', 'computer'] },
    });
    expect(source.tools.deny).toEqual(['exec', 'computer']);
    expect(JSON.parse(payload.raw)).not.toHaveProperty('models');
    expect(JSON.parse(payload.raw).tools).not.toHaveProperty('sandbox');
  });

  test('disables both in one write without emptying a restrictive allowlist', async () => {
    const source = config(true, { allow: ['computer'], deny: ['operator-tool'] });
    const patch = buildComputerControlPatch(source, false);
    expect(JSON.parse(patch.raw)).toEqual({
      plugins: { entries: { 'cua-computer': { enabled: false } } },
      tools: { deny: ['operator-tool', 'computer'] },
    });
    expect(withComputerControlPolicy(config(false, source.tools)).tools).toEqual({
      allow: ['computer'],
      deny: ['operator-tool', 'computer'],
    });
  });

  test('extends a nonempty allowlist without adding an incompatible alsoAllow list', () => {
    const patch = JSON.parse(
      buildComputerControlPatch(config(false, { allow: ['read'] }), true).raw,
    );
    expect(patch.tools).toEqual({ allow: ['read', 'computer'], deny: [] });
    expect(withComputerControlPolicy(config(true, { allow: ['read', 'computer'] })).tools).toEqual({
      allow: ['read', 'computer'],
      deny: [],
    });
  });

  test('preserves a blank-only absolute allowlist without creating an allow/alsoAllow conflict', () => {
    const patch = JSON.parse(buildComputerControlPatch(config(false, { allow: [' '] }), true).raw);
    expect(patch.tools).toEqual({ allow: [' ', 'computer'], deny: [] });
  });

  test('removes only normalized exact computer denials while retaining broader restrictions', () => {
    const patch = JSON.parse(
      buildComputerControlPatch(
        config(false, {
          deny: [' Computer ', 'computer*', 'exec'],
        }),
        true,
      ).raw,
    );
    expect(patch.tools.deny).toEqual(['computer*', 'exec']);
  });

  test('reads native global admission and rejects a still-blocked enable before writing', async () => {
    const source = config(true, { profile: 'coding', allow: ['read'] });
    const request = vi.fn().mockResolvedValue({ valid: true, hash: 'revision', config: source });
    const isToolAdmitted = vi.fn().mockResolvedValue(false);
    const service = new ComputerControlSettingsService(request, () => true, isToolAdmitted);
    expect(await service.get()).toEqual({ success: true, enabled: false });
    expect(isToolAdmitted).toHaveBeenLastCalledWith(source.tools);
    expect(await service.setEnabled(true)).toEqual({ success: false, code: 'failed' });
    expect(isToolAdmitted).toHaveBeenLastCalledWith({
      profile: 'coding',
      allow: ['read', 'computer'],
      deny: [],
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(['config.get', 'config.get']);
  });

  test('keeps a global plugin prohibition and rejects invalid requests before writing', async () => {
    const request = vi.fn().mockResolvedValue({
      valid: true,
      hash: 'revision',
      config: { ...config(false), plugins: { enabled: false } },
    });
    const service = new ComputerControlSettingsService(
      request,
      () => true,
      async () => true,
    );
    expect(await service.setEnabled('true')).toEqual({ success: false, code: 'invalid' });
    expect(request).not.toHaveBeenCalled();
    expect(await service.setEnabled(true)).toEqual({ success: false, code: 'failed' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  test('does not retry uncertain writes or conflicts', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ valid: true, hash: 'revision', config: config(false) })
      .mockRejectedValueOnce(new Error('baseHash conflict'));
    const service = new ComputerControlSettingsService(
      request,
      () => true,
      async () => true,
    );
    expect(await service.setEnabled(true)).toEqual({ success: false, code: 'conflict' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  test('does not start the gateway when the bundled provider is missing', async () => {
    const request = vi.fn();
    const service = new ComputerControlSettingsService(
      request,
      () => false,
      async () => true,
    );
    expect(await service.get()).toEqual({ success: false, code: 'unavailable' });
    expect(await service.setEnabled(true)).toEqual({ success: false, code: 'unavailable' });
    expect(request).not.toHaveBeenCalled();
  });
});
