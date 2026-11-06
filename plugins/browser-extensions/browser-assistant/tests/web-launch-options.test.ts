// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWebLaunchOptions,
  parseWebLaunchOrigin,
  WebLaunchOptionsMessage as Message,
} from '../conversation-overlay/modules/web-launch-options.js';

const views: ReturnType<typeof createWebLaunchOptions>[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  [...document.querySelectorAll('button')].find(node => node.textContent === text)!;
async function mount() {
  document.body.innerHTML = '<section id="webLaunchSites"></section>';
  const policies: any[] = [];
  const permission = vi.fn(async () => true);
  const order: string[] = [];
  const sendMessage = vi.fn(async (message: any): Promise<any> => {
    order.push(message.type);
    if (message.type === Message.List)
      return { ok: true, sitesRevision: 7, policies: [...policies] };
    if (message.type === Message.Observations) return { ok: true, observations: [] };
    if (message.type === Message.Save) {
      policies.push(message);
      return { ok: true };
    }
    return { ok: true };
  });
  const confirm = vi.fn(() => true);
  const removePermission = vi.fn();
  const view = createWebLaunchOptions({
    document,
    confirm,
    chrome: {
      runtime: { sendMessage },
      permissions: {
        request: (value: unknown) => {
          order.push('permission');
          return permission(value);
        },
        remove: removePermission,
      },
    },
  });
  views.push(view);
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: Message.List }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const input = document.getElementById('webLaunchOrigin') as HTMLInputElement;
  const setOrigin = (value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  return {
    view,
    policies,
    sendMessage,
    permission,
    removePermission,
    order,
    confirm,
    input,
    setOrigin,
  };
}

describe('website launch options', () => {
  it('requests the required Chrome host permission directly in the click before saving exact origin', async () => {
    const { setOrigin, permission, sendMessage, order } = await mount();
    setOrigin('https://business.internal:8443');
    button('Add website and authorize Chrome access').click();
    expect(permission).toHaveBeenCalledWith({ origins: ['https://business.internal/*'] });
    expect(sendMessage.mock.calls.some(([value]) => value.type === Message.Save)).toBe(false);
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: Message.Save,
        expectedRevision: 7,
        origin: 'https://business.internal:8443',
        enabled: true,
        allowSend: false,
        allowResult: false,
      }),
    );
    expect(order.indexOf('permission')).toBeLessThan(order.indexOf(Message.Save));
    expect(document.body.textContent).toContain('Refresh its open page');
  });

  it('does not save a website when Chrome permission was denied', async () => {
    const { setOrigin, permission, sendMessage } = await mount();
    permission.mockResolvedValue(false);
    setOrigin('http://intranet.internal:8080');
    button('Add website and authorize Chrome access').click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Chrome access was not granted'),
    );
    expect(sendMessage.mock.calls.some(([value]) => value.type === Message.Save)).toBe(false);
  });

  it.each([
    'file:///tmp/a',
    'https://name:password@internal.test',
    'https://internal.test/path',
    'https://internal.test/?token=secret',
    'https://internal.test/#fragment',
  ])('rejects a non-origin input: %s', value =>
    expect(() => parseWebLaunchOrigin(value)).toThrow(),
  );

  it('revokes only the site policy without deleting shared Chrome permissions', async () => {
    const { view, policies, sendMessage, removePermission } = await mount();
    policies.push({
      origin: 'https://internal.test',
      enabled: true,
      allowSend: true,
      allowResult: true,
    });
    await view.refresh();
    button('Revoke website access').click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: Message.Save,
        expectedRevision: 7,
        origin: 'https://internal.test',
        enabled: false,
        allowSend: false,
        allowResult: false,
      }),
    );
    expect(removePermission).not.toHaveBeenCalled();
  });

  it('allows explicit abandonment of unknown observation without a stop command', async () => {
    const { view, sendMessage, confirm } = await mount();
    sendMessage.mockImplementation(async message =>
      message.type === Message.Observations
        ? {
            ok: true,
            observations: [
              {
                origin: 'https://internal.test',
                receipt: { launchId: 'unknown-one', execution: { status: 'unknown' } },
              },
            ],
          }
        : { ok: true, sitesRevision: 7, policies: [] },
    );
    await view.refresh();
    button('Unlink and stop observing').click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: Message.Abandon,
        launchId: 'unknown-one',
        confirm: true,
      }),
    );
    expect(confirm).toHaveBeenCalled();
    expect(sendMessage.mock.calls.some(([value]) => value.type.includes(':stop'))).toBe(false);
  });

  it('shows safe errors and does not automatically retry a conflicted write', async () => {
    const { setOrigin, sendMessage } = await mount();
    sendMessage.mockImplementation(async message =>
      message.type === Message.Save
        ? { ok: false, code: 'REVISION_CONFLICT', error: 'secret=private' }
        : { ok: true, sitesRevision: 8, policies: [] },
    );
    setOrigin('https://internal.test');
    button('Add website and authorize Chrome access').click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Settings changed while you were editing'),
    );
    expect(sendMessage.mock.calls.filter(([value]) => value.type === Message.Save)).toHaveLength(1);
    expect(document.body.textContent).not.toContain('private');
  });
});
