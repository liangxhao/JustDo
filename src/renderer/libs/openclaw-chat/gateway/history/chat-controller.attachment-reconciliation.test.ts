import type { CoworkAttachmentPayload } from '@shared/cowork/attachments';
import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { isLocallyOptimisticHistoryTail } from '@/libs/openclaw-chat/model/history/optimistic-history-tail';
import { mergePendingUserMessageForDisplay } from '@/libs/openclaw-chat/model/input/optimistic-user-message';
import { normalizeMessage } from '@/libs/openclaw-chat/pipeline/message-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

const sessionKey = 'agent:main:justdo:attachment-session';
const controllers: ChatController[] = [];

function createController(request = vi.fn().mockResolvedValue({})): ChatController {
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = sessionKey;
  return controller;
}

function image(name: string, base64Data: string): CoworkAttachmentPayload {
  return { name, mimeType: 'image/png', base64Data };
}

function userMessage(
  id: string,
  text: string,
  timestamp: number,
  inputKey: string,
  attachment?: CoworkAttachmentPayload,
): GatewayMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...(attachment ? [{
        type: 'attachment',
        attachment: {
          url: `data:${attachment.mimeType};base64,${attachment.base64Data}`,
          kind: 'image',
          label: attachment.name,
          mimeType: attachment.mimeType,
        },
      }] : []),
    ],
    timestamp,
    __openclaw: { id, seq: id === 'old-user' ? 1 : 2, idempotencyKey: inputKey },
  };
}

function attachmentUrls(message: unknown): string[] {
  return normalizeMessage(message).content.flatMap(block =>
    block.type === 'attachment' ? [block.attachment.url] : [],
  );
}

afterEach(() => {
  controllers.forEach(controller => controller.clearSending());
  controllers.length = 0;
  vi.unstubAllGlobals();
});

test('keeps an unbound pending attachment instead of overwriting equal-text history', async () => {
  const controller = createController();
  controller.setPendingUserMessage('Inspect this image', [image('new.png', 'bmV3')]);
  const pending = controller.state.pendingUserMessage as GatewayMessage;
  const oldMessage = userMessage(
    'old-user', 'Inspect this image', pending.timestamp! - 10, 'old-request:user', image('old.png', 'b2xk'),
  );
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ messages: [oldMessage] }),
  } as never;
  controller.state.chatSending = false;

  await controller.loadHistory();

  expect(controller.state.pendingUserMessage).toBe(pending);
  expect(attachmentUrls(controller.state.chatMessages[0])).toEqual(['data:image/png;base64,b2xk']);
  expect(mergePendingUserMessageForDisplay(controller.state.chatMessages as GatewayMessage[], pending))
    .toEqual([...controller.state.chatMessages, pending]);
});

test.each([false, true])(
  'uses the initial dispatch identity while native media is incomplete or transformed (media=%s)',
  async withNativeMedia => {
    const readFileAsDataUrl = vi.fn().mockResolvedValue({
      success: true,
      dataUrl: 'data:image/jpeg;base64,YWJj',
    });
    vi.stubGlobal('window', { electron: { dialog: { readFileAsDataUrl } } });
    const controller = createController();
    controller.setPendingUserMessage('Inspect this image', [image('prompt.png', 'YWJj')]);
    controller.beginInitialDispatch(sessionKey, 'initial-request');
    const pending = controller.state.pendingUserMessage as GatewayMessage;
    const nativeMessage = {
      role: 'user',
      content: 'Inspect this image',
      timestamp: pending.timestamp! + 10,
      __openclaw: { id: 'native-user', seq: 1, idempotencyKey: 'initial-request:user' },
      ...(withNativeMedia ? {
        MediaPaths: ['C:\\media\\normalized.jpg'],
        MediaTypes: ['image/jpeg'],
      } : {}),
    };
    expect(pending.__openclaw).toMatchObject({ idempotencyKey: 'initial-request:user' });
    expect(mergePendingUserMessageForDisplay([nativeMessage], pending)).toEqual([nativeMessage]);
    controller.state.client = {
      request: vi.fn().mockResolvedValue({ messages: [nativeMessage] }),
    } as never;
    controller.state.chatSending = false;

    await controller.loadHistory();
    await Promise.resolve();

    expect(controller.state.pendingUserMessage).toBeNull();
    expect(controller.state.chatMessages).toHaveLength(1);
    expect(attachmentUrls(controller.state.chatMessages[0])).toEqual(['data:image/png;base64,YWJj']);
    expect(readFileAsDataUrl).toHaveBeenCalledTimes(withNativeMedia ? 1 : 0);
  },
);

test.each([
  { text: 'Inspect this image', oldBytes: 'b2xk' },
  { text: 'Inspect this image', oldBytes: 'bmV3' },
  { text: '', oldBytes: 'b2xk' },
])('keeps distinct input identities with equal text, including reused files: %j', async ({ text, oldBytes }) => {
  const controller = createController();
  controller.setPendingUserMessage(text, [image('same-name.png', 'bmV3')]);
  controller.beginInitialDispatch(sessionKey, 'new-request');
  const pending = controller.state.pendingUserMessage as GatewayMessage;
  const oldMessage = userMessage(
    'old-user', text, pending.timestamp! - 10, 'old-request:user', image('same-name.png', oldBytes),
  );
  controller.state.client = {
    request: vi.fn().mockResolvedValue({ messages: [oldMessage] }),
  } as never;
  controller.state.chatSending = false;

  await controller.loadHistory();

  expect(controller.state.pendingUserMessage).toBe(pending);
  expect(attachmentUrls(controller.state.chatMessages[0])).toEqual([`data:image/png;base64,${oldBytes}`]);
  expect(mergePendingUserMessageForDisplay(controller.state.chatMessages as GatewayMessage[], pending))
    .toEqual([...controller.state.chatMessages, pending]);
});

test('preserves a subsequent optimistic attachment until its exact input appears in history', async () => {
  const text = 'Inspect this image';
  const oldMessage = userMessage('old-user', text, Date.now() - 10, 'old-request:user', image('old.png', 'b2xk'));
  let history: GatewayMessage[] = [oldMessage];
  const request = vi.fn().mockImplementation(async (method: string, params: { idempotencyKey?: string }) =>
    method === 'chat.send' ? { runId: params.idempotencyKey } : { messages: history },
  );
  const controller = createController(request);
  await controller.loadHistory();
  await controller.sendMessage(text, [image('new.png', 'bmV3')], undefined, { clientTurnId: 'new-request' });
  const optimistic = controller.state.chatMessages[1] as GatewayMessage;

  expect(optimistic.__openclaw).toMatchObject({ idempotencyKey: 'new-request:user' });
  expect(isLocallyOptimisticHistoryTail(optimistic)).toBe(true);
  // Suspended reconciliation reads history without declaring the run complete.
  await controller.loadHistory(false, { reconcileSuspended: true });
  expect(controller.state.chatMessages).toEqual([oldMessage, optimistic]);

  const durable = userMessage('new-user', text, optimistic.timestamp! + 10, 'new-request:user', image('new.png', 'bmV3'));
  history = [oldMessage, durable];
  await controller.loadHistory(false, { reconcileSuspended: true });

  expect(controller.state.chatMessages).toHaveLength(2);
  expect(controller.state.chatMessages[1]).toMatchObject({ __openclaw: { id: 'new-user' } });
  expect(controller.state.chatMessages.some(isLocallyOptimisticHistoryTail)).toBe(false);
});

test('keeps a document input key when the execution ACK assigns a different run', async () => {
  const document = { name: 'report.txt', mimeType: 'text/plain', base64Data: 'bmV3' };
  const request = vi.fn().mockResolvedValue({ runId: 'execution-run' });
  const controller = createController(request);
  await controller.sendMessage('Review the report', [document], undefined, { clientTurnId: 'document-input' });
  const optimistic = controller.state.chatMessages[0] as GatewayMessage;
  expect(controller.state.chatRunId).toBe('execution-run');
  expect(optimistic.__openclaw?.idempotencyKey).toBe('document-input:user');
  const durable = {
    role: 'user', content: 'Review the report\n\nExtracted native document context',
    __openclaw: { id: 'document-user', idempotencyKey: 'document-input:user' },
  };

  expect(mergePendingUserMessageForDisplay([durable], optimistic)).toEqual([durable]);
  expect(mergePendingUserMessageForDisplay([{
    ...durable, __openclaw: { id: 'other-document', idempotencyKey: 'other-input:user' },
  }], optimistic)).toHaveLength(2);
});

test('binds an initial attachment only within its selected dispatch session', () => {
  const controller = createController();
  controller.setPendingUserMessage('Inspect this image', [image('prompt.png', 'YWJj')]);
  expect(() => controller.beginInitialDispatch('agent:main:justdo:other-session', 'wrong-input'))
    .toThrow();
  expect(controller.state.pendingUserMessage?.__openclaw).toBeUndefined();

  controller.beginInitialDispatch(sessionKey, 'owned-input');
  expect(controller.state.pendingUserMessage?.__openclaw?.idempotencyKey).toBe('owned-input:user');
  expect(() => controller.beginInitialDispatch(sessionKey, 'other-input')).toThrow();
  expect(controller.state.pendingUserMessage?.__openclaw?.idempotencyKey).toBe('owned-input:user');
});
