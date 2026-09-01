import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawSessionMigrationPhase } from '../../../shared/openclaw/sessionMigration';
import { SessionStoreMigrationCoordinator } from './sessionStoreMigration';

const temporaryDirectories: string[] = [];

const fixture = () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-session-migration-'));
  temporaryDirectories.push(baseDir);
  const stateDir = path.join(baseDir, 'state');
  const sourcePath = path.join(stateDir, 'agents', 'main', 'sessions', 'sessions.json');
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, JSON.stringify({ 'agent:main:justdo:one': { sessionId: 'one' } }));
  return { baseDir, stateDir, sourcePath };
};

const createVerifiedBackup = (args: string[]) => {
  const outputIndex = args.indexOf('--output');
  const archivePath = args[outputIndex + 1];
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, 'verified backup');
  return { stdout: JSON.stringify({ archivePath, verified: true }), stderr: '' };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not run doctor when no legacy sessions.json exists', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-session-migration-empty-'));
  temporaryDirectories.push(baseDir);
  const runCli = vi.fn();
  const coordinator = new SessionStoreMigrationCoordinator({
    baseDir,
    stateDir: path.join(baseDir, 'state'),
    runtimeVersion: () => 'v2026.8.1',
    runCli,
  });

  await expect(coordinator.plan()).resolves.toEqual({
    required: false,
    sourceCount: 0,
    agents: [],
  });
  expect(runCli).not.toHaveBeenCalled();
});

test('fails closed and redacts paths and credentials when legacy discovery fails', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-session-migration-scan-'));
  temporaryDirectories.push(baseDir);
  const stateDir = path.join(baseDir, 'private-state');
  fs.mkdirSync(path.join(stateDir, 'agents'), { recursive: true });
  const runCli = vi.fn();
  const readdir = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
    throw new Error(`${stateDir} Authorization: Bearer scan-secret`);
  });
  const coordinator = new SessionStoreMigrationCoordinator({
    baseDir,
    stateDir,
    runtimeVersion: () => 'v2026.8.1',
    runCli,
  });

  const plan = await coordinator.plan();

  expect(plan).toMatchObject({
    required: true,
    phase: OpenClawSessionMigrationPhase.Failed,
    sourceCount: 0,
  });
  expect(plan.error).not.toContain(stateDir);
  expect(plan.error).not.toContain('scan-secret');
  expect(runCli).not.toHaveBeenCalled();
  readdir.mockRestore();
});

test('dry-runs all agents and cancellation leaves every source untouched', async () => {
  const { baseDir, stateDir, sourcePath } = fixture();
  const runCli = vi.fn().mockResolvedValue({
    stdout: JSON.stringify({
      totals: { targets: 1, legacyEntries: 1, validatedTranscriptEvents: 2 },
    }),
    stderr: '',
  });
  const coordinator = new SessionStoreMigrationCoordinator({
    baseDir,
    stateDir,
    runtimeVersion: () => 'v2026.8.1',
    runCli,
  });

  const plan = await coordinator.plan();
  expect(plan).toMatchObject({
    required: true,
    sourceCount: 1,
    agents: ['main'],
    dryRun: { targetCount: 1, sessionCount: 1, transcriptCount: 2 },
  });
  await expect(coordinator.confirm(plan.planId!, false)).resolves.toMatchObject({
    success: false,
    cancelled: true,
    progress: { phase: OpenClawSessionMigrationPhase.Cancelled },
  });
  expect(fs.existsSync(sourcePath)).toBe(true);
  expect(runCli).toHaveBeenCalledTimes(1);
});

test('keeps the legacy source and stops before import when backup verification fails', async () => {
  const { baseDir, stateDir, sourcePath } = fixture();
  const runCli = vi
    .fn()
    .mockResolvedValueOnce({ stdout: JSON.stringify({ targetCount: 1 }), stderr: '' })
    .mockRejectedValueOnce(new Error('apiKey=secret-value backup failed'));
  const coordinator = new SessionStoreMigrationCoordinator({
    baseDir,
    stateDir,
    runtimeVersion: () => 'v2026.8.1',
    runCli,
  });

  const plan = await coordinator.plan();
  const result = await coordinator.confirm(plan.planId!, true);

  expect(result).toMatchObject({ success: false, progress: { phase: 'failed' } });
  expect(result.error).not.toContain('secret-value');
  expect(fs.existsSync(sourcePath)).toBe(true);
  expect(runCli).toHaveBeenCalledTimes(2);
});

test('restores archived sources when post-import integrity validation fails', async () => {
  const { baseDir, stateDir, sourcePath } = fixture();
  const original = fs.readFileSync(sourcePath);
  const runCli = vi.fn(async (args: string[]) => {
    if (args.includes('dry-run')) return { stdout: '{}', stderr: '' };
    if (args.includes('create')) return createVerifiedBackup(args);
    if (args.includes('import')) {
      fs.rmSync(sourcePath);
      return { stdout: '{}', stderr: '' };
    }
    if (args.includes('validate')) throw new Error('integrity check failed');
    if (args.includes('restore')) {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, original);
      return { stdout: '{}', stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  });
  const coordinator = new SessionStoreMigrationCoordinator({
    baseDir,
    stateDir,
    runtimeVersion: () => 'v2026.8.1',
    runCli,
  });

  const plan = await coordinator.plan();
  await expect(coordinator.confirm(plan.planId!, true)).resolves.toMatchObject({
    success: false,
    error: 'integrity check failed',
  });
  expect(fs.readFileSync(sourcePath)).toEqual(original);
  expect(runCli.mock.calls.some(([args]) => args.includes('restore'))).toBe(true);
});

test('writes a receipt and does not repeat migration after successful verified import', async () => {
  const { baseDir, stateDir, sourcePath } = fixture();
  const runCli = vi.fn(async (args: string[]) => {
    if (args.includes('dry-run')) {
      return { stdout: JSON.stringify({ targetCount: 1, sessionCount: 1 }), stderr: '' };
    }
    if (args.includes('create')) return createVerifiedBackup(args);
    if (args.includes('import')) {
      fs.rmSync(sourcePath);
      return { stdout: JSON.stringify({ imported: 1 }), stderr: '' };
    }
    if (args.includes('validate')) {
      return { stdout: JSON.stringify({ ok: true, integrityCheck: 'ok' }), stderr: '' };
    }
    if (args.includes('inspect')) {
      return { stdout: JSON.stringify({ targets: [{ agentId: 'main', sessions: 1 }] }), stderr: '' };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  });
  const coordinator = new SessionStoreMigrationCoordinator({
    baseDir,
    stateDir,
    runtimeVersion: () => 'v2026.8.1',
    runCli,
    now: () => Date.UTC(2026, 8, 1),
  });

  const plan = await coordinator.plan();
  const result = await coordinator.confirm(plan.planId!, true);

  expect(result).toMatchObject({
    success: true,
    progress: { phase: OpenClawSessionMigrationPhase.Completed },
  });
  expect(fs.existsSync(result.progress!.receiptPath!)).toBe(true);
  await expect(coordinator.plan()).resolves.toMatchObject({ required: false });
  expect(runCli).toHaveBeenCalledTimes(5);
  const manifestPath = JSON.parse(fs.readFileSync(result.progress!.receiptPath!, 'utf8'))
    .manifestPath as string;
  expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))).toMatchObject({
    validate: { ok: true, integrityCheck: 'ok' },
    inspect: { targets: [{ agentId: 'main', sessions: 1 }] },
  });
});
