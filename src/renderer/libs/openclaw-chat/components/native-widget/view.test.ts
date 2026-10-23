// @vitest-environment jsdom
import './view';

import { WIDGET_VIEWER_PARTITION, WidgetViewerIpc } from '@shared/widgets/viewer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatScrollController } from '../../controllers/chat-scroll-controller';
import { decodeNativeCanvasResult } from '../../pipeline/native-canvas';
import type { NativeWidgetContext } from './host';
import { NATIVE_WIDGET_OWNER_MESSENGER } from './messaging';
import { WIDGET_LAYOUT_REQUEST, WIDGET_MEASURED_HEIGHT } from './sizing';
import { NativeWidgetView } from './view';

const result = {
  html: '<!doctype html><p>Native content</p>',
  sandboxPort: 18790,
  sandboxUrl: '/mcp-app-sandbox',
};
const preview = (id: string) =>
  decodeNativeCanvasResult(
    JSON.stringify({
      kind: 'canvas',
      presentation: { target: 'assistant_message', sandbox: 'scripts', title: 'Team' },
      view: { id },
    }),
    'show_widget',
    'call-1',
  )!;
async function settle(view: NativeWidgetView): Promise<void> {
  await Promise.resolve();
  await view.updateComplete;
  await Promise.resolve();
  await view.updateComplete;
}
function inlineHeight(view: NativeWidgetView): string {
  return view.shadowRoot!.querySelector('dialog')!.style.getPropertyValue('--widget-height');
}
function mount(request = vi.fn().mockResolvedValue(result), parent: Node = document.body) {
  const client = { generation: 1, gatewayUrl: 'ws://127.0.0.1:18789', request };
  const context: NativeWidgetContext = {
    client,
    generation: 1,
    sessionKey: 'session-1',
    isCurrent: () => true,
    canDraft: () => true,
  };
  const view = document.createElement('justdo-native-widget') as NativeWidgetView;
  view.context = context;
  view.preview = preview('widget-1');
  parent.appendChild(view);
  return { view, client, context, request };
}

const actualRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.round(this.getBoundingClientRect().width);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.round(this.getBoundingClientRect().height);
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const root = this.getRootNode() as ShadowRoot;
    if (
      ['iframe', 'webview'].includes(this.localName) &&
      root.host?.localName === 'justdo-native-widget'
    ) {
      const dialog = root.querySelector('dialog')!;
      const height =
        dialog.getAttribute('aria-modal') === 'true'
          ? 877
          : parseFloat(dialog.style.getPropertyValue('--widget-height')) || 420;
      return new DOMRect(0, 0, 840, height);
    }
    return actualRect.call(this);
  });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function sandbox(view: NativeWidgetView) {
  const frame = view.shadowRoot!.querySelector('iframe')!;
  const post = vi.spyOn(frame.contentWindow!, 'postMessage');
  const send = (data: unknown, origin = new URL(frame.src).origin, source = frame.contentWindow) =>
    view.ownerDocument.defaultView!.dispatchEvent(
      new MessageEvent('message', { data, origin, source }),
    );
  const ready = () => {
    send({ method: 'ui/notifications/sandbox-proxy-ready', params: { sandboxUrl: frame.src } });
    const resource = post.mock.calls.find(
      ([data]) => data?.method === 'ui/notifications/sandbox-resource-ready',
    )![0];
    send({
      method: 'ui/notifications/sandbox-resource-loaded',
      params: { renderId: resource.params.renderId },
    });
  };
  const measured = (height: unknown, revision?: number) => {
    const request = post.mock.calls
      .filter(([data]) => data?.type === WIDGET_LAYOUT_REQUEST)
      .slice(-1)[0]![0];
    return {
      type: WIDGET_MEASURED_HEIGHT,
      id: request.id,
      height,
      revision: revision ?? request.layout.revision,
      width: request.layout.width,
      viewportHeight: request.layout.height,
    };
  };
  return { frame, post, send, ready, measured, size: (height: unknown) => send(measured(height)) };
}

describe('native widget viewer lifecycle', () => {
  it('fills the sidebar and restores inline height without reloading its document', async () => {
    const { view, request } = mount();
    await settle(view);
    const { frame, ready, size, measured, send, post } = sandbox(view);
    ready();
    size(480);
    await settle(view);
    const pin = vi.fn();
    view.pinPresentation = pin;
    view.requestUpdate();
    await settle(view);
    view.shadowRoot!.querySelector<HTMLButtonElement>('[data-action="pin"]')!.click();
    expect(pin).toHaveBeenCalledOnce();
    const inlineReport = measured(720);

    view.fillContainer = true;
    await settle(view);
    expect(view.hasAttribute('fill-container')).toBe(true);
    expect(view.shadowRoot!.querySelector('[data-action="pin"]')).toBeNull();
    expect(
      post.mock.calls.filter(([data]) => data?.type === WIDGET_LAYOUT_REQUEST).slice(-1)[0]?.[0]
        .layout.expanded,
    ).toBe(true);
    size(1250);
    await settle(view);
    expect(inlineHeight(view)).toBe('480px');

    const sidebarReport = measured(1600);
    view.fillContainer = false;
    await settle(view);
    send(sidebarReport);
    send(inlineReport);
    await settle(view);
    expect(inlineHeight(view)).toBe('480px');
    size(600);
    await settle(view);
    expect(inlineHeight(view)).toBe('600px');
    expect(view.shadowRoot!.querySelector('iframe')).toBe(frame);
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not share pending reads across native session incarnations', async () => {
    const request = vi.fn(() => new Promise(() => undefined));
    const { view, context } = mount(request);
    view.context = { ...context, sessionId: 'first-incarnation' };
    await settle(view);
    const second = document.createElement('justdo-native-widget') as NativeWidgetView;
    second.preview = view.preview;
    second.context = { ...context, sessionId: 'second-incarnation' };
    document.body.append(second);
    await settle(second);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('routes only confirmed sidebar suggestions through the current context and revokes hidden suggestions', async () => {
    const { view, context, request } = mount();
    const addDraft = vi.fn().mockResolvedValue(false);
    context.addDraft = addDraft;
    let visible = true;
    view.presentationVisible = () => visible;
    await settle(view);
    const { frame, ready } = sandbox(view);
    ready();
    const internal = view as unknown as {
      suggestion: string;
      renderSuggestion: () => { values: unknown[] };
    };
    internal.suggestion = 'Confirmed local choice';
    await settle(view);
    const confirm = internal
      .renderSuggestion()
      .values.find(value => typeof value === 'function') as (event: MouseEvent) => void;
    confirm({ isTrusted: false } as MouseEvent);
    await settle(view);
    expect(addDraft).not.toHaveBeenCalled();
    confirm({ isTrusted: true } as MouseEvent);
    await settle(view);
    expect(addDraft).toHaveBeenCalledExactlyOnceWith('Confirmed local choice');
    expect(view.shadowRoot!.querySelector('section')?.textContent).toContain(
      'Confirmed local choice',
    );

    visible = false;
    view.refreshPresentation();
    await settle(view);
    confirm({ isTrusted: true } as MouseEvent);
    expect(addDraft).toHaveBeenCalledOnce();
    expect(view.shadowRoot!.querySelector('section')).toBeNull();
    visible = true;
    view.refreshPresentation();
    await settle(view);
    confirm({ isTrusted: true } as MouseEvent);
    expect(addDraft).toHaveBeenCalledOnce();
    expect(view.shadowRoot!.querySelector('iframe')).toBe(frame);
    expect(request).toHaveBeenCalledOnce();
  });

  it('routes desktop links to the current consumer even in read-only history, rejecting hidden and stale cards', async () => {
    vi.stubGlobal('electron', {});
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { view, context, client } = mount();
    const open = vi.fn();
    context.openLink = open;
    context.canDraft = () => false;
    await settle(view);
    const guest = view.shadowRoot!.querySelector('webview')! as HTMLElement & {
      send: ReturnType<typeof vi.fn>;
    };
    guest.send = vi.fn();
    guest.tabIndex = 0;
    guest.focus();
    guest.dispatchEvent(new Event('dom-ready'));
    const { mountId } = guest.send.mock.calls[0][1];
    const emit = (data: unknown) =>
      guest.dispatchEvent(
        Object.assign(new Event('ipc-message'), {
          channel: WidgetViewerIpc.Event,
          args: [data],
        }),
      );
    const link = { mountId, type: 'link', url: 'https://example.com/report' };
    emit(link);
    expect(open).not.toHaveBeenCalled();
    emit({ mountId, type: 'ready' });
    emit({ ...link, mountId: 'old' });
    for (const url of [
      'file:///private.txt',
      'javascript:alert(1)',
      'https://user:secret@example.com',
    ])
      emit({ ...link, url });
    expect(open).not.toHaveBeenCalled();
    emit(link);
    expect(open).toHaveBeenCalledExactlyOnceWith(link.url);
    const dialog = view.shadowRoot!.querySelector('dialog')!;
    dialog.close = vi.fn();
    dialog.showModal = vi.fn();
    view.shadowRoot!.querySelector<HTMLButtonElement>('.view-actions button')!.click();
    await settle(view);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    guest.focus();
    emit(link);
    await settle(view);
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(dialog.close).toHaveBeenCalledTimes(2);
    expect(view.shadowRoot!.querySelector('webview')).toBe(guest);
    expect(open).toHaveBeenCalledTimes(2);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    emit(link);
    expect(open).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('visible');
    client.generation++;
    emit(link);
    expect(open).toHaveBeenCalledTimes(2);
    view.remove();
    emit(link);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('does not send a final state message into a guest being destroyed', async () => {
    vi.stubGlobal('electron', {});
    const { view } = mount();
    await settle(view);
    const guest = view.shadowRoot!.querySelector('webview')! as HTMLElement & {
      send: ReturnType<typeof vi.fn>;
    };
    guest.send = vi.fn().mockResolvedValue(undefined);
    guest.dispatchEvent(new Event('dom-ready'));
    expect(guest.send).toHaveBeenCalledOnce();
    view.remove();
    await settle(view);
    expect(guest.send).toHaveBeenCalledOnce();
  });

  it('handles an old asynchronous send rejection after a replacement guest is mounted', async () => {
    vi.stubGlobal('electron', {});
    const { view, request } = mount();
    await settle(view);
    const first = view.shadowRoot!.querySelector('webview')! as HTMLElement & {
      send: ReturnType<typeof vi.fn>;
    };
    let reject!: (error: Error) => void;
    first.send = vi.fn().mockImplementation(
      () =>
        new Promise<void>((_resolve, rejectSend) => {
          reject = rejectSend;
        }),
    );
    first.dispatchEvent(new Event('dom-ready'));
    view.preview = preview('replacement');
    await settle(view);
    const replacement = view.shadowRoot!.querySelector('webview')! as HTMLElement & {
      send: ReturnType<typeof vi.fn>;
    };
    expect(replacement).not.toBe(first);
    replacement.send = vi.fn().mockResolvedValue(undefined);
    replacement.dispatchEvent(new Event('dom-ready'));
    const init = replacement.send.mock.calls[0][1];
    replacement.dispatchEvent(
      Object.assign(new Event('ipc-message'), {
        channel: WidgetViewerIpc.Event,
        args: [{ mountId: init.mountId, type: 'ready' }],
      }),
    );
    reject(new Error('Invalid guestInstanceId: 4'));
    await settle(view);
    expect(view.shadowRoot!.querySelector('webview')).toBe(replacement);
    expect(view.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
    expect(first.send).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['initialize', 'state'])(
    'recovers when the desktop guest %s send rejects asynchronously',
    async stage => {
      vi.stubGlobal('electron', {});
      const { view, context } = mount();
      await settle(view);
      const guest = view.shadowRoot!.querySelector('webview')! as HTMLElement & {
        send: ReturnType<typeof vi.fn>;
      };
      guest.send = vi.fn().mockResolvedValue(undefined);
      if (stage === 'initialize')
        guest.send.mockRejectedValueOnce(new Error('Invalid guestInstanceId: 4'));
      guest.dispatchEvent(new Event('dom-ready'));
      if (stage === 'state') {
        guest.send.mockRejectedValueOnce(new Error('Invalid guestInstanceId: 5'));
        context.canDraft = () => false;
        view.requestUpdate();
      }
      await settle(view);
      expect(view.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
      expect(view.shadowRoot!.querySelector('webview')).toBeNull();
      expect(view.shadowRoot!.querySelector('iframe')).toBeNull();
    },
  );
  it.each(['crash', 'send'])(
    'recovers from a desktop guest %s without recursive IPC failures',
    async kind => {
      vi.stubGlobal('electron', {});
      const { view, context } = mount();
      await settle(view);
      const guest = view.shadowRoot!.querySelector('webview')! as HTMLElement & {
        send: ReturnType<typeof vi.fn>;
      };
      guest.send = vi.fn();
      guest.dispatchEvent(new Event('dom-ready'));
      guest.send.mockImplementation(() => {
        throw new Error('Guest unavailable');
      });
      if (kind === 'crash') guest.dispatchEvent(new Event('render-process-gone'));
      else {
        context.canDraft = () => false;
        view.requestUpdate();
      }
      await settle(view);
      expect(view.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
      expect(view.shadowRoot!.querySelector('webview')).toBeNull();
      expect(view.shadowRoot!.querySelector('iframe')).toBeNull();
      expect(guest.send.mock.calls.length).toBeLessThanOrEqual(2);
    },
  );
  it('isolates desktop cards in a guest and rejects stale events without a direct fallback', async () => {
    vi.stubGlobal('electron', {});
    const { view, request, context } = mount();
    await settle(view);
    const guest = view.shadowRoot!.querySelector('webview')! as HTMLElement & {
      src: string;
      send: ReturnType<typeof vi.fn>;
    };
    expect(view.shadowRoot!.querySelector('iframe')).toBeNull();
    expect(guest.getAttribute('partition')).toBe(WIDGET_VIEWER_PARTITION);
    guest.send = vi.fn();
    guest.dispatchEvent(new Event('dom-ready'));
    const init = guest.send.mock.calls[0][1];
    expect(init.html).toBe(result.html);
    expect(new URL(guest.src).searchParams.get('mount')).toBe(init.mountId);
    const emit = (data: unknown) =>
      guest.dispatchEvent(
        Object.assign(new Event('ipc-message'), { channel: WidgetViewerIpc.Event, args: [data] }),
      );
    emit({ mountId: 'stale', type: 'height', height: 780 });
    await settle(view);
    expect(inlineHeight(view)).toBe('420px');
    emit({ mountId: init.mountId, type: 'ready' });
    emit({ mountId: init.mountId, type: 'height', height: 570, revision: init.layout.revision });
    await settle(view);
    expect(inlineHeight(view)).toBe('570px');
    context.canDraft = () => false;
    view.requestUpdate();
    await settle(view);
    expect(guest.send.mock.lastCall![1].draftAllowed).toBe(false);
    expect(view.shadowRoot!.querySelector('webview')).toBe(guest);
    expect(request).toHaveBeenCalledOnce();
    emit({ mountId: init.mountId, type: 'failure', runtime: false });
    await settle(view);
    expect(view.shadowRoot!.querySelector('webview')).toBeNull();
    expect(view.shadowRoot!.querySelector('iframe')).toBeNull();
    expect(view.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
    emit({ mountId: init.mountId, type: 'ready' });
    await settle(view);
    expect(view.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
  });
  it('expands and collapses the same iframe without reading the document again', async () => {
    const chat = document.createElement('justdo-chat');
    document.body.append(chat);
    const { view, request } = mount(undefined, chat.attachShadow({ mode: 'open' }));
    await settle(view);
    const { frame, ready, size } = sandbox(view);
    ready();
    await settle(view);
    size(480);
    await settle(view);
    const dialog = view.shadowRoot!.querySelector('dialog')!;
    const close = vi.fn(() => {
      dialog.open = false;
    });
    const showModal = vi.fn(() => {
      dialog.open = true;
    });
    dialog.close = close;
    dialog.showModal = showModal;
    const expand = () =>
      view.shadowRoot!.querySelector<HTMLButtonElement>('.view-actions button')!.click();
    expand();
    await settle(view);
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.body.querySelector('[data-workspace-overlay="true"]')).not.toBeNull();
    size(960);
    await settle(view);
    expect(inlineHeight(view)).toBe('480px');
    expand();
    await settle(view);
    expect(dialog.hasAttribute('aria-modal')).toBe(false);
    expect(document.body.querySelector('[data-workspace-overlay="true"]')).toBeNull();
    expect(inlineHeight(view)).toBe('480px');
    expect(view.shadowRoot!.querySelector('iframe')).toBe(frame);
    expect(request).toHaveBeenCalledOnce();
    expand();
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await settle(view);
    expect(dialog.getAttribute('role')).toBe('group');
    expect(dialog.open).toBe(true);
    expect(document.body.querySelector('[data-workspace-overlay="true"]')).toBeNull();
    expand();
    view.remove();
    expect(document.body.querySelector('[data-workspace-overlay="true"]')).toBeNull();
  });

  it('clears the workspace overlay immediately when the expanded binding becomes invalid', async () => {
    const { view, context } = mount();
    await settle(view);
    const dialog = view.shadowRoot!.querySelector('dialog')!;
    dialog.close = vi.fn();
    dialog.showModal = vi.fn();
    view.shadowRoot!.querySelector<HTMLButtonElement>('.view-actions button')!.click();
    expect(document.body.querySelector('[data-workspace-overlay="true"]')).not.toBeNull();
    view.context = { ...context, isCurrent: () => false };
    await settle(view);
    expect(document.body.querySelector('[data-workspace-overlay="true"]')).toBeNull();
  });

  it.each(['browser', 'desktop'])(
    'rejects delayed sizes from an old viewport revision in a %s card',
    async kind => {
      vi.useFakeTimers();
      if (kind === 'desktop') vi.stubGlobal('electron', {});
      const { view } = mount();
      await settle(view);
      let send: (height: number, revision?: number) => void;
      let revision: () => number;
      if (kind === 'desktop') {
        const guest = view.shadowRoot!.querySelector('webview')! as HTMLElement & {
          send: ReturnType<typeof vi.fn>;
        };
        guest.send = vi.fn().mockResolvedValue(undefined);
        guest.dispatchEvent(new Event('dom-ready'));
        const { mountId } = guest.send.mock.calls[0][1];
        revision = () => guest.send.mock.lastCall![1].layout.revision;
        send = (height, measuredRevision = revision()) =>
          guest.dispatchEvent(
            Object.assign(new Event('ipc-message'), {
              channel: WidgetViewerIpc.Event,
              args: [{ mountId, type: 'height', height, revision: measuredRevision }],
            }),
          );
      } else {
        const sandboxHost = sandbox(view);
        sandboxHost.ready();
        revision = () => sandboxHost.measured(420).revision;
        send = (height, measuredRevision) =>
          sandboxHost.send(sandboxHost.measured(height, measuredRevision));
      }
      const dialog = view.shadowRoot!.querySelector('dialog')!;
      dialog.close = vi.fn();
      dialog.showModal = vi.fn();
      const toggle = () =>
        view.shadowRoot!.querySelector<HTMLButtonElement>('.view-actions button')!.click();
      const inlineRevision = revision();
      toggle();
      await settle(view);
      const expandedRevision = revision();
      expect(expandedRevision).toBeGreaterThan(inlineRevision);
      send(877);
      toggle();
      await settle(view);
      const collapsedRevision = revision();
      expect(collapsedRevision).toBeGreaterThan(expandedRevision);
      setTimeout(() => send(877, expandedRevision), 2000);
      await vi.advanceTimersByTimeAsync(2500);
      await settle(view);
      expect(inlineHeight(view)).toBe('420px');
      send(640);
      await settle(view);
      expect(inlineHeight(view)).toBe('640px');
      send(877, collapsedRevision);
      await settle(view);
      expect(inlineHeight(view)).toBe('640px');
      send(660);
      await settle(view);
      expect(inlineHeight(view)).toBe('660px');
      view.preview = preview('replacement');
      await settle(view);
      expect(inlineHeight(view)).toBe('420px');
      send(900);
      await settle(view);
      expect(inlineHeight(view)).toBe('420px');
    },
  );

  it('publishes the overlay only in the actual workspace document when a side-chat card expands', async () => {
    const workspace = document.createElement('iframe');
    workspace.src = new URL('/workspace.html', window.location.href).href;
    document.body.append(workspace);
    const doc = workspace.contentDocument!;
    doc.write('<!doctype html><html><body></body></html>');
    doc.close();
    const { view } = mount();
    doc.body.append(view);
    await settle(view);
    const dialog = view.shadowRoot!.querySelector('dialog')!;
    dialog.close = vi.fn();
    dialog.showModal = vi.fn();
    view.shadowRoot!.querySelector<HTMLButtonElement>('.view-actions button')!.click();
    expect(doc.body.querySelector('[data-workspace-overlay="true"]')).not.toBeNull();
    expect(document.body.querySelector('[data-workspace-overlay="true"]')).toBeNull();
    view.remove();
    expect(doc.body.querySelector('[data-workspace-overlay="true"]')).toBeNull();
  });

  it('keeps a slow authenticated read and sandbox alive, then clears the notice on render', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const { view, request } = mount(
      vi.fn(
        () =>
          new Promise(accept => {
            resolve = accept;
          }),
      ),
    );
    await settle(view);
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(view);
    expect(view.shadowRoot!.querySelector('[role="status"]')?.textContent).toMatch(/较长|longer/);
    expect(view.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
    resolve(result);
    await settle(view);
    const { ready, frame } = sandbox(view);
    expect(view.shadowRoot!.querySelector('.frame.loading')).not.toBeNull();
    expect(frame.inert).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    ready();
    await settle(view);
    expect(view.shadowRoot!.querySelector('.frame.loading')).toBeNull();
    expect(frame.inert).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await settle(view);
    expect(view.shadowRoot!.querySelector('iframe')).toBe(frame);
    expect(view.shadowRoot!.querySelector('[role="status"]')).toBeNull();
    expect(view.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it('shows a slow sandbox notice before the final deadline and cancels it on unmount', async () => {
    vi.useFakeTimers();
    const { view, request } = mount();
    await settle(view);
    const frame = view.shadowRoot!.querySelector('iframe');
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(view);
    expect(view.shadowRoot!.querySelector('iframe')).toBe(frame);
    expect(view.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    await settle(view);
    expect(view.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.shadowRoot!.querySelector('iframe')).toBeNull();
    expect(request).toHaveBeenCalledOnce();
    view.shadowRoot!.querySelector<HTMLButtonElement>('.status button')!.click();
    await settle(view);
    view.remove();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards only current native scroll authority to its own transcript, including paging intent', async () => {
    const chat = document.createElement('justdo-chat');
    const root = chat.attachShadow({ mode: 'open' });
    document.body.append(chat);
    const scrollBy = vi.fn();
    chat.scrollBy = scrollBy;
    const wheel = vi.fn();
    chat.addEventListener('wheel', wheel);
    chat.scrollTop = 100;
    const loadOlder = vi.fn();
    const controller = new ChatScrollController(vi.fn(), loadOlder);
    controller.connect(chat);
    const { view } = mount(undefined, root);
    await settle(view);
    const first = sandbox(view);
    first.ready();
    await settle(view);
    const nonce = first.post.mock.calls.find(
      ([data]) => data?.type === 'openclaw:widget-board-host',
    )![0].nonce;
    const scroll = { type: 'openclaw:widget-scroll', nonce, deltaY: -80 };
    for (const data of [
      { ...scroll, nonce: 'stale' },
      { ...scroll, deltaY: Infinity },
      { ...scroll, deltaY: '80' },
    ])
      first.send(data);
    first.send(scroll, 'https://evil.test');
    first.send(scroll, new URL(first.frame.src).origin, window);
    expect(scrollBy).not.toHaveBeenCalled();
    first.send(scroll);
    expect(wheel).toHaveBeenCalledOnce();
    expect(controller.state.mode).toBe('paused');
    expect(loadOlder).toHaveBeenCalledOnce();
    expect(scrollBy).toHaveBeenCalledWith({ top: -80, behavior: 'instant' });
    const prevent = (event: Event) => event.preventDefault();
    chat.addEventListener('wheel', prevent);
    first.send(scroll);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    chat.removeEventListener('wheel', prevent);
    view.preview = preview('widget-2');
    await settle(view);
    const second = sandbox(view);
    second.ready();
    await settle(view);
    first.send(scroll);
    second.send(scroll);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const newNonce = second.post.mock.calls.find(
      ([data]) => data?.type === 'openclaw:widget-board-host',
    )![0].nonce;
    second.send({ ...scroll, nonce: newNonce });
    expect(scrollBy).toHaveBeenCalledTimes(1);
    controller.disconnect();
  });

  it('reloads after disconnected updates settle before the same view is attached again', async () => {
    const { view, request } = mount();
    await settle(view);
    expect(request).toHaveBeenCalledOnce();
    view.remove();
    await settle(view);
    expect(request).toHaveBeenCalledOnce();
    document.body.append(view);
    await settle(view);
    expect(request).toHaveBeenCalledTimes(2);
    const frame = view.shadowRoot!.querySelector('iframe')!;
    expect(frame).not.toBeNull();
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { method: 'ui/notifications/sandbox-proxy-ready', params: { sandboxUrl: frame.src } },
        origin: new URL(frame.src).origin,
        source: frame.contentWindow,
      }),
    );
    const resource = post.mock.calls[0][0] as { params: { renderId: string } };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          method: 'ui/notifications/sandbox-resource-loaded',
          params: { renderId: resource.params.renderId },
        },
        origin: new URL(frame.src).origin,
        source: frame.contentWindow,
      }),
    );
    await settle(view);
    expect(view.shadowRoot!.querySelector('[role="status"]')).toBeNull();
  });

  it('shows a recoverable failure when the workspace sender is unavailable instead of marking delivery successful', async () => {
    const workspace = document.createElement('iframe');
    workspace.src = new URL('/workspace.html', window.location.href).href;
    document.body.append(workspace);
    workspace.contentDocument!.write('<!doctype html><html><body></body></html>');
    workspace.contentDocument!.close();
    const { view, request } = mount();
    workspace.contentDocument!.body.append(view);
    await settle(view);
    const frame = view.shadowRoot!.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    workspace.contentWindow!.dispatchEvent(
      new MessageEvent('message', {
        data: { method: 'ui/notifications/sandbox-proxy-ready', params: { sandboxUrl: frame.src } },
        origin: new URL(frame.src).origin,
        source: frame.contentWindow,
      }),
    );
    await settle(view);
    expect(post).not.toHaveBeenCalled();
    expect(view.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.shadowRoot!.querySelector('button')).not.toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it('follows the owner window for messages, theme and visibility, and releases the previous document on adoption', async () => {
    const workspace = document.createElement('iframe');
    workspace.src = new URL('/workspace.html', window.location.href).href;
    document.body.append(workspace);
    workspace.contentDocument!.write('<!doctype html><html><body></body></html>');
    workspace.contentDocument!.close();
    const owner = workspace.contentWindow!;
    const doc = workspace.contentDocument!;
    // jsdom does not implement postMessage source realms. Assert delegation here;
    // the separate Electron check exercises the workspace's actual module.
    const messenger = vi.fn((frame: HTMLIFrameElement, data: unknown, origin: string) => {
      frame.contentWindow!.postMessage(data, origin);
      return true;
    });
    Object.defineProperty(owner, NATIVE_WIDGET_OWNER_MESSENGER, { value: messenger });
    doc.documentElement.style.setProperty('--justdo-primary', '#123456');
    doc.documentElement.style.setProperty('--justdo-radius', '12px');
    doc.documentElement.style.setProperty('--justdo-scroll-thumb', '#445566');
    doc.documentElement.style.fontFamily = 'Example Font';
    doc.documentElement.style.colorScheme = 'dark';
    let visibility = 'visible';
    vi.spyOn(doc, 'visibilityState', 'get').mockImplementation(
      () => visibility as DocumentVisibilityState,
    );
    const { view, request } = mount();
    view.style.fontFamily = 'Chat Font';
    doc.body.append(view);
    await settle(view);
    expect(view.shadowRoot!.querySelectorAll('style')).toHaveLength(1);
    const frame = view.shadowRoot!.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const send = (target: Window, data: unknown, ports: unknown[] = []) => {
      const event = new MessageEvent('message', {
        data,
        origin: new URL(frame.src).origin,
        source: frame.contentWindow,
      });
      Object.defineProperty(event, 'ports', { value: ports });
      target.dispatchEvent(event);
    };
    const ready = {
      method: 'ui/notifications/sandbox-proxy-ready',
      params: { sandboxUrl: frame.src },
    };
    send(window, ready);
    expect(post).not.toHaveBeenCalled();
    send(owner, ready);
    const resource = post.mock.calls[0][0] as { params: { renderId: string } };
    expect(resource).toMatchObject({ method: 'ui/notifications/sandbox-resource-ready' });
    expect(messenger).toHaveBeenCalledWith(frame, resource, new URL(frame.src).origin);
    send(owner, {
      method: 'ui/notifications/sandbox-resource-loaded',
      params: { renderId: resource.params.renderId },
    });
    await settle(view);
    expect(view.shadowRoot!.querySelector('[role="status"]')).toBeNull();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'openclaw:widget-theme',
        mode: 'dark',
        tokens: expect.objectContaining({
          accent: '#123456',
          radius: '12px',
          'font-body': '"Chat Font"',
          'scrollbar-thumb': '#445566',
          'font-mono': expect.any(String),
        }),
      }),
      new URL(frame.src).origin,
    );
    const port = { close: vi.fn(), start: vi.fn(), postMessage: vi.fn(), onmessage: null };
    visibility = 'hidden';
    send(owner, { type: 'openclaw:widget-prompt-offer' }, [port]);
    const policy = () =>
      post.mock.calls
        .filter(([message]) => message?.type === 'openclaw:scenario-draft-policy')
        .slice(-1)[0]?.[0];
    expect(policy()).toMatchObject({ available: false });
    visibility = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(policy()).toMatchObject({ available: true });
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(policy()).toMatchObject({ available: true });
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(policy()).toMatchObject({ available: false });
    doc.documentElement.style.setProperty('--justdo-primary', '#654321');
    await Promise.resolve();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'openclaw:widget-theme',
        tokens: expect.objectContaining({ accent: '#654321' }),
      }),
      new URL(frame.src).origin,
    );

    const removeWindow = vi.spyOn(owner, 'removeEventListener');
    const removeDocument = vi.spyOn(doc, 'removeEventListener');
    document.body.append(view);
    await settle(view);
    expect(port.close).toHaveBeenCalledOnce();
    expect(removeWindow).toHaveBeenCalledWith('message', expect.any(Function));
    expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(view.shadowRoot!.querySelectorAll('style')).toHaveLength(1);
    expect(view.shadowRoot!.querySelector('style')!.ownerDocument).toBe(document);
    expect(request).toHaveBeenCalledTimes(2);
    post.mockClear();
    send(owner, ready);
    doc.documentElement.style.setProperty('--justdo-primary', '#abcdef');
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    const currentFrame = view.shadowRoot!.querySelector('iframe')!;
    const currentPost = vi.spyOn(currentFrame.contentWindow!, 'postMessage');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          method: 'ui/notifications/sandbox-proxy-ready',
          params: { sandboxUrl: currentFrame.src },
        },
        origin: new URL(currentFrame.src).origin,
        source: currentFrame.contentWindow,
      }),
    );
    expect(currentPost).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'ui/notifications/sandbox-resource-ready' }),
      new URL(currentFrame.src).origin,
    );
  });

  it('revokes and restores draft admission without reloading the document or closing its prompt port', async () => {
    let allowed = false;
    const { view, context, request } = mount();
    view.context = { ...context, canDraft: () => allowed };
    await settle(view);
    const frame = view.shadowRoot!.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const send = (data: unknown, ports: unknown[] = []) => {
      const event = new MessageEvent('message', {
        data,
        origin: new URL(frame.src).origin,
        source: frame.contentWindow,
      });
      Object.defineProperty(event, 'ports', { value: ports });
      window.dispatchEvent(event);
    };
    send({ method: 'ui/notifications/sandbox-proxy-ready', params: { sandboxUrl: frame.src } });
    const resource = post.mock.calls[0][0];
    send({
      method: 'ui/notifications/sandbox-resource-loaded',
      params: { renderId: resource.params.renderId },
    });
    await settle(view);
    expect(view.shadowRoot!.querySelector('.notice')).toBeNull();
    const port = {
      close: vi.fn(),
      start: vi.fn(),
      postMessage: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
    };
    send({ type: 'openclaw:widget-prompt-offer' }, [port]);
    await settle(view);
    expect(view.shadowRoot!.querySelector('.notice')).toBeNull();
    send({ type: 'openclaw:widget-bridge-ready' });
    const policy = () =>
      post.mock.calls
        .filter(([message]) => message?.type === 'openclaw:scenario-draft-policy')
        .slice(-1)[0]?.[0];
    expect(policy()?.available).toBe(false);
    const prompt = (text: string) =>
      port.onmessage!(
        new MessageEvent('message', {
          data: { type: 'openclaw:widget-prompt', prompt: text },
        }),
      );
    prompt('Unavailable read-only suggestion');
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')).toBeNull();

    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      width: 500,
      height: 400,
      top: 10,
      bottom: 410,
      left: 10,
      right: 510,
    } as DOMRect);
    frame.focus();
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    allowed = true;
    view.context = { ...view.context! };
    await settle(view);
    expect(policy()?.available).toBe(true);
    expect(view.shadowRoot!.querySelector('.notice')).toBeNull();
    prompt('Reviewed selection');
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')?.textContent).toContain('Reviewed selection');
    const internal = view as unknown as { renderSuggestion: () => { values: unknown[] } };
    const oldAdd = internal
      .renderSuggestion()
      .values.find(value => typeof value === 'function') as (event: MouseEvent) => void;
    const draft = vi.fn();
    view.addEventListener('native-widget-draft', draft);

    // Admission changes before the next Lit render. The old visible button and
    // an in-flight private-port message must observe the live capability.
    allowed = false;
    oldAdd({ isTrusted: true } as MouseEvent);
    prompt('Late read-only suggestion');
    expect(draft).not.toHaveBeenCalled();
    view.context = { ...view.context! };
    await settle(view);
    expect(policy()?.available).toBe(false);
    expect(view.shadowRoot!.querySelector('section')).toBeNull();
    expect(view.shadowRoot!.querySelector('.notice')).toBeNull();
    expect(view.shadowRoot!.querySelector('iframe')).toBe(frame);
    expect(port.close).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);

    allowed = true;
    view.context = { ...view.context! };
    await settle(view);
    oldAdd({ isTrusted: true } as MouseEvent);
    expect(draft).not.toHaveBeenCalled();
    expect(policy()?.available).toBe(true);
    prompt('Fresh current suggestion');
    await settle(view);
    const freshAdd = internal
      .renderSuggestion()
      .values.find(value => typeof value === 'function') as (event: MouseEvent) => void;
    freshAdd({ isTrusted: true } as MouseEvent);
    expect(draft).toHaveBeenCalledOnce();
    expect(view.shadowRoot!.querySelector('iframe')).toBe(frame);
    expect(request).toHaveBeenCalledTimes(1);
    expect(port.close).not.toHaveBeenCalled();
  });

  it('keeps reload available but withholds recreation and stale suggestions when draft admission is revoked', async () => {
    let allowed = false;
    const { view, context, request } = mount(
      vi.fn().mockRejectedValue(new Error('Synthetic missing document')),
    );
    view.context = { ...context, canDraft: () => allowed };
    await settle(view);
    expect(view.shadowRoot!.querySelectorAll('.status button')).toHaveLength(1);
    const action = view as unknown as {
      requestRebuild: (event: MouseEvent) => void;
      renderSuggestion: () => { values: unknown[] };
    };
    action.requestRebuild({ isTrusted: true } as MouseEvent);
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')).toBeNull();
    allowed = true;
    view.context = { ...view.context! };
    await settle(view);
    expect(view.shadowRoot!.querySelectorAll('.status button')).toHaveLength(2);
    action.requestRebuild({ isTrusted: true } as MouseEvent);
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')).not.toBeNull();
    const oldAdd = action.renderSuggestion().values.find(value => typeof value === 'function') as (
      event: MouseEvent,
    ) => void;
    const draft = vi.fn();
    view.addEventListener('native-widget-draft', draft);
    allowed = false;
    oldAdd({ isTrusted: true } as MouseEvent);
    expect(draft).not.toHaveBeenCalled();
    view.context = { ...view.context! };
    await settle(view);
    expect(view.shadowRoot!.querySelectorAll('.status button')).toHaveLength(1);
    expect(view.shadowRoot!.querySelector('section')).toBeNull();
    allowed = true;
    view.context = { ...view.context! };
    await settle(view);
    oldAdd({ isTrusted: true } as MouseEvent);
    expect(draft).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('ignores an error from a removed frame after a new document is bound', async () => {
    const { view } = mount();
    await settle(view);
    const oldFrame = view.shadowRoot!.querySelector('iframe')!;
    view.preview = preview('widget-2');
    await settle(view);
    const currentFrame = view.shadowRoot!.querySelector('iframe')!;
    expect(currentFrame).not.toBe(oldFrame);
    oldFrame.dispatchEvent(new Event('error'));
    await settle(view);
    expect(view.shadowRoot!.querySelector('iframe')).toBe(currentFrame);
    expect(view.shadowRoot!.querySelector('[role="alert"]')).toBeNull();
  });

  it('requires a trusted current host action to review a recreation draft without retrying or sending', async () => {
    const { view, request, context, client } = mount(
      vi.fn().mockRejectedValue(new Error('private raw diagnostic')),
    );
    await settle(view);
    const buttons = view.shadowRoot!.querySelectorAll<HTMLButtonElement>('.status button');
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')).toBeNull();
    const hostAction = view as unknown as {
      requestRebuild: (event: MouseEvent, binding?: unknown) => void;
      binding: unknown;
    };
    const oldBinding = hostAction.binding;
    hostAction.requestRebuild({ isTrusted: true } as MouseEvent);
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')?.textContent).toContain('widget-1');
    expect(view.shadowRoot!.textContent).not.toContain('private raw diagnostic');
    expect(request).toHaveBeenCalledTimes(1);
    view.shadowRoot!.querySelector<HTMLButtonElement>('section button')!.click();
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')).not.toBeNull();
    view.context = { ...context, sessionKey: 'session-2' };
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')).toBeNull();
    hostAction.requestRebuild({ isTrusted: true } as MouseEvent, oldBinding);
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')).toBeNull();
    client.generation++;
    hostAction.requestRebuild({ isTrusted: true } as MouseEvent);
    await settle(view);
    expect(view.shadowRoot!.querySelector('section')).toBeNull();
  });

  it('reads only canvas.document.view with docId and prepares a dedicated sandbox frame without auth in its URL', async () => {
    const { view, request } = mount();
    await settle(view);
    expect(request).toHaveBeenCalledExactlyOnceWith('canvas.document.view', { docId: 'widget-1' });
    const frame = view.shadowRoot!.querySelector('iframe')!;
    expect(frame.src).toBe('http://127.0.0.1:18790/mcp-app-sandbox');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-popups');
    expect(frame.getAttribute('referrerpolicy')).toBe('origin');
  });

  it('rejects an invalid response origin without mounting a remote frame and allows only manual retry', async () => {
    const { view, request } = mount(
      vi.fn().mockResolvedValue({ ...result, sandboxOrigin: 'https://evil.test' }),
    );
    await settle(view);
    expect(view.shadowRoot!.querySelector('iframe')).toBeNull();
    expect(view.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    view.shadowRoot!.querySelector<HTMLButtonElement>('.status button')!.click();
    await settle(view);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(call => call[0] === 'canvas.document.view')).toBe(true);
  });

  it('drops old document, session and connection results, including results delivered after unmount', async () => {
    const resolve: Array<(value: unknown) => void> = [];
    const request = vi.fn(() => new Promise(accept => resolve.push(accept)));
    const { view, client, context } = mount(request);
    await settle(view);
    view.preview = preview('widget-2');
    await settle(view);
    resolve[0](result);
    await settle(view);
    expect(view.shadowRoot!.querySelector('iframe')).toBeNull();
    client.generation = 2;
    resolve[1](result);
    await settle(view);
    expect(view.shadowRoot!.querySelector('iframe')).toBeNull();
    view.context = { ...context, generation: 2, sessionKey: 'session-2' };
    await settle(view);
    view.remove();
    resolve[2](result);
    await settle(view);
    expect(view.shadowRoot!.querySelector('iframe')).toBeNull();
  });

  it('fits short and tall native content, rounds up fractional heights and resets size when the document changes', async () => {
    const { view } = mount();
    await settle(view);
    const { frame, ready, measured } = sandbox(view);
    ready();
    const resize = async (height: unknown, source = frame.contentWindow) => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: measured(height),
          origin: new URL(frame.src).origin,
          source,
        }),
      );
      await settle(view);
    };
    await resize(72.5);
    expect(inlineHeight(view)).toBe('73px');
    await resize(24);
    expect(inlineHeight(view)).toBe('48px');
    await resize(2600);
    expect(inlineHeight(view)).toBe('2600px');
    await resize(9000);
    expect(inlineHeight(view)).toBe('8000px');
    for (const invalid of [0, -1, NaN, Infinity, '200']) await resize(invalid);
    await resize(200, window);
    expect(inlineHeight(view)).toBe('8000px');

    view.preview = preview('widget-2');
    await settle(view);
    const replacement = view.shadowRoot!.querySelector('iframe')!;
    expect(replacement).not.toBe(frame);
    expect(inlineHeight(view)).toBe('420px');
    await resize(600);
    expect(inlineHeight(view)).toBe('420px');
  });

  it('bounds concurrent history reads without failing newer retained widgets behind expired documents', async () => {
    const requests: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> =
      [];
    const request = vi.fn(
      () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    );
    const { context, view } = mount(request);
    const views = [view];
    for (let index = 2; index <= 34; index++) {
      const widget = document.createElement('justdo-native-widget') as NativeWidgetView;
      widget.context = context;
      widget.preview = preview(`widget-${index}`);
      document.body.append(widget);
      views.push(widget);
    }
    await Promise.all(views.map(settle));
    expect(request).toHaveBeenCalledTimes(32);
    expect(views[33].shadowRoot!.querySelector('[role="alert"]')).toBeNull();

    // A history row removed while waiting must never issue a late document read.
    views[32].remove();
    requests[0].reject(new Error('document expired'));
    await Promise.all(views.map(settle));
    expect(request).toHaveBeenCalledTimes(33);
    expect(request).toHaveBeenLastCalledWith('canvas.document.view', { docId: 'widget-34' });
    requests[32].resolve(result);
    await settle(views[33]);
    expect(views[33].shadowRoot!.querySelector('iframe')).not.toBeNull();
  });

  it('requires current proxy readiness, first private prompt port and focus/activation before displaying a draft; never calls wake or send', async () => {
    const { view, request } = mount();
    await settle(view);
    const frame = view.shadowRoot!.querySelector('iframe')!;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    function send(data: unknown, ports: unknown[] = [], origin = new URL(frame.src).origin): void {
      const event = new MessageEvent('message', { data, origin, source: frame.contentWindow });
      Object.defineProperty(event, 'ports', { value: ports });
      window.dispatchEvent(event);
    }
    send({ method: 'ui/notifications/sandbox-proxy-ready', params: { sandboxUrl: frame.src } });
    const port = {
      close: vi.fn(),
      start: vi.fn(),
      postMessage: vi.fn(),
      onmessage: null as ((message: MessageEvent) => void) | null,
    };
    send({ type: 'openclaw:widget-prompt-offer' }, [port]);
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'openclaw:widget-prompt-host-ready' });
    const second = { close: vi.fn() };
    send({ type: 'openclaw:widget-prompt-offer' }, [second]);
    expect(second.close).toHaveBeenCalledOnce();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({
      width: 500,
      height: 400,
      top: 10,
      bottom: 410,
      left: 10,
      right: 510,
    } as DOMRect);
    frame.focus();
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    port.onmessage!(
      new MessageEvent('message', { data: { type: 'openclaw:widget-prompt', prompt: '/execute' } }),
    );
    await settle(view);
    expect(view.shadowRoot!.textContent).not.toContain('/execute');
    port.onmessage!(
      new MessageEvent('message', {
        data: { type: 'openclaw:widget-prompt', prompt: 'Analyze this selection' },
      }),
    );
    await settle(view);
    expect(view.shadowRoot!.textContent).toContain('Analyze this selection');
    expect(request).toHaveBeenCalledTimes(1);
    send({ type: 'openclaw:widget-runtime-error', message: 'bad script' });
    await settle(view);
    expect(view.shadowRoot!.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.shadowRoot!.querySelector('iframe')).toBe(frame);
    expect(port.close).toHaveBeenCalledOnce();
    expect(view.shadowRoot!.querySelector('.notice')).toBeNull();
    const latePort = { close: vi.fn() };
    send({ type: 'openclaw:widget-prompt-offer' }, [latePort]);
    expect(latePort.close).toHaveBeenCalledOnce();
    expect(
      post.mock.calls.some(
        call => call[0]?.type === 'openclaw:scenario-draft-policy' && call[0].available === false,
      ),
    ).toBe(true);
  });
});
