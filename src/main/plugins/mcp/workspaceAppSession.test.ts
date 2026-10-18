import { EventEmitter } from 'node:events';
import path from 'node:path';

import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceAppSessions } from './workspaceAppSession';

function fixture() {
  const cwd = path.resolve('workspace-fixture');
  let config = { workingDirectory: cwd, permissionMode: 'auto', allowMainAgentSwitch: false };
  const sessions = new Map<string, Record<string, unknown>>();
  const request = vi.fn(async (method: string, raw: unknown): Promise<unknown> => {
    const params = raw as Record<string, unknown>;
    if (method === 'sessions.create') {
      const entry = {
        sessionId: `native-${sessions.size + 1}`,
        lifecycleRevision: 'revision-1',
        sessionRoot: params.cwd,
        permissionMode: params.permissionMode,
      };
      sessions.set(String(params.key), entry);
      return { key: params.key, sessionId: entry.sessionId, entry, runStarted: false };
    }
    if (method === 'sessions.describe') return { session: sessions.get(String(params.key)) };
    return { ok: true, deleted: true };
  });
  const productCreate = vi.fn();
  const service = new WorkspaceAppSessions({
    getStore: () =>
      ({
        getConfig: () => config,
        getAgent: (id: string) => (id === 'main' ? { enabled: true } : null),
        createSession: productCreate,
      }) as never,
    request: request as never,
  });
  const emitter = new EventEmitter();
  const owner = Object.assign(emitter, { isDestroyed: () => false }) as unknown as WebContents;
  const input = { requestId: '12345678-1234-1234-1234-123456789abc', cwd, agentId: 'main' };
  return {
    service,
    owner,
    input,
    request,
    sessions,
    productCreate,
    configure: (value: Partial<typeof config>) => {
      config = { ...config, ...value };
    },
    created: () => request.mock.calls.filter(([method]) => method === 'sessions.create'),
  };
}

describe('homepage native App workspace ownership', () => {
  it('prepares once on explicit use, without a product chat or model send', async () => {
    const f = fixture();
    expect(f.request).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      f.service.prepare(f.owner, f.input),
      f.service.prepare(f.owner, f.input),
    ]);
    expect(first).toEqual(second);
    expect(f.created()).toHaveLength(1);
    expect(first.sessionKey).toMatch(/^agent:main:workspace-preview:/);
    expect(f.created()[0][1]).toEqual({
      key: first.sessionKey,
      agentId: 'main',
      cwd: f.input.cwd,
      permissionMode: 'workspace',
    });
    expect(f.productCreate).not.toHaveBeenCalled();
    expect(
      f.request.mock.calls.every(([method]) =>
        ['sessions.create', 'sessions.describe'].includes(method),
      ),
    ).toBe(true);
  });

  it.each(['folder', 'agent', 'empty-config'])(
    'rejects an unapproved %s before touching native state',
    async kind => {
      const f = fixture();
      if (kind === 'empty-config') f.configure({ workingDirectory: '' });
      const input = {
        ...f.input,
        ...(kind === 'folder' ? { cwd: path.resolve('another-workspace') } : {}),
        ...(kind === 'agent' ? { agentId: 'other' } : {}),
      };
      await expect(f.service.prepare(f.owner, input)).rejects.toThrow();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each(['sessionId', 'sessionRoot', 'permissionMode'])(
    'refuses a changed native %s without recreating or adopting it',
    async field => {
      const f = fixture();
      const binding = await f.service.prepare(f.owner, f.input);
      f.sessions.get(binding.sessionKey)![field] = 'replaced';
      await expect(f.service.prepare(f.owner, f.input)).rejects.toThrow('changed');
      expect(f.created()).toHaveLength(1);
    },
  );

  it('releases only the captured identity owned by this window', async () => {
    const f = fixture();
    const binding = await f.service.prepare(f.owner, f.input);
    await f.service.release({} as WebContents, f.input.requestId);
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.delete')).toBe(false);
    await f.service.release(f.owner, f.input.requestId);
    expect(f.request).toHaveBeenLastCalledWith('sessions.delete', {
      key: binding.sessionKey,
      agentId: 'main',
      expectedSessionId: binding.gatewaySessionId,
      expectedLifecycleRevision: 'revision-1',
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  });

  it('cleans a late preparation after the window closes without publishing it', async () => {
    const f = fixture();
    const native = f.request.getMockImplementation()!;
    let finish!: () => void;
    f.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.create')
        await new Promise<void>(resolve => {
          finish = resolve;
        });
      return native(method, params);
    });
    const pending = f.service.prepare(f.owner, f.input);
    (f.owner as unknown as EventEmitter).emit('destroyed');
    finish();
    await expect(pending).rejects.toThrow('changed');
    await vi.waitFor(() =>
      expect(f.request.mock.calls.some(([method]) => method === 'sessions.delete')).toBe(true),
    );
  });

  it('shares concurrent cleanup and keeps the next owned context registered', async () => {
    const f = fixture();
    const previous = await f.service.prepare(f.owner, f.input);
    const native = f.request.getMockImplementation()!;
    const completions: Array<() => void> = [];
    f.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.delete')
        await new Promise<void>(resolve => completions.push(resolve));
      return native(method, params);
    });

    const first = f.service.release(f.owner, f.input.requestId);
    const second = f.service.release(f.owner, f.input.requestId);
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(f.request.mock.calls.filter(([method]) => method === 'sessions.delete')).toHaveLength(1);
    completions.shift()!();
    await Promise.all([first, second]);

    const next = await f.service.prepare(f.owner, f.input);
    expect(next.sessionKey).not.toBe(previous.sessionKey);
    (f.owner as unknown as EventEmitter).emit('destroyed');
    await vi.waitFor(() => expect(completions).toHaveLength(1));
    expect(f.request).toHaveBeenLastCalledWith(
      'sessions.delete',
      expect.objectContaining({
        key: next.sessionKey,
        expectedSessionId: next.gatewaySessionId,
      }),
    );
    completions.shift()!();
  });

  it('shares an unknown cleanup result without resending the deletion', async () => {
    const f = fixture();
    await f.service.prepare(f.owner, f.input);
    const native = f.request.getMockImplementation()!;
    let fail!: (error: Error) => void;
    f.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.delete')
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      return native(method, params);
    });
    const first = f.service.release(f.owner, f.input.requestId);
    const second = f.service.release(f.owner, f.input.requestId);
    const results = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
    fail(new Error('connection lost after deletion dispatch'));
    expect((await results).every(result => result.status === 'rejected')).toBe(true);
    await f.service.release(f.owner, f.input.requestId);
    expect(f.request.mock.calls.filter(([method]) => method === 'sessions.delete')).toHaveLength(1);
  });

  it('rejects a changed homepage folder while native preparation is pending', async () => {
    const f = fixture();
    const pending = f.service.prepare(f.owner, f.input);
    f.configure({ workingDirectory: path.resolve('changed-workspace') });
    await expect(pending).rejects.toThrow('current');
    await f.service.release(f.owner, f.input.requestId);
    expect(f.request.mock.calls.filter(([method]) => method === 'sessions.delete')).toHaveLength(1);
  });

  it('creates a new owned context only on explicit preparation after the previous one is absent', async () => {
    const f = fixture();
    const previous = await f.service.prepare(f.owner, f.input);
    f.sessions.delete(previous.sessionKey);
    const next = await f.service.prepare(f.owner, f.input);
    expect(next.sessionKey).not.toBe(previous.sessionKey);
    expect(f.created()).toHaveLength(2);
  });

  it('shares one replacement when concurrent preparations observe the old context is absent', async () => {
    const f = fixture();
    const previous = await f.service.prepare(f.owner, f.input);
    f.sessions.delete(previous.sessionKey);
    const native = f.request.getMockImplementation()!;
    const observations: Array<() => void> = [];
    f.request.mockImplementation(async (method, params) => {
      if (method === 'sessions.describe' && (params as { key: string }).key === previous.sessionKey)
        return new Promise(resolve => observations.push(() => resolve({ session: undefined })));
      return native(method, params);
    });
    const first = f.service.prepare(f.owner, f.input);
    const second = f.service.prepare(f.owner, f.input);
    await vi.waitFor(() => expect(observations).toHaveLength(2));
    for (const finish of observations) finish();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.sessionKey).not.toBe(previous.sessionKey);
    expect(f.created()).toHaveLength(2);
    (f.owner as unknown as EventEmitter).emit('destroyed');
    await vi.waitFor(() =>
      expect(f.request).toHaveBeenLastCalledWith(
        'sessions.delete',
        expect.objectContaining({ key: a.sessionKey }),
      ),
    );
  });

  it('does not resend a preparation with an unknown result', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error('connection lost after dispatch'));
    await expect(f.service.prepare(f.owner, f.input)).rejects.toThrow('connection lost');
    await expect(f.service.prepare(f.owner, f.input)).rejects.toThrow('connection lost');
    expect(f.created()).toHaveLength(1);
  });
});
