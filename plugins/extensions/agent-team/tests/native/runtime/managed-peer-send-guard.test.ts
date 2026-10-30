import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const code = buildSync({
  entryPoints: [path.resolve(import.meta.dirname, '../../../runtime/collaboration/managed-peer-send-guard.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['openclaw/plugin-sdk/*'],
}).outputFiles[0].text;

function fixture(initiallyEnabled = false) {
  let enabled = initiallyEnabled;
  let beforeToolCall!: (event: unknown, context: unknown) => unknown;
  const module = { exports: {} as Record<string, (...args: any[]) => unknown> };
  vm.runInNewContext(code, {
    exports: module.exports,
    module,
    require(name: string) {
      if (name !== 'openclaw/plugin-sdk/routing') throw new Error('Unexpected required guard import');
      return {
        isSubagentSessionKey: (key: string) => /^(?:agent:[^:]+:)?subagent:/i.test(key.trim()),
        isAcpSessionKey: (key: string) => /^(?:agent:[^:]+:)?acp:/i.test(key.trim()),
      };
    },
  });
  module.exports.registerManagedPeerSendGuard({
    runtime: { config: { current: () => ({ plugins: { entries: { 'agent-team': { enabled } } } }) } },
    on(name: string, hook: typeof beforeToolCall) {
      expect(name).toBe('before_tool_call');
      beforeToolCall = hook;
    },
  });
  return {
    before: (toolName: string, params?: unknown) => beforeToolCall(
      { toolName, params }, { sessionKey: 'agent:main:justdo:a' },
    ),
    enable: () => { enabled = true; },
  };
}

describe('required peer protection without optional Team code', () => {
  it.each([
    { sessionKey: 'agent:review:justdo:b' },
    { sessionKey: 'physical-session-id' },
    { label: 'review' },
    { agentId: 'review' },
  ])('keeps the disabled peer boundary for %j', params => {
    expect(fixture().before('sessions_send', params)).toMatchObject({ block: true });
  });

  it.each([true, false].flatMap(enabled => [
    'agent:main:subagent:child', 'subagent:child', ' AGENT:main:SUBAGENT:child ',
    'agent:main:acp:child', 'acp:child',
  ].map(sessionKey => [enabled, sessionKey] as const)))(
    'leaves native child sends untouched when enabled=%s and key=%s', (enabled, sessionKey) => {
      expect(fixture(enabled).before('sessions_send', { sessionKey })).toBeUndefined();
    },
  );

  it('blocks stale peer sends, preserves SubAgent spawning and follows current enablement', () => {
    const h = fixture();
    expect(h.before('sessions_send')).toMatchObject({ block: true });
    expect(h.before('sessions_spawn')).toBeUndefined();
    h.enable();
    expect(h.before('sessions_send')).toBeUndefined();
  });
});
