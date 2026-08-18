import { describe, expect, it, vi } from 'vitest';

import permissionPolicyPlugin from '../../../../openclaw-extensions/file-permission-policy/index';

type BeforeToolCall = (event: {
  toolName: string;
  params?: unknown;
  derivedPaths?: unknown;
}) => Promise<unknown>;

const registerPolicy = (mode: 'ask' | 'auto' | 'full'): BeforeToolCall => {
  let beforeToolCall: BeforeToolCall | undefined;
  permissionPolicyPlugin.register({
    pluginConfig: { mode },
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

  it.each(['ask', 'auto', 'full'] as const)(
    'does not block native cron mutations in %s mode',
    async mode => {
      const beforeToolCall = registerPolicy(mode);

      for (const action of ['add', 'update', 'remove', 'run']) {
        await expect(
          beforeToolCall({ toolName: 'cron', params: { action } }),
        ).resolves.toBeUndefined();
      }
    },
  );

  it('allows read-only cron actions in full mode', async () => {
    const beforeToolCall = registerPolicy('full');

    await expect(
      beforeToolCall({ toolName: 'cron', params: { action: 'list' } }),
    ).resolves.toBeUndefined();
  });

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
      pluginConfig: { mode: 'ask' },
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
    expect(payload).toMatchObject({ loaded: true, configuredMode: 'ask' });
    expect(payload).not.toHaveProperty('active');
    expect(payload).not.toHaveProperty('effectiveMode');
  });
});
