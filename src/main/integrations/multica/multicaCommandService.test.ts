import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import { MulticaCommandService } from './multicaCommandService';
import type {
  MulticaExternalSession,
  MulticaExternalSessionStore,
} from './multicaExternalSessionStore';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const fixture = (existingExternal?: MulticaExternalSession) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-'));
  temporaryDirectories.push(cwd);
  const configPath = path.join(cwd, 'openclaw-config.json');
  fs.writeFileSync(configPath, '{}');
  const session = {
    id: 'cowork-1',
    agentId: 'main',
    cwd,
    status: 'idle',
  };
  let external = existingExternal ?? null;
  const coworkStore = {
    listAgents: vi.fn(() => [
      { id: 'main', name: 'Main Agent', model: 'provider/model', enabled: true },
      { id: 'disabled', name: 'Disabled', model: '', enabled: false },
    ]),
    getAgent: vi.fn((id: string) =>
      id === 'main'
        ? { id: 'main', name: 'Main Agent', model: 'provider/model', enabled: true }
        : null,
    ),
    getConfig: vi.fn(() => ({ permissionMode: 'full' })),
    createSession: vi.fn(() => session),
    deleteSession: vi.fn(),
    getSession: vi.fn(() => session),
    updateSession: vi.fn(),
    beginSessionRun: vi.fn(input => ({
      id: 'run-timing-1',
      ...input,
      rootRunId: 'root-run-1',
      state: 'running',
    })),
    getSessionRun: vi.fn(() => ({
      id: 'run-timing-1',
      sessionId: session.id,
      clientTurnId: 'client-turn-1',
      rootRunId: 'root-run-1',
      startedAt: 1,
      state: 'running',
    })),
    finishSessionRun: vi.fn(),
  } as unknown as CoworkStore;
  const externalStore = {
    get: vi.fn(() => external),
    wasDeleted: vi.fn(() => false),
    create: vi.fn(input => {
      external = {
        ...input,
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      } as MulticaExternalSession;
      return external;
    }),
    setStatus: vi.fn(),
  } as unknown as MulticaExternalSessionStore;
  const execute = vi.fn().mockResolvedValue('Finished');
  const service = new MulticaCommandService({
    getCoworkStore: () => coworkStore,
    getExternalSessionStore: () => externalStore,
    getModels: () => [{ id: 'provider/model', name: 'Configured model', isDefault: true }],
    execute,
    isEnabled: () => true,
    onSessionsChanged: vi.fn(),
  });
  return { service, cwd, execute };
};

describe('Multica Codex command service', () => {
  it('discovers actual configured models rather than assistant names', async () => {
    const { service } = fixture();
    const result = await service.execute(['debug', 'models']);
    expect(JSON.parse(result.stdout!).models.map((model: { slug: string }) => model.slug)).toEqual([
      'provider/model',
    ]);
  });
  it('does not expose the retired OpenClaw command interface', async () => {
    const { service, execute } = fixture();
    await expect(service.execute(['agent', '--json'])).rejects.toThrow('Codex');
    expect(execute).not.toHaveBeenCalled();
  });
});
