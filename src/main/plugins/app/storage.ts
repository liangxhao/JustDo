import path from 'node:path';

import { PLUGIN_DATA_DIRECTORY } from '../../../../plugins/sdk/app-plugin-sdk/data';

const HOST_DIRECTORY = '.host';

/** One writable root; artifact retention and approval writes create their own directories. */
export function appPluginStoragePaths(stateDirectory: string) {
  const root = path.join(stateDirectory, PLUGIN_DATA_DIRECTORY);
  const host = path.join(root, HOST_DIRECTORY);
  return { root, host, artifacts: path.join(host, 'artifacts'), approvals: path.join(host, 'approvals.json') };
}
