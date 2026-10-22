import { describe, expect, it, vi } from 'vitest';

import automationPermissionPlugin from '../../../../plugins/extensions/automation-permission/index';

type PolicyEvaluator = (
  event: { toolName: string; params?: unknown },
  context: { agentId?: string; sessionKey?: string },
) => Promise<unknown>;

const registerPolicy = (
  permissionMode?: 'read-only' | 'guarded' | 'workspace' | 'full',
  approvalTimeoutMinutes = 2,
): PolicyEvaluator => {
  let evaluator: PolicyEvaluator | undefined;
  automationPermissionPlugin.register({
    pluginConfig: { approvalTimeoutMinutes },
    runtime: {
      agent: {
        session: {
          getSessionEntry: vi.fn(() => (permissionMode ? { permissionMode } : undefined)),
        },
      },
    },
    logger: { info: vi.fn() },
    registerGatewayMethod: vi.fn(),
    registerTrustedToolPolicy: (policy: { evaluate: PolicyEvaluator }) => {
      evaluator = policy.evaluate;
    },
  } as never);
  if (!evaluator) throw new Error('trusted tool policy was not registered');
  return evaluator;
};

describe('automation permission extension', () => {
  it.each(['guarded', 'workspace', undefined] as const)(
    'requires one-shot approval for %s session mutations',
    async permissionMode => {
      const evaluate = registerPolicy(permissionMode);

      await expect(
        evaluate(
          { toolName: 'automations', params: { action: 'add', name: 'Daily report' } },
          { agentId: 'main', sessionKey: 'agent:main:justdo:session-1' },
        ),
      ).resolves.toMatchObject({
        requireApproval: {
          allowedDecisions: ['allow-once', 'deny'],
          timeoutMs: 120_000,
        },
      });
    },
  );

  it('allows mutations in Full sessions', async () => {
    const evaluate = registerPolicy('full');

    await expect(
      evaluate(
        { toolName: 'automations', params: { action: 'remove', jobId: 'job-1' } },
        { agentId: 'main', sessionKey: 'agent:main:justdo:session-1' },
      ),
    ).resolves.toBeUndefined();
  });

  it('requires approval for mutations even inside a cron run', async () => {
    const evaluate = registerPolicy('guarded');

    await expect(
      evaluate(
        { toolName: 'automations', params: { action: 'run', jobId: 'job-1' } },
        {
          agentId: 'main',
          sessionKey: 'agent:main:cron:job-1:run:run-1',
        },
      ),
    ).resolves.toMatchObject({ requireApproval: expect.any(Object) });
  });

  it('requires approval for interactive agent mutations', async () => {
    const evaluate = registerPolicy('guarded');

    await expect(
      evaluate(
        { toolName: 'automations', params: { action: 'wake', mode: 'now' } },
        {
          agentId: 'main',
          sessionKey: 'agent:main:justdo:interactive-session',
        },
      ),
    ).resolves.toMatchObject({ requireApproval: expect.any(Object) });
  });

  it('blocks mutations in read-only sessions', async () => {
    const evaluate = registerPolicy('read-only');

    await expect(
      evaluate(
        { toolName: 'automations', params: { action: 'update', jobId: 'job-1' } },
        { agentId: 'main', sessionKey: 'agent:main:justdo:session-1' },
      ),
    ).resolves.toEqual({
      allow: false,
      reason: 'Automation mutations are disabled in read-only sessions.',
    });
  });

  it('includes a bounded summary of mutation parameters in the approval description', async () => {
    const evaluate = registerPolicy('guarded');
    const privateTarget = 'private-channel-at-the-end';
    const privatePrompt = `private-prompt-${'x'.repeat(700)}`;
    const result = await evaluate(
      {
        toolName: 'automations',
        params: {
          action: 'add',
          prompt: privatePrompt,
          delivery: privateTarget,
        },
      },
      { agentId: 'main', sessionKey: 'agent:main:justdo:session-1' },
    );

    const approval = (result as { requireApproval: { description: string } }).requireApproval;
    expect(approval.description).toContain(privatePrompt.slice(0, 100));
    expect(approval.description).not.toContain(privatePrompt);
    expect(approval.description).toContain(privateTarget);
    expect(approval.description).toContain('…[truncated]');
    expect([...approval.description].length).toBeLessThanOrEqual(400);
    expect(approval).not.toHaveProperty('detail');
  });

  it('preserves invisible characters for upstream secret detection while budgeting their display cost', async () => {
    const evaluate = registerPolicy('guarded');
    const splicedSecret = `sk-abc123\u200B${'x'.repeat(700)}`;
    const result = await evaluate(
      {
        toolName: 'automations',
        params: { action: 'update', name: splicedSecret },
      },
      { agentId: 'main', sessionKey: 'agent:main:justdo:session-1' },
    );

    const approval = (result as { requireApproval: { description: string } }).requireApproval;
    expect(approval.description).toContain('sk-abc123\u200B');
    expect(approval.description).not.toContain('\\u{200B}');
    const upstreamDisplay = approval.description.replace(/\u200B/gu, '\\u{200B}');
    expect([...upstreamDisplay].length).toBeLessThanOrEqual(400);
  });

  it('uses the configured scheduled task approval timeout', async () => {
    const evaluate = registerPolicy('guarded', 10);

    await expect(
      evaluate(
        { toolName: 'automations', params: { action: 'remove', jobId: 'job-1' } },
        { agentId: 'main', sessionKey: 'agent:main:justdo:session-1' },
      ),
    ).resolves.toMatchObject({ requireApproval: { timeoutMs: 600_000 } });
  });

  it.each(['status', 'list', 'get', 'runs'])(
    'allows read-only action %s without approval',
    async action => {
      const evaluate = registerPolicy('guarded');

      await expect(
        evaluate(
          { toolName: 'automations', params: { action } },
          { agentId: 'main', sessionKey: 'agent:main:justdo:session-1' },
        ),
      ).resolves.toBeUndefined();
    },
  );
});
