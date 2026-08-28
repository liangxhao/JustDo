import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OpenClawCliNetworkMode,
  type OpenClawEngineManager,
} from '../../openclaw/runtime/openclawEngineManager';
import {
  buildMemoryCliEnvironment,
  normalizeMemoryIndexStatus,
  normalizeSearchHits,
  resolveMemoryWorkspace,
  scanMemoryDocuments,
} from './memory';

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-memory-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('scanMemoryDocuments', () => {
  it('groups long-term, daily, and dreaming Markdown without including unrelated files', () => {
    const workspace = createTemporaryDirectory();
    fs.mkdirSync(path.join(workspace, 'memory', 'dreaming', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'MEMORY.md'), '# Durable facts\n\n- Prefer TypeScript.');
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
  it('prefers the main agent workspace over the default workspace', () => {
    const root = createTemporaryDirectory();
    const configPath = path.join(root, 'openclaw.json');
    const mainWorkspace = path.join(root, 'main-workspace');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          defaults: { workspace: path.join(root, 'default-workspace') },
          list: [{ id: 'main', workspace: mainWorkspace }],
        },
      }),
    );
    const manager = {
      getConfigPath: () => configPath,
      getStateDir: () => path.join(root, 'state'),
    } as OpenClawEngineManager;

    expect(resolveMemoryWorkspace(manager)).toBe(path.resolve(mainWorkspace));
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
