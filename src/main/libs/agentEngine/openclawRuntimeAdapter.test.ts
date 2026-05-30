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

test('gateway subagent status updates both tool call and session key aliases', async () => {
  const store = {
    getSession: (sessionId: string) =>
      sessionId === 'session-1'
        ? {
            id: 'session-1',
            title: 'Session',
            claudeSessionId: null,
            status: 'running',
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
              status: 'running' as const,
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
    updateSubagentStatusByIdentifier: vi.fn(),
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.listSubagentsFromGateway = async () => [
    {
      id: 'agent:main:subagent:child-1',
      sessionKey: 'agent:main:subagent:child-1',
      label: 'research task',
      status: 'done' as const,
    },
  ];

  const statuses = await adapter.getSubagentStatuses('session-1');

  expect(statuses.statuses['call-subagent']).toBe('done');
  expect(statuses.statuses['agent:main:subagent:child-1']).toBe('done');
  expect(statuses.sessionKeys['call-subagent']).toBe('agent:main:subagent:child-1');
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

test('announce run events follow webchat chat-final and tool-stream split', () => {
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
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:gucciai:session-1',
      state: 'delta',
      message: {
        role: 'assistant',
        content: 'I will inspect the file.',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'assistant',
      data: { text: 'I will inspect the file and then report back.' },
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
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:gucciai:session-1',
      state: 'final',
      message: {
        role: 'assistant',
        content: 'I will inspect the file and then report back.',
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
  expect(session.messages[1].content).toBe('I will inspect the file and then report back.');
});

test('announce item and command_output events render tool messages', () => {
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
    updateMessage: () => true,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
    getSubagentsByParentSession: () => [],
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const mainMessages: Array<Record<string, unknown>> = [];
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));

  adapter.rememberSessionKey('session-1', 'agent:main:gucciai:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:gucciai:session-1', 'main-run');
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'item',
      data: {
        itemId: 'command:call-1',
        phase: 'start',
        kind: 'command',
        title: 'exec command',
        status: 'running',
        name: 'exec',
        toolCallId: 'call-1',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'command_output',
      data: {
        itemId: 'command:call-1',
        phase: 'end',
        title: 'exec command',
        toolCallId: 'call-1',
        name: 'exec',
        output: 'ok',
        status: 'completed',
      },
    },
  });

  expect(mainMessages.map(message => message.type)).toEqual(['tool_use', 'tool_result']);
  expect(session.messages.map(message => message.type)).toEqual(['tool_use', 'tool_result']);
  expect(session.messages[1].content).toBe('ok');
});

test('announce events after parent turn cleanup do not render assistant deltas', () => {
  const session = {
    id: 'session-1',
    title: 'Announce Session',
    claudeSessionId: null,
    status: 'idle',
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
    updateMessage: () => true,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
    getSubagentsByParentSession: () => [],
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const mainMessages: Array<Record<string, unknown>> = [];
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));

  adapter.rememberSessionKey('session-1', 'agent:main:gucciai:session-1');
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'assistant',
      data: { text: '已汇总两个子agent的祝福语并写入Excel： | 序号 |' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'assistant',
      data: {
        text: '已汇总两个子agent的祝福语并写入Excel： | 序号 | 祝福语 | |:---:|---|',
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
        phase: 'start',
        toolCallId: 'call-1',
        name: 'exec',
        args: { command: 'write xlsx' },
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
        name: 'exec',
        result: 'ok',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId: 'announce:v1:agent:main:subagent:child-run',
      sessionKey: 'agent:main:gucciai:session-1',
      stream: 'lifecycle',
      data: { phase: 'end' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:gucciai:session-1',
      state: 'final',
      message: {
        role: 'assistant',
        content:
          '已汇总两个子agent的祝福语并写入Excel：\n\n| 序号 | 祝福语 |\n|:---:|---|\n| 1 | 愿你今天的每一份努力都化作明天的惊喜。 |\n| 2 | 愿你今天的每一分努力都有回响。 |\n\n文件已保存到：`blessings.xlsx`',
      },
    },
  });

  expect(mainMessages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
    'assistant',
  ]);
  expect(session.messages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
    'assistant',
  ]);
  expect(session.messages[3].content).toContain('文件已保存到');
});

test('detached announce final does not append composite assistant snapshot', () => {
  const session = {
    id: 'session-1',
    title: 'Announce Session',
    claudeSessionId: null,
    status: 'idle',
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
  adapter.on('message', (_sessionId, message) => mainMessages.push(message));

  const sessionKey = 'agent:main:gucciai:session-1';
  const runId = 'announce:v1:agent:main:subagent:child-run';
  const beforeTool = '两个祝福语都收到了！现在汇总写入 Excel。';
  const afterTool = '✅ **完成！** 两个 subagent 的祝福语已汇总写入 Excel';

  adapter.rememberSessionKey('session-1', sessionKey);
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: beforeTool },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'tool',
      data: {
        phase: 'start',
        toolCallId: 'call-1',
        name: 'exec',
        args: { command: 'write xlsx' },
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'tool',
      data: {
        phase: 'result',
        toolCallId: 'call-1',
        name: 'exec',
        result: 'ok',
      },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'assistant',
      data: { text: afterTool },
    },
  });
  adapter.handleGatewayEvent({
    event: 'agent',
    payload: {
      runId,
      sessionKey,
      stream: 'lifecycle',
      data: { phase: 'end' },
    },
  });
  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      runId,
      sessionKey,
      state: 'final',
      message: {
        role: 'assistant',
        content: `${beforeTool}${afterTool}`,
      },
    },
  });

  expect(mainMessages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
    'assistant',
  ]);
  expect(session.messages.map(message => message.type)).toEqual([
    'assistant',
    'tool_use',
    'tool_result',
    'assistant',
  ]);
  expect(session.messages[0].content).toBe(beforeTool);
  expect(session.messages[3].content).toBe(afterTool);
});

test('chat delta without run id is ignored while a turn is active', () => {
  const session = {
    id: 'session-1',
    title: 'Session',
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
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: (sessionId: string, message: Record<string, unknown>) => {
      expect(sessionId).toBe(session.id);
      session.messages.push(message);
      return { id: `msg-${session.messages.length}`, timestamp: Date.now(), ...message };
    },
    updateMessage: () => true,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
    getSubagentsByParentSession: () => [],
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  adapter.rememberSessionKey('session-1', 'agent:main:gucciai:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:gucciai:session-1', 'main-run');

  adapter.handleGatewayEvent({
    event: 'chat',
    payload: {
      sessionKey: 'agent:main:gucciai:session-1',
      state: 'delta',
      message: { role: 'assistant', content: 'unowned partial' },
    },
  });

  expect(session.messages).toHaveLength(0);
});

test('session.message reload is deferred until sessions.changed clears active run', () => {
  const session = {
    id: 'session-1',
    title: 'Session',
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
  const store = {
    getSession: (sessionId: string) => (sessionId === session.id ? session : null),
    getAgent: () => null,
    addMessage: () => {
      throw new Error('not expected');
    },
    updateMessage: () => true,
    updateSession: (_sessionId: string, updates: Record<string, unknown>) => {
      Object.assign(session, updates);
    },
    deleteMessage: () => true,
    replaceConversationMessages: () => {},
    getSubagentsByParentSession: () => [],
  };
  const adapter = new OpenClawRuntimeAdapter(store, {});
  const reconcileWithHistory = vi.fn().mockResolvedValue(undefined);
  (
    adapter as unknown as {
      historyReconciler: { reconcileWithHistory: typeof reconcileWithHistory };
    }
  ).historyReconciler = { reconcileWithHistory };
  adapter.rememberSessionKey('session-1', 'agent:main:gucciai:session-1');
  adapter.ensureActiveTurn('session-1', 'agent:main:gucciai:session-1', 'main-run');

  adapter.handleGatewayEvent({
    event: 'session.message',
    payload: { sessionKey: 'agent:main:gucciai:session-1' },
  });
  expect(reconcileWithHistory).not.toHaveBeenCalled();

  adapter.handleGatewayEvent({
    event: 'sessions.changed',
    payload: {
      sessionKey: 'agent:main:gucciai:session-1',
      key: 'agent:main:gucciai:session-1',
      status: 'idle',
      hasActiveRun: false,
    },
  });

  expect(reconcileWithHistory).toHaveBeenCalledWith(
    'session-1',
    'agent:main:gucciai:session-1',
  );
  expect(session.status).toBe('idle');
});
