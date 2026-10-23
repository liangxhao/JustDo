import { PluginOperationStage } from '@shared/plugins/pluginOperation';
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
  importPath: vi.fn(),
  setEnabled: vi.fn(),
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

test('queues one Hook mutation failure with its original stage without a mounted category', async () => {
  api.setEnabled.mockResolvedValue({
    success: false,
    error: 'Native apply refused',
    failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
  });
  const { hookService } = await import('./hookService');
  const { getPluginOperationOwner } = await import('../shared/pluginOperationService');
  await hookService.loadHooks();

  await expect(hookService.setHookEnabled('removed', false)).rejects.toThrow(
    'Native apply refused',
  );

  expect(getPluginOperationOwner().snapshot()).toEqual([]);
  expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({
      message: 'Native apply refused',
      failedStage: PluginOperationStage.APPLYING_CONFIGURATION,
      state: 'failed',
    }),
  ]);
});

test('does not duplicate per-file Hook errors when a batch owns their result', async () => {
  api.importPath.mockResolvedValue({
    success: false,
    error: 'Invalid Hook',
    failedStage: PluginOperationStage.VALIDATING,
  });
  const { hookService } = await import('./hookService');
  const { getPluginOperationOwner } = await import('../shared/pluginOperationService');

  await expect(
    hookService.importHook('C:/imports/hook.zip', { reportFailure: false }),
  ).resolves.toMatchObject({ success: false, failedStage: PluginOperationStage.VALIDATING });
  expect(getPluginOperationOwner().failureSnapshot()).toEqual([]);
});

test('propagates a failed fresh read after Hook deletion as a refresh warning', async () => {
  let resolve!: (value: { success: boolean; hooks: ReturnType<typeof nativeHook>[] }) => void;
  api.delete.mockReturnValue(
    new Promise(finish => {
      resolve = finish;
    }),
  );
  const { hookService } = await import('./hookService');
  const { getPluginOperationOwner } = await import('../shared/pluginOperationService');
  await hookService.loadHooks();
  const deletion = hookService.deleteHook('removed');
  await hookService.loadHooks({ force: true });
  api.list.mockResolvedValue({ success: false, error: 'Read failed' });

  resolve({ success: true, hooks: [nativeHook('retained')] });

  await expect(deletion).resolves.toMatchObject({ success: true, refreshWarning: true });
  expect(getPluginOperationOwner().failureSnapshot()).toEqual([
    expect.objectContaining({ state: 'refresh_failed' }),
  ]);
});

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
    expect(api.delete).toHaveBeenCalledWith('removed', { requestId: expect.any(String) });
  },
);

test('keeps the original list when Hook deletion fails', async () => {
  const { hookService } = await import('./hookService');
  await hookService.loadHooks();
  api.delete.mockResolvedValue({ success: false, error: 'Directory is locked' });

  await expect(hookService.deleteHook('removed')).rejects.toThrow('Directory is locked');
  expect(hookService.getHooks().map(hook => hook.id)).toEqual(['removed', 'retained']);
});

test('a list started before import cannot overwrite the imported Hook', async () => {
  let finishOld!: (result: { success: boolean; hooks: ReturnType<typeof nativeHook>[] }) => void;
  api.list.mockReturnValueOnce(
    new Promise(resolve => {
      finishOld = resolve;
    }),
  );
  api.importPath.mockResolvedValue({ success: true, hooks: [nativeHook('imported')] });
  const { hookService } = await import('./hookService');
  const oldLoad = hookService.loadHooks();

  await hookService.importHook('C:/imports/hook.zip');
  finishOld({ success: true, hooks: [] });

  expect((await oldLoad).hooks?.map(hook => hook.id)).toEqual(['imported']);
  expect(hookService.getHooks().map(hook => hook.id)).toEqual(['imported']);
});

test('a superseded failed Hook list cannot mark a successful mutation offline', async () => {
  let rejectOld!: (error: Error) => void;
  api.list.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectOld = reject;
    }),
  );
  api.delete.mockResolvedValue({ success: true, hooks: [nativeHook('retained')] });
  const { hookService } = await import('./hookService');
  const oldLoad = hookService.loadHooks();

  await hookService.deleteHook('removed');
  rejectOld(new Error('Gateway disconnected'));

  expect((await oldLoad).hooks?.map(hook => hook.id)).toEqual(['retained']);
  expect(hookService.isGatewayOffline()).toBe(false);
});

test('a delayed deletion reply cannot remove a subsequently reimported Hook', async () => {
  let finishDelete!: (result: { success: boolean; hooks: ReturnType<typeof nativeHook>[] }) => void;
  api.delete.mockReturnValue(
    new Promise(resolve => {
      finishDelete = resolve;
    }),
  );
  const reimported = { ...nativeHook('example'), description: 'New version' };
  api.importPath.mockResolvedValue({ success: true, hooks: [reimported] });
  api.list.mockResolvedValue({ success: true, hooks: [reimported] });
  const { hookService } = await import('./hookService');
  const deletion = hookService.deleteHook('example');

  await hookService.importHook('C:/imports/example.zip');
  finishDelete({ success: true, hooks: [] });

  expect((await deletion).hooks?.[0].description).toBe('New version');
  expect(hookService.getHooks()[0].description).toBe('New version');
});

test('a list consumed after a same-turn mutation cannot restore the prior Hook state', async () => {
  let finishRead!: (result: { success: boolean; hooks: ReturnType<typeof nativeHook>[] }) => void;
  let finishSwitch!: (result: { success: boolean; hooks: ReturnType<typeof nativeHook>[] }) => void;
  api.list.mockReturnValueOnce(new Promise(resolve => (finishRead = resolve)));
  api.setEnabled.mockReturnValueOnce(new Promise(resolve => (finishSwitch = resolve)));
  const { hookService } = await import('./hookService');
  const consumed: boolean[] = [];
  const reading = hookService.loadHooks().then(result => consumed.push(result.hooks![0].enabled));
  const switching = hookService
    .setHookEnabled('example', false)
    .then(result => consumed.push(result.hooks![0].enabled));

  finishRead({ success: true, hooks: [nativeHook('example')] });
  finishSwitch({ success: true, hooks: [{ ...nativeHook('example'), disabled: true }] });
  await Promise.all([reading, switching]);

  expect(consumed[consumed.length - 1]).toBe(false);
  expect(hookService.getHooks()[0].enabled).toBe(false);
});

test('a failed supplementary read preserves the latest confirmed Hooks without relabeling the mutation', async () => {
  let finishSwitch!: (result: { success: boolean; hooks: ReturnType<typeof nativeHook>[] }) => void;
  api.setEnabled.mockReturnValueOnce(new Promise(resolve => (finishSwitch = resolve)));
  api.importPath.mockResolvedValue({ success: true, hooks: [nativeHook('newer')] });
  api.list.mockResolvedValue({ success: false, error: 'Native status unavailable' });
  const { hookService } = await import('./hookService');
  const switching = hookService.setHookEnabled('example', false);
  await hookService.importHook('C:/imports/newer.zip');
  finishSwitch({ success: true, hooks: [{ ...nativeHook('example'), disabled: true }] });

  expect(await switching).toMatchObject({ success: true, hooks: [{ id: 'newer' }] });
  expect(hookService.getHooks()[0].id).toBe('newer');
  expect(await hookService.loadHooks()).toMatchObject({
    success: false,
    error: 'Native status unavailable',
    hooks: [{ id: 'newer' }],
  });
});

test.each(['refused', 'disconnected'] as const)(
  'a %s Hook read preserves its last confirmed directory metadata without replaying mutation flags',
  async failure => {
    api.list.mockResolvedValueOnce({
      success: true,
      hooks: [nativeHook('retained')],
      workspaceDir: 'C:/fixture/workspace',
      managedHooksDir: 'C:/fixture/hooks',
      restartRequired: true,
      hookId: 'previous-operation',
    });
    const { hookService } = await import('./hookService');
    await hookService.loadHooks();
    if (failure === 'refused')
      api.list.mockResolvedValueOnce({ success: false, error: 'Read refused' });
    else api.list.mockRejectedValueOnce(new Error('Gateway disconnected'));

    const result = await hookService.loadHooks();

    expect(result).toMatchObject({
      success: false,
      hooks: [{ id: 'retained' }],
      workspaceDir: 'C:/fixture/workspace',
      managedHooksDir: 'C:/fixture/hooks',
      error: failure === 'refused' ? 'Read refused' : 'Gateway disconnected',
    });
    expect(result).not.toHaveProperty('restartRequired');
    expect(result).not.toHaveProperty('hookId');
  },
);
