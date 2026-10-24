import { EventEmitter } from 'node:events';
import path from 'node:path';

import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRequestOptions } from '../../engine/types';
import { parseManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';
import { WorkspaceAppSessions } from './workspaceAppSession';

function fixture() {
  const cwd = path.resolve('workspace-fixture');
  let config = { workingDirectory: cwd, permissionMode: 'auto', allowMainAgentSwitch: false };
  const sessions = new Map<string, Record<string, unknown>>();
  const responses = new WeakSet<object>();
  let generation = 1;
  const captureResponseContext = vi.fn(async () => {
    const captured = generation;
    return {
      isCurrent: () => generation === captured,
      isResponseError: (error: unknown) => typeof error === 'object' && error !== null && responses.has(error),
    };
  });
  const request = vi.fn(async (method: string, raw: unknown, options?: GatewayRequestOptions): Promise<unknown> => {
    options?.assertBeforeSend?.();
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
    if (method === 'sessions.describe') return { session: sessions.get(String(params.key)) ?? null };
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
    captureResponseContext,
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
    captureResponseContext,
    advanceGeneration: () => { generation++; },
    pending: (overrides: Record<string, unknown> = {}, correlated = true) => {
      const error = Object.assign(new Error('Agent main inspection pending'), {
        code: 'UNAVAILABLE', gatewayCode: 'UNAVAILABLE', retryable: true,
        details: { code: 'agent-database-inspection-pending', agentId: 'main' }, ...overrides,
      });
      if (correlated) responses.add(error);
      return error;
    },
    configure: (value: Partial<typeof config>) => {
      config = { ...config, ...value };
    },
    created: () => request.mock.calls.filter(([method]) => method === 'sessions.create'),
  };
}

describe('homepage native App workspace ownership', () => {
  it('adopts its reserved product identity without recreating or deleting the live preview', async () => {
    const f = fixture();
    const binding = await f.service.prepare(f.owner, f.input);
    const create = vi.fn((id: string) => ({ id }));
    const adopted = await f.service.adopt(f.owner, f.input, create, () => true);
    expect(adopted.binding).toEqual(binding);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      parseManagedSessionKey(binding.sessionKey)!.sessionId,
      binding,
    );
    await f.service.release(f.owner, f.input.requestId);
    (f.owner as unknown as EventEmitter).emit('destroyed');
    expect(f.created()).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === 'sessions.delete')).toBe(false);
    await expect(f.service.adopt(f.owner, f.input, create, () => true)).rejects.toThrow();
    expect(create).toHaveBeenCalledOnce();
  });

  it.each(['owner', 'incarnation', 'permission', 'cancelled', 'folder'])(
    'refuses %s changes during adoption',
    async kind => {
      const f = fixture();
      const binding = await f.service.prepare(f.owner, f.input);
      const entry = f.sessions.get(binding.sessionKey)!;
      if (kind === 'incarnation') entry.sessionId = 'replacement';
      if (kind === 'permission') entry.permissionMode = 'full';
      if (kind === 'folder') f.configure({ workingDirectory: path.resolve('another-folder') });
      const create = vi.fn();
      await expect(
        f.service.adopt(
          kind === 'owner' ? ({} as WebContents) : f.owner,
          f.input,
          create,
          () => kind !== 'cancelled',
        ),
      ).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
      expect(f.created()).toHaveLength(1);
    },
  );

  it('keeps preview ownership if product creation fails', async () => {
    const f = fixture();
    await f.service.prepare(f.owner, f.input);
    await expect(
      f.service.adopt(
        f.owner,
        f.input,
        () => {
          throw new Error('database failed');
        },
        () => true,
      ),
    ).rejects.toThrow('database failed');
    await f.service.release(f.owner, f.input.requestId);
    expect(f.request.mock.calls.filter(([method]) => method === 'sessions.delete')).toHaveLength(1);
  });
  it('prepares once on explicit use, without a product chat or model send', async () => {
    const f = fixture();
    expect(f.request).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([
      f.service.prepare(f.owner, f.input),
      f.service.prepare(f.owner, f.input),
    ]);
    expect(first).toEqual(second);
    expect(f.created()).toHaveLength(1);
    expect(parseManagedSessionKey(first.sessionKey)?.agentId).toBe('main');
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
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
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
    await expect(f.service.release(f.owner, f.input.requestId)).rejects.toThrow('current');
    expect(f.created()).toHaveLength(0);
    expect(f.request.mock.calls.filter(([method]) => method === 'sessions.delete')).toHaveLength(0);
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

  it.each(['release', 'adopt'] as const)('rejects a late old absence after its successor is retired by %s', async kind => {
    const f = fixture();
    const previous = await f.service.prepare(f.owner, f.input);
    f.sessions.delete(previous.sessionKey);
    const native = f.request.getMockImplementation()!;
    const observations: Array<() => void> = [];
    f.request.mockImplementation(async (method, params, options) => {
      if (method === 'sessions.describe' && (params as { key: string }).key === previous.sessionKey)
        return new Promise(resolve => observations.push(() => resolve({ session: null })));
      return native(method, params, options);
    });
    const first = f.service.prepare(f.owner, f.input);
    const second = f.service.prepare(f.owner, f.input);
    const rejected = expect(second).rejects.toThrow('changed');
    await vi.waitFor(() => expect(observations).toHaveLength(2));
    observations[0]();
    const replacement = await first;
    expect(replacement.sessionKey).not.toBe(previous.sessionKey);
    if (kind === 'release') await f.service.release(f.owner, f.input.requestId);
    else await f.service.adopt(f.owner, f.input, () => ({}), () => true);
    observations[1]();
    await rejected;
    expect(f.created()).toHaveLength(2);
  });

  it('does not resend a preparation with an unknown result', async () => {
    const f = fixture();
    const native = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, options) => {
      if (method === 'sessions.create') throw new Error('connection lost after dispatch');
      return native(method, params, options);
    });
    await expect(f.service.prepare(f.owner, f.input)).rejects.toThrow('connection lost');
    await expect(f.service.prepare(f.owner, f.input)).rejects.toThrow('connection lost');
    expect(f.created()).toHaveLength(1);
  });

  it('shares a pending read and only retries on a later explicit preparation before any create', async () => {
    const f = fixture();
    const failure = f.pending();
    let reject!: (error: Error) => void;
    f.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const first = f.service.prepare(f.owner, f.input);
    const second = f.service.prepare(f.owner, f.input);
    const observed = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    expect(f.created()).toHaveLength(0);
    reject(failure);
    expect((await observed).every(result => result.status === 'rejected' && result.reason === failure)).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    const [a, b] = await Promise.all([f.service.prepare(f.owner, f.input), f.service.prepare(f.owner, f.input)]);
    expect(a).toEqual(b);
    expect(f.created()).toHaveLength(1);
    await f.service.release(f.owner, f.input.requestId);
  });

  it.each([
    ['uncorrelated', {}, false],
    ['wrong agent', { details: { code: 'agent-database-inspection-pending', agentId: 'other' } }, true],
    ['failed inspection', { details: { code: 'agent-database-inspection-failed', agentId: 'main' } }, true],
    ['ownership mismatch', { details: { code: 'agent-database-ownership-mismatch', agentId: 'main' } }, true],
    ['nonretryable', { retryable: false }, true],
    ['conflicting code', { code: 'CLIENT_TIMEOUT' }, true],
    ['wrong gateway code', { gatewayCode: 'FORBIDDEN' }, true],
  ] as const)('retains %s read failures instead of treating them as creation rejection', async (_name, overrides, correlated) => {
    const f = fixture();
    const failure = f.pending(overrides, correlated);
    f.request.mockRejectedValueOnce(failure);
    await expect(f.service.prepare(f.owner, f.input)).rejects.toBe(failure);
    await expect(f.service.prepare(f.owner, f.input)).rejects.toBe(failure);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.created()).toHaveLength(0);
  });

  it('does not recycle the same pending receipt once creation was dispatched', async () => {
    const f = fixture();
    const native = f.request.getMockImplementation()!;
    const failure = f.pending();
    f.request.mockImplementation(async (method, params, options) => {
      if (method === 'sessions.create') throw failure;
      return native(method, params, options);
    });
    await expect(f.service.prepare(f.owner, f.input)).rejects.toBe(failure);
    await expect(f.service.prepare(f.owner, f.input)).rejects.toBe(failure);
    expect(f.created()).toHaveLength(1);
  });

  it('retains the created identity if its subsequent describe is temporarily unavailable', async () => {
    const f = fixture();
    const native = f.request.getMockImplementation()!;
    const failure = f.pending();
    let reads = 0;
    f.request.mockImplementation(async (method, params, options) => {
      if (method === 'sessions.describe' && ++reads === 2) throw failure;
      return native(method, params, options);
    });
    await expect(f.service.prepare(f.owner, f.input)).rejects.toBe(failure);
    const binding = await f.service.prepare(f.owner, f.input);
    expect(binding.gatewaySessionId).toBe('native-1');
    expect(f.created()).toHaveLength(1);
  });

  it('rejects a reserved-key collision without adopting or creating it', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ session: { sessionId: 'foreign' } });
    await expect(f.service.prepare(f.owner, f.input)).rejects.toThrow('already exists');
    expect(f.created()).toHaveLength(0);
  });

  it.each(['generation', 'folder', 'destroyed'] as const)('does not create after %s changes while preflight waits', async kind => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.service.prepare(f.owner, f.input);
    const rejected = expect(pending).rejects.toThrow(kind === 'folder' ? 'current' : 'changed');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    if (kind === 'generation') f.advanceGeneration();
    if (kind === 'folder') f.configure({ workingDirectory: path.resolve('changed') });
    if (kind === 'destroyed') (f.owner as unknown as EventEmitter).emit('destroyed');
    finish({ session: null });
    await rejected;
    expect(f.created()).toHaveLength(0);
  });

  it('checks current ownership again inside the request adapter before the create send', async () => {
    const f = fixture();
    const native = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, options) => {
      if (method === 'sessions.create') f.advanceGeneration();
      return native(method, params, options);
    });
    await expect(f.service.prepare(f.owner, f.input)).rejects.toThrow('changed');
    expect(f.sessions.size).toBe(0);
    await expect(f.service.prepare(f.owner, f.input)).rejects.toThrow('changed');
    expect(f.created()).toHaveLength(1);
  });

  it('does not recycle a late pending rejection from a retired transport', async () => {
    const f = fixture();
    const failure = f.pending();
    let reject!: (error: Error) => void;
    f.request.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = f.service.prepare(f.owner, f.input);
    const observed = expect(pending).rejects.toBe(failure);
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
    f.advanceGeneration();
    reject(failure);
    await observed;
    await expect(f.service.prepare(f.owner, f.input)).rejects.toBe(failure);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('releases an empty owner after a safely rejected observation', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(f.pending());
    await expect(f.service.prepare(f.owner, f.input)).rejects.toThrow('inspection pending');
    const owners = (f.service as unknown as { owners: Map<WebContents, unknown> }).owners;
    expect(owners.has(f.owner)).toBe(false);
    (f.owner as unknown as EventEmitter).emit('destroyed');
    expect(owners.size).toBe(0);
    expect(f.created()).toHaveLength(0);
  });

  it('waits for Main transport preparation instead of pinning an initially absent client', async () => {
    const f = fixture();
    const capture = f.captureResponseContext.getMockImplementation()!;
    let ready!: (value: Awaited<ReturnType<typeof capture>>) => void;
    f.captureResponseContext.mockImplementationOnce(() => new Promise(resolve => { ready = resolve; }));
    const pending = f.service.prepare(f.owner, f.input);
    await vi.waitFor(() => expect(ready).toBeTypeOf('function'));
    expect(f.request).not.toHaveBeenCalled();
    ready(await capture());
    const binding = await pending;
    expect(binding.gatewaySessionId).toBe('native-1');
    expect(f.created()).toHaveLength(1);
  });

  it('does not publish an accepted creation after its transport retires', async () => {
    const f = fixture();
    const native = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (method, params, options) => {
      const result = await native(method, params, options);
      if (method === 'sessions.create') f.advanceGeneration();
      return result;
    });
    const results = await Promise.allSettled([
      f.service.prepare(f.owner, f.input), f.service.prepare(f.owner, f.input),
    ]);
    expect(results.every(result => result.status === 'rejected' && /changed/.test(result.reason.message))).toBe(true);
    expect(f.created()).toHaveLength(1);
    // Keep the actual receipt for exact cleanup; do not throw away a committed identity.
    await f.service.release(f.owner, f.input.requestId);
    expect(f.request).toHaveBeenLastCalledWith('sessions.delete', expect.objectContaining({ expectedSessionId: 'native-1' }));
  });
});
