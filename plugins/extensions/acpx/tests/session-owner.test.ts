import { describe, expect, it, vi } from 'vitest';

vi.mock('../runtime-api.js', () => ({
  AcpRuntimeError: class extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));
vi.mock('openclaw/plugin-sdk/routing', () => ({
  normalizeAgentId: (agentId: string) => agentId.trim().toLowerCase(),
  parseAgentSessionKey: (sessionKey: string) => {
    const match = /^agent:([^:]+):.+$/.exec(sessionKey);
    return match ? { agentId: match[1] } : null;
  },
}));

import { assertAcpxSessionOwnerLocator } from '../src/session-owner.js';

describe('ACP session owner admission', () => {
  it('accepts the canonical owner-qualified session key', () => {
    expect(
      assertAcpxSessionOwnerLocator({ sessionKey: 'agent:main:session', agentId: 'main' }),
    ).toBe('agent:main:session');
  });

  it('rejects an unqualified stored record without offering a removed migration', () => {
    expect(() =>
      assertAcpxSessionOwnerLocator(
        { sessionKey: 'stored-session', agentId: 'main' },
        new Set(['stored-session']),
      ),
    ).toThrow('has an unqualified or unverifiable backend locator and cannot be resumed');
  });

  it('rejects a persisted bare handle that cannot prove its owner', () => {
    expect(() =>
      assertAcpxSessionOwnerLocator({
        sessionKey: 'stored-session',
        agentId: 'main',
        persistedHandle: {
          sessionKey: 'stored-session',
          backend: 'acpx',
          runtimeSessionName: 'stored-session',
        },
      }),
    ).toThrow('has an unqualified or unverifiable backend locator and cannot be resumed');
  });
});
