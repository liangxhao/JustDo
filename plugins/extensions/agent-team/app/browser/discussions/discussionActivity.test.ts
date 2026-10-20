import {
  type TeamDiscussionExecution,
  type TeamDiscussionRoom,
  teamDiscussionSessionKey,
} from '../../contracts/teamDiscussion';
import { CoworkInteractionKind } from '@app-plugin/sdk/interactions';
import { expect, it } from 'vitest';

import type { CoworkInteractionRequest } from '@app-plugin/sdk/application';

import { discussionQuestionAgents, discussionRunningAgents } from './discussionActivity';

const room: TeamDiscussionRoom = {
  id: 'room',
  title: 'Room',
  cwd: '/project',
  permissionMode: 'ask',
  rounds: 2,
  revision: 1,
  generation: 0,
  createdAt: 1,
  updatedAt: 1,
  state: 'running',
  members: [
    { agentId: 'alice', name: 'Alice' },
    { agentId: 'bob', name: 'Bob' },
  ],
};
const question = (agent: string, roomId = 'room'): CoworkInteractionRequest => ({
  sessionId: 'native',
  requestId: agent,
  toolName: 'ask_user_question',
  interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
  toolInput: { sessionKey: teamDiscussionSessionKey(roomId, agent) },
});

it('shows attention only for exact room members with pending structured questions', () => {
  expect(
    discussionQuestionAgents(room, [
      question('alice'),
      question('alice'),
      question('bob', 'other'),
      question('outsider'),
      { ...question('bob'), interactionKind: CoworkInteractionKind.PLAN_APPROVAL },
      { ...question('bob'), toolInput: { sessionKey: 'agent:bob:justdo:source' } },
    ]),
  ).toEqual(['alice']);
  expect(discussionQuestionAgents(room, [])).toEqual([]);
  expect(
    discussionQuestionAgents(
      { ...room, members: [{ agentId: 'alice', name: 'Alice', deleted: true }] },
      [question('alice')],
    ),
  ).toEqual([]);
});

it('uses the newest exact-batch execution per member and excludes old activity', () => {
  const execution = (
    agentId: string,
    discussionId: string,
    outcome: TeamDiscussionExecution['outcome'],
  ): TeamDiscussionExecution => ({
    agentId,
    discussionId,
    outcome,
    sessionKey: 'key',
    sessionId: 'native',
    lifecycleRevision: 'rev',
    runId: 'run',
  });
  const executions = [
    execution('bob', 'old', 'running'),
    execution('alice', 'current', 'completed'),
    execution('alice', 'current', 'running'),
  ];
  expect(discussionRunningAgents(room, 'current', executions)).toEqual(['alice']);
  expect(discussionRunningAgents({ ...room, state: 'ready' }, 'current', executions)).toEqual([]);
  expect(discussionRunningAgents(room, undefined, executions)).toEqual([]);
});
