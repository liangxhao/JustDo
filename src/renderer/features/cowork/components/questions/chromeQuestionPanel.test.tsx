// @vitest-environment jsdom
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChromeQuestion,createQuestionPanel } from './chromeQuestionPanel';

const question = (requestId = 'ask-1'): ChromeQuestion => ({
  requestId,
  waitPolicy: { mode: 'required' },
  questions: [{
    id: 'targets', question: 'Choose targets', multiSelect: true,
    defaultOptionIds: ['mobile'],
    options: [{ id: 'desktop', label: 'Desktop', input: { label: 'Version' } },
      { id: 'mobile', label: 'Mobile' }],
  }, {
    id: 'region', question: 'Choose a region',
    options: [{ id: 'east', label: 'East' }, { id: 'west', label: 'West' }],
  }],
});

describe('Chrome host adapter for the desktop question wizard', () => {
  let root: HTMLElement;
  let panel: ReturnType<typeof createQuestionPanel>;
  let respond: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    document.body.innerHTML = '<textarea id="draft">Unsent draft</textarea><section id="questions"></section>';
    root = document.getElementById('questions')!;
    respond = vi.fn(async () => ({}));
    act(() => { panel = createQuestionPanel(root, { respond }); });
  });
  afterEach(() => {
    act(() => panel.dispose());
    vi.useRealTimers();
  });
  const show = (thread = 'thread', questions = [question()]) =>
    act(() => panel.setQuestions(thread, questions));

  it('uses desktop multi-select, required option input, Other and per-question skip with exact IDs', async () => {
    show();
    const view = within(root);
    expect(root.querySelectorAll('input:checked')).toHaveLength(0);
    fireEvent.click(root.querySelector('input[value="desktop"]')!);
    expect(view.queryByRole('button', { name: /Next|下一个/ })).toBeNull();
    fireEvent.change(view.getByLabelText('Version'), { target: { value: '24' } });
    fireEvent.click(root.querySelector('input[value="mobile"]')!);
    fireEvent.click(view.getByRole('checkbox', { name: /Other|其他/ }));
    fireEvent.change(view.getByPlaceholderText(/custom answer|自定义答案/), { target: { value: 'Tablet' } });
    fireEvent.click(view.getByRole('button', { name: /Next|下一个/ }));
    fireEvent.click(view.getByRole('button', { name: /Skip|跳过/ }));
    fireEvent.click(view.getByRole('button', { name: /^Submit$|^提交$/ }));
    await waitFor(() => expect(respond).toHaveBeenCalledExactlyOnceWith('thread', 'ask-1', {
      behavior: 'submit', answers: {
        targets: { selected: ['desktop', 'mobile'], optionInputs: { desktop: '24' }, other: 'Tablet' },
        region: { selected: [], skipped: true },
      },
    }));
    await waitFor(() => expect(panel.hasPending).toBe(false));
    expect((document.getElementById('draft') as HTMLTextAreaElement).value).toBe('Unsent draft');
  });

  it('preserves the same draft through authoritative refresh and higher priority approval suspension', () => {
    show();
    fireEvent.click(root.querySelector('input[value="desktop"]')!);
    fireEvent.change(within(root).getByLabelText('Version'), { target: { value: 'Draft' } });
    show('thread', [{ ...question(), createdAt: 123 }]);
    expect((within(root).getByLabelText('Version') as HTMLTextAreaElement).value).toBe('Draft');
    act(() => panel.setSuspended(true));
    expect(root.hidden).toBe(true);
    expect(root.inert).toBe(true);
    act(() => panel.setSuspended(false));
    expect(root.hidden).toBe(false);
    expect((within(root).getByLabelText('Version') as HTMLTextAreaElement).value).toBe('Draft');
    expect(respond).not.toHaveBeenCalled();
  });

  it('withdraws on disconnect or thread change without answering, cancelling or replaying', () => {
    show();
    fireEvent.click(root.querySelector('input[value="mobile"]')!);
    act(() => panel.clear());
    expect(root.hidden).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    show('other-thread', [question('ask-2')]);
    expect(root.querySelectorAll('input:checked')).toHaveLength(0);
    expect(respond).not.toHaveBeenCalled();
  });

  it('does not apply defaults or send an answer when the displayed countdown reaches zero', () => {
    vi.useFakeTimers();
    show('thread', [{ ...question(), waitPolicy: {
      mode: 'timeout', timeoutMinutes: 1, onTimeout: 'model-decides',
    }, expiresAt: Date.now() + 1000 }]);
    act(() => vi.advanceTimersByTime(2000));
    expect(root.textContent).toContain('00:00');
    expect(root.querySelectorAll('input:checked')).toHaveLength(0);
    expect(respond).not.toHaveBeenCalled();
    show('thread', []);
    expect(panel.hasPending).toBe(false);
  });

  it('only cancels a question after the explicit desktop Cancel request action', async () => {
    show();
    fireEvent.click(within(root).getByRole('button', { name: /^Cancel request$|^取消请求$/ }));
    await waitFor(() => expect(respond).toHaveBeenCalledExactlyOnceWith('thread', 'ask-1', { behavior: 'cancel' }));
  });

  it('does not clear another thread when a prior answer finishes late', async () => {
    let finish!: () => void;
    respond.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    show();
    fireEvent.click(within(root).getByRole('button', { name: /^Cancel request$|^取消请求$/ }));
    show('new-thread', [question('ask-new')]);
    await act(async () => finish());
    expect(panel.hasPending).toBe(true);
    expect(root.querySelector('[id*="ask-new"]')).toBeTruthy();
  });
});
