// @vitest-environment jsdom

import type { ScheduledTaskRun } from '@shared/scheduledTask/types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@/features/cowork/components/ChatMessageDisplay', () => ({
  default: () => React.createElement('div', null, 'chat-history'),
}));
vi.mock('@/libs/openclaw-chat/pipeline/history-display-normalizer', () => ({
  normalizeGatewayHistoryForDisplay: vi.fn(async (messages: unknown[]) => messages),
}));
vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key },
}));

import RunSessionModal, { isSilentScheduledTaskResult } from './RunSessionModal';

afterEach(() => cleanup());

test('recognizes only the exact OpenClaw silent reply marker', () => {
  expect(isSilentScheduledTaskResult('NO_REPLY')).toBe(true);
  expect(isSilentScheduledTaskResult('  no_reply  ')).toBe(true);
  expect(isSilentScheduledTaskResult('No reply was needed')).toBe(false);
  expect(isSilentScheduledTaskResult(null)).toBe(false);
});

test('shows intentional silence immediately without requesting unavailable history', () => {
  const resolveSession = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { scheduledTasks: { resolveSession } },
  });
  const run: ScheduledTaskRun = {
    id: 'run-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    sessionKey: 'agent:main:cron:task-1:run:session-1',
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
