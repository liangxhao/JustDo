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
    '<section id="webConnectionCard" class="hidden"></section><div class="composer"><div id="webLaunchControls" hidden></div></div><p id="error"></p>';
  const input = envelope(options);
  const settled = new Set<string>();
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
  let tabWindowId = 4;
  let onDetached = (_id: number) => {};
  let onAttached = (_id: number) => {};
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
      tabs: {
        get: async () => ({ windowId: tabWindowId }),
        onDetached: {
          addListener: handler => {
            onDetached = handler;
          },
          removeListener: vi.fn(),
        },
        onAttached: {
          addListener: handler => {
            onAttached = handler;
          },
          removeListener: vi.fn(),
        },
      },
    },
    tabId: 7,
    readComposer: () => composer,
    installComposer,
    confirm,
    isTurnSettled: (threadId, turnId) => settled.has(`${threadId}/${turnId}`),
    onError: message => {
      document.getElementById('error')!.textContent = message;
    },
    onClearError: () => {
      document.getElementById('error')!.textContent = '';
    },
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
    settled,
    moveToWindow: (id: number, notify = false) => {
      if (notify) onDetached(7);
      tabWindowId = id;
      if (notify) onAttached(7);
    },
    emit: (response: any) =>
      listener({
        type: Message.Event,
        panelInstanceId: registration.panelInstanceId,
        tabId: 7,
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
      '<section id="webConnectionCard" class="hidden"></section><div class="composer"><div id="webLaunchControls" hidden></div></div><p id="error"></p>';
    let listener = (_message: Record<string, unknown>) => {};
    let registration: Record<string, unknown> = {};
    let respond!: (value: Record<string, unknown>) => void;
    const panel = createWebLaunchPanel({
      document,
      chrome: {
        tabs: { get: async () => ({ windowId: 4 }) },
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
      tabId: 7,
      readComposer: () => ({ prompt: '', ready: false }),
      installComposer: vi.fn(),
    });
    panels.push(panel);
    await vi.waitFor(() => expect(respond).toBeDefined());
    listener({
      type: Message.Event,
      panelInstanceId: registration.panelInstanceId,
      tabId: 7,
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
    const card = document.getElementById('webConnectionCard')!;
    const consent = {
      pendingId: 'connection-one',
      origin: 'https://business.internal:8443',
      expiresAt: Date.now() + 60_000,
    };
    emit({ connectionPending: { ...consent, revision: 1, status: 'awaiting-consent' } });
    expect(card.classList.contains('hidden')).toBe(false);
    emit({
      connectionPending: { ...consent, revision: 2, status: 'connected' },
    });
    expect(card.classList.contains('hidden')).toBe(true);
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
    expect(installComposer).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'ask' }),
    );
    expect(calls(sendMessage, Message.Submit)).toHaveLength(0);
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toHaveLength(1);
    expect(calls(sendMessage, Message.Submit)[0]).toMatchObject({
      submission: 'confirmed',
      shareResult: true,
    });
  });

  it('creates a separate guarded draft without sending or carrying previous full access', async () => {
    const { panel, composer, sendMessage, installComposer } = await mount();
    expect(composer.permissionMode).toBe('ask');
    expect(composer.prompt).toBe('Website prompt');
    expect(composer.threadId).toBe('external-thread');
    expect(installComposer).toHaveBeenCalledWith(expect.objectContaining({ includePage: false }));
    expect(panel.inputAssociated()).toBe(true);
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    expect(
      document.querySelector('#webLaunchControls details:not([hidden]) summary')?.textContent,
    ).toBe('Website-provided context');
    expect(document.querySelector('#webLaunchControls p:not([hidden])')).toBeNull();
  });

  it('releases an old website draft as ordinary text when its tab moves to another window', async () => {
    const { panel, composer, sendMessage, moveToWindow } = await mount();
    expect(panel.inputAssociated()).toBe(true);
    moveToWindow(9);
    const reply = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async message => {
      if (message.type === Message.State && message.windowId === 4)
        return { ok: false, code: 'FORBIDDEN' };
      if (message.type === Message.Register && message.windowId === 9)
        return { ok: true, connectionPending: null };
      return reply(message);
    });

    await panel.publishState(true);
    expect(calls(sendMessage, Message.Register).at(-1)).toMatchObject({ tabId: 7, windowId: 9 });
    expect(panel.inputAssociated()).toBe(false);
    expect(composer.prompt).toBe('Website prompt');
    expect(document.getElementById('error')?.textContent).toContain('ordinary draft');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
  });

  it('does not leave a pending website send ready to repeat after moving its tab', async () => {
    const { panel, composer, input, sendMessage, moveToWindow, emit } = await mount();
    const reply = sendMessage.getMockImplementation()!;
    let finishSubmit!: (value: unknown) => void;
    sendMessage.mockImplementation(async message => {
      if (message.type === Message.Submit) {
        return new Promise(resolve => {
          finishSubmit = resolve;
        });
      }
      if (message.type === Message.State && message.windowId === 4)
        return { ok: false, code: 'FORBIDDEN' };
      if (message.type === Message.Register && message.windowId === 9)
        return { ok: true, connectionPending: null };
      return reply(message);
    });
    const submitting = panel.submit();
    await vi.waitFor(() => expect(finishSubmit).toBeDefined());
    moveToWindow(9, true);
    emit({ windowId: 4, envelope: input });
    await vi.waitFor(() =>
      expect(calls(sendMessage, Message.Register).at(-1)).toMatchObject({ tabId: 7, windowId: 9 }),
    );
    expect(composer.prompt).toBe('');
    expect(panel.inputAssociated()).toBe(false);

    composer.prompt = 'New ordinary draft';
    finishSubmit(await reply({ type: Message.Submit }));
    await submitting;
    expect(composer.prompt).toBe('New ordinary draft');
    expect(calls(sendMessage, Message.Submit)).toHaveLength(1);
  });

  it.each([
    { prompt: 'Unsent ordinary draft' },
    { attachments: 1 },
    { attachmentReads: 1 },
    { busy: true },
  ])('rejects a conflicting ordinary composer without changing it: %j', async initial => {
    const { composer, input, sendMessage, installComposer } = await mount({}, initial);
    expect(installComposer).not.toHaveBeenCalled();
    expect(calls(sendMessage, Message.Cancel)[0].launchId).toBe(input.launchId);
    expect(composer).toEqual(expect.objectContaining(initial));
  });

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

  it('shows the exact recipient and shares only on confirmation when the site lacks automatic result permission', async () => {
    const { panel, sendMessage } = await mount({
      mode: 'send',
      result: 'final',
      automaticSendAllowed: true,
      shareAllowed: false,
      contextText: undefined,
    });
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    const controls = document.getElementById('webLaunchControls')!;
    expect(controls.querySelector('p:not([hidden])')?.textContent).toBe(
      'Sending will return the result to https://business.internal:8443',
    );
    expect(controls.querySelector('details:not([hidden])')).toBeNull();
    expect(controls.querySelector('label:not([hidden]) input, button:not([hidden])')).toBeNull();
    expect(panel.composerAction('external-thread')).toMatchObject({ label: 'webLaunchSendReturn' });
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)[0]).toEqual(
      expect.objectContaining({ submission: 'confirmed', shareResult: true }),
    );
    expect(calls(sendMessage, Message.Submit)[0]).not.toHaveProperty('rememberSend');
    expect(calls(sendMessage, Message.Submit)[0]).not.toHaveProperty('rememberResult');
  });

  it('waits for the latest revised input before allowing confirmed sending', async () => {
    const { panel, composer, sendMessage, input } = await mount({ result: 'final' });
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
    expect(calls(sendMessage, Message.Revise)[0]).not.toHaveProperty('shareResult');
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    expect(panel.composerAction('external-thread')?.disabled).toBe(true);
    resolveRevision({ ok: true, receipt: input.receipt, internal: { composeRevision: 2 } });
    await vi.waitFor(() => expect(panel.composerAction('external-thread')?.disabled).toBe(false));
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)[0]).toEqual(
      expect.objectContaining({
        composeRevision: 2,
        shareResult: true,
        input: expect.objectContaining({ prompt: 'Actually edited', permissionMode: 'ask' }),
      }),
    );
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

  it('uses the exact launch Stop route during a pending submit and deduplicates pending Stop', async () => {
    const { panel, sendMessage } = await mount();
    let submitAnswer!: (value: object) => void;
    let stopAnswer!: (value: object) => void;
    sendMessage.mockImplementation(async message => {
      if (message.type === Message.Submit)
        return new Promise(resolve => {
          submitAnswer = resolve;
        });
      if (message.type === Message.Stop)
        return new Promise(resolve => {
          stopAnswer = resolve;
        });
      return { ok: true };
    });
    expect(panel.composerAction('external-thread')).toMatchObject({ type: 'send' });
    const submit = panel.submit('confirmed');
    expect(panel.composerAction('external-thread')).toEqual({ type: 'stop', disabled: false });
    const stop = panel.stop();
    expect(panel.composerAction('external-thread')).toEqual({ type: 'stop', disabled: true });
    await panel.stop();
    expect(calls(sendMessage, Message.Stop)).toHaveLength(1);
    expect(calls(sendMessage, Message.Stop)[0].launchId).toBe('launch-one');
    stopAnswer({ ok: true });
    await stop;
    expect(panel.composerAction('external-thread')).toMatchObject({ type: 'stop' });
    submitAnswer({ ok: true });
    await submit;
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
    const choice = document.querySelector<HTMLInputElement>('.web-launch-choice input')!;
    choice.checked = true;
    choice.dispatchEvent(new Event('change'));
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
    await vi.waitFor(() => expect(panel.composerAction('external-thread')?.disabled).toBe(false));
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

  it('reopens a running website observation with trusted Stop and no extra composer controls', async () => {
    const original = envelope().receipt;
    const { sendMessage, composer, panel } = await mount(
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
    expect(panel.composerAction('existing-thread')).toBeNull();
    expect(document.getElementById('webLaunchControls')?.hasAttribute('hidden')).toBe(true);
    composer.threadId = 'external-thread';
    panel.updateSelection();
    expect(panel.composerAction('external-thread')).toMatchObject({ type: 'stop' });
    expect(document.getElementById('webLaunchControls')?.hasAttribute('hidden')).toBe(true);
    await panel.stop();
    await vi.waitFor(() => expect(calls(sendMessage, Message.Stop)).toHaveLength(1));
    expect(calls(sendMessage, Message.Cancel)).toHaveLength(0);
    expect(composer.prompt).toBe('Unrelated ordinary draft');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
  });

  it('lets a human abandon a restored unknown observation without claiming the task stopped', async () => {
    const original = envelope().receipt;
    const { sendMessage, confirm, composer, panel } = await mount(
      {
        prompt: '',
        contextText: undefined,
        receipt: {
          ...original,
          request: { status: 'submitted' },
          execution: { status: 'unknown', executionSettled: false },
        },
      },
      { prompt: 'Ordinary input', threadId: 'external-thread' },
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

  it('restricts Stop to the matching website turn and releases it after exact settled evidence', async () => {
    const original = envelope().receipt;
    const receipt = {
      ...original,
      request: { status: 'submitted' },
      execution: { status: 'unknown', executionSettled: false },
    };
    const { panel, sendMessage, settled } = await mount(
      { prompt: '', receipt },
      { threadId: 'external-thread' },
      { observations: [{ receipt, internal: { clientTurnId: 'web-turn' } }] },
    );
    expect(panel.composerAction('external-thread', 'ordinary-turn')).toBeNull();
    await panel.stop('ordinary-turn');
    expect(calls(sendMessage, Message.Stop)).toHaveLength(0);
    expect(panel.composerAction('external-thread', 'web-turn')?.type).toBe('stop');
    settled.add('external-thread/web-turn');
    expect(panel.composerAction('external-thread', 'web-turn')).toBeNull();
    await panel.stop('web-turn');
    expect(calls(sendMessage, Message.Stop)).toHaveLength(0);
  });

  it('keeps expired website text out of ordinary send until explicitly detached', async () => {
    const { panel, composer, sendMessage, input, emit } = await mount();
    composer.prompt = 'User-edited draft';
    emit({
      receipt: {
        ...input.receipt,
        receiptRevision: 3,
        request: { status: 'expired' },
        error: { code: 'EXPIRED' },
      },
    });
    expect(panel.inputAssociated()).toBe(true);
    expect(panel.composerAction('external-thread')).toMatchObject({ type: 'send', disabled: true });
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toHaveLength(0);
    const detach = [...document.querySelectorAll('button')].find(
      node => node.textContent === 'Continue as ordinary chat',
    )!;
    expect(detach.hidden).toBe(false);
    detach.click();
    expect(panel.inputAssociated()).toBe(false);
    expect(composer.prompt).toBe('User-edited draft');
    expect(calls(sendMessage, Message.Cancel)).toHaveLength(0);
  });

  it('clears only its unchanged input when cancellation through a conversation switch is confirmed', async () => {
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
    composer.threadId = 'other-thread';
    expect(await panel.beforeSwitch('other-thread')).toBe(false);
    expect(calls(sendMessage, Message.Cancel)).toHaveLength(1);
    expect(composer.threadId).toBe('external-thread');
    expect(composer.prompt).toBe('Website prompt');
    emit({ receipt: { ...input.receipt, receiptRevision: 3, request: { status: 'cancelled' } } });
    expect(panel.inputAssociated()).toBe(false);
    expect(composer.prompt).toBe('');
  });

  it('does not send an expired request or expose a raw transport error', async () => {
    const { panel, sendMessage, emit } = await mount({ expiresAt: Date.now() - 1 });
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    emit({
      code: 'UNKNOWN',
      error: 'secret capability http://127.0.0.1/?token=private',
    });
    expect(document.getElementById('error')?.textContent).toContain('could not be confirmed');
    expect(document.body.textContent).not.toContain('private');
    expect(document.body.textContent).not.toContain('capability');
  });
});
