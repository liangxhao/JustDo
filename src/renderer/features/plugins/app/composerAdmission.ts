import { SessionGoalStatus } from '@shared/cowork/sessionGoal';

/** Native special routes cannot carry an ordinary-turn plugin launch intent. */
export function blocksAppComposerSubmission(
  mode: { allowQueue?: boolean; ordinaryTurnOnly?: boolean } | undefined,
  input: {
    running: boolean;
    plan: boolean;
    prompt: string;
    goalStatus?: SessionGoalStatus;
    completionFeedback: boolean;
  },
): boolean {
  return (
    !!mode &&
    ((!mode.allowQueue && input.running) ||
      (!!mode.ordinaryTurnOnly &&
        (input.plan ||
          input.prompt.trimStart().startsWith('/') ||
          input.completionFeedback ||
          (!!input.goalStatus && input.goalStatus !== SessionGoalStatus.Complete))))
  );
}
