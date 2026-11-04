import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { agentTeamDataDirectory } from '../../../runtime/data-directory';
import { AgentTeamLaunchLedger } from '../../../runtime/launch/agent-team-launch-ledger';
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

it('uses the host-prepared directory for durable launch receipts', () => {
  const state = stateDirectory();
  const directory = prepareTeamPluginData(state);
  const marker = readFileSync(path.join(directory, '.owner.json'), 'utf8');
  expect(agentTeamDataDirectory(state)).toBe(directory);
  const ledger = new AgentTeamLaunchLedger(state);
  expect(ledger.directory).toBe(path.join(directory, 'launch-receipts'));
  const session = 'agent:main:justdo:source';
  const receipt = { generation: 1, state: 'unknown' };
  ledger.write(session, receipt);
  expect(ledger.read(session)).toEqual(receipt);
  expect(readFileSync(path.join(directory, '.owner.json'), 'utf8')).toBe(marker);
  expect(existsSync(path.join(state, 'agent-team'))).toBe(false);
  expect(existsSync(path.join(state, 'runtime-services'))).toBe(false);
});

it('never prepares Native ownership or reads the former launch directory', () => {
  const state = stateDirectory();
  const session = 'agent:main:justdo:source';
  const legacy = path.join(state, 'runtime-services', 'agent-team-launch');
  mkdirSync(legacy, { recursive: true });
  const previous = path.join(legacy, createHash('sha256').update(session).digest('hex') + '.json');
  const oldBytes = '{"generation":99,"state":"unknown"}';
  writeFileSync(previous, oldBytes);
  expect(() => new AgentTeamLaunchLedger(state)).toThrow();
  expect(existsSync(path.join(state, 'plugin-data'))).toBe(false);
  prepareTeamPluginData(state);
  const ledger = new AgentTeamLaunchLedger(state);
  expect(ledger.read(session)).toBeUndefined();
  ledger.write(session, { generation: 1, state: 'pending' });
  expect(ledger.read(session)).toEqual({ generation: 1, state: 'pending' });
  expect(readFileSync(previous, 'utf8')).toBe(oldBytes);
});

it('refuses a removable data receipt before writing safety ledgers', () => {
  const state = stateDirectory();
  const directory = prepareTeamPluginData(state);
  const marker = path.join(directory, '.owner.json');
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  writeFileSync(marker, JSON.stringify({
    schemaVersion: owner.schemaVersion, pluginId: owner.pluginId, dataId: owner.dataId,
  }));
  expect(() => agentTeamDataDirectory(state)).toThrow();
  expect(() => new AgentTeamLaunchLedger(state)).toThrow();
  expect(existsSync(path.join(directory, 'launch-receipts'))).toBe(false);
});
