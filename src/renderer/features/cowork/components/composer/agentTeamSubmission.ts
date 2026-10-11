import type { AgentTeamMode } from '@shared/cowork/agent-team/agentTeamPrompt';
import { SessionGoalStatus } from '@shared/cowork/sessionGoal';

export {
  AGENT_TEAM_MODE,
  agentTeamInstruction,
  type AgentTeamMode,
} from '@shared/cowork/agent-team/agentTeamPrompt';

export async function submitAgentTeamMessage(options: {
  mode?: AgentTeamMode;
  queued?: boolean;
  enabled: () => Promise<boolean>;
  isCurrent: () => boolean;
  submit: () => Promise<boolean | void>;
  accepted: () => void;
  report: (key: 'teamFeatureDisabled' | 'teamFeatureUnavailable' | 'teamFeatureBusy') => void;
}): Promise<boolean | void> {
  if (options.mode) {
    if (options.queued) {
      options.report('teamFeatureBusy');
      return false;
    }
    try {
      if (!(await options.enabled())) {
        options.report('teamFeatureDisabled');
        return false;
      }
    } catch {
      options.report('teamFeatureUnavailable');
      return false;
    }
    if (!options.isCurrent()) return false;
  }
  const result = await options.submit();
  if (result !== false && options.mode) options.accepted();
  return result;
}

export function teamSubmissionConflict(input: {
  prompt: string;
  plan: boolean;
  goalStatus?: SessionGoalStatus;
  completionFeedback: boolean;
}): boolean {
  return (
    input.plan ||
    input.prompt.trimStart().startsWith('/') ||
    input.completionFeedback ||
    (!!input.goalStatus && input.goalStatus !== SessionGoalStatus.Complete)
  );
}
