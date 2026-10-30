import { describe, expect, it } from 'vitest';

import {
  parseTeamDiscussionInitiator,
  parseTeamDiscussionSend,
  parseTeamDiscussionSessionKey,
  teamDiscussionSessionKey,
} from './teamDiscussion';

const send = {
  roomId: 'room',
  requestId: 'request',
  expectedRevision: 1,
  message: 'Hello',
  selectedAgentIds: [],
  rounds: 2,
};
describe('group discussion request boundary', () => {
  it('rejects sender impersonation at the public send boundary and validates gateway attribution', () => {
    const initiator = { kind: 'organizer', agentId: 'main', name: 'Organizer' };
    expect(() => parseTeamDiscussionSend({ ...send, initiator })).toThrow();
    expect(() => parseTeamDiscussionSend({ ...send, initiatorAgentId: 'main' })).toThrow();
    expect(parseTeamDiscussionInitiator(initiator)).toEqual(initiator);
    expect(parseTeamDiscussionInitiator(undefined)).toEqual({ kind: 'user' });
    expect(() => parseTeamDiscussionInitiator({ ...initiator, agentId: '../main' })).toThrow();
    expect(() => parseTeamDiscussionInitiator({ kind: 'user', agentId: 'main' })).toThrow();
  });
  it('requires an explicit valid recipient selection even for broadcast', () => {
    expect(parseTeamDiscussionSend(send).selectedAgentIds).toEqual([]);
    for (const selectedAgentIds of [
      undefined,
      null,
      'alice',
      ['alice', 'alice'],
      ['../alice'],
      ['Alice'],
    ]) {
      expect(() => parseTeamDiscussionSend({ ...send, selectedAgentIds })).toThrow();
    }
  });
  it('rejects excess execution budgets and hidden payload fields', () => {
    for (const rounds of [0, 5, 1.5, '2'])
      expect(() => parseTeamDiscussionSend({ ...send, rounds })).toThrow();
    expect(() => parseTeamDiscussionSend({ ...send, permissionMode: 'full' })).toThrow();
    expect(() => parseTeamDiscussionSend({ ...send, message: ' ' })).toThrow();
  });
  it('keeps each member in a distinct group namespace', () => {
    expect(teamDiscussionSessionKey('room', 'alice')).toBe('agent:alice:agent-team:group:room');
    expect(() => teamDiscussionSessionKey('room:other', 'alice')).toThrow();
  });
});

it('attributes native group questions without accepting another session namespace', () => {
  expect(parseTeamDiscussionSessionKey('agent:alice:agent-team:group:room')).toEqual({
    agentId: 'alice',
    roomId: 'room',
  });
  expect(parseTeamDiscussionSessionKey('agent:alice:justdo:room')).toBeNull();
  expect(parseTeamDiscussionSessionKey('agent:alice:justdo-team:group:room')).toBeNull();
  expect(parseTeamDiscussionSessionKey('agent:alice:agent-team:group:room:other')).toBeNull();
});
