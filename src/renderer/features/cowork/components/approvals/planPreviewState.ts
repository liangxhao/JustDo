import type { CoworkInteractionRequest } from '@/features/cowork/coworkTypes';

export interface PlanPreviewState {
  retainedBySessionId: Record<string, CoworkInteractionRequest>;
  openSessionId: string | null;
}

export type PlanPreviewAction =
  | { type: 'pending-shown'; sessionId: string }
  | { type: 'implementation-started'; interaction: CoworkInteractionRequest }
  | { type: 'resolved-without-implementation'; sessionId: string }
  | { type: 'preview-opened'; interaction: CoworkInteractionRequest }
  | { type: 'closed' };

export const initialPlanPreviewState: PlanPreviewState = {
  retainedBySessionId: {},
  openSessionId: null,
};

function withoutSession(
  retainedBySessionId: Record<string, CoworkInteractionRequest>,
  sessionId: string,
  requestId?: string,
): Record<string, CoworkInteractionRequest> {
  const retained = retainedBySessionId[sessionId];
  if (!retained || (requestId && retained.requestId !== requestId)) return retainedBySessionId;
  const next = { ...retainedBySessionId };
  delete next[sessionId];
  return next;
}

export function planPreviewReducer(
  state: PlanPreviewState,
  action: PlanPreviewAction,
): PlanPreviewState {
  switch (action.type) {
    case 'pending-shown':
      return {
        retainedBySessionId: withoutSession(state.retainedBySessionId, action.sessionId),
        openSessionId: action.sessionId,
      };
    case 'implementation-started':
    case 'preview-opened':
      return {
        retainedBySessionId: {
          ...state.retainedBySessionId,
          [action.interaction.sessionId]: action.interaction,
        },
        openSessionId: action.interaction.sessionId,
      };
    case 'resolved-without-implementation':
      return {
        retainedBySessionId: withoutSession(state.retainedBySessionId, action.sessionId),
        openSessionId: state.openSessionId === action.sessionId ? null : state.openSessionId,
      };
    case 'closed':
      return { ...state, openSessionId: null };
  }
}

export function retainedPlanForSession(
  state: PlanPreviewState,
  sessionId: string | null,
): CoworkInteractionRequest | null {
  if (!sessionId || state.openSessionId !== sessionId) return null;
  return state.retainedBySessionId[sessionId] ?? null;
}
