// @vitest-environment jsdom
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  notify: (_method: string, _params: unknown) => {},
  request: vi.fn(),
  disconnect: vi.fn(),
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
  createMessageRenderer: () => ({ render: vi.fn(), dispose: vi.fn() }),
}));
vi.mock('../conversation-overlay/modules/sidepanel-activity.js', () => ({
  createRunActivityView: () => ({ render: vi.fn(), dispose: vi.fn() }),
}));
vi.mock('../conversation-overlay/modules/web-launch-panel.js', () => ({
  createWebLaunchPanel: () => ({
    inputAssociated: () => false, ownsThread: () => false,
    publishState: vi.fn(), ready: vi.fn(), edit: vi.fn(), dispose: vi.fn(), blocked: () => false,
  }),
}));
vi.mock('../conversation-overlay/modules/sidepanel-stream.js', () => ({
  ChromeExtensionStream: class {
    id: string;
    constructor(id: string) { this.id = id; }
    project() { return { id: this.id, turns: [] }; }
    setHistory() {}
    start() {}
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
    if (method === 'chrome/composer/options') return { cwd: 'E:/default', recentCwds: [], modelRef: 'p/m', permissionMode: 'ask' };
    if (method === 'model/list') return { data: [{ id: 'p/m', displayName: 'Model' }], nextCursor: null };
    if (method === 'chrome/questions/list') return { questions: [question] };
    if (method === 'thread/start') return { thread: { id: 'created', cwd: 'E:/selected folder', name: 'Created' } };
    if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress' } };
    if (method === 'chrome/workspace/select') return { cwd: 'E:/selected folder', selectionToken: 'chosen-once' };
    return {};
  });
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

describe('sidepanel working directory and question integration', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mock.questions.hasPending = false;
    mock.questionOptions = null;
  });
  afterEach(() => window.dispatchEvent(new Event('unload')));

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

  it('keeps questions suspended when a refresh fails and never manufactures an answer', async () => {
    await mount();
    await selectThread('one');
    mock.questions.setQuestions.mockClear();
    mock.request.mockRejectedValueOnce(new Error('Pending snapshot unavailable'));
    mock.notify('chrome/questions/changed', { threadId: 'one' });
    await flush();
    expect(mock.questions.setSuspended).toHaveBeenLastCalledWith(true);
    expect(mock.questions.setQuestions).not.toHaveBeenCalled();
    expect(element('error').textContent).toContain('Pending snapshot unavailable');
    expect(mock.request.mock.calls.some(([method]) => method === 'chrome/questions/respond')).toBe(false);
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
