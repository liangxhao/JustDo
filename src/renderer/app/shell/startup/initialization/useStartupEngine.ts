import { redactLogText } from '@shared/diagnostics/redaction';
import { EnginePhase, type OpenClawEngineStatus } from '@shared/openclaw/engineStatus';
import { useCallback, useEffect, useRef, useState } from 'react';

function engineStatus(value: unknown): OpenClawEngineStatus | undefined {
  if (!value || typeof value !== 'object') return;
  const status = value as Partial<OpenClawEngineStatus>;
  if (
    !Object.values(EnginePhase).includes(status.phase as OpenClawEngineStatus['phase']) ||
    typeof status.canRetry !== 'boolean' ||
    !(status.version === null || typeof status.version === 'string') ||
    !(status.diagnosticId === undefined || typeof status.diagnosticId === 'string') ||
    !(status.message === undefined || typeof status.message === 'string')
  )
    return;
  return status as OpenClawEngineStatus;
}

/** A status-only bridge: no Cowork service, Redux, Gateway connection or log scan. */
export function useStartupEngine(enabled = true) {
  const [status, setStatus] = useState<OpenClawEngineStatus>();
  const [failureStatus, setFailureStatus] = useState<OpenClawEngineStatus>();
  const [commandError, setCommandError] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const active = useRef(false);
  const revision = useRef(0);
  const command = useRef(false);
  useEffect(() => {
    active.current = true;
    const api = window.electron?.openclaw?.engine;
    if (!enabled || !api || window.electron?.initialization?.isTransientWindow)
      return () => {
        active.current = false;
      };
    let live = true;
    const accept = (value: unknown) => {
      const next = engineStatus(value);
      if (!live || !next) return;
      revision.current += 1;
      setStatus(next);
      if (next.phase === EnginePhase.Error) setFailureStatus(next);
      setCommandError(null);
    };
    const unsubscribe = api.onProgress(accept);
    const reading = revision.current;
    void api
      .getStatus()
      .then(result => {
        if (result.success && revision.current === reading) accept(result.status);
      })
      .catch(() => {
        /* Engine handlers can still be registering during first setup. */
      });
    return () => {
      live = false;
      active.current = false;
      unsubscribe();
    };
  }, [enabled]);
  const start = useCallback(async () => {
    const api = window.electron?.openclaw?.engine;
    if (!api || command.current) return;
    command.current = true;
    setStarting(true);
    // Unmount the existing collector before a new engine generation starts.
    setDiagnosticsOpen(false);
    setCommandError(null);
    const before = revision.current;
    try {
      const result = await api.startGateway();
      if (!active.current) return;
      const next = engineStatus(result.status);
      if (next && revision.current === before) {
        setStatus(next);
        if (next.phase === EnginePhase.Error) setFailureStatus(next);
      }
      if (!result.success && revision.current === before)
        setCommandError(redactLogText(result.error || next?.message || ''));
    } catch (error) {
      if (active.current && revision.current === before)
        setCommandError(redactLogText(String(error)));
    } finally {
      command.current = false;
      if (active.current) setStarting(false);
    }
  }, []);
  return {
    status,
    diagnosticStatus: failureStatus ?? status,
    commandError,
    diagnosticsOpen,
    setDiagnosticsOpen,
    starting,
    start,
  };
}
