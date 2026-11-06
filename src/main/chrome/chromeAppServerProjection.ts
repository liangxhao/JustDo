import type { AppServerThreadMetadata } from '../appServer/appServerTypes';
import { codexThread } from '../appServer/appServerWire';
import type { ChromeExtensionMessage, ChromeExtensionThread, ChromeExtensionTurnState } from './chromeAppServerTypes';

type ChromeDisplayTurn = {
  id: string;
  items: Array<Record<string, unknown>>;
};

export const toChromeDisplay = (
  threadId: string,
  messages: ChromeExtensionMessage[],
): { id: string; turns: ChromeDisplayTurn[] } => {
  const turns: ChromeDisplayTurn[] = [];
  let items: Array<Record<string, unknown>> = [];
  let itemOrdinal = 0;
  const nextItemId = () => `${threadId}-item-${++itemOrdinal}`;
  const flush = () => {
    if (!items.length) return;
    turns.push({
      id: `${threadId}-history-${turns.length + 1}`,
      items,
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
          phase: message.rawMessage?.phase === 'final_answer' || message.rawMessage?.phase === 'commentary'
            ? message.rawMessage.phase : null,
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
        if (message.questionResult) matchingTool.questionResult = message.questionResult;
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
          ...(message.questionResult ? { questionResult: message.questionResult } : {}),
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
  return { id: threadId, turns };
};

export const toAppServerMetadata = (thread: ChromeExtensionThread): AppServerThreadMetadata => ({
  id: thread.id, cwd: thread.cwd, name: thread.title, status: thread.status,
  createdAt: thread.createdAt, updatedAt: thread.updatedAt,
  permissionMode: thread.permissionMode, source: 'appServer',
  ...(thread.modelRef ? { modelRef: thread.modelRef } : {}),
});

export const toAppServerThread = (
  thread: ChromeExtensionThread,
  messages?: ChromeExtensionMessage[],
  activeTurn: ChromeExtensionTurnState | null = null,
  loaded = true,
): Record<string, unknown> => ({
  ...codexThread(toAppServerMetadata(thread), loaded),
  chrome: {
    ...(messages ? { display: toChromeDisplay(thread.id, messages) } : {}),
    activeTurn,
  },
});
