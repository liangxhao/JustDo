import { EnginePhase, type OpenClawEngineStatus } from '../../../shared/openclaw/engineStatus';
import { t } from '../../core/i18n';
import { EnginePreparationPendingCode, EnginePreparationPendingError } from '../../engine/enginePreparationError';

/** Adapt the app's status-returning preparation to the plugin host's readiness promise. */
export async function ensureAppPluginRuntimeReady(
  prepare: () => Promise<OpenClawEngineStatus>,
): Promise<OpenClawEngineStatus> {
  const status = await prepare();
  if (status.phase === EnginePhase.Running) return status;
  if (status.phase === EnginePhase.Error)
    throw new Error(status.message?.trim() ? status.message : t('enginePreparationFailed'));
  if (status.phase === EnginePhase.Ready) throw new Error(t('enginePreparationStopped'));
  throw new EnginePreparationPendingError(
    EnginePreparationPendingCode.STARTING,
    t('enginePreparationStillStarting'),
  );
}
