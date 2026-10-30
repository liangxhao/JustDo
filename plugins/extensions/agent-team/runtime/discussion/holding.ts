import { createHash } from 'node:crypto';
import path from 'node:path';

import type { CustodyIdentity, CustodyReceipt } from '@runtime-services/sdk/custody';
import { createCustodyClient, custodyResourceId } from '@runtime-services/sdk/custody-client';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import {
  discussionRecord,
  isTeamDiscussionAgentId,
  isTeamDiscussionId,
  parseTeamDiscussionSend,
  serializeTeamDiscussionSend,
  TeamDiscussionGateway,
  type TeamDiscussionHoldingIdentity,
} from '../../contracts/discussionInput';

const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');

/** Business protocol adapter. Required custody sees only opaque bytes and exact native identities. */
export function registerDiscussionHolding(api: OpenClawPluginApi): void {
  const custody = createCustodyClient(api);
  let stopped = true;
  let serviceRevision = 0;
  api.registerService({
    id: 'agent-team-input',
    async start() {
      serviceRevision++;
      if (api.lifecycle.signal?.aborted !== false) throw new Error('teamDiscussionDisabled');
      stopped = false;
    },
    stop() {
      stopped = true;
      serviceRevision++;
    },
  });
  const current = () => {
    if (stopped || !custody.isCurrent() || api.lifecycle.signal?.aborted !== false)
      throw new Error('teamDiscussionDisabled');
  };
  const identity = (value: unknown): TeamDiscussionHoldingIdentity => {
    const input = discussionRecord(value);
    if (
      !isTeamDiscussionId(input.roomId) ||
      !Number.isSafeInteger(input.generation) ||
      Number(input.generation) < 1 ||
      input.epoch !== input.generation ||
      input.resourceId !== custodyResourceId(api.id, input.roomId) ||
      !isTeamDiscussionAgentId(input.agentId) ||
      ['sessionKey', 'sessionId', 'lifecycleRevision'].some(
        key => typeof input[key] !== 'string' || !input[key],
      )
    )
      throw new Error('teamDiscussionSessionChanged');
    return input as unknown as TeamDiscussionHoldingIdentity;
  };
  const output = (value: TeamDiscussionHoldingIdentity, receipt: CustodyReceipt) => ({
    identity: value,
    requestId: receipt.operationId,
    fingerprint: receipt.sha256,
    state: receipt.state,
    ...(receipt.entryId ? { entryId: receipt.entryId } : {}),
  });
  type Handler = Parameters<OpenClawPluginApi['registerGatewayMethod']>[1];
  const handle =
    (work: (params: Record<string, unknown>) => Promise<unknown>): Handler =>
    async request => {
      try {
        const revision = serviceRevision;
        const assertActive = () => {
          if (
            stopped ||
            revision !== serviceRevision ||
            api.lifecycle.signal?.aborted !== false ||
            request.signal?.aborted ||
            request.client?.connect.client.mode !== 'backend' ||
            request.hasCurrentClientAuthority?.() !== true
          )
            throw new Error('teamDiscussionDisabled');
        };
        assertActive();
        if (!(await custody.bind())) throw new Error('teamDiscussionDisabled');
        assertActive();
        current();
        const result = await work(request.params);
        assertActive();
        current();
        request.respond(true, result);
      } catch (error) {
        request.respond(false, undefined, {
          code: 'invalid_request',
          message: error instanceof Error ? error.message : 'teamDiscussionUnavailable',
        });
      }
    };
  api.registerGatewayMethod(
    TeamDiscussionGateway.HoldingPrepare,
    handle(async params => {
      if (
        !isTeamDiscussionId(params.roomId) ||
        !isTeamDiscussionAgentId(params.agentId) ||
        !Number.isSafeInteger(params.generation) ||
        Number(params.generation) < 1 ||
        typeof params.cwd !== 'string' ||
        !path.isAbsolute(params.cwd)
      )
        throw new Error('teamDiscussionInvalidInput');
      const native = await custody.prepare({
        scopeId: params.roomId,
        epoch: Number(params.generation),
        agentId: params.agentId,
        cwd: params.cwd,
      });
      return {
        ...native,
        roomId: params.roomId,
        generation: Number(params.generation),
      } satisfies TeamDiscussionHoldingIdentity;
    }),
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.HoldingSave,
    handle(async params => {
      const value = identity(params.identity);
      const send = parseTeamDiscussionSend(params.send);
      const payload = serializeTeamDiscussionSend(send);
      if (send.roomId !== value.roomId || params.fingerprint !== fingerprint(payload))
        throw new Error('teamDiscussionExecutionConflict');
      return output(
        value,
        await custody.append({
          identity: value,
          operationId: send.requestId,
          sha256: fingerprint(payload),
          payload,
        }),
      );
    }),
    { scope: 'operator.admin' },
  );
  api.registerGatewayMethod(
    TeamDiscussionGateway.HoldingRead,
    handle(async params => {
      const value = identity(params.identity);
      if (
        !isTeamDiscussionId(params.requestId) ||
        typeof params.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(params.fingerprint)
      )
        throw new Error('teamDiscussionInvalidInput');
      const saved = await custody.read({
        identity: value as CustodyIdentity,
        resourceId: value.resourceId,
        epoch: value.epoch,
        operationId: params.requestId,
        sha256: params.fingerprint,
        ...(typeof params.entryId === 'string' ? { entryId: params.entryId } : {}),
      });
      const fields: unknown = JSON.parse(saved.payload);
      if (!Array.isArray(fields) || fields.length !== 7)
        throw new Error('teamDiscussionExecutionConflict');
      const send = parseTeamDiscussionSend({
        roomId: fields[0],
        requestId: params.requestId,
        expectedRevision: fields[1],
        message: fields[2],
        selectedAgentIds: fields[3],
        rounds: fields[4],
        attachmentPaths: fields[5],
        quotes: fields[6],
      });
      if (
        send.roomId !== value.roomId ||
        fingerprint(serializeTeamDiscussionSend(send)) !== params.fingerprint
      )
        throw new Error('teamDiscussionExecutionConflict');
      return { identity: value, send, entryId: saved.entryId };
    }),
    { scope: 'operator.admin' },
  );
}
