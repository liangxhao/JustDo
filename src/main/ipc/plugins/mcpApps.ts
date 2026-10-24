import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { MAIN_USER_AGENT_ID } from '../../../shared/agents/agents';
import {
  McpAppIpc,
  McpAppMethod,
  mcpAppRecord,
  type NativeAppQuestion,
} from '../../../shared/plugins/mcpApps';
import { resolvePermissionMode } from '../../../shared/security/approvals';
import { resolveTaskWorkingDirectory } from '../../core/filesystem/taskWorkspace';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine/cowork/coworkEngineRouter';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';
import { saveMcpAppDownload } from '../../plugins/mcp/mcpAppDownload';
import { readQuestionUploadFiles } from '../../plugins/mcp/questionUpload';
import { WorkspaceAppSessions } from '../../plugins/mcp/workspaceAppSession';

interface Dependencies {
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  requestGateway?: <T>(method: string, params?: unknown) => Promise<T>;
  workspaceAppSessions?: WorkspaceAppSessions;
}
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048;

export function registerMcpAppHandlers(deps: Dependencies): void {
  const created = new Map<string, { signature: string; sessionId: string }>();
  const session = (id: unknown) => {
    if (!text(id)) throw new Error('Invalid application session');
    const current = deps.getCoworkStore().getSession(id);
    if (!current || current.external?.readOnly || current.branchCreationPending)
      throw new Error('Application session is unavailable or read-only');
    return current;
  };
  const request = <T>(method: string, params?: unknown): Promise<T> => {
    if (!deps.requestGateway) throw new Error('Gateway is unavailable');
    return deps.requestGateway<T>(method, params);
  };
  const workspaces =
    deps.workspaceAppSessions ??
    new WorkspaceAppSessions({
      getStore: deps.getCoworkStore, request,
      // A generic RPC port cannot establish native transport correlation.
      // Production supplies Main's shared workspace owner with that evidence.
      captureResponseContext: async () => null,
    });
  const target = (id: unknown) => {
    const current = session(id);
    const sessionKey =
      current.nativeSessionKey ||
      current.external?.sessionKey ||
      buildManagedSessionKey(current.id, current.agentId);
    return { current, sessionKey, agentId: current.agentId };
  };
  const pending = async (sessionId: unknown, id: unknown) => {
    if (!text(id)) throw new Error('Invalid native question');
    const owner = target(sessionId);
    const response = await request<{ question: NativeAppQuestion }>('question.get', { id });
    const question = response.question;
    const latest = target(sessionId);
    if (
      !question ||
      question.sessionKey !== owner.sessionKey ||
      latest.sessionKey !== owner.sessionKey ||
      latest.agentId !== owner.agentId ||
      (question.agentId && question.agentId !== owner.agentId) ||
      question.status !== 'pending' ||
      question.expiresAtMs <= Date.now()
    ) {
      throw new Error('Native question is no longer current');
    }
    return { ...owner, question };
  };
  const handle = (
    channel: string,
    action: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>,
  ) => {
    ipcMain.handle(channel, async (event, input: unknown) => {
      try {
        if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)
          throw new Error('Untrusted application frame');
        return { success: true, value: await action(event, input) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'App operation failed',
        };
      }
    });
  };
  handle(McpAppIpc.DownloadFile, saveMcpAppDownload);
  handle(McpAppIpc.PrepareWorkspace, (event, input) => workspaces.prepare(event.sender, input));
  handle(McpAppIpc.ReleaseWorkspace, (event, input) => workspaces.release(event.sender, input));
  handle(McpAppIpc.CreateSession, async (_event, raw) => {
    const input = mcpAppRecord(raw);
    if (
      !text(input?.requestId) ||
      !text(input?.agentId) ||
      !text(input?.cwd) ||
      !text(input?.title) ||
      input.title.length > 200
    )
      throw new Error('Invalid App conversation');
    const store = deps.getCoworkStore();
    const config = store.getConfig();
    const agent = store.getAgent(input.agentId);
    if (
      !agent ||
      !agent.enabled ||
      agent.deletedAt ||
      (input.agentId !== MAIN_USER_AGENT_ID && config.allowMainAgentSwitch !== true)
    )
      throw new Error('App assistant is unavailable');
    const signature = JSON.stringify([input.agentId, input.cwd, input.title]);
    const previous = created.get(input.requestId);
    if (previous) {
      if (previous.signature !== signature || !store.getSession(previous.sessionId))
        throw new Error('App conversation request changed');
      return { sessionId: previous.sessionId };
    }
    const cwd = resolveTaskWorkingDirectory(input.cwd);
    const session = store.createSession(
      input.title,
      cwd,
      config.executionMode || 'local',
      [],
      input.agentId,
      resolvePermissionMode(config.permissionMode),
      input.agentId === MAIN_USER_AGENT_ID ? undefined : agent.model.trim() || undefined,
    );
    created.set(input.requestId, { signature, sessionId: session.id });
    if (created.size > 256) created.delete(created.keys().next().value!);
    return { sessionId: session.id };
  });
  handle(McpAppIpc.Prepare, async (_event, id) => {
    const current = session(id);
    const result = await deps.getCoworkEngineRouter().prepareSession(current.id);
    const latest = session(current.id);
    if (latest.agentId !== current.agentId || latest.cwd !== current.cwd)
      throw new Error('Application session changed');
    return result;
  });
  handle(McpAppIpc.Questions, async (_event, id) => {
    const owner = target(id);
    const result = await request<{ questions: NativeAppQuestion[] }>('question.list', {});
    if (target(id).sessionKey !== owner.sessionKey) throw new Error('Application session changed');
    return (Array.isArray(result.questions) ? result.questions : []).filter(
      question =>
        question.sessionKey === owner.sessionKey &&
        (!question.agentId || question.agentId === owner.agentId) &&
        question.status === 'pending' &&
        question.expiresAtMs > Date.now(),
    );
  });
  handle(McpAppIpc.ResolveQuestion, async (_event, raw) => {
    const input = mcpAppRecord(raw);
    const { question } = await pending(input?.sessionId, input?.id);
    if (input?.cancel === true)
      return request('question.resolve', { id: question.id, cancel: true });
    const answers = mcpAppRecord(input?.answers);
    if (
      !answers ||
      Object.keys(answers).some(id => !question.questions.some(item => item.questionId === id)) ||
      Object.values(answers).some(
        value =>
          !Array.isArray(value) ||
          value.length > 64 ||
          value.some(item => typeof item !== 'string' || item.length > 4096),
      )
    )
      throw new Error('Invalid native question answers');
    const secret = question.questions.find(item => item.secretStore)?.secretStore;
    return request('question.resolve', {
      id: question.id,
      answers: { answers },
      ...(secret ? { secretStoreAllowedHosts: secret.allowedHosts ?? [] } : {}),
    });
  });
  const resourceOwner = async (raw: unknown) => {
    const input = mcpAppRecord(raw);
    const owner = await pending(input?.sessionId, input?.id);
    const question = owner.question.questions.find(item => item.questionId === input?.questionId);
    if (!question?.resource?.viewId) throw new Error('Question has no native resource authority');
    return {
      input,
      owner,
      question,
      params: {
        sessionKey: owner.sessionKey,
        agentId: owner.agentId,
        viewId: question.resource.viewId,
        requestId: owner.question.id,
        questionId: question.questionId,
      },
    };
  };
  handle(McpAppIpc.PreviewQuestion, async (_event, raw) => {
    const { input, question, params } = await resourceOwner(raw);
    const optionIndex = input?.optionIndex;
    if (
      !Number.isInteger(optionIndex) ||
      Number(optionIndex) < 0 ||
      !question.options[Number(optionIndex)]?.preview
    ) {
      throw new Error('Invalid resource preview');
    }
    const result = await request<unknown>(McpAppMethod.FormResource, {
      ...params,
      action: 'preview',
      optionIndex,
    });
    const preview = mcpAppRecord(mcpAppRecord(result)?.preview);
    await pending(input?.sessionId, input?.id);
    if (text(preview?.viewId)) {
      return {
        preview: { viewId: preview.viewId },
        title: (question.options[Number(optionIndex)].label || question.header).slice(0, 200),
      };
    }
    return result;
  });
  handle(McpAppIpc.UploadQuestion, async (_event, raw) => {
    const { input, question, params } = await resourceOwner(raw);
    const kind = question.resource?.userOptions?.kind;
    if (!kind) throw new Error('Question does not accept user-selected files');
    const selection = await dialog.showOpenDialog({
      properties: [
        kind === 'directory' ? 'openDirectory' : 'openFile',
        ...(kind === 'file' ? ['multiSelections' as const] : []),
      ],
    });
    if (selection.canceled) return { resources: [] };
    await pending(input?.sessionId, input?.id);
    const files = await readQuestionUploadFiles(selection.filePaths);
    await pending(input?.sessionId, input?.id);
    return request(McpAppMethod.FormResource, { ...params, action: 'upload', files });
  });
}
