import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { ipcMain } from 'electron';

import {
  effectiveDiscussionDefaults,
  resolveDiscussionResources,
} from '../../../../shared/cowork/agent-team/agentTeamSettings';
import {
  discussionMemberSessionKey,
  isTeamDiscussionId,
  parseTeamDiscussionAgentIds,
  parseTeamDiscussionIds,
  parseTeamDiscussionRounds,
  parseTeamDiscussionSend,
  type TeamDiscussionExecution,
  TeamDiscussionGateway,
  type TeamDiscussionHoldingIdentity,
  TeamDiscussionIpc,
  type TeamDiscussionMessage,
  type TeamDiscussionReadResult,
  type TeamDiscussionResult,
  type TeamDiscussionRoom,
  teamDiscussionSessionKey,
  type TeamDiscussionSource,
  TeamDiscussionState,
  type TeamDiscussionSummary,
} from '../../../../shared/cowork/agent-team/teamDiscussion';
import { toOpenClawSessionPermissionMode } from '../../../../shared/security/approvals';
import type { PendingInputRecord } from '../../../data/agent-team/teamDiscussionQueueStore';
import { TeamDiscussionStore } from '../../../data/agent-team/teamDiscussionStore';
import type { CoworkStore } from '../../../data/coworkStore';
import { buildManagedSessionKey } from '../../../openclaw/sessions/openclawSessionKeys';
import { AgentTeamSettingsService } from '../../../plugins/extensions/agentTeamSettingsService';
import {
  discussionAttachmentFingerprint,
  stageDiscussionAttachments,
} from './teamDiscussionAttachments';
import { TeamDiscussionQueueCoordinator } from './teamDiscussionQueue';

interface Dependencies {
  isExtensionEnabled?: () => boolean;
  isSourceDeleting?: (sessionId: string) => boolean;
  getDatabase: () => Database.Database;
  getStore: () => CoworkStore;
  ensureReady: () => Promise<unknown>;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  /** Background reads must never start or reconnect a Gateway. */
  requestConnectedGateway?: <T>(method: string, params?: unknown) => Promise<T>;
  onChanged: () => void;
}
interface NativeMember {
  agentId: string;
  sessionId: string;
  lifecycleRevision: string;
  sessionRoot: string;
  permissionMode: string;
}
interface NativeStatus {
  roomId?: string;
  discussionId?: string;
  state: 'unknown' | 'running' | 'completed' | 'failed' | 'cancelled';
  executions?: TeamDiscussionExecution[];
}
function inputRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('teamDiscussionInvalidInput');
  return input as Record<string, unknown>;
}

export class TeamDiscussionCoordinator {
  readonly metadata: TeamDiscussionStore;
  private readonly settings: AgentTeamSettingsService;
  private readonly preparing = new Map<string, Promise<TeamDiscussionRoom>>();
  private readonly deleting = new Map<string, Promise<void>>();
  private readonly stopping = new Map<string, number>();
  private disableDepth = 0;
  private admissionRevision = 0;
  private readonly queueCoordinator: TeamDiscussionQueueCoordinator;
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private reconciling = false;
  private reconcileOffset = 0;
  constructor(private readonly deps: Dependencies) {
    this.metadata = new TeamDiscussionStore(deps.getDatabase());
    this.settings = new AgentTeamSettingsService(deps.getDatabase());
    this.metadata.recoverInterrupted();
    this.queueCoordinator = new TeamDiscussionQueueCoordinator({
      metadata: this.metadata,
      queue: this.metadata.queue,
      room: id => this.room(id),
      assertEnabled: room => this.assertEnabled(room),
      admissionRevision: () => this.admissionRevision,
      sourcePolicy: room => {
        const source =
          room.sourceSessionId && this.deps.getStore().getSession(room.sourceSessionId);
        return source
          ? {
              id: source.id,
              agentId: source.agentId,
              cwd: source.cwd,
              permissionMode: source.permissionMode,
            }
          : null;
      },
      resources: (room, rounds) => {
        const preferences = this.settings.readTeam('discussion', room.id);
        if (room.members.length > preferences.global.value.discussion.maxMembers)
          throw new Error('teamDiscussionResourcesChanged');
        return resolveDiscussionResources(
          preferences.global,
          preferences.team.value,
          room.members.length,
          rounds,
        );
      },
      ensureReady: deps.ensureReady,
      requestGateway: deps.requestGateway,
      requestConnectedGateway: deps.requestConnectedGateway,
      send: (send, assertCurrent, input) => this.send(send, assertCurrent, undefined, input),
      onChanged: deps.onChanged,
    });
  }
  startReconciliation(): void {
    if (this.reconcileTimer || !this.deps.requestConnectedGateway) return;
    this.reconcileTimer = setInterval(() => void this.reconcile().catch(() => {}), 3000);
    this.reconcileTimer.unref();
    void this.reconcile().catch(() => {});
  }
  dispose(): void {
    clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
  }
  /** Explicit product disable revokes pending inputs before configuration mutation. */
  async cancelPendingForDisable(): Promise<() => void> {
    this.admissionRevision++;
    this.disableDepth++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.disableDepth--;
      }
    };
    try {
      const cancellations = this.metadata
        .list()
        .filter(room => this.metadata.queue.hasActive(room.id))
        .map(room => this.queueCoordinator.cancelAll(room.id));
      await Promise.all(cancellations);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  /** Receipt metadata only. Completion remains observable with every team panel closed. */
  async reconcile(): Promise<void> {
    if (this.reconciling || !this.deps.requestConnectedGateway) return;
    this.reconciling = true;
    try {
      const active = this.metadata.list().filter(room => room.activeDiscussionId);
      const offset = active.length ? this.reconcileOffset % active.length : 0;
      const batch = [...active.slice(offset), ...active.slice(0, offset)].slice(0, 16);
      this.reconcileOffset = offset + batch.length;
      for (const room of batch) {
        try {
          let status: NativeStatus;
          try {
            status = await this.deps.requestConnectedGateway<NativeStatus>(
              room.state === TeamDiscussionState.STOPPING
                ? TeamDiscussionGateway.Stop
                : TeamDiscussionGateway.Status,
              {
                roomId: room.id,
                discussionId: room.activeDiscussionId,
              },
            );
          } catch {
            status = await this.deps.requestConnectedGateway<NativeStatus>(
              TeamDiscussionGateway.OfflineControl,
              {
                operation: room.state === TeamDiscussionState.STOPPING ? 'stop' : 'status',
                roomId: room.id,
                discussionId: room.activeDiscussionId,
              },
            );
          }
          const current = this.metadata.get(room.id);
          if (
            !current ||
            current.generation !== room.generation ||
            current.activeDiscussionId !== room.activeDiscussionId
          )
            continue;
          this.applyStatus(current, status);
          if (this.metadata.get(room.id)?.state !== current.state) this.deps.onChanged();
        } catch {
          // Unknown/disconnected is not a terminal. Reconcile again without resending work.
        }
      }
      for (const pending of this.metadata.pendingSummaries()) {
        // Earlier native I/O may yield while Stop cancels a later outbox item.
        const current = this.metadata.summary(pending.discussionId);
        if (!current || !['pending', 'running', 'stopping', 'unknown'].includes(current.state))
          continue;
        const summary = { ...pending, ...current };
        const room = this.metadata.get(summary.roomId);
        const source =
          room?.sourceSessionId && this.deps.getStore().getSession(room.sourceSessionId);
        if (!room) continue;
        const cancel =
          summary.state === 'stopping' ||
          this.stopping.has(room.id) ||
          this.deleting.has(room.id) ||
          !room.summarySource ||
          !source ||
          source.agentId !== room.summarySource.agentId;
        try {
          const request = this.deps.requestConnectedGateway;
          const state = await request<{ state: TeamDiscussionSummary['state']; runId?: string }>(
            TeamDiscussionGateway.Summary,
            {
              operation: cancel ? 'stop' : summary.state === 'pending' ? 'start' : 'status',
              roomId: room.id,
              discussionId: summary.discussionId,
              ...(summary.state === 'pending' ? { room } : {}),
            },
          ).catch(async error => {
            if (!cancel && summary.state === 'pending') throw error;
            return request<{ state: TeamDiscussionSummary['state']; runId?: string }>(
              TeamDiscussionGateway.OfflineControl,
              {
                operation: cancel ? 'summary-stop' : 'summary-status',
                roomId: room.id,
                discussionId: summary.discussionId,
              },
            );
          });
          // Unknown admission never causes an automatic resend. Native receipt owns recovery.
          this.metadata.updateSummary(summary.discussionId, state.state, state.runId);
          if (state.state !== summary.state) this.deps.onChanged();
        } catch (error) {
          if (summary.state === 'pending') {
            const knownRejection =
              error instanceof Error &&
              /teamDiscussion(?:Disabled|SessionChanged|InvalidInput|RequestConflict|HistoryUnavailable|SourcePolicyUnsupported)/.test(
                error.message,
              );
            this.metadata.updateSummary(
              summary.discussionId,
              knownRejection ? 'failed' : 'unknown',
            );
            this.deps.onChanged();
          }
        } finally {
          this.metadata.recordSummaryAttempt(summary.discussionId);
        }
      }
      await this.queueCoordinator.reconcile();
    } finally {
      this.reconciling = false;
    }
  }
  /** Only invoked through the collaboration dispatcher after native call/run validation. */
  async fromAgent(
    sourceSessionId: string,
    inputValue: unknown,
    identity: string,
    assertActive: () => void,
  ): Promise<unknown> {
    assertActive();
    const input = inputRecord(inputValue);
    if (
      input.organizerParticipates !== undefined &&
      typeof input.organizerParticipates !== 'boolean'
    )
      throw new Error('teamDiscussionInvalidInput');
    const source = this.deps.getStore().getSession(sourceSessionId);
    if (!source || source.external) throw new Error('teamDiscussionInvalidInput');
    const requestId = createHash('sha256').update(identity).digest('hex');
    const assertCurrent = this.admissionGuard(
      input.action === 'create' ? requestId : undefined,
      sourceSessionId,
      assertActive,
    );
    let room: TeamDiscussionRoom;
    if (
      ['create', 'send'].includes(String(input.action)) &&
      (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 16000)
    )
      throw new Error('teamDiscussionInvalidInput');
    if (input.action === 'create') {
      let summarySource: TeamDiscussionSource | undefined =
        this.metadata.get(requestId)?.summarySource;
      if (!this.metadata.get(requestId)) {
        const sessionKey = buildManagedSessionKey(source.id, source.agentId);
        const description = await this.deps.requestGateway<{
          source?: { sessionId?: string; lifecycleRevision?: string };
        }>(TeamDiscussionGateway.Summary, { operation: 'source', sessionKey });
        assertCurrent();
        if (description.source?.sessionId && description.source.lifecycleRevision)
          summarySource = {
            agentId: source.agentId,
            sessionKey,
            sessionId: description.source.sessionId,
            lifecycleRevision: description.source.lifecycleRevision,
          };
        else throw new Error('teamDiscussionSessionChanged');
      }
      assertCurrent();
      // The caller cannot choose another project's path, source, or elevated permissions.
      room = await this.create(
        {
          id: requestId,
          title: input.title,
          agentIds: input.agentIds,
          rounds:
            input.rounds ??
            this.metadata.get(requestId)?.rounds ??
            this.settings.read().value.discussion.defaultRounds,
          cwd: source.cwd,
          permissionMode: source.permissionMode,
          readOnly: true,
          sourceSessionId,
        },
        summarySource,
        this.metadata.get(requestId)
          ? this.metadata.get(requestId)!.members.some(member => member.ownership === 'source')
          : input.organizerParticipates === undefined
            ? this.settings.read().value.discussion.organizerParticipates
            : input.organizerParticipates === true,
      );
      assertCurrent();
    } else {
      room = this.room(input.roomId);
      const linkedRead = input.action === 'read' && room.linkedTaskIds?.includes(sourceSessionId);
      if (room.sourceSessionId !== sourceSessionId && !linkedRead)
        throw new Error('teamDiscussionNotFound');
    }
    assertActive();
    if (input.action === 'read') return this.read(room.id, undefined, input.discussionIds);
    if (input.action === 'configure')
      return this.setParticipation({
        roomId: room.id,
        expectedRevision: room.revision,
        enabled: input.organizerParticipates,
      });
    if (input.action === 'stop') {
      await this.stop(room.id);
      return this.room(room.id);
    }
    if (!['create', 'send'].includes(String(input.action)))
      throw new Error('teamDiscussionInvalidInput');
    const result = await this.send(
      {
        roomId: room.id,
        requestId,
        expectedRevision: this.metadata.requestRevision(room.id, requestId) ?? room.revision,
        message: input.message,
        selectedAgentIds: input.selectedAgentIds ?? [],
        rounds:
          input.rounds ??
          (input.action === 'create' ? room.rounds : undefined) ??
          this.metadata.requestRounds(room.id, requestId) ??
          (this.metadata.requestRevision(room.id, requestId) !== undefined
            ? room.rounds
            : undefined) ??
          effectiveDiscussionDefaults(
            this.settings.read().value,
            this.settings.readTeam('discussion', room.id).team.value,
          ).defaultRounds,
      },
      assertActive,
      source.agentId,
    );
    return {
      roomId: result.id,
      title: result.title,
      state: result.state,
      members: result.members.map(({ agentId, name }) => ({ agentId, name })),
      accepted: true,
      discussionId: this.metadata.latestRun(result.id)?.discussionId,
    };
  }
  async stopForSource(sessionId: string, requireSettled = false): Promise<void> {
    const rooms = this.metadata.list().filter(room => room.sourceSessionId === sessionId);
    const results = await Promise.allSettled(rooms.map(room => this.stop(room.id)));
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
    if (requireSettled)
      for (const room of this.metadata.list().filter(room => room.sourceSessionId === sessionId))
        this.metadata.assertSettled(room.id);
  }
  private room(id: unknown): TeamDiscussionRoom {
    if (!isTeamDiscussionId(id)) throw new Error('teamDiscussionInvalidInput');
    const room = this.metadata.get(id);
    if (!room) throw new Error('teamDiscussionNotFound');
    return room;
  }
  private assertEnabled(room: TeamDiscussionRoom): void {
    if (this.stopping.has(room.id) || this.deleting.has(room.id))
      throw new Error('teamDiscussionBusy');
    this.assertSourceAdmission(room.sourceSessionId);
    if (
      room.members.some(member => member.ownership === 'source') &&
      (!room.sourceSessionId || !this.deps.getStore().getSession(room.sourceSessionId))
    )
      throw new Error('teamDiscussionSessionChanged');
    if (room.members.some(member => !this.deps.getStore().getAgent(member.agentId)?.enabled))
      throw new Error('teamDiscussionInvalidMembers');
  }
  private assertSourceAdmission(sessionId?: string): void {
    if (this.disableDepth > 0) throw new Error('teamDiscussionBusy');
    if (this.deps.isExtensionEnabled?.() === false) throw new Error('teamDiscussionDisabled');
    if (sessionId && !this.deps.getStore().getSession(sessionId))
      throw new Error('teamDiscussionSessionChanged');
    if (sessionId && this.deps.isSourceDeleting?.(sessionId)) throw new Error('teamDiscussionBusy');
  }
  /** Stop and explicit disable invalidate continuations even if the room is idle again. */
  private admissionGuard(
    roomId: string | undefined,
    sourceSessionId: string | undefined,
    assertActive: () => void = () => {},
  ): () => void {
    const revision = this.admissionRevision;
    const generation = roomId ? this.metadata.queue.generation(roomId) : undefined;
    const sourcePolicy = () => {
      const source = sourceSessionId && this.deps.getStore().getSession(sourceSessionId);
      return source
        ? JSON.stringify([source.id, source.agentId, source.cwd, source.permissionMode])
        : null;
    };
    const policy = sourcePolicy();
    return () => {
      assertActive();
      this.assertSourceAdmission(sourceSessionId);
      if (
        revision !== this.admissionRevision ||
        (roomId && generation !== this.metadata.queue.generation(roomId)) ||
        policy !== sourcePolicy()
      )
        throw new Error('teamDiscussionSessionChanged');
      if (roomId && (this.stopping.has(roomId) || this.deleting.has(roomId)))
        throw new Error('teamDiscussionBusy');
    };
  }
  async setParticipation(value: unknown): Promise<TeamDiscussionRoom> {
    const input = inputRecord(value);
    const room = this.room(input.roomId);
    const assertCurrent = this.admissionGuard(room.id, room.sourceSessionId);
    assertCurrent();
    if (typeof input.enabled !== 'boolean' || input.expectedRevision !== room.revision)
      throw new Error('teamDiscussionStaleRevision');
    if (
      room.state !== TeamDiscussionState.READY ||
      room.activeDiscussionId ||
      this.metadata.hasUnsettledSummary(room.id)
    )
      throw new Error('teamDiscussionBusy');
    const source = room.summarySource;
    if (
      !source ||
      room.readOnly === false ||
      !room.sourceSessionId ||
      (input.enabled && !this.deps.getStore().getSession(room.sourceSessionId))
    )
      throw new Error('teamDiscussionSessionChanged');
    const previous = room.members.find(member => member.agentId === source.agentId);
    if (previous && previous.ownership !== 'source')
      throw new Error('teamDiscussionLegacyOrganizer');
    if (!!previous === input.enabled) return room;
    const members = room.members.filter(member => member.ownership !== 'source');
    if (input.enabled)
      members.push({
        agentId: source.agentId,
        name: this.deps.getStore().getAgent(source.agentId)?.name ?? source.agentId,
        sessionId: source.sessionId,
        lifecycleRevision: source.lifecycleRevision,
        sessionKey: source.sessionKey,
        ownership: 'source',
      });
    parseTeamDiscussionAgentIds(
      members.map(member => member.agentId),
      2,
    );
    if (input.enabled && members.length > this.settings.read().value.discussion.maxMembers)
      throw new Error('agentTeamSettingsMembersExceeded');
    if (input.enabled) {
      await this.deps.ensureReady();
      const native = await this.deps.requestGateway<{ source?: TeamDiscussionSource }>(
        TeamDiscussionGateway.Summary,
        { operation: 'source', sessionKey: source.sessionKey },
      );
      if (
        native.source?.sessionId !== source.sessionId ||
        native.source.lifecycleRevision !== source.lifecycleRevision
      )
        throw new Error('teamDiscussionSessionChanged');
    }
    assertCurrent();
    if (input.enabled && members.length > this.settings.read().value.discussion.maxMembers)
      throw new Error('agentTeamSettingsMembersExceeded');
    this.metadata.updateMembers(room.id, room.revision, members);
    this.deps.onChanged();
    return this.room(room.id);
  }
  async create(
    value: unknown,
    summarySource?: TeamDiscussionSource,
    organizerParticipates = false,
  ): Promise<TeamDiscussionRoom> {
    const input = inputRecord(value);
    if (
      !isTeamDiscussionId(input.id) ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 120 ||
      typeof input.cwd !== 'string' ||
      !path.isAbsolute(input.cwd) ||
      (input.readOnly !== undefined && typeof input.readOnly !== 'boolean') ||
      !['ask', 'auto', 'full'].includes(String(input.permissionMode)) ||
      (input.sourceSessionId !== undefined &&
        (!isTeamDiscussionId(input.sourceSessionId) ||
          !this.deps.getStore().getSession(input.sourceSessionId)))
    )
      throw new Error('teamDiscussionInvalidInput');
    const sourceSessionId = input.sourceSessionId as string | undefined;
    const assertCurrent = this.admissionGuard(input.id, sourceSessionId);
    assertCurrent();
    input.cwd = await realpath(input.cwd as string);
    assertCurrent();
    const ids = parseTeamDiscussionAgentIds(
      input.agentIds,
      summarySource && organizerParticipates ? 1 : 2,
    );
    if (summarySource && organizerParticipates)
      parseTeamDiscussionAgentIds([...ids, summarySource.agentId], 2);
    const rounds = parseTeamDiscussionRounds(input.rounds);
    const id = input.id;
    const existing = this.metadata.get(id);
    if (!existing) {
      const limits = this.settings.read().value.discussion;
      if (ids.length + (summarySource && organizerParticipates ? 1 : 0) > limits.maxMembers)
        throw new Error('agentTeamSettingsMembersExceeded');
      if (rounds > limits.maxRounds) throw new Error('agentTeamSettingsRoundsExceeded');
    }
    if (!existing && summarySource && ids.includes(summarySource.agentId))
      throw new Error('teamDiscussionLegacyOrganizer');
    if (
      existing &&
      (existing.readOnly !== (input.readOnly !== false) ||
        existing.title !== input.title.trim() ||
        existing.sourceSessionId !== input.sourceSessionId ||
        existing.cwd !== input.cwd ||
        existing.permissionMode !== input.permissionMode ||
        existing.rounds !== rounds ||
        JSON.stringify(
          existing.members
            .filter(member => member.ownership !== 'source')
            .map(member => member.agentId),
        ) !== JSON.stringify(ids))
    )
      throw new Error('teamDiscussionRequestConflict');
    const pending = this.preparing.get(id);
    if (pending) return pending;
    if (existing?.state === TeamDiscussionState.READY) return existing;
    if (
      existing &&
      ![TeamDiscussionState.PREPARING, TeamDiscussionState.PREPARE_FAILED].includes(
        existing.state as 'preparing' | 'prepare_failed',
      )
    )
      throw new Error('teamDiscussionBusy');
    const create = async () => {
      if (!(await stat(input.cwd as string)).isDirectory())
        throw new Error('teamDiscussionInvalidInput');
      assertCurrent();
      const members = ids.map(agentId => {
        const agent = this.deps.getStore().getAgent(agentId);
        if (!agent?.enabled) throw new Error('teamDiscussionInvalidMembers');
        return { agentId, name: agent.name };
      });
      const sourceMember =
        summarySource && organizerParticipates
          ? [
              {
                agentId: summarySource.agentId,
                name:
                  this.deps.getStore().getAgent(summarySource.agentId)?.name ??
                  summarySource.agentId,
                sessionId: summarySource.sessionId,
                lifecycleRevision: summarySource.lifecycleRevision,
                sessionKey: summarySource.sessionKey,
                ownership: 'source' as const,
              },
            ]
          : [];
      if (!existing) {
        const limits = this.settings.read().value.discussion;
        if (members.length + sourceMember.length > limits.maxMembers)
          throw new Error('agentTeamSettingsMembersExceeded');
        if (rounds > limits.maxRounds) throw new Error('agentTeamSettingsRoundsExceeded');
        this.metadata.create({
          id,
          title: (input.title as string).trim(),
          members: [...members, ...sourceMember],
          ...(summarySource ? { summarySource } : {}),
          rounds,
          cwd: input.cwd as string,
          permissionMode: input.permissionMode as TeamDiscussionRoom['permissionMode'],
          revision: 1,
          generation: 0,
          state: TeamDiscussionState.PREPARING,
          readOnly: input.readOnly !== false,
          ...(input.sourceSessionId ? { sourceSessionId: input.sourceSessionId as string } : {}),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      try {
        await this.deps.ensureReady();
        assertCurrent();
        const prepared = await this.deps.requestGateway<{ members: NativeMember[] }>(
          TeamDiscussionGateway.Prepare,
          {
            roomId: id,
            agentIds: ids,
            cwd: input.cwd,
            permissionMode: input.permissionMode,
            readOnly: input.readOnly !== false,
          },
        );
        if (
          !Array.isArray(prepared.members) ||
          prepared.members.length !== ids.length ||
          ids.some(
            agentId =>
              prepared.members.filter(
                member =>
                  member.agentId === agentId &&
                  isTeamDiscussionId(member.sessionId) &&
                  typeof member.lifecycleRevision === 'string',
              ).length !== 1,
          )
        )
          throw new Error('teamDiscussionSessionChanged');
        assertCurrent();
        this.assertEnabled(this.room(id));
        this.metadata.updatePreparation(
          id,
          [
            ...members.map(member => {
              const native = prepared.members.find(item => item.agentId === member.agentId)!;
              return {
                ...member,
                sessionId: native.sessionId,
                lifecycleRevision: native.lifecycleRevision,
              };
            }),
            ...sourceMember,
          ],
          TeamDiscussionState.READY,
        );
        return this.room(id);
      } catch (error) {
        this.metadata.updatePreparation(
          id,
          this.room(id).members,
          TeamDiscussionState.PREPARE_FAILED,
        );
        throw error;
      } finally {
        this.deps.onChanged();
      }
    };
    const promise = create().finally(() => this.preparing.delete(id));
    this.preparing.set(id, promise);
    return promise;
  }
  private applyStatus(room: TeamDiscussionRoom, status: NativeStatus): void {
    if (
      !room.activeDiscussionId ||
      status.roomId !== room.id ||
      status.discussionId !== room.activeDiscussionId
    )
      return;
    for (const execution of status.executions ?? []) {
      if (
        execution.discussionId !== room.activeDiscussionId ||
        execution.sessionKey !== discussionMemberSessionKey(room, execution.agentId)
      )
        throw new Error('teamDiscussionSessionChanged');
      const member = room.members.find(item => item.agentId === execution.agentId);
      if (
        !member ||
        member.sessionId !== execution.sessionId ||
        member.lifecycleRevision !== execution.lifecycleRevision
      )
        throw new Error('teamDiscussionSessionChanged');
      this.metadata.recordExecution(execution);
    }
    if (status.state === 'unknown')
      this.metadata.markUncertain(room.id, room.activeDiscussionId, room.generation);
    else this.metadata.transition(room.id, room.activeDiscussionId, room.generation, status.state);
  }
  async send(
    value: unknown,
    assertActive: () => void = () => {},
    initiatorAgentId?: string,
    pendingInput?: PendingInputRecord,
  ): Promise<TeamDiscussionRoom> {
    const send = parseTeamDiscussionSend(value);
    const room = this.room(send.roomId);
    this.assertEnabled(room);
    if (this.metadata.requestRevision(room.id, send.requestId) !== undefined) {
      assertActive();
      // Fingerprint validation precedes mutable roster/default/native checks for known admissions.
      this.metadata.reserve(send, initiatorAgentId);
      return room;
    }
    const assertAdmission = this.admissionGuard(room.id, room.sourceSessionId, assertActive);
    const assertCurrent = () => {
      assertAdmission();
      this.assertEnabled(this.room(room.id));
    };
    const request = pendingInput ? this.deps.requestConnectedGateway : this.deps.requestGateway;
    if (!request) throw new Error('teamDiscussionUnavailable');
    if (!pendingInput) await this.deps.ensureReady();
    assertCurrent();
    const validation = await request<{ valid: boolean; error?: string }>(
      TeamDiscussionGateway.Validate,
      { room, send },
    );
    if (!validation.valid) throw new Error(validation.error || 'teamDiscussionInvalidInput');
    let nativeMessage = send.message;
    if (send.quotes?.length) {
      const ids = [...new Set(send.quotes.map(quote => quote.discussionId))];
      const known = new Set(this.metadata.runIds(room.id));
      if (ids.some(id => !known.has(id))) throw new Error('teamDiscussionInvalidInput');
      const history = await request<{ messages: TeamDiscussionMessage[] }>(
        TeamDiscussionGateway.History,
        {
          roomId: room.id,
          discussionIds: ids,
          members: room.members
            .filter(member => member.ownership !== 'source')
            .map(member => ({
              agentId: member.agentId,
              sessionId: member.sessionId,
              sessionKey: discussionMemberSessionKey(room, member.agentId),
            })),
        },
      );
      const quotes = send.quotes.map(quote => {
        const message = history.messages.find(
          item => item.id === quote.messageId && item.discussionId === quote.discussionId,
        );
        if (!message) throw new Error('teamDiscussionQuoteUnavailable');
        return `> [${message.role === 'user' ? (this.metadata.initiator(message.discussionId) ?? 'user') : message.agentId}]\n> ${message.text.replace(/\n/g, '\n> ')}`;
      });
      nativeMessage = `${send.message}\n\n${quotes.join('\n\n')}`;
      if (nativeMessage.length > 16000) throw new Error('teamDiscussionInvalidInput');
    }
    assertCurrent();
    const previous = this.metadata.resources(room.id, send.requestId);
    // Resolve only new admission parameters. Replays must keep their original resource snapshot.
    const preferences = this.settings.readTeam('discussion', room.id);
    const knownRequest = this.metadata.runs(room.id).some(run => run.requestId === send.requestId);
    if (!knownRequest && room.members.length > preferences.global.value.discussion.maxMembers)
      throw new Error('agentTeamSettingsMembersExceeded');
    const resources =
      previous ??
      pendingInput?.resources ??
      (knownRequest
        ? {
            settingsRevision: 0,
            maxRounds: 4,
            maxTurns: room.members.length * send.rounds,
            maxConcurrent: room.members.length,
          }
        : resolveDiscussionResources(
            preferences.global,
            preferences.team.value,
            room.members.length,
            send.rounds,
          ));
    const reservation = this.metadata.reserve(
      send,
      initiatorAgentId,
      resources,
      pendingInput?.requestId,
    );
    if (reservation.reused) return this.room(room.id);
    this.deps.onChanged();
    let admitted = false;
    try {
      const staged = await stageDiscussionAttachments(
        room.cwd,
        reservation.discussionId,
        send.attachmentPaths,
      );
      if (
        pendingInput &&
        (await discussionAttachmentFingerprint(staged)) !== pendingInput.attachmentFingerprint
      )
        throw new Error('teamDiscussionAttachmentChanged');
      assertCurrent();
      admitted = true;
      const status = await request<NativeStatus>(TeamDiscussionGateway.Start, {
        room,
        initiator: initiatorAgentId
          ? {
              kind: 'organizer',
              agentId: initiatorAgentId,
              name: this.deps.getStore().getAgent(initiatorAgentId)?.name || initiatorAgentId,
            }
          : { kind: 'user' },
        send: { ...send, message: nativeMessage, attachmentPaths: staged },
        discussionId: reservation.discussionId,
        resources,
        members: room.members.map(member => ({
          agentId: member.agentId,
          sessionId: member.sessionId,
          lifecycleRevision: member.lifecycleRevision,
          sessionRoot: room.cwd,
          permissionMode:
            room.readOnly !== false
              ? 'read-only'
              : toOpenClawSessionPermissionMode(room.permissionMode),
        })),
      });
      this.applyStatus(this.room(room.id), status);
    } catch (error) {
      if (!admitted) {
        const current = this.metadata.get(room.id);
        this.metadata.transition(
          room.id,
          reservation.discussionId,
          current?.activeDiscussionId === reservation.discussionId
            ? current.generation
            : reservation.generation,
          current?.state === TeamDiscussionState.STOPPING ? 'cancelled' : 'failed',
          // Native admission never happened, so no receipt or public result exists to summarize.
          { suppressSummary: true },
        );
        throw error;
      }
      // A lost response does not prove that native work was rejected. Keep the
      // occupied slot and original request id until a status read settles it.
      throw new Error('teamDiscussionOutcomeUnknown');
    }
    return this.room(room.id);
  }
  enqueue(value: unknown): Promise<TeamDiscussionRoom> {
    return this.queueCoordinator.enqueue(value);
  }
  cancelPending(value: unknown): Promise<TeamDiscussionRoom> {
    return this.queueCoordinator.cancel(value);
  }
  async read(
    id: unknown,
    beforeDiscussionId?: unknown,
    exactDiscussionIds?: unknown,
  ): Promise<TeamDiscussionReadResult> {
    let room = this.room(id);
    const exact =
      exactDiscussionIds === undefined ? undefined : parseTeamDiscussionIds(exactDiscussionIds);
    const known = new Set(this.metadata.runIds(room.id));
    if ((exact && beforeDiscussionId !== undefined) || exact?.some(batch => !known.has(batch)))
      throw new Error('teamDiscussionInvalidInput');
    const source = room.sourceSessionId
      ? this.deps.getStore().getSession(room.sourceSessionId)
      : undefined;
    const organizer =
      source && !source.external
        ? {
            agentId: source.agentId,
            name: this.deps.getStore().getAgent(source.agentId)?.name ?? source.agentId,
            sourceSessionId: source.id,
          }
        : undefined;
    try {
      await this.deps.ensureReady();
    } catch {
      return {
        room,
        organizer,
        messages: [],
        historyUnavailable: true,
        latestRun: this.metadata.latestRun(room.id),
        summary: this.metadata.summary(this.metadata.latestRun(room.id)?.discussionId ?? ''),
        executions: this.metadata.executions(this.metadata.latestRun(room.id)?.discussionId ?? ''),
      };
    }
    if (room.activeDiscussionId) {
      try {
        this.applyStatus(
          room,
          await this.deps.requestGateway<NativeStatus>(TeamDiscussionGateway.Status, {
            roomId: room.id,
            discussionId: room.activeDiscussionId,
          }),
        );
        room = this.room(id);
      } catch {
        try {
          this.applyStatus(
            room,
            await this.deps.requestGateway<NativeStatus>(TeamDiscussionGateway.OfflineControl, {
              operation: 'status',
              roomId: room.id,
              discussionId: room.activeDiscussionId,
            }),
          );
          room = this.room(id);
        } catch {
          /* Keep the active slot until a native owner confirms its outcome. */
        }
      }
    }
    room = await this.queueCoordinator.project(room);
    try {
      const allIds = this.metadata.runIds(room.id);
      const end =
        beforeDiscussionId === undefined
          ? allIds.length
          : allIds.indexOf(String(beforeDiscussionId));
      if (end < 0) throw new Error('teamDiscussionInvalidInput');
      const start = Math.max(0, end - 20);
      const discussionIds = exact ?? allIds.slice(start, end);
      const messages: TeamDiscussionMessage[] = [];
      for (let offset = 0; offset < discussionIds.length; offset += 100) {
        const result = await this.deps.requestGateway<{ messages: TeamDiscussionMessage[] }>(
          TeamDiscussionGateway.History,
          {
            roomId: room.id,
            discussionIds: discussionIds.slice(offset, offset + 100),
            members: [
              ...new Map(
                [
                  ...room.members
                    .filter(member => member.sessionId && member.ownership !== 'source')
                    .map(member => ({
                      agentId: member.agentId,
                      sessionId: member.sessionId,
                      sessionKey: discussionMemberSessionKey(room, member.agentId),
                    })),
                  ...discussionIds.flatMap(batch =>
                    this.metadata
                      .executions(batch)
                      .filter(execution => execution.sessionKey.includes(':justdo-team:'))
                      .map(execution => ({
                        agentId: execution.agentId,
                        sessionId: execution.sessionId,
                        sessionKey: execution.sessionKey,
                      })),
                  ),
                ].map(member => [`${member.agentId}:${member.sessionId}`, member]),
              ).values(),
            ],
          },
        );
        messages.push(
          ...result.messages.map(message => {
            const initiator = this.metadata.initiator(message.discussionId);
            return message.role === 'user' && initiator
              ? {
                  ...message,
                  role: 'assistant' as const,
                  agentId: initiator,
                  origin: 'organizer' as const,
                }
              : message;
          }),
        );
      }
      return {
        room,
        organizer,
        messages,
        discussionIds,
        runs: this.metadata.runs(room.id).filter(run => discussionIds.includes(run.discussionId)),
        ...(!exact && start > 0 ? { previousCursor: discussionIds[0] } : {}),
        historyUnavailable: false,
        latestRun: this.metadata.latestRun(room.id),
        summary: this.metadata.summary(this.metadata.latestRun(room.id)?.discussionId ?? ''),
        executions: this.metadata.executions(this.metadata.latestRun(room.id)?.discussionId ?? ''),
      };
    } catch {
      return {
        room,
        organizer,
        messages: [],
        historyUnavailable: true,
        latestRun: this.metadata.latestRun(room.id),
        summary: this.metadata.summary(this.metadata.latestRun(room.id)?.discussionId ?? ''),
        executions: this.metadata.executions(this.metadata.latestRun(room.id)?.discussionId ?? ''),
      };
    }
  }
  createTask(value: unknown): string {
    const input = inputRecord(value);
    const room = this.room(input.roomId);
    if (!isTeamDiscussionId(input.requestId) || room.state === TeamDiscussionState.DELETING)
      throw new Error('teamDiscussionInvalidInput');
    const sessionId = this.metadata.createTaskLink(
      room.id,
      input.requestId,
      () =>
        this.deps
          .getStore()
          .createSession(room.title, room.cwd, 'local', [], 'main', room.permissionMode).id,
    );
    this.deps.onChanged();
    return sessionId;
  }
  async stop(id: unknown): Promise<TeamDiscussionRoom> {
    const room = this.room(id);
    this.stopping.set(room.id, (this.stopping.get(room.id) ?? 0) + 1);
    const cancelPending = this.queueCoordinator.cancelAll(room.id);
    // Freeze active native admission synchronously, before awaiting any cleanup RPC.
    this.metadata.freeze(room.id);
    this.metadata.cancelSummaries(room.id);
    this.deps.onChanged();
    try {
      await cancelPending;
      return await this.stopNative(room.id);
    } finally {
      const remaining = this.stopping.get(room.id)! - 1;
      if (remaining > 0) this.stopping.set(room.id, remaining);
      else this.stopping.delete(room.id);
    }
  }
  private async stopNative(id: unknown): Promise<TeamDiscussionRoom> {
    const room = this.metadata.freeze(this.room(id).id);
    const cancelled = this.metadata.cancelSummaries(room.id);
    this.deps.onChanged();
    if (!room.activeDiscussionId && cancelled.length === 0) return room;
    await this.deps.ensureReady();
    let summaryError: unknown;
    for (const discussionId of cancelled) {
      try {
        const result = await this.deps
          .requestGateway<{ state: TeamDiscussionSummary['state']; runId?: string }>(
            TeamDiscussionGateway.Summary,
            { operation: 'stop', roomId: room.id, discussionId },
          )
          .catch(() =>
            this.deps.requestGateway<{ state: TeamDiscussionSummary['state']; runId?: string }>(
              TeamDiscussionGateway.OfflineControl,
              { operation: 'summary-stop', roomId: room.id, discussionId },
            ),
          );
        this.metadata.updateSummary(discussionId, result.state, result.runId);
      } catch (error) {
        summaryError = error;
      }
    }
    this.deps.onChanged();
    if (!room.activeDiscussionId) {
      if (summaryError) throw summaryError;
      return room;
    }
    const result = await this.deps
      .requestGateway<NativeStatus>(TeamDiscussionGateway.Stop, {
        roomId: room.id,
        discussionId: room.activeDiscussionId,
      })
      .catch(() =>
        this.deps.requestGateway<NativeStatus>(TeamDiscussionGateway.OfflineControl, {
          operation: 'stop',
          roomId: room.id,
          discussionId: room.activeDiscussionId,
        }),
      );
    this.applyStatus(room, result);
    this.deps.onChanged();
    if (summaryError) throw summaryError;
    return this.room(id);
  }
  async delete(id: unknown): Promise<void> {
    const room = this.room(id);
    const existing = this.deleting.get(room.id);
    if (existing) return existing;
    const remove = async () => {
      if (this.preparing.has(room.id)) throw new Error('teamDiscussionBusy');
      await this.stop(room.id);
      this.metadata.assertSettled(room.id);
      await this.deps.ensureReady();
      // Freeze native admission and wait for any preparation whose reply was lost.
      // Disabling the service is not evidence of native settlement. The guards
      // above and in beginDelete retain unresolved identities before any deletion.
      let nativeMembers: NativeMember[] | undefined;
      try {
        const closed = await this.deps.requestGateway<{ members: NativeMember[] }>(
          TeamDiscussionGateway.Close,
          {
            roomId: room.id,
            agentIds: room.members
              .filter(member => member.ownership !== 'source')
              .map(member => member.agentId),
          },
        );
        nativeMembers = closed.members;
        if (
          room.state === TeamDiscussionState.PREPARE_FAILED ||
          room.state === TeamDiscussionState.PREPARING
        ) {
          this.metadata.updatePreparation(
            room.id,
            room.members.map(member => {
              const native = nativeMembers?.find(item => item.agentId === member.agentId);
              return {
                ...member,
                ...(native?.sessionId
                  ? { sessionId: native.sessionId, lifecycleRevision: native.lifecycleRevision }
                  : {}),
              };
            }),
            TeamDiscussionState.PREPARE_FAILED,
          );
        }
      } catch {
        if (room.members.some(member => !member.sessionId))
          throw new Error('teamDiscussionUnavailable');
        await this.deps.requestGateway(TeamDiscussionGateway.OfflineControl, {
          operation: 'close',
          roomId: room.id,
        });
      }
      this.metadata.beginDelete(room.id);
      try {
        if (this.metadata.queue.list(room.id).length > 0) await this.deleteHolding(room.id);
        for (const member of this.room(room.id).members) {
          if (member.ownership === 'source') {
            this.metadata.markMemberDeleted(room.id, member.agentId);
            continue;
          }
          if (member.deleted) continue;
          if (
            !member.sessionId &&
            nativeMembers &&
            !nativeMembers.find(item => item.agentId === member.agentId)?.sessionId
          ) {
            this.metadata.markMemberDeleted(room.id, member.agentId);
            continue;
          }
          if (!member.sessionId) throw new Error('teamDiscussionSessionChanged');
          const key = teamDiscussionSessionKey(room.id, member.agentId);
          try {
            await this.deps.requestGateway('sessions.delete', {
              key,
              expectedSessionId: member.sessionId,
              expectedLifecycleRevision: member.lifecycleRevision,
              deleteTranscript: true,
            });
          } catch (error) {
            // A delete can commit before its acknowledgement is lost. Native
            // compare-and-delete rejects a missing session on replay, so only
            // an explicit absent projection from our operator client settles it.
            // An unavailable read or a replacement incarnation remains a failure.
            const described = await this.deps
              .requestGateway<{ session: unknown }>('sessions.describe', { key })
              .catch((): undefined => undefined);
            if (described?.session !== null) throw error;
          }
          this.metadata.markMemberDeleted(room.id, member.agentId);
        }
        this.metadata.remove(room.id);
      } finally {
        this.deps.onChanged();
      }
    };
    const promise = remove().finally(() => this.deleting.delete(room.id));
    this.deleting.set(room.id, promise);
    return promise;
  }

  /** Harness-owned sessions use public admin lifecycle RPCs, then the owning SDK unlock. */
  private async deleteHolding(roomId: string): Promise<void> {
    const close = () =>
      this.deps.requestGateway<{ closed: boolean; identities: TeamDiscussionHoldingIdentity[] }>(
        TeamDiscussionGateway.HoldingClose,
        { roomId },
      );
    const closed = await close();
    if (closed.closed !== true || !Array.isArray(closed.identities))
      throw new Error('teamDiscussionOutcomeUnknown');
    for (const identity of closed.identities) {
      let archiveError: unknown;
      try {
        await this.deps.requestGateway('sessions.patch', {
          key: identity.sessionKey,
          expectedSessionId: identity.sessionId,
          expectedLifecycleRevision: identity.lifecycleRevision,
          archived: true,
        });
      } catch (error) {
        archiveError = error;
      }
      // The owner exposes the latest SDK identity. Public describe omits lifecycleRevision.
      const latest = (await close()).identities.find(
        item => item.sessionKey === identity.sessionKey,
      );
      if (!latest) continue;
      if (latest.sessionId !== identity.sessionId) throw new Error('teamDiscussionSessionChanged');
      let unlocked: { identity: TeamDiscussionHoldingIdentity };
      try {
        unlocked = await this.deps.requestGateway(TeamDiscussionGateway.HoldingClose, {
          roomId,
          phase: 'unlock',
          identity: latest,
        });
      } catch (error) {
        throw archiveError ?? error;
      }
      if (
        unlocked.identity.sessionId !== identity.sessionId ||
        unlocked.identity.sessionKey !== identity.sessionKey
      )
        throw new Error('teamDiscussionSessionChanged');
      try {
        await this.deps.requestGateway('sessions.delete', {
          key: identity.sessionKey,
          expectedSessionId: identity.sessionId,
          expectedLifecycleRevision: unlocked.identity.lifecycleRevision,
          archivedOnly: true,
          deleteTranscript: true,
        });
      } catch (error) {
        const described = await this.deps
          .requestGateway<{ session: unknown }>('sessions.describe', { key: identity.sessionKey })
          .catch((): undefined => undefined);
        if (described?.session !== null) throw error;
      }
    }
    if ((await close()).identities.length) throw new Error('teamDiscussionOutcomeUnknown');
  }
}

export function registerTeamDiscussionHandlers(
  deps: Dependencies,
): () => TeamDiscussionCoordinator {
  let coordinator: TeamDiscussionCoordinator | undefined;
  const get = () => (coordinator ??= new TeamDiscussionCoordinator(deps));
  const result = async <T>(operation: () => Promise<T> | T): Promise<TeamDiscussionResult<T>> => {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return {
        success: false,
        error: /^teamDiscussion[A-Za-z]+$/.test(message) ? message : 'teamDiscussionUnavailable',
      };
    }
  };
  ipcMain.handle(TeamDiscussionIpc.CreateTask, (_event, value: unknown) =>
    result(() => get().createTask(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.Participation, (_event, value: unknown) =>
    result(() => get().setParticipation(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.List, () => result(() => get().metadata.list()));
  ipcMain.handle(TeamDiscussionIpc.Create, (_event, value: unknown) =>
    result(() => get().create(value)),
  );
  ipcMain.handle(
    TeamDiscussionIpc.Read,
    (_event, id: unknown, beforeDiscussionId: unknown, exactDiscussionIds: unknown) =>
      result(() => get().read(id, beforeDiscussionId, exactDiscussionIds)),
  );
  ipcMain.handle(TeamDiscussionIpc.Send, (_event, value: unknown) =>
    result(() => get().send(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.Enqueue, (_event, value: unknown) =>
    result(() => get().enqueue(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.CancelPending, (_event, value: unknown) =>
    result(() => get().cancelPending(value)),
  );
  ipcMain.handle(TeamDiscussionIpc.Stop, (_event, id: unknown) => result(() => get().stop(id)));
  ipcMain.handle(TeamDiscussionIpc.Delete, (_event, id: unknown) => result(() => get().delete(id)));
  return get;
}
