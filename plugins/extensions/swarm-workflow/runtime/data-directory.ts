import { resolvePluginDataDirectory } from '@app-plugin/sdk/data';

/** Native uses only the host-prepared retained store for this plugin. */
export function workflowDataDirectory(stateDirectory: string): string {
  return resolvePluginDataDirectory(stateDirectory, 'swarm-workflow', { retention: 'retain' });
}
