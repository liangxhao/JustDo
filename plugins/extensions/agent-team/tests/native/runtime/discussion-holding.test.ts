import { createHash } from 'node:crypto';
import path from 'node:path';

import { beforeEach, expect, test, vi } from 'vitest';

import {
  serializeTeamDiscussionSend,
  TeamDiscussionGateway as RPC,
} from '../../../contracts/discussionInput';
import { registerDiscussionHolding } from '../../../runtime/discussion/holding';

const ports = vi.hoisted(() => ({
  bind: vi.fn(),
  prepare: vi.fn(),
  append: vi.fn(),
  read: vi.fn(),
  isCurrent: vi.fn(),
}));
vi.mock('@runtime-services/sdk/custody-client', async () => {
  const { createHash } = await import('node:crypto');
  return {
    createCustodyClient: () => ports,
    custodyResourceId: (ownerId: string, scopeId: string) =>
      createHash('sha256')
        .update(JSON.stringify([ownerId, scopeId]))
        .digest('hex'),
  };
});
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const resourceId = sha(JSON.stringify(['agent-team', 'room']));
const nativeIdentity = {
  resourceId,
  epoch: 1,
  agentId: 'main',
  sessionKey: `agent:main:harness:inert-custody:${resourceId}:1`,
  sessionId: 'native',
  lifecycleRevision: 'r1',
};
const identity = { ...nativeIdentity, roomId: 'room', generation: 1 };
const send = {
  roomId: 'room',
  requestId: 'request',
  expectedRevision: 1,
  message: 'A discussion topic',
  selectedAgentIds: [],
  rounds: 1,
};
beforeEach(() => {
  ports.bind.mockReset().mockResolvedValue(true);
  ports.isCurrent.mockReset().mockReturnValue(true);
  ports.prepare.mockReset().mockResolvedValue(nativeIdentity);
  ports.append
    .mockReset()
    .mockResolvedValue({
      resourceId,
      epoch: 1,
      operationId: 'request',
      sha256: sha(serializeTeamDiscussionSend(send)),
      state: 'saved',
      entryId: 'entry',
    });
  ports.read
    .mockReset()
    .mockResolvedValue({
      identity: nativeIdentity,
      payload: serializeTeamDiscussionSend(send),
      entryId: 'entry',
    });
});
function fixture() {
  const methods = new Map<string, (request: any) => Promise<void>>();
  const controller = new AbortController();
  let service!: { start(): Promise<void>; stop(): void };
  registerDiscussionHolding({
    id: 'agent-team',
    lifecycle: { signal: controller.signal },
    registerService: (value: typeof service) => {
      service = value;
    },
    registerGatewayMethod: (name: string, handler: any) => methods.set(name, handler),
  } as never);
  const call = (
    method: string,
    params: any,
    request: { signal?: AbortSignal; hasCurrentClientAuthority?: () => boolean } = {},
  ) =>
    new Promise<any>(
      (resolve, reject) =>
        void methods.get(method)!({
          params,
          client: { connect: { client: { mode: 'backend' } } },
          hasCurrentClientAuthority: () => true,
          ...request,
          respond: (ok: boolean, value: unknown, error: any) =>
            ok ? resolve(value) : reject(new Error(error.message)),
        }),
    );
  return { service, controller, call };
}

test('maps Team rooms to opaque custody scopes without putting the business schema in Required services', async () => {
  const f = fixture();
  await f.service.start();
  expect(
    await f.call(RPC.HoldingPrepare, {
      roomId: 'room',
      generation: 1,
      agentId: 'main',
      cwd: path.resolve('.'),
    }),
  ).toEqual(identity);
  expect(ports.prepare).toHaveBeenCalledExactlyOnceWith({
    scopeId: 'room',
    epoch: 1,
    agentId: 'main',
    cwd: path.resolve('.'),
  });
  expect(
    await f.call(RPC.HoldingSave, {
      identity,
      send,
      fingerprint: sha(serializeTeamDiscussionSend(send)),
    }),
  ).toMatchObject({ requestId: 'request', state: 'saved', entryId: 'entry' });
  expect(ports.append).toHaveBeenCalledWith({
    identity,
    operationId: 'request',
    sha256: sha(serializeTeamDiscussionSend(send)),
    payload: serializeTeamDiscussionSend(send),
  });
});

test('interprets the opaque canonical payload only in Team and rejects foreign or conflicting locators', async () => {
  const f = fixture();
  await f.service.start();
  const params = {
    identity,
    requestId: 'request',
    fingerprint: sha(serializeTeamDiscussionSend(send)),
    entryId: 'entry',
  };
  expect((await f.call(RPC.HoldingRead, params)).send).toMatchObject(send);
  await expect(
    f.call(RPC.HoldingRead, { ...params, identity: { ...identity, resourceId: sha('foreign') } }),
  ).rejects.toThrow('SessionChanged');
  ports.read.mockResolvedValueOnce({ payload: JSON.stringify(send), entryId: 'entry' });
  await expect(f.call(RPC.HoldingRead, params)).rejects.toThrow('ExecutionConflict');
});

test('validates the Team send before delegating any opaque append', async () => {
  const f = fixture();
  await f.service.start();
  await expect(
    f.call(RPC.HoldingSave, { identity, send: { ...send, rounds: 99 }, fingerprint: sha('input') }),
  ).rejects.toThrow('InvalidInput');
  expect(ports.append).not.toHaveBeenCalled();
});

test('starts a candidate storage adapter without waiting for its unpublished owner proof', async () => {
  ports.bind.mockResolvedValue(false);
  const f = fixture();
  await f.service.start();
  expect(ports.bind).not.toHaveBeenCalled();
});

test('rejects failed storage binding before calling the opaque append capability', async () => {
  const f = fixture();
  await f.service.start();
  ports.bind.mockResolvedValue(false);
  await expect(
    f.call(RPC.HoldingSave, {
      identity,
      send,
      fingerprint: sha(serializeTeamDiscussionSend(send)),
    }),
  ).rejects.toThrow('Disabled');
  expect(ports.append).not.toHaveBeenCalled();
});

test.each(['stop', 'restart', 'abort', 'authority'] as const)(
  'a late storage proof after %s cannot call an opaque capability',
  async changed => {
    const f = fixture();
    await f.service.start();
    let release!: (value: boolean) => void;
    ports.bind.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        release = resolve;
      }),
    );
    const controller = new AbortController();
    let authority = true;
    const pending = f.call(
      RPC.HoldingSave,
      { identity, send, fingerprint: sha(serializeTeamDiscussionSend(send)) },
      { signal: controller.signal, hasCurrentClientAuthority: () => authority },
    );
    const rejected = expect(pending).rejects.toThrow('Disabled');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    if (changed === 'stop' || changed === 'restart') {
      f.service.stop();
      if (changed === 'restart') await f.service.start();
    } else if (changed === 'abort') controller.abort();
    else authority = false;
    release(true);
    await rejected;
    expect(ports.append).not.toHaveBeenCalled();
  },
);
