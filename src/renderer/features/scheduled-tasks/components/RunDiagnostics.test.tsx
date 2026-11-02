// @vitest-environment jsdom

import type { ScheduledTaskRun, TaskState } from '@shared/scheduledTask/types';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';

import RunDiagnostics from './RunDiagnostics';
import TaskStateNotice from './TaskStateNotice';

afterEach(cleanup);

const run: ScheduledTaskRun = {
  id: 'run',
  taskId: 'task',
  sessionId: null,
  sessionKey: null,
  status: 'success',
  summary: 'Report ready',
  startedAt: '2026-10-31T01:00:00Z',
  finishedAt: '2026-10-31T01:00:01Z',
  durationMs: 1000,
  error: null,
  deliveryStatus: null,
  deliveryError: null,
};

test('keeps overall completion and notification outcomes separate from execution success', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(
    <RunDiagnostics run={{ ...run, completionStatus: 'failed', deliveryStatus: 'unknown' }} />,
  );

  expect(screen.getByText('整体完成: 未完成')).toBeTruthy();
  expect(screen.getByText('外部通知: 发送结果未知')).toBeTruthy();
  expect(screen.queryByText('执行失败')).toBeNull();
});

test('shows a native skip reason even when no session exists', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(
    <RunDiagnostics
      run={{
        ...run,
        status: 'skipped',
        error: 'Model endpoint is unavailable',
        errorReason: 'model_not_found',
      }}
      compact
    />,
  );

  expect(screen.getByText('Model endpoint is unavailable')).toBeTruthy();
  expect(screen.getByText('原因: 配置的模型不可用。')).toBeTruthy();
});

test('does not turn a suppressed notification into an execution failure', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(
    <RunDiagnostics
      run={{ ...run, deliveryStatus: 'not-delivered', deliverySuppressionReason: 'silent-reply' }}
    />,
  );

  const delivery = screen.getByText('外部通知: 未发送');
  expect(delivery.className).not.toContain('red');
  expect(screen.getByText('未发送原因: silent-reply')).toBeTruthy();
  expect(screen.queryByText(/外部通知失败/)).toBeNull();
});

test('shows real historical routing errors instead of hiding them', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(
    <RunDiagnostics run={{ ...run, deliveryError: 'announce requires a delivery channel' }} />,
  );

  expect(screen.getByText('外部通知失败: announce requires a delivery channel')).toBeTruthy();
});

test('shows actual model and supplied zero usage without inventing a total', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(
    <RunDiagnostics
      run={{
        ...run,
        model: 'internal/report',
        provider: 'internal',
        usage: { input_tokens: 0, output_tokens: 12 },
      }}
    />,
  );

  expect(screen.getByText('实际模型: internal/report')).toBeTruthy();
  expect(screen.getByText('Token 用量: 输入 0 · 输出 12')).toBeTruthy();
  expect(screen.queryByText(/总计/)).toBeNull();
});

test('keeps native diagnostics as text and preserves explicit exit code zero', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(
    <RunDiagnostics
      run={{
        ...run,
        diagnostics: {
          entries: [
            {
              ts: 1,
              source: 'exec',
              severity: 'warn',
              message: '<script>diagnostic</script>',
              exitCode: 0,
              truncated: true,
            },
          ],
        },
      }}
    />,
  );

  expect(
    screen.getAllByText('<script>diagnostic</script>').some(message => !message.closest('details')),
  ).toBe(true);
  expect(screen.getByText('退出码: 0 · 内容已截断')).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
});

test('does not invent completion, model, or usage facts for old records', () => {
  const view = render(<RunDiagnostics run={run} />);
  expect(view.container.textContent).toBe('');
});

test('keeps routine metadata and informational diagnostics out of the inbox preview', () => {
  const view = render(
    <RunDiagnostics
      run={{
        ...run,
        completionStatus: 'succeeded',
        deliveryStatus: 'not-requested',
        model: 'internal/report',
        usage: { total_tokens: 42 },
        diagnostics: {
          summary: 'Routine checks passed',
          entries: [
            { ts: 1, source: 'agent-run', severity: 'info', message: 'Routine checks passed' },
          ],
        },
      }}
      issuesOnly
      compact
    />,
  );

  expect(view.container.textContent).toBe('');
});

test('keeps execution warnings visible while completion and delivery metadata stay folded', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(
    <RunDiagnostics
      run={{
        ...run,
        summary: 'NO_REPLY',
        completionStatus: 'unknown',
        deliveryStatus: 'unknown',
        deliveryError: 'Internal notification endpoint unavailable',
        diagnostics: {
          summary: 'Run finished',
          entries: [
            { ts: 1, source: 'agent-run', severity: 'info', message: 'Starting' },
            { ts: 2, source: 'tool', severity: 'warn', message: 'Report attachment is missing' },
            { ts: 3, source: 'delivery', severity: 'error', message: 'Notification failed' },
          ],
        },
      }}
      issuesOnly
      compact
    />,
  );

  expect(screen.queryByText('整体完成: 结果未知')).toBeNull();
  expect(screen.queryByText('外部通知: 发送结果未知')).toBeNull();
  expect(screen.queryByText('外部通知失败: Internal notification endpoint unavailable')).toBeNull();
  expect(screen.queryByText('Notification failed')).toBeNull();
  expect(
    screen.getAllByText('Report attachment is missing').some(node => !node.closest('details')),
  ).toBe(true);
  expect(screen.queryByText('Starting')).toBeNull();
  expect(screen.queryByText('Run finished')).toBeNull();
});

test('keeps delivery outcomes out of the inbox preview regardless of suppression', () => {
  i18nService.setLanguage('zh', { persist: false });
  const view = render(
    <RunDiagnostics
      run={{
        ...run,
        status: 'error',
        error: 'Notification failed',
        errorReason: 'timeout',
        deliveryStatus: 'not-delivered',
        deliveryError: 'Notification failed',
        diagnostics: {
          summary: 'Notification failed',
          entries: [
            { ts: 1, source: 'delivery', severity: 'error', message: 'Notification failed' },
          ],
        },
      }}
      issuesOnly
    />,
  );
  expect(view.container.textContent).toBe('');
  view.rerender(
    <RunDiagnostics
      run={{
        ...run,
        status: 'error',
        diagnostics: {
          summary: 'Notification failed',
          entries: [
            { ts: 1, source: 'delivery', severity: 'error', message: 'Notification failed' },
          ],
        },
      }}
      issuesOnly
    />,
  );
  expect(view.container.textContent).toBe('');
  view.rerender(
    <RunDiagnostics
      run={{
        ...run,
        deliveryStatus: 'not-delivered',
        deliverySuppressionReason: 'silent-reply',
      }}
      issuesOnly
    />,
  );
  expect(view.container.textContent).toBe('');
});

test('keeps independent execution failures visible alongside folded notification errors', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(
    <RunDiagnostics
      run={{
        ...run,
        status: 'error',
        error: 'Model unavailable',
        errorReason: 'model_not_found',
        deliveryError: 'Notification failed',
        diagnostics: {
          summary: 'Notification failed',
          entries: [
            { ts: 1, source: 'model-preflight', severity: 'error', message: 'Model unavailable' },
            { ts: 2, source: 'delivery', severity: 'error', message: 'Notification failed' },
          ],
        },
      }}
      issuesOnly
    />,
  );

  expect(screen.getAllByText('Model unavailable').some(node => !node.closest('details'))).toBe(
    true,
  );
  expect(screen.getByText('原因: 配置的模型不可用。').closest('details')).toBeNull();
  expect(screen.queryByText(/Notification failed/)).toBeNull();
});

test('preserves the only native explanation for a failure without diagnostic entries', () => {
  render(
    <RunDiagnostics
      run={{
        ...run,
        status: 'error',
        diagnostics: { summary: 'The configured model is unavailable', entries: [] },
      }}
      issuesOnly
      compact
    />,
  );

  expect(screen.getByText('The configured model is unavailable').closest('details')).toBeNull();
});

test('identifies native automatic pauses and does not keep that notice after re-enabling', () => {
  i18nService.setLanguage('zh', { persist: false });
  const state: TaskState = {
    nextRunAtMs: null,
    lastRunAtMs: 1,
    lastStatus: 'error',
    lastError: null,
    lastDurationMs: 100,
    runningAtMs: null,
    consecutiveErrors: 3,
    autoDisabled: { reason: 'schedule-errors', atMs: 2, consecutiveErrors: 3 },
  };
  const view = render(<TaskStateNotice state={state} enabled={false} />);
  expect(screen.getByText('调度规则连续出错，调度器已自动暂停此任务。')).toBeTruthy();

  view.rerender(<TaskStateNotice state={state} enabled />);
  expect(view.container.textContent).toBe('');
});
