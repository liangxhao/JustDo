import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { CoworkSessionExportIpc } from '../../../shared/cowork/sessionExport';
import type { CoworkSession } from '../../data/coworkStore';

const mocks = vi.hoisted(() => ({ handle: vi.fn(), save: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => 'C:/downloads' },
  dialog: { showSaveDialog: mocks.save },
  ipcMain: { handle: mocks.handle },
}));
vi.mock('../../core/i18n', () => ({ t: (key: string) => key }));
vi.mock('../../core/window/workspaceWindowManager', () => ({ getWorkspaceDialogOwner: () => undefined }));

import { registerCoworkSessionExport } from './sessionExport';

const session = {
  id: 'product-session',
  title: 'Saved conversation',
  agentId: 'main',
  cwd: 'C:/workspace',
  createdAt: 1,
  updatedAt: 2,
  nativeSessionKey: 'agent:main:worktree:source',
  historyBinding: {
    sessionKey: 'agent:main:worktree:source',
    nativeSessionId: 'physical-id',
    availability: 'native',
  },
} as CoworkSession;

let directory: string;
let destination: string;

beforeEach(async () => {
  mocks.handle.mockClear();
  mocks.save.mockReset();
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-export-ipc-test-'));
  destination = path.join(directory, 'conversation.json');
  mocks.save.mockResolvedValue({ canceled: false, filePath: destination });
});

afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

function register() {
  let generation = 1;
  const getSession = vi.fn(() => session);
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method !== 'chat.history') throw new Error('Unexpected method');
    if (params.cursor) return {
      kind: 'delta', deltaCursor: 'verified', messages: [],
      sessionInfo: { key: session.nativeSessionKey, sessionId: 'physical-id' },
    };
    const first = params.offset === 0;
    return {
      sessionKey: session.nativeSessionKey,
      sessionId: 'physical-id',
      totalMessages: 2,
      hasMore: first,
      ...(first ? { nextOffset: 1, deltaCursor: 'snapshot' } : {}),
      messages: [first ? { role: 'assistant', content: 'latest page' } : { role: 'user', content: 'older page' }],
    };
  });
  const client = { start: vi.fn(), stop: vi.fn(), request };
  const runtime = {
    getGatewayClient: () => client,
    getGatewayClientGeneration: () => generation,
    getAutomaticErrorRetryActivity: () => ({ revision: 0, sessionIds: [] }),
  };
  const isAllowedSender = vi.fn(() => true);
  registerCoworkSessionExport({
    getSession,
    isAllowedSender,
    getRuntime: (() => runtime) as Parameters<typeof registerCoworkSessionExport>[0]['getRuntime'],
    isExternalSessionExecuting: () => false,
  });
  expect(mocks.handle).toHaveBeenCalledWith(CoworkSessionExportIpc.Export, expect.any(Function));
  const event = { sender: { id: 1, once: vi.fn(), removeListener: vi.fn() } };
  const invoke = (input: unknown = { sessionId: session.id, includeRawData: true }) =>
    mocks.handle.mock.calls[0][1](event, input);
  return { invoke, isAllowedSender, getSession, request, changeGeneration: () => generation++ };
}

test('uses the saved native identity and publishes both pages from a single IPC request', async () => {
  const { invoke, request } = register();

  expect(await invoke()).toEqual({ success: true, canceled: false });

  expect(request.mock.calls.map(([, params]) => [params.sessionKey, params.offset, params.cursor])).toEqual([
    [session.nativeSessionKey, 0, undefined],
    [session.nativeSessionKey, 1, undefined],
    [session.nativeSessionKey, undefined, 'snapshot'],
  ]);
  const exported = JSON.parse(await fs.readFile(destination, 'utf8'));
  expect(exported.messages.map((message: { content: string }) => message.content)).toEqual([
    'older page', 'latest page',
  ]);
  expect(exported.extensions.justdo.session_key).toBe(session.nativeSessionKey);
});

test('rejects a non-owning sender or invalid options before resolving the session', async () => {
  const { invoke, isAllowedSender, getSession } = register();
  isAllowedSender.mockReturnValueOnce(false);

  expect(await invoke()).toMatchObject({ success: false });
  expect(await invoke({ sessionId: session.id, includeRawData: 'true' })).toMatchObject({ success: false });
  expect(getSession).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

test('leaves an existing file untouched when the selected connection changes', async () => {
  const { invoke, request, changeGeneration } = register();
  const reply = request.getMockImplementation()!;
  request.mockImplementationOnce(async (method, params) => {
    const result = await reply(method, params);
    changeGeneration();
    return result;
  });
  await fs.writeFile(destination, 'existing export');

  expect(await invoke()).toEqual({ success: false, reason: 'changed' });
  expect(await fs.readFile(destination, 'utf8')).toBe('existing export');
});
