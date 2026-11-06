// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApprovalPanel } from '../conversation-overlay/modules/sidepanel-approvals.js';

const command = (id = 'approval') => ({ id, method: 'item/commandExecution/requestApproval', params: {
  threadId: 'thread', turnId: 'turn', itemId: 'item', command: 'cat <private>.txt',
  cwd: '/task folder', reason: 'Read the selected file',
} });
const question = (questions: unknown[]) => ({ id: 'question', method: 'item/tool/requestUserInput', params: {
  threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, questions,
} });

describe('transient standard approval forms', () => {
  let root: HTMLElement;
  let current: boolean;
  let panel: ReturnType<typeof createApprovalPanel>;
  beforeEach(() => {
    document.body.innerHTML = '<textarea id="draft">Unsent draft</textarea><section class="hidden"></section>';
    root = document.querySelector('section')!;
    current = true;
    panel = createApprovalPanel(root, { isCurrent: () => current });
  });
  afterEach(() => panel.dispose());

  it('shows exact command context as text and responds only once to an explicit choice', async () => {
    const result = panel.request(command());
    expect(root.textContent).toContain('cat <private>.txt');
    expect(root.textContent).toContain('/task folder');
    expect(root.textContent).toContain('Read the selected file');
    expect(root.querySelector('private')).toBeNull();
    expect(root.querySelector('[data-decision="acceptForSession"]')).toBeNull();
    const allow = root.querySelector<HTMLButtonElement>('[data-decision="accept"]')!;
    allow.click();
    allow.click();
    await expect(result).resolves.toEqual({ decision: 'accept' });
    expect(root.classList.contains('hidden')).toBe(true);
    expect((document.getElementById('draft') as HTMLTextAreaElement).value).toBe('Unsent draft');
  });

  it('keeps rejection and explicit execution cancellation distinct and hides unsupported grants', async () => {
    const request = { ...command(), params: { ...command().params,
      availableDecisions: ['decline', 'cancel', { acceptWithExecpolicyAmendment: [] }] } };
    const cancelled = panel.request(request);
    expect(root.querySelector('[data-decision="accept"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[data-decision="cancel"]')!.click();
    await expect(cancelled).resolves.toEqual({ decision: 'cancel' });
    const rejected = panel.request(command('next'));
    root.querySelector<HTMLButtonElement>('[data-decision="decline"]')!.click();
    await expect(rejected).resolves.toEqual({ decision: 'decline' });
  });

  it('offers a session decision only when the current server request explicitly advertises it', async () => {
    const result = panel.request({ ...command(), params: { ...command().params,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } });
    root.querySelector<HTMLButtonElement>('[data-decision="acceptForSession"]')!.click();
    await expect(result).resolves.toEqual({ decision: 'acceptForSession' });
    const ordinary = panel.request(command('ordinary'));
    expect(root.querySelector('[data-decision="acceptForSession"]')).toBeNull();
    panel.cancelAll();
    await expect(ordinary).resolves.toEqual({ decision: 'decline' });
  });

  it('requires an explicit answer to every question and returns the exact selected labels', async () => {
    const result = panel.request(question([
      { id: 'permission', header: 'Tool access', question: 'Allow this tool?', isOther: false,
        options: [{ label: 'Allow once', description: 'One request' }, { label: 'Deny', description: 'Reject' }] },
      { id: 'note', header: 'Note', question: 'What should be included?', options: null },
    ]));
    const submit = root.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(true);
    expect(root.querySelectorAll('input:checked')).toHaveLength(0);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(root.classList.contains('hidden')).toBe(false);
    root.querySelector<HTMLInputElement>('input[type="radio"]')!.click();
    expect(submit.disabled).toBe(true);
    const answer = root.querySelector<HTMLInputElement>('input[type="text"]')!;
    answer.value = 'Chosen details';
    answer.dispatchEvent(new Event('input'));
    expect(submit.disabled).toBe(false);
    submit.click();
    await expect(result).resolves.toEqual({ answers: {
      permission: { answers: ['Allow once'] }, note: { answers: ['Chosen details'] },
    } });
  });

  it('supports a secret other answer without displaying or retaining its value after withdrawal', async () => {
    const controller = new AbortController();
    const result = panel.request(question([{ id: 'secret', header: 'Access', question: 'Provide the value',
      isSecret: true, isOther: true, options: [{ label: 'Skip', description: 'No value' }] }]),
    { signal: controller.signal });
    const input = root.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.disabled).toBe(true);
    root.querySelector<HTMLInputElement>('input[value="other"]')!.click();
    input.value = 'private answer';
    input.dispatchEvent(new Event('input'));
    expect(input.disabled).toBe(false);
    expect(root.textContent).not.toContain('private answer');
    expect(input.autocomplete).toBe('off');
    controller.abort();
    await expect(result).resolves.toEqual({ answers: {} });
    expect(input.value).toBe('');
    expect(root.childElementCount).toBe(0);
  });

  it('renders an explicit native App grant without inventing it for other requests or reusing a withdrawn choice', async () => {
    const once = { label: 'Allow once', description: 'This request only' };
    const persistent = { label: 'Always allow this App', description: 'Persist the requested permissions; manage them in App settings.' };
    const deny = { label: 'Deny', description: 'Reject' };
    const appQuestion = (options: unknown[]) => question([{ id: 'permission', header: 'App permissions',
      question: 'Allow this App to read selected files?', isOther: false, options }]);
    const result = panel.request(appQuestion([once, persistent, deny]));
    expect(root.querySelectorAll('input:checked')).toHaveLength(0);
    expect(root.textContent).toContain('manage them in App settings');
    root.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1].click();
    root.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await expect(result).resolves.toEqual({ answers: { permission: { answers: ['Always allow this App'] } } });
    const ordinary = panel.request({ ...appQuestion([once, deny]), id: 'ordinary' });
    expect(root.textContent).not.toContain('Always allow this App');
    panel.cancelAll();
    await expect(ordinary).resolves.toEqual({ answers: {} });
    const controller = new AbortController();
    const withdrawn = panel.request({ ...appQuestion([once, persistent, deny]), id: 'withdrawn' }, { signal: controller.signal });
    const stale = root.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1];
    controller.abort();
    stale.click();
    await expect(withdrawn).resolves.toEqual({ answers: {} });
    expect(root.childElementCount).toBe(0);
  });

  it('never grants an old owner and drains queued forms on a conversation change', async () => {
    const first = panel.request(command());
    const second = panel.request(command('second'));
    const staleAllow = root.querySelector<HTMLButtonElement>('[data-decision="accept"]')!;
    expect(root.querySelector('.approval-count')!.textContent).toContain('2');
    current = false;
    staleAllow.click();
    await expect(first).resolves.toEqual({ decision: 'decline' });
    await expect(second).resolves.toEqual({ decision: 'decline' });
    staleAllow.click();
    expect(root.childElementCount).toBe(0);
  });

  it('dismisses only the exact completed turn and rejects malformed or oversized requests', async () => {
    const result = panel.request(command());
    panel.cancelTurn('thread', 'other');
    expect(root.classList.contains('hidden')).toBe(false);
    panel.cancelTurn('thread', 'turn');
    await expect(result).resolves.toEqual({ decision: 'decline' });
    await expect(panel.request(question([{ id: 'same', header: '', question: 'Question', options: [
      { label: 'Repeated', description: '' }, { label: 'Repeated', description: '' },
    ] }]))).resolves.toEqual({ answers: {} });
    await expect(panel.request({ ...command(), params: { ...command().params,
      command: 'x'.repeat(65537) } })).resolves.toEqual({ decision: 'decline' });
    expect(root.childElementCount).toBe(0);
  });
});
