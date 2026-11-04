import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Supplies the host-prepared retained directory in isolated plugin fixtures. */
export function prepareWorkflowPluginData(stateDirectory: string): string {
  const directory = path.join(stateDirectory, 'plugin-data', 'swarm-workflow');
  mkdirSync(directory, { recursive: true });
  const marker = path.join(directory, '.owner.json');
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({
    schemaVersion: 1, pluginId: 'swarm-workflow', dataId: randomUUID(), retention: 'retain',
  }));
  return directory;
}
