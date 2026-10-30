import type { CoworkInteractionRequest } from '../../coworkTypes';

type Presentation = {
  visible: boolean;
  label?: string;
  ownerDocument?: Document;
};
export interface QuestionQueueContext {
  currentSessionId: string | null;
  visible: boolean;
  sourceViewVisible: boolean;
  presentation(key: unknown): Presentation | undefined;
  isPluginCurrent(pluginId: string, epoch?: string): boolean;
}

/** Display filtering never grants permission to answer; Main rechecks the exact Native request. */
export function visibleQuestionQueue(
  interactions: readonly CoworkInteractionRequest[],
  context: QuestionQueueContext,
): CoworkInteractionRequest[] {
  if (!context.visible) return [];
  return interactions
    .filter(interaction => {
      const origin = interaction.origin;
      if (
        origin?.available === false ||
        (origin?.pluginId && !context.isPluginCurrent(origin.pluginId, origin.epoch))
      )
        return false;
      const presentation = context.presentation(interaction.toolInput.sessionKey);
      if (presentation) return presentation.visible;
      if (!interaction.sessionId && origin?.nativeSessionId) return true;
      return context.sourceViewVisible && interaction.sessionId === context.currentSessionId;
    })
    .sort((left, right) => (left.origin?.createdAt ?? 0) - (right.origin?.createdAt ?? 0));
}

export const questionSourceLabel = (
  interaction: CoworkInteractionRequest,
  presentation?: Presentation,
): string => {
  const origin = interaction.origin;
  return (
    [
      presentation?.label ?? origin?.label ?? origin?.agentId,
      origin?.sessionKey ?? interaction.toolInput.sessionKey,
      origin?.nativeSessionId,
    ].find((value): value is string => typeof value === 'string' && Boolean(value)) ?? ''
  );
};
