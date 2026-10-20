import team from '../../plugins/extensions/agent-team/app.plugin.json';
import workflow from '../../plugins/extensions/swarm-workflow/app.plugin.json';
import { parseAppPluginManifest } from '../../packages/app-plugin-sdk/contracts';
export const appNativePolicies = Object.fromEntries(
  [team, workflow].map(source => {
    const manifest = parseAppPluginManifest(source);
    return [manifest.nativePluginId, manifest.native!];
  }),
);
