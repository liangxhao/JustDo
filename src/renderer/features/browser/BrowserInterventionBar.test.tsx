// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { BrowserInterventionBar } from './BrowserInterventionBar';

const reference = { sessionId: 'session', targetId: 'page', profile: 'embedded' };
let phase: 'stopping' | 'manual' | 'resuming' | null;
const api = vi.fn(async ({ action }: { action: string }) => {
  if (action === 'begin') phase = 'stopping';
  if (action === 'confirmStop') phase = 'manual';
  if (action === 'resume') phase = 'resuming';
  if (action === 'complete') phase = null;
  return { success: true, value: phase ? { token: 'token', targetId: 'page', phase } : null };
});
beforeEach(() => {
  vi.useFakeTimers();
  phase = null;
  api.mockClear();
  i18nService.setLanguage('en', { persist: false });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { browser: { intervention: api } },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

test('recovers when the guest registers after the first state read', async () => {
  api.mockRejectedValueOnce(new Error('guest not registered yet'));
  const blocked = vi.fn();
  render(
    <BrowserInterventionBar
      reference={reference}
      active
      browserOperationRunning
      onStop={async () => true}
      onContinue={async () => 'sent'}
      onBlockedChange={blocked}
    />,
  );
  await settle();
  expect(blocked).toHaveBeenLastCalledWith(false);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(blocked).toHaveBeenLastCalledWith(false);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('idle pages have no stop button or interaction lock, but a manual hold keeps its continue action', async () => {
  const blocked = vi.fn();
  const props = {
    reference,
    active: true,
    onStop: async () => true,
    onContinue: async () => 'sent' as const,
    onBlockedChange: blocked,
  };
  const view = render(<BrowserInterventionBar {...props} browserOperationRunning={false} />);
  await settle();
  expect(screen.queryByTestId('browser-intervention-bar')).toBeNull();
  expect(blocked).toHaveBeenLastCalledWith(false);
  view.rerender(<BrowserInterventionBar {...props} browserOperationRunning />);
  expect(screen.getByRole('button', { name: 'Stop task and interact manually' })).toBeTruthy();
  view.rerender(<BrowserInterventionBar {...props} browserOperationRunning={false} />);
  expect(screen.queryByTestId('browser-intervention-bar')).toBeNull();
  phase = 'manual';
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(screen.getByRole('button', { name: 'Done, continue task' })).toBeTruthy();
  expect(blocked).toHaveBeenLastCalledWith(false);
});

test('waits for task stop, permits manual input and continues only once with fresh observation', async () => {
  let finish!: (value: boolean) => void;
  const stop = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        finish = resolve;
      }),
  );
  const resume = vi.fn(async (_prompt: string) => 'sent' as const);
  const blocked = vi.fn();
  render(
    <BrowserInterventionBar
      reference={reference}
      active
      browserOperationRunning
      onStop={stop}
      onContinue={resume}
      onBlockedChange={blocked}
    />,
  );
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Stop task and interact manually' }));
  await settle();
  expect(blocked).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole('button', { name: 'Done, continue task' })).toBeNull();
  await act(async () => {
    finish(true);
  });
  expect(blocked).toHaveBeenLastCalledWith(false);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'signed in' } });
  const button = screen.getByRole('button', { name: 'Done, continue task' });
  fireEvent.click(button);
  fireEvent.click(button);
  await settle();
  expect(resume).toHaveBeenCalledOnce();
  expect(resume.mock.calls[0][0]).toContain('List the currently open tabs');
  expect(resume.mock.calls[0][0]).toContain('signed in');
  expect(phase).toBeNull();
});

test('failed stop keeps the page blocked and never grants manual control', async () => {
  const blocked = vi.fn();
  render(
    <BrowserInterventionBar
      reference={reference}
      active
      browserOperationRunning
      onStop={async () => false}
      onContinue={async () => 'sent'}
      onBlockedChange={blocked}
    />,
  );
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Stop task and interact manually' }));
  await settle();
  expect(blocked).toHaveBeenLastCalledWith(true);
  expect(phase).toBe('stopping');
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('alert')).toBeTruthy();
});

test('reload preserves manual hold and unknown continuation requires a new stop', async () => {
  phase = 'manual';
  const resume = vi.fn(async () => 'unknown' as const);
  const blocked = vi.fn();
  const view = render(
    <BrowserInterventionBar
      reference={reference}
      active
      browserOperationRunning
      onStop={async () => true}
      onContinue={resume}
      onBlockedChange={blocked}
    />,
  );
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Done, continue task' }));
  await settle();
  expect(phase).toBe('resuming');
  view.unmount();
  render(
    <BrowserInterventionBar
      reference={reference}
      active
      browserOperationRunning
      onStop={async () => true}
      onContinue={resume}
      onBlockedChange={blocked}
    />,
  );
  await settle();
  expect(screen.queryByRole('button', { name: 'Done, continue task' })).toBeNull();
  expect(resume).toHaveBeenCalledOnce();
  expect(blocked).toHaveBeenLastCalledWith(true);
});

test('reconciles delayed stop confirmation without stopping the task again', async () => {
  const stop = vi.fn(async () => false);
  const checkStopped = vi.fn(async () => false);
  const blocked = vi.fn();
  render(
    <BrowserInterventionBar
      reference={reference}
      active
      browserOperationRunning
      onStop={stop}
      onCheckStopped={checkStopped}
      onContinue={async () => 'sent'}
      onBlockedChange={blocked}
    />,
  );
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Stop task and interact manually' }));
  await settle();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(blocked).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole('textbox')).toBeNull();
  checkStopped.mockResolvedValue(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(blocked).toHaveBeenLastCalledWith(false);
  expect(stop).toHaveBeenCalledOnce();
  expect(api.mock.calls.filter(([request]) => request.action === 'begin')).toHaveLength(1);
});

test('restored stopping state recovers after a failed runtime read without resending stop', async () => {
  phase = 'stopping';
  const stop = vi.fn(async () => true);
  const checkStopped = vi.fn(async () => true).mockRejectedValueOnce(new Error('disconnected'));
  const blocked = vi.fn();
  render(
    <BrowserInterventionBar
      reference={reference}
      active
      browserOperationRunning={false}
      onStop={stop}
      onCheckStopped={checkStopped}
      onContinue={async () => 'sent'}
      onBlockedChange={blocked}
    />,
  );
  await settle();
  expect(blocked).toHaveBeenLastCalledWith(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2500);
  });
  expect(screen.getByRole('textbox')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(blocked).toHaveBeenLastCalledWith(false);
  expect(stop).not.toHaveBeenCalled();
});

test('an unmounted status check cannot confirm a different intervention', async () => {
  phase = 'stopping';
  let finish!: (stopped: boolean) => void;
  const view = render(
    <BrowserInterventionBar
      reference={reference}
      active
      browserOperationRunning
      onStop={async () => false}
      onCheckStopped={() =>
        new Promise(resolve => {
          finish = resolve;
        })
      }
      onContinue={async () => 'sent'}
      onBlockedChange={vi.fn()}
    />,
  );
  await settle();
  view.unmount();
  await act(async () => {
    finish(true);
  });
  expect(api.mock.calls.some(([request]) => request.action === 'confirmStop')).toBe(false);
});

test('confirmed task stop still waits for browser work to drain without polling the task again', async () => {
  phase = 'stopping';
  const original = api.getMockImplementation()!;
  api.mockImplementation(async request => {
    const result = await original(request);
    return { ...result, value: result.value ? { ...result.value, stopConfirmed: true } : null };
  });
  const checkStopped = vi.fn(async () => true);
  const blocked = vi.fn();
  try {
    render(
      <BrowserInterventionBar
        reference={reference}
        active
        browserOperationRunning={false}
        onStop={async () => true}
        onCheckStopped={checkStopped}
        onContinue={async () => 'sent'}
        onBlockedChange={blocked}
      />,
    );
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(blocked).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(checkStopped).not.toHaveBeenCalled();
    phase = 'manual';
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByRole('textbox')).toBeTruthy();
    expect(blocked).toHaveBeenLastCalledWith(false);
  } finally {
    api.mockImplementation(original);
  }
});

test('keeps a manual hold recoverable after the original tab is closed', async () => {
  phase = 'manual';
  const resume = vi.fn(async (_prompt: string) => 'sent' as const);
  const props = {
    active: true,
    browserOperationRunning: false,
    onStop: async () => true,
    onContinue: resume,
    onBlockedChange: vi.fn(),
  };
  const view = render(<BrowserInterventionBar {...props} reference={reference} />);
  await settle();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Signed in' } });
  view.rerender(
    <BrowserInterventionBar {...props} reference={{ ...reference, targetId: '__panel__' }} />,
  );
  await settle();
  const button = screen.getByRole('button', { name: 'Done, continue task' });
  expect(button).toHaveProperty('disabled', false);
  fireEvent.click(button);
  await settle();
  expect(resume).toHaveBeenCalledOnce();
  expect(resume.mock.calls[0][0]).toContain('Signed in');
  expect(resume.mock.calls[0][0]).toContain('List the currently open tabs');
  expect(api.mock.calls.some(([request]) => request.action === 'complete')).toBe(true);
});
