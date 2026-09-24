import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';
import { ipcMain } from 'electron';

import type { AgentResult } from '../../../shared/agents/agents';
import {
  COLLABORATION_MAX_MEMBERS,
  CollaborationGateway,
  CollaborationIpc,
  type CollaborationMessageResult,
  type CollaborationSnapshot,
  parseCollaborationSend,
} from '../../../shared/cowork/collaboration';
import { parseCoworkSessionKey } from '../../../shared/cowork/sessionKey';
import { CollaborationStore } from '../../data/collaborationStore';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter, OpenClawRuntimeAdapter } from '../../engine';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';

interface Dependencies {
  createAssistant?: (
    input: unknown,
    identity: string,
    assertActive: () => void,
  ) => Promise<unknown>;
  onSessionsChanged?: () => void;
  getDatabase: () => Database.Database;
  getStore: () => CoworkStore;
  getRouter: () => CoworkEngineRouter;
  getRuntime: () => OpenClawRuntimeAdapter | null;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
}
export class CollaborationCoordinator {
  private readonly metadata: CollaborationStore;
  private readonly stoppedDuringSetup = new Set<string>();
  private readonly membershipWrites = new Map<string, Promise<void>>();
  private readonly deletions = new Map<string, Promise<boolean>>();
  private readonly nativeAdmissionWaiters = new Map<string, Set<() => void>>();
  private readonly stoppingRooms = new Set<string>();
  constructor(private readonly deps: Dependencies) {
    this.metadata = new CollaborationStore(deps.getDatabase());
    this.metadata.recoverInterrupted();
  }
  private notifySessionsChanged(): void {
    try {
      this.deps.onSessionsChanged?.();
    } catch {
      // UI notification failure must not roll back an already committed room/member.
      console.warn('[CollaborationCoordinator] Could not notify session list changes.');
    }
  }
  private admissionWaiterKey(roomId: string, targetAgentId: string): string {
    return `${roomId}\u0000${targetAgentId}`;
  }
  private notifyNativeAdmission(roomId: string, targetAgentId: string): void {
    const key = this.admissionWaiterKey(roomId, targetAgentId);
    const waiters = this.nativeAdmissionWaiters.get(key);
    if (!waiters) return;
    this.nativeAdmissionWaiters.delete(key);
    for (const resolve of waiters) resolve();
  }
  private async waitForNativeAdmission(
    roomId: string,
    targetAgentId: string,
    expiresAt: unknown,
  ): Promise<void> {
    const requestDeadline = typeof expiresAt === 'number' ? expiresAt : Date.now() + 2_000;
    const waitMs = Math.max(0, Math.min(2_000, requestDeadline - Date.now()));
    if (!waitMs) return;
    const key = this.admissionWaiterKey(roomId, targetAgentId);
    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const waiters = this.nativeAdmissionWaiters.get(key);
        waiters?.delete(finish);
        if (!waiters?.size) this.nativeAdmissionWaiters.delete(key);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      const waiters = this.nativeAdmissionWaiters.get(key) ?? new Set<() => void>();
      waiters.add(finish);
      this.nativeAdmissionWaiters.set(key, waiters);
    });
  }
  read(sessionId: string): CollaborationSnapshot {
    this.metadata.expireNativeAdmissions();
    const room = this.metadata.getRoomForSession(sessionId);
    return {
      ...(room ? { room } : {}),
      deliveries: room ? this.metadata.listDeliveries(room.id) : [],
    };
  }
  async deleteTask(sessionId: string): Promise<boolean> {
    const room = this.metadata.getRoomForSession(sessionId);
    if (!room) return false;
    const active = this.deletions.get(room.id);
    if (active) return active;
    const operation = this.deleteRoom(room);
    this.deletions.set(room.id, operation);
    try {
      return await operation;
    } finally {
      this.deletions.delete(room.id);
    }
  }
  private async deleteRoom(room: NonNullable<CollaborationSnapshot['room']>): Promise<boolean> {
    this.metadata.beginDeletion(room.id);
    this.notifySessionsChanged();
    await this.stop(room.anchorSessionId);
    await this.membershipWrites.get(room.anchorSessionId)?.catch((): void => undefined);
    for (const member of room.members) {
      if (this.metadata.isMemberDeleted(room.id, member.sessionId)) continue;
      const status = await this.deps.getRouter().getSessionRuntimeStatus(member.sessionId, {
        forceRefresh: true,
        includeSubagents: true,
        fullScan: true,
      });
      if (!status.known) {
        const described = await this.deps.requestGateway<{ session: unknown }>(
          'sessions.describe',
          { key: member.sessionKey },
        );
        if (described.session === null) {
          this.metadata.markMemberDeleted(room.id, member.sessionId);
          continue;
        }
      }
      if (!status.known || status.running) throw new Error('collaborationDeletePending');
    }
    // All members are frozen and confirmed idle before native deletion invalidates runtime caches.
    for (const member of room.members) {
      if (this.metadata.isMemberDeleted(room.id, member.sessionId)) continue;
      await this.deps.requestGateway('sessions.delete', { key: member.sessionKey });
      this.metadata.markMemberDeleted(room.id, member.sessionId);
    }
    const store = this.deps.getStore();
    // Capture artifact locations before cascading deletion removes plan metadata.
    const workspaceRoots = new Map(
      room.members.map(member => {
        const roots = store.listPlanHandoffs(member.sessionId)
          .map(handoff => handoff.artifact.workspaceRoot)
          .filter((root): root is string => typeof root === 'string');
        const cwd = store.getSession(member.sessionId)?.cwd;
        if (cwd) roots.push(cwd);
        return [member.sessionId, roots];
      }),
    );
    this.deps.getDatabase().transaction(() => {
      for (const member of room.members.filter(member => member.sessionId !== room.anchorSessionId))
        store.deleteSession(member.sessionId);
      store.deleteSession(room.anchorSessionId);
    })();
    for (const member of room.members) {
      try {
        this.deps.getRouter().onSessionDeleted(
          member.sessionId,
          member.agentId,
          [member.sessionKey],
          workspaceRoots.get(member.sessionId),
        );
      } catch {
        console.warn('[CollaborationCoordinator] Could not clear deleted session runtime state.');
      }
    }
    this.notifySessionsChanged();
    return true;
  }
  async create(sessionId: string, agentIds: string[]): Promise<CollaborationSnapshot> {
    const source = this.deps.getStore().getSession(sessionId);
    const existing = this.metadata.getRoomForSession(sessionId);
    if (existing) return this.read(sessionId);
    if (
      !source ||
      source.external ||
      !Array.isArray(agentIds) ||
      agentIds.length < 2 ||
      agentIds.length > COLLABORATION_MAX_MEMBERS ||
      new Set(agentIds).size !== agentIds.length ||
      !agentIds.includes(source.agentId)
    )
      throw new Error('collaborationInvalidMembers');
    const health = await this.deps.requestGateway<{ version: number }>(CollaborationGateway.Health);
    if (health.version !== 2) throw new Error('collaborationRuntimeUnavailable');
    const status = await this.deps
      .getRouter()
      .getSessionRuntimeStatus(sessionId, { forceRefresh: true });
    if (!status.known || status.running) throw new Error('agentBusy');
    const store = this.deps.getStore();
    for (const id of agentIds) {
      const agent = store.getAgent(id);
      if (!agent?.enabled)
        throw new Error('collaborationInvalidMembers');
    }
    // Product creation is atomic; native preparation is idempotent and precedes first execution.
    this.deps.getDatabase().transaction(() => {
      const members = agentIds.map(agentId => {
        const agent = store.getAgent(agentId)!;
        const session =
          agentId === source.agentId
            ? source
            : store.createSession(
                source.title,
                source.cwd,
                source.executionMode,
                [],
                agentId,
                source.permissionMode,
                agent.model || undefined,
              );
        return {
          agentId,
          sessionId: session.id,
          sessionKey: buildManagedSessionKey(session.id, agentId),
        };
      });
      this.metadata.createRoom({ id: randomUUID(), anchorSessionId: source.id, members });
    })();
    const configured = this.read(sessionId);
    try {
      for (const member of configured.room!.members)
        await this.deps.getRouter().prepareSession(member.sessionId);
    } catch (error) {
      this.deps
        .getDatabase()
        .prepare('DELETE FROM collaboration_rooms WHERE id = ?')
        .run(configured.room!.id);
      for (const member of configured.room!.members)
        if (member.sessionId !== sessionId) {
          store.deleteSession(member.sessionId);
          await this.deps
            .requestGateway('sessions.delete', { key: member.sessionKey })
            .catch((): void => undefined);
        }
      throw error;
    }
    this.notifySessionsChanged();
    return this.read(sessionId);
  }
  async readMessages(
    sessionId: string,
    deliveryIds: readonly string[],
  ): Promise<CollaborationMessageResult[]> {
    const room = this.metadata.getRoomForSession(sessionId);
    if (
      !room ||
      room.deleting ||
      !Array.isArray(deliveryIds) ||
      !deliveryIds.length ||
      deliveryIds.length > 16 ||
      new Set(deliveryIds).size !== deliveryIds.length ||
      deliveryIds.some(id => typeof id !== 'string' || !id)
    )
      throw new Error('collaborationInvalidMessage');
    const deliveries = deliveryIds.map(id => this.metadata.getDelivery(id));
    if (deliveries.some(delivery => !delivery || delivery.roomId !== room.id))
      throw new Error('collaborationInvalidMessage');
    const lookups = deliveries.map(delivery => {
      const source = room.members.find(member => member.agentId === delivery!.from);
      const target = room.members.find(member => member.agentId === delivery!.to);
      if (!source || !target) throw new Error('collaborationInvalidMessage');
      return {
        deliveryId: delivery!.id,
        receiptId: delivery!.runId || delivery!.id,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sourceSessionKey: source.sessionKey,
      };
    });
    const response = await this.deps.requestGateway<{ messages?: unknown }>(
      CollaborationGateway.Messages,
      { lookups },
    );
    if (!Array.isArray(response.messages)) throw new Error('collaborationInvalidMessage');
    const allowed = new Set(deliveryIds);
    return response.messages.flatMap(value => {
      if (!value || typeof value !== 'object') return [];
      const item = value as Record<string, unknown>;
      if (typeof item.deliveryId !== 'string' || !allowed.has(item.deliveryId)) return [];
      return [
        {
          deliveryId: item.deliveryId,
          ...(item.message && typeof item.message === 'object' ? { message: item.message } : {}),
        },
      ];
    });
  }
  private assertRequestActive(expiresAt: unknown): void {
    if (
      expiresAt !== undefined &&
      (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || Date.now() >= expiresAt)
    )
      throw new Error('collaborationInvalidMessage');
  }
  private async ensureRecipient(
    sessionId: string,
    agentId: string,
    runId: string,
    expiresAt: unknown,
  ): Promise<void> {
    const operation = async () => {
      this.assertRequestActive(expiresAt);
      const store = this.deps.getStore();
      const source = store.getSession(sessionId);
      const room = this.metadata.getRoomForSession(sessionId);
      if (
        !source ||
        source.external ||
        room?.deleting ||
        (room && room.anchorSessionId !== sessionId)
      )
        throw new Error('collaborationInvalidMembers');
      let previous = room
        ? this.metadata
            .listDeliveries(room.id)
            .find(
              delivery =>
                delivery.to === source.agentId &&
                delivery.runId === runId &&
                ['dispatching', 'accepted'].includes(delivery.state),
            )
        : undefined;
      let run = previous
        ? undefined
        : store
            .getSessionRuns(sessionId)
            .find(item => item.rootRunId === runId || item.clientTurnId === runId);
      if (
        room &&
        !previous &&
        !run &&
        this.metadata.listDeliveries(room.id).some(
          delivery =>
            delivery.to === source.agentId && delivery.state === 'dispatching' && !delivery.runId,
        )
      ) {
        // A fast nested main turn can recruit its next peer before the sender's
        // native acknowledgement has identified this recipient run.
        await this.waitForNativeAdmission(room.id, source.agentId, expiresAt);
        this.assertRequestActive(expiresAt);
        if (this.metadata.isDeleting(room.id)) throw new Error('collaborationDeletePending');
        previous = this.metadata.listDeliveries(room.id).find(
          delivery =>
            delivery.to === source.agentId && delivery.runId === runId &&
            ['dispatching', 'accepted'].includes(delivery.state),
        );
        run = previous
          ? undefined
          : store.getSessionRuns(sessionId)
              .find(item => item.rootRunId === runId || item.clientTurnId === runId);
      }
      const roundId = previous?.roundId ?? run?.clientTurnId;
      if (room && roundId) this.metadata.beginRound(room.id, roundId);
      if (
        !roundId ||
        (run && (run.state === 'aborted' || run.state === 'failed')) ||
        this.stoppedDuringSetup.has(runId) ||
        (room && this.metadata.isRoundStopped(roundId))
      )
        throw new Error('collaborationInvalidRound');
      // A nested main-agent turn admitted from an existing delivery remains part of
      // that user round and may prepare the next configured peer in the workflow.
      if (previous?.state === 'dispatching')
        this.metadata.transition(previous.id, 'dispatching', 'accepted', previous.runId);
      if (room?.members.some(member => member.agentId === agentId)) return;
      const target = store.getAgent(agentId);
      if (
        !target?.enabled ||
        agentId === source.agentId ||
        (room && room.members.length >= COLLABORATION_MAX_MEMBERS)
      )
        throw new Error('collaborationInvalidMembers');
      const session = store.createSession(
        source.title,
        source.cwd,
        source.executionMode,
        [],
        agentId,
        source.permissionMode,
        target.model || undefined,
      );
      const member = {
        agentId,
        sessionId: session.id,
        sessionKey: buildManagedSessionKey(session.id, agentId),
      };
      try {
        await this.deps.getRouter().prepareSession(session.id);
        this.assertRequestActive(expiresAt);
        // Preparing a native session yields: Stop, deletion and profile edits may happen meanwhile.
        if (
          !store.getSession(sessionId) ||
          !store.getAgent(agentId)?.enabled ||
          !store.getAgent(source.agentId)?.enabled ||
          this.stoppedDuringSetup.has(runId) ||
          (room && this.metadata.isRoundStopped(roundId)) ||
          (room && this.metadata.isDeleting(room.id)) ||
          (room && !this.metadata.getRoom(room.id))
        )
          throw new Error('collaborationInvalidMembers');
        if (room) this.metadata.addMember(room.id, member);
        else
          this.metadata.createRoom(
            {
              id: randomUUID(),
              anchorSessionId: sessionId,
              members: [
                {
                  agentId: source.agentId,
                  sessionId,
                  sessionKey: buildManagedSessionKey(sessionId, source.agentId),
                },
                member,
              ],
            },
            true,
          );
      } catch (error) {
        store.deleteSession(session.id);
        await this.deps
          .requestGateway('sessions.delete', { key: member.sessionKey })
          .catch((): void => undefined);
        throw error;
      }
      this.notifySessionsChanged();
    };
    const previous = this.membershipWrites.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.membershipWrites.set(sessionId, next);
    try {
      await next;
    } finally {
      if (this.membershipWrites.get(sessionId) === next) this.membershipWrites.delete(sessionId);
    }
  }

  async handle(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object') return;
    const request = payload as Record<string, unknown>;
    if (typeof request.requestId !== 'string' || typeof request.sessionKey !== 'string') return;
    let result: unknown;
    try {
      this.assertRequestActive(request.expiresAt);
      const parsed = parseCoworkSessionKey(request.sessionKey);
      let room = parsed ? this.metadata.getRoomForSession(parsed.sessionId) : undefined;
      if (room?.deleting && !['members', 'native-result'].includes(String(request.operation)))
        throw new Error('collaborationDeletePending');
      if (request.operation === 'ensure') {
        if (
          !parsed ||
          this.deps.getStore().getSession(parsed.sessionId)?.agentId !== parsed.agentId ||
          typeof request.sourceRunId !== 'string'
        )
          throw new Error('collaborationInvalidMembers');
        const input = request.input as { agentId?: unknown } | undefined;
        const roster = this.deps
          .getStore()
          .listAgents()
          .filter(agent => agent.enabled);
        const candidates = roster.filter(agent => agent.id === input?.agentId);
        const matches = candidates.length
          ? candidates
          : roster.filter(agent => agent.name === input?.agentId);
        if (matches.length !== 1) throw new Error('collaborationInvalidMembers');
        await this.ensureRecipient(
          parsed.sessionId,
          matches[0].id,
          request.sourceRunId,
          request.expiresAt,
        );
        room = this.metadata.getRoomForSession(parsed.sessionId);
        result = { member: room?.members.find(member => member.agentId === matches[0].id) };
        await this.deps.requestGateway(CollaborationGateway.Resolve, {
          requestId: request.requestId,
          result,
        });
        return;
      }
      if (request.operation === 'native-result') {
        const input = request.input as {
          deliveryId?: string;
          runId?: string;
          status?: string;
          sentBeforeError?: boolean;
        };
        const delivery =
          input && typeof input.deliveryId === 'string'
            ? this.metadata.getDelivery(input.deliveryId)
            : undefined;
        if (
          !room ||
          !delivery ||
          delivery.roomId !== room.id ||
          delivery.sourceRunId !== request.sourceRunId ||
          delivery.toolCallId !== request.toolCallId ||
          !room.members.some(
            member => member.sessionKey === request.sessionKey && member.agentId === delivery.from,
          )
        )
          throw new Error('collaborationInvalidMessage');
        if (delivery.state === 'dispatching' || delivery.state === 'unknown') {
          const accepted =
            ['accepted', 'ok', 'timeout', 'no_reply'].includes(input.status ?? '') &&
            typeof input.runId === 'string' &&
            !!input.runId;
          const nextState = accepted
            ? 'accepted'
            : input.sentBeforeError || input.status === 'unknown'
              ? 'unknown'
              : 'failed';
          if (delivery.state !== nextState)
            this.metadata.transition(delivery.id, delivery.state, nextState, input.runId);
          this.notifyNativeAdmission(delivery.roomId, delivery.to);
          this.notifySessionsChanged();
        }
        await this.deps.requestGateway(CollaborationGateway.Resolve, {
          requestId: request.requestId,
          result: { ok: true },
        });
        return;
      }
      if (request.operation === 'native-send') {
        const input = request.input as { sessionKey?: unknown; message?: unknown };
        const target = room?.members.find(member => member.sessionKey === input?.sessionKey);
        if (!target) throw new Error('collaborationInvalidRecipient');
        request.input = { to: target.agentId, message: input.message };
      }
      if (request.operation === 'create') {
        const assertActive = () => {
          this.assertRequestActive(request.expiresAt);
          if (
            !parsed ||
            typeof request.sourceRunId !== 'string' ||
            typeof request.toolCallId !== 'string' ||
            !request.toolCallId ||
            !request.sourceRunId
          )
            throw new Error('agentUnavailable');
          const store = this.deps.getStore();
          const source = store.getSession(parsed.sessionId);
          const currentRoom = this.metadata.getRoomForSession(parsed.sessionId);
          const run = store
            .getSessionRuns(parsed.sessionId)
            .find(
              item =>
                item.rootRunId === request.sourceRunId || item.clientTurnId === request.sourceRunId,
            );
          if (
            !source ||
            source.external ||
            source.agentId !== parsed.agentId ||
            !store.getAgent(source.agentId)?.enabled ||
            (currentRoom && currentRoom.anchorSessionId !== source.id) ||
            run?.state !== 'running' ||
            this.stoppedDuringSetup.has(request.sourceRunId)
          )
            throw new Error('agentUnavailable');
        };
        assertActive();
        if (!this.deps.createAssistant) throw new Error('agentUnavailable');
        result = await this.deps.createAssistant(
          request.input,
          JSON.stringify([request.sessionKey, request.sourceRunId, request.toolCallId]),
          assertActive,
        );
        await this.deps.requestGateway(CollaborationGateway.Resolve, {
          requestId: request.requestId,
          result,
        });
        return;
      }
      if (request.operation === 'members' && parsed) {
        const source = this.deps.getStore().getSession(parsed.sessionId);
        if (
          !source ||
          source.external ||
          source.agentId !== parsed.agentId ||
          (room && !room.members.some(member => member.sessionKey === request.sessionKey))
        )
          throw new Error('collaborationInvalidMembers');
        const canInvite =
          source &&
          !source.external &&
          source.agentId === parsed.agentId &&
          (!room || room.anchorSessionId === source.id);
        result = {
          members: (room?.members ?? []).map(member => ({
            agentId: member.agentId,
            name: this.deps.getStore().getAgent(member.agentId)?.name || member.agentId,
            sessionKey: member.sessionKey,
          })),
          ...(canInvite
            ? {
                available: this.deps
                  .getStore()
                  .listAgents()
                  .filter(
                    agent =>
                      agent.enabled &&
                      agent.id !== parsed.agentId,
                  )
                  .map(agent => ({
                    agentId: agent.id,
                    name: agent.name,
                    description: agent.description,
                  })),
              }
            : {}),
        };
      } else if (!room || !room.members.some(member => member.sessionKey === request.sessionKey)) {
        result =
          request.operation === 'members'
            ? { members: [] }
            : { error: 'collaborationInvalidMembers' };
      } else if (request.operation === 'members') {
        result = {
          members: room.members.map(member => ({
            agentId: member.agentId,
            name: this.deps.getStore().getAgent(member.agentId)?.name || member.agentId,
          })),
        };
      } else {
        if (
          request.operation !== 'native-send' ||
          typeof request.sourceRunId !== 'string' ||
          typeof request.toolCallId !== 'string'
        )
          throw new Error('collaborationInvalidMessage');
        const input = parseCollaborationSend(request.input);
        const source = room.members.find(member => member.sessionKey === request.sessionKey)!;
        let deliveries = this.metadata.listDeliveries(room.id);
        let previous = deliveries
          .find(
            delivery =>
              delivery.to === source.agentId &&
              delivery.runId === request.sourceRunId &&
              ['dispatching', 'accepted'].includes(delivery.state),
          );
        let userRun = previous
          ? undefined
          : this.deps
              .getStore()
              .getSessionRuns(source.sessionId)
              .find(
                run =>
                  run.rootRunId === request.sourceRunId || run.clientTurnId === request.sourceRunId,
              );
        if (
          !previous &&
          !userRun &&
          deliveries.some(
            delivery =>
              delivery.to === source.agentId &&
              delivery.state === 'dispatching' &&
              !delivery.runId,
          )
        ) {
          // Native sessions_send starts the recipient before the sender's after_tool_call
          // reports its run id. Give that acknowledgement a short bounded window so a fast
          // recipient reply is not rejected as an unrelated run.
          await this.waitForNativeAdmission(room.id, source.agentId, request.expiresAt);
          this.assertRequestActive(request.expiresAt);
          deliveries = this.metadata.listDeliveries(room.id);
          previous = deliveries.find(
            delivery =>
              delivery.to === source.agentId &&
              delivery.runId === request.sourceRunId &&
              ['dispatching', 'accepted'].includes(delivery.state),
          );
          userRun = previous
            ? undefined
            : this.deps
                .getStore()
                .getSessionRuns(source.sessionId)
                .find(
                  run =>
                    run.rootRunId === request.sourceRunId ||
                    run.clientTurnId === request.sourceRunId,
                );
        }
        if (
          (!previous && (!userRun || ['aborted', 'failed'].includes(userRun.state))) ||
          this.stoppedDuringSetup.has(request.sourceRunId)
        )
          throw new Error('collaborationInvalidRound');
        const roundId = previous?.roundId ?? userRun!.clientTurnId;
        if (!previous) this.metadata.beginRound(room.id, roundId);
        if (this.metadata.isRoundStopped(roundId)) throw new Error('collaborationInvalidRound');
        // A trusted tool event from the exact recipient run proves native admission,
        // even when the agent RPC acknowledgement has not reached this process yet.
        if (previous?.state === 'dispatching')
          this.metadata.transition(previous.id, 'dispatching', 'accepted', previous.runId);
        if (previous?.from === input.to)
          input.inReplyTo = previous.id;
        this.assertRequestActive(request.expiresAt);
        const delivery = this.metadata.enqueue(
          room.id,
          roundId,
          request.sessionKey,
          request.toolCallId,
          request.sourceRunId,
          input,
        );
        if (delivery.state !== 'queued') throw new Error('collaborationDuplicateConflict');
        this.metadata.transition(delivery.id, 'queued', 'dispatching');
        result = {
          deliveryId: delivery.id,
          sessionKey: room.members.find(member => member.agentId === input.to)!.sessionKey,
        };
        this.notifySessionsChanged();
        await this.deps.requestGateway(CollaborationGateway.Resolve, {
          requestId: request.requestId,
          result,
        });
        return;
      }
    } catch (error) {
      result = { error: error instanceof Error ? error.message : 'collaborationInvalidMessage' };
    }
    await this.deps.requestGateway(CollaborationGateway.Resolve, {
      requestId: request.requestId,
      result,
    });
  }
  async stop(sessionId: string): Promise<void> {
    for (const run of this.deps.getStore().getSessionRuns(sessionId)) {
      this.stoppedDuringSetup.add(run.clientTurnId);
      if (run.rootRunId) this.stoppedDuringSetup.add(run.rootRunId);
    }
    const room = this.metadata.getRoomForSession(sessionId);
    if (!room || this.stoppingRooms.has(room.id)) return;
    this.stoppingRooms.add(room.id);
    try {
      for (const member of room.members)
        for (const run of this.deps.getStore().getSessionRuns(member.sessionId)) {
          this.metadata.beginRound(room.id, run.clientTurnId);
        }
      this.metadata.stopRounds(room.id);
      await Promise.all(
        room.members
          .filter(member => !this.metadata.isMemberDeleted(room.id, member.sessionId))
          .map(member => this.deps.getRouter().stopSession(member.sessionId)),
      );
    } finally {
      this.stoppingRooms.delete(room.id);
    }
  }
}

export function registerCollaborationHandlers(
  deps: Dependencies,
): (() => void) & { coordinator: () => CollaborationCoordinator } {
  let service: CollaborationCoordinator | undefined;
  const get = () => (service ??= new CollaborationCoordinator(deps));
  const result = async <T>(operation: () => Promise<T> | T): Promise<AgentResult<T>> => {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'collaborationInvalidMessage',
      };
    }
  };
  ipcMain.handle(CollaborationIpc.List, () =>
    result(() => new CollaborationStore(deps.getDatabase()).listRooms()),
  );
  ipcMain.handle(CollaborationIpc.Read, (_event, sessionId: unknown) =>
    result(() => {
      if (typeof sessionId !== 'string') throw new Error('collaborationInvalidMembers');
      return get().read(sessionId);
    }),
  );
  ipcMain.handle(
    CollaborationIpc.ReadMessages,
    (_event, input: { sessionId?: unknown; deliveryIds?: unknown }) =>
      result(() => {
        if (!input || typeof input.sessionId !== 'string' || !Array.isArray(input.deliveryIds))
          throw new Error('collaborationInvalidMessage');
        return get().readMessages(input.sessionId, input.deliveryIds);
      }),
  );
  let creating: Promise<unknown> = Promise.resolve();
  ipcMain.handle(
    CollaborationIpc.Create,
    (_event, input: { sessionId: string; agentIds: string[] }) => {
      const next = creating.then(() =>
        result(() => {
          if (!input || typeof input.sessionId !== 'string')
            throw new Error('collaborationInvalidMembers');
          return get().create(input.sessionId, input.agentIds);
        }),
      );
      creating = next;
      return next;
    },
  );
  ipcMain.handle(CollaborationIpc.Stop, (_event, sessionId: unknown) =>
    result(async () => {
      if (typeof sessionId !== 'string') throw new Error('collaborationInvalidMembers');
      await get().stop(sessionId);
    }),
  );
  return Object.assign(
    () => {
      const coordinator = get();
      deps.getRuntime()?.on('gatewayEvent', event => {
        if (event.event === CollaborationGateway.Requested)
          void coordinator.handle(event.payload).catch((): void => undefined);
      });
      deps.getRouter().on('sessionStopped', sessionId => {
        void coordinator.stop(sessionId).catch((): void => undefined);
      });
    },
    { coordinator: get },
  );
}
