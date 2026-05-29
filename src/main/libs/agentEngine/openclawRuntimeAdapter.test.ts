import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

function createEmptyStore() {
  const session = {
    id: 'session-1',
    title: 'Test Session',
    claudeSessionId: null,
    status: 'completed',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let nextId = 1;

  return {
    session,
    store: {
      getSession: (sessionId: string) => (sessionId === session.id ? session : null),
      getAgent: () => null,
      addMessage: (sessionId: string, message: Record<string, unknown>) => {
        expect(sessionId).toBe(session.id);
        const created = {
          id: `msg-${nextId++}`,
          timestamp: nextId,
          metadata: {},
          ...message,
        };
        session.messages.push(created);
        return created;
      },
      updateMessage: (sessionId: string, messageId: string, updates: Record<string, unknown>) => {
        expect(sessionId).toBe(session.id);
        const index = session.messages.findIndex(m => m.id === messageId);
        if (index !== -1) {
          session.messages[index] = {
            ...session.messages[index],
            ...updates,
            metadata: {
              ...((session.messages[index].metadata as Record<string, unknown>) ?? {}),
              ...((updates.metadata as Record<string, unknown>) ?? {}),
            },
          };
        }
        return index !== -1;
      },
      updateSession: () => {},
      deleteMessage: () => true,
      replaceConversationMessages: () => {},
      getSubagentsByParentSession: () =>
        [] as Array<{
          toolCallId: string;
          parentSessionId: string;
          childSessionKey: string;
          label: string;
          status: 'running' | 'done' | 'error';
        }>,
    },
  };
}

test('getSessionKeysForSession prefers channel keys before managed fallback', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.rememberSessionKey(
    'session-1',
    'agent:main:openai-user:telegram:__default__:2459325231940374',
  );
  adapter.rememberSessionKey('session-1', 'agent:main:gucciai:session-1');

  expect(adapter.getSessionKeysForSession('session-1')).toEqual([
    'agent:main:openai-user:telegram:__default__:2459325231940374',
    'agent:main:gucciai:session-1',
  ]);
});

test('subagent lifecycle end updates status after parent turn is cleaned up', async () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  adapter.toolCallIdToParentSessionId.set('call-subagent', 'session-1');
  adapter.toolCallIdToSessionKey.set(
    'call-subagent',
    'agent:main:subagent:44e50e0e-5dbf-43fb-b6cf-5ab411675435',
  );
  adapter.subagentStatus.set('call-subagent', 'running');

  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'run-subagent',
      session: 'subagent:44e50e0e-5dbf-43fb-b6cf-5ab411675435',
      stream: 'lifecycle',
      data: { phase: 'end' },
    },
  });

  const statuses = await adapter.getSubagentStatuses('session-1');
  expect(statuses.statuses['agent:main:subagent:44e50e0e-5dbf-43fb-b6cf-5ab411675435']).toBe(
    'done',
  );
});

test('subagent status list restores persisted rows after app restart', async () => {
  const store = {
    getSession: (sessionId: string) =>
      sessionId === 'session-1'
        ? {
            id: 'session-1',
            title: 'Session',
            claudeSessionId: null,
            status: 'completed',
            pinned: false,
            cwd: '',
            executionMode: 'local',
            activeSkillIds: [],
            messages: [],
            createdAt: 1,
            updatedAt: 1,
          }
        : null,
    getAgent: () => null,
    getSubagentsByParentSession: (sessionId: string) =>
      sessionId === 'session-1'
        ? [
            {
              toolCallId: 'call-subagent',
              parentSessionId: 'session-1',
              childSessionKey: 'agent:main:subagent:child-1',
              label: 'research task',
              status: 'done' as const,
            },
          ]
        : [],
    addMessage: () => {
      throw new Error('not expected');
    },
    updateSession: () => {},
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
    updateMessage: () => {},
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});

  const statuses = await adapter.getSubagentStatuses('session-1');

  expect(statuses.subagents).toEqual([
    {
      id: 'agent:main:subagent:child-1',
      sessionKey: 'agent:main:subagent:child-1',
      label: 'research task',
      status: 'done',
    },
  ]);
});

test('subagent display label prefers explicit label before task preview', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  expect(
    adapter.getSubagentDisplayLabelFromToolInput({
      label: 'example-diagram-generator',
      task: '请阅读 skill 文件，然后根据该 skill 的说明，写一个完整的 diagram 示例',
    }),
  ).toBe('example-diagram-generator');
});

test('subagent display label falls back to the first 30 task characters', () => {
  const { store } = createEmptyStore();
  const adapter = new OpenClawRuntimeAdapter(store, {});

  expect(
    adapter.getSubagentDisplayLabelFromToolInput({
      task: '请阅读 skill 文件，然后根据该 skill 的说明，写一个完整的 diagram 示例',
    }),
  ).toBe('请阅读 skill 文件，然后根据该 skill 的说明，写...');
});

test('announce run events for the parent session render as main-session stream events', () => {
  const session = {
    id: 'session-1',
    title: 'Announce Session',
    claudeSessionId: null,
    status: 'running',
    pinned: false,
    cwd: '',
    executionMode: 'local',
    activeSkillIds: [],
    messages: [] as Array<Record<string, unknown>>,
    createdAt: 1,
    updatedAt: 1,
  };
  let nextId = 1;
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: (sessionId: string, message: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const created = {
        id: `msg-${nextId++}`,
        timestamp: nextId,
        metadata: {},
        ...message,
      };
      session.messages.push(created);
      return created;
    },
    updateMessage: (sessionId: string, messageId: string, updates: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      const index = session.messages.findIndex(m => m.id === messageId);
      if (index !== -1) {
        session.messages[index] = {
          ...session.messages[index],
          ...updates,
          metadata: {
            ...((session.messages[index].metadata as Record<string, unknown>) ?? {}),
            ...((updates.metadata as Record<string, unknown>) ?? {}),
          },
        };
      }
      return index !== -1;
    },
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
    getSubagentsByParentSession: () => [],
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const mainMessages: Array<Record<string, unknown>> = [];
  const subagentMessages: Array<Record<string, unknown>> = [];
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));
  adapter.on('subagentMessage', (_parentSessionId, _agentId, message) =>
    subagentMessages.push(message),
  );

  adapter.rememberSessionKey('session-1', 'agent:main:gucciai:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:gucciai:session-1', 'main-run');
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'thinking',
      data: { text: 'thinking snapshot' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'assistant',
      data: { text: 'I will inspect the file.' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-1',
        name: 'Bash',
        args: { command: 'pwd' },
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'tool',
      data: {
        phase: 'result',
        toolCallId: 'call-1',
        name: 'Bash',
        result: 'ok',
      },
    },
  });

  expect(subagentMessages).toHaveLength(0);
  expect(mainMessages.map(message => message.type)).toEqual([
    'assistant',
    'assistant',
    'tool_use',
    'tool_result',
  ]);
  expect(session.messages.map(message => message.type)).toEqual([
    'assistant',
    'assistant',
    'tool_use',
    'tool_result',
  ]);
});
