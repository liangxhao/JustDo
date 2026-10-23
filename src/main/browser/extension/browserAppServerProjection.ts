import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { BrowserExtensionMessage, BrowserExtensionThread } from './browserAppServerTypes';

type AppServerThreadStatus =
  { type: 'active'; activeFlags: string[] } | { type: 'idle' | 'systemError' };

type AppServerTurn = {
  id: string;
  status: 'completed';
  items: Array<Record<string, unknown>>;
  error: { message: string } | null;
  itemsView: 'full';
  startedAt: null;
  completedAt: null;
  durationMs: null;
};

const toAppServerStatus = (status: string): AppServerThreadStatus => {
  if (status === 'running') return { type: 'active', activeFlags: [] };
  if (status === 'error') return { type: 'systemError' };
  return { type: 'idle' };
};

const toAppServerTurns = (
  threadId: string,
  messages: BrowserExtensionMessage[],
): AppServerTurn[] => {
  const turns: AppServerTurn[] = [];
  let items: Array<Record<string, unknown>> = [];
  let itemOrdinal = 0;
  const nextItemId = () => `${threadId}-item-${++itemOrdinal}`;
  const flush = () => {
    if (!items.length) return;
    turns.push({
      error: null,
      completedAt: null,
      durationMs: null,
      id: `${threadId}-history-${turns.length + 1}`,
      items,
      itemsView: 'full',
      startedAt: null,
      status: 'completed',
    });
    items = [];
  };
  messages.forEach(message => {
    if (message.display?.kind === 'phase-boundary') {
      items.push({ id: nextItemId(), type: 'phaseBoundary', text: '', display: message.display });
      return;
    }
    if (message.role === 'user' && items.length) flush();
    if (message.role === 'user') {
      items.push({
        content: [{ text: message.text, type: 'text' }],
        ...(message.rawMessage ? { rawMessage: message.rawMessage } : {}),
        ...(message.pendingInput ? { pendingInput: message.pendingInput } : {}),
        id: nextItemId(),
        type: 'userMessage',
      });
      return;
    }
    if (message.role === 'assistant') {
      if (message.thinking) {
        items.push({
          content: [message.thinking],
          id: nextItemId(),
          summary: [],
          type: 'reasoning',
          ...(message.display ? { display: message.display } : {}),
        });
      }
      if (message.text || message.rawMessage) {
        items.push({
          ...(message.rawMessage ? { rawMessage: message.rawMessage } : {}),
          id: nextItemId(),
          phase: 'final_answer',
          text: message.text,
          type: 'agentMessage',
          ...(message.display ? { display: message.display } : {}),
        });
      }
      return;
    }
    if (message.role === 'tool_use') {
      items.push({
        id: nextItemId(),
        input: message.toolInput ?? message.text,
        isError: false,
        output: null,
        status: 'inProgress',
        toolName: message.toolName ?? 'tool',
        toolUseId: message.toolUseId ?? null,
        type: 'toolCall',
        ...(message.display?.keepVisible ? { display: { keepVisible: true } } : {}),
      });
      return;
    }
    if (message.role === 'tool_result') {
      const matchingTool = [...items]
        .reverse()
        .find(
          item =>
            item.type === 'toolCall' && message.toolUseId && item.toolUseId === message.toolUseId,
        );
      if (matchingTool) {
        matchingTool.output = message.text;
        matchingTool.isError = message.isError === true;
        matchingTool.status = message.isError === true ? 'failed' : 'completed';
        if (message.display?.keepVisible) matchingTool.display = { keepVisible: true };
      } else {
        items.push({
          id: nextItemId(),
          input: message.toolInput ?? null,
          isError: message.isError === true,
          output: message.text,
          status: message.isError === true ? 'failed' : 'completed',
          toolName: message.toolName ?? 'tool',
          toolUseId: message.toolUseId ?? null,
          type: 'toolCall',
          ...(message.display?.keepVisible ? { display: { keepVisible: true } } : {}),
        });
      }
      return;
    }
    if (message.text || message.display?.kind || message.rawMessage) {
      items.push({
        id: nextItemId(),
        text: message.text,
        type: 'systemMessage',
        ...(message.rawMessage ? { rawMessage: message.rawMessage } : {}),
        ...(message.display ? { display: message.display } : {}),
      });
    }
  });
  flush();
  return turns;
};

export const toAppServerThread = (
  thread: BrowserExtensionThread,
  messages?: BrowserExtensionMessage[],
): Record<string, unknown> => ({
  agentNickname: null,
  agentRole: null,
  canAcceptDirectInput: true,
  cliVersion: PRODUCT_NAME,
  createdAt: Math.floor(thread.createdAt / 1000),
  cwd: thread.cwd,
  daybreakEnabled: null,
  ephemeral: false,
  environments: null,
  extra: null,
  forkedFromId: null,
  gitInfo: null,
  historyMode: 'legacy',
  id: thread.id,
  isPinned: false,
  model: thread.modelRef ?? null,
  modelProvider: thread.modelRef?.split('/')[0] || 'justdo',
  permissionMode: thread.permissionMode,
  name: thread.title,
  originator: 'justdo-chrome-extension',
  parentThreadId: null,
  path: null,
  preview: thread.title,
  projectId: null,
  reasoningEffort: null,
  recencyAt: Math.floor(thread.updatedAt / 1000),
  section: null,
  sectionEnteredAt: null,
  sessionId: thread.id,
  source: 'appServer',
  status: toAppServerStatus(thread.status),
  threadSource: 'user',
  turns: messages ? toAppServerTurns(thread.id, messages) : [],
  updatedAt: Math.floor(thread.updatedAt / 1000),
});
