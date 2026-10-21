import { type ReactNode, useContext, useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

import {
  type RendererStartupActivity,
  StartupStartedAtContext,
} from '../initialization/startupPresentation';
import StartupFrame, { startupDuration } from './StartupFrame';
import StartupSteps from './StartupSteps';

/** Renderer work has no measurable byte total; never invent a percentage. */
export default function StartupLoading({ activity, diagnostics }: { activity?: RendererStartupActivity; diagnostics?: ReactNode }) {
  const [startedAt] = useState(Date.now);
  const launchStartedAt = useContext(StartupStartedAtContext) ?? startedAt;
  const [activityStartedAt, setActivityStartedAt] = useState(startedAt);
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    setActivityStartedAt(Date.now());
  }, [activity]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - launchStartedAt) / 1000));
  const activitySeconds = Math.max(0, Math.floor((now - activityStartedAt) / 1000));
  const key = activity ? `startupRenderer_${activity}` : 'startupConnecting';
  return (
    <div className="startup-screen">
      <StartupFrame>
        <section className="startup-activity" role="status" aria-live="polite" aria-atomic="true">
          <p className="startup-label">{i18nService.t('startupCurrentActivity')}</p>
          <h2 className="startup-operation">{i18nService.t(key)}</h2>
          <p className="startup-operation-detail">{i18nService.t(`${key}Description`)}</p>
        </section>
        {diagnostics}
        <div className="startup-metrics">
          <span>{i18nService.t('startupLoadingLabel')}</span>
          <span>
            {i18nService.t('startupElapsed')} <strong>{startupDuration(seconds)}</strong>
          </span>
        </div>
        <div
          className="startup-progress startup-progress--indeterminate"
          role="progressbar"
          aria-label={i18nService.t(key)}
        >
          <div className="startup-progress-fill" />
        </div>
        <StartupSteps />
        <p className="startup-hint" data-waiting={activitySeconds >= 30}>
          {i18nService.t(
            activitySeconds >= 90
              ? 'startupExtendedWait'
              : activitySeconds >= 30
                ? 'startupLongWait'
                : 'startupContinue',
          )}
        </p>
      </StartupFrame>
    </div>
  );
}
