import { EventEmitter } from 'node:events';

import { spawn } from 'child_process';
import { ipcMain } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryIndexHealth, MemoryIpc } from '../../../shared/openclaw/memory';
import {
  OpenClawCliNetworkMode,
  type OpenClawEngineManager,
} from '../../openclaw/runtime/openclawEngineManager';
import {
  buildMemoryCliEnvironment,
  buildMemoryRebuildCliEnvironment,
  normalizeMemoryIndexStatus,
  normalizeSearchHits,
  registerOpenClawMemoryHandlers,
  resolveMemoryWorkspace,
  scanMemoryDocuments,
} from './memory';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('child_process', () => ({ spawn: vi.fn() }));

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-memory-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('scanMemoryDocuments', () => {
  it('groups profile, long-term, daily, and dreaming Markdown without including unrelated files', () => {
    const workspace = createTemporaryDirectory();
    fs.mkdirSync(path.join(workspace, 'memory', 'dreaming', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Durable facts\n\n- Prefer TypeScript.');
    fs.writeFileSync(
      path.join(workspace, 'USER.md'),
      '# User profile\n\n- Prefers concise replies.',
    );
    fs.writeFileSync(
      path.join(workspace, 'memory', '2026-07-19-project.md'),
      '# Project update\n\nThe release is ready.',
    );
    fs.writeFileSync(
      path.join(workspace, 'memory', 'dreaming', 'deep', '2026-07-19.md'),
      '# Deep review\n\nA lasting update.',
    );
    fs.writeFileSync(path.join(workspace, 'notes.md'), '# Not memory');

    const documents = scanMemoryDocuments(workspace);

    expect(documents.map(document => [document.relativePath, document.kind])).toEqual(
      expect.arrayContaining([
        ['USER.md', 'profile'],
        ['MEMORY.md', 'longTerm'],
        ['memory/2026-07-19-project.md', 'daily'],
        ['memory/dreaming/deep/2026-07-19.md', 'dreaming'],
      ]),
    );
    expect(
      documents.find(document => document.relativePath === 'memory/2026-07-19-project.md'),
    ).toMatchObject({
      title: 'Project update',
      date: '2026-07-19',
      preview: 'Project update The release is ready.',
    });
  });
});

describe('resolveMemoryWorkspace', () => {
  it('prefers the keyed main agent workspace over legacy and default workspaces', async () => {
    const root = createTemporaryDirectory();
    const configPath = path.join(root, 'openclaw.json');
    const mainWorkspace = path.join(root, 'main-workspace');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          defaults: { workspace: path.join(root, 'default-workspace') },
          entries: { main: { workspace: mainWorkspace } },
          list: [{ id: 'main', workspace: path.join(root, 'legacy-workspace') }],
        },
      }),
    );
    const manager = {
      getConfigPath: () => configPath,
      getStateDir: () => path.join(root, 'state'),
    } as OpenClawEngineManager;

    await expect(resolveMemoryWorkspace(manager, vi.fn())).resolves.toBe(
      path.resolve(mainWorkspace),
    );
  });
});

describe('buildMemoryCliEnvironment', () => {
  it('routes memory embedding commands through the outbound header proxy environment', async () => {
    const cli = {
      env: {},
      runtimeRoot: 'runtime',
      openclawEntry: 'openclaw.mjs',
      port: 1234,
      token: 'token',
    };
    const buildCliEnvironment = vi.fn().mockResolvedValue(cli);
    const manager = { buildCliEnvironment } as unknown as OpenClawEngineManager;

    await expect(buildMemoryCliEnvironment(manager)).resolves.toBe(cli);
    expect(buildCliEnvironment).toHaveBeenCalledWith({
      networkMode: OpenClawCliNetworkMode.OutboundProxy,
    });
  });

  it('uses the normal proxied CLI environment for native forced rebuilds', async () => {
    const cli = {
      env: { EXISTING_VALUE: 'kept' },
      runtimeRoot: 'runtime',
      openclawEntry: 'openclaw.mjs',
      port: 1234,
      token: 'token',
    };
    const buildCliEnvironment = vi.fn().mockResolvedValue(cli);
    const manager = { buildCliEnvironment } as unknown as OpenClawEngineManager;

    await expect(buildMemoryRebuildCliEnvironment(manager)).resolves.toBe(cli);
    expect(cli.env).toEqual({ EXISTING_VALUE: 'kept' });
    expect(buildCliEnvironment).toHaveBeenCalledWith({
      networkMode: OpenClawCliNetworkMode.OutboundProxy,
    });
  });
});

describe('normalizeMemoryIndexStatus', () => {
  it('normalizes the JSON output from openclaw memory status', () => {
    expect(
      normalizeMemoryIndexStatus([
        {
          agentId: 'main',
          status: {
            backend: 'builtin',
            files: 3,
            chunks: 7,
            dirty: false,
            provider: 'builtin_models',
            model: 'embedding-model',
            fts: { enabled: true, available: true },
            vector: { enabled: true, dims: 1024 },
            custom: { searchMode: 'hybrid' },
          },
        },
      ]),
    ).toEqual({
      available: true,
      chunks: 7,
      dirty: false,
      health: MemoryIndexHealth.Unknown,
    });
  });
});

describe('normalizeSearchHits', () => {
  it('keeps canonical memory files and excludes paths outside the workspace', () => {
    const workspace = path.join(createTemporaryDirectory(), 'workspace');
    const results = normalizeSearchHits(
      {
        results: [
          { path: 'memory/2026-07-19.md', snippet: 'inside', score: 0.8 },
          { path: '../private.md', snippet: 'outside', score: 0.9 },
          { path: 'notes.md', snippet: 'not memory', score: 0.7 },
        ],
      },
      workspace,
    );

    expect(results).toEqual([
      expect.objectContaining({ path: 'memory/2026-07-19.md', snippet: 'inside' }),
    ]);
  });
});

const nativeStatus = (overrides: Record<string, unknown> = {}) => [
  {
    agentId: 'main',
    status: {
      backend: 'builtin',
      provider: 'runtime-services',
      chunks: 7,
      dirty: false,
      fts: { enabled: true, available: true },
      vector: { enabled: true, semanticAvailable: true },
      ...overrides,
    },
  },
];

describe('memory health diagnostics', () => {
  it('distinguishes semantic readiness, keyword-only recall, stale identity and unprobed vectors', () => {
    expect(normalizeMemoryIndexStatus(nativeStatus()).health).toBe(MemoryIndexHealth.Ready);
    expect(
      normalizeMemoryIndexStatus(
        nativeStatus({
          provider: 'none',
          vector: { enabled: true, semanticAvailable: false },
          custom: { searchMode: 'fts-only' },
        }),
      ).health,
    ).toBe(MemoryIndexHealth.KeywordOnly);
    expect(
      normalizeMemoryIndexStatus(
        nativeStatus({
          custom: {
            indexIdentity: {
              status: 'mismatched',
              reason: 'model changed',
            },
          },
        }),
      ),
    ).toMatchObject({ health: MemoryIndexHealth.Stale, warning: 'model changed' });
    expect(
      normalizeMemoryIndexStatus(nativeStatus({ lastSyncError: 'sync failed' })),
    ).toMatchObject({ health: MemoryIndexHealth.Stale, warning: 'sync failed' });
    expect(normalizeMemoryIndexStatus(nativeStatus({ vector: { available: true } })).health).toBe(
      MemoryIndexHealth.Unknown,
    );
    for (const malformed of [{}, [], [{ agentId: 'other', status: nativeStatus()[0].status }]]) {
      expect(normalizeMemoryIndexStatus(malformed).available).toBe(false);
    }
  });

  it('keeps authorized session and extra-path snippets without granting file preview access', () => {
    const root = createTemporaryDirectory();
    fs.mkdirSync(path.join(root, 'memory'));
    fs.writeFileSync(path.join(root, 'memory', 'daily.md'), 'fact');
    const hits = normalizeSearchHits(
      {
        results: [
          { path: 'memory/daily.md', source: 'memory', snippet: 'fact' },
          { path: '../extra/notes.md', source: 'memory', snippet: 'extra' },
          { path: 'sessions/example.jsonl', source: 'sessions', snippet: 'session' },
        ],
      },
      root,
    );
    expect(hits.map(hit => [hit.source, hit.previewable])).toEqual([
      ['memory', true],
      ['memory', false],
      ['sessions', false],
    ]);
  });

  it('delegates implicit, home and relative workspace resolution to the native owner', async () => {
    const root = createTemporaryDirectory();
    const configPath = path.join(root, 'config.json');
    const manager = { getConfigPath: () => configPath } as OpenClawEngineManager;
    const gateway = vi.fn().mockResolvedValue({ workspace: path.join(root, 'native-main') });
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { workspace: root } } }));
    await expect(resolveMemoryWorkspace(manager, gateway)).resolves.toBe(
      path.join(root, 'native-main'),
    );
    expect(gateway).toHaveBeenCalledWith('agents.files.list', { agentId: 'main' });
    vi.stubEnv('OPENCLAW_HOME', '~/custom-home');
    gateway.mockResolvedValue({ workspace: path.join(root, 'native-home', 'notes') });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: { entries: { main: { workspace: '~/notes' } } } }),
    );
    await expect(resolveMemoryWorkspace(manager, gateway)).resolves.toBe(
      path.join(root, 'native-home', 'notes'),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: { entries: { main: { workspace: './notes' } } } }),
    );
    await expect(resolveMemoryWorkspace(manager, gateway)).resolves.toBe(
      path.join(root, 'native-home', 'notes'),
    );
    expect(gateway).toHaveBeenCalledTimes(3);
  });
});

function registerHandlers(
  gateway = vi.fn().mockResolvedValue({ results: [] }),
  setup?: (root: string) => void,
) {
  const root = createTemporaryDirectory();
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ agents: { entries: { main: { workspace: root } } } }),
  );
  setup?.(root);
  registerOpenClawMemoryHandlers({
    getManager: () =>
      ({
        getConfigPath: () => configPath,
        buildCliEnvironment: vi.fn().mockResolvedValue({ env: {}, openclawEntry: 'fixture.mjs' }),
      }) as unknown as OpenClawEngineManager,
    requestGateway: gateway,
  });
  return (channel: string) => {
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(call => call[0] === channel)?.[1];
    if (!handler) throw new Error('Missing IPC handler');
    return handler;
  };
}

function mockCommand(stdout: string, stderr = '', code = 0) {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => {
      child.stdout.emit('data', stdout);
      child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child as ReturnType<typeof spawn>;
  });
}

describe('memory IPC regression cases', () => {
  it('preserves stale search diagnostics and executable guidance while redacting credentials', async () => {
    const get = registerHandlers(
      vi.fn().mockResolvedValue({
        results: [],
        stale: true,
        searchMode: 'fts-only',
        warning: 'sync failed token=secret-value',
        action: 'Run openclaw memory status --index --agent main',
      }),
    );
    const result = await get(MemoryIpc.Search)({} as never, 'preference');
    expect(result).toMatchObject({
      success: true,
      hits: [],
      stale: true,
      searchMode: 'fts-only',
      warning: 'sync failed token=***',
      action: 'Run openclaw memory status --index --agent main',
    });
  });

  it('does not claim a rebuild succeeded when memory was disabled', async () => {
    const get = registerHandlers();
    mockCommand('Memory search disabled.');
    mockCommand('Memory search disabled.\n[]');
    const result = await get(MemoryIpc.RebuildIndex)({} as never);
    expect(result).toMatchObject({ success: false, index: { health: MemoryIndexHealth.Disabled } });
  });

  it('returns a warning when indexing succeeds but semantic recall is degraded', async () => {
    const get = registerHandlers();
    mockCommand('Indexed', 'Vector recall degraded.');
    mockCommand(
      JSON.stringify(nativeStatus({ provider: 'none', vector: { semanticAvailable: false } })),
    );
    const result = await get(MemoryIpc.RebuildIndex)({} as never);
    expect(result).toMatchObject({
      success: true,
      warning: 'Vector recall degraded.',
      index: { health: MemoryIndexHealth.KeywordOnly },
    });
  });

  it('fails verification if the post-rebuild status cannot be read', async () => {
    const get = registerHandlers();
    mockCommand('Indexed');
    mockCommand('invalid JSON');
    expect(await get(MemoryIpc.RebuildIndex)({} as never)).toMatchObject({ success: false });
  });

  it('reports a verified rebuild without warnings for healthy semantic indexes', async () => {
    const get = registerHandlers();
    mockCommand('Indexed');
    mockCommand(JSON.stringify(nativeStatus()));
    const result = await get(MemoryIpc.RebuildIndex)({} as never);
    expect(result).toMatchObject({ success: true, index: { health: MemoryIndexHealth.Ready } });
    expect(result.warning).toBeUndefined();
  });
});

it('rejects preview reads outside canonical workspace memory even after an authorized search hit', async () => {
  const get = registerHandlers(undefined, root => {
    fs.mkdirSync(path.join(root, 'memory'));
    fs.writeFileSync(path.join(root, 'private.md'), 'private workspace content');
    fs.writeFileSync(path.join(root, 'memory', 'allowed.md'), 'allowed memory');
  });
  for (const target of [
    '../extra/notes.md',
    'sessions/example.jsonl',
    'memory/../../private.md',
    'memory/../private.md',
  ]) {
    expect(await get(MemoryIpc.GetDocument)({} as never, target)).toMatchObject({ success: false });
  }
  expect(await get(MemoryIpc.GetDocument)({} as never, 'memory/allowed.md')).toMatchObject({
    success: true,
    document: { content: 'allowed memory' },
  });
});

it('returns failure when the indexing process itself fails', async () => {
  const get = registerHandlers();
  mockCommand('', 'index failed', 1);
  expect(await get(MemoryIpc.RebuildIndex)({} as never)).toMatchObject({ success: false });
  expect(spawn).toHaveBeenCalledTimes(1);
});

it('does not treat an unresolved index identity after rebuilding as success', async () => {
  const get = registerHandlers();
  mockCommand('Indexed');
  mockCommand(
    JSON.stringify(
      nativeStatus({
        custom: {
          indexIdentity: {
            status: 'mismatched',
            reason: 'model changed',
          },
        },
      }),
    ),
  );
  expect(await get(MemoryIpc.RebuildIndex)({} as never)).toMatchObject({
    success: false,
    index: { health: MemoryIndexHealth.Stale },
  });
});

it('recognizes a complete persisted index without claiming a live semantic probe', async () => {
  const status = nativeStatus({
    vector: { enabled: true, index: { state: 'complete' } },
    custom: { indexIdentity: { status: 'valid' }, searchMode: 'hybrid' },
  });
  expect(normalizeMemoryIndexStatus(status).health).toBe(MemoryIndexHealth.Indexed);
  const get = registerHandlers();
  mockCommand('Indexed');
  mockCommand(JSON.stringify(status));
  const result = await get(MemoryIpc.RebuildIndex)({} as never);
  expect(result).toMatchObject({ success: true, index: { health: MemoryIndexHealth.Indexed } });
  expect(result.warning).toBeUndefined();
});

it('keeps an incomplete unprobed vector index unconfirmed', () => {
  expect(
    normalizeMemoryIndexStatus(
      nativeStatus({
        vector: { enabled: true, index: { state: 'incomplete' } },
        custom: { indexIdentity: { status: 'valid' } },
      }),
    ).health,
  ).toBe(MemoryIndexHealth.Unknown);
});
