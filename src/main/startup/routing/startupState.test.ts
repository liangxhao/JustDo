import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { StartupRoute, StartupStage } from '../../../shared/app/startup/routing';
import { newStartupJournal, readStartupJournal, STARTUP_STATE_FILE, writeStartupJson } from './startupState';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const writeJournal = (historySnapshotDirectory?: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-state-'));
  roots.push(root);
  const journal = { ...newStartupJournal(StartupRoute.Migration), stage: StartupStage.Initialize,
    ...(historySnapshotDirectory === undefined ? {} : { historySnapshotDirectory }) };
  writeStartupJson(path.join(root, STARTUP_STATE_FILE), journal);
  return { root, journal };
};

test('startup records preserve the default snapshot and a generated refresh basename', () => {
  const original = writeJournal();
  expect(readStartupJournal(original.root)).toEqual(original.journal);
  const refreshed = writeJournal('history-refresh-12345678-1234-4321-8765-123456789abc');
  expect(readStartupJournal(refreshed.root)).toEqual(refreshed.journal);
});

test.each(['../history', 'C:\\outside\\history', 'history-refresh-not-a-uuid'])
('startup records reject an unsafe snapshot directory %s', directory => {
  const { root } = writeJournal(directory);
  expect(() => readStartupJournal(root)).toThrow(/Invalid startup recovery record/);
});
