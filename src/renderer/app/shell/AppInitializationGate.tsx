import { AppInitializationPhase, type AppInitializationState } from '@shared/app/initialization';
import React, { useEffect, useState } from 'react';

import StartupLoading from '@/app/shell/StartupLoading';
import WindowHeader from '@/app/shell/window/WindowHeader';
import { i18nService } from '@/services/i18n';

import InitializationScreen from './InitializationScreen';

export default function AppInitializationGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppInitializationState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [, refreshLanguage] = useState(0);
  useEffect(() => {
    document.documentElement.classList.add(`platform-${window.electron.platform}`);
    let active = true;
    let eventReceived = false;
    let shellReady = false;
    const unsubscribe = window.electron.initialization.onChanged(next => {
      eventReceived = true;
      shellReady = next.phase === AppInitializationPhase.Ready;
      if (active) {
        setReadError(null);
        setState(next);
      }
    });
    void window.electron.initialization
      .getState()
      .then(next => {
        if (active && !eventReceived) {
          shellReady = next.phase === AppInitializationPhase.Ready;
          setReadError(null);
          setState(next);
        }
      })
      .catch(error => {
        console.error('[AppInitialization] Failed to read initialization state:', error);
        if (active && !eventReceived) setReadError(String(error));
      });
    void window.electron.appInfo
      .getSystemLocale()
      .then(locale => {
        if (active && !shellReady)
          i18nService.setLanguage(locale.startsWith('zh') ? 'zh' : 'en', { persist: false });
      })
      .catch(error => console.warn('[AppInitialization] Failed to read system locale:', error));
    const unsubscribeLanguage = i18nService.subscribe(() => refreshLanguage(value => value + 1));
    return () => {
      active = false;
      unsubscribe();
      unsubscribeLanguage();
    };
  }, []);
  if (readError)
    return (
      <div className="flex h-screen flex-col">
        <WindowHeader />
        <main role="alert" className="space-y-3 p-8">
          <h1>{i18nService.t('initializationFailed')}</h1>
          <p>{readError}</p>
        </main>
      </div>
    );
  if (!state)
    return (
      <div className="flex h-screen flex-col">
        <WindowHeader />
        <StartupLoading />
      </div>
    );
  if (state.phase === AppInitializationPhase.Ready) return <>{children}</>;
  if (state.firstLaunch || state.phase === AppInitializationPhase.Failed) {
    return <InitializationScreen state={state} />;
  }
  return (
    <div className="flex h-screen flex-col">
      <WindowHeader />
      <StartupLoading />
    </div>
  );
}
