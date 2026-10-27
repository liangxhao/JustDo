import { useEffect, useRef, useState } from 'react';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import ArrowUpRightIcon from '@/shared/components/icons/ArrowUpRightIcon';

interface ControlUiSettingProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  isSaving: boolean;
}

const isControlUiSavedEnabled = () => {
  const config = configService.getConfig();
  return config.developerMode === true && config.controlUiEnabled === true;
};

export function ControlUiSetting({ enabled, onChange, isSaving }: ControlUiSettingProps) {
  const [savedEnabled, setSavedEnabled] = useState(isControlUiSavedEnabled);
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const syncSavedEnabled = () => {
      const nextEnabled = isControlUiSavedEnabled();
      setSavedEnabled(nextEnabled);
      if (!nextEnabled) {
        requestRef.current += 1;
        setIsOpening(false);
      }
    };
    window.addEventListener('config-updated', syncSavedEnabled);
    return () => {
      requestRef.current += 1;
      window.removeEventListener('config-updated', syncSavedEnabled);
    };
  }, []);

  useEffect(() => {
    // A changed draft or an in-progress save revokes an earlier launch request.
    requestRef.current += 1;
    setIsOpening(false);
    setError(null);
  }, [enabled, isSaving]);

  const handleOpenChatWeb = async () => {
    if (!enabled || isSaving || isOpening || !isControlUiSavedEnabled()) return;
    const request = ++requestRef.current;
    const isCurrent = () => request === requestRef.current && isControlUiSavedEnabled();
    setIsOpening(true);
    setError(null);
    try {
      const engine = window.electron?.openclaw?.engine;
      if (!engine?.getPort || !engine?.getToken) {
        setError(i18nService.t('coworkErrorEngineNotReady'));
        return;
      }
      const portResult = await engine.getPort();
      if (!isCurrent()) return;
      const tokenResult = await engine.getToken();
      if (!isCurrent()) return;
      const port = portResult.success ? portResult.port : null;
      const token = tokenResult.success ? tokenResult.token : null;
      if (!port) {
        setError(i18nService.t('chatWebPortError'));
        return;
      }
      if (!token) {
        setError(i18nService.t('chatWebTokenError'));
        return;
      }
      const result = await window.electron.shell.openExternal(
        `http://127.0.0.1:${port}/#token=${token}`,
      );
      if (isCurrent() && !result.success) {
        setError(i18nService.t('controlUiOpenFailed'));
      }
    } catch {
      if (isCurrent()) setError(i18nService.t('coworkErrorEngineNotReady'));
    } finally {
      if (isCurrent()) setIsOpening(false);
    }
  };

  return (
    <div className="space-y-4 py-5">
      <div className="flex items-center justify-between gap-6">
        <div>
          <h4 className="text-sm font-medium text-foreground">{i18nService.t('controlUiTitle')}</h4>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('controlUiDescription')}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label={i18nService.t('controlUiTitle')}
          aria-checked={enabled}
          disabled={isSaving}
          onClick={() => onChange(!enabled)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-50 ${
            enabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
      {enabled && (
        <div className="space-y-3 rounded-xl bg-surface-raised px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-xs leading-5 text-secondary">
                {i18nService.t('controlUiBrowserDescription')}
              </p>
              {!savedEnabled && (
                <p id="control-ui-save-hint" className="text-xs leading-5 text-secondary">
                  {i18nService.t('controlUiSaveBeforeOpen')}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void handleOpenChatWeb()}
              disabled={isSaving || isOpening || !savedEnabled}
              aria-describedby={!savedEnabled ? 'control-ui-save-hint' : undefined}
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {i18nService.t('openChatWeb')}
              <ArrowUpRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
