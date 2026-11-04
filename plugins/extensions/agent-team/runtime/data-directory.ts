import { resolvePluginDataDirectory } from '@app-plugin/sdk/data';

/** Native reads only the directory prepared by the host for this plugin. */
export function agentTeamDataDirectory(stateDirectory: string): string {
  return resolvePluginDataDirectory(stateDirectory, 'agent-team', { retention: 'retain' });
}
