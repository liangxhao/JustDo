import React from 'react';
import { flushSync } from 'react-dom';

import { AppBrowserRegistry } from '@/features/plugins/app/browserRegistry';
import { appJsxRuntime } from '@/features/plugins/app/jsxRuntime';
import * as composerStyles from '@/features/cowork/components/composer/draft/composerStyles';
import { i18nService } from '@/services/i18n';
import LoadingDots from '@/shared/components/ui/LoadingDots';
import Modal from '@/shared/components/ui/Modal';
import { OwnerDocumentContext, useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';
import { createStyleScopedPortal } from '@/shared/dom/styleScope';

const source = {
  id: 'ui-source',
  title: '界面对比',
  cwd: '',
  agentId: 'main',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
  messages: [],
};
const snapshot = {
  agent: { agents: [{ id: 'main', name: '主助手', enabled: true }] },
  cowork: {
    sessions: [source],
    sessionDirectory: [source],
    currentSession: source,
    sessionRunTimings: {},
    pendingInteractions: [],
    draftPrompts: {},
    draftMessageQuotes: {},
    sessionRuntimeActivity: {},
  },
};
const Empty = () => null;
const settings = {
  version: 1,
  revision: 0,
  value: {
    collaboration: { maxMembers: 12, messageBudget: 16 },
    discussion: {
      maxMembers: 6,
      defaultRounds: 2,
      maxRounds: 4,
      maxTurns: null,
      maxConcurrent: null,
      organizerParticipates: false,
    },
  },
};

Object.defineProperty(globalThis, Symbol.for('app-plugin.browser-runtime.v1'), {
  value: {
    React,
    createPortal: createStyleScopedPortal,
    flushSync,
    ...appJsxRuntime,
    services: {
      ui: {
        i18n: i18nService,
        Modal,
        useOwnerDocument,
        useOwnerWindow,
        OwnerDocumentProvider: OwnerDocumentContext.Provider,
      },
      primitives: new Proxy(
        { LoadingDots },
        {
          get: (value, name) => (name in value ? value[name as keyof typeof value] : Empty),
        },
      ),
      composerStyles,
      rendering: { toSanitizedMarkdownHtml: (text: string) => text, normalizeMessage: Empty },
    },
  },
});

export const appBrowserRegistry = new AppBrowserRegistry(
  {
    snapshot: async () => [],
    onChanged: () => () => {},
    onEvent: () => () => {},
    invoke: async input => {
      if (input.command.startsWith('settings.')) return { success: true, value: settings };
      if (input.command === 'collaboration.list')
        return {
          success: true,
          value: [{ id: 'ui-summary-room', anchorSessionId: 'ui-summary', members: [] }],
        };
      if (input.command === 'workflow.summary')
        return {
          success: true,
          count: input.args[0] === 'ui-summary' ? 1 : 0,
          running: false,
        };
      if (input.command === 'workflow.list') return { success: true, flows: [] };
      if (input.command === 'workflow.activity') return { success: true, sessionIds: [] };
      return { success: true, value: [] };
    },
  },
  {
    t: key => i18nService.t(key),
    translations: (id, value) => i18nService.registerPluginTranslations(id, value),
    components: {},
    renderHistory: () => null,
    application: {
      metadata: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      sessions: {
        onChanged: () => () => {},
        ensureSummaries: async () => {},
        loadSession: async () => source,
        getDetails: async () => ({ session: null }),
      },
      navigation: { showSettings() {} },
      drafts: { addQuote() {}, setPrompt() {} },
      files: {
        selectDirectory: async () => ({ success: true, path: null }),
        selectFiles: async () => ({ success: true, paths: [] }),
        readFileAsDataUrl: async () => ({ success: false }),
      },
      stageAudio: async () => ({ success: false }),
    } as never,
  },
);

export { source };
