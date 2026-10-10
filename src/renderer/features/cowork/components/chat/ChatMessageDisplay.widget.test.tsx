// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { NATIVE_WIDGET_OWNER_MESSENGER } from '@/libs/openclaw-chat/components/native-widget/messaging';
import type { NativeWidgetView } from '@/libs/openclaw-chat/components/native-widget/view';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import ChatMessageDisplay from './ChatMessageDisplay';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('renders native widget history in a workspace chat through its own sandbox handshake', async () => {
  const workspace = document.createElement('iframe');
  workspace.src = new URL('/workspace.html', window.location.href).href;
  document.body.append(workspace);
  workspace.contentDocument!.write('<!doctype html><html><body></body></html>');
  workspace.contentDocument!.close();
  const doc = workspace.contentDocument!;
  const owner = workspace.contentWindow!;
  Object.defineProperty(owner, NATIVE_WIDGET_OWNER_MESSENGER, {
    value: (frame: HTMLIFrameElement, data: unknown, origin: string) => {
      frame.contentWindow!.postMessage(data, origin);
      return true;
    },
  });
  const descriptor = {
    kind: 'canvas',
    presentation: { target: 'assistant_message', sandbox: 'scripts' },
    view: { id: 'cv_workspace' },
  };
  const client = {
    generation: 1,
    gatewayUrl: 'ws://127.0.0.1:18789',
    request: vi.fn().mockResolvedValue({
      html: '<!doctype html><p>Native workspace content</p>',
      sandboxPort: 18790,
      sandboxUrl: '/mcp-app-sandbox',
    }),
    stop: vi.fn(),
  };
  const controller = new ChatController();
  Object.assign(controller.state, {
    connected: true,
    client,
    sessionKey: 'agent:main:workspace',
    initialHistoryReady: true,
    chatMessages: [
      {
        role: 'toolResult',
        toolName: 'show_widget',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: JSON.stringify(descriptor) }],
      },
    ],
  });
  controller.state.visibleChatMessages = controller.state.chatMessages;
  const root = doc.createElement('div');
  doc.body.append(root);
  render(<ChatMessageDisplay controller={controller} fullWidth />, { container: root });
  const chat = root.querySelector('justdo-chat')!;
  await act(async () => {
    await (chat as unknown as { updateComplete: Promise<boolean> }).updateComplete;
  });
  const widget = chat.shadowRoot!.querySelector('justdo-native-widget') as NativeWidgetView;
  expect(widget.ownerDocument).toBe(doc);
  await act(async () => {
    await widget.updateComplete;
    await Promise.resolve();
    await widget.updateComplete;
  });
  const frame = widget.shadowRoot!.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const ready = {
    method: 'ui/notifications/sandbox-proxy-ready',
    params: { sandboxUrl: frame.src },
  };
  const send = (target: Window, data: unknown) =>
    target.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: new URL(frame.src).origin,
        source: frame.contentWindow,
      }),
    );
  send(window, ready);
  expect(post).not.toHaveBeenCalled();
  send(owner, ready);
  const resource = post.mock.calls[0][0] as { params: { renderId: string } };
  expect(resource).toMatchObject({
    method: 'ui/notifications/sandbox-resource-ready',
    params: { html: '<!doctype html><p>Native workspace content</p>' },
  });
  await act(async () => {
    send(owner, {
      method: 'ui/notifications/sandbox-resource-loaded',
      params: { renderId: resource.params.renderId },
    });
    await widget.updateComplete;
  });
  expect(widget.shadowRoot!.querySelector('[role="status"]')).toBeNull();
  expect(widget.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
  expect(post).toHaveBeenCalledWith(
    { type: 'openclaw:scenario-draft-policy', available: false },
    new URL(frame.src).origin,
  );
  expect(client.request).toHaveBeenCalledOnce();
  expect(client.request).toHaveBeenCalledWith('canvas.document.view', { docId: 'cv_workspace' });
});
