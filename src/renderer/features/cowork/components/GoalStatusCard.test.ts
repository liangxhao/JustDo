import { buildGoalFollowUpPrompt } from '@shared/prompts/goalFollowUpPrompt';
import { GoalExecutionPhase, SessionGoalStatus } from '@shared/sessionGoal';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import GoalStatusCard, { formatGoalElapsed } from './GoalStatusCard';

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

const findButtonByLabel = (
  node: React.ReactNode,
  label: string,
): React.ReactElement<{ children?: React.ReactNode; onClick?: () => void }> | null => {
  if (!React.isValidElement(node)) return null;
  const element = node as React.ReactElement<{
    children?: React.ReactNode;
    label?: string;
    onClick?: () => void;
  }>;
  if (
    (element.type === 'button' && element.props.children === label) ||
    element.props.label === label
  ) {
    return element;
  }
  let match: ReturnType<typeof findButtonByLabel> = null;
  React.Children.forEach(element.props.children, child => {
    if (!match) match = findButtonByLabel(child, label);
  });
  return match;
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

  it('shows only the literal follow-up request for a templated Goal objective', () => {
    const command = buildGoalFollowUpPrompt('Write five poems.', 'Write one more poem.');
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: {
          ...activeGoal,
          objective: command.slice('/goal start '.length),
        },
        onCommand: vi.fn(),
        onPause: vi.fn(),
      }),
    );

    expect(rendered).toContain('Write one more poem.');
    expect(rendered).not.toContain('Write five poems.');
    expect(rendered).not.toContain('sole task for this goal');
  });

  it('never presents an active goal as waiting for confirmation', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: activeGoal,
        execution: null,
        onCommand: vi.fn(),
        onEdit: vi.fn(),
        onPause: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t('coworkGoalActiveHint'));
    expect(rendered).toContain(`>${i18nService.t('coworkGoalPause')}<`);
    expect(rendered).not.toContain(`>${i18nService.t('coworkGoalContinue')}<`);
    expect(rendered).not.toContain(i18nService.t('coworkGoalMarkComplete'));
    expect(rendered).not.toContain('42k');
    expect(rendered).not.toContain('50k');
    expect(rendered).toContain(i18nService.t('coworkGoalEdit'));
  });

  it('hides editing while the goal is running or complete', () => {
    const running = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: activeGoal,
        isRunning: true,
        onCommand: vi.fn(),
        onEdit: vi.fn(),
        onPause: vi.fn(),
      }),
    );
    const complete = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: { ...activeGoal, status: SessionGoalStatus.Complete },
        onCommand: vi.fn(),
        onEdit: vi.fn(),
      }),
    );

    expect(running).not.toContain(`aria-label="${i18nService.t('coworkGoalEdit')}"`);
    expect(complete).not.toContain(`aria-label="${i18nService.t('coworkGoalEdit')}"`);
  });

  it('formats elapsed goal age without exposing token progress', () => {
    const previousLanguage = i18nService.getLanguage();
    try {
      i18nService.setLanguage('en', { persist: false });
      const start = 1_000_000;
      expect(formatGoalElapsed(start, start + 30_000)).toBe('Running for less than 1 min');
      expect(formatGoalElapsed(start, start + 17 * 60_000)).toBe('Running for 17 min');
      expect(formatGoalElapsed(start, start + 125 * 60_000)).toBe('Running for 2 hr 5 min');
      expect(formatGoalElapsed(start, start + 50 * 60 * 60_000)).toBe('Running for 2 d 2 hr');

      i18nService.setLanguage('zh', { persist: false });
      expect(formatGoalElapsed(start, start + 125 * 60_000)).toBe('已运行 2 小时 5 分钟');
    } finally {
      i18nService.setLanguage(previousLanguage, { persist: false });
    }
  });

  it('keeps an active goal live while its execution snapshot is not matched yet', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: activeGoal,
        execution: {
          sessionId: 'session-1',
          phase: GoalExecutionPhase.Running,
          runId: 'initial-run',
          continuationCount: 0,
          updatedAt: Date.now(),
        },
        isRunning: true,
        onCommand: vi.fn(),
        onPause: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t('coworkGoalPhaseRunning'));
    expect(rendered).toContain(`>${i18nService.t('coworkGoalPause')}<`);
    expect(rendered).not.toContain(`>${i18nService.t('coworkGoalContinue')}<`);
    expect(rendered).not.toContain(`>${i18nService.t('coworkGoalMarkComplete')}<`);
    expect(rendered).not.toContain(i18nService.t('coworkGoalActiveHint'));
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
        onPause: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t('coworkGoalActiveHint'));
    expect(rendered).toContain(i18nService.t('coworkGoalPause'));
    expect(rendered).not.toContain(i18nService.t('coworkGoalPhaseRunning'));
  });

  it('renders continue after an active goal is explicitly stopped', () => {
    const onContinue = vi.fn();
    const tree = GoalStatusCard({
      goal: activeGoal,
      execution: {
        sessionId: 'session-1',
        goalId: 'goal-1',
        phase: GoalExecutionPhase.Stopped,
        continuationCount: 1,
        updatedAt: Date.now(),
      },
      isRunning: true,
      onCommand: vi.fn(),
      onEdit: vi.fn(),
      onPause: vi.fn(),
      onContinue,
    });
    const continueButton = findButtonByLabel(tree, i18nService.t('coworkGoalContinue'));
    const rendered = renderToStaticMarkup(tree);

    expect(rendered).toContain(i18nService.t('coworkGoalStoppedHint'));
    expect(rendered).not.toContain(`>${i18nService.t('coworkGoalPause')}<`);
    expect(rendered).toContain(`aria-label="${i18nService.t('coworkGoalEdit')}"`);
    expect(continueButton).not.toBeNull();
    continueButton?.props.onClick?.();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('renders an active retrying execution without a confirmation action', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: activeGoal,
        execution: {
          sessionId: 'session-1',
          goalId: 'goal-1',
          phase: GoalExecutionPhase.Retrying,
          continuationCount: 1,
          updatedAt: Date.now(),
        },
        onCommand: vi.fn(),
        onPause: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t('coworkGoalRetryingHint'));
    expect(rendered).toContain(i18nService.t('coworkGoalPause'));
    expect(rendered).not.toContain(i18nService.t('coworkGoalMarkComplete'));
  });

  it.each([
    [SessionGoalStatus.Paused, 'coworkGoalPaused'],
    [SessionGoalStatus.Blocked, 'coworkGoalBlocked'],
  ] as const)(
    'renders resume and end actions for OpenClaw %s lifecycle state',
    (status, labelKey) => {
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
      expect(rendered).toContain(i18nService.t('coworkGoalResume'));
      expect(rendered).toContain(i18nService.t('coworkGoalEnd'));
      expect(rendered).not.toContain(`>${i18nService.t('coworkGoalContinue')}<`);
    },
  );

  it('renders continue improving and confirm complete for a completed goal', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: { ...activeGoal, status: SessionGoalStatus.Complete },
        onCommand: vi.fn(),
        onContinueImproving: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t('coworkGoalComplete'));
    expect(rendered).toContain(i18nService.t('coworkGoalContinueImproving'));
    expect(rendered).toContain(i18nService.t('coworkGoalMarkComplete'));
    expect(rendered).not.toContain(i18nService.t('coworkGoalClear'));
    expect(rendered).not.toContain(i18nService.t('coworkGoalEnd'));
    expect(rendered).not.toContain(i18nService.t('coworkGoalResume'));
  });

  it('uses an awaiting-confirmation execution before complete metadata arrives', () => {
    const rendered = renderToStaticMarkup(
      React.createElement(GoalStatusCard, {
        goal: activeGoal,
        execution: {
          sessionId: 'session-1',
          phase: GoalExecutionPhase.AwaitingConfirmation,
          continuationCount: 2,
          updatedAt: Date.now(),
        },
        onCommand: vi.fn(),
        onPause: vi.fn(),
      }),
    );

    expect(rendered).toContain(i18nService.t('coworkGoalComplete'));
    expect(rendered).toContain(i18nService.t('coworkGoalMarkComplete'));
    expect(rendered).not.toContain(i18nService.t('coworkGoalPause'));
    expect(rendered).not.toContain(`>${i18nService.t('coworkGoalContinue')}<`);
  });

  it('clears the goal when completion is confirmed', () => {
    const onCommand = vi.fn();
    const tree = GoalStatusCard({
      goal: { ...activeGoal, status: SessionGoalStatus.Complete },
      onCommand,
    });
    const confirmButton = findButtonByLabel(tree, i18nService.t('coworkGoalMarkComplete'));

    expect(confirmButton).not.toBeNull();
    confirmButton?.props.onClick?.();
    expect(onCommand).toHaveBeenCalledWith('/goal clear');
  });

  it('enters and cancels completion feedback without changing the goal', () => {
    const onContinueImproving = vi.fn();
    const onCancelContinueImproving = vi.fn();
    const initialTree = GoalStatusCard({
      goal: { ...activeGoal, status: SessionGoalStatus.Complete },
      onCommand: vi.fn(),
      onContinueImproving,
    });
    findButtonByLabel(initialTree, i18nService.t('coworkGoalContinueImproving'))?.props.onClick?.();

    const feedbackTree = GoalStatusCard({
      goal: { ...activeGoal, status: SessionGoalStatus.Complete },
      completionFeedbackActive: true,
      onCommand: vi.fn(),
      onCancelContinueImproving,
    });
    const feedbackMarkup = renderToStaticMarkup(feedbackTree);
    findButtonByLabel(feedbackTree, i18nService.t('coworkGoalCancelImproving'))?.props.onClick?.();

    expect(onContinueImproving).toHaveBeenCalledOnce();
    expect(feedbackMarkup).toContain(i18nService.t('coworkGoalCompletionFeedbackHint'));
    expect(feedbackMarkup).not.toContain(i18nService.t('coworkGoalMarkComplete'));
    expect(onCancelContinueImproving).toHaveBeenCalledOnce();
  });

  it('delegates the end action instead of clearing the goal directly', () => {
    const onCommand = vi.fn();
    const onEnd = vi.fn();
    const tree = GoalStatusCard({
      goal: { ...activeGoal, status: SessionGoalStatus.Paused },
      onCommand,
      onEnd,
    });
    const endButton = findButtonByLabel(tree, i18nService.t('coworkGoalEnd'));

    expect(endButton).not.toBeNull();
    endButton?.props.onClick?.();
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onCommand).not.toHaveBeenCalled();
  });
});
