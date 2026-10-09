import {
  ArrowPathIcon,
  CheckCircleIcon,
  PencilSquareIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { type CustomProxyConfig, ProxyMode } from '@shared/network/proxy';
import type { GatewayPortInputValidation } from '@shared/openclaw/gatewayPort';
import React from 'react';

import AppUpdateFrequencySetting from '@/features/settings/updates/AppUpdateFrequencySetting';
import { i18nService, LanguageType } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

import { ProxySettingsSection } from './ProxySettingsSection';

interface GeneralSettingsPageProps {
  language: LanguageType;
  setLanguage: React.Dispatch<React.SetStateAction<LanguageType>>;
  autoLaunch: boolean;
  isUpdatingAutoLaunch: boolean;
  setIsUpdatingAutoLaunch: React.Dispatch<React.SetStateAction<boolean>>;
  setAutoLaunchState: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  preventSleep: boolean;
  isUpdatingPreventSleep: boolean;
  setIsUpdatingPreventSleep: React.Dispatch<React.SetStateAction<boolean>>;
  setPreventSleepState: React.Dispatch<React.SetStateAction<boolean>>;
  developerModeAvailable: boolean;
  developerMode: boolean;
  setDeveloperMode: React.Dispatch<React.SetStateAction<boolean>>;
  proxyMode: ProxyMode;
  handleProxyModeChange: (mode: ProxyMode) => void;
  customProxy: CustomProxyConfig;
  handleCustomProxyChange: (key: keyof CustomProxyConfig, value: string) => void;
  isSaving: boolean;
  openClawGatewayPortInputRef: React.RefObject<HTMLInputElement>;
  openClawGatewayPortInput: string;
  openClawGatewayPortEditing: boolean;
  setOpenClawGatewayPortEditing: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenClawGatewayPortError: React.Dispatch<React.SetStateAction<string | null>>;
  setOpenClawGatewayPortInput: React.Dispatch<React.SetStateAction<string>>;
  openClawGatewayPortValidation: GatewayPortInputValidation;
  handleSaveOpenClawGatewayPort: () => Promise<void>;
  cancelOpenClawGatewayPortEditing: () => void;
  openClawGatewayPortValidationError: string | null;
  openClawGatewayPortSaving: boolean;
  handleRestartOpenClawGateway: () => Promise<void>;
  isRestartingOpenClawGateway: boolean;
  openClawGatewayPortError: string | null;
  openClawGatewayPortRestartRequired: boolean;
}

export function GeneralSettingsPage({
  language,
  setLanguage,
  autoLaunch,
  isUpdatingAutoLaunch,
  setIsUpdatingAutoLaunch,
  setAutoLaunchState,
  setError,
  preventSleep,
  isUpdatingPreventSleep,
  setIsUpdatingPreventSleep,
  setPreventSleepState,
  developerModeAvailable,
  developerMode,
  setDeveloperMode,
  proxyMode,
  handleProxyModeChange,
  customProxy,
  handleCustomProxyChange,
  isSaving,
  openClawGatewayPortInputRef,
  openClawGatewayPortInput,
  openClawGatewayPortEditing,
  setOpenClawGatewayPortEditing,
  setOpenClawGatewayPortError,
  setOpenClawGatewayPortInput,
  openClawGatewayPortValidation,
  handleSaveOpenClawGatewayPort,
  cancelOpenClawGatewayPortEditing,
  openClawGatewayPortValidationError,
  openClawGatewayPortSaving,
  handleRestartOpenClawGateway,
  isRestartingOpenClawGateway,
  openClawGatewayPortError,
  openClawGatewayPortRestartRequired,
}: GeneralSettingsPageProps) {
  return (
    <div className="space-y-8">
      <section aria-labelledby="general-behavior-heading">
        <h4 id="general-behavior-heading" className="mb-3 text-sm font-semibold text-foreground">
          {i18nService.t('settingsGeneralBehavior')}
        </h4>
        <div className="divide-y divide-border-subtle rounded-2xl border border-border-subtle bg-surface-raised/50 px-5">
          {/* Language Section */}
          <div className="flex items-center justify-between gap-6 py-4">
            <div>
              <h4 className="text-sm font-medium text-foreground">{i18nService.t('language')}</h4>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('settingsLanguageDescription')}
              </p>
            </div>
            <div className="w-[140px] shrink-0">
              <ThemedSelect
                id="language"
                ariaLabel={i18nService.t('language')}
                value={language}
                onChange={value => {
                  const nextLanguage = value as LanguageType;
                  setLanguage(nextLanguage);
                  i18nService.setLanguage(nextLanguage, { persist: false });
                }}
                options={[
                  { value: 'zh', label: i18nService.t('chinese') },
                  { value: 'en', label: i18nService.t('english') },
                ]}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-6 py-4">
            <div className="min-w-0">
              <h4 className="text-sm font-medium text-foreground">{i18nService.t('autoLaunch')}</h4>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('autoLaunchDescription')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label={i18nService.t('autoLaunch')}
              aria-checked={autoLaunch}
              onClick={async () => {
                if (isUpdatingAutoLaunch) return;
                const next = !autoLaunch;
                setIsUpdatingAutoLaunch(true);
                try {
                  const result = await window.electron.autoLaunch.set(next);
                  if (result.success) {
                    setAutoLaunchState(next);
                  } else {
                    setError(result.error || 'Failed to update auto-launch setting');
                  }
                } catch (err) {
                  console.error('Failed to set auto-launch:', err);
                  setError('Failed to update auto-launch setting');
                } finally {
                  setIsUpdatingAutoLaunch(false);
                }
              }}
              disabled={isUpdatingAutoLaunch}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                isUpdatingAutoLaunch ? 'opacity-50 cursor-not-allowed' : ''
              } ${autoLaunch ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  autoLaunch ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="flex items-center justify-between gap-6 py-4">
            <div className="min-w-0">
              <h4 className="text-sm font-medium text-foreground">
                {i18nService.t('preventSleep')}
              </h4>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('preventSleepDescription')}
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label={i18nService.t('preventSleep')}
              aria-checked={preventSleep}
              onClick={async () => {
                if (isUpdatingPreventSleep) return;
                const next = !preventSleep;
                setIsUpdatingPreventSleep(true);
                try {
                  const result = await window.electron.preventSleep.set(next);
                  if (result.success) {
                    setPreventSleepState(next);
                  } else {
                    setError(result.error || 'Failed to update prevent-sleep setting');
                  }
                } catch (err) {
                  console.error('Failed to set prevent-sleep:', err);
                  setError('Failed to update prevent-sleep setting');
                } finally {
                  setIsUpdatingPreventSleep(false);
                }
              }}
              disabled={isUpdatingPreventSleep}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                isUpdatingPreventSleep ? 'opacity-50 cursor-not-allowed' : ''
              } ${preventSleep ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  preventSleep ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          <div className="py-4">
            <AppUpdateFrequencySetting />
          </div>
        </div>
      </section>

      {/* Developer Mode Section */}
      {developerModeAvailable && (
        <div>
          <h4 className="text-sm font-medium text-foreground mb-3">
            {i18nService.t('developerMode')}
          </h4>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-sm text-secondary">
              {i18nService.t('developerModeDescription')}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={developerMode}
              onClick={() => {
                setDeveloperMode(prev => !prev);
              }}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                developerMode ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  developerMode ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </label>
        </div>
      )}

      {developerModeAvailable && developerMode && (
        <>
          <ProxySettingsSection
            id="application-proxy"
            titleKey="proxySettings"
            descriptionKey="applicationProxyDescription"
            proxyMode={proxyMode}
            handleProxyModeChange={handleProxyModeChange}
            customProxy={customProxy}
            handleCustomProxyChange={handleCustomProxyChange}
            isSaving={isSaving}
          />

          {/* Gateway Port Configuration */}
          <div className="space-y-3 rounded-xl border px-4 py-4 border-border">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-sm font-medium text-foreground">
                  {i18nService.t('openclawGatewayPortTitle')}
                </div>
                <input
                  ref={openClawGatewayPortInputRef}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={openClawGatewayPortInput}
                  readOnly={!openClawGatewayPortEditing}
                  onDoubleClick={() => {
                    setOpenClawGatewayPortEditing(true);
                    setOpenClawGatewayPortError(null);
                  }}
                  onChange={e => {
                    setOpenClawGatewayPortInput(e.target.value);
                    setOpenClawGatewayPortError(null);
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && openClawGatewayPortValidation.valid) {
                      event.preventDefault();
                      void handleSaveOpenClawGatewayPort();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelOpenClawGatewayPortEditing();
                    }
                  }}
                  aria-invalid={
                    openClawGatewayPortEditing && Boolean(openClawGatewayPortValidationError)
                  }
                  aria-describedby="openclaw-gateway-port-help"
                  className={`w-32 rounded-lg border px-3 py-1.5 text-center text-sm font-mono bg-surface ${
                    openClawGatewayPortEditing && openClawGatewayPortValidationError
                      ? 'border-danger text-foreground'
                      : 'border-border'
                  } ${
                    openClawGatewayPortEditing ? 'text-foreground' : 'cursor-default text-secondary'
                  }`}
                  disabled={openClawGatewayPortSaving}
                />
                {openClawGatewayPortEditing && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void handleSaveOpenClawGatewayPort()}
                      disabled={openClawGatewayPortSaving || !openClawGatewayPortValidation.valid}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-primary hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                      aria-label={i18nService.t('save')}
                    >
                      <CheckCircleIcon className="h-5 w-5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={cancelOpenClawGatewayPortEditing}
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                      aria-label={i18nService.t('cancel')}
                    >
                      <XCircleIcon className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </div>
                )}
                {!openClawGatewayPortEditing && (
                  <button
                    type="button"
                    onClick={() => {
                      setOpenClawGatewayPortEditing(true);
                      setOpenClawGatewayPortError(null);
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
                    aria-label={i18nService.t('openclawGatewayPortEdit')}
                    title={i18nService.t('openclawGatewayPortEdit')}
                  >
                    <PencilSquareIcon className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleRestartOpenClawGateway()}
                disabled={
                  isRestartingOpenClawGateway ||
                  openClawGatewayPortEditing ||
                  openClawGatewayPortSaving
                }
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium border-border text-secondary hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                title={i18nService.t('openclawGatewayRestartHint')}
              >
                <ArrowPathIcon
                  className={`h-4 w-4 ${isRestartingOpenClawGateway ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                {isRestartingOpenClawGateway
                  ? i18nService.t('openclawGatewayRestarting')
                  : i18nService.t('coworkOpenClawRestartGateway')}
              </button>
            </div>
            <div id="openclaw-gateway-port-help" className="space-y-1 text-xs">
              <p className="text-secondary">{i18nService.t('openclawGatewayPortHint')}</p>
              {openClawGatewayPortEditing && openClawGatewayPortValidationError && (
                <p className="text-danger" role="alert">
                  {openClawGatewayPortValidationError}
                </p>
              )}
              {openClawGatewayPortEditing &&
                openClawGatewayPortValidation.valid &&
                openClawGatewayPortValidation.usesEphemeralRange && (
                  <p className="text-warning">
                    {i18nService.t('openclawGatewayPortEphemeralWarning')}
                  </p>
                )}
              {openClawGatewayPortError && (
                <p className="text-danger" role="alert">
                  {openClawGatewayPortError}
                </p>
              )}
              {openClawGatewayPortRestartRequired && (
                <p className="text-warning" role="status">
                  {i18nService.t('openclawGatewayPortRestartRequired')}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
