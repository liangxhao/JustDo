import type { AppBrowserHost, AppViewContext } from '@app-plugin/sdk/browser';
import { useEffect, useSyncExternalStore } from 'react';

import type { CollaborationRoom } from '../../contracts/collaboration';
import type { TeamDiscussionRoom } from '../../contracts/teamDiscussion';
import {
  useCollaborationRooms,
  useCollaborationRoomsState,
} from './collaboration/CollaborationPanel';
import { useTeamDiscussionRoomsState } from './discussions/teamDiscussionNavigation';
import { groupTeamKey } from './display/agentTeamEntries';
import { application, browserHost } from './ports';
import CollaborationTaskDetails from './sessions/CollaborationTaskDetails';
import { collectRelatedRunningSessionIds } from './sessions/sessionListActivity';

let retainedRooms: CollaborationRoom[] = [];
let retainedDiscussions: TeamDiscussionRoom[] = [];
export function registerSessionPresentation(host: AppBrowserHost): () => void {
  const release = host.registerSessionPresentation(sessionId => {
    const memberRoom = retainedRooms.find(
      item =>
        item.members.some(member => member.sessionId === sessionId) &&
        item.anchorSessionId !== sessionId,
    );
    if (memberRoom)
      return {
        anchorSessionId: memberRoom.anchorSessionId,
        workspace: {
          contributionId: 'team',
          selection: { memberSessionId: sessionId, version: Date.now() },
        },
      };
    const room = retainedRooms.find(item => item.anchorSessionId === sessionId);
    const summaryAvailable =
      !!room || retainedDiscussions.some(item => item.sourceSessionId === sessionId);
    const metadata = application.metadata.getSnapshot().cowork;
    if (!room) return summaryAvailable ? { summaryAvailable } : undefined;
    const members = (metadata.sessionDirectory ?? metadata.sessions).filter(session =>
      room.members.some(member => member.sessionId === session.id),
    );
    return {
      summaryAvailable,
      copyAllowed: false,
      exportAllowed: !room.deleting,
      status: room.deleting ? 'error' : undefined,
      ...(members.length
        ? { updatedAt: Math.max(...members.map(member => member.updatedAt)) }
        : {}),
      ...(room.deleting ? { titleSuffix: host.t('collaborationDeletePending') } : {}),
      deletionMessage: host.t('collaborationDeleteConfirm'),
      diagnosticScopeLabel: host.t('diagnosticsMain'),
    };
  });
  host.registerView({
    id: 'session-observer',
    slot: 'application.page',
    labelKey: 'teamTitle',
    component: SessionObserver,
  });
  return () => {
    retainedRooms = [];
    retainedDiscussions = [];
    release();
  };
}
function SessionObserver() {
  const host = browserHost();
  const metadata = useSyncExternalStore(
    host.application.metadata.subscribe,
    host.application.metadata.getSnapshot,
  );
  const activeSessionId = metadata.cowork.currentSession?.id ?? null;
  const open = (sessionId: string, selection?: unknown) => {
    if (
      host.signal.aborted ||
      application.metadata.getSnapshot().cowork.currentSession?.id !== sessionId
    )
      return;
    host.openWorkspace('team', sessionId, selection);
  };
  const { rooms, ready: roomsReady } = useCollaborationRoomsState({
    activeSessionId,
    onFirstCollaboration: sessionId => open(sessionId),
  });
  const { rooms: discussions, ready: discussionsReady } = useTeamDiscussionRoomsState(room => {
    if (room.sourceSessionId === activeSessionId && activeSessionId)
      open(activeSessionId, { key: groupTeamKey(room.id), version: Date.now() });
  });
  useEffect(() => {
    if (host.signal.aborted) return;
    retainedRooms = rooms;
    retainedDiscussions = discussions;
    if (roomsReady && discussionsReady)
      host.publishSessionActivity([
        ...collectRelatedRunningSessionIds(
          rooms,
          discussions,
          metadata.cowork.sessionRuntimeActivity,
        ),
      ]);
    host.interactionContextChanged();
  }, [
    rooms,
    discussions,
    roomsReady,
    discussionsReady,
    host,
    metadata.cowork.sessionRuntimeActivity,
    metadata.cowork.sessions,
    metadata.cowork.sessionDirectory,
  ]);
  return null;
}
export function teamDetailsPresentation(sessionId: string): 'replace' | 'hidden' {
  return retainedRooms.some(room => room.anchorSessionId === sessionId) ? 'replace' : 'hidden';
}

export function TeamSessionDetails({ session, sessionSummary, onInspectSession }: AppViewContext) {
  const rooms = useCollaborationRooms();
  const room = rooms.find(item => item.anchorSessionId === (sessionSummary?.id ?? session?.id));
  if (!room) return null;
  return <CollaborationTaskDetails room={room} onSelect={member => onInspectSession?.(member)} />;
}
