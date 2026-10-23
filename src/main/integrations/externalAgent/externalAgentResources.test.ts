import { expect, test, vi } from 'vitest';

import {
  EXTERNAL_MCP_CLOSE_METHOD,
  EXTERNAL_MCP_OPEN_METHOD,
} from '../../../../plugins/extensions/runtime-services/contracts/external-mcp';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { ExternalAgentResources } from './externalAgentResources';
import type { ExternalAgentNativeBinding } from './externalAgentTypes';

function setup(failFirst = false) {
  let calls = 0;
  const request = vi.fn(async (method: string, input: unknown) => {
    if (method === EXTERNAL_MCP_OPEN_METHOD) {
      if (failFirst && calls++ === 0) throw new Error('The MCP server could not start.');
      return {
        ok: true,
        leaseId: (input as { leaseId: string }).leaseId,
        serverCount: 1,
        toolCount: 1,
      };
    }
    return { ok: true };
  });
  const client = { request } as unknown as GatewayClientLike;
  const release = vi.fn();
  const claim = vi.fn<OpenClawRuntimeAdapter['claimExternalApprovalOwner']>(() => release);
  const runtime = {
    getGatewayClient: () => client,
    claimExternalApprovalOwner: claim,
  } as unknown as OpenClawRuntimeAdapter;
  const resources = new ExternalAgentResources(() => runtime);
  const binding: ExternalAgentNativeBinding = {
    localSessionId: 'local',
    sessionKey: 'native-key',
    sessionId: 'native-id',
    lifecycleRevision: '1',
    runId: 'run',
    client,
  };
  const thread = { id: 'external-id', cwd: process.cwd(), agentId: 'main' };
  const servers = [{ name: 'server', command: process.execPath, args: [], env: [] }];
  return { resources, binding, thread, servers, request, claim, release };
}

test('failed MCP setup is closed before a later prompt can make a fresh lease', async () => {
  const h = setup(true);
  await expect(
    h.resources.prepare(h.thread, h.servers, h.binding, async () => 'deny'),
  ).rejects.toThrow('could not start');
  expect(h.request).toHaveBeenCalledWith(
    EXTERNAL_MCP_CLOSE_METHOD,
    expect.objectContaining({ sessionId: 'native-id' }),
  );
  await h.resources.prepare(h.thread, h.servers, h.binding, async () => 'deny');
  expect(
    h.request.mock.calls.filter(([method]) => method === EXTERNAL_MCP_OPEN_METHOD),
  ).toHaveLength(2);
  await h.resources.close(h.thread.id);
});

test('MCP connections survive turns while approval ownership is scoped to each exact run', async () => {
  const h = setup();
  const first = await h.resources.prepare(h.thread, h.servers, h.binding, async () => 'deny');
  first();
  const cancellation = new AbortController();
  const second = await h.resources.prepare(
    h.thread,
    h.servers,
    { ...h.binding, runId: 'next-run' },
    async () => 'deny',
    cancellation.signal,
  );
  expect(
    h.request.mock.calls.filter(([method]) => method === EXTERNAL_MCP_OPEN_METHOD),
  ).toHaveLength(1);
  expect(h.claim).toHaveBeenLastCalledWith(
    expect.objectContaining({ runId: 'next-run' }),
    expect.any(Function),
    expect.any(AbortSignal),
  );
  const authority = h.claim.mock.calls[1][2]!;
  expect(authority.aborted).toBe(false);
  cancellation.abort();
  expect(authority.aborted).toBe(true);
  second();
  await h.resources.close(h.thread.id);
  expect(h.release).toHaveBeenCalledTimes(2);
});

test('resource closure revokes approval authority and MCP without releasing an unsettled owner', async () => {
  const h = setup();
  const cleanup = await h.resources.prepare(h.thread, h.servers, h.binding, async () => 'deny');
  const authority = h.claim.mock.calls[0][2]!;

  await h.resources.close(h.thread.id);

  expect(authority.aborted).toBe(true);
  expect(h.request).toHaveBeenCalledWith(
    EXTERNAL_MCP_CLOSE_METHOD,
    expect.objectContaining({ sessionId: 'native-id' }),
  );
  expect(h.release).not.toHaveBeenCalled();
  cleanup();
  cleanup();
  expect(h.release).toHaveBeenCalledOnce();
});
