import type { CollaborationRoom } from '@shared/cowork/collaboration';
import { useEffect } from 'react';

import { type JustDoChatWrapperRef } from '@/features/cowork/components/chat/JustDoChatWrapper';
import { coworkService } from '@/features/cowork/coworkService';
import type { CoworkSession, CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import {
  COWORK_SESSION_LIST_ACTION_EVENT,
  type CoworkSessionListActionDetail,
} from '@/features/cowork/sessionListActions';
import { i18nService } from '@/services/i18n';

import { COLLABORATION_DISPLAY_TAB_ID } from '../preview/displayTabIds';

interface CoworkSessionActionsOptions {
  setPendingSessionListAction: React.Dispatch<
    React.SetStateAction<CoworkSessionListActionDetail | null>
  >;
  pendingSessionListAction: CoworkSessionListActionDetail | null;
  currentSession: CoworkSession | null;
  setCollaborationSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  collaborationRooms: CollaborationRoom[];
  setCollaborationMemberId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setPreferredDisplayTabId: React.Dispatch<React.SetStateAction<string | null>>;
  setIsDisplayPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsWorkspaceFilesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  currentSessionRuntimeRunning: boolean;
  sessions: CoworkSessionSummary[];
  sessionTranscriptMutationRef: React.MutableRefObject<SessionTranscriptMutation | null>;
  setSessionTranscriptMutation: React.Dispatch<
    React.SetStateAction<SessionTranscriptMutation | null>
  >;
  currentSessionIdRef: React.MutableRefObject<string | null>;
  chatWrapperRef: React.RefObject<JustDoChatWrapperRef>;
  currentGatewaySessionKey: string | null;
  setSessionExportMessageCount: React.Dispatch<React.SetStateAction<number>>;
  setIsSessionExportOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sessionTranscriptMutation: SessionTranscriptMutation | null;
}

export function useCoworkSessionActions({
  setPendingSessionListAction,
  pendingSessionListAction,
  currentSession,
  setCollaborationSessionId,
  collaborationRooms,
  setCollaborationMemberId,
  setPreferredDisplayTabId,
  setIsDisplayPanelOpen,
  setIsWorkspaceFilesOpen,
  currentSessionRuntimeRunning,
  sessions,
  sessionTranscriptMutationRef,
  setSessionTranscriptMutation,
  currentSessionIdRef,
  chatWrapperRef,
  currentGatewaySessionKey,
  setSessionExportMessageCount,
  setIsSessionExportOpen,
  sessionTranscriptMutation,
}: CoworkSessionActionsOptions) {
  useEffect(() => {
    const handleSessionListAction = (event: Event) => {
      const detail = (event as CustomEvent<CoworkSessionListActionDetail>).detail;
      if (!detail?.sessionId || !['copy', 'export', 'collaboration'].includes(detail.action))
        return;
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
    if (pendingSessionListAction.action === 'collaboration') {
      if (!currentSession.external) {
        setCollaborationSessionId(currentSession.id);
        const requestedMemberId = pendingSessionListAction.memberSessionId;
        const room = collaborationRooms.find(item => item.anchorSessionId === currentSession.id);
        setCollaborationMemberId(
          room?.members.some(member => member.sessionId === requestedMemberId)
            ? requestedMemberId
            : undefined,
        );
        setPreferredDisplayTabId(COLLABORATION_DISPLAY_TAB_ID);
        setIsDisplayPanelOpen(true);
        setIsWorkspaceFilesOpen(false);
      }
      setPendingSessionListAction(null);
      return;
    }
    if (
      currentSessionRuntimeRunning ||
      collaborationRooms
        .find(room => room.anchorSessionId === currentSession.id)
        ?.members.some(member =>
          sessions.some(session => session.id === member.sessionId && session.status === 'running'),
        )
    ) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: i18nService.t(
            pendingSessionListAction.action === 'export'
              ? 'coworkExportWaitForCompletion'
              : 'coworkCopyWaitForCompletion',
          ),
        }),
      );
      setPendingSessionListAction(null);
      return;
    }

    if (pendingSessionListAction.action === 'copy') {
      if (sessionTranscriptMutationRef.current) return;
      const operation = { kind: 'copy' as const, sessionId: currentSession.id };
      setPendingSessionListAction(null);
      sessionTranscriptMutationRef.current = operation;
      setSessionTranscriptMutation(operation);
      void coworkService
        .copySession(currentSession)
        .then(copied => {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t(
                copied ? 'coworkCopySessionSuccess' : 'coworkCopySessionFailed',
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
      return;
    }

    let attempts = 0;
    let settled = false;
    let timer: number | undefined;
    const openExportWhenReady = () => {
      if (settled) return;
      attempts += 1;
      if (currentSessionIdRef.current !== pendingSessionListAction.sessionId) {
        if (attempts >= 100) {
          settled = true;
          setPendingSessionListAction(null);
        }
        return;
      }
      const snapshot = chatWrapperRef.current?.getExportSnapshot();
      if (snapshot && snapshot.sessionKey === currentGatewaySessionKey && !snapshot.isLoading) {
        settled = true;
        setSessionExportMessageCount(snapshot.messages.length);
        setIsSessionExportOpen(true);
        setPendingSessionListAction(null);
        return;
      }
      if (attempts >= 100) {
        settled = true;
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkExportHistoryLoading'),
          }),
        );
        setPendingSessionListAction(null);
      }
    };
    openExportWhenReady();
    if (!settled) timer = window.setInterval(openExportWhenReady, 100);
    return () => {
      settled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [
    currentGatewaySessionKey,
    currentSession,
    currentSessionRuntimeRunning,
    pendingSessionListAction,
    collaborationRooms,
    sessions,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setPreferredDisplayTabId,
    sessionTranscriptMutation,
    setPendingSessionListAction,
    setCollaborationSessionId,
    setCollaborationMemberId,
    sessionTranscriptMutationRef,
    setSessionTranscriptMutation,
    currentSessionIdRef,
    chatWrapperRef,
    setSessionExportMessageCount,
    setIsSessionExportOpen,
  ]);
  return {};
}

export type SessionTranscriptMutation = {
  kind: 'copy' | 'fork' | 'message';
  sessionId: string;
};
