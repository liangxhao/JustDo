import type {
  CollaborationDelivery,
  CollaborationMember,
  CollaborationRoom,
  CollaborationRoomEntry,
  CollaborationSnapshot,
} from '@shared/cowork/agent-team/collaboration';
import {
  CollaborationDeliveryState,
  CollaborationReviewState,
} from '@shared/cowork/agent-team/collaboration';
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSelector } from 'react-redux';

import type { CoworkSession, CoworkSessionStatus } from '@/features/cowork/coworkTypes';
import AgentTeamSettingsDialog from '@/features/plugins/extensions/AgentTeamSettingsDialog';
import { i18nService } from '@/services/i18n';
import { useOwnerDocument } from '@/shared/dom/ownerDocument';
import type { RootState } from '@/store';

import AgentTeamMenu from '../chat/AgentTeamMenu';
import DiscussionActionsMenu from '../discussions/DiscussionActionsMenu';
import { useTeamDiscussionRooms } from '../discussions/teamDiscussionNavigation';
import { type AgentTeamEntry, buildAgentTeamEntries } from '../display/agentTeamEntries';
import { OPEN_TEAM_RECORDS } from '../display/agentTeamHistory';
import { COLLABORATION_PALETTE } from '../shared/collaborationPalette';
import type { Subtask } from '../subagents/subtaskPresentation';
import {
  collaborationContinueDraftKey,
  type CollaborationContinueRequest,
  type CollaborationContinueStatus,
  continueRequests,
  reconcileContinueDraft,
  useContinueRequestsRevision,
} from './collaborationContinueDraft';
import CollaborationContinueInput from './CollaborationContinueInput';
import {
  collaborationContinueStatus,
  continueTimingsEvidenceKey,
} from './collaborationContinueStatus';
import CollaborationGraph from './CollaborationGraph';
import CollaborationMemberHistory from './CollaborationMemberHistory';
import CollaborationReferenceAction from './CollaborationReferenceAction';
import CollaborationStopButton from './CollaborationStopButton';

const STATUS_LABELS: Record<CoworkSessionStatus, string> = {
  idle: 'collaborationIdle',
  running: 'coworkStatusRunning',
  completed: 'collaborationIdle',
  error: 'coworkStatusError',
};
const DELIVERY_STATUS_LABELS = {
  [CollaborationDeliveryState.QUEUED]: 'collaborationQueued',
  [CollaborationDeliveryState.DISPATCHING]: 'collaborationDispatching',
  [CollaborationDeliveryState.ACCEPTED]: 'collaborationAccepted',
  [CollaborationDeliveryState.UNKNOWN]: 'collaborationUnknown',
  [CollaborationDeliveryState.FAILED]: 'collaborationFailed',
} as const;
const EMPTY_SESSIONS: never[] = [];
const EMPTY_RUN_TIMINGS: SessionRunTiming[] = [];

export const COLLABORATION_CHANGED = 'cowork:collaboration-changed';

type CollaborationRoomsSnapshot = {
  rooms: CollaborationRoomEntry[];
  baselineRoomIds: readonly string[] | null;
  revision: number;
};

const EMPTY_ROOMS_SNAPSHOT: CollaborationRoomsSnapshot = {
  rooms: [],
  baselineRoomIds: null,
  revision: 0,
};
let roomsSnapshot = EMPTY_ROOMS_SNAPSHOT;
let roomsRequestId = 0;
let roomsBaselineRequestId = 0;
let roomsStarted = false;
let unsubscribeRoomsChanged: (() => void) | undefined;
const roomSubscribers = new Set<() => void>();

function emitRoomsSnapshot(next: CollaborationRoomsSnapshot): void {
  roomsSnapshot = next;
  for (const subscriber of roomSubscribers) subscriber();
}

function refreshCollaborationRooms(): void {
  const currentRequestId = ++roomsRequestId;
  const request = window.electron?.collaboration?.list?.();
  if (!request) return;
  const failBaseline = () => {
    if (!roomsStarted || currentRequestId !== roomsBaselineRequestId) return;
    roomsBaselineRequestId = 0;
    // A newer successful response may already have arrived while startup failed.
    if (roomsSnapshot.revision > 0 && roomsSnapshot.baselineRoomIds === null)
      emitRoomsSnapshot({
        ...roomsSnapshot,
        baselineRoomIds: roomsSnapshot.rooms.map(room => room.id),
        revision: roomsSnapshot.revision + 1,
      });
  };
  void request
    .then(result => {
      if (!roomsStarted) return;
      if (!result.success) {
        failBaseline();
        return;
      }
      const isBaselineRequest = currentRequestId === roomsBaselineRequestId;
      const isLatestRequest = currentRequestId === roomsRequestId;
      if (!isBaselineRequest && !isLatestRequest) return;
      emitRoomsSnapshot({
        rooms: isLatestRequest ? result.value : roomsSnapshot.rooms,
        baselineRoomIds:
          isBaselineRequest ||
          (roomsBaselineRequestId === 0 && roomsSnapshot.baselineRoomIds === null)
            ? result.value.map(room => room.id)
            : roomsSnapshot.baselineRoomIds,
        revision: roomsSnapshot.revision + 1,
      });
    })
    .catch(failBaseline);
}

function startCollaborationRooms(): void {
  if (roomsStarted) return;
  roomsStarted = true;
  roomsBaselineRequestId = roomsRequestId + 1;
  refreshCollaborationRooms();
  unsubscribeRoomsChanged = window.electron?.cowork?.onSessionsChanged?.(refreshCollaborationRooms);
  window.addEventListener(COLLABORATION_CHANGED, refreshCollaborationRooms);
}

function stopCollaborationRooms(): void {
  if (!roomsStarted) return;
  roomsStarted = false;
  roomsRequestId += 1;
  roomsBaselineRequestId = 0;
  unsubscribeRoomsChanged?.();
  unsubscribeRoomsChanged = undefined;
  window.removeEventListener(COLLABORATION_CHANGED, refreshCollaborationRooms);
  roomsSnapshot = EMPTY_ROOMS_SNAPSHOT;
}

function subscribeCollaborationRooms(subscriber: () => void): () => void {
  roomSubscribers.add(subscriber);
  startCollaborationRooms();
  return () => {
    roomSubscribers.delete(subscriber);
    if (!roomSubscribers.size) stopCollaborationRooms();
  };
}

function useCollaborationRoomsSnapshot(): CollaborationRoomsSnapshot {
  return useSyncExternalStore(
    subscribeCollaborationRooms,
    () => roomsSnapshot,
    () => EMPTY_ROOMS_SNAPSHOT,
  );
}

export function useCollaborationRooms(options?: {
  activeSessionId: string | null;
  onFirstCollaboration: (sessionId: string) => void;
}): CollaborationRoomEntry[] {
  const snapshot = useCollaborationRoomsSnapshot();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const observedRoomIds = useRef<Set<string>>();
  const mountedBeforeBaseline = useRef(snapshot.baselineRoomIds === null);
  useEffect(() => {
    if (!snapshot.baselineRoomIds) return;
    observedRoomIds.current ??= new Set(
      mountedBeforeBaseline.current
        ? snapshot.baselineRoomIds
        : snapshot.rooms.map(room => room.id),
    );
    const activeSessionId = optionsRef.current?.activeSessionId ?? null;
    const newRoom = snapshot.rooms.find(
      room => !observedRoomIds.current!.has(room.id) && room.anchorSessionId === activeSessionId,
    );
    // Keep observed IDs after removal too: a later refresh must not reopen a dismissed panel.
    for (const room of snapshot.rooms) observedRoomIds.current.add(room.id);
    if (newRoom && activeSessionId === optionsRef.current?.activeSessionId) {
      optionsRef.current?.onFirstCollaboration(newRoom.anchorSessionId);
    }
  }, [snapshot]);
  return snapshot.rooms;
}

export function CollaborationMemberLinks({
  sessionId,
  onOpen,
}: {
  sessionId: string;
  onOpen: (entry: AgentTeamEntry) => void;
}) {
  const rooms = useCollaborationRooms();
  const discussions = useTeamDiscussionRooms();
  const ownerDocument = useOwnerDocument();
  const entries = buildAgentTeamEntries(sessionId, rooms, discussions, key => i18nService.t(key));
  return (
    <AgentTeamMenu
      key={sessionId}
      entries={entries}
      onSelect={onOpen}
      onHistory={
        rooms.length || discussions.length
          ? () =>
              window.dispatchEvent(new CustomEvent(OPEN_TEAM_RECORDS, { detail: ownerDocument }))
          : undefined
      }
    />
  );
}

export default function CollaborationPanel({
  source,
  roomId,
  roundId,
  selectedMemberId,
  onSelect,
  onOpenSubtask,
  onFocusComposer,
  onRequestContinue,
}: {
  source: CoworkSession;
  roomId?: string;
  roundId?: string;
  selectedMemberId?: string;
  onSelect: (sessionId: string | undefined) => void;
  onOpenSubtask?: (task: Subtask, parentSessionId: string) => void;
  onFocusComposer?: () => void;
  onRequestContinue?: (
    room: CollaborationRoom,
    member: CollaborationMember,
    delivery: CollaborationDelivery | undefined,
    input: CollaborationContinueRequest,
  ) => Promise<CollaborationContinueStatus>;
}) {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const sessions = useSelector((state: RootState) => state.cowork?.sessions ?? EMPTY_SESSIONS);
  const sourceRunTimings = useSelector(
    (state: RootState) => state.cowork?.sessionRunTimings?.[source.id] ?? EMPTY_RUN_TIMINGS,
  );
  const timingsEvidenceKey = continueTimingsEvidenceKey(sourceRunTimings);
  const continueRequestsRevision = useContinueRequestsRevision();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loaded, setLoaded] = useState<{
    sessionId: string;
    snapshot: CollaborationSnapshot;
    timingsEvidenceKey: string;
  }>();
  const snapshot = loaded?.sessionId === source.id ? loaded.snapshot : undefined;
  const [error, setError] = useState('');
  const [receiptId, setReceiptId] = useState<string>();
  const messageTextCache = useRef(new Map<string, string>());
  const messageTextCacheRoomId = useRef<string>();
  const roomRevision = useCollaborationRoomsSnapshot().revision;
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await window.electron.collaboration.read(source.id);
        if (disposed) return;
        if (result.success) {
          setLoaded({ sessionId: source.id, snapshot: result.value, timingsEvidenceKey });
          setError('');
        } else setError(result.error);
      } catch {
        if (!disposed) setError('collaborationRuntimeUnavailable');
      }
    };
    void refresh();
    return () => {
      disposed = true;
    };
  }, [roomRevision, source.id, timingsEvidenceKey]);
  useEffect(() => {
    if (!snapshot) return;
    for (const request of continueRequests(source.id)) {
      const status = collaborationContinueStatus(
        request.locator,
        request.requestId,
        snapshot,
        sourceRunTimings,
        loaded?.timingsEvidenceKey === timingsEvidenceKey,
      );
      if (status) reconcileContinueDraft(request.key, request.requestId, status);
    }
  }, [
    snapshot,
    source.id,
    sourceRunTimings,
    timingsEvidenceKey,
    loaded?.timingsEvidenceKey,
    continueRequestsRevision,
  ]);
  const room = snapshot?.room?.id === roomId || !roomId ? snapshot?.room : undefined;
  const selectedRound = roundId
    ? snapshot?.rounds?.find(round => round.id === roundId)
    : snapshot?.rounds?.[snapshot.rounds.length - 1];
  const deliveries =
    snapshot?.deliveries.filter(delivery => !roundId || delivery.roundId === roundId) ?? [];
  // Batches share the team roster; receipts scope edges and statuses, not membership.
  const statuses = Object.fromEntries(
    roundId
      ? (room?.members ?? []).flatMap(member => {
          const received = deliveries.filter(item => item.to === member.agentId);
          const delivery = received[received.length - 1];
          // Admission alone does not establish execution, and another batch may now use this session.
          return delivery
            ? [
                [
                  member.sessionId,
                  i18nService.t(
                    delivery.executionOutcome
                      ? `teamExecution_${delivery.executionOutcome}`
                      : DELIVERY_STATUS_LABELS[delivery.state],
                  ),
                ],
              ]
            : [];
        })
      : sessions.map(session => [session.id, i18nService.t(STATUS_LABELS[session.status])]),
  );
  if (messageTextCacheRoomId.current !== room?.id) {
    messageTextCacheRoomId.current = room?.id;
    messageTextCache.current.clear();
  }
  const selectedMember = room?.members.some(member => member.sessionId === selectedMemberId)
    ? selectedMemberId
    : undefined;
  const activeReceipt =
    !selectedMember && receiptId
      ? deliveries.find(delivery => delivery.id === receiptId)
      : undefined;
  const detailMemberId =
    selectedMember ||
    (activeReceipt
      ? room?.members.find(member => member.agentId === activeReceipt.to)?.sessionId
      : undefined);
  const detailMember = room?.members.find(member => member.sessionId === detailMemberId);
  const detailName =
    agents.find(agent => agent.id === detailMember?.agentId)?.name || detailMember?.agentId || '';
  const organizerName = agents.find(agent => agent.id === source.agentId)?.name ?? source.agentId;
  const organizerLabel = `${i18nService.t('teamOrganizer')}: ${organizerName}`;
  const roundStatus = selectedRound
    ? [
        i18nService.t(`teamRound_${selectedRound.state}`),
        ...(selectedRound.pending > 0
          ? [`${i18nService.t('teamPendingExecutions')}: ${selectedRound.pending}`]
          : []),
      ].join(' · ')
    : '';
  const reviews = (snapshot?.reviews ?? []).filter(review => review.roundId === selectedRound?.id);
  return (
    <section
      className="flex h-full min-h-0 flex-col bg-surface"
      aria-label={i18nService.t('collaborationTab')}
    >
      {room && settingsOpen && (
        <AgentTeamSettingsDialog
          key={room.id}
          team={{ kind: 'collaboration', roomId: room.id }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {!detailMember && (
        <div className="flex min-h-10 min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle bg-background px-3 py-1">
          <h2 className="shrink-0 text-sm font-semibold">
            {i18nService.t('collaborationOverview')}
          </h2>
          {room && (
            <>
              <span
                className="min-w-0 max-w-[40%] truncate text-xs text-secondary"
                title={organizerLabel}
              >
                {organizerLabel}
              </span>
              {roundStatus && (
                <span
                  className="min-w-0 truncate text-xs text-secondary"
                  role="status"
                  title={roundStatus}
                >
                  {roundStatus}
                </span>
              )}
            </>
          )}
          {room && (
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <CollaborationStopButton
                key={room.id}
                label={i18nService.t('collaborationStop')}
                disabled={room.deleting === true}
                stop={() => window.electron.collaboration.stop(room.anchorSessionId)}
              />
              <DiscussionActionsMenu compact onSettings={() => setSettingsOpen(true)} />
            </div>
          )}
        </div>
      )}
      <div
        className={`min-h-0 flex-1 ${room ? `flex flex-col overflow-hidden${detailMemberId ? ' p-3' : ''}` : 'overflow-auto p-3'}`}
      >
        {error && (
          <p role="alert" className="my-3 text-sm text-red-500">
            {i18nService.t(error)}
          </p>
        )}
        {room && detailMember ? (
          <>
            <div className="min-h-0 flex-1">
              <CollaborationMemberHistory
                key={detailMemberId}
                onOpenSubtask={onOpenSubtask}
                anchorSessionId={room.anchorSessionId}
                roomId={room.id}
                member={detailMember}
                name={detailName}
                backAction={{
                  label: i18nService.t('collaborationBackToOverview'),
                  onClick: () => {
                    setReceiptId(undefined);
                    onSelect(undefined);
                  },
                }}
                headerMenu={
                  <DiscussionActionsMenu compact onSettings={() => setSettingsOpen(true)} />
                }
                headerAction={
                  onFocusComposer && source.id === room.anchorSessionId ? (
                    <CollaborationReferenceAction
                      key={detailMemberId}
                      room={room}
                      member={detailMember}
                      name={detailName}
                      delivery={
                        activeReceipt &&
                        (activeReceipt.to === detailMember.agentId ||
                          activeReceipt.from === detailMember.agentId)
                          ? activeReceipt
                          : undefined
                      }
                      onFocusComposer={onFocusComposer}
                    />
                  ) : undefined
                }
                receipt={
                  activeReceipt &&
                  activeReceipt.roomId === room.id &&
                  detailMember.agentId === activeReceipt.to
                    ? {
                        deliveryId: activeReceipt.id,
                        id: activeReceipt.runId || activeReceipt.id,
                      }
                    : undefined
                }
                workingDirectory={source.cwd}
                peerColors={Object.fromEntries(
                  room.members.map((member, index) => [
                    member.agentId,
                    COLLABORATION_PALETTE[index % COLLABORATION_PALETTE.length].stroke,
                  ]),
                )}
                peerNames={Object.fromEntries(
                  room.members.map(member => [
                    member.agentId,
                    agents.find(agent => agent.id === member.agentId)?.name || member.agentId,
                  ]),
                )}
              />
            </div>
            {onFocusComposer &&
              onRequestContinue &&
              source.id === room.anchorSessionId &&
              detailMember.sessionId !== room.anchorSessionId && (
                <div className="-mx-3 max-h-[55%] min-h-0 shrink-0 overflow-y-auto px-3 pb-4">
                  <CollaborationContinueInput
                    key={detailMemberId}
                    draftKey={collaborationContinueDraftKey(
                      {
                        roomId: room.id,
                        sourceSessionId: room.anchorSessionId,
                        targetAgentId: detailMember.agentId,
                        targetSessionId: detailMember.sessionId,
                        targetSessionKey: detailMember.sessionKey,
                      },
                      activeReceipt?.id,
                    )}
                    disabled={room.deleting === true}
                    onRequestContinue={input =>
                      onRequestContinue(room, detailMember, activeReceipt, input)
                    }
                  />
                </div>
              )}
          </>
        ) : room ? (
          <>
            {reviews.length > 0 && (
              <div className="max-h-[40%] shrink-0 overflow-y-auto py-2">
                {reviews.map(review => (
                  <button
                    key={review.id}
                    className="mx-3 my-1 block rounded-lg border border-border px-3 py-2 text-left text-xs hover:bg-surface-raised"
                    onClick={() => {
                      setReceiptId(review.reviewDeliveryId);
                      onSelect(undefined);
                    }}
                  >
                    {i18nService.t('teamIndependentReview')} ·{' '}
                    {agents.find(agent => agent.id === review.reviewerAgentId)?.name ??
                      review.reviewerAgentId}
                    {' · '}
                    {i18nService.t(
                      review.state === CollaborationReviewState.CONFIRMED
                        ? `teamReviewVerdict_${review.verdict}`
                        : `teamReviewState_${review.state}`,
                    )}
                    {' · '}
                    {i18nService.t('teamReviewedExecutions')}: {review.deliveryIds.length}
                  </button>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1">
              <CollaborationGraph
                room={room}
                deliveries={deliveries}
                names={Object.fromEntries(agents.map(agent => [agent.id, agent.name]))}
                statuses={statuses}
                onSelectMember={id => {
                  setReceiptId(undefined);
                  onSelect(id);
                }}
                onSelectMessage={delivery => {
                  const target = room.members.find(member => member.agentId === delivery.to);
                  if (target) {
                    setReceiptId(delivery.id);
                    onSelect(undefined);
                  }
                }}
                messageTextCache={messageTextCache.current}
              />
            </div>
          </>
        ) : (
          snapshot && (
            <>
              <p className="my-4 text-sm text-secondary">
                {i18nService.t('collaborationSetupHelp')}
              </p>
            </>
          )
        )}
      </div>
    </section>
  );
}
