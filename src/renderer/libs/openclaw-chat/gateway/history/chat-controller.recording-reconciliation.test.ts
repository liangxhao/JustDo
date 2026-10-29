import { type BrowserAnnotationDraft, composeBrowserGatewayPrompt } from '@shared/browser/browser';
import type { BrowserRecordingDraft } from '@shared/browser/browserRecording';
import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { mergePendingUserMessageForDisplay } from '@/libs/openclaw-chat/model/input/optimistic-user-message';
import { projectGatewayHistoryForDisplay } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';
import { normalizeMessage } from '@/libs/openclaw-chat/pipeline/message-normalizer';
import type { GatewayMessage } from '@/libs/openclaw-chat/types';

const controllers: ChatController[] = [];

function createController(): ChatController {
  const controller = new ChatController();
  controllers.push(controller);
  return controller;
}

afterEach(() => {
  controllers.forEach(controller => controller.clearSending());
  controllers.length = 0;
});

function bindInitialInput(controller: ChatController, inputId: string): void {
  controller.state.client = { request: vi.fn() } as never;
  controller.state.connected = true;
  controller.beginInitialDispatch(controller.state.sessionKey, inputId);
}

function recording(stepId = 'step'): BrowserRecordingDraft {
  return {
    id: 'recording',
    sessionId: 'session',
    profile: 'embedded',
    title: 'Example flow',
    note: '',
    startedAt: 1,
    steps: [
      {
        id: stepId,
        action: 'click',
        pageId: 'tab',
        at: 0,
        url: 'https://example.com/',
        title: 'Example',
      },
    ],
    images: [],
  };
}

function annotation(id = 'annotation'): BrowserAnnotationDraft {
  return {
    id,
    modelContext: 'Untrusted page details',
    title: 'Example',
    displayUrl: 'example.com',
    markedRegionCount: 1,
    inspectedElement: false,
    addedAt: 1,
    dataUrl: 'data:image/png;base64,YWJj',
    fileName: 'annotation.png',
  };
}

test.each([
  { text: 'Replay this flow', screenshot: true },
  { text: '', screenshot: false },
])('reconciles the pending recording with history: %j', async ({ text, screenshot }) => {
  const draft = recording();
  if (screenshot) {
    draft.images = [
      { stepId: 'step', fileName: 'step.jpg', dataUrl: 'data:image/jpeg;base64,YWJj' },
    ];
  }
  const prompt = composeBrowserGatewayPrompt(text, [], draft);
  const controller = createController();
  controller.state.sessionKey = 'agent:main:justdo:session';
  controller.setPendingUserMessage(
    text,
    screenshot ? [{ name: 'step.jpg', mimeType: 'image/jpeg', base64Data: 'YWJj' }] : [],
    prompt,
  );
  bindInitialInput(controller, 'recording-input');
  const pending = controller.state.pendingUserMessage as GatewayMessage;
  expect(pending.text).toBe(text);
  expect(Array.isArray(pending.content)).toBe(true);
  const nativeMessage = {
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    timestamp: pending.timestamp! + 10,
    __openclaw: { id: 'user-message', seq: 1, idempotencyKey: 'recording-input:user' },
  };
  const history = projectGatewayHistoryForDisplay([nativeMessage]) as GatewayMessage[];

  // The same merge is used while the durable row and optimistic prompt coexist.
  expect(mergePendingUserMessageForDisplay(history, pending)).toEqual(history);

  controller.state.client = {
    request: vi.fn().mockResolvedValue({ messages: [nativeMessage] }),
  } as never;
  controller.state.connected = true;
  controller.state.chatSending = false;
  await controller.loadHistory();

  expect(controller.state.pendingUserMessage).toBeNull();
  expect(controller.state.chatMessages).toHaveLength(1);
  const content = normalizeMessage(controller.state.chatMessages[0]).content;
  expect(content.filter(block => block.type === 'browser_recording')).toHaveLength(1);
  expect(content.filter(block => block.type === 'attachment')).toHaveLength(screenshot ? 1 : 0);
});

test('keeps a different recording with the same prompt visible', () => {
  const text = 'Replay this flow';
  const controller = createController();
  controller.setPendingUserMessage(
    text,
    [],
    composeBrowserGatewayPrompt(text, [], recording('new-step')),
  );
  const pending = controller.state.pendingUserMessage as GatewayMessage;
  const history = projectGatewayHistoryForDisplay([
    {
      role: 'user',
      content: composeBrowserGatewayPrompt(text, [], recording('old-step')),
      timestamp: pending.timestamp! - 10,
    },
  ]) as GatewayMessage[];

  expect(mergePendingUserMessageForDisplay(history, pending)).toEqual([...history, pending]);
});

test.each([
  { text: 'Inspect this page', screenshot: true },
  { text: '', screenshot: false },
])('reconciles the same browser annotation: %j', ({ text, screenshot }) => {
  const prompt = composeBrowserGatewayPrompt(text, [annotation()]);
  const controller = createController();
  controller.setPendingUserMessage(
    text,
    screenshot ? [{ name: 'annotation.png', mimeType: 'image/png', base64Data: 'YWJj' }] : [],
    prompt,
  );
  bindInitialInput(controller, 'annotation-input');
  const pending = controller.state.pendingUserMessage as GatewayMessage;
  const history = projectGatewayHistoryForDisplay([
    {
      role: 'user', content: prompt, timestamp: pending.timestamp! + 10,
      __openclaw: { idempotencyKey: 'annotation-input:user' },
    },
  ]) as GatewayMessage[];

  expect(mergePendingUserMessageForDisplay(history, pending)).toEqual(history);
});

test.each([
  { text: 'Inspect this page', oldAnnotation: 'old-annotation' },
  { text: '', oldAnnotation: 'old-annotation' },
  { text: '', oldAnnotation: null },
])(
  'preserves a pending annotation across unrelated history takeover: %j',
  async ({ text, oldAnnotation }) => {
    const controller = createController();
    controller.state.sessionKey = 'agent:main:justdo:session';
    controller.setPendingUserMessage(
      text,
      [{ name: 'annotation.png', mimeType: 'image/png', base64Data: 'YWJj' }],
      composeBrowserGatewayPrompt(text, [annotation('new-annotation')]),
    );
    const pending = controller.state.pendingUserMessage as GatewayMessage;
    const nativeMessage = {
      role: 'user',
      content: composeBrowserGatewayPrompt(text, oldAnnotation ? [annotation(oldAnnotation)] : []),
      timestamp: pending.timestamp! - 10,
      __openclaw: { id: 'old-user-message', seq: 1 },
    };
    const history = projectGatewayHistoryForDisplay([nativeMessage]) as GatewayMessage[];

    expect(mergePendingUserMessageForDisplay(history, pending)).toEqual([...history, pending]);

    controller.state.client = {
      request: vi.fn().mockResolvedValue({ messages: [nativeMessage] }),
    } as never;
    controller.state.connected = true;
    controller.state.chatSending = false;
    await controller.loadHistory();

    expect(controller.state.pendingUserMessage).toBe(pending);
    const annotations = normalizeMessage(controller.state.chatMessages[0]).content.filter(
      block => block.type === 'browser_annotation',
    );
    expect(annotations).toEqual(oldAnnotation ? [
      { type: 'browser_annotation', annotation: expect.objectContaining({ id: oldAnnotation }) },
    ] : []);
  },
);

test('reconciles annotation, recording, quote and ordinary attachment together', async () => {
  const text = 'Replay this flow\n\n> Quoted request';
  const prompt = composeBrowserGatewayPrompt(text, [annotation()], recording());
  const controller = createController();
  controller.state.sessionKey = 'agent:main:justdo:session';
  controller.setPendingUserMessage(
    text,
    [
      { name: 'annotation.png', mimeType: 'image/png', base64Data: 'YWJj' },
      { name: 'reference.png', mimeType: 'image/png', base64Data: 'ZGVm' },
    ],
    prompt,
  );
  bindInitialInput(controller, 'mixed-input');
  const pending = controller.state.pendingUserMessage as GatewayMessage;
  const nativeMessage = {
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    timestamp: pending.timestamp! + 10,
    __openclaw: { id: 'mixed-user-message', seq: 1, idempotencyKey: 'mixed-input:user' },
  };
  const history = projectGatewayHistoryForDisplay([nativeMessage]) as GatewayMessage[];
  expect(mergePendingUserMessageForDisplay(history, pending)).toEqual(history);

  controller.state.client = {
    request: vi.fn().mockResolvedValue({ messages: [nativeMessage] }),
  } as never;
  controller.state.connected = true;
  controller.state.chatSending = false;
  await controller.loadHistory();

  expect(controller.state.pendingUserMessage).toBeNull();
  expect(controller.state.chatMessages).toHaveLength(1);
  const content = normalizeMessage(controller.state.chatMessages[0]).content;
  expect(content.filter(block => block.type === 'browser_annotation')).toHaveLength(1);
  expect(content.filter(block => block.type === 'browser_recording')).toHaveLength(1);
  expect(content.filter(block => block.type === 'attachment')).toHaveLength(2);
  expect(content).toContainEqual({ type: 'text', text });

  const otherHistory = projectGatewayHistoryForDisplay([
    {
      ...nativeMessage,
      content: composeBrowserGatewayPrompt(text, [annotation('different-annotation')], recording()),
      timestamp: pending.timestamp! - 10,
      __openclaw: { id: 'other-message', seq: 2, idempotencyKey: 'other-input:user' },
    },
  ]) as GatewayMessage[];
  expect(mergePendingUserMessageForDisplay(otherHistory, pending)).toEqual([...otherHistory, pending]);
});
