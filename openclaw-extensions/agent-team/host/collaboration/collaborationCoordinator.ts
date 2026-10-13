import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { OpenClawExtensionId } from '../../../runtime-services/contracts/native-ids';
import { parseCoworkSessionKey } from '../../../runtime-services/contracts/session-key';
import { buildCoworkSessionKey as buildManagedSessionKey } from '../../../runtime-services/contracts/session-key';
import {
  type CollaborationContinueTarget,
  CollaborationGateway,
  type CollaborationMessageResult,
  type CollaborationRoom,
  type CollaborationSnapshot,
  type CollaborationStopMemberInput,
  parseCollaborationSend,
} from '../../contracts/collaboration';
import { AgentTeamSettingsService } from '../data/agentTeamSettingsService';
import { CollaborationStore } from '../data/collaborationStore';
import type { TeamHostStore as CoworkStore } from '../ports';
import type {
  TeamHostRouter as CoworkEngineRouter,
  TeamHostRuntime as OpenClawRuntimeAdapter,
} from '../ports';

export interface CollaborationDependencies {
  onExecution?: (payload: unknown) => void;
  onLaunchAccepted?: (receipt: {
    sessionKey: string;
    sourceRunId: string;
    mode: 'discussion' | 'collaboration';
    receiptId: string;
  }) => Promise<void>;
  stopDiscussions?: (sessionId: string, requireSettled?: boolean) => Promise<void>;
  discussion?: (
    sourceSessionId: string,
    input: unknown,
    identity: string,
    assertActive: () => void,
  ) => Promise<unknown>;
  createAssistant?: (
    input: unknown,
    identity: string,
    assertActive: () => void,
  ) => Promise<unknown>;
  onSessionsChanged?: () => void;
  getDatabase: () => Database.Database;
  getStore: () => Pick<
    CoworkStore,
    | 'getSession'
    | 'getAgent'
    | 'listAgents'
    | 'getSessionRuns'
    | 'listPlanHandoffs'
    | 'createSession'
    | 'deleteSession'
  >;
  getRouter: () => Pick<
    CoworkEngineRouter,
    'prepareSession' | 'getSessionRuntimeStatus' | 'stopSession' | 'onSessionDeleted'
  >;
  getRuntime: () => OpenClawRuntimeAdapter | null;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
}
export class CollaborationCoordinator {
  private readonly metadata: CollaborationStore;
  private readonly stoppedDuringSetup = new Set<string>();
  private readonly sourceDeletionLeases = new Map<string, number>();
  private readonly membershipWrites = new Map<string, Promise<void>>();
  private readonly deletions = new Map<string, Promise<boolean>>();
  private readonly nativeAdmissionWaiters = new Map<string, Set<() => void>>();
  private readonly stoppingRooms = new Map<string, Promise<void>>();
  constructor(private readonly deps: CollaborationDependencies) {
    this.metadata = new CollaborationStore(deps.getDatabase());
    this.metadata.recoverInterrupted();
  }
  private limits(room?: CollaborationRoom) {
    const service = new AgentTeamSettingsService(this.deps.getDatabase());
    const global = service.read().value;
    const override = room
      ? service.readTeam('collaboration', room.id).team.value.messageBudget
      : undefined;
    return {
      ...global,
      collaboration: {
        ...global.collaboration,
        messageBudget: Math.min(global.collaboration.messageBudget, override ?? 16),
      },
    };
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
      rounds: room ? this.metadata.rounds(room.id) : [],
      reviews: room ? this.metadata.reviews.list(room.id) : [],
    };
  }
  /** A read-only preparation, never a forged source run or a direct peer send. */
  async prepareContinuation(value: unknown): Promise<CollaborationContinueTarget> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('collaborationInvalidMessage');
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some(
        key => !['sourceSessionId', 'roomId', 'targetSessionKey', 'priorDeliveryId'].includes(key),
      ) ||
      typeof input.sourceSessionId !== 'string' ||
      typeof input.roomId !== 'string' ||
      typeof input.targetSessionKey !== 'string' ||
      (input.priorDeliveryId !== undefined && typeof input.priorDeliveryId !== 'string')
    )
      throw new Error('collaborationInvalidMessage');
    const sourceSessionId = input.sourceSessionId;
    this.assertSourceAdmission(sourceSessionId);
    const store = this.deps.getStore();
    const snapshot = this.read(sourceSessionId);
    const room = snapshot.room;
    const source = store.getSession(sourceSessionId);
    const target = room?.members.find(member => member.sessionKey === input.targetSessionKey);
    if (
      !source ||
      source.external ||
      !room ||
      room.deleting ||
      this.stoppingRooms.has(room.id) ||
      room.id !== input.roomId ||
      room.anchorSessionId !== source.id ||
      !target ||
      target.sessionId === source.id ||
      this.metadata.isMemberDeleted(room.id, target.sessionId) ||
      !store.getAgent(source.agentId)?.enabled ||
      !store.getAgent(target.agentId)?.enabled ||
      store.getSession(target.sessionId)?.agentId !== target.agentId ||
      (input.priorDeliveryId &&
        !snapshot.deliveries.some(
          delivery =>
            delivery.id === input.priorDeliveryId &&
            (delivery.to === target.agentId || delivery.from === target.agentId),
        ))
    )
      throw new Error('collaborationInvalidRecipient');
    const hasUnsettledDelivery = (snapshot: CollaborationSnapshot) =>
      snapshot.deliveries.some(
        delivery =>
          ['queued', 'dispatching', 'unknown'].includes(delivery.state) ||
          (delivery.state === 'accepted' && !delivery.executionOutcome),
      );
    if (hasUnsettledDelivery(snapshot)) throw new Error('agentBusy');
    const policy = JSON.stringify([source.agentId, source.cwd, source.permissionMode]);
    const health = await this.deps.requestGateway<{ version: number }>(CollaborationGateway.Health);
    if (health.version !== 2) throw new Error('collaborationRuntimeUnavailable');
    const runtime = this.deps.getRuntime();
    const assertEligible = async () => {
      const described = await this.deps.requestGateway<{
        session?: {
          goal?: unknown;
          pluginExtensions?: {
            pluginId?: string;
            namespace?: string;
            value?: { enabled?: boolean; awaitingReview?: unknown };
          }[];
        } | null;
      }>('sessions.describe', { key: buildManagedSessionKey(source.id, source.agentId) });
      if (!runtime || !described.session || described.session.goal != null)
        throw new Error('collaborationContinuationUnavailable');
      const planState = described.session.pluginExtensions?.find(
        extension =>
          extension.pluginId === OpenClawExtensionId.PLAN_MODE && extension.namespace === 'state',
      )?.value;
      const plan = await runtime.getPlanMode(source.id);
      if (
        plan.enabled ||
        planState?.enabled === true ||
        planState?.awaitingReview != null ||
        runtime.getGoalExecution(source.id)
      )
        throw new Error('collaborationContinuationUnavailable');
    };
    await assertEligible();
    for (const member of room.members) {
      const status = await this.deps.getRouter().getSessionRuntimeStatus(member.sessionId, {
        includeSubagents: true,
        forceRefresh: true,
        fullScan: true,
      });
      if (!status.known || status.running) throw new Error('agentBusy');
    }
    await assertEligible();
    this.assertSourceAdmission(sourceSessionId);
    const currentSnapshot = this.read(sourceSessionId);
    if (hasUnsettledDelivery(currentSnapshot)) throw new Error('agentBusy');
    const current = currentSnapshot.room;
    if (
      !current ||
      current.id !== room.id ||
      current.deleting ||
      this.stoppingRooms.has(room.id) ||
      JSON.stringify(
        current.members.map(({ agentId, sessionId, sessionKey }) => [
          agentId,
          sessionId,
          sessionKey,
        ]),
      ) !==
        JSON.stringify(
          room.members.map(({ agentId, sessionId, sessionKey }) => [
            agentId,
            sessionId,
            sessionKey,
          ]),
        ) ||
      JSON.stringify([
        store.getSession(source.id)?.agentId,
        store.getSession(source.id)?.cwd,
        store.getSession(source.id)?.permissionMode,
      ]) !== policy ||
      current.members.some(
        member =>
          !store.getAgent(member.agentId)?.enabled ||
          store.getSession(member.sessionId)?.agentId !== member.agentId,
      ) ||
      !current.members.some(
        member =>
          member.agentId === target.agentId &&
          member.sessionId === target.sessionId &&
          member.sessionKey === target.sessionKey,
      )
    )
      throw new Error('collaborationInvalidRecipient');
    return {
      sourceSessionId,
      sourceAgentId: source.agentId,
      roomId: room.id,
      targetAgentId: target.agentId,
      targetSessionId: target.sessionId,
      targetSessionKey: target.sessionKey,
      ...(typeof input.priorDeliveryId === 'string'
        ? { priorDeliveryId: input.priorDeliveryId }
        : {}),
    };
  }
  observeExecution(payload: unknown): void {
    this.deps.onExecution?.(payload);
    if (!payload || typeof payload !== 'object') return;
    const event = payload as {
      stream?: string;
      sessionKey?: string;
      runId?: string;
      data?: { phase?: string; executionSettled?: boolean; aborted?: boolean };
    };
    if (
      event.stream !== 'lifecycle' ||
      event.data?.executionSettled !== true ||
      !event.sessionKey ||
      !event.runId ||
      !['end', 'error'].includes(event.data.phase ?? '')
    )
      return;
    this.metadata.recordExecution(
      event.sessionKey,
      event.runId,
      event.data.aborted ? 'cancelled' : event.data.phase === 'error' ? 'failed' : 'completed',
    );
    this.notifySessionsChanged();
  }
  isSourceDeleting(sessionId: string): boolean {
    return this.sourceDeletionLeases.has(sessionId);
  }
  private assertSourceAdmission(sessionId: string): void {
    if (this.isSourceDeleting(sessionId)) throw new Error('collaborationDeletePending');
  }
  /** Freeze admission synchronously, including the standalone deletion fallback. */
  acquireSourceDeletion(sessionIds: string[]): () => void {
    const sources = new Set<string>();
    const rooms = new Set<string>();
    for (const sessionId of sessionIds) {
      sources.add(sessionId);
      const room = this.metadata.getRoomForSession(sessionId);
      if (room) rooms.add(room.id);
      for (const member of room?.members ?? []) sources.add(member.sessionId);
    }
    const runs = [...sources].map(source => this.deps.getStore().getSessionRuns(source));
    for (const source of sources)
      this.sourceDeletionLeases.set(source, (this.sourceDeletionLeases.get(source) ?? 0) + 1);
    for (const sourceRuns of runs) {
      for (const run of sourceRuns) {
        this.stoppedDuringSetup.add(run.clientTurnId);
        if (run.rootRunId) this.stoppedDuringSetup.add(run.rootRunId);
      }
    }
    for (const roomId of rooms) {
      this.metadata.stopRounds(roomId);
      for (const delivery of this.metadata.listDeliveries(roomId)) {
        this.stoppedDuringSetup.add(delivery.sourceRunId);
        if (delivery.runId) this.stoppedDuringSetup.add(delivery.runId);
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const source of sources) {
        const remaining = (this.sourceDeletionLeases.get(source) ?? 1) - 1;
        if (remaining) this.sourceDeletionLeases.set(source, remaining);
        else this.sourceDeletionLeases.delete(source);
      }
    };
  }
  async deleteTask(sessionId: string): Promise<boolean> {
    const release = this.acquireSourceDeletion([sessionId]);
    try {
      const initialRoom = this.metadata.getRoomForSession(sessionId);
      await Promise.all(
        (initialRoom?.members.map(member => member.sessionId) ?? [sessionId]).map(source =>
          this.deps.stopDiscussions?.(source, true),
        ),
      );
      const room = this.metadata.getRoomForSession(sessionId);
      if (!room) return false;
      const active = this.deletions.get(room.id);
      if (active) return await active;
      const operation = this.deleteRoom(room);
      this.deletions.set(room.id, operation);
      try {
        return await operation;
      } finally {
        this.deletions.delete(room.id);
      }
    } finally {
      release();
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
        const roots = store
          .listPlanHandoffs(member.sessionId)
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
        this.deps
          .getRouter()
          .onSessionDeleted(
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
    if (this.isSourceDeleting(sessionId)) throw new Error('collaborationDeletePending');
    const source = this.deps.getStore().getSession(sessionId);
    const existing = this.metadata.getRoomForSession(sessionId);
    if (existing) return this.read(sessionId);
    if (
      !source ||
      source.external ||
      !Array.isArray(agentIds) ||
      agentIds.length < 2 ||
      agentIds.length >
        new AgentTeamSettingsService(this.deps.getDatabase()).read().value.collaboration
          .maxMembers ||
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
      if (!agent?.enabled) throw new Error('collaborationInvalidMembers');
    }
    // Product creation is atomic; native preparation is idempotent and precedes first execution.
    if (this.isSourceDeleting(sessionId) || !store.getSession(sessionId))
      throw new Error('collaborationDeletePending');
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
      this.assertSourceAdmission(sessionId);
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
        this.metadata
          .listDeliveries(room.id)
          .some(
            delivery =>
              delivery.to === source.agentId && delivery.state === 'dispatching' && !delivery.runId,
          )
      ) {
        // A fast nested main turn can recruit its next peer before the sender's
        // native acknowledgement has identified this recipient run.
        await this.waitForNativeAdmission(room.id, source.agentId, expiresAt);
        this.assertRequestActive(expiresAt);
        this.assertSourceAdmission(sessionId);
        if (this.metadata.isDeleting(room.id)) throw new Error('collaborationDeletePending');
        previous = this.metadata
          .listDeliveries(room.id)
          .find(
            delivery =>
              delivery.to === source.agentId &&
              delivery.runId === runId &&
              ['dispatching', 'accepted'].includes(delivery.state),
          );
        run = previous
          ? undefined
          : store
              .getSessionRuns(sessionId)
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
        (room &&
          room.members.length >=
            new AgentTeamSettingsService(this.deps.getDatabase()).read().value.collaboration
              .maxMembers)
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
        this.assertSourceAdmission(sessionId);
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
      if (
        parsed &&
        this.isSourceDeleting(parsed.sessionId) &&
        !['members', 'native-result'].includes(String(request.operation))
      )
        throw new Error('collaborationDeletePending');
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
        if (
          typeof input.runId === 'string' &&
          input.runId &&
          (this.metadata.isRoundStopped(delivery.roundId) ||
            room.members.some(member => this.isSourceDeleting(member.sessionId)))
        )
          this.stoppedDuringSetup.add(input.runId);
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
          if (accepted)
            await this.deps
              .onLaunchAccepted?.({
                sessionKey: request.sessionKey,
                sourceRunId: delivery.sourceRunId,
                mode: 'collaboration',
                receiptId: delivery.id,
              })
              .catch((): void => undefined);
          this.notifyNativeAdmission(delivery.roomId, delivery.to);
          this.notifySessionsChanged();
        }
        await this.deps.requestGateway(CollaborationGateway.Resolve, {
          requestId: request.requestId,
          result: { ok: true },
        });
        return;
      }
      if (request.operation === 'review') {
        const source = room?.members.find(member => member.sessionKey === request.sessionKey);
        const input = request.input as Record<string, unknown> | undefined;
        if (
          !room ||
          !source ||
          !parsed ||
          typeof request.sourceRunId !== 'string' ||
          !input ||
          Object.keys(input).some(key => key !== 'review') ||
          !this.deps.getStore().getAgent(source.agentId)?.enabled ||
          this.deps.getStore().getSession(source.sessionId)?.agentId !== parsed.agentId ||
          this.stoppedDuringSetup.has(request.sourceRunId)
        )
          throw new Error('collaborationInvalidReview');
        const deliveries = this.metadata.listDeliveries(room.id);
        if (
          !deliveries.some(
            delivery => delivery.to === source.agentId && delivery.runId === request.sourceRunId,
          ) &&
          deliveries.some(
            delivery =>
              delivery.to === source.agentId && delivery.state === 'dispatching' && !delivery.runId,
          )
        )
          await this.waitForNativeAdmission(room.id, source.agentId, request.expiresAt);
        this.assertRequestActive(request.expiresAt);
        this.assertSourceAdmission(source.sessionId);
        if (
          this.stoppedDuringSetup.has(request.sourceRunId) ||
          !this.deps.getStore().getAgent(source.agentId)?.enabled ||
          this.deps.getStore().getSession(source.sessionId)?.agentId !== parsed.agentId
        )
          throw new Error('collaborationInvalidReview');
        result = {
          review: this.metadata.reviews.report(
            room.id,
            request.sessionKey,
            request.sourceRunId,
            input.review,
          ),
        };
        this.notifySessionsChanged();
        await this.deps.requestGateway(CollaborationGateway.Resolve, {
          requestId: request.requestId,
          result,
        });
        return;
      }
      if (request.operation === 'seal') {
        const source = room?.members.find(member => member.sessionKey === request.sessionKey);
        if (
          !room ||
          !source ||
          source.sessionId !== room.anchorSessionId ||
          typeof request.sourceRunId !== 'string' ||
          this.stoppedDuringSetup.has(request.sourceRunId)
        )
          throw new Error('collaborationInvalidRound');
        let deliveries = this.metadata.listDeliveries(room.id);
        let incoming = deliveries.find(
          delivery =>
            delivery.to === source.agentId &&
            delivery.runId === request.sourceRunId &&
            ['dispatching', 'accepted'].includes(delivery.state),
        );
        const userRun = this.deps
          .getStore()
          .getSessionRuns(source.sessionId)
          .find(
            run =>
              run.rootRunId === request.sourceRunId || run.clientTurnId === request.sourceRunId,
          );
        if (
          !incoming &&
          !userRun &&
          deliveries.some(
            delivery =>
              delivery.to === source.agentId && delivery.state === 'dispatching' && !delivery.runId,
          )
        ) {
          await this.waitForNativeAdmission(room.id, source.agentId, request.expiresAt);
          this.assertRequestActive(request.expiresAt);
          deliveries = this.metadata.listDeliveries(room.id);
          incoming = deliveries.find(
            delivery =>
              delivery.to === source.agentId &&
              delivery.runId === request.sourceRunId &&
              ['dispatching', 'accepted'].includes(delivery.state),
          );
        }
        if (
          this.metadata.isDeleting(room.id) ||
          this.isSourceDeleting(source.sessionId) ||
          this.stoppedDuringSetup.has(request.sourceRunId) ||
          !this.deps.getStore().getAgent(source.agentId)?.enabled
        )
          throw new Error('collaborationInvalidRound');
        const roundId =
          incoming?.roundId ?? (userRun?.state === 'running' ? userRun.clientTurnId : undefined);
        if (!roundId) throw new Error('collaborationInvalidRound');
        this.metadata.sealRound(room.id, roundId, request.sourceRunId);
        this.notifySessionsChanged();
        await this.deps.requestGateway(CollaborationGateway.Resolve, {
          requestId: request.requestId,
          result: { rounds: this.metadata.rounds(room.id) },
        });
        return;
      }
      if (request.operation === 'native-send') {
        const input = request.input as { sessionKey?: unknown; message?: unknown };
        const target = room?.members.find(member => member.sessionKey === input?.sessionKey);
        if (!target) throw new Error('collaborationInvalidRecipient');
        request.input = { to: target.agentId, message: input.message };
      }
      if (request.operation === 'create' || request.operation === 'discussion') {
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
          this.assertSourceAdmission(parsed.sessionId);
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
        const operation =
          request.operation === 'discussion'
            ? (input: unknown, identity: string, guard: () => void) => {
                if (!this.deps.discussion) throw new Error('agentUnavailable');
                return this.deps.discussion(parsed!.sessionId, input, identity, guard);
              }
            : this.deps.createAssistant;
        if (!operation) throw new Error('agentUnavailable');
        result = await operation(
          request.input,
          JSON.stringify([request.sessionKey, request.sourceRunId, request.toolCallId]),
          assertActive,
        );
        if (
          request.operation === 'discussion' &&
          result &&
          typeof result === 'object' &&
          (result as { accepted?: unknown }).accepted === true &&
          ['running', 'ready'].includes(String((result as { state?: unknown }).state))
        ) {
          const receiptId = (result as { discussionId?: unknown }).discussionId;
          if (typeof receiptId === 'string')
            await this.deps
              .onLaunchAccepted?.({
                sessionKey: request.sessionKey,
                sourceRunId: request.sourceRunId as string,
                mode: 'discussion',
                receiptId,
              })
              .catch((): void => undefined);
        }
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
          ...(room
            ? {
                deliveries: this.metadata.listDeliveries(room.id).slice(-32),
                reviews: this.metadata.reviews.list(room.id).slice(-32),
              }
            : {}),
          limits: this.limits(room),
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
                  .filter(agent => agent.enabled && agent.id !== parsed.agentId)
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
          limits: this.limits(room),
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
        let previous = deliveries.find(
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
              delivery.to === source.agentId && delivery.state === 'dispatching' && !delivery.runId,
          )
        ) {
          // Native sessions_send starts the recipient before the sender's after_tool_call
          // reports its run id. Give that acknowledgement a short bounded window so a fast
          // recipient reply is not rejected as an unrelated run.
          await this.waitForNativeAdmission(room.id, source.agentId, request.expiresAt);
          this.assertRequestActive(request.expiresAt);
          this.assertSourceAdmission(source.sessionId);
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
        if (previous?.from === input.to) input.inReplyTo = previous.id;
        this.assertRequestActive(request.expiresAt);
        this.assertSourceAdmission(source.sessionId);
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
    const results = await Promise.allSettled([
      this.stopPeers(sessionId),
      this.deps.stopDiscussions?.(sessionId),
    ]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;
  }
  /** Cancel only the selected native execution, without the room-wide sessionStopped cascade. */
  async stopMember(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('collaborationInvalidMessage');
    const record = value as Record<string, unknown>;
    const fields = ['sourceSessionId', 'roomId', 'targetSessionKey', 'nativeSessionId', 'runId'];
    if (
      Object.keys(record).length !== fields.length ||
      fields.some(
        field =>
          typeof record[field] !== 'string' ||
          !(record[field] as string).trim() ||
          (record[field] as string).length > 256,
      )
    )
      throw new Error('collaborationInvalidMessage');
    const input = value as CollaborationStopMemberInput;
    const assertMember = () => {
      const room = this.metadata.getRoomForSession(input.sourceSessionId);
      const target = room?.members.find(member => member.sessionKey === input.targetSessionKey);
      if (
        !room ||
        room.id !== input.roomId ||
        room.anchorSessionId !== input.sourceSessionId ||
        !target ||
        this.metadata.isMemberDeleted(room.id, target.sessionId) ||
        this.deps.getStore().getSession(target.sessionId)?.agentId !== target.agentId
      )
        throw new Error('collaborationInvalidRecipient');
      return target;
    };
    const target = assertMember();
    const described = await this.deps.requestGateway<{
      session?: {
        key?: string;
        sessionId?: string;
        activeRunIds?: string[];
        hasActiveRun?: boolean;
      };
    }>('sessions.describe', { key: target.sessionKey });
    if (
      described.session?.key !== target.sessionKey ||
      described.session.sessionId !== input.nativeSessionId
    )
      throw new Error('collaborationStateConflict');
    if (Array.isArray(described.session.activeRunIds)) {
      if (!described.session.activeRunIds.includes(input.runId))
        throw new Error('collaborationStateConflict');
    } else {
      // Native embedded owners intentionally omit an incomplete activeRunIds set.
      // Read their exact live snapshot without retaining any returned messages.
      if (described.session.hasActiveRun !== true) throw new Error('collaborationStateConflict');
      const history = await this.deps.requestGateway<{
        sessionId?: string;
        sessionInfo?: { key?: string; sessionId?: string };
        inFlightRun?: { runId?: string };
      }>('chat.history', { sessionKey: target.sessionKey, limit: 1, maxBytes: 16_384 });
      if (
        history.sessionId !== input.nativeSessionId ||
        history.sessionInfo?.sessionId !== input.nativeSessionId ||
        history.sessionInfo.key !== target.sessionKey ||
        history.inFlightRun?.runId !== input.runId
      )
        throw new Error('collaborationStateConflict');
    }
    const current = assertMember();
    if (current.sessionId !== target.sessionId || current.agentId !== target.agentId)
      throw new Error('collaborationStateConflict');
    // A run ID keeps a delayed Stop from aborting a replacement execution. Do not
    // clear this session's future inputs or mark receipts settled from a Stop ACK.
    const result = await this.deps.requestGateway<{
      ok?: boolean;
      status?: string;
      abortedRunId?: string | null;
    }>('sessions.abort', { key: target.sessionKey, runId: input.runId });
    if (
      result.ok !== true ||
      !['aborted', 'no-active-run'].includes(result.status ?? '') ||
      (result.status === 'aborted' && result.abortedRunId !== input.runId)
    )
      throw new Error('collaborationStopFailed');
  }
  private async stopPeers(sessionId: string): Promise<void> {
    const room = this.metadata.getRoomForSession(sessionId);
    if (!room) return;
    const existing = this.stoppingRooms.get(room.id);
    if (existing) return existing;
    for (const member of room.members)
      for (const run of this.deps.getStore().getSessionRuns(member.sessionId)) {
        this.metadata.beginRound(room.id, run.clientTurnId);
      }
    // Freeze admission synchronously so already-admitted peer calls cannot slip
    // into an old round while native cancellation is waiting to start.
    this.metadata.stopRounds(room.id);
    // Publish the shared wait before native cancellation can synchronously emit
    // sessionStopped and re-enter the room-wide cascade.
    const stopping = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(
        room.members
          .filter(member => !this.metadata.isMemberDeleted(room.id, member.sessionId))
          .map(member => this.deps.getRouter().stopSession(member.sessionId)),
      );
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed) throw failed.reason;
    });
    this.stoppingRooms.set(room.id, stopping);
    try {
      await stopping;
    } finally {
      if (this.stoppingRooms.get(room.id) === stopping) this.stoppingRooms.delete(room.id);
    }
  }
}
