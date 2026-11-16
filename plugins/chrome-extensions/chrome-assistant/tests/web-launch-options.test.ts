// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWebLaunchOptions,
  WebLaunchOptionsMessage as Message,
} from '../conversation-overlay/modules/web-launch-options.js';

const views: ReturnType<typeof createWebLaunchOptions>[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  [...document.querySelectorAll('button')].find(node => node.textContent === text)!;
const site = {
  origin: 'https://internal.test:8443',
  enabled: true,
  allowSend: false,
  allowResult: false,
};
type SettingsMessage = { type: string; sendMode?: string } & Partial<typeof site>;
async function mount(initial: (typeof site)[] = [], initialMode?: string) {
  document.body.innerHTML = '<section id="webLaunchSites"></section>';
  const policies = initial.map(value => ({ ...value }));
  let sendMode = initialMode;
  let revision = 7;
  const permission = vi.fn();
  const sendMessage = vi.fn(async (message: SettingsMessage): Promise<Record<string, unknown>> => {
    if (message.type === Message.List)
      return { ok: true, sitesRevision: revision, policies: [...policies], sendMode };
    if (message.type === Message.Observations) return { ok: true, observations: [] };
    if (message.type === Message.SendMode) {
      sendMode = message.sendMode;
      revision += 1;
      return { ok: true, sitesRevision: revision, sendMode };
    }
    if (message.type === Message.Save) {
      const index = policies.findIndex(value => value.origin === message.origin);
      if (index >= 0) policies[index] = { ...policies[index], ...message };
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
      permissions: { request: permission, remove: removePermission },
    },
  });
  views.push(view);
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: Message.List }));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { view, policies, sendMessage, permission, removePermission, confirm };
}

describe('website launch options', () => {
  it('offers one global selector and saves with no connected websites', async () => {
    const { permission, sendMessage } = await mount();
    expect(document.body.textContent).toContain('Click the conversation button on a website');
    expect(document.body.textContent).toContain('No connected websites.');
    expect(document.querySelector('input[type="url"]')).toBeNull();
    expect(document.querySelectorAll('input')).toHaveLength(0);
    expect(permission).not.toHaveBeenCalled();
    const mode = document.querySelector<HTMLSelectElement>('#webLaunchSendMode')!;
    expect(mode.labels?.[0].textContent).toBe('Website message sending mode');
    expect([...mode.options].map(option => option.textContent)).toEqual([
      'Follow website (default)',
      'Send directly',
      'Open as draft',
    ]);
    expect(mode.value).toBe('website');
    expect(mode.disabled).toBe(false);
    mode.focus();
    mode.value = 'draft';
    mode.dispatchEvent(new Event('change'));
    expect(mode.disabled).toBe(true);
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: Message.SendMode,
      expectedRevision: 7,
      sendMode: 'draft',
    });
    await vi.waitFor(() => expect(mode.disabled).toBe(false));
    expect(mode.value).toBe('draft');
    expect(document.activeElement).toBe(mode);
  });

  it('lists sites for revocation and directs legacy partial grants to reconfirm from the website', async () => {
    const connected = {
      ...site,
      origin: 'https://approved.test',
      allowSend: true,
      allowResult: true,
    };
    const { sendMessage, permission } = await mount(
      [{ ...site, allowSend: true }, connected],
      'send',
    );
    expect(document.querySelectorAll('select')).toHaveLength(1);
    expect(document.querySelector<HTMLSelectElement>('#webLaunchSendMode')?.value).toBe('send');
    const rows = [...document.querySelectorAll('.web-launch-site-access')];
    expect(rows.map(row => row.querySelector('strong')?.textContent)).toEqual([
      connected.origin,
      site.origin,
    ]);
    expect(rows[0].querySelector('p')).toBeNull();
    expect(rows[1].textContent).toContain(
      'Click the website’s conversation button to confirm access again.',
    );
    for (const row of rows) {
      expect(row.querySelector('input, select')).toBeNull();
      expect([...row.querySelectorAll('button')].map(button => button.textContent)).toEqual([
        'Revoke website access',
      ]);
    }
    expect(sendMessage.mock.calls.some(([value]) => value.type === Message.Save)).toBe(false);
    expect(permission).not.toHaveBeenCalled();
  });

  it('revokes all site permissions without deleting shared Chrome permissions', async () => {
    const { sendMessage, removePermission } = await mount([
      { ...site, allowSend: true, allowResult: true },
    ]);
    button('Revoke website access').click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: Message.Save,
        expectedRevision: 7,
        origin: site.origin,
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
                origin: site.origin,
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

  it('shows safe errors without retrying a conflicted write or claiming success', async () => {
    const { sendMessage } = await mount([site]);
    sendMessage.mockImplementation(async message =>
      message.type === Message.Save
        ? { ok: false, code: 'POLICY_CONFLICT', error: 'secret=private' }
        : { ok: true, sitesRevision: 8, policies: [site] },
    );
    button('Revoke website access').click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Settings changed while you were editing'),
    );
    expect(sendMessage.mock.calls.filter(([value]) => value.type === Message.Save)).toHaveLength(1);
    expect(document.body.textContent).not.toContain('private');
    expect(document.body.textContent).not.toContain('Website permissions saved.');
  });

  it('disables stale site controls while the desktop application is unavailable', async () => {
    const { view, sendMessage } = await mount([site]);
    sendMessage.mockResolvedValue({ ok: false, code: 'APP_NOT_RUNNING' });
    await view.refresh();
    expect(button('Revoke website access').disabled).toBe(true);
    expect(document.querySelector<HTMLSelectElement>('#webLaunchSendMode')?.disabled).toBe(true);
    expect(document.body.textContent).toContain('Check that the desktop application is running');
  });
});
