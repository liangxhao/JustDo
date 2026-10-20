import type { AppMainHost, AppMainRegistration } from '@app-plugin/sdk/main';

import { createSwarmWorkflowCoordinator } from './coordinator';
import { workflowResources } from './resources';
import { buildManagedSwarmWorkflowPluginEntries } from './config';
import {
  isWorkflowNativeChange,
  SwarmWorkflowGatewayEvent,
  WorkflowEventName,
} from '../contracts/events';

export function register(host: AppMainHost): AppMainRegistration {
  const resources = workflowResources(host);
  const operations = createSwarmWorkflowCoordinator({
    getRuntime: host.getRuntime,
    hasSession: id => !resources.isDeleting(id) && Boolean(host.getSessions().getSession(id)),
  });
  // Native coordinator validators own the wire admission; preserve all optional args.
  const invoke =
    (name: keyof typeof operations) =>
    (...args: unknown[]) =>
      Reflect.apply(operations[name], operations, args);
  return {
    onEnable: () =>
      host.onNativeEvent(event => {
        if (event.event === SwarmWorkflowGatewayEvent.Reset) {
          host.publishEvent(WorkflowEventName.Changed, {});
        } else if (
          event.event === SwarmWorkflowGatewayEvent.Changed &&
          isWorkflowNativeChange(event.payload)
        ) {
          const { parentKey, flowId, revision } = event.payload;
          const session = host.getSessions().getSessionByNativeKey(parentKey);
          if (session)
            host.publishEvent(WorkflowEventName.Changed, {
              sessionId: session.id,
              flowId,
              revision,
            });
        }
      }),
    resources,
    beforePackageMutation: () => resources.prepareDelete(resources.protectedResources?.() ?? []),
    submission: {
      matches: (_prompt, selection) => selection?.pluginId === host.manifest.id,
      register: async () => {
        host.assertActive();
      },
      markSubmissionStarted: async () => {
        host.assertActive();
      },
      abortBeforeSend: async () => true,
      // Native workflow receipts belong to the flow, independently of the source turn.
      cancel: async () => undefined,
      releaseIfSettled: async () => true,
    },
    commands: [
      { id: 'workflow.prepare', invoke: invoke('prepareSwarmWorkflow') },
      { id: 'workflow.list', invoke: invoke('getSwarmWorkflows') },
      { id: 'workflow.activity', invoke: invoke('getSwarmWorkflowActivity') },
      { id: 'workflow.summary', invoke: invoke('getSwarmWorkflowSummary') },
      { id: 'workflow.detail', invoke: invoke('getSwarmWorkflowDetail') },
      { id: 'workflow.control', invoke: invoke('controlSwarmWorkflow') },
      { id: 'workflow.intervene', invoke: invoke('interveneSwarmWorkflow') },
      { id: 'workflow.batch', invoke: invoke('getSwarmWorkflowBatch') },
      { id: 'workflow.retry-batch', invoke: invoke('retrySwarmWorkflowBatch') },
    ],
    projectNativeConfig: agents => {
      const entry = buildManagedSwarmWorkflowPluginEntries(agents, () => true)[
        host.manifest.nativePluginId
      ] as { config?: Record<string, unknown> } | undefined;
      return entry?.config ?? {};
    },
  };
}
