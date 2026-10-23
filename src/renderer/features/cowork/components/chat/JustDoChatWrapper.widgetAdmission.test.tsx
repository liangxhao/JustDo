// @vitest-environment jsdom
import '@/libs/openclaw-chat/components/justdo-chat';

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JustDoChatElement } from '@/libs/openclaw-chat/components/justdo-chat';
import { NativeWidgetAnchor } from '@/libs/openclaw-chat/components/native-widget/anchor';
import type { NativeWidgetContext } from '@/libs/openclaw-chat/components/native-widget/host';
import { getNativeWidgetPresentations } from '@/libs/openclaw-chat/components/native-widget/presentations';
import { NativeWidgetView } from '@/libs/openclaw-chat/components/native-widget/view';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { decodeNativeCanvasResult } from '@/libs/openclaw-chat/pipeline/native-canvas';

import JustDoChatWrapper from './JustDoChatWrapper';

const fixture = vi.hoisted(() => ({
  chat: null as JustDoChatElement | null,
  session: { id: 'widget-admission', agentId: 'main' } as {
    id: string;
    agentId: string;
    nativeSessionKey?: string;
  },
}));
vi.mock('react-redux', () => ({
  useSelector: () => fixture.session,
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
      const currentController = useRef(controller);
      currentController.current = controller;
      useEffect(() => {
        const chat = document.createElement('justdo-chat') as JustDoChatElement;
        chat.controller = currentController.current;
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
  fixture.session = { id: 'widget-admission', agentId: 'main' };
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      mcpApps: {
        questions: vi.fn().mockResolvedValue({ success: true, value: [] }),
        onQuestionsChanged: vi.fn(() => () => undefined),
      },
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

function widgetContext(chat = fixture.chat!): NativeWidgetContext {
  return (chat as unknown as { widgetContext: () => NativeWidgetContext }).widgetContext();
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

  it('routes a confirmed sidebar suggestion through its captured product and native identity', async () => {
    const connect = connection();
    const onDraft = vi.fn();
    const screen = render(<JustDoChatWrapper onWidgetDraft={onDraft} />);
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const context = widgetContext();

    expect(context.presentationScope).toBe('widget-admission');
    expect(context.presentationOwner).toBe(fixture.chat);
    expect(await context.addDraft?.('Confirmed selection')).toBe(true);
    expect(onDraft).toHaveBeenCalledExactlyOnceWith(context.sessionKey, 'Confirmed selection');
    for (const text of ['', '   ', '/execute', '!run', 'x'.repeat(4001)])
      expect(await context.addDraft?.(text)).toBe(false);
    expect(onDraft).toHaveBeenCalledOnce();

    screen.unmount();
    expect(await context.addDraft?.('Unmounted selection')).toBe(false);
    expect(onDraft).toHaveBeenCalledOnce();
  });

  it.each(['generation', 'client', 'sessionId', 'connection'] as const)(
    'rejects a confirmed sidebar suggestion after its native %s changes',
    async change => {
      const connect = connection();
      const onDraft = vi.fn();
      render(<JustDoChatWrapper onWidgetDraft={onDraft} />);
      await waitFor(() => expect(connect).toHaveBeenCalledOnce());
      const context = widgetContext();
      const state = fixture.chat!.controller!.state;
      if (change === 'generation') Object.assign(state.client!, { generation: 2 });
      if (change === 'client') state.client = Object.create(state.client!);
      if (change === 'sessionId') state.currentSessionId = 'replacement-incarnation';
      if (change === 'connection') state.connected = false;

      expect(await context.addDraft?.('Stale selection')).toBe(false);
      expect(onDraft).not.toHaveBeenCalled();
    },
  );

  it('rejects an old sidebar suggestion when another product uses the same native session', async () => {
    fixture.session.nativeSessionKey = 'agent:main:shared-native';
    const connect = connection();
    const onDraft = vi.fn();
    const screen = render(<JustDoChatWrapper onWidgetDraft={onDraft} />);
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const old = widgetContext();
    fixture.session = {
      id: 'widget-next',
      agentId: 'main',
      nativeSessionKey: old.sessionKey,
    };
    screen.rerender(<JustDoChatWrapper onWidgetDraft={onDraft} />);

    expect(await old.addDraft?.('Old selection')).toBe(false);
    const current = widgetContext();
    expect(await current.addDraft?.('Current selection')).toBe(true);
    expect(onDraft).toHaveBeenCalledExactlyOnceWith(current.sessionKey, 'Current selection');
  });
});

describe('widget product presentation retention', () => {
  it('restores one pinned tab after the real chat owner remounts across product sessions', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const manager = getNativeWidgetPresentations();
    vi.spyOn(manager, 'requestLayout').mockImplementation(() => undefined);
    vi.spyOn(NativeWidgetView.prototype, 'canPin', 'get').mockImplementation(function (
      this: NativeWidgetView,
    ) {
      return this.context?.isCurrent() === true;
    });
    const release = manager.retainWorkspace();
    fixture.session.nativeSessionKey = 'agent:main:shared-native';
    const firstSession = fixture.session;
    const connect = connection();
    const screen = render(<JustDoChatWrapper onWidgetDraft={vi.fn()} />);
    try {
      await waitFor(() => expect(connect).toHaveBeenCalledOnce());
      const firstChat = fixture.chat!;
      firstChat.controller!.state.currentSessionId = 'widget-incarnation';
      await firstChat.updateComplete;
      const preview = decodeNativeCanvasResult(
        JSON.stringify({
          kind: 'canvas',
          presentation: { target: 'assistant_message', sandbox: 'scripts', title: 'Pinned chart' },
          view: { id: 'widget-retained' },
        }),
        'show_widget',
        'retained-call',
      )!;
      const attach = (chat: JustDoChatElement) => {
        const anchor = new NativeWidgetAnchor();
        anchor.preview = preview;
        chat.shadowRoot!.append(anchor);
        return { anchor, entry: manager.acquire(anchor, preview, widgetContext(chat))! };
      };
      const first = attach(firstChat);
      await first.anchor.updateComplete;
      manager.pin(first.entry);
      expect(first.entry.pinned).toBe(true);
      const retainedId = first.entry.id;
      const firstContext = widgetContext(firstChat);

      fixture.session = {
        id: 'widget-next',
        agentId: 'main',
        nativeSessionKey: firstContext.sessionKey,
      };
      screen.rerender(<JustDoChatWrapper onWidgetDraft={vi.fn()} />);
      const nextChat = fixture.chat!;
      expect(nextChat).not.toBe(firstChat);
      expect(firstChat.isConnected).toBe(false);
      await nextChat.updateComplete;
      const next = attach(nextChat);
      await next.anchor.updateComplete;
      expect(next.entry).not.toBe(first.entry);
      expect(next.entry.scope).toBe('widget-next');
      expect(next.entry.pinned).toBe(false);
      expect(first.entry.pinned).toBe(true);
      expect(firstContext.isCurrent()).toBe(false);

      fixture.session = firstSession;
      screen.rerender(<JustDoChatWrapper onWidgetDraft={vi.fn()} />);
      const restoredChat = fixture.chat!;
      expect(restoredChat).not.toBe(firstChat);
      expect(restoredChat).not.toBe(nextChat);
      await restoredChat.updateComplete;
      const restoredContext = widgetContext(restoredChat);
      expect(restoredContext.client).toBe(firstContext.client);
      expect(restoredContext.generation).toBe(firstContext.generation);
      expect(restoredContext.sessionKey).toBe(firstContext.sessionKey);
      expect(restoredContext.sessionId).toBe('widget-incarnation');
      const restored = attach(restoredChat);
      await restored.anchor.updateComplete;

      expect(restored.entry).toBe(first.entry);
      expect(restored.entry.id).toBe(retainedId);
      expect(restored.entry.pinned).toBe(true);
      expect(restored.entry.owner).toBe(restoredChat);
      expect(restored.entry.view.context?.isCurrent()).toBe(true);
      const currentContext = restored.entry.view.context;
      manager.refresh(firstChat);
      expect(restored.entry.view.context).toBe(currentContext);
      expect(restored.entry.view.context?.isCurrent()).toBe(true);
      await waitFor(() => expect(manager.entries).toEqual([first.entry]));
    } finally {
      screen.unmount();
      release();
      await waitFor(() => expect(manager.entries).toHaveLength(0));
      vi.unstubAllGlobals();
    }
  });
});

describe('widget product link admission', () => {
  it('uses the live link callback independently of draft admission without remounting the chat', async () => {
    const connect = connection();
    const first = vi.fn();
    const second = vi.fn();
    const screen = render(<JustDoChatWrapper onWidgetLink={first} />);
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const chat = fixture.chat!;
    const context = widgetContext(chat);
    const url = 'https://example.com/report?q=1#chart';

    expect(context.canDraft()).toBe(false);
    context.openLink?.(url);
    expect(first).toHaveBeenCalledExactlyOnceWith(context.sessionKey, url);

    screen.rerender(<JustDoChatWrapper onWidgetLink={second} />);
    context.openLink?.(url);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledExactlyOnceWith(context.sessionKey, url);

    screen.rerender(<JustDoChatWrapper />);
    context.openLink?.(url);
    expect(second).toHaveBeenCalledOnce();
    expect(context.canDraft()).toBe(false);
    expect(fixture.chat).toBe(chat);
    expect(connect).toHaveBeenCalledOnce();
  });

  it('rejects a mismatched native session key at the product bridge', async () => {
    const connect = connection();
    const onLink = vi.fn();
    render(<JustDoChatWrapper onWidgetLink={onLink} />);
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());

    fixture.chat!.openWidgetLink?.('agent:main:old-session', 'https://example.com');

    expect(onLink).not.toHaveBeenCalled();
  });

  it.each(['generation', 'client', 'session', 'connection'] as const)(
    'rejects a captured link callback after its native %s changes',
    async change => {
      const connect = connection();
      const onLink = vi.fn();
      render(<JustDoChatWrapper onWidgetLink={onLink} />);
      await waitFor(() => expect(connect).toHaveBeenCalledOnce());
      const context = widgetContext();
      const state = fixture.chat!.controller!.state;

      if (change === 'generation') Object.assign(state.client!, { generation: 2 });
      if (change === 'client') state.client = Object.create(state.client!);
      if (change === 'session') state.sessionKey = 'agent:main:replacement';
      if (change === 'connection') state.connected = false;
      context.openLink?.('https://example.com');

      expect(onLink).not.toHaveBeenCalled();
    },
  );

  it('rejects the old product session and accepts the newly selected session', async () => {
    const connect = connection();
    vi.spyOn(ChatController.prototype, 'switchSession').mockImplementation(async function (
      this: ChatController,
      sessionKey: string,
    ) {
      this.state.sessionKey = sessionKey;
    });
    const onLink = vi.fn();
    const screen = render(<JustDoChatWrapper onWidgetLink={onLink} />);
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const old = widgetContext();

    fixture.session = { id: 'widget-next', agentId: 'main' };
    screen.rerender(<JustDoChatWrapper onWidgetLink={onLink} />);
    const current = widgetContext();
    expect(current.sessionKey).not.toBe(old.sessionKey);
    old.openLink?.('https://example.com/old');
    expect(onLink).not.toHaveBeenCalled();

    current.openLink?.('https://example.com/current');
    expect(onLink).toHaveBeenCalledExactlyOnceWith(
      current.sessionKey,
      'https://example.com/current',
    );
  });

  it('revokes the registered and previously captured link callbacks on unmount', async () => {
    const connect = connection();
    const onLink = vi.fn();
    const screen = render(<JustDoChatWrapper onWidgetLink={onLink} />);
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const chat = fixture.chat!;
    const context = widgetContext(chat);
    const openLink = chat.openWidgetLink!;

    screen.unmount();
    context.openLink?.('https://example.com');
    openLink(context.sessionKey, 'https://example.com');

    expect(chat.openWidgetLink).toBeUndefined();
    expect(onLink).not.toHaveBeenCalled();
  });

  it('revokes the old product owner even when both products reference the same native session', async () => {
    fixture.session.nativeSessionKey = 'agent:main:shared-native';
    const connect = connection();
    const onLink = vi.fn();
    const screen = render(<JustDoChatWrapper onWidgetLink={onLink} />);
    await waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const old = widgetContext();
    const oldProductLink = fixture.chat!.openWidgetLink!;

    fixture.session = {
      id: 'widget-next',
      agentId: 'main',
      nativeSessionKey: old.sessionKey,
    };
    screen.rerender(<JustDoChatWrapper onWidgetLink={onLink} />);
    const current = widgetContext();
    expect(current.sessionKey).toBe(old.sessionKey);
    old.openLink?.('https://example.com/old');
    oldProductLink(old.sessionKey, 'https://example.com/old');
    expect(onLink).not.toHaveBeenCalled();

    current.openLink?.('https://example.com/current');
    expect(onLink).toHaveBeenCalledExactlyOnceWith(
      current.sessionKey,
      'https://example.com/current',
    );
  });
});
