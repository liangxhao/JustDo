import {
  AppUpdateCheckFrequency,
  type AppUpdateCheckFrequency as AppUpdateCheckFrequencyValue,
  DEFAULT_APP_UPDATE_CHECK_FREQUENCY,
} from '@shared/appUpdate';
import React, { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

const AppUpdateFrequencySetting: React.FC = () => {
  const [frequency, setFrequency] = useState<AppUpdateCheckFrequencyValue>(
    DEFAULT_APP_UPDATE_CHECK_FREQUENCY,
  );
  const [supported, setSupported] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    void window.electron.appUpdate
      .getPreferences()
      .then(preferences => {
        if (!active) return;
        setFrequency(preferences.checkFrequency);
        setSupported(preferences.supported);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleFrequencyChange = async (value: string) => {
    if (isSaving) return;
    const nextFrequency = value as AppUpdateCheckFrequencyValue;
    const previousFrequency = frequency;
    setFrequency(nextFrequency);
    setIsSaving(true);
    setError(false);
    try {
      const preferences = await window.electron.appUpdate.setCheckFrequency(nextFrequency);
      setFrequency(preferences.checkFrequency);
    } catch {
      setFrequency(previousFrequency);
      setError(true);
    } finally {
      setIsSaving(false);
    }
  };

  const scheduleHintKey =
    frequency === AppUpdateCheckFrequency.Never
      ? 'appUpdateFrequencyNeverHint'
      : frequency === AppUpdateCheckFrequency.Weekly
        ? 'appUpdateFrequencyWeeklyHint'
        : 'appUpdateFrequencyDailyHint';

  return (
    <div>
      <h4 className="mb-3 text-sm font-medium text-foreground">
        {i18nService.t('appUpdateFrequencyTitle')}
      </h4>
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <p className="text-sm text-secondary">
            {i18nService.t('appUpdateFrequencyDescription')}
            {!supported && (
              <span className="ml-2 text-xs text-tertiary">
                {i18nService.t('appUpdateStatusUnsupported')}
              </span>
            )}
          </p>
          {supported && (
            <p className="mt-1 text-xs text-tertiary">{i18nService.t(scheduleHintKey)}</p>
          )}
          {error && (
            <p className="mt-1 text-xs text-danger" role="alert">
              {i18nService.t('appUpdateFrequencySaveError')}
            </p>
          )}
        </div>
        <div className="w-[140px] shrink-0">
          <ThemedSelect
            id="app-update-check-frequency"
            ariaLabel={i18nService.t('appUpdateFrequencyTitle')}
            value={frequency}
            disabled={isLoading || isSaving || !supported}
            onChange={value => void handleFrequencyChange(value)}
            options={[
              {
                value: AppUpdateCheckFrequency.Never,
                label: i18nService.t('appUpdateFrequencyNever'),
              },
              {
                value: AppUpdateCheckFrequency.Daily,
                label: i18nService.t('appUpdateFrequencyDaily'),
              },
              {
                value: AppUpdateCheckFrequency.Weekly,
                label: i18nService.t('appUpdateFrequencyWeekly'),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
};

export default AppUpdateFrequencySetting;
