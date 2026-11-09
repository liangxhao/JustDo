import { BrowserTabPresentation } from '@shared/browser/browser';

export interface BrowserPagePresentationState {
  visible: boolean;
  activeTargetId: string | null;
  agentControlling: boolean;
}

/** Read current presentation state; resource ownership never implies selection. */
export const canPresentBrowserPage = (
  targetId: string | null | undefined,
  state: BrowserPagePresentationState,
): boolean => Boolean(
  targetId && state.visible && state.activeTargetId === targetId && !state.agentControlling,
);

export const shouldPresentBrowserPopup = (
  openerTargetId: string | undefined,
  presentation: BrowserTabPresentation | undefined,
  state: BrowserPagePresentationState,
): boolean => {
  if (presentation === BrowserTabPresentation.Background) return false;
  return openerTargetId === undefined ? state.visible : canPresentBrowserPage(openerTargetId, state);
};
