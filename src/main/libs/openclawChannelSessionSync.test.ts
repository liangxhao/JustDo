import { test, expect } from 'vitest';
import {
  DEFAULT_MANAGED_AGENT_ID,
  OpenClawChannelSessionSync,
  buildManagedSessionKey,
  isManagedSessionKey,
  parseManagedSessionKey,
  isCronSessionKey,
} from './openclawChannelSessionSync';

function createSync() {
  return new OpenClawChannelSessionSync({
    coworkStore: {
      getSession: () => null,
      createSession: () => ({
        id: 'test-session-id',
        title: 'Test Session',
        claudeSessionId: null,
        status: 'active',
        pinned: false,
        workingDirectory: '/tmp',
        executionMode: 'local',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      }),
    },
    getDefaultCwd: () => '/tmp',
  });
}

test('parseManagedSessionKey handles raw local session keys', () => {
  expect(parseManagedSessionKey('gucciai:abc-123')).toEqual({
    agentId: null,
    sessionId: 'abc-123',
  });
});

test('parseManagedSessionKey handles canonical local session keys', () => {
  expect(parseManagedSessionKey('agent:main:gucciai:abc-123')).toEqual({
    agentId: 'main',
    sessionId: 'abc-123',
  });
});

test('buildManagedSessionKey emits canonical local session keys', () => {
  expect(buildManagedSessionKey('abc-123')).toBe(
    `agent:${DEFAULT_MANAGED_AGENT_ID}:gucciai:abc-123`,
  );
  expect(buildManagedSessionKey('abc-123', 'secondary')).toBe('agent:secondary:gucciai:abc-123');
});

test('isCronSessionKey recognizes cron session keys', () => {
  expect(isCronSessionKey('cron:a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
  expect(isCronSessionKey('agent:main:cron:a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
  expect(isCronSessionKey('gucciai:abc-123')).toBe(false);
  expect(isCronSessionKey('agent:main:gucciai:abc-123')).toBe(false);
});

test('channel sync does not treat managed local session keys as channel sessions', () => {
  const sync = createSync();

  expect(isManagedSessionKey('agent:main:gucciai:abc-123')).toBe(true);
  expect(sync.isChannelSessionKey('agent:main:gucciai:abc-123')).toBe(false);
  expect(sync.resolveOrCreateSession('agent:main:gucciai:abc-123')).toBe(null);
  expect(sync.resolveOrCreateMainAgentSession('agent:main:gucciai:abc-123')).toBe(null);
});

test('channel sync recognizes main agent session keys', () => {
  const sync = createSync();

  expect(sync.isChannelSessionKey('agent:main:main')).toBe(true);
});

test('channel sync recognizes cron session keys', () => {
  const sync = createSync();

  expect(sync.isChannelSessionKey('cron:abc-123')).toBe(true);
  expect(sync.isChannelSessionKey('agent:main:cron:abc-123')).toBe(true);
});

test('resolveOrCreateCronSession creates sessions for cron keys', () => {
  const sync = createSync();

  const sessionId = sync.resolveOrCreateCronSession('cron:a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  expect(sessionId).toBe('test-session-id');
});
