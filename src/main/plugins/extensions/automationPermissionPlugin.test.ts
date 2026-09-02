import { afterEach, describe, expect, it, vi } from 'vitest';

import automationPermissionPlugin from '../../../../openclaw-extensions/automation-permission/index';

type PolicyEvaluator = (
  event: { toolName: string; params?: unknown },
  context: { agentId?: string; sessionKey?: string },
) => Promise<unknown>;

const registerPolicy = (
  permissionMode?: 'read-only' | 'guarded' | 'workspace' | 'full',
  unrestrictedAgentIds: string[] = [],
): PolicyEvaluator => {
  let evaluator: PolicyEvaluator | undefined;
  automationPermissionPlugin.register({
    pluginConfig: { unrestrictedAgentIds },
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
          timeoutBehavior: 'deny',
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

  it('allows mutations for the dedicated scheduler agent', async () => {
    const evaluate = registerPolicy('guarded', ['justdo-scheduler']);

    await expect(
      evaluate(
        { toolName: 'automations', params: { action: 'run', jobId: 'job-1' } },
        {
          agentId: 'justdo-scheduler',
          sessionKey: 'agent:justdo-scheduler:cron:job-1:run:run-1',
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('does not trust a scheduler agent id outside a native cron run', async () => {
    const evaluate = registerPolicy('guarded', ['justdo-scheduler']);

    await expect(
      evaluate(
        { toolName: 'automations', params: { action: 'wake', mode: 'now' } },
        {
          agentId: 'justdo-scheduler',
          sessionKey: 'agent:justdo-scheduler:justdo:interactive-session',
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

  it('keeps sensitive mutation parameters only in reviewer-only approval detail', async () => {
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

    const approval = (result as { requireApproval: { description: string; detail: string } })
      .requireApproval;
    expect(approval.description).toContain('Open the desktop app to review full details');
    expect(approval.description).not.toContain(privatePrompt);
    expect(approval.description).not.toContain(privateTarget);
    expect(approval.detail).toContain(privatePrompt);
    expect(approval.detail).toContain(privateTarget);
  });

  it.each([
    ['1200000', 1_200_000],
    ['0', Number.MAX_SAFE_INTEGER],
  ])('uses the host approval timeout %s', async (configured, expected) => {
    vi.stubEnv('JUSTDO_EXEC_APPROVAL_TIMEOUT_MS', configured);
    const evaluate = registerPolicy('guarded');

    await expect(
      evaluate(
        { toolName: 'automations', params: { action: 'remove', jobId: 'job-1' } },
        { agentId: 'main', sessionKey: 'agent:main:justdo:session-1' },
      ),
    ).resolves.toMatchObject({ requireApproval: { timeoutMs: expected } });
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
