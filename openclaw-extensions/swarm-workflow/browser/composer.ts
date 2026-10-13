import { OpenClawExtensionId } from '../../runtime-services/contracts/native-ids';
import { SwarmWorkflowMode, type SwarmWorkflowOptions } from '../contracts/options';
import type { SwarmWorkflowApi } from '../contracts/api';

export type WorkflowComposerPreparation =
  { success: true; instruction: string } | { success: false; messageKey?: string };

/** Prepare one exact draft selection without sending or retrying a source turn. */
export async function prepareWorkflowComposerSubmission({
  options,
  sessionId,
  prompt,
  planModeEnabled,
  isSelectionCurrent,
  isDraftCurrent,
  prepare,
}: {
  options: SwarmWorkflowOptions;
  sessionId?: string;
  prompt: string;
  planModeEnabled: boolean;
  isSelectionCurrent: () => boolean;
  isDraftCurrent: () => boolean;
  prepare: SwarmWorkflowApi['prepareSwarmWorkflow'];
}): Promise<WorkflowComposerPreparation> {
  if (!isSelectionCurrent()) return { success: false };
  if (planModeEnabled || prompt.trimStart().startsWith('/')) {
    return {
      success: false,
      messageKey: planModeEnabled ? 'swarmWorkflowPlan' : 'swarmWorkflowInvalid',
    };
  }
  let instruction: string;
  try {
    const prepared = await prepare(options, sessionId);
    if (!prepared.success) {
      return {
        success: false,
        messageKey: {
          disabled: 'swarmWorkflowDisabled',
          plan: 'swarmWorkflowPlan',
          invalid: 'swarmWorkflowInvalid',
          unavailable: 'swarmWorkflowPrepareUnavailable',
        }[prepared.reason],
      };
    }
    instruction = prepared.instruction;
  } catch {
    return { success: false, messageKey: 'swarmWorkflowPrepareUnavailable' };
  }
  if (!isDraftCurrent() || !isSelectionCurrent()) return { success: false };
  return { success: true, instruction };
}

export function buildWorkflowComposerFeature({
  swarmWorkflow,
  selectSwarmWorkflow,
}: {
  swarmWorkflow?: SwarmWorkflowOptions;
  selectSwarmWorkflow: (options: SwarmWorkflowOptions) => void;
}) {
  return {
    id: OpenClawExtensionId.SWARM_WORKFLOW,
    extensionId: OpenClawExtensionId.SWARM_WORKFLOW,
    labelKey: 'swarmWorkflowTitle',
    selected: Boolean(swarmWorkflow),
    onSelect: () => selectSwarmWorkflow({ mode: SwarmWorkflowMode.Auto, verify: true }),
  };
}

/** Goal resume and completion feedback are not ordinary source chat turns. */
export function blocksWorkflowGoalSubmission({
  swarmWorkflowSelected,
  goalIsIncomplete,
  completionFeedback,
}: {
  swarmWorkflowSelected: boolean;
  goalIsIncomplete: boolean;
  completionFeedback: boolean;
}): boolean {
  return swarmWorkflowSelected && (completionFeedback || goalIsIncomplete);
}
