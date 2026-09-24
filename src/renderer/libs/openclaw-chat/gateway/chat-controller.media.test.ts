import { composeBrowserGatewayPrompt } from '@shared/browser/browser';
import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test.each(['second image', ''])('sends and renders image attachments with text %j', async text => {
  const request = vi.fn().mockResolvedValue({ runId: 'run-1' });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.sendMessage(text, [
    {
      name: 'second.png',
      mimeType: 'image/png',
      base64Data: 'YWJj',
    },
  ]);

  expect(request).toHaveBeenCalledWith('chat.send', {
    sessionKey: 'agent:main:justdo:session-1',
    message: text,
    deliver: false,
    justdoUserInitiated: true,
    idempotencyKey: expect.stringMatching(/^justdo-/),
    attachments: [
      {
        type: 'image',
        mimeType: 'image/png',
        content: 'YWJj',
        fileName: 'second.png',
      },
    ],
  });
  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'user',
      content: [
        { type: 'text', text },
        {
          type: 'attachment',
          attachment: {
            url: 'data:image/png;base64,YWJj',
            kind: 'image',
            label: 'second.png',
            mimeType: 'image/png',
          },
        },
      ],
    }),
  ]);
});

test.each(['Update this control.', ''])(
  'renders browser metadata with text %j without exposing context',
  async text => {
    const request = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const controller = new ChatController();
    controller.state.client = { request } as never;
    controller.state.connected = true;
    controller.state.sessionKey = 'agent:main:justdo:session-1';
    const gatewayMessage = composeBrowserGatewayPrompt(text, [
      {
        id: 'annotation-1',
        modelContext: 'Untrusted element details for the model',
        title: 'Settings',
        displayUrl: 'example.com',
        markedRegionCount: 0,
        inspectedElement: true,
        display: {
          id: 'annotation-1',
          title: 'Settings',
          displayUrl: 'example.com',
          markedRegionCount: 0,
          element: {
            tag: 'button',
            id: 'save',
            classes: ['primary'],
            role: 'button',
            name: 'Save changes',
            cssPath: 'main > button#save',
            rect: { x: 10, y: 20, width: 100, height: 40 },
          },
        },
        dataUrl: 'data:image/png;base64,YWJj',
        fileName: 'browser-annotation.png',
        addedAt: 1,
      },
    ]);

    await controller.sendMessage(text, [], gatewayMessage);

    expect(request).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({ message: gatewayMessage }),
    );
    expect(controller.state.chatMessages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [
          { type: 'text', text },
          {
            type: 'browser_annotation',
            annotation: expect.objectContaining({
              id: 'annotation-1',
              element: expect.objectContaining({ tag: 'button', id: 'save' }),
            }),
          },
        ],
      }),
    ]);
    expect(JSON.stringify(controller.state.chatMessages)).not.toContain(
      'Untrusted element details for the model',
    );
  },
);

test('renders browser element metadata in a pending first-session message', () => {
  const controller = new ChatController();
  const gatewayMessage = composeBrowserGatewayPrompt('Update this control.', [
    {
      id: 'annotation-1',
      modelContext: 'Hidden model context',
      title: 'Settings',
      displayUrl: 'example.com',
      markedRegionCount: 0,
      inspectedElement: true,
      display: {
        id: 'annotation-1',
        title: 'Settings',
        displayUrl: 'example.com',
        markedRegionCount: 0,
        element: {
          tag: 'button',
          id: 'save',
          classes: [],
          role: 'button',
          name: 'Save changes',
          cssPath: 'button#save',
          rect: { x: 10, y: 20, width: 100, height: 40 },
        },
      },
      dataUrl: 'data:image/png;base64,YWJj',
      fileName: 'browser-annotation.png',
      addedAt: 1,
    },
  ]);

  controller.setPendingUserMessage('Update this control.', [], gatewayMessage);

  expect(controller.state.pendingUserMessage).toEqual(
    expect.objectContaining({
      content: [
        { type: 'text', text: 'Update this control.' },
        {
          type: 'browser_annotation',
          annotation: expect.objectContaining({
            element: expect.objectContaining({ tag: 'button', id: 'save' }),
          }),
        },
      ],
    }),
  );
});

test('dedupes optimistic attachment bytes after managed image MIME normalization', async () => {
  const readFileAsDataUrl = vi.fn().mockResolvedValue({
    success: true,
    dataUrl: 'data:image/jpeg;base64,YWJj',
  });
  vi.stubGlobal('window', {
    electron: {
      dialog: {
        readFileAsDataUrl,
      },
    },
  });
  const request = vi.fn().mockResolvedValue({
    messages: [
      {
        role: 'user',
        content: 'image prompt',
        timestamp: Date.now(),
        MediaPaths: ['C:\\media\\prompt.png'],
        MediaTypes: ['image/png'],
      },
    ],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.setPendingUserMessage('image prompt', [
    {
      name: 'prompt.png',
      mimeType: 'image/png',
      base64Data: 'YWJj',
    },
  ]);
  controller.state.chatSending = false;

  await controller.loadHistory();
  await Promise.resolve();

  expect(controller.state.chatMessages).toEqual([
    expect.objectContaining({
      role: 'user',
      content: [
        { type: 'text', text: 'image prompt' },
        {
          type: 'attachment',
          attachment: {
            url: 'data:image/png;base64,YWJj',
            kind: 'image',
            label: 'prompt.png',
            mimeType: 'image/png',
          },
        },
      ],
    }),
  ]);
  expect((controller.state.chatMessages[0] as { content: unknown[] }).content).toHaveLength(2);
  expect(readFileAsDataUrl).toHaveBeenCalledTimes(1);
});

test('hydrates canonical managed inbound images from a full history refresh', async () => {
  const readAssistantMediaDataUrl = vi.fn().mockResolvedValue({
    success: true,
    dataUrl: 'data:image/png;base64,YWJj',
    mimeType: 'image/png',
  });
  vi.stubGlobal('window', {
    electron: { openclaw: { engine: { readAssistantMediaDataUrl } } },
  });
  const request = vi.fn().mockResolvedValue({
    messages: [
      {
        role: 'user',
        content: 'image prompt',
        timestamp: 1000,
        __openclaw: {
          media: [
            {
              path: 'media://inbound/photo---managed-id.png',
              contentType: 'image/png',
              kind: 'image',
              fileName: 'photo.png',
            },
          ],
        },
      },
    ],
  });
  const controller = new ChatController();
  controller.state.client = { request } as never;
  controller.state.connected = true;
  controller.state.sessionKey = 'agent:main:justdo:session-1';

  await controller.loadHistory();

  await vi.waitFor(() => {
    expect(readAssistantMediaDataUrl).toHaveBeenCalledWith({
      source: 'media://inbound/photo---managed-id.png',
      sessionKey: 'agent:main:justdo:session-1',
    });
    expect(controller.state.chatMessages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: [
          { type: 'text', text: 'image prompt' },
          {
            type: 'image',
            url: 'data:image/png;base64,YWJj',
            alt: 'photo.png',
            mimeType: 'image/png',
          },
        ],
      }),
    ]);
  });
});

test('hydrates the canonical image when the first session message replaces the optimistic row', async () => {
  let finishMediaRead!: (value: { success: true; dataUrl: string; mimeType: string }) => void;
  const readAssistantMediaDataUrl = vi.fn().mockReturnValue(
    new Promise(resolve => {
      finishMediaRead = resolve;
    }),
  );
  vi.stubGlobal('window', {
    electron: { openclaw: { engine: { readAssistantMediaDataUrl } } },
  });
  const controller = new ChatController();
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatRunId = 'run-1';
  controller.state.chatSending = true;
  Object.assign(controller, {
    expectInitialHistory: true,
    expectInitialUserMessage: true,
  });
  controller.setPendingUserMessage('first image', [
    { name: 'first.png', mimeType: 'image/png', base64Data: 'YWJj' },
  ]);
  controller.state.chatRunId = 'run-1';

  (
    controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    }
  ).handleEvent({
    event: 'session.message',
    payload: {
      sessionKey: 'agent:main:justdo:session-1',
      runId: 'run-1',
      hasActiveRun: true,
      messageSeq: 1,
      message: {
        role: 'user',
        content: 'first image',
        __openclaw: {
          id: 'user-1',
          seq: 1,
          runId: 'run-1',
          idempotencyKey: 'run-1:user',
          media: [
            {
              path: 'media://inbound/first---managed-id.png',
              contentType: 'image/png',
              kind: 'image',
            },
          ],
        },
      },
    },
  });

  expect(controller.state.chatMessages[0]).toMatchObject({
    content: [
      { type: 'text', text: 'first image' },
      {
        type: 'attachment',
        attachment: { kind: 'image', url: 'data:image/png;base64,YWJj' },
      },
    ],
  });
  finishMediaRead({
    success: true,
    dataUrl: 'data:image/png;base64,YWJj',
    mimeType: 'image/png',
  });

  await vi.waitFor(() => {
    expect(readAssistantMediaDataUrl).toHaveBeenCalledWith({
      source: 'media://inbound/first---managed-id.png',
      sessionKey: 'agent:main:justdo:session-1',
    });
    expect(controller.state.chatMessages[0]).toMatchObject({
      content: [
        { type: 'text', text: 'first image' },
        {
          type: 'attachment',
          attachment: { kind: 'image', url: 'data:image/png;base64,YWJj' },
        },
      ],
    });
  });
});

test('does not apply a completed image hydration after switching sessions', async () => {
  let finishMediaRead!: (value: { success: true; dataUrl: string; mimeType: string }) => void;
  const readAssistantMediaDataUrl = vi.fn().mockReturnValue(
    new Promise(resolve => {
      finishMediaRead = resolve;
    }),
  );
  vi.stubGlobal('window', {
    electron: { openclaw: { engine: { readAssistantMediaDataUrl } } },
  });
  const controller = new ChatController();
  const firstSessionMessages = [
    {
      role: 'user',
      content: 'first session image',
      __openclaw: {
        media: [
          {
            url: 'media://inbound/first-session.png',
            contentType: 'image/png',
            kind: 'image',
          },
        ],
      },
    },
  ];
  controller.state.sessionKey = 'agent:main:justdo:session-1';
  controller.state.chatMessages = firstSessionMessages;

  (
    controller as unknown as {
      hydrateCurrentSessionImages(messages: unknown[], sessionKey: string): void;
    }
  ).hydrateCurrentSessionImages(firstSessionMessages, 'agent:main:justdo:session-1');

  const secondSessionMessages = [{ role: 'assistant', content: 'second session' }];
  controller.state.sessionKey = 'agent:main:justdo:session-2';
  controller.state.chatMessages = secondSessionMessages;
  finishMediaRead({
    success: true,
    dataUrl: 'data:image/png;base64,YWJj',
    mimeType: 'image/png',
  });
  await Promise.resolve();
  await Promise.resolve();

  expect(controller.state.chatMessages).toBe(secondSessionMessages);
  expect(controller.state.chatMessages).toEqual([{ role: 'assistant', content: 'second session' }]);
});

test('hydrates OpenClaw transcript MediaPaths as image blocks', async () => {
  const readFileAsDataUrl = vi.fn().mockResolvedValue({
    success: true,
    dataUrl: 'data:image/png;base64,YWJj',
  });
  vi.stubGlobal('window', {
    electron: {
      dialog: {
        readFileAsDataUrl,
      },
    },
  });
  const controller = new ChatController();
  const resolved = await (
    controller as unknown as {
      resolveManagedHistoryImages(messages: unknown[]): Promise<unknown[]>;
    }
  ).resolveManagedHistoryImages([
    {
      role: 'user',
      content: '[User sent media without caption]',
      MediaPaths: ['C:\\media\\saved.png'],
      MediaTypes: ['image/png'],
    },
  ]);

  expect(resolved[0]).toMatchObject({
    content: [
      { type: 'text', text: '[User sent media without caption]' },
      {
        type: 'image',
        url: 'data:image/png;base64,YWJj',
        alt: 'saved.png',
        mimeType: 'image/png',
      },
    ],
  });

  await (
    controller as unknown as {
      resolveManagedHistoryImages(messages: unknown[]): Promise<unknown[]>;
    }
  ).resolveManagedHistoryImages([
    {
      role: 'user',
      content: 'same image',
      MediaPaths: ['C:\\media\\saved.png'],
      MediaTypes: ['image/png'],
    },
  ]);
  expect(readFileAsDataUrl).toHaveBeenCalledTimes(1);
});
