// @vitest-environment jsdom

import type { WorkboardCard } from '@shared/openclaw/workboard';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import WorkboardCardDetailsDrawer, {
  clampWorkboardDetailsDrawerWidth,
} from './WorkboardCardDetailsDrawer';

const handlers = {
  onClose: vi.fn(),
  onEdit: vi.fn(),
  onOpenSession: vi.fn(),
  onStart: vi.fn().mockResolvedValue(undefined),
  onStop: vi.fn().mockResolvedValue(undefined),
  onMove: vi.fn().mockResolvedValue(undefined),
  onArchive: vi.fn().mockResolvedValue(undefined),
  onComment: vi.fn().mockResolvedValue(undefined),
  onDelete: vi.fn().mockResolvedValue(undefined),
};

const card = (patch: Partial<WorkboardCard> = {}): WorkboardCard => ({
  id: 'card-1',
  title: 'Review result',
  status: 'review',
  priority: 'high',
  labels: ['test'],
  agentId: 'main',
  position: 1,
  createdAt: 1,
  updatedAt: 2,
  ...patch,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WorkboardCardDetailsDrawer', () => {
  it('keeps the resizable drawer inside the available area', () => {
    expect(clampWorkboardDetailsDrawerWidth(200, 1200)).toBe(360);
    expect(clampWorkboardDetailsDrawerWidth(700, 1200)).toBe(700);
    expect(clampWorkboardDetailsDrawerWidth(1400, 1200)).toBe(1176);
    expect(clampWorkboardDetailsDrawerWidth(700, 320)).toBe(296);
  });

  it('offers the linked session but not a duplicate start for a review card', () => {
    i18nService.setLanguage('zh', { persist: false });
    render(
      <WorkboardCardDetailsDrawer
        card={card({ sessionKey: 'agent:main:subagent:workboard-default-card-1' })}
        busy={false}
        {...handlers}
      />,
    );

    expect(screen.getByRole('button', { name: '查看会话' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: '拖动调整卡片详情侧边栏宽度' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '启动' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止执行' })).toBeNull();
    expect(screen.getByText('agent:main:subagent:workboard-default-card-1')).toBeTruthy();
  });

  it('offers start for an unlinked ready card', () => {
    i18nService.setLanguage('zh', { persist: false });
    render(
      <WorkboardCardDetailsDrawer
        card={card({ status: 'ready' })}
        busy={false}
        {...handlers}
        onOpenSession={undefined}
      />,
    );

    expect(screen.getByRole('button', { name: '启动' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '查看会话' })).toBeNull();
  });

  it('offers stop only while the linked execution is running', () => {
    i18nService.setLanguage('zh', { persist: false });
    render(
      <WorkboardCardDetailsDrawer
        card={card({
          status: 'running',
          sessionKey: 'agent:main:subagent:workboard-default-card-1',
        })}
        busy={false}
        {...handlers}
      />,
    );

    expect(screen.getByRole('button', { name: '停止执行' })).toBeTruthy();
  });

  it('explains a completed card in plain language and folds technical details', () => {
    i18nService.setLanguage('zh', { persist: false });
    const { container } = render(
      <WorkboardCardDetailsDrawer
        card={card({
          status: 'done',
          sessionKey: 'agent:main:subagent:workboard-default-card-1',
          runId: 'workboard:card-1:run-1',
          completedAt: 3,
          metadata: {
            attempts: [
              {
                id: 'attempt-1',
                status: 'succeeded',
                startedAt: 2,
                endedAt: 3,
                engine: 'openclaw',
                model: 'zcode/glm-4.6',
              },
            ],
            diagnostics: [
              {
                kind: 'missing_proof',
                severity: 'warning',
                title: 'Done card has no proof',
                detail: 'The card is marked done without proof or an attached artifact.',
                firstSeenAt: 3,
                lastSeenAt: 3,
                count: 1,
                actions: [],
              },
            ],
            workerLogs: [
              {
                id: 'log-1',
                createdAt: 3,
                level: 'info',
                message: 'Dispatcher started subagent run',
              },
            ],
          },
          events: [
            {
              id: 'event-1',
              kind: 'moved',
              at: 3,
              fromStatus: 'review',
              toStatus: 'done',
            },
          ],
        })}
        busy={false}
        {...handlers}
      />,
    );

    expect(screen.getByText('已关联，可从下方查看')).toBeTruthy();
    expect(screen.getByText('成功 · 内置执行器 · zcode/glm-4.6')).toBeTruthy();
    expect(screen.getByText('缺少验收依据')).toBeTruthy();
    expect(screen.getByText(/这是验收提醒，不代表执行失败。$/)).toBeTruthy();
    expect(screen.getByText('状态变更：待验收 → 已完成')).toBeTruthy();
    expect(screen.queryByText('Done card has no proof')).toBeNull();
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();

    const technicalDetails = screen.getByText('技术详情').closest('details');
    expect(technicalDetails?.hasAttribute('open')).toBe(false);
    expect(technicalDetails?.textContent).toContain('workboard:card-1:run-1');
    expect(container.querySelector('details')).toBeTruthy();
  });
});

it('offers explicit completion and requeue actions for review without an arbitrary status selector', () => {
  i18nService.setLanguage('zh', { persist: false });
  render(<WorkboardCardDetailsDrawer card={card()} busy={false} {...handlers} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('workboardConfirmDone') }));
  expect(handlers.onMove).toHaveBeenCalledWith('done');
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('workboardRequeue') }));
  expect(handlers.onMove).toHaveBeenCalledWith('todo');
});

it('does not let a running execution be completed or requeued through details', () => {
  render(
    <WorkboardCardDetailsDrawer card={card({ status: 'running' })} busy={false} {...handlers} />,
  );
  expect(screen.queryByRole('button', { name: i18nService.t('workboardConfirmDone') })).toBeNull();
  expect(screen.queryByRole('button', { name: i18nService.t('workboardRequeue') })).toBeNull();
});

it.each(['review', 'blocked', 'done'] as const)(
  'describes live execution even when the card status is %s',
  status => {
    render(
      <WorkboardCardDetailsDrawer
        card={card({
          status,
          execution: {
            id: 'execution-1',
            kind: 'agent-session',
            mode: 'manual',
            status: 'running',
            sessionKey: 'session-1',
            startedAt: 1,
            updatedAt: 2,
          },
        })}
        busy={false}
        {...handlers}
      />,
    );
    expect(screen.getByText(i18nService.t('workboardSummaryRunning'))).toBeTruthy();
    expect(screen.getByRole('button', { name: i18nService.t('workboardStop') })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: i18nService.t('workboardConfirmDone') }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: i18nService.t('workboardRequeue') })).toBeNull();
  },
);

it('shows the scheduled time without instructing users to use an unavailable requeue action', () => {
  const scheduledAt = Date.UTC(2030, 0, 1, 12);
  render(
    <WorkboardCardDetailsDrawer
      card={card({
        status: 'scheduled',
        sessionKey: 'previous-session',
        metadata: { automation: { scheduledAt } },
      })}
      busy={false}
      {...handlers}
    />,
  );
  expect(
    screen.getByText(
      i18nService
        .t('workboardScheduledHint')
        .replace('{time}', new Date(scheduledAt).toLocaleString()),
    ),
  ).toBeTruthy();
  expect(screen.queryByText(i18nService.t('workboardStartStatusHint'))).toBeNull();
  expect(screen.queryByText(i18nService.t('workboardExistingExecutionHint'))).toBeNull();
  expect(screen.queryByRole('button', { name: i18nService.t('workboardRequeue') })).toBeNull();
});
