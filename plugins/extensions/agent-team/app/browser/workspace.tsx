import { useLayoutEffect, useState } from 'react';
import type { AppNativeHistoryState, AppViewContext } from '@app-plugin/sdk/browser';
import { UserGroupIcon } from '@heroicons/react/24/outline';
import type {
  CollaborationRoom,
  CollaborationMember,
  CollaborationDelivery,
} from '../../contracts/collaboration';
import type { CollaborationContinueRequest } from '../../browser/collaboration/collaborationContinueDraft';

import AgentTeamPanel from './display/AgentTeamPanel';
import { buildAgentTeamEntries } from './display/agentTeamEntries';
import { useCollaborationRooms } from './collaboration/CollaborationPanel';
import { useTeamDiscussionRooms } from './discussions/teamDiscussionNavigation';
import { submitCollaborationContinuation } from './collaboration/collaborationContinueSubmission';
import { application, browserHost, teamApi } from './ports';
import { useSelector } from './state';

export function TeamWorkspace(context: AppViewContext) {
  const host = browserHost();
  const source = useSelector(state => state.cowork.currentSession);
  const [memberId, selectMember] = useState<string>();
  const selection = context.selection as
    | {
        key?: string;
        version?: number;
        memberSessionId?: string;
      }
    | undefined;
  useLayoutEffect(() => {
    selectMember(selection?.memberSessionId);
  }, [selection?.memberSessionId, context.selectionRevision]);
  if (!source || source.id !== context.session?.id) return null;
  const continuePeer = async (
    room: CollaborationRoom,
    member: CollaborationMember,
    delivery: CollaborationDelivery | undefined,
    input: CollaborationContinueRequest,
    memberSession: AppNativeHistoryState,
  ) => {
    const submit = context.submitUserTurn;
    if (!submit) return 'rejected' as const;
    const assertCurrent = () => {
      if (host.signal.aborted) throw new Error('collaborationContinuationUnavailable');
      submit.assertReady();
      const current = memberSession.readCurrent ? memberSession.readCurrent() : memberSession;
      if (
        !current?.connected ||
        current.sessionKey !== member.sessionKey ||
        !current.nativeSessionId ||
        current.nativeSessionId !== memberSession.nativeSessionId ||
        !memberSession.send
      )
        throw new Error('collaborationContinuationUnavailable');
    };
    const nativeSessionId = memberSession.nativeSessionId;
    const prepare = (expectedControlGeneration?: string) =>
      teamApi.collaboration.prepareContinuation({
        sourceSessionId: source.id,
        roomId: room.id,
        targetSessionKey: member.sessionKey,
        nativeSessionId: nativeSessionId!,
        ...(expectedControlGeneration === undefined ? {} : { expectedControlGeneration }),
        ...(delivery ? { priorDeliveryId: delivery.id } : {}),
      });
    try {
      assertCurrent();
      if (!memberSession.ready) throw new Error('collaborationContinuationUnavailable');
      const prepared = await prepare();
      assertCurrent();
      if (!prepared.success) throw new Error(prepared.error);
      if (
        prepared.value.sourceSessionId !== source.id ||
        prepared.value.targetSessionId !== member.sessionId ||
        prepared.value.targetSessionKey !== member.sessionKey ||
        prepared.value.sourceAgentId !== source.agentId
      )
        throw new Error('collaborationInvalidRecipient');
      return await submitCollaborationContinuation(input, {
        target: prepared.value,
        cwd: source.cwd,
        assertCurrent,
        supportsImages: () => memberSession.supportsImages?.() === true,
        stageAudio: application.stageAudio,
        readImage: application.files.readFileAsDataUrl,
        beforeSubmit: async () => {
          const result = await prepare(prepared.value.controlGeneration);
          assertCurrent();
          if (!result.success || JSON.stringify(result.value) !== JSON.stringify(prepared.value))
            throw new Error('collaborationInvalidRecipient');
        },
        submit: async (_target, message, images, clientTurnId) => {
          const status = await memberSession.send!({
            message,
            images,
            clientTurnId,
            assertCurrent,
            beforeSend: async () => {
              const result = await prepare(prepared.value.controlGeneration);
              assertCurrent();
              if (
                !result.success ||
                JSON.stringify(result.value) !== JSON.stringify(prepared.value)
              )
                throw new Error('collaborationInvalidRecipient');
            },
          });
          return status === 'accepted' ? 'target_accepted' : status;
        },
      });
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: host.t(
            error instanceof Error ? error.message : 'collaborationContinuationUnavailable',
          ),
        }),
      );
      return 'rejected' as const;
    }
  };
  return (
    <AgentTeamPanel
      active={context.active}
      source={source}
      selectedMemberId={memberId}
      onSelect={selectMember}
      selectionRequest={{
        key: selection?.key,
        version: context.selectionRevision ?? selection?.version ?? 0,
      }}
      onOpenSubtask={context.onOpenSubtask}
      onRequestContinue={continuePeer}
      onFocusComposer={context.draft?.focus}
    />
  );
}
export function TeamSummary({ session, onClose }: AppViewContext) {
  const host = browserHost();
  const collaborations = useCollaborationRooms();
  const discussions = useTeamDiscussionRooms();
  const entries = session
    ? buildAgentTeamEntries(session.id, collaborations, discussions, host.t)
    : [];
  if (!session || !entries.length) return null;
  const counts = [
    ['task', 'teamSummaryTaskCount'],
    ['group', 'teamSummaryGroupCount'],
  ].flatMap(([kind, label]) => {
    const count = entries.filter(entry => entry.kind === kind).length;
    return count ? [host.t(label).replace('{count}', String(count))] : [];
  });
  const countLabel = counts.join(host.t('teamSummaryCountSeparator'));
  return (
    <div className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        className="session-summary-panel__action flex w-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={[host.t('teamTitle'), countLabel].filter(Boolean).join(' ')}
        onClick={() => {
          onClose?.();
          host.openWorkspace('team', session.id);
        }}
      >
        <UserGroupIcon className="h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
        <span className="shrink-0">{host.t('teamTitle')}</span>
        {countLabel && (
          <span className="min-w-0 flex-1 text-right text-xs text-secondary tabular-nums">
            {countLabel}
          </span>
        )}
      </button>
    </div>
  );
}
