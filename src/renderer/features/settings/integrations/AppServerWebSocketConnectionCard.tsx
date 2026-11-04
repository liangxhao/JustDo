import './AppServerWebSocketConnectionCard.css';

import {
  ArrowPathIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  ClockIcon,
  InformationCircleIcon,
  LinkIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import {
  AppServerIntegrationFailure,
  type AppServerIntegrationStatus,
  isAppServerPort,
} from '@shared/integrations/appServerIntegration';
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

const PortMode = { Automatic: 'automatic', Fixed: 'fixed' } as const;
type PortMode = (typeof PortMode)[keyof typeof PortMode];

const fixedPortFor = (status: AppServerIntegrationStatus): string => {
  if (status.configuredPort > 0) return String(status.configuredPort);
  try {
    const port = Number(new URL(status.url).port);
    return isAppServerPort(port) && port > 0 ? String(port) : '';
  } catch {
    return '';
  }
};

const AppServerWebSocketConnectionCard: React.FC = () => {
  const titleId = useId();
  const portId = useId();
  const portHelpId = useId();
  const portErrorId = useId();
  const settingsId = useId();
  const [status, setStatus] = useState<AppServerIntegrationStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [portMode, setPortMode] = useState<PortMode>(PortMode.Automatic);
  const [portInput, setPortInput] = useState('');
  const [portTouched, setPortTouched] = useState(false);
  const [tokenChanged, setTokenChanged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const portDraftEdited = useRef(false);
  const copyRevision = useRef(0);
  const copyTimer = useRef<number>();
  const portInputRef = useRef<HTMLInputElement>(null);

  const resetPortDraft = useCallback((next: AppServerIntegrationStatus) => {
    portDraftEdited.current = false;
    setPortMode(next.configuredPort === 0 ? PortMode.Automatic : PortMode.Fixed);
    setPortInput(fixedPortFor(next));
    setPortTouched(false);
  }, []);

  const resetCopy = useCallback(() => {
    copyRevision.current += 1;
    window.clearTimeout(copyTimer.current);
    setCopied(false);
  }, []);

  const load = useCallback(async () => {
    const current = ++generation.current;
    resetCopy();
    setBusy(true);
    try {
      const next = await window.electron.appServer.getStatus();
      if (generation.current !== current) return;
      setStatus(next);
      if (!portDraftEdited.current) resetPortDraft(next);
      if (!next.restartRequired) setTokenChanged(false);
      setError('');
      setNotice('');
    } catch {
      if (generation.current !== current) return;
      setStatus(null);
      setError(i18nService.t('appServerWebSocketStatusFailed'));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }, [resetCopy, resetPortDraft]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
      copyRevision.current += 1;
      window.clearTimeout(copyTimer.current);
    };
  }, [load]);

  const copy = async () => {
    if (!status?.running || !status.url || busy || saving) return;
    const current = ++copyRevision.current;
    window.clearTimeout(copyTimer.current);
    setCopied(false);
    try {
      // Fetch credentials only for this copy operation, never into view state.
      const config = await window.electron.appServer.getConnectionConfig();
      if (copyRevision.current !== current) return;
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      if (copyRevision.current !== current) return;
      setError('');
      setCopied(true);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      if (copyRevision.current === current)
        setError(i18nService.t('appServerWebSocketCopyFailed'));
    }
  };

  const updateSettings = async (
    update: () => Promise<AppServerIntegrationStatus>,
    updatePort: boolean,
  ) => {
    if (busy || saving || !status) return;
    const current = ++generation.current;
    resetCopy();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const next = await update();
      if (generation.current !== current) return;
      setStatus(next);
      if (updatePort) {
        resetPortDraft(next);
      } else {
        setTokenChanged(next.restartRequired);
      }
      setNotice(i18nService.t(
        updatePort ? 'appServerWebSocketSettingsSaved' : 'appServerWebSocketTokenSaved',
      ));
    } catch {
      if (generation.current === current) {
        setError(i18nService.t(
          updatePort ? 'appServerWebSocketSaveFailed' : 'appServerWebSocketTokenFailed',
        ));
      }
    } finally {
      if (generation.current === current) setSaving(false);
    }
  };

  const port = portMode === PortMode.Automatic ? 0 : portInput.trim() === '' ? NaN : Number(portInput);
  const validPort = isAppServerPort(port) && (portMode === PortMode.Automatic || port > 0);
  const invalidPort = portTouched && !validPort;
  const changed = Boolean(status && (!validPort || port !== status.configuredPort));
  const disabled = busy || saving;
  const ready = status?.running === true;
  const statusKey = busy
    ? 'appServerWebSocketLoading'
    : ready
      ? 'appServerWebSocketReady'
      : 'appServerWebSocketNotReady';

  const changeMode = (mode: PortMode) => {
    portDraftEdited.current = true;
    setPortMode(mode);
    setPortTouched(false);
    setNotice('');
  };

  const savePort = () => {
    if (!validPort) {
      setPortTouched(true);
      portInputRef.current?.focus();
      return;
    }
    void updateSettings(() => window.electron.appServer.setPort(port), true);
  };

  return (
    <section
      aria-labelledby={titleId}
      className="app-server-connection flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-muted text-primary">
            <LinkIcon className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h5 id={titleId} className="text-sm font-semibold text-foreground">{i18nService.t('appServerWebSocketTitle')}</h5>
            <p className="mt-0.5 text-xs text-secondary">{i18nService.t('appServerWebSocketDescription')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span role="status" className={`inline-flex items-center gap-1.5 text-xs ${ready && !busy ? 'text-success' : 'text-secondary'}`}>
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
            {i18nService.t(statusKey)}
          </span>
          <button
            type="button"
            disabled={disabled}
            aria-label={i18nService.t('appServerWebSocketRefresh')}
            onClick={() => void load()}
            className="rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          >
            <ArrowPathIcon className={`app-server-refresh h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="min-w-0 space-y-2">
        <p className="text-xs text-secondary">{i18nService.t('appServerWebSocketAddress')}</p>
        <code className="block min-w-0 select-all whitespace-pre-wrap break-all rounded-xl bg-surface-raised px-3.5 py-3 font-mono text-xs leading-6 text-foreground">
          {status?.url || '—'}
        </code>
      </div>
      <button
        type="button"
        disabled={disabled || !ready || !status?.url}
        onClick={() => void copy()}
        className="inline-flex w-fit shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
      >
        {copied ? <CheckIcon className="h-3.5 w-3.5" aria-hidden="true" /> : <ClipboardDocumentIcon className="h-3.5 w-3.5" aria-hidden="true" />}
        {i18nService.t(copied ? 'appServerWebSocketCopied' : 'appServerWebSocketCopyConfig')}
      </button>
      <div className="border-t border-border/70 pt-3">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={settingsId}
          onClick={() => setExpanded(value => !value)}
          className="flex w-full items-center justify-between gap-3 rounded-md py-1 text-left text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <span>{i18nService.t('appServerWebSocketSettings')}</span>
          <span className="flex items-center gap-2">
            {changed && <span className="font-normal text-warning">{i18nService.t('appServerWebSocketUnsaved')}</span>}
            <ChevronDownIcon className={`app-server-settings-chevron h-4 w-4 shrink-0 ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
          </span>
        </button>
        <div id={settingsId} hidden={!expanded} className="space-y-5 pt-5">
          <div className="app-server-port-row">
            <span className="app-server-port-label text-xs font-medium text-foreground">{i18nService.t('appServerWebSocketPort')}</span>
            <div className="app-server-port-controls">
              <div role="group" aria-label={i18nService.t('appServerWebSocketPort')} className="app-server-port-modes inline-flex shrink-0 gap-0.5 rounded-lg bg-surface-raised p-0.5">
                {Object.values(PortMode).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={portMode === mode}
                    disabled={disabled || !status}
                    onClick={() => changeMode(mode)}
                    className={`rounded-md px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50 ${portMode === mode ? 'bg-surface font-medium text-foreground shadow-sm' : 'text-secondary hover:text-foreground'}`}
                  >
                    {i18nService.t(mode === PortMode.Automatic ? 'appServerWebSocketAutomatic' : 'appServerWebSocketFixed')}
                  </button>
                ))}
              </div>
              {portMode === PortMode.Fixed && (
                <input
                  ref={portInputRef}
                  id={portId}
                  type="number"
                  min={1}
                  max={65535}
                  step={1}
                  inputMode="numeric"
                  value={portInput}
                  disabled={disabled || !status}
                  aria-label={i18nService.t('appServerWebSocketPort')}
                  aria-describedby={`${portHelpId}${invalidPort ? ` ${portErrorId}` : ''}`}
                  aria-invalid={invalidPort}
                  onChange={event => {
                    const value = event.target.value;
                    portDraftEdited.current = true;
                    setPortInput(value);
                    setPortTouched(false);
                    setNotice('');
                  }}
                  onBlur={() => setPortTouched(true)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && changed && !disabled) {
                      event.preventDefault();
                      savePort();
                    }
                  }}
                  className={`app-server-port-input h-8 rounded-lg border bg-surface px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50 ${invalidPort ? 'border-destructive' : 'border-border'}`}
                />
              )}
            </div>
            <div className="app-server-port-detail space-y-2">
              <p id={portHelpId} className="text-xs leading-5 text-secondary">
                {i18nService.t(portMode === PortMode.Automatic ? 'appServerWebSocketAutomaticHint' : 'appServerWebSocketFixedHint')}
              </p>
              {invalidPort && <p id={portErrorId} role="alert" className="text-xs text-destructive">{i18nService.t('appServerWebSocketPortInvalid')}</p>}
              {changed && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={disabled || !status}
                    onClick={savePort}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
                  >
                    {i18nService.t('appServerWebSocketSavePort')}
                  </button>
                  <button
                    type="button"
                    disabled={disabled || !status}
                    onClick={() => { if (status) resetPortDraft(status); }}
                    className="rounded-lg px-2 py-1.5 text-xs text-secondary transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
                  >
                    {i18nService.t('appServerWebSocketCancel')}
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="app-server-token-row">
            <span className="text-xs font-medium text-foreground">{i18nService.t('appServerWebSocketToken')}</span>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <span className="flex min-w-0 items-center gap-1.5 text-xs leading-5 text-secondary">
                <ShieldCheckIcon className={`h-4 w-4 shrink-0 ${status ? 'text-success' : 'text-secondary'}`} aria-hidden="true" />
                {status && i18nService.t(status.restartRequired
                  ? tokenChanged ? 'appServerWebSocketTokenPending' : 'appServerWebSocketTokenStoredPending'
                  : 'appServerWebSocketTokenStored')}
              </span>
              <button
                type="button"
                disabled={disabled || !status}
                onClick={() => void updateSettings(() => window.electron.appServer.regenerateToken(), false)}
                className="shrink-0 rounded-md py-1 text-xs text-primary transition-colors hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
              >
                {i18nService.t('appServerWebSocketRegenerateToken')}
              </button>
            </div>
          </div>
          {!status?.restartRequired && (
            <p className="flex items-start gap-1.5 text-xs leading-5 text-secondary">
              <InformationCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {i18nService.t('appServerWebSocketApplyHint')}
            </p>
          )}
        </div>
      </div>
      {status?.restartRequired && (
        <p className="app-server-pending-notice flex items-start gap-2 rounded-lg px-3 py-2.5 text-xs leading-5 text-warning" aria-live="polite">
          <ClockIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {i18nService.t('appServerWebSocketRestartRequired')}
        </p>
      )}
      {status?.failure && (
        <p role="alert" className="text-xs leading-5 text-destructive">
          {i18nService.t(status.failure === AppServerIntegrationFailure.PortInUse
            ? 'appServerWebSocketPortInUse'
            : 'appServerWebSocketUnavailable')}
        </p>
      )}
      {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}
      {notice && !status?.restartRequired && <p className="text-xs leading-5 text-success" aria-live="polite">{notice}</p>}
      <span className="sr-only" aria-live="polite">
        {copied ? i18nService.t('appServerWebSocketCopied') : ''}
      </span>
    </section>
  );
};

export default AppServerWebSocketConnectionCard;
