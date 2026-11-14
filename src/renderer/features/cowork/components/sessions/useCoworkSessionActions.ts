import { SessionCopyErrorCode } from '@shared/cowork/sessionCopy';
import { useEffect, useSyncExternalStore } from 'react';

import { coworkService } from '@/features/cowork/coworkService';
import type { CoworkSession } from '@/features/cowork/coworkTypes';
import {
  COWORK_SESSION_LIST_ACTION_EVENT,
  type CoworkSessionListActionDetail,
} from '@/features/cowork/sessionListActions';
import { appBrowserRegistry } from '@/features/plugins/app/runtime';
import { i18nService } from '@/services/i18n';

const copyFailureTranslation = (code: SessionCopyErrorCode | undefined): string => {
  switch (code) {
    case SessionCopyErrorCode.RuntimeActive: return 'coworkCopyWaitForCompletion';
    case SessionCopyErrorCode.RuntimeUnknown: return 'coworkCopyRuntimeUnknown';
    case SessionCopyErrorCode.SourceUnavailable: return 'coworkCopySourceUnavailable';
    case SessionCopyErrorCode.SourceRestricted: return 'coworkCopySourceRestricted';
    case SessionCopyErrorCode.GatewayUnavailable: return 'coworkCopyGatewayUnavailable';
    case SessionCopyErrorCode.CreationUnconfirmed: return 'coworkCopyCreationUnconfirmed';
    case SessionCopyErrorCode.PreparationFailed: return 'coworkCopyPreparationFailed';
    default: return 'coworkCopySessionFailed';
  }
};

/** Presentation can narrow a transcript action without changing native execution authority. */
export function getSessionTranscriptActionError(
  action: 'copy' | 'export',
  sessionId: string,
  runtimeRunning: boolean,
): string | undefined {
  const presentation = appBrowserRegistry.sessionPresentation(sessionId);
  if (runtimeRunning || presentation.status === 'running')
    return action === 'copy' ? 'coworkCopyWaitForCompletion' : 'coworkExportWaitForCompletion';
  if (action === 'copy' ? presentation.copyAllowed === false : presentation.exportAllowed === false)
    return action === 'copy' ? 'coworkCopySessionFailed' : 'coworkExportFailed';
  return undefined;
}

interface CoworkSessionActionsOptions {
  setPendingSessionListAction: React.Dispatch<
    React.SetStateAction<CoworkSessionListActionDetail | null>
  >;
  pendingSessionListAction: CoworkSessionListActionDetail | null;
  currentSession: CoworkSession | null;
  currentSessionRuntimeRunning: boolean;
  sessionTranscriptMutationRef: React.MutableRefObject<SessionTranscriptMutation | null>;
  setSessionTranscriptMutation: React.Dispatch<
    React.SetStateAction<SessionTranscriptMutation | null>
  >;
  sessionTranscriptMutation: SessionTranscriptMutation | null;
}

export function useCoworkSessionActions({
  setPendingSessionListAction,
  pendingSessionListAction,
  currentSession,
  currentSessionRuntimeRunning,
  sessionTranscriptMutationRef,
  setSessionTranscriptMutation,
  sessionTranscriptMutation,
}: CoworkSessionActionsOptions) {
  const pluginRevision = useSyncExternalStore(
    appBrowserRegistry.subscribe,
    appBrowserRegistry.getContextRevision,
  );
  useEffect(() => {
    const handleSessionListAction = (event: Event) => {
      const detail = (event as CustomEvent<CoworkSessionListActionDetail>).detail;
      if (!detail?.sessionId || detail.action !== 'copy') return;
      setPendingSessionListAction(detail);
    };
    window.addEventListener(COWORK_SESSION_LIST_ACTION_EVENT, handleSessionListAction);
    return () => {
      window.removeEventListener(COWORK_SESSION_LIST_ACTION_EVENT, handleSessionListAction);
    };
  }, [setPendingSessionListAction]);

  useEffect(() => {
    if (!pendingSessionListAction) return;
    if (currentSession?.id !== pendingSessionListAction.sessionId) {
      setPendingSessionListAction(null);
      return;
    }
    const actionError = getSessionTranscriptActionError(
      pendingSessionListAction.action,
      currentSession.id,
      currentSessionRuntimeRunning,
    );
    if (actionError) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t(actionError),
        }),
      );
      setPendingSessionListAction(null);
      return;
    }

    if (sessionTranscriptMutationRef.current) return;
    const operation = { kind: 'copy' as const, sessionId: currentSession.id };
    setPendingSessionListAction(null);
    sessionTranscriptMutationRef.current = operation;
    setSessionTranscriptMutation(operation);
    let failureCode: SessionCopyErrorCode | undefined;
    void coworkService
      .copySession(currentSession, code => { failureCode = code; })
      .then(copied => {
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t(
              copied ? 'coworkCopySessionSuccess' : copyFailureTranslation(failureCode),
            ),
          }),
        );
      })
      .finally(() => {
        if (sessionTranscriptMutationRef.current === operation) {
          sessionTranscriptMutationRef.current = null;
          setSessionTranscriptMutation(null);
        }
      });
  }, [
    currentSession,
    currentSessionRuntimeRunning,
    pendingSessionListAction,
    pluginRevision,
    sessionTranscriptMutation,
    setPendingSessionListAction,
    sessionTranscriptMutationRef,
    setSessionTranscriptMutation,
  ]);
}

export type SessionTranscriptMutation = {
  kind: 'copy' | 'fork' | 'message';
  sessionId: string;
};
