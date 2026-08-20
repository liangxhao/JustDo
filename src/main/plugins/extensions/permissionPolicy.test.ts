import { describe, expect, it, vi } from 'vitest';

import permissionPolicyPlugin from '../../../../openclaw-extensions/file-permission-policy/index';

type BeforeToolCall = (event: {
  toolName: string;
  params?: unknown;
  derivedPaths?: unknown;
  toolCallId?: string;
}, context?: { agentId?: string; toolCallId?: string; sessionKey?: string }) => Promise<unknown>;

const registerPolicy = (
  mode: 'ask' | 'auto' | 'full',
  fullAgentIds: string[] = [],
): BeforeToolCall => {
  let beforeToolCall: BeforeToolCall | undefined;
  permissionPolicyPlugin.register({
    pluginConfig: { mode, fullAgentIds },
    logger: { info: vi.fn() },
    registerTrustedToolPolicy: (policy: { evaluate: BeforeToolCall }) => {
      beforeToolCall = policy.evaluate;
    },
    registerGatewayMethod: vi.fn(),
  } as never);
  if (!beforeToolCall) throw new Error('trusted tool policy was not registered');
  return beforeToolCall;
};

describe('file permission policy extension', () => {
  it.each(['write', 'edit', 'apply_patch'])(
    'requires one-shot approval for %s in ask mode',
    async toolName => {
      const beforeToolCall = registerPolicy('ask');

      const result = await beforeToolCall({
        toolName,
        params: { file_path: 'E:/workspace/project/example.ts' },
      });

      expect(result).toMatchObject({
        requireApproval: {
          allowedDecisions: ['allow-once', 'deny'],
          description: 'E:/workspace/project/example.ts',
          timeoutBehavior: 'deny',
        },
      });
    },
  );

  it('fails auto file writes back to one-shot approval', async () => {
    const beforeToolCall = registerPolicy('auto');

    await expect(beforeToolCall({ toolName: 'write' })).resolves.toMatchObject({
      requireApproval: { allowedDecisions: ['allow-once', 'deny'] },
    });
  });

  it('does not prompt for file writes in full mode', async () => {
    const beforeToolCall = registerPolicy('full');

    await expect(beforeToolCall({ toolName: 'write' })).resolves.toBeUndefined();
  });

  it('allows file writes only for an explicitly configured Full agent', async () => {
    const beforeToolCall = registerPolicy('ask', ['justdo-scheduler']);

    await expect(
      beforeToolCall({ toolName: 'write' }, { agentId: 'justdo-scheduler' }),
    ).resolves.toBeUndefined();
    await expect(
      beforeToolCall({ toolName: 'write' }, { agentId: 'main' }),
    ).resolves.toMatchObject({ requireApproval: expect.any(Object) });
  });

  it.each(['ask', 'auto'] as const)(
    'requires one-shot approval for native cron mutations in %s mode',
    async mode => {
      const beforeToolCall = registerPolicy(mode);

      for (const action of ['add', 'update', 'remove', 'run']) {
        const result = await beforeToolCall({ toolName: 'cron', params: { action } });
        expect(result).toMatchObject({
          requireApproval: {
            allowedDecisions: ['allow-once', 'deny'],
            description: `justdo-detail:unavailable\n${JSON.stringify({ action })}`,
            timeoutBehavior: 'deny',
          },
        });
      }
    },
  );

  it('makes complete scheduled-task details available through the operator gateway method', async () => {
    let beforeToolCall: BeforeToolCall | undefined;
    let detailsHandler:
      | ((context: {
          params?: unknown;
          respond: (ok: boolean, payload: Record<string, unknown>) => void;
        }) => Promise<void>)
      | undefined;
    permissionPolicyPlugin.register({
      pluginConfig: { mode: 'ask', fullAgentIds: [] },
      logger: { info: vi.fn() },
      registerTrustedToolPolicy: (policy: { evaluate: BeforeToolCall }) => {
        beforeToolCall = policy.evaluate;
      },
      registerGatewayMethod: (name: string, handler: typeof detailsHandler) => {
        if (name === 'filePermissionPolicy.approvalDetails') detailsHandler = handler;
      },
    } as never);
    const params = {
      action: 'add',
      job: {
        name: 'Morning report',
        schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
        enabled: true,
        sessionTarget: 'isolated',
        payload: { kind: 'agentTurn', message: 'Summarize overnight changes' },
      },
    };

    const result = (await beforeToolCall?.(
      { toolName: 'cron', params },
      {
        toolCallId: 'tool-call-1',
        agentId: 'main',
        sessionKey: 'agent:main:justdo:session-1',
      } as never,
    )) as {
      requireApproval: { description: string };
    };
    const nonce = /^justdo-detail:([0-9a-f-]{36})\n/.exec(
      result.requireApproval.description,
    )?.[1];
    let detail: Record<string, unknown> = {};
    await detailsHandler?.({
      params: {
        nonce,
        toolCallId: 'tool-call-1',
        agentId: 'main',
        sessionKey: 'agent:main:justdo:session-1',
      },
      respond: (_ok, payload) => {
        detail = payload;
      },
    });

    expect(result.requireApproval.description.length).toBeLessThanOrEqual(256);
    expect(detail).toEqual({ found: true, description: JSON.stringify(params, null, 2) });
  });

  it('does not return details when approval identity fields do not match', async () => {
    let beforeToolCall: BeforeToolCall | undefined;
    let detailsHandler:
      | ((context: {
          params?: unknown;
          respond: (ok: boolean, payload: Record<string, unknown>) => void;
        }) => Promise<void>)
      | undefined;
    permissionPolicyPlugin.register({
      pluginConfig: { mode: 'ask', fullAgentIds: [] },
      logger: { info: vi.fn() },
      registerTrustedToolPolicy: (policy: { evaluate: BeforeToolCall }) => {
        beforeToolCall = policy.evaluate;
      },
      registerGatewayMethod: (name: string, handler: typeof detailsHandler) => {
        if (name === 'filePermissionPolicy.approvalDetails') detailsHandler = handler;
      },
    } as never);
    const result = (await beforeToolCall?.(
      { toolName: 'cron', params: { action: 'run', jobId: 'job-1' } },
      {
        toolCallId: 'reused-call-id',
        agentId: 'agent-a',
        sessionKey: 'session-a',
      } as never,
    )) as { requireApproval: { description: string } };
    const nonce = /^justdo-detail:([0-9a-f-]{36})\n/.exec(
      result.requireApproval.description,
    )?.[1];
    let detail: Record<string, unknown> = {};

    await detailsHandler?.({
      params: {
        nonce,
        toolCallId: 'reused-call-id',
        agentId: 'agent-b',
        sessionKey: 'session-b',
      },
      respond: (_ok, payload) => {
        detail = payload;
      },
    });

    expect(detail).toEqual({ found: false });
  });

  it('allows cron mutations in full mode', async () => {
    const beforeToolCall = registerPolicy('full');

    await expect(
      beforeToolCall({ toolName: 'cron', params: { action: 'run' } }),
    ).resolves.toBeUndefined();
  });

  it('allows cron mutations for an explicitly configured Full agent', async () => {
    const beforeToolCall = registerPolicy('ask', ['justdo-scheduler']);

    await expect(
      beforeToolCall(
        { toolName: 'cron', params: { action: 'run' } },
        { agentId: 'justdo-scheduler' },
      ),
    ).resolves.toBeUndefined();
  });

  it.each(['status', 'list', 'get', 'runs'])(
    'allows read-only cron action %s without approval',
    async action => {
      const beforeToolCall = registerPolicy('ask');

      await expect(
        beforeToolCall({ toolName: 'cron', params: { action } }),
      ).resolves.toBeUndefined();
    },
  );

  it('does not duplicate native exec approvals', async () => {
    const beforeToolCall = registerPolicy('ask');

    await expect(beforeToolCall({ toolName: 'exec' })).resolves.toBeUndefined();
  });

  it('does not guess aliases outside the declared core tool contract', async () => {
    const beforeToolCall = registerPolicy('ask');

    await expect(beforeToolCall({ toolName: 'write_file' })).resolves.toBeUndefined();
  });

  it('reports adapter diagnostics without claiming trusted-policy activation', async () => {
    let methodName = '';
    let methodHandler:
      | ((context: {
          respond: (ok: boolean, payload: Record<string, unknown>) => void;
        }) => Promise<void>)
      | undefined;
    permissionPolicyPlugin.register({
      pluginConfig: { mode: 'ask', fullAgentIds: ['justdo-scheduler'] },
      logger: { info: vi.fn() },
      registerTrustedToolPolicy: vi.fn(),
      registerGatewayMethod: (name: string, handler: typeof methodHandler) => {
        methodName = name;
        methodHandler = handler;
      },
    } as never);
    let payload: Record<string, unknown> = {};

    await methodHandler?.({
      respond: (_ok, value) => {
        payload = value;
      },
    });

    expect(methodName).toBe('filePermissionPolicy.info');
    expect(payload).toMatchObject({
      loaded: true,
      configuredMode: 'ask',
      fullAgentIds: ['justdo-scheduler'],
    });
    expect(payload).not.toHaveProperty('active');
    expect(payload).not.toHaveProperty('effectiveMode');
  });
});
