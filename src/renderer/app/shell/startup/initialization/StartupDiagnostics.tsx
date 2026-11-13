import { captureStartupFailure, StartupFailureSource } from '@shared/app/startupFailure';
import { EngineFailureReason, EnginePhase } from '@shared/openclaw/engineStatus';
import { lazy, Suspense } from 'react';

import { i18nService } from '@/services/i18n';

import { engineMemoryAdvice } from '../../engineMemoryAdvice';
import StartupLogButton from './StartupLogButton';
import type { useStartupEngine } from './useStartupEngine';

const EngineDiagnostics = lazy(() =>
  import('../../EngineDiagnosticsModal').catch(error => {
    const failure = captureStartupFailure(StartupFailureSource.Renderer, error);
    return {
      default: ({ onClose }: { onClose: () => void }) => (
        <div className="startup-diagnostic-loading" role="alert">
          <p>{failure.error.message}</p>
          <button type="button" className="startup-action" onClick={onClose}>
            {i18nService.t('windowClose')}
          </button>
        </div>
      ),
    };
  }),
);

type Props = { engine: ReturnType<typeof useStartupEngine> };

export function StartupEngineNotice({ engine }: Props) {
  if (!engine.status) return null;
  const failed = engine.status.phase === EnginePhase.Error || Boolean(engine.commandError);
  const memoryFailure = engine.status.failureReason === EngineFailureReason.MemoryAllocation;
  if (!failed && !memoryFailure) return null;
  const heading = i18nService.t(memoryFailure
    ? engine.status.phase === EnginePhase.Starting
      ? 'engineMemoryAllocationRestarting'
      : 'engineMemoryAllocationFailed'
    : 'startupEngineFailure');
  return (
    <aside className="startup-engine-error" aria-label={heading}>
      <p role="status">{heading}</p>
      <p>
        {memoryFailure
          ? engineMemoryAdvice()
          : engine.commandError || engine.status.message || i18nService.t('engineReasonUnavailable')}
      </p>
      {failed && (
        <>
          <button
            className="startup-action"
            type="button"
            onClick={() => engine.setDiagnosticsOpen(true)}
          >
            {i18nService.t('startupDiagnosticsView')}
          </button>
          {engine.status.canRetry && (
            <button
              className="startup-action"
              type="button"
              disabled={engine.starting}
              onClick={() => void engine.start()}
            >
              {i18nService.t('engineStart')}
            </button>
          )}
        </>
      )}
      <StartupLogButton />
    </aside>
  );
}

export default function StartupDiagnostics({ engine }: Props) {
  if (!engine.status || !engine.diagnosticStatus || !engine.diagnosticsOpen) return null;
  return (
    <Suspense
      fallback={
        <div className="startup-diagnostic-loading" role="status">
          <p>{i18nService.t('startupDiagnosticsLoading')}</p>
          <button
            type="button"
            className="startup-action"
            onClick={() => engine.setDiagnosticsOpen(false)}
          >
            {i18nService.t('windowClose')}
          </button>
        </div>
      }
    >
      <EngineDiagnostics
        key={engine.diagnosticStatus.diagnosticId ?? 'engine-command'}
        status={{
          ...engine.diagnosticStatus,
          canRetry: engine.status.canRetry && !engine.starting,
        }}
        commandError={engine.commandError}
        onClose={() => engine.setDiagnosticsOpen(false)}
        onStart={() => void engine.start()}
      />
    </Suspense>
  );
}
