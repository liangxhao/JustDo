import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Supply the public host-prepared data receipt in an isolated test state root. */
export function prepareTeamPluginData(stateDirectory: string): string {
  const directory = path.join(stateDirectory, 'plugin-data', 'agent-team');
  mkdirSync(directory, { recursive: true });
  const marker = path.join(directory, '.owner.json');
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({
    schemaVersion: 1, pluginId: 'agent-team', dataId: randomUUID(), retention: 'retain',
  }));
  return directory;
}
