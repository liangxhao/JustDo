// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createWebLaunchPanel,
  WebLaunchPanelMessage as Message,
} from '../conversation-overlay/modules/web-launch-panel.js';

const panels: ReturnType<typeof createWebLaunchPanel>[] = [];
afterEach(() => {
  for (const panel of panels.splice(0)) panel.dispose();
  vi.restoreAllMocks();
});

const envelope = (overrides: Record<string, unknown> = {}) => ({
  launchId: 'launch-one',
  requestId: 'request-one',
  origin: 'https://business.internal:8443',
  threadId: 'external-thread',
  mode: 'draft',
  result: 'none',
  prompt: 'Website prompt',
  contextText: 'Business snapshot',
  expiresAt: Date.now() + 60_000,
  automaticSendAllowed: false,
  shareAllowed: false,
  composeRevision: 1,
  receipt: {
    launchId: 'launch-one',
    requestId: 'request-one',
    receiptRevision: 1,
    request: { status: 'drafted' },
    execution: { status: 'not-started', executionSettled: false },
    output: { status: 'not-requested' },
    delivery: { status: 'connected' },
  },
  ...overrides,
});
async function mount(options: Record<string, unknown> = {}, initial = {}, registrationExtra = {}) {
  document.body.innerHTML =
    '<section id="webConnectionCard" class="hidden"></section><section id="webLaunchCard" class="hidden"></section>';
  const input = envelope(options);
  const composer = {
    prompt: '',
    threadId: 'existing-thread',
    modelRef: 'product/default',
    permissionMode: 'full',
    attachments: 0,
    attachmentReads: 0,
    ready: true,
    ...initial,
  };
  let listener = (_message: any) => {};
  let registration: any;
  const sendMessage = vi.fn(async (message: any): Promise<any> => {
    if (message.type === Message.Register) {
      registration = message;
      return { ok: true, envelope: input, ...registrationExtra };
    }
    if (message.type === Message.Submit)
      return {
        ok: true,
        receipt: {
          ...input.receipt,
          receiptRevision: 2,
          request: { status: 'submitted' },
          execution: { status: 'running', executionSettled: false },
        },
        internal: {
          threadId: input.threadId,
          clientTurnId: 'client-turn',
          nativeRunId: 'native-run',
        },
      };
    if (message.type === Message.Revise)
      return {
        ok: true,
        receipt: input.receipt,
        internal: { composeRevision: message.expectedComposeRevision + 1 },
      };
    if (message.type === Message.Cancel)
      return {
        ok: true,
        receipt: { ...input.receipt, receiptRevision: 2, request: { status: 'cancelled' } },
      };
    return { ok: true };
  });
  const installComposer = vi.fn((next: any) => {
    if (next.clearPrompt) composer.prompt = '';
    for (const key of ['prompt', 'threadId', 'permissionMode'])
      if (next[key] !== undefined) (composer as any)[key] = next[key];
  });
  const confirm = vi.fn(() => true);
  const panel = createWebLaunchPanel({
    document,
    chrome: {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (handler: any) => {
            listener = handler;
          },
          removeListener: vi.fn(),
        },
      },
      windows: { getCurrent: async () => ({ id: 4 }) },
    },
    readComposer: () => composer,
    installComposer,
    confirm,
  });
  panels.push(panel);
  await vi.waitFor(() => expect(registration).toBeDefined());
  await new Promise(resolve => setTimeout(resolve, 0));
  return {
    panel,
    composer,
    input,
    sendMessage,
    installComposer,
    confirm,
    emit: (response: any) =>
      listener({
        type: Message.Event,
        panelInstanceId: registration.panelInstanceId,
        windowId: 4,
        ...response,
      }),
  };
}
const calls = (mock: ReturnType<typeof vi.fn>, type: string) =>
  mock.mock.calls.map(args => args[0]).filter(message => message.type === type);

describe('website launch panel', () => {
  it('keeps a newer connection event when an older cold registration reply arrives', async () => {
    document.body.innerHTML =
      '<section id="webConnectionCard" class="hidden"></section><section id="webLaunchCard" class="hidden"></section>';
    let listener = (_message: Record<string, unknown>) => {};
    let registration: Record<string, unknown> = {};
    let respond!: (value: Record<string, unknown>) => void;
    const panel = createWebLaunchPanel({
      document,
      chrome: {
        windows: { getCurrent: async () => ({ id: 4 }) },
        runtime: {
          sendMessage: (message: Record<string, unknown>) => {
            if (message.type === Message.Register) {
              registration = message;
              return new Promise(resolve => {
                respond = resolve;
              });
            }
            return Promise.resolve({ ok: true });
          },
          onMessage: {
            addListener: (handler: typeof listener) => {
              listener = handler;
            },
            removeListener: vi.fn(),
          },
        },
      },
      readComposer: () => ({ prompt: '', ready: false }),
      installComposer: vi.fn(),
    });
    panels.push(panel);
    await vi.waitFor(() => expect(respond).toBeDefined());
    listener({
      type: Message.Event,
      panelInstanceId: registration.panelInstanceId,
      windowId: 4,
      connectionPending: {
        pendingId: 'newer',
        revision: 2,
        origin: 'https://business.internal:8443',
        expiresAt: Date.now() + 60_000,
        status: 'awaiting-consent',
      },
    });
    respond({ ok: true, connectionPending: null });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.getElementById('webConnectionCard')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('webConnectionCard')?.textContent).toContain(
      'https://business.internal:8443',
    );
  });

  it('shows connection consent on cold registration before Main or composer readiness', async () => {
    const { composer, installComposer, sendMessage } = await mount(
      {},
      { ready: false, prompt: 'Keep this draft' },
      {
        envelope: undefined,
        connectionPending: {
          pendingId: 'connection-one',
          revision: 1,
          origin: 'https://business.internal:8443',
          status: 'awaiting-consent',
          expiresAt: Date.now() + 60_000,
        },
      },
    );
    expect(document.getElementById('webConnectionCard')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('webConnectionCard')?.textContent).toContain(
      'https://business.internal:8443',
    );
    expect(installComposer).not.toHaveBeenCalled();
    expect(composer.prompt).toBe('Keep this draft');
    expect(calls(sendMessage, Message.Submit)).toHaveLength(0);
  });

  it('receives connection updates independently, then waits for manual send after connection', async () => {
    const { emit, installComposer, sendMessage, panel } = await mount(
      {},
      {},
      { envelope: undefined },
    );
    emit({
      connectionPending: {
        pendingId: 'connection-one',
        revision: 2,
        origin: 'https://business.internal:8443',
        status: 'connected',
        expiresAt: Date.now() + 60_000,
      },
    });
    expect(installComposer).not.toHaveBeenCalled();
    emit({
      envelope: envelope({
        mode: 'send',
        result: 'final',
        automaticSendAllowed: false,
        shareAllowed: false,
      }),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.getElementById('webConnectionCard')?.classList.contains('hidden')).toBe(true);
    expect(installComposer).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'ask' }),
    );
    expect(calls(sendMessage, Message.Submit)).toHaveLength(0);
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toHaveLength(1);
    expect(calls(sendMessage, Message.Submit)[0]).toMatchObject({ submission: 'confirmed' });
  });

  it('creates a separate guarded draft without sending or carrying previous full access', async () => {
    const { panel, composer, sendMessage, installComposer } = await mount();
    expect(composer.permissionMode).toBe('ask');
    expect(composer.prompt).toBe('Website prompt');
    expect(composer.threadId).toBe('external-thread');
    expect(installComposer).toHaveBeenCalledWith(expect.objectContaining({ includePage: false }));
    expect(panel.inputAssociated()).toBe(true);
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    expect(document.getElementById('webLaunchCard')?.textContent).toContain(
      'https://business.internal:8443',
    );
  });

  it.each([{ prompt: 'Unsent ordinary draft' }, { attachments: 1 }, { attachmentReads: 1 }])(
    'rejects a conflicting ordinary composer without changing it: %j',
    async initial => {
      const { composer, input, sendMessage, installComposer } = await mount({}, initial);
      expect(installComposer).not.toHaveBeenCalled();
      expect(calls(sendMessage, Message.Cancel)[0].launchId).toBe(input.launchId);
      expect(composer).toEqual(expect.objectContaining(initial));
    },
  );

  it.each(['none', 'final'])(
    'automatically submits authorized send + %s exactly once',
    async result => {
      const { panel, sendMessage } = await mount({
        mode: 'send',
        result,
        automaticSendAllowed: true,
        shareAllowed: true,
      });
      await vi.waitFor(() => expect(calls(sendMessage, Message.Submit)).toHaveLength(1));
      panel.ready();
      await panel.submit('confirmed');
      expect(calls(sendMessage, Message.Submit)).toHaveLength(1);
      expect(calls(sendMessage, Message.Submit)[0]).toEqual(
        expect.objectContaining({
          submission: 'automatic',
          shareResult: result === 'final',
          input: {
            prompt: 'Website prompt',
            context: { text: 'Business snapshot' },
            permissionMode: 'ask',
          },
        }),
      );
    },
  );

  it('requires human confirmation when result permission is missing, even if send is allowed', async () => {
    const { panel, sendMessage } = await mount({
      mode: 'send',
      result: 'final',
      automaticSendAllowed: true,
      shareAllowed: false,
    });
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)[0]).toEqual(
      expect.objectContaining({ submission: 'confirmed', shareResult: true }),
    );
  });

  it('waits for the latest revised input before allowing confirmed sending', async () => {
    const { panel, composer, sendMessage, input } = await mount();
    let resolveRevision!: (response: unknown) => void;
    sendMessage.mockImplementation(async (message: any) => {
      if (message.type === Message.Revise)
        return new Promise(resolve => {
          resolveRevision = resolve;
        });
      if (message.type === Message.Submit)
        return {
          ok: true,
          receipt: { ...input.receipt, receiptRevision: 3, request: { status: 'submitted' } },
        };
      return { ok: true };
    });
    composer.prompt = 'Actually edited';
    panel.edit();
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    expect(panel.blocked()).toBe(true);
    resolveRevision({ ok: true, receipt: input.receipt, internal: { composeRevision: 2 } });
    await vi.waitFor(() => expect(panel.blocked()).toBe(false));
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)[0]).toEqual(
      expect.objectContaining({
        composeRevision: 2,
        input: expect.objectContaining({ prompt: 'Actually edited', permissionMode: 'ask' }),
      }),
    );
  });

  it('can withdraw sharing and still submit only the message', async () => {
    const { panel, sendMessage } = await mount({ result: 'final' });
    const share = document.querySelector('.web-launch-choice input') as HTMLInputElement;
    share.checked = false;
    share.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(panel.blocked()).toBe(false));
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)[0].shareResult).toBe(false);
  });

  it('consumes receipt updates even when they include the same envelope', async () => {
    const { panel, input, emit } = await mount();
    emit({
      envelope: input,
      receipt: {
        ...input.receipt,
        receiptRevision: 3,
        request: { status: 'submitted' },
        execution: { status: 'running', executionSettled: false },
      },
    });
    expect(panel.inputAssociated()).toBe(false);
    expect(panel.ownsThread('external-thread')).toBe(true);
  });

  it('uses only the trusted launch Stop route and keeps Stop ACK nonterminal', async () => {
    const { panel, sendMessage } = await mount();
    await panel.stop();
    expect(calls(sendMessage, Message.Stop)).toHaveLength(1);
    expect(panel.inputAssociated()).toBe(true);
    expect(calls(sendMessage, 'turn/interrupt')).toEqual([]);
  });

  it('does not switch away from an external draft when confirmation is declined', async () => {
    const { panel, composer, confirm } = await mount();
    composer.threadId = 'other-thread';
    confirm.mockReturnValue(false);
    expect(await panel.beforeSwitch('other-thread')).toBe(false);
    expect(composer.threadId).toBe('external-thread');
  });

  it('requires a fresh unknown-task confirmation even for a trusted send site', async () => {
    const { panel, sendMessage } = await mount({
      mode: 'send',
      automaticSendAllowed: true,
      requiresUnknownConfirmation: true,
    });
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    const choices = document.querySelectorAll('.web-launch-choice input');
    (choices[3] as HTMLInputElement).checked = true;
    choices[3].dispatchEvent(new Event('change'));
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)[0].confirmNewTask).toBe(true);
  });

  it('restores a revised draft with ask/default and requires a new revision and human send', async () => {
    const { composer, panel, sendMessage } = await mount({
      mode: 'send',
      automaticSendAllowed: true,
      composeRevision: 2,
      restored: true,
    });
    await vi.waitFor(() => expect(calls(sendMessage, Message.Revise)).toHaveLength(1));
    expect(composer.permissionMode).toBe('ask');
    expect(calls(sendMessage, Message.Revise)[0].input).not.toHaveProperty('modelRef');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    await vi.waitFor(() => expect(panel.blocked()).toBe(false));
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)[0].submission).toBe('confirmed');
  });

  it('restores an already submitted observation without touching an ordinary draft', async () => {
    const sent = envelope().receipt;
    const { composer, panel, sendMessage, installComposer } = await mount(
      {
        receipt: {
          ...sent,
          request: { status: 'submitted' },
          execution: { status: 'running', executionSettled: false },
        },
      },
      { prompt: 'New ordinary draft', attachments: 1 },
    );
    expect(composer.prompt).toBe('New ordinary draft');
    expect(installComposer).not.toHaveBeenCalled();
    expect(panel.inputAssociated()).toBe(false);
    expect(calls(sendMessage, Message.Cancel)).toEqual([]);
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
  });

  it('can invalidate the pending automatic preparation while its submit ACK is outstanding', async () => {
    const { composer, panel, sendMessage, input } = await mount();
    let resolveSubmit!: (value: unknown) => void;
    sendMessage.mockImplementation(async (message: any) => {
      if (message.type === Message.Submit)
        return new Promise(resolve => {
          resolveSubmit = resolve;
        });
      if (message.type === Message.Revise)
        return { ok: true, receipt: input.receipt, internal: { composeRevision: 2 } };
      return { ok: true };
    });
    const submitting = panel.submit('confirmed');
    composer.prompt = 'Edited while preparing';
    panel.edit();
    await vi.waitFor(() => expect(calls(sendMessage, Message.Revise)).toHaveLength(1));
    resolveSubmit({ ok: false, code: 'COMPOSE_CONFLICT' });
    await submitting;
    expect(composer.prompt).toBe('Edited while preparing');
    const resubmitting = panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toHaveLength(2);
    resolveSubmit({
      ok: true,
      receipt: { ...input.receipt, receiptRevision: 3, request: { status: 'submitted' } },
    });
    await resubmitting;
  });

  it('reopens metadata-only running observations with trusted Stop and sharing cancellation', async () => {
    const original = envelope().receipt;
    const { sendMessage, composer } = await mount(
      {
        prompt: '',
        contextText: undefined,
        result: 'final',
        receipt: {
          ...original,
          request: { status: 'submitted' },
          execution: { status: 'running', executionSettled: false },
          output: { status: 'pending' },
        },
      },
      { prompt: 'Unrelated ordinary draft' },
    );
    const stop = [...document.querySelectorAll('button')].find(
      node => node.textContent === 'Stop',
    )!;
    const sharing = [...document.querySelectorAll('button')].find(
      node => node.textContent === 'Stop sharing results',
    )!;
    expect(stop.hidden).toBe(false);
    expect(sharing.hidden).toBe(false);
    stop.click();
    await vi.waitFor(() => expect(calls(sendMessage, Message.Stop)).toHaveLength(1));
    sharing.click();
    await vi.waitFor(() => expect(calls(sendMessage, Message.Cancel)).toHaveLength(1));
    await vi.waitFor(() =>
      expect(document.getElementById('webLaunchCard')?.classList.contains('hidden')).toBe(true),
    );
    expect(composer.prompt).toBe('Unrelated ordinary draft');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
  });

  it('lets a human abandon a restored unknown observation without claiming the task stopped', async () => {
    const original = envelope().receipt;
    const { sendMessage, confirm, composer } = await mount(
      {
        prompt: '',
        contextText: undefined,
        receipt: {
          ...original,
          request: { status: 'submitted' },
          execution: { status: 'unknown', executionSettled: false },
        },
      },
      { prompt: 'Ordinary input' },
    );
    const abandon = [...document.querySelectorAll('button')].find(
      node => node.textContent === 'Unlink and stop observing',
    )!;
    expect(abandon.hidden).toBe(false);
    abandon.click();
    await vi.waitFor(() => expect(calls(sendMessage, Message.Abandon)).toHaveLength(1));
    expect(calls(sendMessage, Message.Abandon)[0].confirm).toBe(true);
    expect(confirm).toHaveBeenCalled();
    expect(calls(sendMessage, Message.Stop)).toEqual([]);
    expect(composer.prompt).toBe('Ordinary input');
  });

  it('clears only its unchanged input when a pending cancellation is later confirmed', async () => {
    const { panel, composer, sendMessage, input, emit } = await mount();
    sendMessage.mockImplementation(async message =>
      message.type === Message.Cancel
        ? {
            ok: true,
            receipt: {
              ...input.receipt,
              receiptRevision: 2,
              request: { status: 'submitting' },
            },
          }
        : { ok: true },
    );
    const cancel = [...document.querySelectorAll('button')].find(
      node => node.textContent === 'Cancel website request',
    )!;
    cancel.click();
    await vi.waitFor(() => expect(calls(sendMessage, Message.Cancel)).toHaveLength(1));
    expect(composer.prompt).toBe('Website prompt');
    emit({ receipt: { ...input.receipt, receiptRevision: 3, request: { status: 'cancelled' } } });
    expect(panel.inputAssociated()).toBe(false);
    expect(composer.prompt).toBe('');
  });

  it('does not send an expired request or expose a raw transport error', async () => {
    const { panel, sendMessage } = await mount({ expiresAt: Date.now() - 1 });
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    sendMessage.mockResolvedValue({
      ok: false,
      code: 'UNKNOWN',
      error: 'secret capability http://127.0.0.1/?token=private',
    });
    await panel.stop();
    expect(document.body.textContent).not.toContain('private');
    expect(document.body.textContent).not.toContain('capability');
  });
});
