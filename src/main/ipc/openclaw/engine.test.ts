import type { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { WorktreeIpc } from '../../../shared/openclaw/worktrees';

const { ipcHandle } = vi.hoisted(() => ({ ipcHandle: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcHandle },
}));

import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  buildWindowsTerminalCandidates,
  getOpenClawTerminalEnvKeys,
  readOpenClawAssistantMedia,
  registerOpenClawEngineHandlers,
  resolveExternalTerminalCwd,
  resolveWindowsPowerShell,
  restartOpenClawGatewayForUser,
  spawnDetachedTerminal,
} from './engine';

const createRestartHarness = (options: {
  phase?: 'ready' | 'starting' | 'running' | 'error';
  activePort?: number;
  configuredPort?: number;
  ready?: boolean;
  requestResult?: unknown;
  requestError?: Error;
  restartPhase?: 'ready' | 'running' | 'error';
  pendingLaunchEnvironmentChanges?: boolean;
} = {}) => {
  const initialStatus = {
    phase: options.phase ?? 'running',
    version: 'v-test',
    canRetry: false,
  } as const;
  const restartStatus = {
    phase: options.restartPhase ?? 'running',
    version: 'v-test',
    canRetry: false,
  } as const;
  let currentStatus = initialStatus;
  const manager = {
    getStatus: vi.fn(() => currentStatus),
    getGatewayPort: vi.fn().mockReturnValue(options.activePort ?? 6126),
    getConfiguredGatewayPort: vi.fn().mockReturnValue(options.configuredPort ?? 6126),
    hasPendingGatewayLaunchEnvironmentChanges: vi
      .fn()
      .mockReturnValue(options.pendingLaunchEnvironmentChanges ?? false),
    getGatewayLifecycleGeneration: vi.fn().mockReturnValue(7),
    waitForGatewayReadyAfter: vi.fn().mockResolvedValue(options.ready ?? true),
    startGateway: vi.fn(async () => {
      currentStatus = restartStatus;
      return restartStatus;
    }),
    restartGateway: vi.fn(async () => {
      currentStatus = restartStatus;
      return restartStatus;
    }),
    onSessionMigrationProgress: vi.fn().mockReturnValue(() => undefined),
  };
  const requestGateway = options.requestError
    ? vi.fn().mockRejectedValue(options.requestError)
    : vi.fn().mockResolvedValue(
        options.requestResult ?? {
          ok: true,
          status: 'scheduled',
          restart: { delayMs: 0 },
        },
      );
  const reconnectGatewayClient = vi.fn().mockResolvedValue(undefined);

  return {
    manager,
    requestGateway,
    reconnectGatewayClient,
    restart: () =>
      restartOpenClawGatewayForUser({
        getManager: () => manager as unknown as OpenClawEngineManager,
        requestGateway: requestGateway as unknown as <T>(
          method: string,
          params?: unknown,
        ) => Promise<T>,
        reconnectGatewayClient,
      }),
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ipcHandle.mockReset();
});

describe('OpenClaw assistant media bridge', () => {
  test('loads managed inbound images in Main without exposing the Gateway token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Blob(['abc'], { type: 'image/png' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = {
      getStatus: () => ({ phase: 'running' }),
      getGatewayConnectionInfo: () => ({ port: 6126, token: 'gateway-token' }),
    } as unknown as OpenClawEngineManager;

    await expect(
      readOpenClawAssistantMedia(manager, {
        source: 'media://inbound/photo.png',
        sessionKey: 'agent:main:justdo:session-1',
      }),
    ).resolves.toEqual({
      success: true,
      dataUrl: 'data:image/png;base64,YWJj',
      mimeType: 'image/png',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:6126/__openclaw__/assistant-media?source=media%3A%2F%2Finbound%2Fphoto.png&sessionKey=agent%3Amain%3Ajustdo%3Asession-1&agentId=main',
      expect.objectContaining({
        headers: {
          Accept: 'image/*',
          Authorization: 'Bearer gateway-token',
        },
        redirect: 'error',
      }),
    );
  });

  test('rejects non-managed sources before making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const manager = {} as OpenClawEngineManager;

    await expect(
      readOpenClawAssistantMedia(manager, {
        source: 'https://example.test/private.png',
        sessionKey: 'agent:main:justdo:session-1',
      }),
    ).resolves.toEqual({ success: false, error: 'Invalid Gateway image request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    'media://outbound/photo.png',
    'media://inbound/',
    'media://inbound/nested%2Fphoto.png',
    'media://inbound/%00.png',
    'media://inbound/nested/../photo.png',
    'media://inbound/%2e%2e',
    'media://inbound/photo.png?raw=1',
    'media://inbound/photo.png#preview',
    'media://inbound/%',
  ])('rejects non-canonical managed source %s', async source => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      readOpenClawAssistantMedia({} as OpenClawEngineManager, {
        source,
        sessionKey: 'agent:main:justdo:session-1',
      }),
    ).resolves.toEqual({ success: false, error: 'Invalid Gateway image request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('bounds session keys to the Gateway protocol limit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      readOpenClawAssistantMedia({} as OpenClawEngineManager, {
        source: 'media://inbound/photo.png',
        sessionKey: 's'.repeat(513),
      }),
    ).resolves.toEqual({ success: false, error: 'Invalid Gateway image request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('bounds managed source length before constructing the Gateway URL', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      readOpenClawAssistantMedia({} as OpenClawEngineManager, {
        source: `media://inbound/${'a'.repeat(2_048)}.png`,
        sessionKey: 'agent:main:justdo:session-1',
      }),
    ).resolves.toEqual({ success: false, error: 'Invalid Gateway image request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not derive an agent parameter from an unqualified session key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Blob(['abc'], { type: 'image/png' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = {
      getStatus: () => ({ phase: 'running' }),
      getGatewayConnectionInfo: () => ({ port: 6126, token: 'gateway-token' }),
    } as unknown as OpenClawEngineManager;

    await readOpenClawAssistantMedia(manager, {
      source: 'media://inbound/photo.png',
      sessionKey: 'justdo:legacy-session',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.not.stringContaining('agentId='),
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  test('loads a session-bound managed outgoing image through Main', async () => {
    const attachmentId = '11111111-1111-4111-8111-111111111111';
    const sessionKey = 'agent:main:justdo:session-1';
    const source = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Blob(['abc'], { type: 'image/png' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = {
      getStatus: () => ({ phase: 'running' }),
      getGatewayConnectionInfo: () => ({ port: 6126, token: 'gateway-token' }),
    } as unknown as OpenClawEngineManager;

    await expect(
      readOpenClawAssistantMedia(manager, { source, sessionKey }),
    ).resolves.toMatchObject({ success: true, mimeType: 'image/png' });
    expect(fetchMock).toHaveBeenCalledWith(`http://127.0.0.1:6126${source}`, {
      headers: {
        Accept: 'image/*',
        Authorization: 'Bearer gateway-token',
        'x-openclaw-requester-session-key': sessionKey,
      },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  test.each([
    '/api/chat/media/outgoing/agent%3Aother%3Ajustdo%3Asession-1/11111111-1111-4111-8111-111111111111/full',
    '/api/chat/media/outgoing/agent%253Amain%253Ajustdo%253Asession-1/11111111-1111-4111-8111-111111111111/full',
    '/api/chat/media/outgoing/agent%3Amain%3Ajustdo%3Asession-1/not-a-uuid/full',
    '/api/chat/media/outgoing/agent%3Amain%3Ajustdo%3Asession-1/11111111-1111-4111-8111-111111111111/thumbnail',
    '/api/chat/media/outgoing/agent%3Amain%3Ajustdo%3Asession-1/11111111-1111-4111-8111-111111111111/full?mediaTicket=untrusted',
    '//example.test/api/chat/media/outgoing/agent%3Amain%3Ajustdo%3Asession-1/11111111-1111-4111-8111-111111111111/full',
  ])('rejects invalid or differently scoped outgoing source %s', async source => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      readOpenClawAssistantMedia({} as OpenClawEngineManager, {
        source,
        sessionKey: 'agent:main:justdo:session-1',
      }),
    ).resolves.toEqual({ success: false, error: 'Invalid Gateway image request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('returns a structured failure when connection metadata cannot be read', async () => {
    const manager = {
      getStatus: () => ({ phase: 'running' }),
      getGatewayConnectionInfo: () => {
        throw new Error('metadata unavailable');
      },
    } as unknown as OpenClawEngineManager;

    await expect(
      readOpenClawAssistantMedia(manager, {
        source: 'media://inbound/photo.png',
        sessionKey: 'agent:main:justdo:session-1',
      }),
    ).resolves.toEqual({ success: false, error: 'metadata unavailable' });
  });

  test('cancels rejected response bodies without buffering them', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 404 })));
    const manager = {
      getStatus: () => ({ phase: 'running' }),
      getGatewayConnectionInfo: () => ({ port: 6126, token: 'gateway-token' }),
    } as unknown as OpenClawEngineManager;

    await expect(
      readOpenClawAssistantMedia(manager, {
        source: 'media://inbound/photo.png',
        sessionKey: 'agent:main:justdo:session-1',
      }),
    ).resolves.toEqual({ success: false, error: 'Gateway image is unavailable (404)' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  test('rejects declared oversized images and cancels the response body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(20 * 1024 * 1024 + 1),
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const manager = {
      getStatus: () => ({ phase: 'running' }),
      getGatewayConnectionInfo: () => ({ port: 6126, token: 'gateway-token' }),
    } as unknown as OpenClawEngineManager;

    await expect(
      readOpenClawAssistantMedia(manager, {
        source: 'media://inbound/photo.png',
        sessionKey: 'agent:main:justdo:session-1',
      }),
    ).resolves.toEqual({ success: false, error: 'Gateway image is too large' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  test('aborts stalled Gateway requests after the media timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const manager = {
      getStatus: () => ({ phase: 'running' }),
      getGatewayConnectionInfo: () => ({ port: 6126, token: 'gateway-token' }),
    } as unknown as OpenClawEngineManager;

    const result = readOpenClawAssistantMedia(manager, {
      source: 'media://inbound/photo.png',
      sessionKey: 'agent:main:justdo:session-1',
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(result).resolves.toEqual({
      success: false,
      error: 'Gateway image request timed out',
    });
  });
});

describe('OpenClaw terminal environment', () => {
  test('keeps current OpenClaw runtime controls', () => {
    const keys = getOpenClawTerminalEnvKeys({
      OPENCLAW_BUNDLED_SKILLS_DIR: 'C:\\runtime\\skills',
      OPENCLAW_BUNDLED_HOOKS_DIR: 'C:\\runtime\\dist\\bundled',
      OPENCLAW_NO_AUTO_UPDATE: '1',
      UNRELATED_HOST_VALUE: 'blocked',
    });

    expect(keys).toEqual([
      'PATH',
      'OPENCLAW_BUNDLED_HOOKS_DIR',
      'OPENCLAW_BUNDLED_SKILLS_DIR',
      'OPENCLAW_NO_AUTO_UPDATE',
    ]);
  });

  test('keeps proxy and trust settings needed by terminal CLI tools', () => {
    const keys = getOpenClawTerminalEnvKeys({
      NODE_OPTIONS: '--use-system-ca',
      NODE_EXTRA_CA_CERTS: '/state/ca.pem',
      REQUESTS_CA_BUNDLE: '/state/ca.pem',
      CURL_CA_BUNDLE: '/state/ca.pem',
      SSL_CERT_FILE: '/state/ca.pem',
      PIP_CERT: '/state/ca.pem',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      http_proxy: 'http://127.0.0.1:8080',
      NO_PROXY: '127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
    });

    expect(keys).toEqual([
      'PATH',
      'CURL_CA_BUNDLE',
      'HTTPS_PROXY',
      'NODE_EXTRA_CA_CERTS',
      'NODE_OPTIONS',
      'NODE_USE_ENV_PROXY',
      'NO_PROXY',
      'PIP_CERT',
      'REQUESTS_CA_BUNDLE',
      'SSL_CERT_FILE',
      'http_proxy',
    ]);
  });

  test('passes the managed Python user base but excludes unrelated host values', () => {
    const keys = getOpenClawTerminalEnvKeys({
      PATH: 'C:\\Windows',
      PYTHONUSERBASE: 'C:\\Users\\test\\AppData\\Roaming\\JustDo\\runtimes\\python-user',
      JUSTDO_MANAGED_PYTHON_USER_BASE:
        'C:\\Users\\test\\AppData\\Roaming\\JustDo\\runtimes\\python-user',
      UNRELATED_HOST_VALUE: 'blocked',
    });

    expect(keys).toContain('PYTHONUSERBASE');
    expect(keys).not.toContain('JUSTDO_MANAGED_PYTHON_USER_BASE');
    expect(keys).not.toContain('UNRELATED_HOST_VALUE');
  });

  test.each([
    ['missing provenance', undefined],
    ['mismatched provenance', 'C:\\untrusted\\python-user'],
    ['empty provenance', ''],
  ])('excludes a host Python user base with %s', (_label, provenance) => {
    const keys = getOpenClawTerminalEnvKeys({
      PATH: 'C:\\Windows',
      PYTHONUSERBASE: 'C:\\host\\python-user',
      ...(provenance === undefined
        ? {}
        : { JUSTDO_MANAGED_PYTHON_USER_BASE: provenance }),
    });

    expect(keys).not.toContain('PYTHONUSERBASE');
    expect(keys).not.toContain('JUSTDO_MANAGED_PYTHON_USER_BASE');
  });

  test('excludes a lowercase provenance lookalike', () => {
    const keys = getOpenClawTerminalEnvKeys({
      PATH: 'C:\\Windows',
      PYTHONUSERBASE: 'C:\\host\\python-user',
      justdo_managed_python_user_base: 'C:\\host\\python-user',
    });

    expect(keys).not.toContain('PYTHONUSERBASE');
    expect(keys).not.toContain('justdo_managed_python_user_base');
  });
});

describe('external terminal startup', () => {
  test('prefers PowerShell 7 when pwsh.exe is available on PATH', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'powershell-path-'));
    const executable = path.join(directory, 'pwsh.exe');
    fs.writeFileSync(executable, '');
    try {
      expect(resolveWindowsPowerShell({ PATH: directory })).toBe(executable);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('opens Windows PowerShell first with command prompt and Windows Terminal fallbacks', () => {
    expect(
      buildWindowsTerminalCandidates(
        'C:\\Windows\\System32\\cmd.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\workspace',
        "JustDo's Terminal",
      ),
    ).toEqual([
      {
        command: 'C:\\Windows\\System32\\cmd.exe',
        args: [
          '/d',
          '/c',
          'start',
          '',
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          '-NoLogo',
          '-NoExit',
          '-Command',
          "$Host.UI.RawUI.WindowTitle = 'JustDo''s Terminal'",
        ],
        windowsHide: true,
      },
      {
        command: 'C:\\Windows\\System32\\cmd.exe',
        args: [
          '/d',
          '/c',
          'start',
          '',
          'C:\\Windows\\System32\\cmd.exe',
          '/d',
          '/k',
          "title JustDo's Terminal",
        ],
        windowsHide: true,
      },
      {
        command: 'wt.exe',
        args: [
          '-w',
          'new',
          'new-tab',
          '-d',
          'C:\\workspace',
          'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          '-NoLogo',
          '-NoExit',
        ],
      },
    ]);
  });

  test('uses a validated requested working directory for a system terminal', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'system-terminal-cwd-'));
    const filePath = path.join(directory, 'file.txt');
    fs.writeFileSync(filePath, 'test');
    try {
      expect(resolveExternalTerminalCwd(directory, 'fallback')).toBe(path.resolve(directory));
      expect(resolveExternalTerminalCwd(undefined, 'fallback')).toBe('fallback');
      expect(() => resolveExternalTerminalCwd(filePath, 'fallback')).toThrow(
        'Terminal working directory is not a directory',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('reports an asynchronous launcher failure', async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const launched = spawnDetachedTerminal(
      { command: 'terminal', args: [] },
      {},
      spawnProcess,
    );

    child.emit('spawn');
    child.emit('exit', 1, null);

    await expect(launched).resolves.toEqual({
      success: false,
      error: 'Terminal launcher exited with code 1',
    });
    expect(child.unref).not.toHaveBeenCalled();
  });

  test('lets a terminal candidate hide only its launcher window', async () => {
    const child = new EventEmitter() as ChildProcess;
    child.unref = vi.fn();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const launched = spawnDetachedTerminal(
      { command: 'cmd.exe', args: [], windowsHide: true },
      { windowsHide: false },
      spawnProcess,
    );

    expect(spawnProcess).toHaveBeenCalledWith('cmd.exe', [], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
    child.emit('exit', 0, null);
    await expect(launched).resolves.toEqual({ success: true });
  });

  test('can wait for a short-lived launcher to exit without assuming startup success', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as ChildProcess;
      child.unref = vi.fn();
      const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
      let settled = false;
      const launched = spawnDetachedTerminal(
        { command: 'osascript', args: [] },
        {},
        spawnProcess,
        null,
      ).then(result => {
        settled = true;
        return result;
      });

      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);

      child.emit('exit', 1, null);
      await expect(launched).resolves.toEqual({
        success: false,
        error: 'Terminal launcher exited with code 1',
      });
      expect(child.unref).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('manual OpenClaw Gateway restart', () => {
  test('uses an in-process restart and waits for the next ready lifecycle', async () => {
    const harness = createRestartHarness();

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.requestGateway).toHaveBeenCalledWith('gateway.restart.request', {
      reason: 'justdo-manual-restart',
      skipDeferral: true,
    });
    expect(harness.manager.waitForGatewayReadyAfter).toHaveBeenCalledWith(7, 30_000);
    expect(harness.manager.restartGateway).not.toHaveBeenCalled();
    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
  });

  test('waits for an in-flight start before requesting the user restart', async () => {
    const harness = createRestartHarness({ phase: 'starting' });

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.manager.startGateway).toHaveBeenCalledOnce();
    expect(harness.requestGateway).toHaveBeenCalledWith('gateway.restart.request', {
      reason: 'justdo-manual-restart',
      skipDeferral: true,
    });
    expect(harness.manager.restartGateway).not.toHaveBeenCalled();
  });

  test('uses a full restart when the configured port differs from the active port', async () => {
    const harness = createRestartHarness({ activePort: 6126, configuredPort: 7000 });

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
  });

  test('uses a full restart when launch environment changes are pending', async () => {
    const harness = createRestartHarness({ pendingLaunchEnvironmentChanges: true });

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
  });

  test.each([
    ['an RPC failure', { requestError: new Error('method unavailable') }],
    ['a rejected request', { requestResult: { ok: false } }],
    ['a ready failure', { ready: false }],
    [
      'a long Gateway cooldown',
      {
        requestResult: {
          ok: true,
          status: 'scheduled',
          restart: { delayMs: 10_000 },
        },
      },
    ],
  ])('falls back to a full restart after %s', async (_label, options) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = createRestartHarness(options);

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
  });

  test('uses a full restart when the Gateway is not currently running', async () => {
    const harness = createRestartHarness({ phase: 'error' });

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.requestGateway).not.toHaveBeenCalled();
    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
  });

  test('keeps a successful restart when the adapter reconnect is transiently unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const harness = createRestartHarness();
    harness.reconnectGatewayClient.mockRejectedValueOnce(new Error('handshake pending'));

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.manager.restartGateway).not.toHaveBeenCalled();
  });

  test('returns after Gateway ready without waiting for the adapter handshake', async () => {
    const harness = createRestartHarness();
    let finishReconnect: (() => void) | undefined;
    harness.reconnectGatewayClient.mockReturnValueOnce(
      new Promise<void>(resolve => {
        finishReconnect = resolve;
      }),
    );

    await expect(harness.restart()).resolves.toMatchObject({ phase: 'running' });

    expect(harness.reconnectGatewayClient).toHaveBeenCalledOnce();
    finishReconnect?.();
  });
});

describe('managed worktree bridge', () => {
  test('serializes settings writes with application config mutations and projects the native readback', async () => {
    const runConfigMutationExclusive = vi.fn(async operation => operation());
    const requestGateway = vi.fn(async () => ({
      valid: true, hash: 'viewed', configRevisionHash: 'resolved', appliedConfigHash: 'resolved',
      config: { models: { secret: 'private-value' } },
    }));
    registerOpenClawEngineHandlers({
      getManager: () => ({
        getStateDir: () => path.resolve('test-state'), onSessionMigrationProgress: vi.fn(),
      }) as unknown as OpenClawEngineManager,
      getCoworkStore: () => ({}) as never,
      runConfigMutationExclusive,
      requestGateway: requestGateway as never,
      reconnectGatewayClient: vi.fn(),
    });
    const read = ipcHandle.mock.calls.find(([name]) => name === WorktreeIpc.Settings)![1];
    const save = ipcHandle.mock.calls.find(([name]) => name === WorktreeIpc.SaveSettings)![1];
    expect(await read(null)).toMatchObject({ success: true, value: { root: null } });
    const result = await save(null, { root: null, acceleration: true, revision: 'viewed' });
    expect(result).toMatchObject({ success: true, value: { acceleration: true } });
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(runConfigMutationExclusive).toHaveBeenCalledOnce();
    expect(requestGateway).toHaveBeenCalledWith('config.patch', {
      baseHash: 'viewed', raw: JSON.stringify({ worktreeRoot: null, worktreeAcceleration: true }),
    });
  });
  test('uses only native Gateway methods and rejects invalid worktree IDs', async () => {
    const requestGateway = vi.fn(async (method: string) =>
      method === 'worktrees.list'
        ? { worktrees: [{ id: 'tree-1', path: '/tmp/tree-1' }] }
        : { removed: true },
    );
    registerOpenClawEngineHandlers({
      runConfigMutationExclusive: operation => operation(),
      getCoworkStore: () => ({ listSessions: () => [] }) as never,
      getManager: () => ({ onSessionMigrationProgress: vi.fn() }) as unknown as OpenClawEngineManager,
      requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
      reconnectGatewayClient: vi.fn(),
    });
    const handler = (channel: string) => {
      const call = ipcHandle.mock.calls.find(([name]) => name === channel);
      if (!call) throw new Error(`Missing ${channel}`);
      return call[1] as (_event: unknown, id?: unknown) => Promise<unknown>;
    };
    await expect(handler(WorktreeIpc.List)(null)).resolves.toMatchObject({ success: true });
    await expect(handler(WorktreeIpc.Remove)(null, 'tree-1')).resolves.toEqual({
      success: true,
      value: { removed: true },
    });
    await expect(handler(WorktreeIpc.Remove)(null, '')).resolves.toMatchObject({
      success: false,
    });
    expect(requestGateway).toHaveBeenCalledWith('worktrees.remove', { id: 'tree-1' });
    expect(requestGateway).toHaveBeenCalledTimes(3);
  });

  test.each(['native', 'ordinary', 'nested'])('keeps a worktree referenced by a local %s conversation', async kind => {
    const requestGateway = vi.fn(async () => ({
      worktrees: [{ id: 'tree-1', path: '/tmp/tree-1' }],
    }));
    registerOpenClawEngineHandlers({
      getManager: () => ({ onSessionMigrationProgress: vi.fn() }) as unknown as OpenClawEngineManager,
      runConfigMutationExclusive: operation => operation(),
      getCoworkStore: () =>
        ({
          listSessions: () => [{ id: 'child' }],
          getSession: () => ({
            ...(kind === 'native' ? { nativeSessionKey: 'agent:main:subagent:child' } : {}),
            cwd: kind === 'nested' ? '/tmp/tree-1/packages/api' : '/tmp/tree-1',
          }),
        }) as never,
      requestGateway: requestGateway as <T>(method: string, params?: unknown) => Promise<T>,
      reconnectGatewayClient: vi.fn(),
    });
    const call = ipcHandle.mock.calls.find(([name]) => name === WorktreeIpc.Remove);
    const remove = call?.[1] as (_event: unknown, id: string) => Promise<unknown>;
    await expect(remove(null, 'tree-1')).resolves.toMatchObject({ success: false });
    expect(requestGateway).not.toHaveBeenCalledWith('worktrees.remove', expect.anything());
  });
});

describe('OpenClaw Gateway restart IPC', () => {
  test('registers the assistant media bridge on its shared channel', () => {
    const harness = createRestartHarness();
    registerOpenClawEngineHandlers({
      runConfigMutationExclusive: operation => operation(),
      getCoworkStore: () => ({ listSessions: () => [] }) as never,
      getManager: () => harness.manager as unknown as OpenClawEngineManager,
      requestGateway: harness.requestGateway as unknown as <T>(
        method: string,
        params?: unknown,
      ) => Promise<T>,
      reconnectGatewayClient: harness.reconnectGatewayClient,
    });

    expect(ipcHandle).toHaveBeenCalledWith(
      'openclaw:assistantMedia:readDataUrl',
      expect.any(Function),
    );
  });

  test('returns structured failures to concurrent callers sharing one restart', async () => {
    const harness = createRestartHarness({ phase: 'error' });
    const restartError = new Error('restart failed');
    harness.manager.restartGateway.mockRejectedValueOnce(restartError);
    registerOpenClawEngineHandlers({
      runConfigMutationExclusive: operation => operation(),
      getCoworkStore: () => ({ listSessions: () => [] }) as never,
      getManager: () => harness.manager as unknown as OpenClawEngineManager,
      requestGateway: harness.requestGateway as unknown as <T>(
        method: string,
        params?: unknown,
      ) => Promise<T>,
      reconnectGatewayClient: harness.reconnectGatewayClient,
    });
    const registration = ipcHandle.mock.calls.find(
      ([channel]) => channel === 'openclaw:engine:restartGateway',
    );
    const handler = registration?.[1] as (() => Promise<{
      success: boolean;
      error?: string;
    }>) | undefined;
    expect(handler).toBeTypeOf('function');

    const [first, second] = await Promise.all([handler!(), handler!()]);

    expect(harness.manager.restartGateway).toHaveBeenCalledOnce();
    expect(first).toMatchObject({ success: false, error: restartError.message });
    expect(second).toMatchObject({ success: false, error: restartError.message });
  });
});
