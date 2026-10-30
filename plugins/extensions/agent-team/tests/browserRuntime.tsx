import type { AppBrowserHost } from '@app-plugin/sdk/browser';
import type { AppBrowserRuntime } from '@app-plugin/sdk/browser-runtime';
import type { AppPrimitives } from '@app-plugin/sdk/presentation';
import React from 'react';
import { jsxDEV } from 'react/jsx-dev-runtime';
import { jsx, jsxs } from 'react/jsx-runtime';
import { createPortal, flushSync } from 'react-dom';

import { OwnerDocumentProvider, useOwnerDocument, useOwnerWindow } from './fixtures/ownerDocument';

type Bridge = Record<string, Record<string, (...args: unknown[]) => unknown>>;
const commands: Record<string, [string, string]> = {
  'settings.read': ['agentTeamSettings', 'read'], 'settings.save': ['agentTeamSettings', 'save'],
  'settings.read-team': ['agentTeamSettings', 'readTeam'], 'settings.save-team': ['agentTeamSettings', 'saveTeam'],
  ...Object.fromEntries(Object.entries({ create: 'create', read: 'read', list: 'list', stop: 'stop', 'stop-member': 'stopMember', messages: 'readMessages', continue: 'prepareContinuation' }).map(([command, method]) => [`collaboration.${command}`, ['collaboration', method]])),
  ...Object.fromEntries(Object.entries({ participation: 'participation', 'create-task': 'createTask', list: 'list', create: 'create', read: 'read', send: 'send', enqueue: 'enqueue', cancel: 'cancelPending', stop: 'stop', delete: 'delete' }).map(([command, method]) => [`discussion.${command}`, ['teamDiscussion', method]])),
};
let ports: Awaited<ReturnType<typeof loadPorts>>;
async function loadPorts() {
  const [i18n, config, speech, preview, markdown, state, services] = await Promise.all([
    import('./fixtures/i18n'), import('./fixtures/config'), import('./fixtures/speech'),
    import('./fixtures/PreviewMarkdown'), import('./fixtures/markdown'),
    import('./fixtures/store'), import('./fixtures/coworkService'),
  ]);
  return { i18n: i18n.i18nService, config: config.configService, speech: speech.LocalSpeechInputButton, preview: preview.default, markdown, store: state.store, sessions: services.coworkService };
}
let historyRenderer: AppBrowserHost['renderHistory'] = () => null;
export function setHistoryRenderer(render: AppBrowserHost['renderHistory']) { historyRenderer = render; }
export async function createBrowserHost(signal: AbortSignal): Promise<AppBrowserHost> {
  // Import after the test module has installed its port mocks.
  ports = await loadPorts();
  historyRenderer = () => null;
  const bridge = () => (window as unknown as { electron: Bridge }).electron;
  return {
    signal,
    async invoke(command: string, ...args: unknown[]) {
      const pair = commands[command];
      if (!pair) return Promise.reject(new Error('Unknown fixture command: ' + command));
      if (command === 'collaboration.create') {
        const input = args[0] as { sessionId: string; agentIds: string[] };
        args = [input.sessionId, input.agentIds];
      } else if (command === 'collaboration.messages') {
        const input = args[0] as { sessionId: string; deliveryIds: string[] };
        args = [input.sessionId, input.deliveryIds];
      } else if (command.startsWith('settings.')) {
        const input = args[0] as { kind: string; roomId: string; value: unknown; expectedRevision: number };
        if (command === 'settings.save') args = [input.value, input.expectedRevision];
        else if (command === 'settings.read-team') args = [input.kind, input.roomId];
        else if (command === 'settings.save-team') args = [input.kind, input.roomId, input.value, input.expectedRevision];
      }
      return Promise.resolve(bridge()[pair[0]][pair[1]](...args));
    },
    t: (key: string) => ports.i18n.t(key),
    onEvent: () => () => undefined,
    renderHistory(input) { return historyRenderer(input); },
    application: {
      metadata: { subscribe: (listener: () => void) => ports.store.subscribe?.(listener) ?? (() => undefined), getSnapshot: () => ports.store.getState?.() },
      sessions: {
        ensureSummaries: (...args: unknown[]) => ports.sessions.ensureSessionSummaries?.(...args),
        loadSession: (...args: unknown[]) => ports.sessions.loadSession(...args),
        getDetails: (...args: unknown[]) => ports.sessions.getSessionDetails?.(...args),
        onChanged: (listener: () => void) => bridge().cowork?.onSessionsChanged?.(listener) ?? (() => undefined),
      },
      drafts: {
        addQuote: (payload: unknown) => ports.store.dispatch({ type: 'cowork/addDraftMessageQuote', payload }),
        setPrompt: (payload: unknown) => ports.store.dispatch({ type: 'cowork/setDraftPrompt', payload }),
      },
      files: {
        selectDirectory: (...args: unknown[]) => bridge().dialog.selectDirectory(...args),
        selectFiles: (...args: unknown[]) => bridge().dialog.selectFiles(...args),
        readFileAsDataUrl: (...args: unknown[]) => bridge().dialog.readFileAsDataUrl(...args),
      },
      stageAudio: (...args: unknown[]) => bridge().localAsr.stageAttachment(...args),
    },
  } as unknown as AppBrowserHost;
}
const Empty = () => null;
const primitives: AppPrimitives = {
  LoadingDots: () => <span data-testid="loading-dots" />, ChatAvatar: Empty, ComposerFeatureMenu: Empty,
  LocalSpeechInputButton: props => <ports.speech {...props} />,
  PreviewMarkdown: props => <ports.preview {...props} />,
  SessionSubtaskButton: props => <button>Subtasks for {props.sessionId}</button>,
  ChatMessageDisplay: props => <div>{JSON.stringify(props.gatewayMessages)}</div>,
  UserMessageContent: props => <div>{JSON.stringify(props.message.content)}</div>,
  RunControlButton: props => <button disabled={props.isRunning ? props.isStopping : !props.canSubmit} title={props.isRunning ? 'Stop' : props.sendTitle} aria-label={props.isRunning ? 'Stop' : props.sendLabel ?? props.sendTitle} onClick={props.isRunning ? props.onStop : props.onSend}>{props.sendText}</button>,
};
/** Synthetic public SDK services; native chat behavior remains a host integration concern. */
export const runtime: AppBrowserRuntime = {
  React, createPortal, flushSync, jsx, jsxs, jsxDEV,
  services: {
    primitives,
    ui: {
      i18n: { t: key => ports?.i18n.t(key) ?? key, getLanguage: () => ports?.i18n.getLanguage?.() ?? 'en' },
      Modal: props => props.isOpen !== false ? <div>{props.children}</div> : null,
      OwnerDocumentProvider, useOwnerDocument, useOwnerWindow,
      isComposerSendShortcut: (event, shortcut) => {
        const setting = shortcut ?? ports.config.getConfig().shortcuts.sendMessage;
        return !event.nativeEvent.isComposing && event.keyCode !== 229 && event.key === 'Enter' && !event.shiftKey && (setting === 'Ctrl+Enter' ? event.ctrlKey || event.metaKey : !event.ctrlKey && !event.metaKey);
      },
    },
    composerStyles: {
      COMPOSER_FRAME_CLASS: 'fixture-composer-frame', COMPOSER_SURFACE_CLASS: 'fixture-composer-surface', COMPOSER_TEXTAREA_CLASS: 'fixture-composer-textarea',
      COMPOSER_TEXTAREA_MAX_HEIGHT: 144, COMPOSER_TEXTAREA_MIN_HEIGHT: 48,
      resizeComposerTextarea: () => undefined,
    },
    rendering: {
      toSanitizedMarkdownHtml: text => ports.markdown.toSanitizedMarkdownHtml(text),
      normalizeMessage: value => {
        const message = value as { role?: string; timestamp?: number; content?: string | Array<{ type: string; text?: string }> };
        return { role: message.role ?? 'assistant', timestamp: message.timestamp ?? 0, content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [] };
      },
    },
  },
};
