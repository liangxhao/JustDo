import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { CustodyLedger } from '../../custody/ledger';
import { INERT_CUSTODY_HARNESS } from '../../sdk/custody';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  expect(path.dirname(root)).toBe(os.tmpdir()); expect(path.basename(root)).toMatch(/^custody-ledger-/u); rmSync(root, { recursive: true, force: true });
} });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() { const root = mkdtempSync(path.join(os.tmpdir(), 'custody-ledger-')); roots.push(root); return { root, ledger: new CustodyLedger(root), resourceId: sha('resource') }; }

test('a malformed existing scope cannot be adopted as fresh or reopen a closed resource', () => {
  const f = fixture(); const file = path.join(f.root, 'resources', f.resourceId, 'scope.json'); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, '{}');
  expect(() => f.ledger.advance(f.resourceId, 1, 'example')).toThrow('Invalid custody scope');
  expect(readFileSync(file, 'utf8')).toBe('{}');
});

test('native slot metadata is bound to the resource path, epoch and exact incarnation', () => {
  const f = fixture(); f.ledger.advance(f.resourceId, 1, 'example'); const other = sha('other');
  const file = path.join(f.root, 'resources', f.resourceId, '1/slot.json'); mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ resourceId: other, epoch: 1, ownerId: 'example', agentId: 'main', cwd: path.resolve('.'), sessionKey: `agent:main:harness:${INERT_CUSTODY_HARNESS}:${other}:1` }));
  expect(() => f.ledger.slot(f.resourceId, 1)).toThrow('Invalid custody slot');
  expect(() => f.ledger.slots(f.resourceId)).toThrow('Invalid custody slot');
});

test('an existing native preparation epoch without its slot remains unknown rather than empty', () => {
  const f = fixture(); f.ledger.advance(f.resourceId, 1, 'example'); mkdirSync(path.join(f.root, 'resources', f.resourceId, '1'));
  expect(() => f.ledger.slots(f.resourceId)).toThrow('no slot metadata');
});

test('a receipt-only cancellation before preparation can close without inventing a native slot', () => {
  const f = fixture(); f.ledger.advance(f.resourceId, 1, 'example'); f.ledger.cancel(f.resourceId, 2, ['request']);
  expect(f.ledger.receipt(f.resourceId, 2, 'request')?.state).toBe('cancelled'); expect(f.ledger.slots(f.resourceId)).toEqual([]);
  f.ledger.close(f.resourceId); expect(() => f.ledger.advance(f.resourceId, 3, 'example')).toThrow('closed');
});

test('public execution reads reject unsupported settlement or wrong owner/file identities', () => {
  const f = fixture(); const operationId = sha('operation'); const file = path.join(f.root, 'executions', sha(JSON.stringify(['example', operationId])) + '.json');
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ ownerId: 'example', operationId, state: 'settled' }));
  expect(() => f.ledger.execution('example', operationId)).toThrow('Invalid execution receipt');
  const invalid = () => undefined; expect(f.ledger.executions(invalid)).toEqual([]);
  expect(readFileSync(file, 'utf8')).toContain('settled');
});
