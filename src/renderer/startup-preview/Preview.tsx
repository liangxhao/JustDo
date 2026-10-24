import './preview.css';

import {
  AppInitializationActivity,
  AppInitializationPhase,
  type AppInitializationState,
} from '@shared/app/initialization';
import { StartupRoute } from '@shared/app/startup/routing';
import { EnginePhase } from '@shared/openclaw/engineStatus';
import { useEffect, useState } from 'react';

import FirstLaunchGuide from '@/app/shell/startup/initialization/FirstLaunchGuide';
import StartupFailureDetails from '@/app/shell/startup/initialization/StartupFailureDetails';
import StartupScreen from '@/app/shell/startup/initialization/StartupScreen';
import { i18nService } from '@/services/i18n';

import { createPreviewState, PreviewFailureKind, type PreviewOptions, previewSteps } from './state';
import { previewTranslations } from './translations';

export default function Preview({ options }: { options: PreviewOptions }) {
  const [language, setLanguage] = useState(options.language);
  const [theme, setTheme] = useState(options.theme);
  const [phase, setPhase] = useState<AppInitializationState['phase']>(
    AppInitializationPhase.Preparing,
  );
  const [index, setIndex] = useState(0);
  const [nativeActivity, setNativeActivity] = useState<AppInitializationActivity>(
    AppInitializationActivity.NativeInspect,
  );
  const [startedAt, setStartedAt] = useState(Date.now);
  const [activityStartedAt, setActivityStartedAt] = useState(Date.now);
  const [action, setAction] = useState('');
  const [failureKind, setFailureKind] = useState<PreviewFailureKind>(PreviewFailureKind.Generic);
  const copy = previewTranslations[language];
  const steps = previewSteps(options.route);
  const state = createPreviewState(
    { ...options, language, theme },
    index,
    phase,
    startedAt,
    nativeActivity,
    failureKind,
    activityStartedAt,
  );
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = copy.title;
    document.documentElement.dataset.theme = theme === 'dark' ? 'classic-dark' : 'classic-light';
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [language, theme, copy.title]);
  useEffect(() => {
    const onAction = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === 'confirmDowngrade') {
        setFailureKind(PreviewFailureKind.Generic);
        setPhase(AppInitializationPhase.Preparing);
        setActivityStartedAt(Date.now());
      }
      setAction(copy.actions);
    };
    window.addEventListener('startup-preview-action', onAction);
    return () => window.removeEventListener('startup-preview-action', onAction);
  }, [copy.actions]);
  const reset = () => {
    setIndex(0);
    setPhase(AppInitializationPhase.Preparing);
    setStartedAt(Date.now());
    setActivityStartedAt(Date.now());
    setAction('');
  };
  const changeLanguage = (value: PreviewOptions['language']) => {
    i18nService.setLanguage(value, { persist: false });
    document.documentElement.lang = value;
    setLanguage(value);
  };
  const link = (route: StartupRoute) => `?${new URLSearchParams({ route, language, theme })}`;
  return (
    <div className="startup-preview-shell">
      <aside className="startup-preview-controls" aria-label={copy.title}>
        <strong>{copy.title}</strong>
        <p>{copy.notice}</p>
        <nav>
          {Object.values(StartupRoute).map(route => (
            <a
              key={route}
              href={link(route)}
              aria-current={options.route === route ? 'page' : undefined}
            >
              {copy.routes[route]}
            </a>
          ))}
        </nav>
        <div className="startup-preview-fields">
          <label>
            {copy.language}
            <select
              value={language}
              onChange={event => changeLanguage(event.target.value as PreviewOptions['language'])}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <label>
            {copy.theme}
            <select
              value={theme}
              onChange={event => setTheme(event.target.value as PreviewOptions['theme'])}
            >
              <option value="light">{copy.light}</option>
              <option value="dark">{copy.dark}</option>
            </select>
          </label>
          <label>
            {copy.phase}
            <select
              value={phase}
              onChange={event => setPhase(event.target.value as AppInitializationState['phase'])}
            >
              {Object.values(AppInitializationPhase).map(value => (
                <option key={value} value={value}>
                  {copy[value]}
                </option>
              ))}
            </select>
          </label>
          {phase === AppInitializationPhase.Failed && (
            <label>
              {copy.failureKind}
              <select
                value={failureKind}
                onChange={event => setFailureKind(event.target.value as PreviewFailureKind)}
              >
                {Object.values(PreviewFailureKind).map(kind => (
                  <option key={kind} value={kind}>
                    {copy.failureKinds[kind]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {copy.step}
            <select
              value={index}
              onChange={event => {
                setIndex(Number(event.target.value));
                setActivityStartedAt(Date.now());
              }}
            >
              {steps.map((step, position) => (
                <option key={step} value={position}>
                  {position + 1} ·{' '}
                  {i18nService.t(
                    options.route === StartupRoute.Normal
                      ? `startupStep_${step}`
                      : step === 'databaseUpgrade'
                        ? 'initializationDatabaseUpgrade'
                        : options.route === StartupRoute.Upgrade && step === 'userData'
                          ? 'initializationRetainedData'
                          : `initialization${step[0].toUpperCase()}${step.slice(1)}`,
                  )}
                </option>
              ))}
            </select>
          </label>
          {options.route === StartupRoute.Upgrade && index === 0 && (
            <label>
              {copy.operation}
              <select
                value={nativeActivity}
                onChange={event => {
                  setNativeActivity(event.target.value as AppInitializationActivity);
                  setActivityStartedAt(Date.now());
                }}
              >
                {(
                  [
                    AppInitializationActivity.NativeInspect,
                    AppInitializationActivity.NativeBackup,
                    AppInitializationActivity.NativeUpgrade,
                    AppInitializationActivity.NativeVerify,
                  ] as const
                ).map(value => (
                  <option key={value} value={value}>
                    {copy[value]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" onClick={reset}>
            {copy.reset}
          </button>
        </div>
        {action && <p role="status">{action}</p>}
      </aside>
      <div className="startup-preview-surface" key={`${options.route}:${language}`}>
        {options.route === StartupRoute.Normal ? (
          <StartupScreen
            state={state}
            onRetry={reset}
            engineStatus={{
              phase:
                phase === AppInitializationPhase.Ready
                  ? EnginePhase.Running
                  : index === steps.length - 1
                    ? phase === AppInitializationPhase.Failed
                      ? EnginePhase.Error
                      : EnginePhase.Starting
                    : EnginePhase.Ready,
              version: null,
              canRetry: false,
            }}
            rendererReady={phase === AppInitializationPhase.Ready}
            diagnostics={state.failure && <StartupFailureDetails failure={state.failure} />}
          />
        ) : (
          <FirstLaunchGuide
            state={state}
            onRetry={reset}
            historyReady={
              options.route === StartupRoute.Migration && phase === AppInitializationPhase.Ready
            }
            onContinue={() => setAction(copy.continued)}
          />
        )}
      </div>
    </div>
  );
}
