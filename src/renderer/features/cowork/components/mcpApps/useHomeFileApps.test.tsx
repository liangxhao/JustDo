// @vitest-environment jsdom
import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useHomeFileApps } from './useHomeFileApps';
import type { McpAppWorkspaceFileEntry } from './workspaceApps';

interface TestHost {
  isCurrent: () => boolean;
}
const f = vi.hoisted(() => ({
  prepare: vi.fn<(host: TestHost) => Promise<TestHost>>(),
  discover: vi.fn<() => Promise<McpAppDiscovery>>(),
  launch: vi.fn(),
  dispose: vi.fn(),
  hosts: [] as TestHost[],
  open: vi.fn(),
}));
vi.mock('@/libs/openclaw-chat/gateway/mcp-workspace-session', () => ({
  McpWorkspaceSession: class {
    constructor(
      _scope: unknown,
      readonly host: TestHost,
    ) {
      f.hosts.push(host);
    }
    apps = { discover: f.discover, launch: f.launch };
    prepare = () => f.prepare(this.host);
    dispose = f.dispose;
  },
}));
vi.mock('@/libs/openclaw-chat/pipeline/native-mcp-app', () => ({
  decodeMcpAppLaunch: (value: unknown) => value,
}));
vi.mock('./workspaceApps', () => ({ openWorkspaceAppFile: f.open }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  f.hosts.length = 0;
});

function setup() {
  f.discover.mockResolvedValue({
    servers: [
      {
        serverName: 'sheet',
        label: 'Sheet',
        entrypoints: [
          {
            toolName: 'preview_file',
            title: 'Preview',
            resourceUri: 'ui://sheet/editor',
            entrypoint: { type: 'file', extensions: ['.xlsx'] },
          },
        ],
      },
    ],
  });
  f.prepare.mockImplementation(async host => ({ isCurrent: host.isCurrent }));
  f.launch.mockResolvedValue({ viewId: 'view' });
  const options = {
    enabled: true,
    cwd: 'E:/workspace',
    agentId: 'main',
    permissionMode: 'auto',
    addDraft: vi.fn(),
  };
  const hook = renderHook((props = options) => useHomeFileApps(props), { initialProps: options });
  const request = { filePath: 'E:/workspace/预算.xlsx', isCurrent: () => true };
  return { ...hook, options, request };
}

test('opens a file in the homepage workspace without mounting a chat or passively preparing', async () => {
  const { result, request } = setup();
  expect(f.prepare).not.toHaveBeenCalled();
  await act(async () => expect(await result.current(request)).toBe(true));
  const entry = f.open.mock.calls[0][0] as McpAppWorkspaceFileEntry;
  expect(entry).toMatchObject({
    sessionId: '__home__',
    filePath: request.filePath,
    label: '预算.xlsx',
  });
  expect(f.launch).not.toHaveBeenCalled();
  const loaded = await entry.load(new AbortController().signal);
  expect(loaded.preview.viewId).toBe('view');
  expect(f.launch).toHaveBeenCalledOnce();
});

test('ordinary preview remains available when no file handler matches or Gateway is unavailable', async () => {
  const { result, request } = setup();
  expect(await result.current({ ...request, filePath: 'E:/workspace/notes.md' })).toBe(false);
  f.prepare.mockRejectedValueOnce(new Error('Gateway unavailable'));
  expect(await result.current(request)).toBe(false);
  expect(f.open).not.toHaveBeenCalled();
});

test('leaving home during discovery cannot create a tab or launch a tool', async () => {
  const { result, request, rerender, options } = setup();
  let finish!: (value: McpAppDiscovery) => void;
  f.discover.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = result.current(request);
  await act(async () => {});
  rerender({ ...options, enabled: false });
  finish({ servers: [] });
  expect(await pending).toBe(false);
  expect(f.open).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.dispose).toHaveBeenCalledOnce();
});

test('changing the homepage workspace revokes a reserved file load', async () => {
  const { result, request, rerender, options } = setup();
  expect(await result.current(request)).toBe(true);
  const entry = f.open.mock.calls[0][0] as McpAppWorkspaceFileEntry;
  rerender({ ...options, cwd: 'E:/other' });
  await expect(entry.load(new AbortController().signal)).rejects.toThrow('changed');
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.hosts[0].isCurrent()).toBe(false);
});

test('reload discovers again and rejects a removed handler instead of replaying it', async () => {
  const { result, request } = setup();
  await result.current(request);
  const loaded = await (f.open.mock.calls[0][0] as McpAppWorkspaceFileEntry).load(
    new AbortController().signal,
  );
  f.discover.mockResolvedValueOnce({ servers: [] });
  await expect(loaded.context.reopen?.()).rejects.toThrow('no longer available');
  expect(f.launch).toHaveBeenCalledOnce();
});
