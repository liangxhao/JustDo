import { expect, test } from 'vitest';

import { parseManagedOutgoingMediaSource } from './assistantMedia';

const sessionKey = 'agent:main:session-one';
const source = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/11111111-1111-4111-8111-111111111111/full`;

test('recovers only the canonical native session from an outgoing route', () => {
  expect(parseManagedOutgoingMediaSource(source)).toBe(sessionKey);
  expect(parseManagedOutgoingMediaSource(source, sessionKey)).toBe(sessionKey);
  expect(parseManagedOutgoingMediaSource(source, 'agent:other:session-one')).toBeNull();
});

test.each([
  `${source}?mediaTicket=untrusted`,
  `${source}#fragment`,
  `http://127.0.0.1${source}`,
  source.replace(encodeURIComponent(sessionKey), encodeURIComponent(encodeURIComponent(sessionKey))),
  source.replace('/full', '/thumbnail'),
  source.replace('/full', '/FULL'),
  source.replace('11111111-1111-4111-8111-111111111111', 'not-an-id'),
  source.replace(encodeURIComponent(sessionKey), 'agent%3amain%3asession-one'),
])('rejects a noncanonical outgoing route: %s', value => {
  expect(parseManagedOutgoingMediaSource(value)).toBeNull();
});
