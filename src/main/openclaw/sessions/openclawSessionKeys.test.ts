import { expect, test } from 'vitest';

import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
  isCronSessionKey,
  isManagedSessionKey,
  parseManagedSessionKey,
} from './openclawSessionKeys';

test('parseManagedSessionKey handles raw local session keys', () => {
  expect(parseManagedSessionKey('justdo:abc-123')).toEqual({
    agentId: null,
    sessionId: 'abc-123',
  });
});

test('parseManagedSessionKey handles canonical local session keys', () => {
  expect(parseManagedSessionKey('agent:main:justdo:abc-123')).toEqual({
    agentId: 'main',
    sessionId: 'abc-123',
  });
});

test('buildManagedSessionKey emits canonical local session keys', () => {
  expect(buildManagedSessionKey('abc-123')).toBe(
    `agent:${DEFAULT_MANAGED_AGENT_ID}:justdo:abc-123`,
  );
  expect(buildManagedSessionKey('abc-123', 'secondary')).toBe('agent:secondary:justdo:abc-123');
});

test('isCronSessionKey recognizes cron session keys', () => {
  expect(isCronSessionKey('cron:a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
  expect(isCronSessionKey('agent:main:cron:a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
  expect(isCronSessionKey('justdo:abc-123')).toBe(false);
  expect(isCronSessionKey('agent:main:justdo:abc-123')).toBe(false);
});

test('isManagedSessionKey only accepts JustDo-owned session keys', () => {
  expect(isManagedSessionKey('agent:main:justdo:abc-123')).toBe(true);
  expect(isManagedSessionKey('justdo:abc-123')).toBe(true);
  expect(isManagedSessionKey('agent:main:main')).toBe(false);
  expect(isManagedSessionKey('cron:abc-123')).toBe(false);
});
