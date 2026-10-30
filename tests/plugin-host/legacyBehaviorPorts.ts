import React from 'react';
import { beforeEach } from 'vitest';

import type { AppBrowserHost } from '../../plugins/sdk/app-plugin-sdk/browser';

type FixtureBridge = Record<string, Record<string, (...args: unknown[]) => unknown>>;
interface BrowserBehaviorOptions {
  pluginRoot: string;
  bindBrowserHost(host: AppBrowserHost): () => void;
  translations: { en: Readonly<Record<string, string>>; zh: Readonly<Record<string, string>> };
  invoke(command: string, args: unknown[], bridge: FixtureBridge): Promise<unknown>;
  subscribe?(listener: (payload: unknown) => void, bridge: FixtureBridge): (() => void) | undefined;
}
const NativeHistory = React.lazy(() =>
  import('./browserRuntime').then(module => ({ default: module.NativeSessionHistory })),
);

/** Host test ports are injected by each plugin's own test setup. */
export function installBrowserBehaviorPorts(options: BrowserBehaviorOptions): void {
  beforeEach(async context => {
    if (
      !context.task.file.filepath
        .replace(/\\/g, '/')
        .startsWith(options.pluginRoot.replace(/\\/g, '/') + '/app/browser/')
    )
      return;
    const { store } = await import('@/store');
    const { coworkService } = await import('@/features/cowork/coworkService');
    const { addDraftMessageQuote, setDraftPrompt } = await import('@/features/cowork/coworkSlice');
    const { i18nService } = await import('@/services/i18n');
    if (typeof i18nService.registerPluginTranslations === 'function')
      context.onTestFinished(
        i18nService.registerPluginTranslations('behavior-fixture', options.translations),
      );
    const electron = () =>
      window.electron as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
    const controller = new AbortController();
    const host = {
      signal: controller.signal,
      onEvent: (_name: string, listener: (payload: unknown) => void) =>
        options.subscribe?.(listener, electron()) ?? (() => {}),
      t: (key: string) => i18nService.t(key),
      invoke: (command: string, ...args: unknown[]) => options.invoke(command, args, electron()),
      application: {
        metadata: { subscribe: store.subscribe, getSnapshot: store.getState },
        sessions: {
          ensureSummaries: (ids: string[]) => coworkService.ensureSessionSummaries(ids),
          loadSession: (...args: Parameters<typeof coworkService.loadSession>) =>
            coworkService.loadSession(...args),
          getDetails: (...args: Parameters<typeof coworkService.getSessionDetails>) =>
            coworkService.getSessionDetails(...args),
          onChanged: (listener: () => void) =>
            electron().cowork?.onSessionsChanged?.(listener) ?? (() => {}),
        },
        drafts: {
          addQuote: (input: Parameters<typeof addDraftMessageQuote>[0]) =>
            store.dispatch(addDraftMessageQuote(input)),
          setPrompt: (input: Parameters<typeof setDraftPrompt>[0]) =>
            store.dispatch(setDraftPrompt(input)),
        },
        files: {
          selectDirectory: (...args: unknown[]) => electron().dialog.selectDirectory(...args),
          selectFiles: (...args: unknown[]) => electron().dialog.selectFiles(...args),
          readFileAsDataUrl: (...args: unknown[]) => electron().dialog.readFileAsDataUrl(...args),
        },
        stageAudio: (...args: unknown[]) => electron().localAsr.stageAttachment(...args),
      },
      renderHistory: (props: Record<string, unknown>) => {
        // Import lazily after per-test mocks are installed.
        return React.createElement(
          React.Suspense,
          { fallback: null },
          React.createElement(NativeHistory, props),
        );
      },
    } as unknown as AppBrowserHost;
    const release = options.bindBrowserHost(host);
    context.onTestFinished(() => {
      controller.abort();
      release();
    });
  });
}
