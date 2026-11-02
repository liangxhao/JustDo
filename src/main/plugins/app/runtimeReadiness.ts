import { EnginePhase, type OpenClawEngineStatus } from '../../../shared/openclaw/engineStatus';
import { t } from '../../core/i18n';

/** Adapt the app's status-returning preparation to the plugin host's readiness promise. */
export async function ensureAppPluginRuntimeReady(
  prepare: () => Promise<OpenClawEngineStatus>,
): Promise<OpenClawEngineStatus> {
  const status = await prepare();
  if (status.phase === EnginePhase.Running) return status;
  if (status.phase === EnginePhase.Error && status.message?.trim())
    throw new Error(status.message);
  throw new Error(t(status.phase === EnginePhase.Ready
    ? 'enginePreparationStopped'
    : status.phase === EnginePhase.Starting
      ? 'enginePreparationStillStarting'
      : 'enginePreparationUnconfirmed'));
}
