// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import ChatMessageDisplay from '@/features/cowork/components/chat/ChatMessageDisplay';
import { useWidgetReferenceTabs } from '@/features/cowork/components/display/tabs/useWidgetReferenceTabs';

import { ChatController } from '../../gateway/chat-controller';
import type { JustDoChatElement } from '../justdo-chat';
import type { NativeWidgetContext } from './host';
import { getNativeWidgetPresentations } from './presentations';
import { NativeWidgetView } from './view';

afterEach(async () => {
  cleanup();
  await new Promise(resolve => setTimeout(resolve, 10));
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('settles React and Lit renders while refreshing widget callbacks and publishing availability changes', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const manager = getNativeWidgetPresentations();
  vi.spyOn(manager, 'requestLayout').mockImplementation(() => undefined);
  vi.spyOn(NativeWidgetView.prototype, 'canPin', 'get').mockReturnValue(true);
  const notified = vi.fn();
  const stop = manager.subscribe(notified);
  const client = {
    generation: 1,
    gatewayUrl: 'ws://127.0.0.1:18789',
    request: vi.fn().mockResolvedValue({
      html: '<!doctype html><p>Interactive chart</p>',
      sandboxPort: 18790,
      sandboxUrl: '/mcp-app-sandbox',
    }),
    stop: vi.fn(),
  };
  const controller = new ChatController();
  Object.assign(controller.state, {
    connected: true,
    client,
    sessionKey: 'agent:main:reactivity',
    currentSessionId: 'reactivity-incarnation',
    initialHistoryReady: true,
    chatMessages: [
      {
        role: 'toolResult',
        toolName: 'show_widget',
        toolCallId: 'reactivity-call',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              kind: 'canvas',
              presentation: { target: 'assistant_message', sandbox: 'scripts', title: 'Chart' },
              view: { id: 'reactivity-widget' },
            }),
          },
        ],
      },
    ],
  });
  controller.state.visibleChatMessages = controller.state.chatMessages;
  let chat: JustDoChatElement | null = null;
  let draftAllowed = true;
  let renders = 0;
  const renderLimit = 12;
  const capture = (): NativeWidgetContext | undefined =>
    controller.state.connected
      ? {
          client,
          generation: client.generation,
          sessionKey: controller.state.sessionKey,
          sessionId: controller.state.currentSessionId ?? undefined,
          presentationScope: 'reactivity',
          isCurrent: () => controller.state.connected,
          canDraft: () => draftAllowed,
        }
      : undefined;
  const changeChat = (element: JustDoChatElement | null) => {
    chat = element;
    if (element) element.captureWidgetContext = capture;
  };
  function Workbench({ revision = 0 }: { revision?: number }) {
    renders++;
    const references = useWidgetReferenceTabs(
      'reactivity',
      () => undefined,
      () => undefined,
      ['reactivity'],
    );
    return (
      <div data-revision={revision}>
        {/* Stop a regression's feedback loop so the failure remains bounded. */}
        {renders < renderLimit && (
          <ChatMessageDisplay controller={controller} onChatElementChange={changeChat} />
        )}
        <output data-testid="tabs">{references.tabs.length}</output>
      </div>
    );
  }
  const result = render(<Workbench />);
  try {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(renders).toBeLessThan(renderLimit);
    expect(chat).not.toBeNull();
    expect(manager.entries).toHaveLength(1);
    const entry = manager.entries[0];
    const originalView = entry.view;
    const previousContext = entry.view.context;
    notified.mockClear();
    const before = renders;

    draftAllowed = false;
    result.rerender(<Workbench revision={1} />);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(renders).toBe(before + 1);
    expect(notified).not.toHaveBeenCalled();
    expect(entry.view).toBe(originalView);
    expect(entry.view.context).not.toBe(previousContext);
    expect(entry.view.context?.canDraft()).toBe(false);
    expect(client.request).toHaveBeenCalledOnce();

    act(() => manager.pin(entry));
    expect(screen.getByTestId('tabs').textContent).toBe('1');
    notified.mockClear();
    controller.state.connected = false;
    await act(async () => {
      chat!.requestUpdate();
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    expect(entry.view.context).toBeUndefined();
    expect(notified).toHaveBeenCalledOnce();
    expect(renders).toBeLessThan(renderLimit);
  } finally {
    stop();
    result.unmount();
    await waitFor(() => expect(manager.entries).toHaveLength(0));
  }
});
