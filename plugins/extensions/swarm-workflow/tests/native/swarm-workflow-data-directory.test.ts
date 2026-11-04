import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { FlowStore } from '../../data/store';
import { workflowDataDirectory } from '../../runtime/data-directory';
import { prepareWorkflowPluginData } from './fixtures/pluginData';

const roots: string[] = [];
function stateDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'workflow-data-test-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of roots.splice(0)) {
    expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory)).toMatch(/^workflow-data-test-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});

it('uses the host-prepared retained directory without opening or migrating the old database', () => {
  const state = stateDirectory();
  const legacy = path.join(state, 'swarm-workflow');
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, 'flows.sqlite'), 'old database bytes, never opened');
  const managed = prepareWorkflowPluginData(state);
  const marker = readFileSync(path.join(managed, '.owner.json'), 'utf8');
  expect(workflowDataDirectory(state)).toBe(managed);
  const store = new FlowStore(workflowDataDirectory(state));
  try {
    expect(store.get('old')).toBeUndefined();
    expect(existsSync(path.join(managed, 'flows.sqlite'))).toBe(true);
    expect(readFileSync(path.join(legacy, 'flows.sqlite'), 'utf8')).toBe('old database bytes, never opened');
    expect(readFileSync(path.join(managed, '.owner.json'), 'utf8')).toBe(marker);
  } finally { store.close(); }
});

it('never creates Native ownership when host preparation is absent', () => {
  const state = stateDirectory();
  expect(() => workflowDataDirectory(state)).toThrow();
  expect(existsSync(path.join(state, 'plugin-data'))).toBe(false);
});

it('refuses a removable owner before opening the execution store', () => {
  const state = stateDirectory();
  const managed = prepareWorkflowPluginData(state);
  const marker = path.join(managed, '.owner.json');
  const owner = JSON.parse(readFileSync(marker, 'utf8'));
  delete owner.retention;
  writeFileSync(marker, JSON.stringify(owner));
  expect(() => workflowDataDirectory(state)).toThrow();
  expect(existsSync(path.join(managed, 'flows.sqlite'))).toBe(false);
});
