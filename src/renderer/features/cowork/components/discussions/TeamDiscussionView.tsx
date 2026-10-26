import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChevronLeftIcon,
  PaperClipIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import { StopIcon } from '@heroicons/react/24/solid';
import {
  type AgentTeamOverrides,
  defaultAgentTeamSettings,
  effectiveDiscussionDefaults,
} from '@shared/cowork/agent-team/agentTeamSettings';
import {
  type TeamDiscussionExecution,
  type TeamDiscussionMessage,
  type TeamDiscussionReadResult,
  type TeamDiscussionRoom,
  type TeamDiscussionSend,
  TeamDiscussionState,
  type TeamDiscussionSummary,
} from '@shared/cowork/agent-team/teamDiscussion';
import { discussionMemberSessionKey } from '@shared/cowork/agent-team/teamDiscussion';
import { buildCoworkSessionKey } from '@shared/cowork/sessionKey';
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '@/features/cowork/coworkService';
import { addDraftMessageQuote } from '@/features/cowork/coworkSlice';
import AgentTeamSettingsDialog, {
  AGENT_TEAM_SETTINGS_CHANGED,
} from '@/features/plugins/extensions/AgentTeamSettingsDialog';
import { useExtensionAvailability } from '@/features/plugins/extensions/useExtensionEnablement';
import { i18nService } from '@/services/i18n';
import { useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';
import type { RootState } from '@/store';
import { store } from '@/store';

import CollaborationMemberHistory from '../collaboration/CollaborationMemberHistory';
import { type AgentTeamEntry, OPEN_AGENT_TEAM } from '../composer/ComposerMoreMenu';
import {
  COMPOSER_FRAME_CLASS,
  COMPOSER_SURFACE_CLASS,
  COMPOSER_TEXTAREA_CLASS,
} from '../composer/draft/composerStyles';
import type { DiscussionQuote } from '../composer/draft/messageQuote';
import { LocalSpeechInputButton } from '../composer/speech/LocalSpeechInputButton';
import { RunControlButton } from '../composer/submission/RunControlButton';
import { COLLABORATION_PALETTE } from '../shared/collaborationPalette';
import DiscussionActionsMenu from './DiscussionActionsMenu';
import { discussionQuestionAgents, discussionRunningAgents } from './discussionActivity';
import { formatDiscussionExportMessage } from './discussionExport';
import DiscussionMentionInput from './DiscussionMentionInput';
import { hasUnboundDiscussionMention } from './discussionMentions';
import {
  deleteDiscussionDraft,
  getDiscussionDraft,
  settleDiscussionDraft,
  settleDiscussionDraftFromRun,
  updateDiscussionDraft,
  useDiscussionDraft,
} from './teamDiscussionDraft';
import TeamDiscussionMembersPanel from './TeamDiscussionMembersPanel';
import TeamDiscussionMessageRow from './TeamDiscussionMessage';
import { TEAM_ROOM_FOCUSED, TEAM_ROOMS_CHANGED } from './teamDiscussionNavigation';
import {
  DISCUSSION_PENDING_LIMIT,
  discussionPendingAccepted,
  discussionPendingCancellable,
  discussionPendingInputs,
  discussionQueueAvailable,
} from './teamDiscussionQueue';
import TeamDiscussionQuoteCard from './TeamDiscussionQuoteCard';
import { buildDiscussionReference, buildTeamResultDraft } from './teamResultDraft';

const t = (key: string) => i18nService.t(key);
const EMPTY_INTERACTIONS: never[] = [];
const button =
  'rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-raised disabled:opacity-40';
const field = 'rounded-lg border border-border bg-surface px-3 py-2 text-foreground';
const headerButton =
  'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40';
const statusLabels: Record<string, string> = {
  preparing: 'teamRecordPreparing',
  prepare_failed: 'teamRecordPrepareFailed',
  ready: 'teamRecordReady',
  submitting: 'teamRecordSubmitting',
  running: 'teamRecordRunning',
  stopping: 'teamRecordStopping',
  interrupted: 'teamRecordUnconfirmed',
  deleting: 'teamRecordDeleting',
  completed: 'teamRecordEnded',
  failed: 'teamRecordFailed',
  cancelled: 'teamRecordStopped',
};
export { TEAM_ROOMS_CHANGED } from './teamDiscussionNavigation';

export function useAgentTeamEntry() {
  const [entry, setEntry] = useState<AgentTeamEntry | null>(null);
  useEffect(() => {
    const open = (event: Event) => setEntry((event as CustomEvent<AgentTeamEntry>).detail);
    window.addEventListener(OPEN_AGENT_TEAM, open);
    return () => window.removeEventListener(OPEN_AGENT_TEAM, open);
  }, []);
  return [entry, setEntry] as const;
}

export default function TeamDiscussionView({
  entry,
  onClose,
  onRoomFocused,
  embedded = false,
  onPrepareSourceDraft,
  onReferenceSource,
}: {
  entry: AgentTeamEntry;
  onClose: () => void;
  embedded?: boolean;
  onRoomFocused?: (roomId: string) => void;
  onPrepareSourceDraft?: (sessionId: string, draft: string) => Promise<void>;
  onReferenceSource?: (sessionId: string, quote: DiscussionQuote) => Promise<void>;
}) {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const agents = useSelector((state: RootState) => state.agent.agents).filter(
    agent => agent.enabled && !agent.deletedAt,
  );
  const draftId = useRef(entry.roomId ?? crypto.randomUUID());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState(defaultAgentTeamSettings);
  const [teamOverrides, setTeamOverrides] = useState<AgentTeamOverrides>({});
  const limits = effectiveDiscussionDefaults(settings, teamOverrides);
  const [mode, setMode] = useState<'task' | 'group'>('task');
  const [detailAgentId, setDetailAgentId] = useState<string>();
  const [detailIsOrganizer, setDetailIsOrganizer] = useState(false);
  const [room, setRoom] = useState<TeamDiscussionRoom | null>(null);
  const sourceSession = useSelector((state: RootState) =>
    state.cowork?.sessions?.find(session => session.id === room?.sourceSessionId),
  );
  const [executions, setExecutions] = useState<TeamDiscussionExecution[]>([]);
  const pendingInteractions = useSelector(
    (state: RootState) => state.cowork?.pendingInteractions ?? EMPTY_INTERACTIONS,
  );
  const composer = useRef<HTMLTextAreaElement>(null);
  const [messages, setMessages] = useState<TeamDiscussionMessage[]>([]);
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState(entry.cwd ?? '');
  const [members, setMembers] = useState<string[]>([]);
  const draft = useDiscussionDraft(draftId.current, entry.draft);
  const { text, quotes, attachments, selected } = draft;
  const rounds = draft.pending?.rounds ?? draft.rounds ?? limits.defaultRounds;
  const draftLocked = !!draft.pending || !!draft.submissionAttemptId;
  const setAttachments = (value: string[] | ((current: string[]) => string[])) =>
    updateDiscussionDraft(draftId.current, {
      attachments:
        typeof value === 'function'
          ? value(getDiscussionDraft(draftId.current).attachments)
          : value,
    });
  const setSelected = (value: string[] | ((current: string[]) => string[])) =>
    updateDiscussionDraft(draftId.current, {
      selected:
        typeof value === 'function' ? value(getDiscussionDraft(draftId.current).selected) : value,
    });
  const setQuotes = (value: typeof quotes | ((current: typeof quotes) => typeof quotes)) =>
    updateDiscussionDraft(draftId.current, {
      quotes:
        typeof value === 'function' ? value(getDiscussionDraft(draftId.current).quotes) : value,
    });
  useEffect(() => {
    let live = true;
    const api = window.electron?.agentTeamSettings;
    if (!api) return;
    const load = async () => {
      const id = room?.id ?? entry.roomId;
      if (id) {
        const result = await api.readTeam('discussion', id);
        if (live && result.success) {
          setSettings(result.value.global.value);
          setTeamOverrides(result.value.team.value);
        }
      } else {
        const result = await api.read();
        if (live && result.success) setSettings(result.value.value);
      }
    };
    const refreshSettings = () => {
      void load().catch(() => {});
    };
    refreshSettings();
    window.addEventListener(AGENT_TEAM_SETTINGS_CHANGED, refreshSettings);
    return () => {
      live = false;
      window.removeEventListener(AGENT_TEAM_SETTINGS_CHANGED, refreshSettings);
    };
  }, [room?.id, entry.roomId]);
  const setRounds = (value: number) => updateDiscussionDraft(draftId.current, { rounds: value });
  const [permission, setPermission] = useState<'ask' | 'auto' | 'full'>('ask');

  useEffect(() => {
    if (room?.id) {
      onRoomFocused?.(room.id);
      window.dispatchEvent(new CustomEvent(TEAM_ROOM_FOCUSED, { detail: room.id }));
    }
    return () => {
      window.dispatchEvent(new CustomEvent(TEAM_ROOM_FOCUSED, { detail: null }));
    };
  }, [room?.id, onRoomFocused]);
  const [previousCursor, setPreviousCursor] = useState<string | undefined>();
  const cursorInitialized = useRef(false);
  const [lastState, setLastState] = useState('');
  const [resultBatch, setResultBatch] = useState<string>();
  const [organizer, setOrganizer] = useState<TeamDiscussionReadResult['organizer']>();
  const [summary, setSummary] = useState<TeamDiscussionSummary>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const {
    loaded: extensionLoaded,
    enabled,
    disabledRevision,
  } = useExtensionAvailability(OpenClawExtensionId.AGENT_TEAM);
  useEffect(() => {
    setSettingsOpen(false);
  }, [disabledRevision]);
  useEffect(() => {
    if (!enabled) setSettingsOpen(false);
  }, [enabled]);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const taskRequestId = useRef(crypto.randomUUID());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const submitting = useRef(false);
  const timeline = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const alive = useRef(true);
  const refreshVersion = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const changeText = (value: string) => {
    updateDiscussionDraft(draftId.current, { text: value });
  };
  const insertSpeechTranscript = (transcript: string) => {
    if (!alive.current) return;
    const current = getDiscussionDraft(draftId.current);
    if (current.pending || current.submissionAttemptId || current.inputEpoch !== draft.inputEpoch)
      return;
    const start = composer.current?.selectionStart ?? current.text.length;
    const end = composer.current?.selectionEnd ?? start;
    const left = current.text.slice(0, start);
    const right = current.text.slice(end);
    const insertion =
      (left && !/\s$/.test(left) ? ' ' : '') +
      transcript.trim() +
      (right && !/^\s/.test(right) ? ' ' : '');
    const next = left + insertion + right;
    if (next.length > 16000) {
      setError('teamDiscussionInvalidInput');
      return;
    }
    changeText(next);
    ownerWindow.requestAnimationFrame(() => {
      composer.current?.focus();
      composer.current?.setSelectionRange(start + insertion.length, start + insertion.length);
    });
  };
  const refresh = useCallback(async (id: string) => {
    const version = ++refreshVersion.current;
    const result = await window.electron.teamDiscussion.read(id);
    if (!alive.current || version !== refreshVersion.current) return;
    if (!result.success) {
      setError(result.error);
      return;
    }
    setRoom(result.value.room);
    setLastState(result.value.latestRun?.state ?? '');
    setResultBatch(result.value.latestRun?.discussionId);
    setOrganizer(result.value.organizer);
    setSummary(result.value.summary);
    setExecutions(result.value.executions ?? []);
    const pending = getDiscussionDraft(draftId.current).pending;
    const queued = result.value.room.pendingInputs?.find(
      input => input.requestId === pending?.requestId,
    );
    if (pending && queued) {
      if (discussionPendingAccepted(queued))
        settleDiscussionDraft(draftId.current, pending.requestId, true);
      else if (queued.state === 'failed' || queued.state === 'cancelled')
        settleDiscussionDraft(draftId.current, pending.requestId, false);
    } else if (pending) {
      settleDiscussionDraftFromRun(
        draftId.current,
        result.value.latestRun?.requestId === pending.requestId
          ? result.value.latestRun
          : result.value.runs?.find(run => run.requestId === pending.requestId),
      );
    }
    setHistoryUnavailable(result.value.historyUnavailable);
    // Retain the last visible projection during a transient read failure.
    if (!result.value.historyUnavailable) {
      if (!cursorInitialized.current) {
        setPreviousCursor(result.value.previousCursor);
        cursorInitialized.current = true;
      }
      const replaced = new Set(
        result.value.discussionIds ?? result.value.messages.map(message => message.discussionId),
      );
      setMessages(current => [
        ...current.filter(message => !replaced.has(message.discussionId)),
        ...result.value.messages,
      ]);
    }
  }, []);
  useEffect(() => {
    const id = room?.id ?? entry.roomId;
    if (!id) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(id);
      } catch {
        if (!disposed) setError('teamDiscussionUnavailable');
      }
      if (!disposed)
        timer = setTimeout(() => {
          void poll();
        }, 1500);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [entry.roomId, room?.id, refresh]);
  const latestMessage = messages[messages.length - 1];
  const latestMediaKey = JSON.stringify(latestMessage?.mediaUrls ?? []);
  useEffect(() => {
    if (atBottom.current) timeline.current?.scrollTo({ top: timeline.current.scrollHeight });
    // Polling returns a fresh projection even when nothing changed. Only
    // actual timeline activity should pull a reader toward the latest reply.
  }, [messages.length, latestMessage?.id, latestMessage?.text, latestMediaKey]);
  const messageName = (message: TeamDiscussionMessage) =>
    message.role === 'user'
      ? t('teamYou')
      : (room?.members.find(member => member.agentId === message.agentId)?.name ??
        agents.find(agent => agent.id === message.agentId)?.name ??
        message.agentId ??
        '?');
  const run = async (operation: () => Promise<void>) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (failure) {
      if (alive.current)
        setError(failure instanceof Error ? failure.message : 'teamDiscussionUnavailable');
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
      window.dispatchEvent(new Event(TEAM_ROOMS_CHANGED));
    }
  };
  const active = Boolean(room?.activeDiscussionId);
  const summaryUnsettled =
    !!summary && ['pending', 'running', 'unknown', 'stopping'].includes(summary.state);
  const pendingInputs = discussionPendingInputs(room);
  const queueContext =
    !!room &&
    (active ||
      summary?.state === 'pending' ||
      summary?.state === 'running' ||
      pendingInputs.length > 0);
  const queueAvailable = discussionQueueAvailable(room, summary);
  const canSubmit =
    (!active || queueContext) &&
    !(
      busy ||
      !!draft.submissionAttemptId ||
      !enabled ||
      !text.trim() ||
      (!room && (!cwd || members.length < 2)) ||
      (!draft.pending &&
        (queueContext ? !queueAvailable : summaryUnsettled || (!!room && room.state !== 'ready')))
    );
  const latestBatchHasMessages =
    !historyUnavailable && messages.some(message => message.discussionId === resultBatch);
  const send = (enqueue = false) =>
    run(async () => {
      if (!enabled) throw new Error('teamDiscussionDisabled');
      const current = getDiscussionDraft(draftId.current);
      if (current.pendingMode === 'enqueue' && current.pending) {
        // Checking an uncertain native append must not submit it a second time.
        await refresh(current.pending.roomId);
        return;
      }
      if (enqueue && !queueAvailable) throw new Error('teamDiscussionQueueUnavailable');
      if (!enqueue && summaryUnsettled && !current.pending) throw new Error('teamDiscussionBusy');
      if (!text.trim() || getDiscussionDraft(draftId.current).submissionAttemptId) return;
      // The lock is shared with any view remounted while preparation is in flight.
      const attemptId = crypto.randomUUID();
      updateDiscussionDraft(draftId.current, { submissionAttemptId: attemptId });
      try {
        // Mentions are structured chips. A typed mention cannot silently broadcast.
        if (hasUnboundDiscussionMention(text)) throw new Error('teamMentionUseSelector');
        let target = room;
        if (!target) {
          const created = await window.electron.teamDiscussion.create({
            id: draftId.current,
            title: title.trim() || text.trim().slice(0, 80),
            cwd,
            agentIds: members,
            rounds,
            permissionMode: permission,
            ...(entry.sourceSessionId ? { sourceSessionId: entry.sourceSessionId } : {}),
          });
          if (!created.success) throw new Error(created.error);
          target = created.value;
          setRoom(target);
        }
        if (
          selected.some(
            id => !target.members.some(member => member.agentId === id && !member.deleted),
          )
        )
          throw new Error('teamDiscussionInvalidInput');
        const candidate: TeamDiscussionSend = {
          roomId: target.id,
          requestId: getDiscussionDraft(draftId.current).pending?.requestId ?? crypto.randomUUID(),
          expectedRevision: target.revision,
          message: text,
          attachmentPaths: attachments,
          quotes: quotes.map(message => ({
            messageId: message.id,
            discussionId: message.discussionId,
          })),
          selectedAgentIds: selected,
          rounds,
        };
        // Keep the same id and payload until an uncertain submission is reconciled.
        const submitted = getDiscussionDraft(draftId.current).pending ?? candidate;
        updateDiscussionDraft(draftId.current, {
          pending: submitted,
          pendingMode: enqueue ? 'enqueue' : 'send',
        });
        const result = enqueue
          ? await window.electron.teamDiscussion.enqueue(submitted)
          : await window.electron.teamDiscussion.send(submitted);
        if (!result.success) {
          if (result.error !== 'teamDiscussionOutcomeUnknown')
            settleDiscussionDraft(draftId.current, submitted.requestId, false);
          await refresh(target.id);
          throw new Error(result.error);
        }
        if (enqueue) {
          const receipt = result.value.pendingInputs?.find(
            input => input.requestId === submitted.requestId,
          );
          if (receipt && discussionPendingAccepted(receipt))
            settleDiscussionDraft(draftId.current, submitted.requestId, true);
          else if (receipt?.state === 'cancelled' || receipt?.state === 'failed')
            settleDiscussionDraft(draftId.current, submitted.requestId, false);
          // No saved receipt means the original identity remains frozen for read-only reconciliation.
        } else settleDiscussionDraftFromRun(draftId.current, result.value.latestRun);
        if (!alive.current) return;
        setRoom(result.value);
        await refresh(target.id);
      } finally {
        if (getDiscussionDraft(draftId.current).submissionAttemptId === attemptId)
          updateDiscussionDraft(draftId.current, { submissionAttemptId: undefined });
      }
    });
  const exportHistory = () =>
    run(async () => {
      let all = [...messages];
      let cursor = previousCursor;
      while (cursor) {
        const result = await window.electron.teamDiscussion.read(room!.id, cursor);
        if (!result.success || result.value.historyUnavailable)
          throw new Error('teamDiscussionUnavailable');
        all = [
          ...result.value.messages,
          ...all.filter(message => !result.value.messages.some(older => older.id === message.id)),
        ];
        cursor = result.value.previousCursor;
      }
      const body = all
        .map(message =>
          formatDiscussionExportMessage(
            message,
            message.role === 'user'
              ? t('teamYou')
              : (room?.members.find(member => member.agentId === message.agentId)?.name ??
                  message.agentId ??
                  ''),
          ),
        )
        .join('\n\n');
      const url = URL.createObjectURL(
        new Blob([`# ${room?.title}\n\n${body}`], { type: 'text/markdown;charset=utf-8' }),
      );
      const link = ownerDocument.createElement('a');
      link.href = url;
      link.download = `agent-team-${room?.id}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  const prepareSummary = () =>
    run(async () => {
      if (!room || !resultBatch || !onPrepareSourceDraft) return;
      const batch = resultBatch;
      const result = await window.electron.teamDiscussion.read(room.id, undefined, [batch]);
      if (!result.success) throw new Error(result.error);
      if (
        result.value.historyUnavailable ||
        !result.value.messages.some(message => message.discussionId === batch)
      )
        throw new Error('teamDiscussionHistoryUnavailable');
      const source = result.value.organizer;
      if (
        !source ||
        !result.value.runs?.some(
          item =>
            item.discussionId === batch &&
            ['completed', 'failed', 'cancelled'].includes(item.state),
        )
      )
        throw new Error('teamDiscussionNotFound');
      if (!alive.current) return;
      await onPrepareSourceDraft(source.sourceSessionId, buildTeamResultDraft(room.id, batch));
    });
  const referenceAction = room && (
    <button
      type="button"
      className={`${headerButton} text-primary hover:bg-primary/10`}
      aria-label={t(room.sourceSessionId ? 'teamReferenceInSource' : 'teamReferenceInNewTask')}
      title={t(
        room.sourceSessionId && !organizer
          ? 'teamDiscussionNotFound'
          : room.sourceSessionId
            ? 'teamReferenceInSource'
            : 'teamReferenceInNewTask',
      )}
      disabled={
        active ||
        busy ||
        !resultBatch ||
        !latestBatchHasMessages ||
        (!!room.sourceSessionId && (!organizer || !onReferenceSource))
      }
      onClick={() =>
        void run(async () => {
          if (!resultBatch || !latestBatchHasMessages) return;
          const quote = buildDiscussionReference(room.id, resultBatch, room.title);
          if (room.sourceSessionId) {
            if (!organizer || !onReferenceSource) throw new Error('teamDiscussionNotFound');
            await onReferenceSource(organizer.sourceSessionId, quote);
            return;
          }
          const result = await window.electron.teamDiscussion.createTask({
            roomId: room.id,
            requestId: taskRequestId.current,
          });
          if (!result.success) throw new Error(result.error);
          if (!alive.current) return;
          store.dispatch(addDraftMessageQuote({ draftKey: result.value, quote }));
          if (!(await coworkService.loadSession(result.value, { canSelect: () => alive.current })))
            throw new Error('teamDiscussionNotFound');
          if (!alive.current) return;
          onClose();
        })
      }
    >
      <ArrowUturnLeftIcon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
  const canStop = !!room && (active || summaryUnsettled || pendingInputs.length > 0);
  const stopAction = canStop && (
    <button
      type="button"
      className={`${headerButton} text-red-500 hover:text-red-600`}
      aria-label={t(active || pendingInputs.length ? 'teamStop' : 'teamStopSummary')}
      title={t(active || pendingInputs.length ? 'teamStop' : 'teamStopSummary')}
      disabled={busy}
      onClick={() =>
        void run(async () => {
          const requestId = getDiscussionDraft(draftId.current).pending?.requestId;
          const result = await window.electron.teamDiscussion.stop(room!.id);
          if (!result.success) throw new Error(result.error);
          if (requestId) settleDiscussionDraft(draftId.current, requestId, false);
          if (alive.current) setRoom(result.value);
          await refresh(result.value.id);
        })
      }
    >
      <StopIcon className="h-4 w-4" aria-hidden="true" />
    </button>
  );
  const nativeMember = room?.members.find(
    member => member.agentId === detailAgentId && member.sessionId && !member.deleted,
  );
  const detailMember =
    nativeMember && room && !detailIsOrganizer
      ? { ...nativeMember, sessionKey: discussionMemberSessionKey(room, nativeMember.agentId) }
      : sourceSession && detailAgentId && (sourceSession.agentId ?? 'main') === detailAgentId
        ? {
            agentId: sourceSession.agentId ?? 'main',
            sessionId: sourceSession.id,
            sessionKey: buildCoworkSessionKey(sourceSession.id, sourceSession.agentId),
            name:
              agents.find(agent => agent.id === sourceSession.agentId)?.name ??
              sourceSession.agentId ??
              'main',
          }
        : undefined;
  const speakingAgents = room ? discussionRunningAgents(room, resultBatch, executions) : [];
  const questionAgents = room ? discussionQuestionAgents(room, pendingInteractions) : [];
  const memberNames = (ids: readonly string[]) =>
    ids.map(id => room?.members.find(member => member.agentId === id)?.name ?? id).join(', ');
  const status = active ? room!.state : lastState || room?.state;
  const statusHint = speakingAgents.length
    ? `${t('teamSpeaking')}: ${memberNames(speakingAgents)}`
    : t(
        status === TeamDiscussionState.INTERRUPTED || status === 'failed'
          ? `teamState_${status}`
          : status && statusLabels[status]
            ? statusLabels[status]
            : 'teamRecordReady',
      );
  const summaryVisible = !active && summary && summary.state !== 'delivered';
  const headerStatus = questionAgents.length
    ? `${t('teamNeedsResponse')}: ${memberNames(questionAgents)}`
    : t(
        summaryVisible
          ? `teamSummaryLabel_${summary.state}`
          : status && statusLabels[status]
            ? statusLabels[status]
            : 'teamRecordReady',
      );
  const headerStatusHint = questionAgents.length
    ? `${headerStatus} · ${t('teamNeedsResponseHelp')}`
    : summaryVisible
      ? t(`teamSummary_${summary.state}`)
      : statusHint;
  const statusWarning =
    questionAgents.length > 0 ||
    status === 'failed' ||
    status === TeamDiscussionState.INTERRUPTED ||
    status === TeamDiscussionState.PREPARE_FAILED ||
    (summaryVisible && ['failed', 'unknown'].includes(summary.state));
  if (detailMember && room)
    return (
      <div className="flex h-full min-h-0 flex-col p-3">
        <div className="min-h-0 flex-1">
          <CollaborationMemberHistory
            member={{
              agentId: detailMember.agentId,
              sessionId: detailMember.sessionId!,
              sessionKey: detailMember.sessionKey,
            }}
            name={detailMember.name}
            backAction={{
              label: t('teamBackToDiscussion'),
              onClick: () => setDetailAgentId(undefined),
            }}
            headerAction={referenceAction}
            headerMenu={stopAction}
            workingDirectory={room.cwd}
            peerNames={Object.fromEntries(
              room.members.map(member => [member.agentId, member.name]),
            )}
            peerColors={Object.fromEntries(
              room.members.map((member, index) => [
                member.agentId,
                COLLABORATION_PALETTE[index % COLLABORATION_PALETTE.length].stroke,
              ]),
            )}
          />
        </div>
        {error && (
          <p role="alert" className="pt-2 text-sm text-red-500">
            {t(error)}
          </p>
        )}
      </div>
    );
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-foreground">
      <header className="flex min-h-10 min-w-0 shrink-0 items-center gap-1.5 border-b border-border-subtle bg-background px-3 py-1">
        {!embedded && (
          <button
            type="button"
            className={headerButton}
            aria-label={t('teamBack')}
            title={t('teamBack')}
            onClick={onClose}
          >
            <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold" title={room?.title ?? t('teamTitle')}>
            {room?.title ?? t('teamTitle')}
          </h1>
        </div>
        {room && (
          <>
            <span
              role="status"
              title={headerStatusHint}
              className={`max-w-24 shrink-0 truncate rounded-md px-1.5 py-0.5 text-[11px] ${statusWarning ? 'bg-warning/10 text-warning' : 'bg-surface-raised text-secondary'}`}
            >
              {headerStatus}
            </span>
            {referenceAction}
            <button
              type="button"
              className={`${headerButton} aria-expanded:bg-surface-raised aria-expanded:text-primary`}
              aria-label={t('teamMembers')}
              title={t('teamMembers')}
              aria-expanded={drawer}
              onClick={() => setDrawer(!drawer)}
            >
              <UserGroupIcon className="h-4 w-4" aria-hidden="true" />
            </button>
            {stopAction}
            {room.state === TeamDiscussionState.PREPARE_FAILED && (
              <button
                type="button"
                className={headerButton}
                aria-label={t('teamRetryPreparation')}
                title={t('teamRetryPreparation')}
                disabled={busy || !enabled}
                onClick={() =>
                  void run(async () => {
                    const result = await window.electron.teamDiscussion.create({
                      id: room.id,
                      title: room.title,
                      cwd: room.cwd,
                      agentIds: room.members.map(member => member.agentId),
                      rounds: room.rounds,
                      permissionMode: room.permissionMode,
                      readOnly: room.readOnly,
                      ...(room.sourceSessionId ? { sourceSessionId: room.sourceSessionId } : {}),
                    });
                    if (!result.success) throw new Error(result.error);
                    setRoom(result.value);
                  })
                }
              >
                <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
            <DiscussionActionsMenu
              compact
              onSettings={enabled ? () => setSettingsOpen(true) : undefined}
              onExport={() => void exportHistory()}
              onDelete={() => setConfirmDelete(true)}
              onSummarize={
                resultBatch &&
                ['completed', 'failed', 'cancelled'].includes(lastState) &&
                organizer &&
                onPrepareSourceDraft &&
                summary?.state !== 'delivered'
                  ? () => void prepareSummary()
                  : undefined
              }
              summarizeDisabled={
                !enabled || historyUnavailable || !latestBatchHasMessages || summaryUnsettled
              }
              exportDisabled={historyUnavailable}
              busy={busy}
            />
          </>
        )}
      </header>
      {enabled && room && settingsOpen && (
        <AgentTeamSettingsDialog
          key={room.id}
          team={{ kind: 'discussion', roomId: room.id }}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {extensionLoaded && !enabled && (
        <p className="border-b border-border p-3 text-sm" role="status">
          {t('teamDiscussionDisabled')}
        </p>
      )}
      {error && (
        <p role="alert" className="p-3 text-sm text-red-500">
          {t(error)}
        </p>
      )}
      {historyUnavailable && (
        <p role="status" className="px-4 text-sm text-secondary">
          {t('teamHistoryUnavailable')}
        </p>
      )}
      {confirmDelete && (
        <div
          className="flex items-center gap-3 border-b border-border p-4"
          role="alertdialog"
          aria-label={t('teamDelete')}
        >
          <p className="flex-1">{t('teamDeleteConfirm')}</p>
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await window.electron.teamDiscussion.delete(room!.id);
                if (!result.success) throw new Error(result.error);
                deleteDiscussionDraft(draftId.current);
                onClose();
              })
            }
          >
            {t('teamDelete')}
          </button>
          <button className={button} onClick={() => setConfirmDelete(false)}>
            {t('teamCancel')}
          </button>
        </div>
      )}
      {!room && !entry.roomId ? (
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-auto p-6">
          <div className="flex gap-2" role="group" aria-label={t('teamChooseMode')}>
            <button
              className={`${button} aria-pressed:bg-surface-raised aria-pressed:ring-2 aria-pressed:ring-primary`}
              aria-pressed={mode === 'task'}
              onClick={() => setMode('task')}
            >
              {t('teamTask')}
            </button>
            <button
              className={`${button} aria-pressed:bg-surface-raised aria-pressed:ring-2 aria-pressed:ring-primary`}
              aria-pressed={mode === 'group'}
              onClick={() => setMode('group')}
            >
              {t('teamGroup')}
            </button>
          </div>
          {mode === 'task' ? (
            <button className={button} onClick={onClose}>
              {t('teamContinueTask')}
            </button>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                {t('teamName')}
                <input
                  maxLength={120}
                  className={field}
                  value={title}
                  onChange={event => setTitle(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                {t('teamProject')}
                <div className="flex gap-2">
                  <input
                    className={`${field} flex-1`}
                    value={cwd}
                    onChange={event => setCwd(event.target.value)}
                  />
                  <button
                    className={button}
                    onClick={() =>
                      void window.electron.dialog.selectDirectory().then(result => {
                        if (result.success && result.path) setCwd(result.path);
                      })
                    }
                  >
                    {t('teamBrowse')}
                  </button>
                </div>
              </label>
              <fieldset>
                <legend>{t('teamMembers')}</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {agents.map(agent => (
                    <label key={agent.id} className={button}>
                      <input
                        type="checkbox"
                        checked={members.includes(agent.id)}
                        disabled={
                          !members.includes(agent.id) && members.length >= limits.maxMembers
                        }
                        onChange={() =>
                          setMembers(current =>
                            current.includes(agent.id)
                              ? current.filter(id => id !== agent.id)
                              : [...current, agent.id],
                          )
                        }
                      />{' '}
                      {agent.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              {entry.sourceSessionId ? (
                <p className="text-sm text-secondary">{t('teamInheritSourceSettings')}</p>
              ) : (
                <label>
                  {t('teamPermission')}{' '}
                  <select
                    className={field}
                    value={permission}
                    onChange={event => setPermission(event.target.value as typeof permission)}
                  >
                    {(['ask', 'auto', 'full'] as const).map(value => (
                      <option key={value} value={value}>
                        {t(`teamPermission_${value}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          <div
            ref={timeline}
            className="min-w-0 flex-1 overflow-auto px-4 py-5"
            onScroll={() => {
              const node = timeline.current;
              if (node)
                atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            }}
          >
            <div className="mx-auto max-w-3xl space-y-6">
              {previousCursor && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const oldHeight = timeline.current?.scrollHeight ?? 0;
                      atBottom.current = false;
                      const result = await window.electron.teamDiscussion.read(
                        room!.id,
                        previousCursor,
                      );
                      if (!result.success || result.value.historyUnavailable)
                        throw new Error('teamDiscussionUnavailable');
                      setPreviousCursor(result.value.previousCursor);
                      setMessages(current => [
                        ...result.value.messages,
                        ...current.filter(
                          message => !result.value.messages.some(older => older.id === message.id),
                        ),
                      ]);
                      ownerWindow.requestAnimationFrame(() => {
                        if (timeline.current)
                          timeline.current.scrollTop += timeline.current.scrollHeight - oldHeight;
                      });
                    })
                  }
                >
                  {t('teamLoadEarlier')}
                </button>
              )}

              {messages.map(message => (
                <TeamDiscussionMessageRow
                  key={message.id}
                  message={message}
                  name={messageName(message)}
                  color={
                    COLLABORATION_PALETTE[
                      Math.max(
                        0,
                        room?.members.findIndex(member => member.agentId === message.agentId) ?? 0,
                      ) % COLLABORATION_PALETTE.length
                    ].stroke
                  }
                  onOpenAgent={
                    message.agentId &&
                    (sourceSession?.agentId === message.agentId ||
                      room?.members.some(
                        member =>
                          member.agentId === message.agentId && member.sessionId && !member.deleted,
                      ))
                      ? () => {
                          setDetailAgentId(message.agentId);
                          setDetailIsOrganizer(message.origin === 'organizer');
                        }
                      : undefined
                  }
                  quoteDisabled={
                    busy ||
                    draftLocked ||
                    (quotes.length >= 5 && !quotes.some(item => item.id === message.id))
                  }
                  onReply={
                    message.role === 'assistant' &&
                    message.agentId &&
                    room?.members.some(
                      member => member.agentId === message.agentId && !member.deleted,
                    )
                      ? () => {
                          const current = getDiscussionDraft(draftId.current);
                          const alreadyQuoted = current.quotes.some(item => item.id === message.id);
                          if (
                            current.pending ||
                            current.submissionAttemptId ||
                            (!alreadyQuoted && current.quotes.length >= 5)
                          )
                            return;
                          updateDiscussionDraft(draftId.current, {
                            selected: [message.agentId!],
                            quotes: alreadyQuoted
                              ? current.quotes
                              : [
                                  ...current.quotes,
                                  { id: message.id, discussionId: message.discussionId },
                                ],
                          });
                          composer.current?.focus();
                        }
                      : undefined
                  }
                  onQuote={() =>
                    setQuotes(current =>
                      current.some(item => item.id === message.id)
                        ? current
                        : [
                            ...current,
                            {
                              id: message.id,
                              discussionId: message.discussionId,
                            },
                          ].slice(0, 5),
                    )
                  }
                />
              ))}
            </div>
          </div>
          {drawer && room && (
            <TeamDiscussionMembersPanel
              members={room.members}
              executions={executions}
              onOpenAgent={agentId => {
                setDetailIsOrganizer(false);
                setDetailAgentId(agentId);
                setDrawer(false);
              }}
              onClose={() => setDrawer(false)}
              participation={
                room.summarySource &&
                !room.members.some(
                  member =>
                    member.agentId === room.summarySource?.agentId && member.ownership !== 'source',
                )
                  ? {
                      enabled: room.members.some(member => member.ownership === 'source'),
                      disabled: active || busy || draftLocked || !enabled,
                      onChange: enabled => {
                        void run(async () => {
                          const result = await window.electron.teamDiscussion.participation({
                            roomId: room.id,
                            expectedRevision: room.revision,
                            enabled,
                          });
                          if (!result.success) throw new Error(result.error);
                          setRoom(result.value);
                        });
                      },
                    }
                  : undefined
              }
            />
          )}
        </div>
      )}
      {(room || (!entry.roomId && mode === 'group')) && (
        <footer className="shrink-0 px-4 pb-4 pt-3">
          {room && limits.maxTurns < room.members.length && (
            <p role="status" className="mb-2 text-xs text-secondary">
              {t('agentTeamFirstRoundBudget')}
            </p>
          )}
          <div className="mx-auto max-w-3xl space-y-2">
            {pendingInputs.length > 0 && (
              <section
                className="rounded-xl border border-border text-xs"
                aria-label={t('teamPendingInputs')}
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-secondary hover:bg-surface-raised"
                  aria-expanded={queueExpanded}
                  onClick={() => setQueueExpanded(value => !value)}
                >
                  <span>
                    {t('teamPendingInputs')} · {pendingInputs.length}/{DISCUSSION_PENDING_LIMIT}
                  </span>
                  <span>{t(queueExpanded ? 'teamQueueCollapse' : 'teamQueueExpand')}</span>
                </button>
                {queueExpanded && (
                  <ol className="space-y-2 border-t border-border px-3 py-2">
                    {pendingInputs.map((input, index) => (
                      <li key={input.requestId} className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <p role="status">
                            {index + 1}. {t(`teamQueue_${input.state}`)}
                          </p>
                          <p className="truncate text-secondary">
                            {input.selectedAgentIds.length
                              ? input.selectedAgentIds
                                  .map(
                                    id =>
                                      room?.members.find(member => member.agentId === id)?.name ??
                                      id,
                                  )
                                  .join(', ')
                              : t('teamQueueAllMembers')}
                            {' · '}
                            {t('teamRounds')}: {input.rounds}
                          </p>
                          {input.message !== undefined ? (
                            <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-raised px-2 py-1 text-foreground">
                              {input.message}
                            </p>
                          ) : (
                            <p className="mt-1 text-secondary">
                              {t('teamQueuePreviewUnavailable')}
                            </p>
                          )}
                          {input.reason && <p className="text-warning">{t(input.reason)}</p>}
                        </div>
                        {discussionPendingCancellable(input) && (
                          <button
                            type="button"
                            disabled={busy}
                            className="rounded-lg px-2 py-1 text-secondary hover:bg-surface-raised disabled:opacity-40"
                            aria-label={`${t('teamQueueCancel')} ${index + 1}`}
                            onClick={() =>
                              void run(async () => {
                                const result = await window.electron.teamDiscussion.cancelPending({
                                  roomId: room!.id,
                                  requestId: input.requestId,
                                });
                                if (!result.success) throw new Error(result.error);
                                if (alive.current) setRoom(result.value);
                                await refresh(result.value.id);
                              })
                            }
                          >
                            {t('teamCancel')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            )}
            {quotes.length > 0 && (
              <ul
                aria-label={t('messageQuoteLabel')}
                className="max-h-52 min-w-0 space-y-2 overflow-y-auto"
              >
                {quotes.map(quote => {
                  const message = messages.find(
                    item => item.id === quote.id && item.discussionId === quote.discussionId,
                  );
                  return (
                    <li key={quote.id}>
                      <TeamDiscussionQuoteCard
                        message={message}
                        name={message ? messageName(message) : undefined}
                        disabled={busy || draftLocked}
                        onRemove={() =>
                          setQuotes(current => current.filter(item => item.id !== quote.id))
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {attachments.map(file => (
                  <button
                    key={file}
                    className={button}
                    disabled={busy || draftLocked}
                    onClick={() => setAttachments(current => current.filter(item => item !== file))}
                  >
                    {file.split(/[\\/]/).pop()} ×
                  </button>
                ))}
              </div>
            )}
            <div className={COMPOSER_FRAME_CLASS}>
              <div className={COMPOSER_SURFACE_CLASS}>
                <DiscussionMentionInput
                  ref={composer}
                  value={text}
                  onChange={changeText}
                  onSubmit={() => {
                    if (canSubmit) void send(queueContext && !draft.pending);
                  }}
                  members={
                    room?.members ??
                    agents
                      .filter(agent => members.includes(agent.id))
                      .map(agent => ({ agentId: agent.id, name: agent.name }))
                  }
                  selected={selected}
                  onSelected={setSelected}
                  disabled={busy || draftLocked}
                  recipientsDisabled={false}
                  className={`${COMPOSER_TEXTAREA_CLASS} block`}
                />
                <div className="flex flex-wrap items-center gap-1 px-3 pb-2 pt-1.5">
                  <button
                    type="button"
                    aria-label={t('coworkAddFile')}
                    title={t('coworkAddFile')}
                    className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised disabled:opacity-40"
                    disabled={busy || draftLocked}
                    onClick={() => {
                      const epoch = getDiscussionDraft(draftId.current).inputEpoch;
                      void window.electron.dialog
                        .selectFiles({ title: t('coworkAddFile') })
                        .then(result => {
                          const current = getDiscussionDraft(draftId.current);
                          if (
                            alive.current &&
                            !current.pending &&
                            !current.submissionAttemptId &&
                            current.inputEpoch === epoch &&
                            result.success
                          )
                            setAttachments(current =>
                              [...new Set([...current, ...result.paths])].slice(0, 12),
                            );
                        });
                    }}
                  >
                    <PaperClipIcon className="h-4 w-4" />
                  </button>
                  <LocalSpeechInputButton
                    key={`${draftId.current}:${draft.inputEpoch}`}
                    disabled={busy || draftLocked}
                    onTranscript={insertSpeechTranscript}
                  />
                  <label className="ml-auto flex items-center gap-1.5 text-xs text-secondary">
                    {t('teamRounds')}
                    <select
                      className="h-7 rounded-lg border-0 bg-transparent px-1 py-1 text-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
                      value={rounds}
                      disabled={busy || draftLocked}
                      onChange={event => setRounds(Number(event.target.value))}
                    >
                      {Array.from({ length: limits.maxRounds }, (_, index) => index + 1)
                        .concat(rounds > limits.maxRounds ? [rounds] : [])
                        .map(value => (
                          <option key={value} disabled={value > limits.maxRounds}>
                            {value}
                          </option>
                        ))}
                    </select>
                  </label>
                  {(!active || queueContext) && (
                    <RunControlButton
                      isRunning={false}
                      isStopping={false}
                      size="normal"
                      sendLabel={t(
                        draft.pending ? 'teamRetry' : queueContext ? 'teamEnqueue' : 'teamSend',
                      )}
                      sendTitle={t(
                        draft.pending ? 'teamRetry' : queueContext ? 'teamEnqueue' : 'teamSend',
                      )}
                      canSubmit={canSubmit}
                      onSend={() => void send(queueContext && !draft.pending)}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
