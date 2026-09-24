import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentProfileInput } from '../../../shared/agents/agents';
import type { CoworkStore } from '../../data/coworkStore';
import { NativeAssistantCreation } from './nativeAssistantCreation';

let db: Database.Database;
let service: NativeAssistantCreation;
let agents: Map<string, AgentProfileInput & { id: string }>;
let native: Map<string, { workspace: string; content?: string; name: string }>;
const request = vi.fn();
const changed = vi.fn();
const input = {
  name: '代码审查助手',
  description: 'Review changes',
  instructions: 'Review code carefully.',
};
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(
    'CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  );
  agents = new Map();
  native = new Map();
  changed.mockReset();
  request.mockReset().mockImplementation(async (method, params) => {
    if (method === 'models.list') return { models: [{ provider: 'test', id: 'model' }] };
    if (method === 'agents.list') return { agents: [...native.keys()].map(id => ({ id })) };
    if (method === 'agents.create') {
      native.set(params.name, { workspace: params.workspace, name: params.name });
      return { ok: true, agentId: params.name, workspace: params.workspace };
    }
    const agent = native.get(params.agentId)!;
    if (method === 'agents.update') {
      agent.name = params.name;
      return { ok: true };
    }
    if (method === 'agents.files.set') {
      agent.content = params.content;
      return { ok: true };
    }
    if (method === 'agents.files.get')
      return { workspace: agent.workspace, file: { content: agent.content } };
    throw new Error('Unexpected method');
  });
  let tail = Promise.resolve();
  service = new NativeAssistantCreation({
    getDatabase: () => db,
    getStore: () =>
      ({
        getAgent: (id: string) => agents.get(id),
        listAgents: () => [...agents.values()],
        saveAgentProfile: (profile: AgentProfileInput & { id: string }) => {
          agents.set(profile.id, profile);
          return profile;
        },
      }) as unknown as CoworkStore,
    getStateDir: () => 'C:/isolated-state',
    requestGateway: request,
    onChanged: changed,
    exclusive: operation => {
      const next = tail.then(operation);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  });
});
afterEach(() => db.close());
describe('native persistent assistant creation', () => {
  it('does not mutate a deleted incomplete assistant when its original call retries', async () => {
    const original = request.getMockImplementation()!;
    request.mockImplementationOnce(original);
    request.mockImplementationOnce(async (method, params) => {
      await original(method, params);
      throw new Error('connection lost');
    });
    const incomplete = await service.create(input, 'interrupted-call', () => {});
    expect(incomplete.status).toBe('incomplete');
    Object.assign(agents.get(incomplete.agentId)!, { enabled: false, deletedAt: 123 });
    request.mockClear();

    await expect(service.create(input, 'interrupted-call', () => {})).rejects.toThrow(
      'agentUnavailable',
    );
    expect(request).not.toHaveBeenCalled();
    expect(agents.get(incomplete.agentId)?.enabled).toBe(false);
  });

  it('creates a new identity for a name previously deleted without reviving history ownership', async () => {
    const first = await service.create(input, 'first-call', () => {});
    Object.assign(agents.get(first.agentId)!, { enabled: false, deletedAt: 123 });
    const second = await service.create(input, 'new-call', () => {});
    expect(second.status).toBe('created');
    expect(second.agentId).not.toBe(first.agentId);
    expect(agents.get(first.agentId)?.enabled).toBe(false);
    await expect(service.create(input, 'first-call', () => {})).rejects.toThrow('agentUnavailable');
  });

  it('waits for the native runtime snapshot before configuring a newly created assistant', async () => {
    const original = request.getMockImplementation()!;
    let pendingSnapshot = true;
    request.mockImplementation(async (method, params) => {
      if (method === 'agents.list' && native.size && pendingSnapshot) {
        pendingSnapshot = false;
        return { agents: [] };
      }
      return original(method, params);
    });
    const result = await service.create(input, 'delayed-reload', () => {});
    expect(result.status).toBe('created');
    expect(request.mock.calls.filter(([method]) => method === 'agents.list')).toHaveLength(3);
  });
  it('uses native creation and file APIs with a stable ID and Chinese display name', async () => {
    const result = await service.create(input, 'native-call', () => {});
    expect(result).toMatchObject({ status: 'created', name: input.name, enabled: true });
    expect(request).toHaveBeenCalledWith(
      'agents.create',
      expect.objectContaining({ name: result.agentId }),
    );
    expect(native.get(result.agentId)).toMatchObject({
      name: input.name,
      content: input.instructions,
    });
    expect(agents.get(result.agentId)?.enabled).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
  });
  it('reuses the same call and same-name requests without overwriting an assistant', async () => {
    const first = await service.create(input, 'call', () => {});
    expect(await service.create(input, 'call', () => {})).toMatchObject({
      status: 'existing',
      agentId: first.agentId,
    });
    expect(
      await service.create({ ...input, instructions: 'Different' }, 'new-call', () => {}),
    ).toMatchObject({ status: 'existing', agentId: first.agentId });
    await expect(
      service.create({ ...input, instructions: 'Different' }, 'call', () => {}),
    ).rejects.toThrow('agentCreationConflict');
    expect(request.mock.calls.filter(([method]) => method === 'agents.create')).toHaveLength(1);
  });
  it('recovers an uncertain native creation on retry without duplicating its profile', async () => {
    const original = request.getMockImplementation()!;
    request.mockImplementationOnce(original); // roster
    request.mockImplementationOnce(async (method, params) => {
      await original(method, params);
      throw new Error('connection lost');
    });
    const incomplete = await service.create(input, 'call', () => {});
    expect(incomplete.status).toBe('incomplete');
    expect(agents.get(incomplete.agentId)?.enabled).toBe(false);
    const result = await service.create(input, 'retry-call', () => {});
    expect(result).toMatchObject({ status: 'created', agentId: incomplete.agentId });
    expect(native.size).toBe(1);
    expect(agents.size).toBe(1);
  });
  it('rejects unknown models and model-supplied filesystem paths before writing', async () => {
    await expect(
      service.create({ ...input, model: 'missing/model' }, 'call', () => {}),
    ).rejects.toThrow('agentInvalidModel');
    expect(() => service.create({ ...input, workspace: 'C:/user' }, 'call', () => {})).toThrow(
      'agentInvalidProfile',
    );
    expect(agents.size).toBe(0);
  });
  it('checks cancellation after waiting for the configuration lock', async () => {
    await expect(
      service.create(input, 'call', () => {
        throw new Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
    expect(request).not.toHaveBeenCalled();
    expect(agents.size).toBe(0);
  });
  it('serializes concurrent requests for the same name', async () => {
    const results = await Promise.all([
      service.create(input, 'one', () => {}),
      service.create(input, 'two', () => {}),
    ]);
    expect(results).toEqual([
      expect.objectContaining({ status: 'created' }),
      expect.objectContaining({ status: 'existing' }),
    ]);
    expect(agents.size).toBe(1);
  });
});
