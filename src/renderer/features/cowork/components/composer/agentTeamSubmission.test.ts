import { SessionGoalStatus } from '@shared/cowork/sessionGoal';
import { expect, it, vi } from 'vitest';

import {
  agentTeamInstruction,
  submitAgentTeamMessage,
  teamSubmissionConflict,
} from './agentTeamSubmission';

it('preserves a selected mode on unavailable extension, failed send, and stale navigation', async () => {
  const options = {
    mode: 'group' as const,
    enabled: vi.fn().mockResolvedValue(false),
    isCurrent: vi.fn().mockReturnValue(true),
    submit: vi.fn().mockResolvedValue(false),
    accepted: vi.fn(),
    report: vi.fn(),
  };
  expect(await submitAgentTeamMessage(options)).toBe(false);
  expect(options.submit).not.toHaveBeenCalled();
  expect(options.report).toHaveBeenCalledWith('teamFeatureDisabled');
  options.enabled.mockRejectedValueOnce(new Error('offline'));
  expect(await submitAgentTeamMessage(options)).toBe(false);
  expect(options.report).toHaveBeenCalledWith('teamFeatureUnavailable');
  options.enabled.mockResolvedValue(true);
  options.isCurrent.mockReturnValue(false);
  expect(await submitAgentTeamMessage(options)).toBe(false);
  expect(options.submit).not.toHaveBeenCalled();
  options.isCurrent.mockReturnValue(true);
  expect(await submitAgentTeamMessage(options)).toBe(false);
  expect(options.accepted).not.toHaveBeenCalled();
  options.submit.mockResolvedValue(true);
  expect(await submitAgentTeamMessage(options)).toBe(true);
  expect(options.accepted).toHaveBeenCalledOnce();
});

it('leaves ordinary chat independent of the optional extension', async () => {
  const options = {
    enabled: vi.fn(),
    isCurrent: () => true,
    submit: vi.fn().mockResolvedValue(true),
    accepted: vi.fn(),
    report: vi.fn(),
  };
  expect(await submitAgentTeamMessage(options)).toBe(true);
  expect(options.enabled).not.toHaveBeenCalled();
  expect(options.accepted).not.toHaveBeenCalled();
});

it('preserves an explicit mode and draft rather than queueing an unbound launch intent', async () => {
  const options = {
    mode: 'task' as const,
    queued: true,
    enabled: vi.fn(),
    isCurrent: () => true,
    submit: vi.fn(),
    accepted: vi.fn(),
    report: vi.fn(),
  };
  expect(await submitAgentTeamMessage(options)).toBe(false);
  expect(options.enabled).not.toHaveBeenCalled();
  expect(options.submit).not.toHaveBeenCalled();
  expect(options.accepted).not.toHaveBeenCalled();
  expect(options.report).toHaveBeenCalledWith('teamFeatureBusy');
  expect(
    await submitAgentTeamMessage({ ...options, mode: undefined, submit: async () => true }),
  ).toBe(true);
});

it('explicitly selects the native group or persistent collaboration tool path', () => {
  expect(agentTeamInstruction('group')).toContain('team_discussion action=create');
  expect(agentTeamInstruction('group')).toContain('do not execute proposed changes');
  expect(agentTeamInstruction('task')).toContain('sessions_send');
  expect(agentTeamInstruction('task')).toContain('Do not replace task collaboration');
});

it('blocks special workflows before their side effects and permits normal sends', () => {
  const normal = { prompt: 'Review architecture', plan: false, completionFeedback: false };
  expect(teamSubmissionConflict(normal)).toBe(false);
  expect(teamSubmissionConflict({ ...normal, prompt: ' /plan hello' })).toBe(true);
  expect(teamSubmissionConflict({ ...normal, plan: true })).toBe(true);
  expect(teamSubmissionConflict({ ...normal, completionFeedback: true })).toBe(true);
  for (const goalStatus of Object.values(SessionGoalStatus)) {
    expect(teamSubmissionConflict({ ...normal, goalStatus })).toBe(
      goalStatus !== SessionGoalStatus.Complete,
    );
  }
});
