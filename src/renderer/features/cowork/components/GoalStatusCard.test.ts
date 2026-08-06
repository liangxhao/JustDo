import { GoalExecutionPhase, SessionGoalStatus } from '@shared/sessionGoal';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import GoalStatusCard from './GoalStatusCard';

const activeGoal = {
  schemaVersion: 1 as const,
  id: 'goal-1',
  objective: 'Build a release dashboard',
  status: SessionGoalStatus.Active,
  createdAt: 1,
  updatedAt: 1,
  tokenStart: 0,
  tokensUsed: 42_000,
  tokenBudget: 50_000,
  continuationTurns: 0,
};

describe('GoalStatusCard', () => {
  it('renders an optimistic goal with live execution activity', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: null,
        pendingObjective: 'Build a release dashboard',
        isRunning: true,
        onCommand: vi.fn(),
      }),
    );

    expect(rendered).toContain('Build a release dashboard');
    expect(rendered).toContain(i18nService.t('coworkGoalPhaseRunning'));
    expect(rendered).not.toContain('<button');
  });

  it('renders an idle active goal as waiting for manual continuation without token progress', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: activeGoal,
        execution: null,
        onCommand: vi.fn(),
        onContinue: vi.fn(),
        onComplete: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t('coworkGoalActiveHint'));
    expect(rendered).toContain(i18nService.t('coworkGoalContinue'));
    expect(rendered).toContain(i18nService.t('coworkGoalMarkComplete'));
    expect(rendered).not.toContain(`>${i18nService.t('coworkGoalPause')}<`);
    expect(rendered).not.toContain('42k');
    expect(rendered).not.toContain('50k');
  });

  it('renders a pausable automatic continuation with its current count', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: activeGoal,
        execution: {
          sessionId: 'session-1',
          goalId: 'goal-1',
          phase: GoalExecutionPhase.Running,
          runId: 'run-1',
          continuationCount: 3,
          updatedAt: Date.now(),
        },
        onCommand: vi.fn(),
        onPause: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t('coworkGoalPause'));
    expect(rendered).not.toContain(i18nService.t('coworkGoalMarkComplete'));
    expect(rendered).toContain('3');
    expect(rendered).toContain(i18nService.t('coworkGoalPhaseRunning'));
  });

  it('ignores an execution snapshot that belongs to a replaced goal', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: { ...activeGoal, id: 'goal-2' },
        execution: {
          sessionId: 'session-1',
          goalId: 'goal-1',
          phase: GoalExecutionPhase.Running,
          runId: 'old-run',
          continuationCount: 3,
          updatedAt: Date.now(),
        },
        onCommand: vi.fn(),
        onContinue: vi.fn(),
        onComplete: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t('coworkGoalActiveHint'));
    expect(rendered).toContain(i18nService.t('coworkGoalContinue'));
    expect(rendered).not.toContain(i18nService.t('coworkGoalPhaseRunning'));
    expect(rendered).not.toContain(`>${i18nService.t('coworkGoalPause')}<`);
  });

  it.each([
    [GoalExecutionPhase.Stopped, 'coworkGoalStoppedHint', 'coworkGoalContinue'],
    [GoalExecutionPhase.Failed, 'coworkGoalFailedHint', 'coworkGoalRetry'],
  ] as const)('renders an active %s execution with its recovery action', (phase, hintKey, actionKey) => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: activeGoal,
        execution: {
          sessionId: 'session-1',
          goalId: 'goal-1',
          phase,
          continuationCount: 1,
          updatedAt: Date.now(),
        },
        onCommand: vi.fn(),
        onContinue: vi.fn(),
        onComplete: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t(hintKey));
    expect(rendered).toContain(i18nService.t(actionKey));
    expect(rendered).toContain(i18nService.t('coworkGoalMarkComplete'));
  });

  it.each([
    [SessionGoalStatus.Paused, 'coworkGoalPaused'],
    [SessionGoalStatus.Blocked, 'coworkGoalBlocked'],
    [SessionGoalStatus.UsageLimited, 'coworkGoalUsageLimited'],
    [SessionGoalStatus.BudgetLimited, 'coworkGoalBudgetLimited'],
    [SessionGoalStatus.Complete, 'coworkGoalComplete'],
  ] as const)('keeps OpenClaw %s lifecycle state authoritative', (status, labelKey) => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: { ...activeGoal, status },
        execution: {
          sessionId: 'session-1',
          phase: GoalExecutionPhase.Waiting,
          continuationCount: 0,
          updatedAt: Date.now(),
        },
        onCommand: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t(labelKey));
    expect(rendered).not.toContain(`>${i18nService.t('coworkGoalContinue')}<`);
  });
});
