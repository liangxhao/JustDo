import React, { useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { jsx, jsxs } from 'react/jsx-runtime';
import { jsxDEV } from 'react/jsx-dev-runtime';
import type { AppBrowserHost } from '@app-plugin/sdk/browser';
import type { AppBrowserRuntime } from '@app-plugin/sdk/browser-runtime';
import type { AppPrimitives } from '@app-plugin/sdk/presentation';

import { swarmWorkflowTranslations } from '../browser/translations';

let language: 'en' | 'zh' = 'en';
export const i18nService = {
  getLanguage: () => language,
  setLanguage(value: 'en' | 'zh', _options?: { persist?: boolean }) {
    language = value;
  },
  t(key: string) {
    return Reflect.get(swarmWorkflowTranslations[language], key) ?? key;
  },
};

/** Test-owned SDK ports. No Electron bridge or application implementation is loaded. */
export const workflowTestPorts: Record<string, (...args: unknown[]) => unknown> = {};
export function setWorkflowTestPorts(ports: typeof workflowTestPorts) {
  Object.assign(workflowTestPorts, ports);
}
const commands: Record<string, string> = {
  list: 'getSwarmWorkflows',
  activity: 'getSwarmWorkflowActivity',
  summary: 'getSwarmWorkflowSummary',
  detail: 'getSwarmWorkflowDetail',
  batch: 'getSwarmWorkflowBatch',
  control: 'controlSwarmWorkflow',
  intervene: 'interveneSwarmWorkflow',
  'retry-batch': 'retrySwarmWorkflowBatch',
};
let historyRenderer: AppBrowserHost['renderHistory'] = () => null;
export function setHistoryRenderer(render: AppBrowserHost['renderHistory']) {
  historyRenderer = render;
}
export function createBrowserHost(signal: AbortSignal): AppBrowserHost {
  return {
    signal,
    invoke(command: string, ...args: unknown[]) {
      const method = commands[command.replace(/^workflow\./u, '')];
      const invoke = workflowTestPorts[method];
      if (!invoke) return Promise.reject(new Error('Unconfigured workflow test port: ' + command));
      return Promise.resolve(invoke(...args));
    },
    onEvent(_event: string, listener: (payload: unknown) => void) {
      return workflowTestPorts.onSwarmWorkflowsChanged?.(listener) ?? (() => undefined);
    },
    renderHistory(input) {
      return historyRenderer(input);
    },
  } as AppBrowserHost;
}
export function resetBrowserPorts() {
  for (const key of Object.keys(workflowTestPorts)) delete workflowTestPorts[key];
  historyRenderer = () => null;
  language = 'en';
}
const Empty = () => null;
const primitives: AppPrimitives = {
  LoadingDots: Empty,
  ChatAvatar: Empty,
  PreviewMarkdown: Empty,
  LocalSpeechInputButton: Empty,
  SessionSubtaskButton: Empty,
  RunControlButton: props => (
    <button
      aria-label={props.sendLabel ?? props.sendTitle}
      disabled={!props.canSubmit}
      title={props.sendTitle}
      onClick={props.onSend}
    />
  ),
  UserMessageContent: props => (
    <div data-user-message>
      {typeof props.message.content === 'string'
        ? props.message.content
        : JSON.stringify(props.message.content)}
    </div>
  ),
  ChatMessageDisplay: props => <div>{JSON.stringify(props.gatewayMessages)}</div>,
  ComposerFeatureMenu: props => {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button disabled={props.disabled} onClick={() => setOpen(!open)}>
          {props.label}
        </button>
        {open && (
          <div role="menu">
            {props.items.map(item => (
              <button
                key={item.id}
                role="menuitem"
                aria-label={item.label}
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
                <small>{item.description}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  },
};
export const runtime: AppBrowserRuntime = {
  React,
  createPortal,
  flushSync,
  jsx,
  jsxs,
  jsxDEV,
  services: {
    primitives,
    ui: {
      i18n: i18nService,
      Modal: props => (props.isOpen ? <div>{props.children}</div> : null),
      useOwnerDocument: () => document,
      useOwnerWindow: () => window,
      OwnerDocumentProvider: props => <>{props.children}</>,
      isComposerSendShortcut: event => event.key === 'Enter' && (event.ctrlKey || event.metaKey),
    },
    composerStyles: {
      COMPOSER_FRAME_CLASS: 'fixture-composer-frame',
      COMPOSER_SURFACE_CLASS: 'fixture-composer-surface',
      COMPOSER_TEXTAREA_CLASS: 'fixture-composer-textarea',
      COMPOSER_TEXTAREA_MAX_HEIGHT: 144,
      COMPOSER_TEXTAREA_MIN_HEIGHT: 48,
      resizeComposerTextarea: () => undefined,
    },
    rendering: {
      toSanitizedMarkdownHtml: () => {
        throw new Error('Unconfigured rendering test port');
      },
      normalizeMessage: () => {
        throw new Error('Unconfigured rendering test port');
      },
    },
  },
};
