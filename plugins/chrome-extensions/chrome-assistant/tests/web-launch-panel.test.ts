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
  permissionMode: 'full',
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
async function mount(
  options: Record<string, unknown> = {},
  initial = {},
  registrationExtra = {},
  statusBeforeRegister = false,
) {
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
      if (statusBeforeRegister) listener({
        type: Message.Event,
        panelInstanceId: message.panelInstanceId,
        tabId: message.tabId,
        windowId: message.windowId,
        envelope: input,
        receipt: input.receipt,
      });
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
  const onSubmitInput = vi.fn();
  const onWithdrawSubmitInput = vi.fn();
  const onReceipt = vi.fn();
  const refreshThread = vi.fn(async (_threadId: string) => {});
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
    onSubmitInput,
    onWithdrawSubmitInput,
    onReceipt,
    refreshThread,
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
    onSubmitInput,
    onWithdrawSubmitInput,
    onReceipt,
    refreshThread,
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
    expect(card.textContent).toContain('Website requests use Full access by default.');
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
      expect.objectContaining({ permissionMode: 'full' }),
    );
    expect(calls(sendMessage, Message.Submit)).toHaveLength(0);
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toHaveLength(1);
    expect(calls(sendMessage, Message.Submit)[0]).toMatchObject({
      submission: 'confirmed',
      shareResult: true,
      input: { permissionMode: 'full' },
    });
  });

  it('keeps a separate legacy draft at Ask when the host did not provide a permission mode', async () => {
    const { panel, composer, sendMessage, installComposer } = await mount({
      permissionMode: undefined,
    });
    expect(composer.permissionMode).toBe('ask');
    expect(composer.prompt).toBe('Website prompt');
    expect(composer.threadId).toBe('external-thread');
    expect(installComposer).toHaveBeenCalledWith(expect.objectContaining({ includePage: false }));
    expect(panel.inputAssociated()).toBe(true);
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    expect(document.querySelector('#webLaunchControls button:not([hidden])')?.textContent).toBe(
      'Website-provided context',
    );
    expect(document.querySelector('#webLaunchControls p:not([hidden])')).toBeNull();
  });

  it('previews without revising and closes the context dialog at the updated deadline', async () => {
    const { input, emit, sendMessage } = await mount({ contextText: '# Business snapshot' });
    const trigger = document.querySelector<HTMLButtonElement>('#webLaunchControls button')!;
    const dialog = document.getElementById(
      trigger.getAttribute('aria-controls')!,
    ) as HTMLDialogElement;
    dialog.showModal = () => {
      dialog.open = true;
    };
    dialog.close = () => {
      dialog.open = false;
      dialog.dispatchEvent(new Event('close'));
    };
    trigger.click();

    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('.markdown-content h1')?.textContent).toBe('Business snapshot');
    expect(calls(sendMessage, Message.Revise)).toEqual([]);
    expect(calls(sendMessage, Message.Submit)).toEqual([]);

    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout'],
      shouldClearNativeTimers: true,
    });
    try {
      const deadlineAt = Date.now() + 120_000;
      emit({ receipt: { ...input.receipt, receiptRevision: 2 }, internal: { deadlineAt } });
      await vi.advanceTimersByTimeAsync(60_001);
      expect(dialog.open).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(dialog.open).toBe(false);
      expect(trigger.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('revises and submits the Markdown source edited in the dialog', async () => {
    const { panel, sendMessage } = await mount({ contextText: '# Business snapshot' });
    const trigger = document.querySelector<HTMLButtonElement>('#webLaunchControls button')!;
    const dialog = document.getElementById(
      trigger.getAttribute('aria-controls')!,
    ) as HTMLDialogElement;
    dialog.showModal = () => {
      dialog.open = true;
    };
    dialog.close = () => {
      dialog.open = false;
    };
    trigger.click();
    const edit = dialog.querySelector<HTMLButtonElement>('button[aria-label="Edit"]')!;
    edit.click();
    const editor = dialog.querySelector('textarea')!;
    const updated = '# Current orders\n\n- **3 pending**\n';
    editor.value = updated;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(panel.composerAction('external-thread')?.disabled).toBe(false));

    const context = { text: updated };
    expect(calls(sendMessage, Message.Revise)).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ context }) }),
    ]);
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toEqual([
      expect.objectContaining({ composeRevision: 2, input: expect.objectContaining({ context }) }),
    ]);
    expect(dialog.open).toBe(false);
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
      const { panel, sendMessage, onSubmitInput } = await mount({
        mode: 'send',
        result,
        automaticSendAllowed: true,
        shareAllowed: true,
      });
      await vi.waitFor(() => expect(calls(sendMessage, Message.Submit)).toHaveLength(1));
      panel.ready();
      await panel.submit('confirmed');
      expect(calls(sendMessage, Message.Submit)).toHaveLength(1);
      expect(onSubmitInput).toHaveBeenCalledExactlyOnceWith({
        launchId: 'launch-one',
        threadId: 'external-thread',
        prompt: 'Website prompt',
      });
      expect(calls(sendMessage, Message.Submit)[0]).toEqual(
        expect.objectContaining({
          submission: 'automatic',
          confirmNewTask: false,
          shareResult: result === 'final',
          input: {
            prompt: 'Website prompt',
            context: { text: 'Business snapshot' },
            permissionMode: 'full',
          },
        }),
      );
    },
  );

  it('returns the result from ordinary Send without a separate reminder or control', async () => {
    const { panel, sendMessage } = await mount({
      mode: 'send',
      result: 'final',
      automaticSendAllowed: true,
      shareAllowed: false,
      contextText: undefined,
    });
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    const controls = document.getElementById('webLaunchControls')!;
    expect(controls.hidden).toBe(true);
    expect(controls.querySelector('p')).toBeNull();
    expect(panel.composerAction('external-thread')).toEqual({
      type: 'send',
      disabled: false,
    });
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)[0]).toEqual(
      expect.objectContaining({ submission: 'confirmed', shareResult: true }),
    );
    expect(calls(sendMessage, Message.Submit)[0]).not.toHaveProperty('rememberSend');
    expect(calls(sendMessage, Message.Submit)[0]).not.toHaveProperty('rememberResult');
  });

  it('keeps an edited Ask selection while waiting for the latest revision before sending', async () => {
    const { panel, composer, sendMessage, input, emit } = await mount({ result: 'final' });
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
    composer.permissionMode = 'ask';
    panel.edit();
    const revise = calls(sendMessage, Message.Revise)[0];
    expect(revise.input).toMatchObject({ permissionMode: 'ask' });
    expect(revise).not.toHaveProperty('shareResult');
    emit({
      receipt: { ...input.receipt, receiptRevision: 2 },
      internal: { composeRevision: 1, permissionMode: 'full' },
    });
    expect(composer.permissionMode).toBe('ask');
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

  it('places the exact confirmed prompt before dispatch and refreshes on authoritative receipts', async () => {
    const { panel, composer, input, emit, sendMessage, onSubmitInput, onReceipt, refreshThread } =
      await mount();
    expect(onSubmitInput).not.toHaveBeenCalled();
    composer.prompt = 'Edited prompt';
    panel.edit();
    await vi.waitFor(() => expect(panel.composerAction('external-thread')?.disabled).toBe(false));
    refreshThread.mockClear();

    let acknowledge!: (value: object) => void;
    const reply = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async message => {
      if (message.type !== Message.Submit) return reply(message);
      expect(onSubmitInput).toHaveBeenCalledExactlyOnceWith({
        launchId: 'launch-one',
        threadId: 'external-thread',
        prompt: 'Edited prompt',
      });
      return new Promise(resolve => {
        acknowledge = resolve;
      });
    });
    const submit = panel.submit();
    const internal = { threadId: 'external-thread', clientTurnId: 'web-turn' };
    const submitting = {
      ...input.receipt,
      receiptRevision: 2,
      request: { status: 'submitting' },
    };
    acknowledge({ ok: true, receipt: submitting, internal });
    await submit;
    expect(onReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        internal,
        matchesSubmission: true,
      }),
    );
    expect(refreshThread).not.toHaveBeenCalled();

    const running = {
      ...submitting,
      receiptRevision: 3,
      request: { status: 'submitted' },
      execution: { status: 'running', executionSettled: false },
    };
    const acceptedInternal = { ...internal, nativeRunId: 'physical-run' };
    emit({ receipt: running, internal: acceptedInternal });
    await vi.waitFor(() =>
      expect(refreshThread).toHaveBeenCalledExactlyOnceWith('external-thread'),
    );
    emit({ receipt: { ...running, receiptRevision: 4 }, internal: acceptedInternal });
    await Promise.resolve();
    expect(refreshThread).toHaveBeenCalledTimes(1);

    emit({
      receipt: {
        ...running,
        receiptRevision: 5,
        execution: { status: 'completed', executionSettled: true },
      },
      internal: acceptedInternal,
    });
    await vi.waitFor(() => expect(refreshThread).toHaveBeenCalledTimes(2));
    expect(composer.prompt).toBe('');
  });

  it('refreshes a fast terminal and preserves its error notice', async () => {
    const { panel, input, sendMessage, onReceipt, refreshThread } = await mount();
    refreshThread.mockClear();
    const errorLine = document.getElementById('error')!;
    refreshThread.mockImplementation(async () => {
      errorLine.textContent = '';
    });
    const reply = sendMessage.getMockImplementation()!;
    const receipt = {
      ...input.receipt,
      receiptRevision: 3,
      request: { status: 'submitted' },
      execution: { status: 'failed', executionSettled: true },
      error: { code: 'NATIVE_UNAVAILABLE', messageKey: 'webLaunchErrorNATIVE_UNAVAILABLE' },
    };
    const internal = {
      threadId: 'external-thread',
      clientTurnId: 'web-turn',
      nativeRunId: 'physical-run',
    };
    sendMessage.mockImplementation(async message =>
      message.type === Message.Submit ? { ok: true, receipt, internal } : reply(message),
    );

    await panel.submit();

    expect(onReceipt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        matchesSubmission: true,
        receipt,
        internal,
      }),
    );
    expect(refreshThread).toHaveBeenCalledExactlyOnceWith('external-thread');
    await vi.waitFor(() => expect(errorLine.textContent).not.toBe(''));
  });

  it('withdraws a directly rejected fresh submission but preserves an earlier unconfirmed attempt', async () => {
    const { panel, sendMessage, onSubmitInput, onWithdrawSubmitInput } = await mount();
    const rejected = { ok: false, code: 'CONFIRMATION_REQUIRED', requestSent: false };
    const replies = [rejected, { ok: false, code: 'REQUEST_TIMEOUT' }, rejected];
    const reply = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async message =>
      message.type === Message.Submit ? replies.shift() : reply(message),
    );
    await panel.submit();
    expect(onSubmitInput).toHaveBeenCalledOnce();
    expect(onWithdrawSubmitInput).toHaveBeenCalledExactlyOnceWith({
      launchId: 'launch-one',
      threadId: 'external-thread',
    });

    await panel.submit();
    expect(onSubmitInput).toHaveBeenCalledTimes(2);
    expect(onWithdrawSubmitInput).toHaveBeenCalledTimes(1);
    await panel.submit();
    expect(onWithdrawSubmitInput).toHaveBeenCalledTimes(1);
  });

  it('matches only the new submission turn after an authoritative not-sent receipt', async () => {
    const { panel, input, emit, sendMessage, onSubmitInput, onReceipt } = await mount();
    const oldInternal = { threadId: 'external-thread', clientTurnId: 'old-turn', notSent: true };
    const first = {
      ...input.receipt,
      receiptRevision: 2,
      request: { status: 'awaiting-confirmation' },
    };
    sendMessage.mockImplementation(async message =>
      message.type === Message.Submit ? { ok: false, code: 'REQUEST_TIMEOUT' } : { ok: true },
    );
    await panel.submit();
    expect(onSubmitInput).toHaveBeenCalledOnce();
    expect(onReceipt).not.toHaveBeenCalled();
    emit({ receipt: first, internal: oldInternal });
    expect(onReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        internal: oldInternal,
        matchesSubmission: true,
      }),
    );

    await panel.submit();
    expect(onSubmitInput).toHaveBeenCalledTimes(2);
    emit({ receipt: { ...first, receiptRevision: 3 }, internal: oldInternal });
    expect(onReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        matchesSubmission: false,
      }),
    );
    emit({
      receipt: { ...first, receiptRevision: 4 },
      internal: { ...oldInternal, clientTurnId: 'new-turn' },
    });
    expect(onReceipt).toHaveBeenLastCalledWith(
      expect.objectContaining({
        matchesSubmission: true,
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

  it('uses manual Send as the new-task confirmation and keeps automatic sending blocked', async () => {
    const { panel, sendMessage } = await mount({
      mode: 'send',
      automaticSendAllowed: true,
      requiresUnknownConfirmation: true,
    });
    expect(document.querySelector('#webLaunchControls input[type="checkbox"]')).toBeNull();
    expect(panel.composerAction('external-thread')?.disabled).toBe(false);
    await panel.submit('automatic');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)).toEqual([
      expect.objectContaining({ submission: 'confirmed', confirmNewTask: true }),
    ]);
  });

  it('restores the previously selected Ask mode and still requires a new revision and human send', async () => {
    const { composer, panel, sendMessage } = await mount({
      mode: 'send',
      automaticSendAllowed: true,
      composeRevision: 2,
      permissionMode: 'ask',
      restored: true,
    });
    await vi.waitFor(() => expect(calls(sendMessage, Message.Revise)).toHaveLength(1));
    expect(composer.permissionMode).toBe('ask');
    expect(calls(sendMessage, Message.Revise)[0].input).not.toHaveProperty('modelRef');
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
    await vi.waitFor(() => expect(panel.composerAction('external-thread')?.disabled).toBe(false));
    await panel.submit('confirmed');
    expect(calls(sendMessage, Message.Submit)[0]).toMatchObject({
      submission: 'confirmed',
      input: { permissionMode: 'ask' },
    });
  });

  it('restores an already submitted observation without touching an ordinary draft', async () => {
    const sent = envelope().receipt;
    const { composer, panel, sendMessage, installComposer, refreshThread } = await mount(
      {
        restored: true,
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
    expect(refreshThread).not.toHaveBeenCalled();
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

  it('reopens a running website observation even when its status arrives before registration', async () => {
    const original = envelope().receipt;
    const { sendMessage, composer, panel, installComposer, refreshThread } = await mount({
      restored: true,
      result: 'final',
      receipt: {
        ...original,
        request: { status: 'submitted' },
        execution: { status: 'running', executionSettled: false },
        output: { status: 'pending' },
      },
    }, {}, {}, true);
    expect(composer.threadId).toBe('external-thread');
    expect(composer.prompt).toBe('');
    expect(installComposer).toHaveBeenCalledExactlyOnceWith({ threadId: 'external-thread' });
    expect(refreshThread).toHaveBeenCalledExactlyOnceWith('external-thread');
    expect(panel.composerAction('external-thread')).toMatchObject({ type: 'stop' });
    expect(document.getElementById('webLaunchControls')?.hasAttribute('hidden')).toBe(true);
    await panel.stop();
    await vi.waitFor(() => expect(calls(sendMessage, Message.Stop)).toHaveLength(1));
    expect(calls(sendMessage, Message.Cancel)).toHaveLength(0);
    expect(calls(sendMessage, Message.Submit)).toEqual([]);
  });

  it('follows an explicit reopen of the existing launch without following its ordinary status updates', async () => {
    const original = envelope().receipt;
    const { composer, emit, input, refreshThread } = await mount({
      receipt: {
        ...original,
        request: { status: 'submitted' },
        execution: { status: 'running', executionSettled: false },
      },
    });
    const snapshot = { envelope: { ...input, restored: true }, receipt: input.receipt };
    emit(snapshot);
    expect(composer.threadId).toBe('existing-thread');
    expect(refreshThread).not.toHaveBeenCalled();

    emit({ ...snapshot, resume: true });
    expect(composer.threadId).toBe('external-thread');
    expect(refreshThread).toHaveBeenCalledExactlyOnceWith('external-thread');
  });

  it('switches to the next website conversation while the first continues and keeps that selection when it finishes', async () => {
    const { composer, emit, input, onReceipt, panel, refreshThread, sendMessage } = await mount({
      mode: 'send', automaticSendAllowed: true,
    });
    await vi.waitFor(() => expect(panel.inputAssociated()).toBe(false));
    expect(calls(sendMessage, Message.Submit).map(message => message.launchId)).toEqual([input.launchId]);

    const nextReceipt = { ...input.receipt, launchId: 'launch-two', requestId: 'request-two' };
    const next = envelope({
      launchId: nextReceipt.launchId, requestId: nextReceipt.requestId, receipt: nextReceipt,
      threadId: 'second-thread', prompt: 'Second button', mode: 'send', automaticSendAllowed: true,
    });
    const original = sendMessage.getMockImplementation()!;
    sendMessage.mockImplementation(async message =>
      message.type === Message.Submit && message.launchId === next.launchId
        ? {
            ok: true,
            receipt: {
              ...nextReceipt, receiptRevision: 2, request: { status: 'submitted' },
              execution: { status: 'running', executionSettled: false },
            },
            internal: { threadId: next.threadId, clientTurnId: 'second-turn' },
          }
        : original(message),
    );
    emit({ envelope: next, receipt: nextReceipt });
    expect(composer.threadId).toBe(next.threadId);
    await vi.waitFor(() => expect(panel.composerAction(next.threadId, 'second-turn')).toMatchObject({ type: 'stop' }));
    expect(calls(sendMessage, Message.Submit).map(message => message.launchId)).toEqual([input.launchId, next.launchId]);

    refreshThread.mockClear();
    emit({ envelope: input, receipt: input.receipt });
    expect(composer.threadId).toBe(next.threadId);
    const firstFinished = {
      ...input.receipt, receiptRevision: 3, request: { status: 'submitted' },
      execution: { status: 'completed', executionSettled: true },
    };
    emit({ receipt: firstFinished, internal: { threadId: input.threadId, clientTurnId: 'client-turn' } });
    expect(onReceipt).toHaveBeenLastCalledWith(expect.objectContaining({
      threadId: input.threadId, receipt: firstFinished,
    }));
    expect(composer.threadId).toBe(next.threadId);
    expect(refreshThread).not.toHaveBeenCalledWith(input.threadId);
    expect(panel.composerAction(next.threadId, 'second-turn')).toMatchObject({ type: 'stop' });
  });

  it('keeps a restored web draft pending when the ordinary composer contains work', async () => {
    const { composer, input, emit, sendMessage, installComposer } = await mount(
      { restored: true, mode: 'send', automaticSendAllowed: true },
      { prompt: 'Unrelated ordinary draft', attachments: 1 },
    );
    expect(composer.prompt).toBe('Unrelated ordinary draft');
    expect(installComposer).not.toHaveBeenCalled();
    expect(calls(sendMessage, Message.Cancel)).toEqual([]);
    composer.prompt = '';
    composer.attachments = 0;
    emit({ envelope: input });
    expect(installComposer).not.toHaveBeenCalled();

    emit({ envelope: input, resume: true });
    expect(composer.prompt).toBe('Website prompt');
    await vi.waitFor(() => expect(calls(sendMessage, Message.Revise)).toHaveLength(1));
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
