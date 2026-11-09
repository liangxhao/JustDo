import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import { ChromeExtensionChatController } from './chromeExtensionChatController';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-workspace-'));
  roots.push(root);
  const configured = path.join(root, 'default');
  const selected = path.join(root, '项目 空格');
  fs.mkdirSync(configured);
  fs.mkdirSync(selected);
  const row = {
    id: 'browser',
    title: 'Browser',
    source: CoworkSessionSource.ChromeExtension as string,
    cwd: configured,
    agentId: 'main',
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
    permissionMode: 'ask',
  };
  const config = { workingDirectory: configured, permissionMode: 'ask' };
  const store = {
    getConfig: () => config,
    getSession: () => row,
    listSessions: () => [{ id: row.id }],
    createSession: vi.fn((_title: string, cwd: string) => {
      row.cwd = cwd;
      return row;
    }),
  };
  const selectDirectory = vi.fn(async () => selected);
  const setSessionWorkspace = vi.fn(async (_input: unknown, allowed: () => boolean) =>
    allowed()
      ? { success: true as const, cwd: selected }
      : { success: false as const, reason: 'unsupported' as const },
  );
  const controller = new ChromeExtensionChatController({
    getStore: () => store as never,
    getRouter: vi.fn(),
    getRuntime: () => null,
    ensureEngineRunning: vi.fn(),
    selectDirectory,
    setSessionWorkspace,
  });
  return {
    row,
    config,
    store,
    controller,
    configured,
    selected,
    selectDirectory,
    setSessionWorkspace,
  };
}

test('creates a selected workspace only with host-side selection proof and leaves the default unchanged', async () => {
  const f = setup();
  await expect(f.controller.startThread('Browser', { cwd: f.selected })).rejects.toThrow(
    'desktop app',
  );
  expect(f.store.createSession).not.toHaveBeenCalled();
  const assertCurrent = vi.fn();
  await expect(
    f.controller.startThread('Browser', {
      cwd: f.selected,
      selectedWorkspace: { assertCurrent },
    }),
  ).resolves.toMatchObject({ cwd: fs.realpathSync.native(f.selected) });
  expect(f.config.workingDirectory).toBe(f.configured);
  expect(assertCurrent).toHaveBeenCalledTimes(2);
});

test('validates recent browser paths without opening a dialog and rejects unknown or deleted folders', async () => {
  const f = setup();
  f.row.cwd = f.selected;
  await expect(f.controller.selectWorkspace({ recentCwd: f.selected })).resolves.toBe(
    fs.realpathSync.native(f.selected),
  );
  expect(f.selectDirectory).not.toHaveBeenCalled();
  await expect(
    f.controller.selectWorkspace({ recentCwd: path.dirname(f.selected) }),
  ).rejects.toThrow('recent');
  fs.rmdirSync(f.selected);
  await expect(f.controller.selectWorkspace({ recentCwd: f.selected })).rejects.toThrow();
  expect(fs.existsSync(f.selected)).toBe(false);
});

test('uses the shared updater only for the current browser source and reevaluates transport authorization', async () => {
  const f = setup();
  const input = { sessionId: f.row.id, expectedCwd: f.row.cwd, cwd: f.selected };
  await expect(f.controller.setThreadWorkspace(input, () => false)).resolves.toEqual({
    success: false,
    reason: 'unsupported',
  });
  await expect(f.controller.setThreadWorkspace(input, () => true)).resolves.toMatchObject({
    success: true,
  });
  f.row.source = 'desktop';
  await expect(f.controller.setThreadWorkspace(input, () => true)).rejects.toThrow('not found');
  expect(f.setSessionWorkspace).toHaveBeenCalledTimes(2);
});
