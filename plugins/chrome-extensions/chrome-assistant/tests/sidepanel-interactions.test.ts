// @vitest-environment jsdom
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  notify: (_method: string, _params: unknown) => {},
  request: vi.fn(),
  disconnect: vi.fn(),
  renderMessages: vi.fn(),
  startStream: vi.fn(),
  openDelivery: null as null | ((threadId: string, source: string) => Promise<void>),
  openMessageFile: null as null | ((threadId: string, link: { sourceKind: string; target: string }) => Promise<void>),
  questionOptions: null as null | {
    respond: (threadId: string, requestId: string, response: unknown) => Promise<unknown>;
  },
  questions: {
    hasPending: false,
    setQuestions: vi.fn(), setSuspended: vi.fn(), clear: vi.fn(), dispose: vi.fn(),
  },
}));

vi.mock('../conversation-overlay/modules/appearance.js', () => ({ initializeAppearance: async () => {} }));
vi.mock('../conversation-overlay/modules/conversation-client.js', () => ({
  AppServerClient: class {
    constructor(notify: typeof mock.notify) { mock.notify = notify; }
    request = (method: string, params: unknown) => mock.request(method, params);
    disconnect = mock.disconnect;
  },
}));
vi.mock('../conversation-overlay/modules/sidepanel-questions.js', () => ({
  createQuestionPanel: (_element: HTMLElement, options: typeof mock.questionOptions) => {
    mock.questionOptions = options;
    return mock.questions;
  },
}));
vi.mock('../conversation-overlay/modules/sidepanel-messages.js', () => ({
  createMessageRenderer: (_element: HTMLElement, options: {
    openDelivery: typeof mock.openDelivery;
    openMessageFile: typeof mock.openMessageFile;
  }) => {
    mock.openDelivery = options.openDelivery;
    mock.openMessageFile = options.openMessageFile;
    return { render: mock.renderMessages, dispose: vi.fn() };
  },
}));
vi.mock('../conversation-overlay/modules/sidepanel-activity.js', () => ({
  createRunActivityView: () => ({ render: vi.fn(), dispose: vi.fn() }),
}));
vi.mock('../conversation-overlay/modules/sidepanel-stream.js', () => ({
  ChromeExtensionStream: class {
    id: string;
    constructor(id: string) { this.id = id; }
    project() { return { id: this.id, turns: [] }; }
    setHistory() {}
    start = mock.startStream;
    identifyInput() { return false; }
    cancelStart() {}
    bindRun() { return true; }
    finish() {}
  },
  foldChromeExtensionEntries: (entries: unknown) => entries,
  isChromeQuestionTool: () => false,
  isPresentPlanToolName: () => false,
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const extensionUrl = (path: string) => `chrome-extension://test-extension/${path}`;
const question = { requestId: 'ask_one', questions: [{ id: 'target', question: 'Where?',
  options: [{ id: 'dev', label: 'Development' }, { id: 'prod', label: 'Production' }] }],
  waitPolicy: { mode: 'required' } };

async function mount() {
  document.documentElement.innerHTML = fs.readFileSync(
    'plugins/chrome-extensions/chrome-assistant/conversation-overlay/sidepanel.html', 'utf8',
  );
  mock.request.mockImplementation(async (method: string, params: { threadId?: string }) => {
    if (method === 'thread/list') return { data: [{ id: 'one' }, { id: 'two' }, { id: 'created' }] };
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [],
      chrome: { display: { id: params.threadId, turns: [] }, activeTurn: null } } };
    if (method === 'chrome/composer/options') return {
      cwd: 'E:/default', recentCwds: [], modelRef: 'p/m', permissionMode: params.threadId ? 'ask' : 'full',
    };
    if (method === 'model/list') return { data: [{ id: 'p/m', displayName: 'Model' }], nextCursor: null };
    if (method === 'chrome/questions/list') return { questions: [question] };
    if (method === 'thread/start') return { thread: { id: 'created', cwd: 'E:/selected folder', name: 'Created' } };
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress' } };
    if (method === 'chrome/workspace/select') return { cwd: 'E:/selected folder', selectionToken: 'chosen-once' };
    return {};
  });
  const dialog = element<HTMLDialogElement>('decisionDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  // Import the real entry point: declaration-order errors and missing adapters fail here.
  await import('../conversation-overlay/sidepanel.js');
  await vi.waitFor(() => expect(element<HTMLSelectElement>('model').disabled).toBe(false));
  expect(element('error').textContent).toBe('');
}

async function selectThread(id: string) {
  const select = element<HTMLSelectElement>('session');
  select.value = id;
  select.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(element<HTMLSelectElement>('model').disabled).toBe(false));
  await flush();
}

function sendPromptWithPageContext() {
  element<HTMLInputElement>('includePage').checked = true;
  const prompt = element<HTMLTextAreaElement>('prompt');
  prompt.value = 'Summarize the page';
  prompt.dispatchEvent(new Event('input'));
  element<HTMLButtonElement>('send').click();
}

describe('side panel interactions', () => {
  it.each([
    ['openDelivery', { source: './reports/file.pdf' }],
    ['openMessageFile', { link: { sourceKind: 'markdown-uri', target: './reports/file.pdf' } }],
  ] as const)('scopes %s to the selected, subscribed chat during thread changes', async (operation, reference) => {
    await mount();
    await selectThread('one');
    const method = `chrome/thread/${operation}`;
    const open = (threadId: string) => 'source' in reference
      ? mock.openDelivery!(threadId, reference.source)
      : mock.openMessageFile!(threadId, reference.link);
    const pendingOpen = deferred<{ opened: boolean }>();
    const pendingThread = deferred<unknown>();
    const original = mock.request.getMockImplementation()!;
    mock.request.mockImplementation((name, params) => {
      if (name === method) return pendingOpen.promise;
      if (name === 'thread/resume' && params.threadId === 'two') return pendingThread.promise;
      return original(name, params);
    });
    const opening = open('one');
    expect(mock.request).toHaveBeenCalledWith(method, { threadId: 'one', ...reference });

    const session = element<HTMLSelectElement>('session');
    session.value = 'two';
    session.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledWith('thread/resume', expect.objectContaining({ threadId: 'two' })));
    await open('one');
    await open('two');
    expect(mock.request.mock.calls.filter(([name]) => name === method)).toHaveLength(1);

    pendingOpen.reject(new Error('Private native error'));
    await expect(opening).resolves.toBeUndefined();
    pendingThread.resolve(await original('thread/resume', { threadId: 'two' }));
    await flush();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mock.questions.hasPending = false;
    mock.questionOptions = null;
  });
  afterEach(() => {
    window.dispatchEvent(new Event('unload'));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('boots the actual entry point and suspends questions until authoritative pending refresh succeeds', async () => {
    await mount();
    await selectThread('one');
    expect(mock.questions.setQuestions).toHaveBeenLastCalledWith('one', [question]);
    expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(false);

    const pending = deferred<{ questions: unknown[] }>();
    mock.request.mockImplementationOnce(() => pending.promise);
    mock.notify('chrome/questions/changed', { threadId: 'one' });
    expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(true);
    pending.resolve({ questions: [question] });
    await flush();
    expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(false);

    // Approval visibility takes priority even after a successful question refresh.
    element('approvals').classList.remove('hidden');
    await flush();
    expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(true);
    element('approvals').classList.add('hidden');
    await flush();
    expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(false);
  });

  it('blocks composer submission until the front dialog is resolved and preserves the draft', async () => {
    await mount();
    await selectThread('one');
    const dialog = element<HTMLDialogElement>('decisionDialog');
    const prompt = element<HTMLTextAreaElement>('prompt');
    prompt.value = 'Keep this draft';
    prompt.dispatchEvent(new Event('input'));
    mock.questions.hasPending = true;
    element('webConnectionCard').classList.remove('hidden');
    await flush();
    expect(dialog.open).toBe(false);
    const pending = deferred<{ questions: unknown[] }>();
    mock.request.mockImplementationOnce(() => pending.promise);
    mock.notify('chrome/questions/changed', { threadId: 'one' });
    expect(dialog.open).toBe(false);
    pending.resolve({ questions: [question] });
    await flush();

    element('approvals').classList.remove('hidden');
    await flush();
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.owner).toBe('approval');
    expect(dialog.dispatchEvent(new Event('cancel', { cancelable: true }))).toBe(false);

    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    element<HTMLButtonElement>('send').click();
    expect(mock.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(false);

    element('approvals').classList.add('hidden');
    await flush();
    expect(dialog.open).toBe(false);
    expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(false);
    mock.questions.hasPending = false;
    mock.notify('chrome/questions/changed', { threadId: 'one' });
    await flush();
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.owner).toBe('website');

    element('webConnectionCard').classList.add('hidden');
    await flush();
    expect(dialog.open).toBe(false);
    expect(prompt.value).toBe('Keep this draft');
    element<HTMLInputElement>('includePage').checked = false;
    element<HTMLButtonElement>('send').click();
    await vi.waitFor(() => expect(
      mock.request.mock.calls.some(([method]) => method === 'turn/start'),
    ).toBe(true));
  });

  it('keeps questions suspended when a refresh fails and never manufactures an answer', async () => {
    await mount();
    await selectThread('one');
    mock.questions.setQuestions.mockClear();
    mock.questions.hasPending = true;
    element('webConnectionCard').classList.remove('hidden');
    await flush();
    const dialog = element<HTMLDialogElement>('decisionDialog');
    expect(dialog.open).toBe(false);
    mock.request.mockRejectedValueOnce(new Error('Pending snapshot unavailable'));
    mock.notify('chrome/questions/changed', { threadId: 'one' });
    await flush();
    expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(true);
    expect(mock.questions.setQuestions).not.toHaveBeenCalled();
    expect(element('error').textContent).toContain('Pending snapshot unavailable');
    expect(dialog.open).toBe(true);
    expect(dialog.dataset.owner).toBe('website');
    expect(mock.request.mock.calls.some(([method]) => method === 'chrome/questions/respond')).toBe(false);
  });

  it('keeps the connection versions visible after a failed chat refresh', async () => {
    await mount();
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '2.4.1' }) } });
    vi.stubGlobal('__BUNDLED_DESKTOP_VERSION__', 'v2026.11.23');
    mock.request.mockImplementationOnce(async () => {
      mock.notify('connection/failed', { code: 'APP_NOT_RUNNING' });
      throw Object.assign(new Error('Underlying discovery error'), { code: 'APP_NOT_RUNNING', stage: 'discovery' });
    });

    element<HTMLButtonElement>('refresh').click();
    await flush();

    expect(element('error').textContent).toContain('Chrome extension 2.4.1 · Bundled with desktop version v2026.11.23');
    expect(element('error').textContent).not.toContain('Underlying discovery error');
  });

  it.each(['switch', 'disconnect'] as const)('cannot revive an old list after %s', async action => {
    await mount();
    await selectThread('one');
    const pending = deferred<{ questions: unknown[] }>();
    mock.request.mockImplementationOnce(() => pending.promise);
    mock.notify('chrome/questions/changed', { threadId: 'one' });
    if (action === 'switch') await selectThread('two');
    else mock.notify('connection/closed', {});
    const calls = mock.questions.setQuestions.mock.calls.length;
    pending.resolve({ questions: [{ ...question, requestId: 'stale' }] });
    await flush();
    expect(mock.questions.setQuestions.mock.calls.length).toBe(calls);
    if (action === 'switch') expect(mock.questions.setQuestions).toHaveBeenLastCalledWith('two', [question]);
    else expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(true);
    expect(mock.request.mock.calls.some(([method]) => method === 'chrome/questions/respond')).toBe(false);
  });

  it('hides questions on Stop and rejects a stale form callback without answering or reopening it', async () => {
    await mount();
    await selectThread('one');
    mock.notify('turn/started', { threadId: 'one', turn: { id: 'running', status: 'inProgress' } });
    const clearing = mock.questions.clear.mock.calls.length;
    element<HTMLButtonElement>('send').click();
    await flush();
    expect(mock.questions.clear.mock.calls.length).toBeGreaterThan(clearing);
    expect(mock.request).toHaveBeenCalledWith('turn/interrupt', { threadId: 'one', turnId: 'running' });
    expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(true);
    await expect(mock.questionOptions!.respond('one', 'ask_one', { behavior: 'cancel' })).rejects.toThrow();
    expect(mock.request.mock.calls.some(([method]) => method === 'chrome/questions/respond')).toBe(false);
    const snapshots = mock.questions.setQuestions.mock.calls.length;
    mock.notify('chrome/questions/changed', { threadId: 'one' });
    await flush();
    expect(mock.questions.setQuestions.mock.calls.length).toBe(snapshots);
  });

  it.each(['click', 'Enter'])('uses %s to send a website draft before Stop targets the exact launch', async activation => {
    const threadId = 'website-draft';
    const receipt = {
      launchId: 'website-launch',
      receiptRevision: 1,
      request: { status: 'drafted' },
      execution: { status: 'not-started', executionSettled: false },
      output: { status: 'awaiting-consent' },
    };
    const pendingSubmit = deferred<{
      ok: boolean;
      receipt: typeof receipt;
      internal: { threadId: string; clientTurnId: string; nativeRunId: string };
    }>();
    const webRequest = vi.fn(async (request: { type: string }) => {
      if (request.type === 'web-launch:launch:submit') return pendingSubmit.promise;
      if (request.type === 'web-launch:launch:revise') return {
        ok: true,
        receipt: { ...receipt, receiptRevision: 2 },
        internal: { composeRevision: 2, permissionMode: 'ask' },
      };
      return { ok: true };
    });
    let receive = (_message: Record<string, unknown>) => {};
    vi.spyOn(document, 'URL', 'get').mockReturnValue(extensionUrl('sidepanel.html?tabId=31'));
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: extensionUrl,
        sendMessage: webRequest,
        onMessage: {
          addListener: (listener: typeof receive) => { receive = listener; },
          removeListener: vi.fn(),
        },
      },
      tabs: { get: async () => ({ id: 31, windowId: 4 }) },
    });

    await mount();
    const hostRequest = mock.request.getMockImplementation()!;
    let acknowledged = false;
    mock.request.mockImplementation(async (method, params) => {
      const result = await hostRequest(method, params);
      if (method === 'thread/list' && (acknowledged || !params?.chrome?.excludePendingFirstSend))
        return { data: [...result.data, { id: threadId, name: 'Summarize these orders' }] };
      return result;
    });
    const registration = webRequest.mock.calls.find(([request]) => request.type === 'web-launch:panel:register')![0];
    receive({
      ...registration,
      type: 'web-launch:panel:event',
      envelope: {
        launchId: receipt.launchId,
        threadId,
        origin: 'https://business.invalid:8443',
        prompt: 'Summarize these orders',
        mode: 'draft',
        result: 'final',
        permissionMode: 'full',
        shareAllowed: false,
        automaticSendAllowed: false,
        requiresUnknownConfirmation: true,
        composeRevision: 1,
        expiresAt: Date.now() + 60_000,
        receipt,
      },
    });

    const prompt = element<HTMLTextAreaElement>('prompt');
    const send = element<HTMLButtonElement>('send');
    const permission = element<HTMLSelectElement>('permission');
    const select = element<HTMLSelectElement>('session');
    const visibleConversations = () => [...select.options].filter(option => !option.hidden).map(option => option.value);
    await vi.waitFor(() => {
      expect(prompt.value).toBe('Summarize these orders');
      expect(send.disabled).toBe(false);
    });
    expect(select.value).toBe(threadId);
    expect(select.selectedOptions[0].textContent).toBe('New chat');
    expect(visibleConversations()).not.toContain(threadId);
    expect(document.getElementById('webLaunchCard')).toBeNull();
    expect(permission.value).toBe('full');
    expect(send.getAttribute('aria-label')).toBe('Send');
    expect(element('webLaunchControls').hidden).toBe(true);
    if (activation === 'click') send.click();
    else {
      const hostRequest = mock.request.getMockImplementation()!;
      mock.request.mockImplementation(async (method, params) => {
        const result = await hostRequest(method, params);
        return method === 'chrome/composer/options' ? { ...result, permissionMode: 'full' } : result;
      });
      permission.value = 'ask';
      permission.dispatchEvent(new Event('change', { bubbles: true }));
      expect(webRequest).toHaveBeenCalledWith(expect.objectContaining({
        type: 'web-launch:launch:revise', input: expect.objectContaining({ permissionMode: 'ask' }),
      }));
      element<HTMLButtonElement>('refresh').click();
      expect(send.disabled).toBe(true);
      await vi.waitFor(() => expect(send.disabled).toBe(false));
      expect(permission.value).toBe('ask');
      prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    await vi.waitFor(() => {
      expect(send.getAttribute('aria-label')).toBe('Stop');
      expect(send.disabled).toBe(false);
    });
    expect(select.selectedOptions[0].textContent).toBe('New chat');
    expect(visibleConversations()).not.toContain(threadId);
    expect(webRequest).toHaveBeenCalledWith(expect.objectContaining({
      type: 'web-launch:launch:submit', launchId: receipt.launchId,
      submission: 'confirmed', shareResult: true, confirmNewTask: true,
      input: expect.objectContaining({ permissionMode: activation === 'click' ? 'full' : 'ask' }),
    }));

    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(webRequest.mock.calls.filter(([request]) => request.type === 'web-launch:launch:stop')).toHaveLength(0);
    send.click();
    expect(webRequest).toHaveBeenCalledWith(expect.objectContaining({
      type: 'web-launch:launch:stop', launchId: receipt.launchId,
    }));
    acknowledged = true;
    pendingSubmit.resolve({
      ok: true,
      receipt: {
        ...receipt, receiptRevision: 3, request: { status: 'submitted' },
        execution: { status: 'running', executionSettled: false },
      },
      internal: { threadId, clientTurnId: 'turn', nativeRunId: 'native-run' },
    });
    await vi.waitFor(() => expect(visibleConversations()).toContain(threadId));
    expect(select.value).toBe(threadId);
    expect(select.selectedOptions[0].textContent).toBe('Summarize these orders');
    expect(webRequest.mock.calls.filter(([request]) => request.type === 'web-launch:launch:submit')).toHaveLength(1);
    expect(mock.request.mock.calls.filter(([method]) => method === 'turn/start' || method === 'turn/interrupt')).toHaveLength(0);
  });

  it.each(['switch', 'reload'] as const)(
    'never collects a sibling tab and revalidates the captured page on %s',
    async action => {
      const tab = { id: 31, windowId: 4, title: 'Orders', url: 'https://orders.invalid/' };
      const sibling = { id: 32, windowId: 4, title: 'Private', url: 'https://private.invalid/' };
      let activeTab = tab;
      const text = { title: tab.title, url: tab.url, selectedText: '', pageText: 'Order 31' };
      const permission = deferred<boolean>();
      const page = deferred<Array<{ documentId: string; result: typeof text }>>();
      let activeDocumentId = 'initial-document';
      const executeScript = vi.fn<() => Promise<Array<{ documentId: string; result: typeof text | string }>>>(async () =>
        [{ documentId: activeDocumentId, result: tab.url }],
      )
        .mockImplementationOnce(() => page.promise);
      const query = vi.fn(async () => [activeTab]);
      vi.spyOn(document, 'URL', 'get').mockReturnValue(extensionUrl('sidepanel.html?tabId=31'));
      vi.stubGlobal('chrome', {
        runtime: { getURL: extensionUrl },
        permissions: { request: vi.fn(() => permission.promise) },
        scripting: { executeScript },
        tabs: {
          get: vi.fn(async (tabId: number) => tabId === tab.id ? tab : sibling),
          query,
        },
      });
      await mount();
      const startedThread = { thread: { id: 'created', cwd: 'E:/selected folder', name: 'Created' } };
      const preparingThread = deferred<typeof startedThread>();
      if (action === 'reload') mock.request.mockImplementationOnce(() => preparingThread.promise);
      else await selectThread('one');
      sendPromptWithPageContext();

      activeTab = sibling;
      permission.resolve(true);
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ target: { tabId: tab.id } }),
      ));
      page.resolve([{ documentId: 'initial-document', result: text }]);
      if (action === 'reload') {
        await vi.waitFor(() => expect(mock.request).toHaveBeenCalledWith('thread/start', expect.anything()));
        // The tab retained its URL while the first product thread was being started.
        activeDocumentId = 'reloaded-document';
        preparingThread.resolve(startedThread);
      }

      const turn = () => mock.request.mock.calls.find(([method]) => method === 'turn/start')?.[1];
      await vi.waitFor(() => expect(turn()).toMatchObject({ threadId: action === 'reload' ? 'created' : 'one' }));
      expect(query).not.toHaveBeenCalled();
      expect(executeScript.mock.calls).toHaveLength(2);
      expect(executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ target: { tabId: tab.id } }));
      if (action === 'reload') expect(turn().chrome).not.toHaveProperty('pageContext');
      else expect(turn().chrome.pageContext).toEqual(text);
    },
  );

  it('sends the bound restricted page title and URL when scripting is blocked', async () => {
    const tab = { id: 31, windowId: 4, title: 'Downloads', url: 'chrome://downloads/' };
    vi.spyOn(document, 'URL', 'get').mockReturnValue(extensionUrl('sidepanel.html?tabId=31'));
    vi.stubGlobal('chrome', {
      runtime: { getURL: extensionUrl },
      permissions: { request: vi.fn().mockResolvedValue(false) },
      scripting: { executeScript: vi.fn().mockRejectedValue(new Error('Restricted Chrome page')) },
      tabs: { get: vi.fn().mockResolvedValue(tab) },
    });
    await mount();
    await selectThread('one');
    sendPromptWithPageContext();

    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      threadId: 'one',
      chrome: expect.objectContaining({
        pageContext: { title: tab.title, url: tab.url, pageText: '', selectedText: '' },
      }),
    })));
  });

  it.each(['stay', 'switch'] as const)('uses the global panel’s own window and %s during capture', async action => {
    const tab = { id: 31, windowId: 4, title: 'Orders', url: 'https://orders.invalid/' };
    const sibling = { id: 32, windowId: 4, title: 'Private', url: 'https://private.invalid/' };
    let activeTab = tab;
    let activate: (info: { tabId: number; windowId: number }) => void = () => {};
    const permission = deferred<boolean>();
    const query = vi.fn(async (_filter: { active: boolean; windowId: number }) => [activeTab]);
    const snapshot = { title: tab.title, url: tab.url, selectedText: '', pageText: 'Order 31' };
    const executeScript = vi.fn()
      .mockResolvedValueOnce([{ documentId: 'document', result: snapshot }])
      .mockResolvedValueOnce([{ documentId: 'document', result: tab.url }]);
    vi.spyOn(document, 'URL', 'get').mockReturnValue(extensionUrl('sidepanel.html'));
    vi.stubGlobal('chrome', {
      runtime: { getURL: extensionUrl, sendMessage: vi.fn().mockResolvedValue({ ok: true, selection: 'one' }) },
      sidePanel: { close: vi.fn(), onClosed: { addListener: vi.fn() } },
      windows: { getCurrent: vi.fn().mockResolvedValue({ id: 4 }) },
      permissions: { request: vi.fn(() => permission.promise) },
      scripting: { executeScript },
      tabs: {
        query,
        onActivated: {
          addListener: (listener: typeof activate) => { activate = listener; },
          removeListener: vi.fn(),
        },
      },
    });

    await mount();
    expect(element<HTMLSelectElement>('session').value).toBe('one');
    expect(element<HTMLButtonElement>('panelScope').getAttribute('aria-pressed')).toBe('true');
    sendPromptWithPageContext();
    activate({ tabId: 100, windowId: 8 });
    if (action === 'switch') {
      activeTab = sibling;
      activate({ tabId: sibling.id, windowId: sibling.windowId });
    }
    permission.resolve(true);

    const sent = () => mock.request.mock.calls.find(([method]) => method === 'turn/start')?.[1];
    await vi.waitFor(() => expect(sent()).toMatchObject({ threadId: 'one' }));
    expect(query.mock.calls.every(([filter]) =>
      Object.keys(filter).length === 2 && filter.active && filter.windowId === tab.windowId,
    )).toBe(true);
    if (action === 'switch') {
      expect(sent().chrome).not.toHaveProperty('pageContext');
      expect(executeScript).not.toHaveBeenCalled();
    } else {
      expect(sent().chrome.pageContext).toEqual(snapshot);
      expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: tab.id } }));
    }
  });

  it('keeps an explicit lower approval mode in an otherwise empty draft when switching scope', async () => {
    const browserRequest = vi.fn(async (_message: { type: string }) => ({ ok: true }));
    vi.spyOn(document, 'URL', 'get').mockReturnValue(extensionUrl('sidepanel.html?tabId=31'));
    vi.stubGlobal('chrome', {
      runtime: { getURL: extensionUrl, sendMessage: browserRequest },
      sidePanel: { close: vi.fn(), onClosed: { addListener: vi.fn() } },
      tabs: { get: vi.fn().mockResolvedValue({ id: 31, windowId: 4 }) },
    });
    await mount();
    const permission = element<HTMLSelectElement>('permission');
    const toggle = element<HTMLButtonElement>('panelScope');
    expect(toggle.disabled).toBe(false);
    permission.value = 'ask';
    permission.dispatchEvent(new Event('change'));

    toggle.click();

    expect(permission.value).toBe('ask');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(browserRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'side-panel:switch-scope' }),
    );
    expect(element('error').classList.contains('hidden')).toBe(false);
  });

  it('shows an attachment-only user bubble before a new chat is created', async () => {
    await mount();
    const attachment = {
      name: 'report.txt',
      type: 'text/plain',
      size: 1,
      arrayBuffer: async () => Uint8Array.of(65).buffer,
    };
    const files = element<HTMLInputElement>('fileInput');
    Object.defineProperty(files, 'files', { value: [attachment] });
    files.dispatchEvent(new Event('change'));
    const send = element<HTMLButtonElement>('send');
    await vi.waitFor(() => expect(send.disabled).toBe(false));

    const hostRequest = mock.request.getMockImplementation()!;
    const threadStart = deferred<{ thread: { id: string } }>();
    mock.request.mockImplementation((method, params) =>
      method === 'thread/start' ? threadStart.promise : hostRequest(method, params),
    );
    element<HTMLInputElement>('includePage').checked = false;
    send.click();

    const rawMessage = {
      role: 'user',
      content: [
        { type: 'text', text: '' },
        { type: 'attachment', attachment: {
          kind: 'document', label: 'report.txt', url: 'data:text/plain;base64,QQ==',
        } },
      ],
    };
    expect(mock.renderMessages).toHaveBeenLastCalledWith([{ role: 'user', text: '', rawMessage }], '');
    expect(mock.startStream).not.toHaveBeenCalled();
    threadStart.resolve({ thread: { id: 'created' } });
    await vi.waitFor(() => expect(mock.startStream).toHaveBeenCalledWith('', rawMessage, expect.any(String)));
    expect(mock.renderMessages).toHaveBeenCalledWith([{ role: 'user', text: '', rawMessage }], 'created');
  });

  it('collects visible main text and selection within the outgoing context limits', async () => {
    const tab = { id: 31, windowId: 4, title: 'Orders', url: window.location.href };
    const requestPermission = vi.fn().mockResolvedValue(true);
    const executeScript = vi.fn(async ({ func }: { func: () => unknown }) => [
      { documentId: 'current-document', result: func() },
    ]);
    vi.spyOn(document, 'URL', 'get').mockReturnValue(extensionUrl('sidepanel.html?tabId=31'));
    vi.stubGlobal('chrome', {
      runtime: { getURL: extensionUrl },
      permissions: { request: requestPermission },
      scripting: { executeScript },
      tabs: { get: vi.fn().mockResolvedValue(tab) },
    });
    await mount();
    await selectThread('one');
    document.title = tab.title;
    const heading = 'Orders queue\n\n';
    const main = element('messages');
    main.innerText = 'Orders\t  queue\n\n\n' + 'x'.repeat(24000);
    const selection = 's'.repeat(16000);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => selection + 'outside the selection limit',
    } as Selection);
    sendPromptWithPageContext();

    expect(requestPermission).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] });
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      threadId: 'one',
      chrome: expect.objectContaining({
        pageContext: {
          title: tab.title,
          url: tab.url,
          pageText: heading + 'x'.repeat(24000 - heading.length),
          selectedText: selection,
        },
      }),
    })));
  });

  it('preserves an explicit lower permission when refreshing an unsent ordinary draft', async () => {
    await mount();
    const permission = element<HTMLSelectElement>('permission');
    const prompt = element<HTMLTextAreaElement>('prompt');
    expect(permission.value).toBe('full');
    permission.value = 'ask';
    permission.dispatchEvent(new Event('change'));
    prompt.value = 'Check this ordinary draft';
    prompt.dispatchEvent(new Event('input'));
    element<HTMLInputElement>('includePage').checked = false;

    mock.request.mockClear();
    element<HTMLButtonElement>('refresh').click();
    await vi.waitFor(() => {
      expect(mock.request).toHaveBeenCalledWith('chrome/composer/options', {});
      expect(permission.disabled).toBe(false);
    });
    expect(permission.value).toBe('ask');
    element<HTMLButtonElement>('send').click();
    await vi.waitFor(() => expect(mock.request).toHaveBeenCalledWith('turn/start', expect.objectContaining({
      chrome: expect.objectContaining({ permissionMode: 'ask' }),
    })));
  });

  it('carries a human-selected draft folder and its token into thread/start only', async () => {
    await mount();
    const attach = vi.spyOn(element<HTMLInputElement>('fileInput'), 'click');
    element<HTMLButtonElement>('attach').click();
    expect(element('addMenu').classList.contains('hidden')).toBe(false);
    element<HTMLButtonElement>('attachFiles').click();
    expect(attach).toHaveBeenCalledOnce();
    element<HTMLButtonElement>('attach').click();
    element<HTMLButtonElement>('workspace').querySelector<HTMLButtonElement>('.workspace-button')!.click();
    expect(element('addMenu').classList.contains('hidden')).toBe(true);
    document.querySelector<HTMLButtonElement>('.workspace-popover button')!.click();
    await flush();
    const selection = mock.request.mock.calls.find(([method]) => method === 'chrome/workspace/select')![1];
    expect(selection).toEqual({ draftId: expect.any(String) });
    element<HTMLInputElement>('includePage').checked = false;
    const prompt = element<HTMLTextAreaElement>('prompt');
    prompt.value = 'Work in this folder';
    prompt.dispatchEvent(new Event('input'));
    element<HTMLButtonElement>('send').click();
    await vi.waitFor(() => expect(mock.request.mock.calls.some(([method]) => method === 'turn/start')).toBe(true));
    expect(mock.request).toHaveBeenCalledWith('thread/start', {
      cwd: 'E:/selected folder', chrome: { title: 'Work in this folder',
        workspaceSelectionToken: 'chosen-once', draftId: selection.draftId },
    });
    const turn = mock.request.mock.calls.find(([method]) => method === 'turn/start')![1];
    expect(turn).not.toHaveProperty('cwd');
    expect(turn.chrome).not.toHaveProperty('workspaceSelectionToken');
  });
});
