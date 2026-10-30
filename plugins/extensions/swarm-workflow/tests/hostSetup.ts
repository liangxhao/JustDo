import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { bindBrowserHost } from '../app/browser/workflowBrowserPorts';
import { swarmWorkflowTranslations } from '../browser/translations';

const methods: Record<string, string> = {
  list: 'getSwarmWorkflows',
  activity: 'getSwarmWorkflowActivity',
  summary: 'getSwarmWorkflowSummary',
  detail: 'getSwarmWorkflowDetail',
  batch: 'getSwarmWorkflowBatch',
  control: 'controlSwarmWorkflow',
  intervene: 'interveneSwarmWorkflow',
  'retry-batch': 'retrySwarmWorkflowBatch',
};
const hostRoot = process.env.APP_PLUGIN_HOST_ROOT;
if (hostRoot) {
  const { installBrowserBehaviorPorts } = await import(
    /* @vite-ignore */
    pathToFileURL(path.join(hostRoot, 'tests/plugin-host/legacyBehaviorPorts.ts')).href
  );
  installBrowserBehaviorPorts({
    pluginRoot: path.resolve(import.meta.dirname, '..'),
    bindBrowserHost,
    translations: swarmWorkflowTranslations,
    async invoke(
      command: string,
      args: unknown[],
      bridge: Record<string, Record<string, (...args: unknown[]) => unknown>>,
    ) {
      const method = methods[command.replace(/^workflow\./, '')];
      if (!method) throw new Error(`Unknown fixture command ${command}`);
      return bridge.cowork[method](...args);
    },
    subscribe: (
      listener: (payload: unknown) => void,
      bridge: Record<string, Record<string, (...args: unknown[]) => unknown>>,
    ) => bridge.cowork?.onSwarmWorkflowsChanged?.(listener) as (() => void) | undefined,
  });
}
