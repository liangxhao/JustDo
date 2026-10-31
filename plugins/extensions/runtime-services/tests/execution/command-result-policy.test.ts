import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { expect, test, vi } from 'vitest';

import { registerCommandResultPolicy } from '../../execution/command-result-policy';

test('adds stable result-collection guidance without reading history or changing tool calls', () => {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const on = vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
    hooks.set(name, handler);
  });
  registerCommandResultPolicy({ on } as unknown as OpenClawPluginApi);

  expect([...hooks.keys()]).toEqual(['before_prompt_build']);
  const unreadableInput = new Proxy({}, {
    get() { throw new Error('Result policy must not inspect prompt, history or session data.'); },
  });
  const build = hooks.get('before_prompt_build')!;
  const first = build(unreadableInput, {});
  expect(build({}, {})).toEqual(first);
  expect(first).toEqual({ appendSystemContext: expect.any(String) });
  const guidance = (first as { appendSystemContext: string }).appendSystemContext;
  expect(guidance).toContain('awaitResults: true');
  expect(guidance).toContain('existing process or cell handle');
  expect(guidance).toContain('Do not launch the command again');
  expect(guidance).toContain('Verify service readiness');
});

test('leaves external ACP agents to their own tool and completion contracts', () => {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  registerCommandResultPolicy({
    config: {
      agents: { entries: { external: { runtime: { type: 'acp' } }, embedded: {} } },
    },
    on: (name: string, handler: (...args: unknown[]) => unknown) => hooks.set(name, handler),
  } as unknown as OpenClawPluginApi);
  const build = hooks.get('before_prompt_build')!;
  expect(build({}, { agentId: 'external' })).toBeUndefined();
  expect(build({}, { agentId: 'embedded' })).toEqual({ appendSystemContext: expect.any(String) });
});
