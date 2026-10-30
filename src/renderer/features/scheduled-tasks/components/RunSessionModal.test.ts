// @vitest-environment jsdom

import type { ScheduledTaskRun } from '@shared/scheduledTask/types';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@/features/cowork/components/chat/ChatMessageDisplay', () => ({
  default: () => React.createElement('div', null, 'chat-history'),
}));
vi.mock('@/libs/openclaw-chat/pipeline/history-display-normalizer', () => ({
  normalizeGatewayHistoryForDisplay: vi.fn(async (messages: unknown[]) => messages),
}));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

import { normalizeGatewayHistoryForDisplay } from '@/libs/openclaw-chat/pipeline/history-display-normalizer';

import RunSessionModal, { isSilentScheduledTaskResult } from './RunSessionModal';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('recognizes only the exact OpenClaw silent reply marker', () => {
  expect(isSilentScheduledTaskResult('NO_REPLY')).toBe(true);
  expect(isSilentScheduledTaskResult('  no_reply  ')).toBe(true);
  expect(isSilentScheduledTaskResult('No reply was needed')).toBe(false);
  expect(isSilentScheduledTaskResult(null)).toBe(false);
});

test('shows intentional silence immediately when no session identity was recorded', () => {
  const resolveSession = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { scheduledTasks: { resolveSession } },
  });
  const run: ScheduledTaskRun = {
    id: 'run-1',
    taskId: 'task-1',
    sessionId: null,
    sessionKey: null,
    status: 'success',
    summary: 'NO_REPLY',
    startedAt: '2026-09-04T01:12:22.342Z',
    finishedAt: '2026-09-04T01:12:34.632Z',
    durationMs: 12_290,
    error: null,
    deliveryStatus: null,
    deliveryError: null,
  };

  const onClose = vi.fn();
  render(React.createElement(RunSessionModal, { run, onClose }));

  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText('scheduledTasksSilentResultTitle')).toBeTruthy();
  expect(screen.getByText('scheduledTasksSilentResultDescription')).toBeTruthy();
  expect(screen.queryByText('NO_REPLY')).toBeNull();
  expect(resolveSession).not.toHaveBeenCalled();

  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
});

test('does not describe a silent response with failed completion as normal completion', () => {
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { scheduledTasks: { resolveSession: vi.fn() } },
  });
  const run: ScheduledTaskRun = {
    id: 'run-incomplete',
    taskId: 'task',
    sessionId: null,
    sessionKey: null,
    status: 'success',
    summary: 'NO_REPLY',
    startedAt: '2026-10-31T01:00:00Z',
    finishedAt: '2026-10-31T01:00:01Z',
    durationMs: 1000,
    error: null,
    deliveryStatus: 'unknown',
    deliveryError: null,
    completionStatus: 'failed',
  };
  render(React.createElement(RunSessionModal, { run, onClose: vi.fn() }));

  expect(screen.queryByText('scheduledTasksSilentResultTitle')).toBeNull();
  expect(
    screen.getByText('scheduledTasksCompletionLabel: scheduledTasksCompletionFailed'),
  ).toBeTruthy();
  expect(screen.queryByText('NO_REPLY')).toBeNull();
});

test('reports exhausted history lookups and clears the failure after a successful retry', async () => {
  vi.useFakeTimers();
  const resolveSession = vi.fn().mockResolvedValue({ success: true, history: null });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { scheduledTasks: { resolveSession } },
  });
  const run: ScheduledTaskRun = {
    id: 'run-retry',
    taskId: 'task-1',
    sessionId: 'session-1',
    sessionKey: 'agent:main:cron:task-1:run:session-1',
    status: 'success',
    summary: 'Saved summary',
    startedAt: '2026-09-24T00:00:00Z',
    finishedAt: '2026-09-24T00:00:01Z',
    durationMs: 1000,
    error: null,
    deliveryStatus: null,
    deliveryError: null,
  };
  const onAvailabilityChange = vi.fn();
  await act(async () => {
    render(React.createElement(RunSessionModal, { run, onClose: vi.fn(), onAvailabilityChange }));
  });
  expect(onAvailabilityChange).not.toHaveBeenCalled();
  for (let retry = 0; retry < 5; retry += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
  }
  expect(onAvailabilityChange).toHaveBeenLastCalledWith(run.id, false);
  expect(screen.getByText('scheduledTasksFullResultUnavailableTitle')).toBeTruthy();
  expect(screen.getByText('Saved summary')).toBeTruthy();

  resolveSession.mockResolvedValue({
    success: true,
    history: {
      sessionKey: run.sessionKey,
      messages: [{ role: 'assistant', content: 'Recovered' }],
    },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'scheduledTasksSessionRetry' }));
  });
  expect(onAvailabilityChange).toHaveBeenLastCalledWith(run.id, true);
  expect(screen.getByText('chat-history')).toBeTruthy();
  expect(screen.queryByText('scheduledTasksFullResultUnavailableTitle')).toBeNull();
});

test('reads execution history even when the final reply was NO_REPLY', async () => {
  const resolveSession = vi.fn().mockResolvedValue({
    success: true,
    history: { sessionKey: 'key', messages: [{ role: 'toolResult', content: 'Executed work' }] },
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { scheduledTasks: { resolveSession } },
  });
  const run: ScheduledTaskRun = {
    id: 'silent-run',
    taskId: 'task',
    sessionId: 'sid',
    sessionKey: 'key',
    status: 'success',
    summary: 'NO_REPLY',
    error: null,
    startedAt: '2026-09-24T00:00:00Z',
    finishedAt: '2026-09-24T00:00:01Z',
    durationMs: 1000,
    deliveryStatus: null,
    deliveryError: null,
  };
  await act(async () => {
    render(React.createElement(RunSessionModal, { run, onClose: vi.fn() }));
  });
  expect(resolveSession).toHaveBeenCalledOnce();
  expect(screen.getByText('chat-history')).toBeTruthy();
});

test.each(['not-found', 'empty'] as const)(
  'does not retry a completed run with a definitive %s result',
  async unavailableReason => {
    vi.useFakeTimers();
    const resolveSession = vi.fn().mockResolvedValue({
      success: true,
      history: { sessionKey: 'key', messages: [], unavailableReason },
    });
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { scheduledTasks: { resolveSession } },
    });
    const run: ScheduledTaskRun = {
      id: 'run',
      taskId: 'task',
      sessionId: 'sid',
      sessionKey: 'key',
      status: 'error',
      summary: null,
      error: 'Saved error',
      startedAt: '2026-09-24T00:00:00Z',
      finishedAt: '2026-09-24T00:00:01Z',
      durationMs: 1000,
      deliveryStatus: null,
      deliveryError: null,
    };
    await act(async () => {
      render(React.createElement(RunSessionModal, { run, onClose: vi.fn() }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(resolveSession).toHaveBeenCalledOnce();
    expect(
      screen.getByText(
        unavailableReason === 'not-found'
          ? 'scheduledTasksSessionRecordMissing'
          : 'scheduledTasksSessionRecordEmpty',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Saved error')).toBeTruthy();
  },
);

test('treats a completed transcript containing only hidden messages as empty without retrying', async () => {
  vi.useFakeTimers();
  vi.mocked(normalizeGatewayHistoryForDisplay).mockResolvedValueOnce([]);
  const resolveSession = vi.fn().mockResolvedValue({
    success: true,
    history: { sessionKey: 'key', messages: [{ role: 'assistant', content: 'NO_REPLY' }] },
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { scheduledTasks: { resolveSession } },
  });
  const run: ScheduledTaskRun = {
    id: 'hidden-run',
    taskId: 'task',
    sessionId: 'sid',
    sessionKey: 'key',
    status: 'success',
    summary: 'NO_REPLY',
    error: null,
    startedAt: '2026-09-24T00:00:00Z',
    finishedAt: '2026-09-24T00:00:01Z',
    durationMs: 1000,
    deliveryStatus: null,
    deliveryError: null,
  };
  await act(async () => {
    render(React.createElement(RunSessionModal, { run, onClose: vi.fn() }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(resolveSession).toHaveBeenCalledOnce();
  expect(screen.getByText('scheduledTasksSessionRecordEmpty')).toBeTruthy();
  expect(screen.queryByText('scheduledTasksFullResultUnavailableDescription')).toBeNull();
});
