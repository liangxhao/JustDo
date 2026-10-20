import { beforeEach } from 'vitest';
import React from 'react';
import { bindBrowserHost } from '../../plugins/extensions/agent-team/app/browser/ports';
import { bindBrowserHost as bindWorkflowHost } from '../../plugins/extensions/swarm-workflow/app/browser/workflowBrowserPorts';
import type { AppBrowserHost } from '../../packages/app-plugin-sdk/browser';

// Adapts old test inputs to plugin commands. These method names are not a production bridge.
const commands: Record<string, [string, string]> = {
  'settings.read': ['agentTeamSettings', 'read'],
  'settings.save': ['agentTeamSettings', 'save'],
  'settings.read-team': ['agentTeamSettings', 'readTeam'],
  'settings.save-team': ['agentTeamSettings', 'saveTeam'],
  'collaboration.create': ['collaboration', 'create'],
  'collaboration.read': ['collaboration', 'read'],
  'collaboration.list': ['collaboration', 'list'],
  'collaboration.stop': ['collaboration', 'stop'],
  'collaboration.stop-member': ['collaboration', 'stopMember'],
  'collaboration.messages': ['collaboration', 'readMessages'],
  'collaboration.continue': ['collaboration', 'prepareContinuation'],
  ...Object.fromEntries(
    Object.entries({
      participation: 'participation',
      'create-task': 'createTask',
      list: 'list',
      create: 'create',
      read: 'read',
      send: 'send',
      enqueue: 'enqueue',
      cancel: 'cancelPending',
      stop: 'stop',
      delete: 'delete',
    }).map(([command, method]) => [`discussion.${command}`, ['teamDiscussion', method]]),
  ),
  ...Object.fromEntries(
    Object.entries({
      list: 'getSwarmWorkflows',
      activity: 'getSwarmWorkflowActivity',
      summary: 'getSwarmWorkflowSummary',
      detail: 'getSwarmWorkflowDetail',
      batch: 'getSwarmWorkflowBatch',
      control: 'controlSwarmWorkflow',
      intervene: 'interveneSwarmWorkflow',
      'retry-batch': 'retrySwarmWorkflowBatch',
    }).map(([command, method]) => [`workflow.${command}`, ['cowork', method]]),
  ),
};
const NativeHistory = React.lazy(() =>
  import('./browserRuntime').then(module => ({ default: module.NativeSessionHistory })),
);
beforeEach(async context => {
  if (!context.task.file.filepath.replace(/\\/g, '/').includes('/app/browser/')) return;
  const { store } = await import('@/store');
  const { coworkService } = await import('@/features/cowork/coworkService');
  const { addDraftMessageQuote, setDraftPrompt } = await import('@/features/cowork/coworkSlice');
  const { i18nService } = await import('@/services/i18n');
  if (typeof i18nService.registerPluginTranslations === 'function') {
    const dictionaries = context.task.file.filepath.includes('agent-team')
      ? (await import('../../plugins/extensions/agent-team/app/browser/translations'))
          .agentTeamTranslations
      : (await import('../../plugins/extensions/swarm-workflow/browser/translations'))
          .swarmWorkflowTranslations;
    const release = i18nService.registerPluginTranslations('behavior-fixture', dictionaries);
    context.onTestFinished(release);
  }
  const electron = () =>
    window.electron as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
  const controller = new AbortController();
  const host = {
    signal: controller.signal,
    onEvent: (_name: string, listener: (payload: unknown) => void) =>
      electron().cowork?.onSwarmWorkflowsChanged?.(listener) ?? (() => {}),
    t: (key: string) => i18nService.t(key),
    invoke: async (command: string, ...args: unknown[]) => {
      const pair = commands[command];
      if (!pair) throw new Error(`Unknown behavior fixture command ${command}`);
      if (command === 'collaboration.create') {
        const input = args[0] as { sessionId: string; agentIds: string[] };
        args = [input.sessionId, input.agentIds];
      } else if (command === 'collaboration.messages') {
        const input = args[0] as { sessionId: string; deliveryIds: string[] };
        args = [input.sessionId, input.deliveryIds];
      } else if (command.startsWith('settings.')) {
        const input = args[0] as {
          kind: string;
          roomId: string;
          value: unknown;
          expectedRevision: number;
        };
        if (command === 'settings.save') args = [input.value, input.expectedRevision];
        else if (command === 'settings.read-team') args = [input.kind, input.roomId];
        else if (command === 'settings.save-team')
          args = [input.kind, input.roomId, input.value, input.expectedRevision];
      }
      return electron()[pair[0]][pair[1]](...args);
    },
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
  const releaseTeam = bindBrowserHost(host);
  const releaseWorkflow = bindWorkflowHost(host);
  context.onTestFinished(() => {
    controller.abort();
    releaseTeam();
    releaseWorkflow();
  });
});
