import type { AppBrowserHost, AppViewContext } from '@app-plugin/sdk/browser';
import { ShareIcon } from '@heroicons/react/24/outline';
import { useEffect, useSyncExternalStore } from 'react';

import { SwarmWorkflowMode } from '../../contracts/options';
import SwarmWorkflowPanel from './SwarmWorkflowPanel';
import { useSwarmWorkflowActivity } from './useSwarmWorkflowActivity';
import { useSwarmWorkflowDiscovery } from './useSwarmWorkflowDiscovery';
import { bindBrowserHost } from './workflowBrowserPorts';

export function register(host: AppBrowserHost): () => void {
  const release = bindBrowserHost(host);
  let summary: { sessionId: string; available: boolean } | undefined;
  host.registerSessionPresentation(sessionId => {
    const summaryAvailable = summary?.sessionId === sessionId && summary.available;
    return summaryAvailable ? { summaryAvailable: true } : undefined;
  });
  function SummaryObserver() {
    const metadata = useSyncExternalStore(
      host.application.metadata.subscribe,
      host.application.metadata.getSnapshot,
    );
    const sessionId = metadata.cowork.currentSession?.id;
    const discovery = useSwarmWorkflowDiscovery(sessionId, undefined, undefined, true);
    useSwarmWorkflowActivity(
      [
        ...(metadata.cowork.sessions ?? []).map(session => session.id),
        ...(sessionId ? [sessionId] : []),
      ],
      { enabled: true, disabledRevision: 0 },
      host.publishSessionActivity,
    );
    useEffect(() => {
      if (host.signal.aborted) return;
      summary = sessionId ? { sessionId, available: discovery.count > 0 } : undefined;
      host.interactionContextChanged();
      return () => {
        summary = undefined;
        if (!host.signal.aborted) host.interactionContextChanged();
      };
    }, [sessionId, discovery.count]);
    return null;
  }
  host.registerView({
    id: 'workflow-observer',
    slot: 'application.page',
    labelKey: 'swarmWorkflowTitle',
    component: SummaryObserver,
  });
  host.registerMode({
    id: 'auto',
    labelKey: 'swarmWorkflowTitle',
    order: 10,
    removeLabelKey: 'swarmWorkflowRemoveToken',
    selectionCaret: 'start',
    ordinaryTurnOnly: true,
    icon: <ShareIcon className="h-4 w-4" />,
    allowQueue: true,
    prepare: async input => {
      if (input.planModeEnabled || input.prompt.trimStart().startsWith('/'))
        throw new Error(input.planModeEnabled ? 'swarmWorkflowPlan' : 'swarmWorkflowInvalid');
      let result: import('../../contracts/api').SwarmWorkflowPrepareResult;
      try {
        result = await host.invoke<import('../../contracts/api').SwarmWorkflowPrepareResult>(
          'workflow.prepare',
          { mode: SwarmWorkflowMode.Auto, verify: true },
          input.sessionId,
        );
      } catch {
        throw new Error('swarmWorkflowPrepareUnavailable');
      }
      if (!result.success)
        throw new Error(
          {
            disabled: 'swarmWorkflowDisabled',
            plan: 'swarmWorkflowPlan',
            invalid: 'swarmWorkflowInvalid',
            unavailable: 'swarmWorkflowPrepareUnavailable',
          }[result.reason] ?? 'swarmWorkflowPrepareUnavailable',
        );
      return { prompt: input.prompt + '\n\n' + result.instruction };
    },
  });
  host.registerView({
    id: 'workflow',
    slot: 'workspace.tab',
    labelKey: 'swarmWorkflowTitle',
    icon: <ShareIcon className="h-4 w-4" />,
    component: ({ session, active }) =>
      session ? <SwarmWorkflowPanel sessionId={session.id} active={active} /> : null,
  });
  function SummaryEntry({ session, onClose }: AppViewContext) {
    const discovery = useSwarmWorkflowDiscovery(session?.id, undefined, undefined, true);
    return session && discovery.count > 0 ? (
      <button
        type="button"
        className="session-summary-panel__action flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={`${host.t('swarmWorkflowTitle')} ${discovery.count}`}
        onClick={() => {
          onClose?.();
          host.openWorkspace('workflow', session.id);
        }}
      >
        <ShareIcon className="h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1">{host.t('swarmWorkflowTitle')}</span>
        <span className="text-secondary">{discovery.count}</span>
      </button>
    ) : null;
  }
  host.registerView({
    id: 'workflow-summary',
    slot: 'session.summary',
    order: 10,
    labelKey: 'swarmWorkflowTitle',
    component: SummaryEntry,
  });
  return release;
}
