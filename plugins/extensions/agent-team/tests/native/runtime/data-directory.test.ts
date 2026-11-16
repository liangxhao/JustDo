import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { agentTeamDataDirectory } from '../../../runtime/data-directory';
import { prepareTeamPluginData } from '../fixtures/pluginData';

const roots: string[] = [];
function stateDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'team-data-directory-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of roots.splice(0)) {
    if (!directory.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(directory).startsWith('team-data-directory-'))
      throw new Error('Unexpected plugin data test directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

it('uses the host-prepared Team data directory without changing its ownership record', () => {
  const state = stateDirectory();
  const directory = prepareTeamPluginData(state);
  const marker = readFileSync(path.join(directory, '.owner.json'), 'utf8');
  expect(agentTeamDataDirectory(state)).toBe(directory);
  expect(readFileSync(path.join(directory, '.owner.json'), 'utf8')).toBe(marker);
});

it('leaves data directory ownership preparation to the host', () => {
  const state = stateDirectory();
  expect(() => agentTeamDataDirectory(state)).toThrow();
  expect(existsSync(path.join(state, 'plugin-data'))).toBe(false);
});

it('requires retained ownership for the Team data directory', () => {
  const state = stateDirectory();
  const directory = prepareTeamPluginData(state);
  const marker = path.join(directory, '.owner.json');
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, JSON.stringify({
    schemaVersion: owner.schemaVersion, pluginId: owner.pluginId, dataId: owner.dataId,
  }));
  expect(() => agentTeamDataDirectory(state)).toThrow();
});
