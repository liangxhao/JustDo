// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const optionsHtml = fs.readFileSync(
  path.resolve(__dirname, '../../resources/browser-extension/conversation-overlay/options.html'),
  'utf8',
);
type Status = {
  paired: boolean;
  state: string;
  accessMode: string;
  nativeBootstrap: { disabled: boolean; state: string };
  retiredCopilotCustodyBlocked?: boolean;
};
let status: Status;
let sendMessage: ReturnType<typeof vi.fn>;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const textarea = () => document.getElementById('pairingString') as HTMLTextAreaElement;
const accessMode = () => document.getElementById('accessMode') as HTMLSelectElement;

async function load() {
  await import('../../resources/browser-extension/conversation-overlay/options.js');
  await vi.waitFor(() => expect(button('useLocal').disabled).toBe(false));
}

describe('product browser settings', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    document.body.innerHTML = optionsHtml;
    status = {
      paired: true,
      state: 'on',
      accessMode: 'selected',
      nativeBootstrap: { disabled: false, state: 'ready' },
    };
    sendMessage = vi.fn(async (request: { type: string }) => {
      if (request.type === 'getStatus') return { ...status };
      if (request.type === 'unpair') {
        status = {
          ...status,
          paired: false,
          state: 'off',
          nativeBootstrap: { disabled: true, state: 'disabled' },
        };
      }
      return { ok: true };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
  });
  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'));
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the original English vocabulary even when Chrome uses Chinese', async () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');

    await load();

    expect(document.documentElement.lang).toBe('en');
    expect(document.getElementById('automaticTitle')?.textContent).toBe('Automatic connection');
    expect(document.getElementById('manualTitle')?.textContent).toBe('Manual connection');
    expect(button('useLocal').textContent).toBe('Use local __PRODUCT_NAME__');
    expect(button('pair').textContent).toBe('Pair manually');
    expect(textarea().placeholder).toBe('Paste the pairing string');
    expect(document.body.textContent).not.toMatch(/[\u3400-\u9fff]/);
  });

  it('enables native automatic setup and refreshes the connection state', async () => {
    status.paired = false;
    status.nativeBootstrap = { disabled: true, state: 'disabled' };
    await load();

    button('useLocal').click();

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'setNativeBootstrapEnabled',
        enabled: true,
      }),
    );
    expect(document.body.textContent).not.toMatch(/openclaw/i);
  });

  it.each(['disconnectAutomatic', 'disconnectManual'])(
    'disconnects and stops automatic reconnection from %s',
    async id => {
      await load();

      button(id).click();

      await vi.waitFor(() => expect(button('useLocal').disabled).toBe(false));
      expect(sendMessage).toHaveBeenCalledWith({ type: 'unpair' });
      expect(button('disconnectManual').disabled).toBe(true);
      expect(button('useLocal').disabled).toBe(false);
      expect(accessMode().disabled).toBe(true);
    },
  );

  it('allows cancelling automatic discovery before pairing exists', async () => {
    status.paired = false;
    status.nativeBootstrap.state = 'retrying';
    await load();

    expect(button('disconnectAutomatic').disabled).toBe(false);
    button('disconnectAutomatic').click();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'unpair' }));
  });

  it('clears pairing information only after successful native pairing', async () => {
    await load();
    textarea().value = 'private-pairing-fixture';
    textarea().dispatchEvent(new Event('input'));

    button('pair').click();

    await vi.waitFor(() => expect(textarea().value).toBe(''));
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'pair',
      pairingString: 'private-pairing-fixture',
      accessMode: 'selected',
    });
    expect(document.getElementById('message')?.textContent).not.toContain(
      'private-pairing-fixture',
    );
  });

  it('retains pairing information on failure and shows a localized error without raw credentials', async () => {
    await load();
    sendMessage.mockImplementation(async (request: { type: string }) =>
      request.type === 'getStatus'
        ? status
        : { ok: false, error: 'OpenClaw error with private-pairing-fixture' },
    );
    textarea().value = 'private-pairing-fixture';
    textarea().dispatchEvent(new Event('input'));

    button('pair').click();

    await vi.waitFor(() => expect(button('pair').disabled).toBe(false));
    expect(textarea().value).toBe('private-pairing-fixture');
    expect(document.getElementById('message')?.dataset.error).toBe('true');
    expect(document.getElementById('message')?.textContent).not.toMatch(
      /openclaw|private-pairing-fixture/i,
    );
  });

  it('keeps native custody protection and allows an explicit disconnect', async () => {
    status.retiredCopilotCustodyBlocked = true;
    await import('../../resources/browser-extension/conversation-overlay/options.js');
    await vi.waitFor(() =>
      expect(document.getElementById('retiredCustody')?.classList.contains('hidden')).toBe(false),
    );

    expect(button('useLocal').disabled).toBe(true);
    expect(button('pair').disabled).toBe(true);
    expect(textarea().disabled).toBe(true);
    expect(accessMode().disabled).toBe(true);
    expect(button('disconnectAutomatic').disabled).toBe(false);
    expect(button('disconnectManual').disabled).toBe(false);
  });

  it('uses native tab access mutation and restores the authoritative choice on failure', async () => {
    await load();
    sendMessage.mockImplementation(async (request: { type: string }) =>
      request.type === 'getStatus' ? status : { ok: false },
    );
    accessMode().value = 'all';

    accessMode().dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(accessMode().value).toBe('selected'));
    expect(sendMessage).toHaveBeenCalledWith({ type: 'setAccessMode', accessMode: 'all' });
  });

  it('rejects late status responses from before a disconnect', async () => {
    await load();
    let resolveStatus!: (value: Status) => void;
    sendMessage.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveStatus = resolve;
        }),
    );
    document.dispatchEvent(new Event('visibilitychange'));
    button('disconnectAutomatic').click();
    await vi.waitFor(() => expect(button('useLocal').disabled).toBe(false));

    resolveStatus({ ...status, paired: true });
    await Promise.resolve();

    expect(button('disconnectManual').disabled).toBe(true);
  });
});
