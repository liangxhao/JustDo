// @vitest-environment jsdom
import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { GatewayClientOptions } from '@/libs/openclaw-chat/gateway/client';
import { i18nService } from '@/services/i18n';

import DisplayPanelLauncher from '../display/DisplayPanelLauncher';
import { useHomeFileApps } from './useHomeFileApps';

interface TestClient {
  generation: number;
  connected: boolean;
  options: GatewayClientOptions;
}
const f = vi.hoisted(() => ({
  clients: [] as TestClient[],
  request: vi.fn<(method: string, params?: unknown, options?: unknown) => Promise<unknown>>(),
}));
// Keep the real workspace/session and hook ownership logic; only replace the wire.
vi.mock('@/libs/openclaw-chat/gateway/client', () => ({
  GatewayClient: class {
    generation = 1;
    connected = false;
    constructor(readonly options: GatewayClientOptions) { f.clients.push(this); }
    get gatewayUrl() { return this.options.url; }
    start() { this.connected = true; }
    stop() { this.connected = false; }
    request = f.request;
    subscribeEvents() { return () => {}; }
  },
}));
vi.mock('./workspaceApps', () => ({
  openWorkspaceAppFile: vi.fn(),
  openWorkspaceAppLaunch: vi.fn(),
}));

const native = {
  sessionKey: 'agent:main:workspace-preview:connection-test',
  gatewaySessionId: 'native-preview',
  agentId: 'main',
};
const catalog: McpAppDiscovery = { servers: [{
  serverName: 'editor', label: 'Workspace editor',
  entrypoints: [{ toolName: 'open_editor', title: 'Editor', resourceUri: 'ui://editor/app',
    entrypoint: { type: 'global' } }],
}] };
const prepareWorkspace = vi.fn();

function Fixture() {
  const apps = useHomeFileApps({ enabled: true, cwd: 'E:/workspace', agentId: 'main',
    permissionMode: 'auto', addDraft: async () => false });
  return <DisplayPanelLauncher appItems={apps.menu.items}
    onCreateBrowser={() => {}} onCreateTerminal={() => {}} />;
}
const region = () => within(screen.getByRole('region', { name: 'Apps' }));
const expectLoading = () => {
  expect(region().getByRole('status').textContent).toBe('Loading apps…');
  expect(region().queryByRole('alert')).toBeNull();
  expect(region().queryByRole('button', { name: 'Reload app list' })).toBeNull();
};
async function connect() {
  await act(async () => { await vi.dynamicImportSettled(); });
  expect(f.clients).toHaveLength(1);
  return f.clients[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  i18nService.setLanguage('en', { persist: false });
  prepareWorkspace.mockResolvedValue({ success: true, value: native });
  f.request.mockImplementation(async method => method === 'sessions.describe'
    ? { session: { sessionId: native.gatewaySessionId } } : catalog);
  vi.stubGlobal('electron', {
    openclaw: { engine: {
      getStatus: async () => ({ success: true, status: { phase: 'running' } }),
      onProgress: () => () => {},
      getPort: async () => ({ success: true, port: 12345 }),
      getToken: async () => ({ success: true, token: 'fixture-token' }),
    } },
    mcpApps: { prepareWorkspace, releaseWorkspace: async () => ({ success: true }) },
    browser: { listHistory: async () => ({ success: true, entries: [] }) },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  f.clients.length = 0;
});

test('keeps visible loading across an initial socket close and a thirty-second native preparation', async () => {
  let finish!: (value: { success: true; value: typeof native }) => void;
  prepareWorkspace.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<Fixture />);
  const client = await connect();
  expectLoading();
  await act(async () => {
    client.connected = false;
    client.options.onClose?.({ code: 1013, reason: 'gateway starting' });
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expectLoading();
  expect(prepareWorkspace).not.toHaveBeenCalled();
  await act(async () => {
    client.generation++;
    client.connected = true;
    client.options.onHello?.({ type: 'hello-ok', protocol: 4 });
  });
  expect(prepareWorkspace).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expectLoading();
  expect(f.clients).toHaveLength(1);
  expect(prepareWorkspace).toHaveBeenCalledOnce();
  expect(f.request).not.toHaveBeenCalled();
  await act(async () => { finish({ success: true, value: native }); });
  expect(region().queryByRole('status')).toBeNull();
  expect(region().queryByRole('alert')).toBeNull();
  expect(region().getByRole('button', { name: 'Workspace editor' })).toBeTruthy();
  expect(f.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'mcp.app.discover']);
});

test('a real connection deadline shows failure and manual retry restores loading before any native creation', async () => {
  render(<Fixture />);
  const client = await connect();
  await act(async () => {
    client.connected = false;
    client.options.onClose?.({ code: 1013, reason: 'gateway starting' });
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(region().queryByRole('status')).toBeNull();
  expect(region().getByRole('alert').textContent).toContain('Could not load app entrypoints.');
  expect(prepareWorkspace).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(region().getByRole('button', { name: 'Reload app list' }));
    await vi.dynamicImportSettled();
  });
  expectLoading();
  expect(f.clients).toHaveLength(2);
  await act(async () => {
    f.clients[1].options.onHello?.({ type: 'hello-ok', protocol: 4 });
  });
  expect(prepareWorkspace).toHaveBeenCalledOnce();
  expect(region().getByRole('button', { name: 'Workspace editor' })).toBeTruthy();
  expect(f.request.mock.calls.map(([method]) => method)).toEqual(['sessions.describe', 'mcp.app.discover']);
});
