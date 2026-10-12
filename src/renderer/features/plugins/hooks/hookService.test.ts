import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const nativeHook = (id: string) => ({
  hookKey: id,
  name: id,
  description: 'Custom Hook',
  source: 'openclaw-managed',
  disabled: false,
  eligible: true,
  requirementsSatisfied: true,
  loadable: true,
  events: ['command:new'],
  missing: { bins: [], env: [], config: [], os: [] },
  managedByPlugin: false,
});

const api = {
  list: vi.fn(),
  delete: vi.fn(),
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('window', { electron: { hooks: api } });
  api.list.mockResolvedValue({
    success: true,
    hooks: [nativeHook('removed'), nativeHook('retained')],
  });
});

afterEach(() => vi.unstubAllGlobals());

test.each([false, true])(
  'removes a confirmed deleted Hook from the list when refreshed status is present: %s',
  async withStatus => {
    const { hookService } = await import('./hookService');
    await hookService.loadHooks();
    api.delete.mockResolvedValue({
      success: true,
      ...(withStatus ? { hooks: [nativeHook('retained')] } : {}),
    });

    const result = await hookService.deleteHook('removed');

    expect(result.success).toBe(true);
    expect(result.hooks?.map(hook => hook.id)).toEqual(['retained']);
    expect(hookService.getHooks().map(hook => hook.id)).toEqual(['retained']);
    expect(api.delete).toHaveBeenCalledWith('removed');
  },
);

test('keeps the original list when Hook deletion fails', async () => {
  const { hookService } = await import('./hookService');
  await hookService.loadHooks();
  api.delete.mockResolvedValue({ success: false, error: 'Directory is locked' });

  await expect(hookService.deleteHook('removed')).rejects.toThrow('Directory is locked');
  expect(hookService.getHooks().map(hook => hook.id)).toEqual(['removed', 'retained']);
});
