import React from 'react';
import { flushSync } from 'react-dom';

import ChatAvatar from '@/features/cowork/components/chat/ChatAvatar';
import ChatMessageDisplay from '@/features/cowork/components/chat/ChatMessageDisplay';
import NativeSessionHistory from '@/features/cowork/components/chat/NativeSessionHistory';
import { UserMessageContent } from '@/features/cowork/components/chat/UserMessageContent';
import ComposerFeatureMenu from '@/features/cowork/components/composer/ComposerFeatureMenu';
import * as composerStyles from '@/features/cowork/components/composer/draft/composerStyles';
import { isComposerSendShortcut } from '@/features/cowork/components/composer/sendShortcut';
import { LocalSpeechInputButton } from '@/features/cowork/components/composer/speech/LocalSpeechInputButton';
import { RunControlButton } from '@/features/cowork/components/composer/submission/RunControlButton';
import PreviewMarkdown from '@/features/cowork/components/preview/PreviewMarkdown';
import SessionSubtaskButton from '@/features/cowork/components/subagents/SessionSubtaskButton';
import { coworkService } from '@/features/cowork/coworkService';
import { addDraftMessageQuote, setDraftPrompt } from '@/features/cowork/coworkSlice';
import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown/markdown';
import { normalizeMessage } from '@/libs/openclaw-chat/pipeline/message-normalizer';
import { i18nService } from '@/services/i18n';
import LoadingDots from '@/shared/components/ui/LoadingDots';
import Modal from '@/shared/components/ui/Modal';
import { OwnerDocumentContext, useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';
import { createStyleScopedPortal } from '@/shared/dom/styleScope';
import { store } from '@/store';

import { AppBrowserRegistry } from './browserRegistry';
import { appJsxRuntime } from './jsxRuntime';
import { requestAppSettings } from './settingsNavigation';

const primitives = {
  LoadingDots,
  ChatMessageDisplay,
  UserMessageContent,
  ComposerFeatureMenu,
  RunControlButton,
  ChatAvatar,
  PreviewMarkdown,
  LocalSpeechInputButton,
  SessionSubtaskButton,
};
const browserRuntime = Object.freeze({
  React,
  createPortal: createStyleScopedPortal,
  flushSync,
  ...appJsxRuntime,
  services: Object.freeze({
    ui: Object.freeze({
      i18n: i18nService,
      Modal,
      OwnerDocumentProvider: OwnerDocumentContext.Provider,
      useOwnerDocument,
      useOwnerWindow,
      isComposerSendShortcut,
    }),
    primitives,
    composerStyles,
    rendering: Object.freeze({ toSanitizedMarkdownHtml, normalizeMessage }),
  }),
});
Object.defineProperty(globalThis, Symbol.for('app-plugin.browser-runtime.v1'), {
  value: browserRuntime,
  configurable: false,
  writable: false,
});
export const appBrowserRegistry = new AppBrowserRegistry(
  window.electron?.appPlugins ?? {
    snapshot: async () => [],
    invoke: async () => ({ success: false, error: 'appPluginUnavailable' }),
    onChanged: () => () => undefined,
  },
  {
    t: key => i18nService.t(key),
    translations: (id, dictionaries) => i18nService.registerPluginTranslations(id, dictionaries),
    components: primitives as unknown as Record<
      string,
      React.ComponentType<Record<string, unknown>>
    >,
    renderHistory: input => (
      <NativeSessionHistory {...(input as React.ComponentProps<typeof NativeSessionHistory>)} />
    ),
    openWorkspace: input =>
      window.dispatchEvent(new CustomEvent('app-plugin:workspace', { detail: input })),
    application: {
      navigation: { showSettings: requestAppSettings },
      metadata: { subscribe: store.subscribe, getSnapshot: () => applicationSnapshot() },
      sessions: {
        ensureSummaries: ids => coworkService.ensureSessionSummaries([...ids]),
        loadSession: (id, options) => coworkService.loadSession(id, options),
        getDetails: id => coworkService.getSessionDetails(id),
        onChanged: listener => window.electron.cowork.onSessionsChanged(listener),
      },
      drafts: {
        addQuote: input => {
          store.dispatch(addDraftMessageQuote(input));
        },
        setPrompt: input => {
          store.dispatch(setDraftPrompt(input));
        },
      },
      files: {
        selectDirectory: (...args) => window.electron.dialog.selectDirectory(...args),
        selectFiles: (...args) => window.electron.dialog.selectFiles(...args),
        readFileAsDataUrl: (...args) => window.electron.dialog.readFileAsDataUrl(...args),
      },
      stageAudio: (...args) => window.electron.localAsr.stageAttachment(...args),
    },
  },
);
let projectedState: ReturnType<typeof store.getState> | undefined;
let projectedSnapshot: import('../../../../../packages/app-plugin-sdk/application').AppStateSnapshot;
function applicationSnapshot() {
  const state = store.getState();
  if (state !== projectedState) {
    projectedState = state;
    const {
      sessions,
      currentSession,
      sessionRunTimings,
      pendingInteractions,
      draftPrompts,
      draftMessageQuotes,
      sessionRuntimeActivity,
    } = state.cowork;
    projectedSnapshot = {
      agent: { agents: state.agent.agents },
      cowork: {
        sessions,
        sessionDirectory: state.cowork.sessionDirectory ?? sessions,
        currentSession,
        sessionRunTimings,
        pendingInteractions,
        draftPrompts,
        draftMessageQuotes,
        sessionRuntimeActivity,
      },
    };
  }
  return projectedSnapshot;
}
