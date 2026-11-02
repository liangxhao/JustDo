import { expect, test, vi } from 'vitest';

import { EnginePhase, type OpenClawEngineStatus } from '../../../shared/openclaw/engineStatus';
import { t } from '../../core/i18n';
import { EnginePreparationPendingCode, EnginePreparationPendingError } from '../../engine/enginePreparationError';
import { ensureAppPluginRuntimeReady } from './runtimeReadiness';

test('returns the original running receipt after one preparation', async () => {
  const status: OpenClawEngineStatus = {
    phase: EnginePhase.Running, version: 'fixture', canRetry: false,
  };
  const prepare = vi.fn(async () => status);

  await expect(ensureAppPluginRuntimeReady(prepare)).resolves.toBe(status);

  expect(prepare).toHaveBeenCalledOnce();
});

test('rejects a returned engine failure with its specific reason before host reconciliation continues', async () => {
  const reason = 'Network generation preparation failed: local certificate store cannot be opened';
  const prepare = vi.fn(async (): Promise<OpenClawEngineStatus> => ({
    phase: EnginePhase.Error, version: 'fixture', canRetry: true, message: reason,
  }));

  await expect(ensureAppPluginRuntimeReady(prepare)).rejects.toThrow(reason);

  expect(prepare).toHaveBeenCalledOnce();
});

test.each([
  { phase: EnginePhase.Ready, key: 'enginePreparationStopped' },
  { phase: EnginePhase.Starting, key: 'enginePreparationStillStarting' },
])('explains a normal $phase status without treating its status message as an error', async ({ phase, key }) => {
  const prepare = vi.fn(async (): Promise<OpenClawEngineStatus> => ({
    phase, version: 'fixture', canRetry: false, message: 'Normal engine status text',
  }));

  await expect(ensureAppPluginRuntimeReady(prepare)).rejects.toThrow(t(key));

  expect(prepare).toHaveBeenCalledOnce();
});

test('reports missing failure details without reading an older preparation failure', async () => {
  const prepare = vi.fn(async (): Promise<OpenClawEngineStatus> => ({
    phase: EnginePhase.Error, version: 'fixture', canRetry: true,
  }));

  const result = ensureAppPluginRuntimeReady(prepare);
  await expect(result).rejects.toThrow(t('enginePreparationFailed'));
  await expect(result).rejects.not.toBeInstanceOf(EnginePreparationPendingError);

  expect(prepare).toHaveBeenCalledOnce();
});

test('preserves a rejected preparation without starting another attempt', async () => {
  const failure = new Error('Permission verification was superseded');
  const prepare = vi.fn().mockRejectedValue(failure);

  await expect(ensureAppPluginRuntimeReady(prepare)).rejects.toBe(failure);

  expect(prepare).toHaveBeenCalledOnce();
});

test('distinguishes a still-starting runtime from a concrete preparation failure', async () => {
  const prepare = vi.fn(async (): Promise<OpenClawEngineStatus> => ({
    phase: EnginePhase.Starting, version: 'fixture', canRetry: false,
  }));

  await expect(ensureAppPluginRuntimeReady(prepare)).rejects.toMatchObject({
    code: EnginePreparationPendingCode.STARTING,
    message: t('enginePreparationStillStarting'),
  });
  expect(prepare).toHaveBeenCalledOnce();
});
