// Workspace DOM transfer uses the real plugin graph with explicit fixture browser ports.
import React from 'react';
import { createPortal, flushSync } from 'react-dom';
import { appJsxRuntime } from '@/features/plugins/app/jsxRuntime';
import { i18nService } from '@/services/i18n';
import { useOwnerWindow } from '@/shared/dom/ownerDocument';
import { bindBrowserHost } from '../../../plugins/extensions/swarm-workflow/app/browser/workflowBrowserPorts';
import { swarmWorkflowTranslations } from '../../../plugins/extensions/swarm-workflow/browser/translations';
import type { AppBrowserHost } from '../../../packages/app-plugin-sdk/browser';
i18nService.registerPluginTranslations('workspace-workflow-fixture', swarmWorkflowTranslations);
bindBrowserHost({
  signal: new AbortController().signal,
  onEvent: () => () => undefined,
  invoke: async () => ({ success: false, error: 'fixture' }),
  renderHistory: () => null,
} as unknown as AppBrowserHost);
export const runtime = {
  React,
  createPortal,
  flushSync,
  ...appJsxRuntime,
  services: {
    ui: { i18n: i18nService, useOwnerWindow },
    primitives: {},
    composerStyles: {},
    rendering: {},
  },
};
