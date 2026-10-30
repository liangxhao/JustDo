import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { DiscussionLedger } from '../../../runtime/discussion/ledger';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('same-directory receipt consumers retain separate owners and never replay a lost dispatcher', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'receipt-store-test-'));
  roots.push(directory);
  const writer = new DiscussionLedger(directory);
  writer.write({ roomId: 'room', discussionId: 'batch', owner: writer.owner,
    fingerprint: 'input', state: 'running', executions: [] });
  const observer = new DiscussionLedger(directory, true);
  expect(observer.owner).not.toBe(writer.owner);
  expect(observer.read('batch', false)?.state).toBe('running');
  expect(JSON.parse(readFileSync(path.join(directory, 'batch.json'), 'utf8')).state).toBe('running');
  expect(observer.read('batch')).toMatchObject({ state: 'unknown', interrupted: true, owner: writer.owner });
  expect(writer.read('batch')?.state).toBe('unknown');
});

test('terminal receipts without both native settlement and cleanup recover as unknown', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'receipt-store-test-'));
  roots.push(directory);
  const ledger = new DiscussionLedger(directory);
  ledger.write({ roomId: 'room', discussionId: 'batch', owner: ledger.owner,
    fingerprint: 'input', state: 'completed', cleanupComplete: false, executions: [] });
  expect(ledger.read('batch')?.state).toBe('unknown');
});
