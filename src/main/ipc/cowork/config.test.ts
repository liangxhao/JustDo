import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import {
  type AgentRuntimeSettings,
  AgentRuntimeSettingsIpc,
  createDefaultAgentRuntimeSettings,
} from '../../../shared/openclaw/agentRuntimeSettings';
import {
  createDefaultExternalAgentSettings,
  ExternalAgentIpc,
  type ExternalAgentSettings,
} from '../../../shared/openclaw/externalAgents';
import type { CoworkConfig } from '../../data/coworkStore';
import { registerCoworkConfigHandlers, waitForCoworkConfigUpdates } from './config';

const baseConfig: CoworkConfig = {
  workingDirectory: 'E:/workspace/project',
  executionMode: 'local',
  sandboxNetworkEnabled: false,
  agentEngine: 'openclaw',
  permissionMode: 'full',
  maxGoalContinuationTurns: 25,
  maxRetainedDisplayTabs: 30,
};

describe('cowork config IPC', () => {
  const syncOpenClawConfig = vi.fn();
  const handleEngineConfigChanged = vi.fn();
  const setConfig = vi.fn();
  const setAgentRuntimeSettings = vi.fn();
  const setExternalAgentSettings = vi.fn();
  const ensureEngineRunning = vi.fn();
  const getEngineStatus = vi.fn();
  const requestGateway = vi.fn();
  const getWindowsSandboxStatus = vi.fn();
  let currentConfig: CoworkConfig;
  let currentAgentRuntimeSettings: AgentRuntimeSettings;
  let currentExternalAgentSettings: ExternalAgentSettings;

  beforeEach(() => {
    handlers.clear();
    syncOpenClawConfig.mockReset();
    syncOpenClawConfig.mockResolvedValue({ success: true, changed: true });
    handleEngineConfigChanged.mockReset();
    setConfig.mockReset();
    setAgentRuntimeSettings.mockReset();
    setExternalAgentSettings.mockReset();
    ensureEngineRunning.mockReset();
    ensureEngineRunning.mockResolvedValue({ phase: 'running' });
    getEngineStatus.mockReset();
    getEngineStatus.mockReturnValue({ phase: 'running' });
    requestGateway.mockReset();
    getWindowsSandboxStatus.mockReset();
    getWindowsSandboxStatus.mockResolvedValue({ ready: true });
    currentConfig = { ...baseConfig };
    currentAgentRuntimeSettings = createDefaultAgentRuntimeSettings();
    currentExternalAgentSettings = createDefaultExternalAgentSettings();
    setConfig.mockImplementation((update: Partial<CoworkConfig>) => {
      currentConfig = {
        ...currentConfig,
        ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
      };
    });
    setAgentRuntimeSettings.mockImplementation((settings: AgentRuntimeSettings) => {
      currentAgentRuntimeSettings = settings;
    });
    setExternalAgentSettings.mockImplementation((settings: ExternalAgentSettings) => {
      currentExternalAgentSettings = settings;
    });
    registerCoworkConfigHandlers({
      getCoworkStore: () =>
        ({
          getConfig: () => currentConfig,
          setConfig,
          getAgentRuntimeSettings: () => currentAgentRuntimeSettings,
          setAgentRuntimeSettings,
          getExternalAgentSettings: () => currentExternalAgentSettings,
          setExternalAgentSettings,
        }) as never,
      getCoworkEngineRouter: () => ({ handleEngineConfigChanged }) as never,
      getEngineManager: () => ({ getStatus: getEngineStatus }) as never,
      syncOpenClawConfig,
      ensureEngineRunning,
      requestGateway,
      getWindowsSandboxService: () => ({ getStatus: getWindowsSandboxStatus }) as never,
      engineNotReadyCode: 'ENGINE_NOT_READY',
    });
  });

  it('persists assistant switching without changing Gateway configuration', async () => {
    await expect(
      handlers.get('cowork:config:set')?.({}, { allowMainAgentSwitch: true }),
    ).resolves.toEqual({ success: true });
    expect(currentConfig.allowMainAgentSwitch).toBe(true);
    await expect(
      handlers.get('cowork:config:set')?.({}, { allowMainAgentSwitch: false }),
    ).resolves.toEqual({ success: true });
    expect(currentConfig.allowMainAgentSwitch).toBe(false);
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });
  it('rejects non-boolean assistant switching settings', async () => {
    await expect(
      handlers.get('cowork:config:set')?.({}, { allowMainAgentSwitch: 'true' }),
    ).resolves.toMatchObject({ success: false });
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('rejects an invalid permission mode instead of silently succeeding', async () => {
    const result = await handlers.get('cowork:config:set')?.({}, { permissionMode: 'unsafe' });

    expect(result).toEqual({ success: false, error: 'Invalid permission mode.' });
    expect(setConfig).not.toHaveBeenCalled();
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('persists a permission change as the default for new sessions without reloading Gateway', async () => {
    const result = await handlers.get('cowork:config:set')?.({}, { permissionMode: 'ask' });

    expect(result).toEqual({ success: true });
    expect(setConfig).toHaveBeenCalledWith({
      workingDirectory: undefined,
      executionMode: undefined,
      agentEngine: undefined,
      permissionMode: 'ask',
    });
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('normalizes and persists the retained display tab limit without reloading Gateway', async () => {
    const result = await handlers.get('cowork:config:set')?.({}, { maxRetainedDisplayTabs: 999 });

    expect(result).toEqual({ success: true });
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetainedDisplayTabs: 200 }),
    );
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('serializes rapid default permission changes in request order', async () => {
    const handler = handlers.get('cowork:config:set');

    const first = handler?.({}, { permissionMode: 'ask' });
    const second = handler?.({}, { permissionMode: 'auto' });
    await expect(first).resolves.toEqual({ success: true });
    await expect(second).resolves.toEqual({ success: true });
    await waitForCoworkConfigUpdates();
    expect(setConfig).toHaveBeenCalledTimes(2);
    expect(setConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ permissionMode: 'auto' }),
    );
    expect(currentConfig.permissionMode).toBe('auto');
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('does not couple a pure permission preference change to config sync', async () => {
    currentConfig = { ...baseConfig, permissionMode: 'ask' };

    const result = await handlers.get('cowork:config:set')?.({}, { permissionMode: 'auto' });

    expect(result).toEqual({ success: true });
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('preserves restart fallback for non-permission config changes', async () => {
    const result = await handlers.get('cowork:config:set')?.(
      {},
      { workingDirectory: 'E:/workspace/other-project' },
    );

    expect(result).toEqual({ success: true });
    expect(syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'cowork-config-change' });
  });

  it('preserves restart fallback when permission and other config change together', async () => {
    currentConfig = { ...baseConfig, permissionMode: 'ask' };

    const result = await handlers.get('cowork:config:set')?.(
      {},
      { permissionMode: 'auto', executionMode: 'sandbox' },
    );

    expect(result).toEqual({ success: true });
    expect(syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'cowork-config-change' });
  });

  it('rejects sandbox mode while the native backend is not ready', async () => {
    getWindowsSandboxStatus.mockResolvedValue({
      ready: false,
      code: 'broker_unavailable',
      supported: true,
      helperAvailable: true,
      initialized: false,
    });

    const result = await handlers.get('cowork:config:set')?.({}, { executionMode: 'sandbox' });

    expect(result).toMatchObject({ success: false, sandboxStatus: { code: 'broker_unavailable' } });
    expect(setConfig).not.toHaveBeenCalled();
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('migrates the retired automatic mode to local execution', async () => {
    const result = await handlers.get('cowork:config:set')?.({}, { executionMode: 'auto' });

    expect(result).toEqual({ success: true });
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ executionMode: 'local' }));
  });

  it('persists explicit sandbox network access and synchronizes OpenClaw', async () => {
    const result = await handlers.get('cowork:config:set')?.({}, { sandboxNetworkEnabled: true });

    expect(result).toEqual({ success: true });
    expect(setConfig).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxNetworkEnabled: true }),
    );
    expect(syncOpenClawConfig).toHaveBeenCalledWith({ reason: 'cowork-config-change' });
  });

  it('rejects an invalid sandbox network preference', async () => {
    const result = await handlers.get('cowork:config:set')?.({}, { sandboxNetworkEnabled: 'yes' });

    expect(result).toEqual({ success: false, error: 'Invalid sandbox network setting.' });
    expect(setConfig).not.toHaveBeenCalled();
  });

  it('returns the persisted Agent runtime settings', async () => {
    const result = await handlers.get(AgentRuntimeSettingsIpc.Get)?.({});

    expect(result).toEqual({ success: true, settings: currentAgentRuntimeSettings });
  });

  it('validates and synchronizes Agent runtime settings', async () => {
    const next = createDefaultAgentRuntimeSettings();
    next.subagents.maxConcurrent = 6;
    next.subagents.delegationMode = 'prefer';

    const result = await handlers.get(AgentRuntimeSettingsIpc.Set)?.({}, next);

    expect(result).toMatchObject({ success: true, changed: true, settings: next });
    expect(setAgentRuntimeSettings).toHaveBeenCalledWith(next);
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      reason: 'agent-runtime-settings-change',
    });
  });

  it('rejects invalid Agent runtime settings before persistence', async () => {
    const invalid = createDefaultAgentRuntimeSettings();
    invalid.subagents.maxConcurrent = 0;

    const result = await handlers.get(AgentRuntimeSettingsIpc.Set)?.({}, invalid);

    expect(result).toMatchObject({ success: false });
    expect(setAgentRuntimeSettings).not.toHaveBeenCalled();
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('rejects an unsupported session visibility before persistence', async () => {
    const invalid = createDefaultAgentRuntimeSettings();
    invalid.sessions.visibility = 'siblings' as never;

    const result = await handlers.get(AgentRuntimeSettingsIpc.Set)?.({}, invalid);

    expect(result).toMatchObject({ success: false });
    expect(setAgentRuntimeSettings).not.toHaveBeenCalled();
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('rolls Agent runtime settings back when generated config cannot be applied', async () => {
    const previous = currentAgentRuntimeSettings;
    const next = createDefaultAgentRuntimeSettings();
    next.subagents.runTimeoutSeconds = 1800;
    syncOpenClawConfig
      .mockResolvedValueOnce({ success: false, changed: true, error: 'reload failed' })
      .mockResolvedValueOnce({ success: true, changed: true });

    const result = await handlers.get(AgentRuntimeSettingsIpc.Set)?.({}, next);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('rolled back'),
    });
    expect(setAgentRuntimeSettings).toHaveBeenNthCalledWith(1, next);
    expect(setAgentRuntimeSettings).toHaveBeenNthCalledWith(2, previous);
    expect(currentAgentRuntimeSettings).toEqual(previous);
    expect(syncOpenClawConfig).toHaveBeenNthCalledWith(2, {
      reason: 'agent-runtime-settings-change-rollback',
    });
  });

  it('returns and synchronizes external Agent settings', async () => {
    await expect(handlers.get(ExternalAgentIpc.GET_SETTINGS)?.({})).resolves.toEqual({
      success: true,
      settings: currentExternalAgentSettings,
    });

    const next = createDefaultExternalAgentSettings();
    next.agents.claude.enabled = true;
    const result = await handlers.get(ExternalAgentIpc.SET_SETTINGS)?.({}, next);

    expect(result).toMatchObject({ success: true, changed: true, settings: next });
    expect(setExternalAgentSettings).toHaveBeenCalledWith(next);
    expect(syncOpenClawConfig).toHaveBeenCalledWith({
      reason: 'external-agent-settings-change',
    });
  });

  it('tests a catalog Agent without restarting or synchronizing a running engine', async () => {
    requestGateway.mockResolvedValue({ ok: true, message: 'ACP runtime is available.' });

    const result = await handlers.get(ExternalAgentIpc.TEST)?.({}, 'hermes');

    expect(ensureEngineRunning).not.toHaveBeenCalled();
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
    expect(requestGateway).toHaveBeenCalledWith('acpx.agent.doctor', { agentId: 'hermes' });
    expect(result).toEqual({
      success: true,
      ready: true,
      message: 'ACP runtime is available.',
    });
  });

  it('rejects an Agent test outside the build-time catalog', async () => {
    const result = await handlers.get(ExternalAgentIpc.TEST)?.({}, 'custom-command');

    expect(result).toEqual({ success: false, error: 'Unsupported external agent.' });
    expect(ensureEngineRunning).not.toHaveBeenCalled();
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('does not probe an Agent before the Gateway is ready', async () => {
    getEngineStatus.mockReturnValue({ phase: 'ready' });
    ensureEngineRunning.mockResolvedValue({ phase: 'error', message: 'Gateway failed to start.' });

    const result = await handlers.get(ExternalAgentIpc.TEST)?.({}, 'codex');

    expect(result).toEqual({ success: false, error: 'Gateway failed to start.' });
    expect(ensureEngineRunning).toHaveBeenCalledOnce();
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('rolls external Agent settings back when config synchronization fails', async () => {
    const previous = currentExternalAgentSettings;
    const next = createDefaultExternalAgentSettings();
    next.permissionMode = 'full-access';
    syncOpenClawConfig
      .mockResolvedValueOnce({ success: false, changed: true, error: 'reload failed' })
      .mockResolvedValueOnce({ success: true, changed: true });

    const result = await handlers.get(ExternalAgentIpc.SET_SETTINGS)?.({}, next);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('rolled back') });
    expect(setExternalAgentSettings).toHaveBeenNthCalledWith(1, next);
    expect(setExternalAgentSettings).toHaveBeenNthCalledWith(2, previous);
    expect(currentExternalAgentSettings).toEqual(previous);
  });

  it('returns a controlled failure when external Agent settings cannot be persisted', async () => {
    const next = createDefaultExternalAgentSettings();
    next.agents.claude.enabled = true;
    setExternalAgentSettings.mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    const result = await handlers.get(ExternalAgentIpc.SET_SETTINGS)?.({}, next);

    expect(result).toEqual({ success: false, error: 'database unavailable' });
    expect(syncOpenClawConfig).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed external Agent rollback without rejecting IPC', async () => {
    const next = createDefaultExternalAgentSettings();
    next.agents.claude.enabled = true;
    setExternalAgentSettings
      .mockImplementationOnce((settings: ExternalAgentSettings) => {
        currentExternalAgentSettings = settings;
      })
      .mockImplementationOnce(() => {
        throw new Error('rollback database unavailable');
      });
    syncOpenClawConfig.mockRejectedValueOnce(new Error('gateway unavailable'));

    const result = await handlers.get(ExternalAgentIpc.SET_SETTINGS)?.({}, next);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('rollback could not be confirmed'),
    });
    expect(currentExternalAgentSettings).toEqual(next);
  });
});
