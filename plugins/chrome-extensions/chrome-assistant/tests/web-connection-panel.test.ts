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
function mount() {
  document.body.innerHTML =
    '<section id="webConnectionCard" class="hidden"></section><textarea id="prompt">Existing draft</textarea>';
  const order: string[] = [];
  const permission = vi.fn(async (_value: unknown) => true);
  const request = vi.fn(
    async (_type: string, _params: unknown): Promise<Record<string, unknown>> => {
      order.push('decide');
      return { ok: true, connectionPending: pending({ revision: 2, status: 'connected' }) };
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
  });
  panels.push(panel);
  panel.accept(pending());
  return { panel, permission, request, order };
}

describe('website connection consent', () => {
  it('shows the verified exact origin without changing an existing composer or granting other permissions', () => {
    const { request } = mount();
    expect(document.getElementById('webConnectionCard')?.textContent).toContain(
      'https://business.internal:8443',
    );
    expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe('Existing draft');
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
  });

  it('requests Chrome access in the click stack before deciding connection only', async () => {
    const { permission, request, order } = mount();
    button('Allow connection').click();
    expect(permission).toHaveBeenCalledWith({ origins: ['https://business.internal/*'] });
    expect(request).not.toHaveBeenCalled();
    button('Allow connection').click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledExactlyOnceWith(WebConnectionMessage.Decide, {
        pendingId: 'connection-one',
        expectedRevision: 1,
        decision: 'allow',
      }),
    );
    expect(order).toEqual(['permission', 'decide']);
    expect(document.body.textContent).toContain('Website connected.');
    expect((document.getElementById('prompt') as HTMLTextAreaElement).value).toBe('Existing draft');
  });

  it('records a denied Chrome prompt as rejection without an allow', async () => {
    const { permission, request } = mount();
    permission.mockResolvedValue(false);
    request.mockResolvedValue({
      ok: true,
      connectionPending: pending({ revision: 2, status: 'rejected' }),
    });
    button('Allow connection').click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(WebConnectionMessage.Decide, {
        pendingId: 'connection-one',
        expectedRevision: 1,
        decision: 'deny',
        reason: 'permission-denied',
      }),
    );
    expect(document.body.textContent).toContain('Connection rejected. This request was not sent.');
  });

  it('rejects without requesting Chrome permission', async () => {
    const { permission, request } = mount();
    button('Reject').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith(WebConnectionMessage.Decide, {
      pendingId: 'connection-one',
      expectedRevision: 1,
      decision: 'deny',
    });
    expect(permission).not.toHaveBeenCalled();
  });

  it('does not approve after rejection while the Chrome permission prompt is unresolved', async () => {
    const { permission, request } = mount();
    let release!: (value: boolean) => void;
    permission.mockImplementation(() => new Promise(resolve => (release = resolve)));
    button('Allow connection').click();
    button('Reject').click();
    release(true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request.mock.calls[0][1]).toMatchObject({ decision: 'deny' });
  });

  it.each(['navigation', 'revision'])(
    'ignores a delayed permission after %s invalidates the original consent',
    async kind => {
      const { panel, permission, request } = mount();
      let release!: (value: boolean) => void;
      permission.mockImplementation(() => new Promise(resolve => (release = resolve)));
      button('Allow connection').click();
      panel.accept(kind === 'navigation' ? null : pending({ revision: 2 }));
      release(true);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it('does not turn a connection failure or missing acknowledgement into success', async () => {
    const { request } = mount();
    request.mockRejectedValue(
      Object.assign(new Error('secret=private'), { code: 'APP_NOT_RUNNING' }),
    );
    button('Allow connection').click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Open the desktop application'),
    );
    expect(document.body.textContent).not.toContain('Website connected.');
    expect(document.body.textContent).not.toContain('private');
    request.mockResolvedValue({ ok: true });
    button('Allow connection').click();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).not.toContain('Website connected.');
  });

  it('expires an unresolved consent without extending its deadline or approving a late permission', async () => {
    vi.useFakeTimers();
    const { panel, permission, request } = mount();
    let release!: (value: boolean) => void;
    permission.mockImplementation(() => new Promise(resolve => (release = resolve)));
    panel.accept(pending({ revision: 2, expiresAt: Date.now() + 1_000 }));
    button('Allow connection').click();
    await vi.advanceTimersByTimeAsync(1_001);
    release(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Connection request expired.');
    expect(button('Allow connection').hidden).toBe(true);
  });

  it('cannot approve an in-progress or stale terminal consent, but can reject an in-progress one', () => {
    const { panel, permission, request } = mount();
    panel.accept(pending({ revision: 3, status: 'granting' }));
    panel.accept(pending({ revision: 2 }));
    expect(button('Allow connection').disabled).toBe(true);
    expect(button('Reject').disabled).toBe(false);
    button('Allow connection').click();
    expect(permission).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    panel.accept(pending({ revision: 4, status: 'cancelled' }));
    expect(document.body.textContent).toContain('Connection request cancelled.');
    expect(button('Allow connection').hidden).toBe(true);
  });
});
