import type { AppMainHost, AppMainRegistration } from '@app-plugin/sdk/main';

import { recognizeAgentTeamMode } from '../prompt/agentTeamPrompt';
import { CollaborationGateway } from '../contracts/collaboration';
import { settingsRecord, type AgentTeamKind } from '../contracts/agentTeamSettings';
import { CollaborationCoordinator } from './collaboration/collaborationCoordinator';
import { CollaborationStore, initializeCollaborationTables } from './data/collaborationStore';
import { initializeTeamDiscussionTables, TeamDiscussionStore } from './data/teamDiscussionStore';
import { AgentTeamSettingsService } from './data/agentTeamSettingsService';
import { TeamDiscussionCoordinator } from './discussion/teamDiscussionCoordinator';
import { AgentTeamLaunchCoordinator } from './launch/agentTeamLaunchCoordinator';
import { TEAM_DISCUSSION_CHANNEL } from '../contracts/teamDiscussion';
import { allowTeamCleanupGatewayRequest, TEAM_CLEANUP_GATEWAY_METHODS } from './cleanupGateway';

/** App entry only. Never import this module from the native registration. */
export function register(host: AppMainHost): AppMainRegistration {
  let collaboration: CollaborationCoordinator | undefined;
  let discussion: TeamDiscussionCoordinator | undefined;
  let launch: AgentTeamLaunchCoordinator | undefined;
  const getLaunch = () =>
    (launch ??= new AgentTeamLaunchCoordinator({
      getStore: host.getSessions,
      getDatabase: host.getDatabase,
      getRouter: host.getExecution,
      requestGateway: host.requestGateway,
    }));
  const getDiscussion = () =>
    (discussion ??= new TeamDiscussionCoordinator({
      isExtensionEnabled: host.isEnabled,
      isSourceDeleting: id => getCollaboration().isSourceDeleting(id),
      getDatabase: host.getDatabase,
      getStore: host.getSessions,
      ensureReady: host.ensureReady,
      requestGateway: host.requestGateway,
      requestConnectedGateway: host.requestConnectedGateway,
      onChanged: host.sessionsChanged,
    }));
  const getCollaboration = (): CollaborationCoordinator =>
    (collaboration ??= new CollaborationCoordinator({
      getStore: host.getSessions,
      getDatabase: host.getDatabase,
      getRouter: host.getExecution,
      getRuntime: host.getRuntime,
      requestGateway: host.requestGateway,
      onExecution: payload => getLaunch().observeExecution(payload),
      onLaunchAccepted: receipt => getLaunch().confirm(receipt),
      stopDiscussions: (id, settled) => getDiscussion().stopForSource(id, settled),
      discussion: (id, input, identity, assertActive) =>
        getDiscussion().fromAgent(id, input, identity, assertActive),
      createAssistant: host.createAssistant,
      onSessionsChanged: host.sessionsChanged,
    }));
  const settings = () => new AgentTeamSettingsService(host.getDatabase());
  const roomStore = () => new CollaborationStore(host.getDatabase());
  const protectedResources = () => [
    ...new Set([
      ...roomStore()
        .listRooms()
        .flatMap(room => room.members.map(member => member.sessionId)),
      ...new TeamDiscussionStore(host.getDatabase())
        .list()
        .map(room => room.sourceSessionId)
        .filter((id): id is string => !!id),
      ...getLaunch().protectedSessionIds(),
    ]),
  ];
  const result =
    (operation: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      try {
        return { success: true, value: await operation(...args) };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'teamDiscussionUnavailable',
        };
      }
    };
  const sessionId = (value: unknown): string => {
    if (typeof value !== 'string' || !value) throw new Error('collaborationInvalidMembers');
    return value;
  };
  let creating: Promise<unknown> = Promise.resolve();
  const commands: AppMainRegistration['commands'] = [
    { id: 'collaboration.list', invoke: result(() => roomStore().listRoomEntries()) },
    { id: 'collaboration.read', invoke: result(id => getCollaboration().read(sessionId(id))) },
    {
      id: 'collaboration.continue',
      invoke: result(input => getCollaboration().prepareContinuation(input)),
    },
    {
      id: 'collaboration.messages',
      invoke: result(input => {
        const value = input as { sessionId?: unknown; deliveryIds?: unknown } | undefined;
        if (!value || typeof value.sessionId !== 'string' || !Array.isArray(value.deliveryIds))
          throw new Error('collaborationInvalidMessage');
        return getCollaboration().readMessages(value.sessionId, value.deliveryIds);
      }),
    },
    {
      id: 'collaboration.create',
      invoke: input => {
        const next = creating
          .catch(() => undefined)
          .then(
            result(() => {
              const value = input as { sessionId?: unknown; agentIds?: unknown } | undefined;
              if (!value || typeof value.sessionId !== 'string' || !Array.isArray(value.agentIds))
                throw new Error('collaborationInvalidMembers');
              return getCollaboration().create(value.sessionId, value.agentIds);
            }),
          );
        creating = next;
        return next;
      },
    },
    { id: 'collaboration.stop', invoke: result(id => getCollaboration().stop(sessionId(id))) },
    {
      id: 'collaboration.stop-member',
      invoke: result(input => getCollaboration().stopMember(input)),
    },
    { id: 'discussion.list', invoke: result(() => getDiscussion().metadata.list()) },
    { id: 'discussion.create', invoke: result(input => getDiscussion().create(input)) },
    {
      id: 'discussion.read',
      invoke: result((id, before, exact) => getDiscussion().read(id, before, exact)),
    },
    { id: 'discussion.send', invoke: result(input => getDiscussion().send(input)) },
    { id: 'discussion.enqueue', invoke: result(input => getDiscussion().enqueue(input)) },
    { id: 'discussion.cancel', invoke: result(input => getDiscussion().cancelPending(input)) },
    { id: 'discussion.stop', invoke: result(id => getDiscussion().stop(id)) },
    { id: 'discussion.delete', invoke: result(id => getDiscussion().delete(id)) },
    { id: 'discussion.create-task', invoke: result(input => getDiscussion().createTask(input)) },
    {
      id: 'discussion.participation',
      invoke: result(input => getDiscussion().setParticipation(input)),
    },
    { id: 'settings.read', invoke: result(() => settings().read()) },
    {
      id: 'settings.save',
      invoke: result(input => {
        const value = settingsRecord(input, ['value', 'expectedRevision']);
        return settings().save(value.value, value.expectedRevision);
      }),
    },
    ...(['settings.read-team', 'settings.save-team'] as const).map(id => ({
      id,
      invoke: result(input => {
        const save = id === 'settings.save-team';
        const value = settingsRecord(
          input,
          save ? ['kind', 'roomId', 'value', 'expectedRevision'] : ['kind', 'roomId'],
        );
        if (
          !['collaboration', 'discussion'].includes(String(value.kind)) ||
          typeof value.roomId !== 'string'
        )
          throw new Error('agentTeamSettingsInvalid');
        return save
          ? settings().saveTeam(
              value.kind as AgentTeamKind,
              value.roomId,
              value.value,
              value.expectedRevision,
            )
          : settings().readTeam(value.kind as AgentTeamKind, value.roomId);
      }),
    })),
  ];
  const disposers: (() => void)[] = [];
  return {
    nativePolicy: {
      skills: ['agent-team'],
      sandboxTools: ['task_assistants', 'assistants_create', 'team_discussion'],
      surfaces: { [TEAM_DISCUSSION_CHANNEL]: { silentReply: { group: 'allow' } } },
    },
    commands,
    cleanupGatewayMethods: [...TEAM_CLEANUP_GATEWAY_METHODS],
    allowCleanupGatewayRequest: allowTeamCleanupGatewayRequest,
    schemas: [
      {
        id: 'team.metadata',
        initialize: db => {
          initializeCollaborationTables(db);
          initializeTeamDiscussionTables(db);
        },
      },
    ],
    submission: {
      matches: prompt => recognizeAgentTeamMode(prompt) !== undefined,
      register: input => {
        host.assertActive();
        return getLaunch().register({ ...input, assertCurrent: input.assertActive });
      },
      markSubmissionStarted: async (id, turn) => {
        host.assertActive();
        getLaunch().markSubmissionStarted(id, turn);
      },
      abortBeforeSend: (id, turn) => getLaunch().abortBeforeSend(id, turn),
      cancel: (id, turn) => getLaunch().cancel(id, turn),
      releaseIfSettled: id => getLaunch().releaseIfSettled(id),
    },
    resources: {
      protectedResources,
      adoptResources: previous => {
        // The current v1 stores/receipt decoder must recognize every retained resource.
        // Missing or unreadable identities do not constitute an adoption receipt.
        const recognized = new Set(protectedResources());
        return previous.resourceIds.every(
          id => recognized.has(id) || getLaunch().hasReadableReceipt(id),
        );
      },
      expandResources: ids => [
        ...new Set(
          ids.flatMap(id => [
            id,
            ...(roomStore()
              .getRoomForSession(id)
              ?.members.map(member => member.sessionId) ?? []),
          ]),
        ),
      ],
      acquireDeletion: ids => getCollaboration().acquireSourceDeletion(ids),
      isDeleting: id =>
        getCollaboration().isSourceDeleting(id) ||
        Boolean(getCollaboration().read(id).room?.deleting),
      isManaged: id => Boolean(getCollaboration().read(id).room),
      prepareDelete: async ids => {
        for (const id of ids) {
          await getDiscussion().stopForSource(id, true);
          await getLaunch().cancel(id);
          if (!(await getLaunch().releaseIfSettled(id))) {
            await host.getExecution().stopSession(id);
            if (!(await getLaunch().releaseIfSettled(id))) throw new Error('teamLaunchUnconfirmed');
          }
        }
      },
      deleteManaged: id => getCollaboration().deleteTask(id),
    },
    activate: () => {
      disposers.push(
        host.onExecutionReceipt(payload => getCollaboration().observeExecution(payload)),
      );
      disposers.push(
        host.onSessionStopped(id => {
          void getCollaboration()
            .stop(id)
            .catch(() => undefined);
        }),
      );
    },
    maintenance: () => {
      if (!host.isEnabled()) return getDiscussion().reconcile({ cleanupOnly: true });
    },
    onEnable: () => {
      getDiscussion().startReconciliation();
      const off = host.onNativeEvent(event => {
        if (event.event === CollaborationGateway.Requested)
          void getCollaboration()
            .handle(event.payload)
            .catch(() => undefined);
      });
      return () => {
        off();
        discussion?.dispose();
      };
    },
    beforeDisable: () => getDiscussion().cancelPendingForDisable(),
    beforePackageMutation: async () => {
      const metadata = new TeamDiscussionStore(host.getDatabase());
      if (
        metadata
          .list()
          .some(
            room =>
              room.activeDiscussionId ||
              metadata.queue.hasActive(room.id) ||
              metadata.hasUnsettledSummary(room.id) ||
              ['preparing', 'submitting', 'running', 'stopping', 'deleting'].includes(room.state),
          )
      )
        throw new Error('appPluginCleanupUnresolved');
      for (const id of protectedResources()) {
        const state = await host.getExecution().getSessionRuntimeStatus(id, {
          includeSubagents: true,
          forceRefresh: true,
          targeted: true,
        });
        if (
          !state.known ||
          state.running ||
          state.mainRunning ||
          state.subagentRunning ||
          !(await getLaunch().releaseIfSettled(id))
        )
          throw new Error('appPluginCleanupUnresolved');
      }
    },
    dispose: () => {
      disposers.splice(0).forEach(dispose => dispose());
      discussion?.dispose();
    },
  };
}
