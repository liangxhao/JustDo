// @vitest-environment jsdom
import './view';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNativeCanvasResult } from '../../pipeline/native-canvas';
import type { NativeWidgetContext } from './host';
import { NATIVE_WIDGET_OWNER_MESSENGER } from './messaging';
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
function mount(request = vi.fn().mockResolvedValue(result)) {
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
  document.body.append(view);
  return { view, client, context, request };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native widget viewer lifecycle', () => {
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
    doc.documentElement.style.colorScheme = 'dark';
    let visibility = 'visible';
    vi.spyOn(doc, 'visibilityState', 'get').mockImplementation(
      () => visibility as DocumentVisibilityState,
    );
    const { view, request } = mount();
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
        tokens: expect.objectContaining({ accent: '#123456' }),
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
    const port = {
      close: vi.fn(),
      start: vi.fn(),
      postMessage: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
    };
    send({ type: 'openclaw:widget-prompt-offer' }, [port]);
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
    expect(view.shadowRoot!.querySelectorAll('button')).toHaveLength(1);
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
    expect(view.shadowRoot!.querySelectorAll('button')).toHaveLength(2);
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
    expect(view.shadowRoot!.querySelectorAll('button')).toHaveLength(1);
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
    const buttons = view.shadowRoot!.querySelectorAll<HTMLButtonElement>('button');
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
    view.shadowRoot!.querySelector<HTMLButtonElement>('button')!.click();
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
    const frame = view.shadowRoot!.querySelector('iframe')!;
    const resize = async (height: unknown, source = frame.contentWindow) => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'openclaw:widget-size', height },
          origin: new URL(frame.src).origin,
          source,
        }),
      );
      await settle(view);
    };
    await resize(72.5);
    expect(frame.style.height).toBe('73px');
    await resize(24);
    expect(frame.style.height).toBe('48px');
    await resize(2600);
    expect(frame.style.height).toBe('2600px');
    await resize(9000);
    expect(frame.style.height).toBe('8000px');
    for (const invalid of [0, -1, NaN, Infinity, '200']) await resize(invalid);
    await resize(200, window);
    expect(frame.style.height).toBe('8000px');

    view.preview = preview('widget-2');
    await settle(view);
    const replacement = view.shadowRoot!.querySelector('iframe')!;
    expect(replacement).not.toBe(frame);
    expect(replacement.style.height).toBe('420px');
    await resize(600);
    expect(replacement.style.height).toBe('420px');
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
    expect(port.close).toHaveBeenCalledOnce();
    expect(
      post.mock.calls.some(
        call => call[0]?.type === 'openclaw:scenario-draft-policy' && call[0].available === false,
      ),
    ).toBe(true);
  });
});
