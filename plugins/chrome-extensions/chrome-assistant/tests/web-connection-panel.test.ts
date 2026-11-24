// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWebConnectionPanel,
  WebConnectionMessage,
} from '../conversation-overlay/modules/web-connection-panel.js';

const panels: ReturnType<typeof createWebConnectionPanel>[] = [];
afterEach(() => {
  for (const panel of panels.splice(0)) panel.dispose();
  vi.useRealTimers();
});

const pending = (extra = {}) => ({
  pendingId: 'connection-one',
  revision: 1,
  origin: 'https://business.internal:8443',
  expiresAt: Date.now() + 60_000,
  status: 'awaiting-consent',
  ...extra,
});
const button = (name: string) =>
  [...document.querySelectorAll('button')].find(node => node.textContent === name)!;
const card = () => document.getElementById('webConnectionCard')!;
function mount() {
  document.body.innerHTML =
    '<section id="webConnectionCard" class="hidden"></section><textarea id="prompt">Existing draft</textarea>';
  const order: string[] = [];
  const onNotice = vi.fn();
  const permission = vi.fn(async (_value: unknown) => true);
  const request = vi.fn(
    async (
      _type: string,
      params: { decision: 'allow' | 'deny' },
    ): Promise<Record<string, unknown>> => {
      order.push('decide');
      return {
        ok: true,
        connectionPending: pending({
          revision: 2,
          status: params.decision === 'allow' ? 'connected' : 'rejected',
        }),
      };
    },
  );
  const panel = createWebConnectionPanel({
    document,
    chrome: {
      permissions: {
        request: (value: unknown) => {
          order.push('permission');
          return permission(value);
        },
      },
    },
    request,
    onNotice,
  });
  panels.push(panel);
  panel.accept(pending());
  return { panel, permission, request, order, onNotice };
}

describe('website connection consent', () => {
  it('leaves the composer available while consent is waiting and shows the prompt when it is ready', () => {
    const { panel, permission, request, onNotice } = mount();
    panel.accept(pending({ revision: 2, status: 'waiting-for-window', requiresAction: false }));
    expect(card().classList.contains('hidden')).toBe(true);
    expect(onNotice).not.toHaveBeenCalled();

    panel.accept(pending({ revision: 3, requiresAction: true }));
    expect(card().classList.contains('hidden')).toBe(false);
    expect(button('Allow connection').disabled).toBe(false);
    expect(permission).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('discloses the exact origin, first draft, and later click scope before approval', () => {
    const { request } = mount();
    const copy = document.getElementById('webConnectionCard')?.textContent;
    expect(copy).toContain('https://business.internal:8443');
    expect(copy).toContain('This request opens as a draft for you to send.');
    expect(copy).toContain(
      'On later clicks, the default is to follow this website’s choice of opening a draft or sending directly.',
    );
    expect(copy).toContain('The website can receive the result it requests.');
    expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe('Existing draft');
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
  });

  it('requests Chrome access in the click stack before the trusted connection decision', async () => {
    const { permission, request, order, onNotice } = mount();
    button('Allow connection').click();
    expect(permission).toHaveBeenCalledWith({ origins: ['https://business.internal/*'] });
    expect(request).toHaveBeenCalledExactlyOnceWith(WebConnectionMessage.Decide, {
      pendingId: 'connection-one',
      expectedRevision: 1,
      decision: 'allow',
    });
    button('Allow connection').click();
    expect(order).toEqual(['permission', 'decide']);
    await vi.waitFor(() => expect(card().classList.contains('hidden')).toBe(true));
    expect(onNotice).not.toHaveBeenCalled();
    expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe('Existing draft');
  });

  it('hands off approval before the panel closes during the Chrome prompt', async () => {
    const { panel, permission, request } = mount();
    let release!: (value: boolean) => void;
    permission.mockImplementation(() => new Promise(resolve => (release = resolve)));
    button('Allow connection').click();
    panel.dispose();
    expect(request).toHaveBeenCalledExactlyOnceWith(WebConnectionMessage.Decide, {
      pendingId: 'connection-one',
      expectedRevision: 1,
      decision: 'allow',
    });
    release(true);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects the same request if Chrome denies permission after the allow intent', async () => {
    const { permission, request, onNotice } = mount();
    let release!: (value: boolean) => void;
    permission.mockImplementation(() => new Promise(resolve => (release = resolve)));
    request
      .mockResolvedValueOnce({
        ok: true,
        connectionPending: pending({ revision: 2, status: 'granting' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        connectionPending: pending({
          revision: 3,
          status: 'rejected',
          code: 'PERMISSION_REQUIRED',
        }),
      });
    button('Allow connection').click();
    await vi.waitFor(() => expect(button('Allow connection').disabled).toBe(true));
    release(false);
    await vi.waitFor(() =>
      expect(request).toHaveBeenNthCalledWith(2, WebConnectionMessage.Decide, {
        pendingId: 'connection-one',
        expectedRevision: 1,
        decision: 'deny',
        reason: 'permission-denied',
      }),
    );
    expect(card().classList.contains('hidden')).toBe(true);
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      'Chrome access was not granted. Website access has not been approved.',
    );
  });

  it('rejects without requesting Chrome permission', async () => {
    const { permission, request, onNotice } = mount();
    button('Reject').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith(WebConnectionMessage.Decide, {
      pendingId: 'connection-one',
      expectedRevision: 1,
      decision: 'deny',
    });
    expect(permission).not.toHaveBeenCalled();
    expect(card().classList.contains('hidden')).toBe(true);
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      'Connection rejected. This request was not sent.',
    );
  });

  it('lets explicit rejection take precedence over the unresolved Chrome permission prompt', async () => {
    const { permission, request } = mount();
    let release!: (value: boolean) => void;
    permission.mockImplementation(() => new Promise(resolve => (release = resolve)));
    button('Allow connection').click();
    button('Reject').click();
    release(false);
    await vi.waitFor(() => expect(card().classList.contains('hidden')).toBe(true));
    expect(request.mock.calls.map(([, { decision }]) => decision)).toEqual(['allow', 'deny']);
    expect(request.mock.calls[1][1]).not.toHaveProperty('reason');
  });

  it.each(['navigation', 'revision'])(
    'ignores a delayed permission denial after %s invalidates the original consent',
    async kind => {
      const { panel, permission, request } = mount();
      let release!: (value: boolean) => void;
      permission.mockImplementation(() => new Promise(resolve => (release = resolve)));
      button('Allow connection').click();
      panel.accept(kind === 'navigation' ? null : pending({ revision: 2 }));
      release(false);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][1]).toMatchObject({ decision: 'allow' });
    },
  );

  it('does not turn a connection failure or missing acknowledgement into success', async () => {
    const { request, onNotice } = mount();
    request.mockRejectedValue(
      Object.assign(new Error('secret=private'), { code: 'APP_NOT_RUNNING' }),
    );
    button('Allow connection').click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Open the desktop application'),
    );
    expect(card().classList.contains('hidden')).toBe(false);
    expect(document.body.textContent).not.toContain('private');
    request.mockResolvedValue({ ok: true });
    button('Allow connection').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(card().classList.contains('hidden')).toBe(false);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it('expires an unresolved consent at its original deadline and ignores late Chrome denial', async () => {
    vi.useFakeTimers();
    const { panel, permission, request, onNotice } = mount();
    let release!: (value: boolean) => void;
    permission.mockImplementation(() => new Promise(resolve => (release = resolve)));
    const expiresAt = Date.now() + 1_000;
    panel.accept(pending({ revision: 2, expiresAt }));
    request.mockResolvedValueOnce({
      ok: true,
      connectionPending: pending({ revision: 3, status: 'granting', expiresAt }),
    });
    button('Allow connection').click();
    await vi.advanceTimersByTimeAsync(1_001);
    release(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(card().classList.contains('hidden')).toBe(true);
    panel.accept(pending({ revision: 3, status: 'expired' }));
    panel.accept(pending({ revision: 3, status: 'awaiting-consent' }));
    expect(card().classList.contains('hidden')).toBe(true);
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      'Connection request expired. Click the website button again to start a new request.',
    );
  });

  it('cannot approve an in-progress or stale terminal consent, but can reject an in-progress one', () => {
    const { panel, permission, request, onNotice } = mount();
    panel.accept(pending({ revision: 3, status: 'granting' }));
    panel.accept(pending({ revision: 2 }));
    expect(button('Allow connection').disabled).toBe(true);
    expect(button('Reject').disabled).toBe(false);
    button('Allow connection').click();
    expect(permission).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    panel.accept(pending({ revision: 4, status: 'cancelled' }));
    expect(card().classList.contains('hidden')).toBe(true);
    expect(onNotice).toHaveBeenCalledExactlyOnceWith(
      'Connection request cancelled. This request was not sent.',
    );
  });
});
