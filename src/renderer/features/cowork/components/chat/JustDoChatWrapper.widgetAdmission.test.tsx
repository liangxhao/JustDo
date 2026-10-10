// @vitest-environment jsdom
import '@/libs/openclaw-chat/components/justdo-chat';

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JustDoChatElement } from '@/libs/openclaw-chat/components/justdo-chat';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import JustDoChatWrapper from './JustDoChatWrapper';

const fixture = vi.hoisted(() => ({ chat: null as JustDoChatElement | null }));
vi.mock('react-redux', () => ({
  useSelector: () => ({ id: 'widget-admission', agentId: 'main' }),
}));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('./ChatMessageDisplay', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    default: function TestChatMessageDisplay({
      controller,
      onChatElementChange,
    }: {
      controller: ChatController | null;
      onChatElementChange: (element: JustDoChatElement | null) => void;
    }) {
      const container = useRef<HTMLDivElement>(null);
      useEffect(() => {
        const chat = document.createElement('justdo-chat') as JustDoChatElement;
        fixture.chat = chat;
        container.current!.append(chat);
        onChatElementChange(chat);
        return () => {
          onChatElementChange(null);
          chat.controller = null;
          chat.remove();
        };
      }, [onChatElementChange]);
      useEffect(() => {
        if (fixture.chat) fixture.chat.controller = controller;
      }, [controller]);
      return <div ref={container} />;
    },
  };
});

beforeEach(() => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      openclaw: {
        engine: {
          getPort: vi.fn().mockResolvedValue({ success: true, port: 1 }),
          getToken: vi.fn().mockResolvedValue({ success: true, token: 'fixture' }),
        },
      },
    },
  });
});
afterEach(() => {
  cleanup();
  fixture.chat = null;
  vi.restoreAllMocks();
});

function connection() {
  return vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.initialHistoryReady = true;
    this.state.client = {
      generation: 1,
      stop: vi.fn(),
      request: vi.fn().mockResolvedValue(undefined),
    } as unknown as NonNullable<ChatController['state']['client']>;
  });
}

describe('widget product draft admission', () => {
  it('defaults to a read-only widget consumer and immediately installs live admission at first ref registration', async () => {
    const connect = connection();
    const screen = render(<JustDoChatWrapper />);
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const chat = fixture.chat!;
    expect(chat.canDraftWidget?.()).toBe(false);
    const captured = (
      chat as unknown as { widgetContext: () => { canDraft: () => boolean } }
    ).widgetContext();
    expect(captured.canDraft()).toBe(false);
    screen.rerender(<JustDoChatWrapper onWidgetDraft={vi.fn()} />);
    expect(captured.canDraft()).toBe(true);
    screen.rerender(<JustDoChatWrapper />);
    expect(captured.canDraft()).toBe(false);
    screen.rerender(<JustDoChatWrapper onWidgetDraft={vi.fn()} />);
    expect(captured.canDraft()).toBe(true);
    expect(fixture.chat).toBe(chat);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('installs a writable consumer when the element first mounts and revokes it on unmount', async () => {
    connection();
    const screen = render(<JustDoChatWrapper onWidgetDraft={vi.fn()} />);
    await waitFor(() => expect(fixture.chat?.canDraftWidget?.()).toBe(true));
    const chat = fixture.chat!;
    screen.unmount();
    expect(chat.canDraftWidget).toBeUndefined();
  });
});
