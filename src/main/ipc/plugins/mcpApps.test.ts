import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpAppIpc, McpAppMethod, type NativeAppQuestion } from '../../../shared/plugins/mcpApps';

vi.mock('../../core/filesystem/taskWorkspace', () => ({
  resolveTaskWorkingDirectory: (cwd: string) => cwd,
}));
vi.mock('../../core/window/workspaceWindowManager', () => ({ getWorkspaceDialogOwner: vi.fn() }));

const { handlers, choose } = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>>(),
  choose: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      name: string,
      handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>,
    ) => handlers.set(name, handler),
  },
  dialog: { showOpenDialog: choose },
}));
import { registerMcpAppHandlers } from './mcpApps';

const frame = {};
const trusted = { senderFrame: frame, sender: { mainFrame: frame } } as IpcMainInvokeEvent;
const question = (): NativeAppQuestion => ({
  id: 'q-1',
  sessionKey: 'agent:a:session',
  agentId: 'a',
  status: 'pending',
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 60000,
  questions: [
    {
      questionId: 'answer',
      header: 'Answer',
      question: 'Choose',
      options: [],
      isSecret: true,
      secretStore: { name: 'API_KEY', kind: 'env', allowedHosts: ['api.example.com'] },
    },
  ],
});
function setup() {
  let allowMainAgentSwitch = true;
  const createSession = vi.fn(() => ({ id: 'created' }));
  let current = {
    id: 'session',
    agentId: 'a',
    nativeSessionKey: 'agent:a:session',
    cwd: '/workspace',
    external: undefined as { readOnly: boolean } | undefined,
    branchCreationPending: false,
  };
  let record = question();
  const request = vi.fn(async (method: string): Promise<unknown> =>
    method === 'question.get'
      ? { question: record }
      : method === 'question.list'
        ? { questions: [record, { ...record, id: 'foreign', sessionKey: 'other' }] }
        : {},
  );
  registerMcpAppHandlers({
    getCoworkStore: () =>
      ({
        getSession: (id: string) =>
          id === 'session'
            ? current
            : id === 'created' && createSession.mock.calls.length
              ? { id: 'created' }
              : undefined,
        getConfig: () => ({
          allowMainAgentSwitch,
          executionMode: 'local',
          permissionMode: 'workspace',
        }),
        getAgent: (id: string) =>
          ['main', 'a'].includes(id) ? { enabled: true, model: 'openai/fixture' } : undefined,
        createSession,
      }) as never,
    getCoworkEngineRouter: () =>
      ({
        prepareSession: async () => ({ sessionKey: 'agent:a:session', gatewaySessionId: 'native' }),
      }) as never,
    requestGateway: request as never,
  });
  const invoke = (channel: string, input: unknown, event = trusted) =>
    handlers.get(channel)!(event, input);
  return {
    request,
    setQuestion: (value: NativeAppQuestion) => {
      record = value;
    },
    createSession,
    disableSwitch: () => {
      allowMainAgentSwitch = false;
    },
    invoke,
    changeSession: () => {
      current = { ...current, nativeSessionKey: 'agent:a:replacement' };
    },
    readOnly: () => {
      current.external = { readOnly: true };
    },
    pendingBranch: () => {
      current.branchCreationPending = true;
    },
    expire: () => {
      record = { ...record, expiresAtMs: Date.now() - 1 };
    },
  };
}
beforeEach(() => {
  handlers.clear();
  choose.mockReset();
});

describe('native App question bridge', () => {
  it('rejects pending native branches before preparing or answering through the App bridge', async () => {
    const { invoke, request, pendingBranch } = setup();
    pendingBranch();
    for (const channel of [McpAppIpc.Prepare, McpAppIpc.Questions]) {
      expect(await invoke(channel, 'session')).toMatchObject({ success: false });
    }
    expect(
      await invoke(McpAppIpc.ResolveQuestion, {
        sessionId: 'session',
        id: 'q-1',
        answers: { answer: ['value'] },
      }),
    ).toMatchObject({ success: false });
    expect(request).not.toHaveBeenCalled();
  });
  it('returns only the native form preview reference and trusted option title', async () => {
    const { invoke, request, setQuestion } = setup();
    const record = question();
    record.questions[0].resource = { viewId: 'form-owner', selection: 'explicit' };
    record.questions[0].options = [{ label: 'Diagram preview', preview: { type: 'mcp_app_tool' } }];
    setQuestion(record);
    request.mockImplementation(async method =>
      method === 'question.get' ? { question: record } : { preview: { viewId: 'native-preview' } },
    );
    expect(
      await invoke(McpAppIpc.PreviewQuestion, {
        sessionId: 'session',
        id: 'q-1',
        questionId: 'answer',
        optionIndex: 0,
        viewId: 'forged',
      }),
    ).toEqual({
      success: true,
      value: { preview: { viewId: 'native-preview' }, title: 'Diagram preview' },
    });
    expect(request).toHaveBeenCalledWith(McpAppMethod.FormResource, {
      sessionKey: 'agent:a:session',
      agentId: 'a',
      viewId: 'form-owner',
      requestId: 'q-1',
      questionId: 'answer',
      action: 'preview',
      optionIndex: 0,
    });
    expect(request.mock.calls.some(([method]) => method === McpAppMethod.View)).toBe(false);
  });
  it('rejects a preview whose native question resolves during the request', async () => {
    const { invoke, request, setQuestion } = setup();
    const record = question();
    record.questions[0].resource = { viewId: 'form-owner', selection: 'explicit' };
    record.questions[0].options = [{ label: 'Diagram preview', preview: { type: 'mcp_app_tool' } }];
    setQuestion(record);
    request.mockImplementation(async method => {
      if (method === 'question.get') return { question: record };
      record.status = 'answered';
      return { preview: { viewId: 'native-preview' } };
    });
    expect(
      await invoke(McpAppIpc.PreviewQuestion, {
        sessionId: 'session',
        id: 'q-1',
        questionId: 'answer',
        optionIndex: 0,
      }),
    ).toMatchObject({ success: false });
  });
  it('rejects sandbox download IPC before inspecting file data or opening a dialog', async () => {
    const { invoke } = setup();
    expect(
      await invoke(McpAppIpc.DownloadFile, {}, {
        ...trusted,
        senderFrame: {},
      } as IpcMainInvokeEvent),
    ).toEqual({ success: false, error: 'Untrusted application frame' });
  });
  it('creates one empty product conversation per exact home request without launching Gateway', async () => {
    const { invoke, request, createSession, disableSwitch } = setup();
    const input = { requestId: 'open-1', agentId: 'a', cwd: '/workspace', title: 'Apps' };
    expect(await invoke(McpAppIpc.CreateSession, input)).toEqual({
      success: true,
      value: { sessionId: 'created' },
    });
    expect(await invoke(McpAppIpc.CreateSession, input)).toMatchObject({ success: true });
    expect(createSession).toHaveBeenCalledOnce();
    expect(await invoke(McpAppIpc.CreateSession, { ...input, title: 'Changed' })).toMatchObject({
      success: false,
    });
    disableSwitch();
    expect(await invoke(McpAppIpc.CreateSession, { ...input, requestId: 'open-2' })).toMatchObject({
      success: false,
    });
    expect(
      await invoke(McpAppIpc.CreateSession, { ...input, requestId: 'open-2', agentId: 'main' }),
    ).toMatchObject({ success: true });
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects iframe senders and read-only product sessions before accessing Gateway', async () => {
    const { request, invoke, readOnly } = setup();
    expect(
      await invoke(McpAppIpc.Questions, 'session', {
        ...trusted,
        senderFrame: {},
      } as IpcMainInvokeEvent),
    ).toMatchObject({ success: false });
    readOnly();
    expect(await invoke(McpAppIpc.Questions, 'session')).toMatchObject({ success: false });
    expect(request).not.toHaveBeenCalled();
  });
  it('lists only current native questions for the exact session', async () => {
    const { invoke } = setup();
    expect(await invoke(McpAppIpc.Questions, 'session')).toMatchObject({
      success: true,
      value: [{ id: 'q-1' }],
    });
  });
  it('submits answers and only the native secret host policy without retaining a copy', async () => {
    const { invoke, request } = setup();
    expect(
      await invoke(McpAppIpc.ResolveQuestion, {
        sessionId: 'session',
        id: 'q-1',
        answers: { answer: ['value'] },
        secretStoreAllowedHosts: ['forged.com'],
      }),
    ).toMatchObject({ success: true });
    expect(request).toHaveBeenLastCalledWith('question.resolve', {
      id: 'q-1',
      answers: { answers: { answer: ['value'] } },
      secretStoreAllowedHosts: ['api.example.com'],
    });
  });
  it('rejects unknown fields, expired requests and changed native incarnations', async () => {
    const { invoke, request, expire, changeSession } = setup();
    expect(
      await invoke(McpAppIpc.ResolveQuestion, {
        sessionId: 'session',
        id: 'q-1',
        answers: { invented: ['value'] },
      }),
    ).toMatchObject({ success: false });
    expire();
    expect(
      await invoke(McpAppIpc.ResolveQuestion, { sessionId: 'session', id: 'q-1', cancel: true }),
    ).toMatchObject({ success: false });
    changeSession();
    expect(
      await invoke(McpAppIpc.ResolveQuestion, { sessionId: 'session', id: 'q-1', cancel: true }),
    ).toMatchObject({ success: false });
    expect(request.mock.calls.every(([method]) => method === 'question.get')).toBe(true);
  });
});
