// @vitest-environment jsdom

import { configureStore } from '@reduxjs/toolkit';
import type { ScheduledTask } from '@shared/scheduledTask/types';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import { TaskDetailsDialog } from './CronView';

vi.mock('@/features/scheduled-tasks/scheduledTaskService', () => ({
  scheduledTaskService: {},
}));

const originalLanguage = i18nService.getLanguage();
const job: ScheduledTask = {
  id: 'report',
  name: 'Daily report',
  description: '',
  enabled: true,
  schedule: { kind: 'every', everyMs: 900_000, anchorMs: 1_793_799_305_211 },
  sessionTarget: 'current',
  wakeMode: 'now',
  payload: { kind: 'agentTurn', message: 'Prepare a report', toolsAllow: ['*'] },
  delivery: { mode: 'announce' },
  agentId: 'main',
  sessionKey: 'agent:main:source-conversation',
  management: 'advanced',
  advancedFeatures: ['owner', 'account-tool-policy', 'pacing'],
  state: {
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastStatus: null,
    lastError: null,
    lastDurationMs: null,
    runningAtMs: null,
    consecutiveErrors: 0,
  },
  createdAt: '',
  updatedAt: '',
};

function showDetails(overrides: Partial<ScheduledTask> = {}) {
  const store = configureStore({ reducer: { agent: () => ({ agents: [] }) } });
  render(
    <Provider store={store}>
      <TaskDetailsDialog job={{ ...job, ...overrides }} onClose={() => {}} />
    </Provider>,
  );
}

function deliveryText() {
  return screen.getByText(i18nService.t('cronDialogDeliveryTitle')).nextElementSibling?.textContent;
}

beforeEach(() => i18nService.setLanguage('zh', { persist: false }));
afterEach(() => {
  cleanup();
  i18nService.setLanguage(originalLanguage, { persist: false });
});

test('explains conversation replies, permissions, and how to change advanced settings', () => {
  showDetails();

  expect(deliveryText()).toBe(i18nService.t('cronDetailsDeliveryCurrent'));
  expect(screen.getByText(i18nService.t('cronDetailsSessionCurrent'))).toBeTruthy();
  expect(screen.getByText(i18nService.t('cronDetailsAdvancedHint'))).toBeTruthy();
  expect(screen.getByText(/所有工具（仍遵循权限设置）/)).toBeTruthy();
  expect(screen.getByText(/任务归属信息 · 遵循账户的工具权限设置 · 自动调整执行间隔/)).toBeTruthy();
  expect(screen.queryByText(i18nService.t('cronDialogDeliveryModeAnnounce'))).toBeNull();
});

test('does not promise a conversation reply when automatic delivery is disabled', () => {
  showDetails({ delivery: { mode: 'none' } });

  expect(deliveryText()).toBe(i18nService.t('cronDialogDeliveryModeNone'));
  expect(screen.queryByText(i18nService.t('cronDetailsDeliveryCurrent'))).toBeNull();
});

test('preserves notification destinations without inferring a conversation reply from a loop name', () => {
  showDetails({
    name: 'loop[000000000000] Daily report',
    sessionTarget: 'isolated',
    delivery: {
      mode: 'announce',
      channel: 'feishu',
      to: 'report-group',
      accountId: 'assistant-bot',
      bestEffort: true,
    },
  });

  expect(deliveryText()).toBe(
    `${i18nService.t('cronDetailsDeliveryAnnounce')} · feishu · report-group · assistant-bot · ${i18nService.t('cronDetailsBestEffort')}`,
  );
  expect(screen.queryByText(i18nService.t('cronDetailsDeliveryCurrent'))).toBeNull();
});

test('shows webhook delivery separately from the linked conversation', () => {
  showDetails({ delivery: { mode: 'webhook', to: 'https://hooks.example.internal/results' } });

  expect(deliveryText()).toBe(
    `${i18nService.t('scheduledTasksFormDeliveryModeWebhook')} · https://hooks.example.internal/results`,
  );
  expect(screen.queryByText(i18nService.t('cronDetailsDeliveryCurrent'))).toBeNull();
});

test('keeps implicit notification routing unresolved for tasks outside conversation-bound assistant runs', () => {
  i18nService.setLanguage('en', { persist: false });
  showDetails({ payload: { kind: 'systemEvent', text: 'Check for updates' } });

  expect(deliveryText()).toBe(i18nService.t('cronDetailsDeliveryAnnounce'));
  expect(screen.queryByText(i18nService.t('cronDetailsDeliveryCurrent'))).toBeNull();
});
