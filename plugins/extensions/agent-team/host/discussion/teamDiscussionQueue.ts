import { createHash } from 'node:crypto';

import type { DiscussionResources } from '../../contracts/agentTeamSettings';
import {
  parseTeamDiscussionSend,
  TeamDiscussionGateway,
  type TeamDiscussionHoldingIdentity,
  type TeamDiscussionRoom,
  type TeamDiscussionSend,
} from '../../contracts/teamDiscussion';
import {
  pendingInputFingerprint,
  type PendingInputRecord,
  type TeamDiscussionQueueStore,
} from '../data/teamDiscussionQueueStore';
import type { TeamDiscussionStore } from '../data/teamDiscussionStore';
import {
  discussionAttachmentFingerprint,
  stageDiscussionAttachments,
} from './teamDiscussionAttachments';

interface QueueContext {
  metadata: TeamDiscussionStore;
  queue: TeamDiscussionQueueStore;
  room: (id: unknown) => TeamDiscussionRoom;
  assertEnabled: (room: TeamDiscussionRoom) => void;
  admissionRevision: () => number;
  sourcePolicy: (room: TeamDiscussionRoom) => unknown;
  resources: (room: TeamDiscussionRoom, rounds: number) => DiscussionResources;
  ensureReady: () => Promise<unknown>;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  requestConnectedGateway?: <T>(method: string, params?: unknown) => Promise<T>;
  send: (
    send: TeamDiscussionSend,
    assertCurrent: () => void,
    input: PendingInputRecord,
  ) => Promise<TeamDiscussionRoom>;
  onChanged: () => void;
}
interface SavedInput {
  state: 'saved' | 'cancelled' | 'unknown';
  requestId: string;
  fingerprint: string;
  entryId?: string;
  identity?: TeamDiscussionHoldingIdentity;
}

/** Serial product admission around native storage and the existing native discussion service. */
export class TeamDiscussionQueueCoordinator {
  private readonly dispatching = new Set<string>();
  constructor(private readonly context: QueueContext) {
    context.queue.recover();
  }
  private snapshot(room: TeamDiscussionRoom): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          room.revision,
          room.cwd,
          room.permissionMode,
          room.readOnly,
          room.summarySource,
          room.members.map(({ agentId, sessionId, lifecycleRevision, ownership, sessionKey }) => ({
            agentId,
            sessionId,
            lifecycleRevision,
            ownership,
            sessionKey,
          })),
          this.context.sourcePolicy(room),
        ]),
      )
      .digest('hex');
  }
  private assertCurrent(input: PendingInputRecord, state: 'receiving' | 'dispatching'): void {
    const { queue, room: getRoom, assertEnabled } = this.context;
    const room = getRoom(input.roomId);
    assertEnabled(room);
    if (
      queue.get(input.roomId, input.requestId)?.state !== state ||
      queue.generation(input.roomId) !== input.generation ||
      this.snapshot(room) !== input.snapshotHash
    )
      throw new Error('teamDiscussionSessionChanged');
  }
  async enqueue(value: unknown): Promise<TeamDiscussionRoom> {
    const {
      queue,
      metadata,
      room: getRoom,
      assertEnabled,
      requestGateway: request,
      onChanged,
    } = this.context;
    const send = parseTeamDiscussionSend(value);
    const admissionRevision = this.context.admissionRevision();
    const room = getRoom(send.roomId);
    assertEnabled(room);
    const previous = queue.get(room.id, send.requestId);
    if (previous) {
      if (previous.fingerprint !== pendingInputFingerprint(send))
        throw new Error('teamDiscussionRequestConflict');
      // A replay reads the receipt; it never repeats a native append or a launch.
      return getRoom(room.id);
    }
    if (metadata.requestRevision(room.id, send.requestId) !== undefined)
      throw new Error('teamDiscussionRequestConflict');
    if (['interrupted', 'stopping', 'deleting', 'preparing', 'prepare_failed'].includes(room.state))
      throw new Error('teamDiscussionBusy');
    const summary = metadata.summary(metadata.latestRun(room.id)?.discussionId ?? '');
    if (summary?.state === 'unknown' || summary?.state === 'stopping')
      throw new Error('teamDiscussionOutcomeUnknown');
    const generation = queue.generation(room.id);
    const snapshotHash = this.snapshot(room);
    await this.context.ensureReady();
    const validated = await request<{ valid: boolean; error?: string }>(
      TeamDiscussionGateway.Validate,
      { room, send },
    );
    if (!validated.valid) throw new Error(validated.error || 'teamDiscussionInvalidInput');
    assertEnabled(getRoom(room.id));
    if (
      admissionRevision !== this.context.admissionRevision() ||
      generation !== queue.generation(room.id) ||
      snapshotHash !== this.snapshot(getRoom(room.id))
    )
      throw new Error('teamDiscussionSessionChanged');
    const concurrent = queue.get(room.id, send.requestId);
    if (concurrent) {
      if (concurrent.fingerprint !== pendingInputFingerprint(send))
        throw new Error('teamDiscussionRequestConflict');
      return getRoom(room.id);
    }
    const input = queue.reserve(
      getRoom(room.id),
      send,
      snapshotHash,
      this.context.resources(room, send.rounds),
    );
    onChanged();
    let storageAttempted = false;
    try {
      this.assertCurrent(input, 'receiving');
      const attachments = await stageDiscussionAttachments(
        room.cwd,
        `pending-${createHash('sha256')
          .update(JSON.stringify([room.id, input.generation, send.requestId]))
          .digest('hex')}`,
        send.attachmentPaths,
      );
      const nativeSend = {
        ...send,
        ...(send.attachmentPaths ? { attachmentPaths: attachments } : {}),
      };
      const attachmentFingerprint = await discussionAttachmentFingerprint(attachments);
      this.assertCurrent(input, 'receiving');
      storageAttempted = true;
      const identity = await request<TeamDiscussionHoldingIdentity>(
        TeamDiscussionGateway.HoldingPrepare,
        {
          roomId: room.id,
          generation: input.generation,
          agentId: room.summarySource?.agentId ?? room.members[0].agentId,
          cwd: room.cwd,
        },
      );
      this.assertCurrent(input, 'receiving');
      const fingerprint = pendingInputFingerprint(nativeSend);
      if (!queue.setIdentity(input, identity, fingerprint, attachmentFingerprint))
        throw new Error('teamDiscussionBusy');
      this.assertCurrent(input, 'receiving');
      const saved = await request<SavedInput>(TeamDiscussionGateway.HoldingSave, {
        identity,
        send: nativeSend,
        fingerprint,
      });
      if (saved.state === 'cancelled')
        queue.transition(input, ['receiving', 'receiving_unknown'], 'cancelled');
      else if (
        saved.state !== 'saved' ||
        !saved.entryId ||
        saved.requestId !== input.requestId ||
        saved.fingerprint !== fingerprint
      )
        throw new Error('teamDiscussionOutcomeUnknown');
      else queue.confirm(input, saved.entryId);
      onChanged();
      return getRoom(room.id);
    } catch (error) {
      queue.transition(input, ['receiving'], storageAttempted ? 'receiving_unknown' : 'failed');
      onChanged();
      if (queue.get(room.id, input.requestId)?.state === 'cancelled') return getRoom(room.id);
      if (storageAttempted) throw new Error('teamDiscussionOutcomeUnknown');
      throw error;
    }
  }
  async cancel(value: unknown): Promise<TeamDiscussionRoom> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('teamDiscussionInvalidInput');
    const input = value as { roomId?: unknown; requestId?: unknown };
    if (
      Object.keys(input).some(key => !['roomId', 'requestId'].includes(key)) ||
      typeof input.requestId !== 'string'
    )
      throw new Error('teamDiscussionInvalidInput');
    const room = this.context.room(input.roomId);
    const cancelled = this.context.queue.cancel(room.id, input.requestId);
    this.context.onChanged();
    // A product tombstone is definitive for an inert input even if native cleanup is offline.
    await this.context
      .requestConnectedGateway?.(TeamDiscussionGateway.HoldingCancel, {
        roomId: room.id,
        generation: this.context.queue.generation(room.id),
        requestIds: [cancelled.requestId],
      })
      .catch(() => {});
    return this.context.room(room.id);
  }
  async cancelAll(roomId: string): Promise<void> {
    const generation = this.context.queue.cancelAll(roomId);
    this.context.onChanged();
    await this.context
      .requestConnectedGateway?.(TeamDiscussionGateway.HoldingCancel, { roomId, generation })
      .catch(() => {});
  }
  async project(room: TeamDiscussionRoom): Promise<TeamDiscussionRoom> {
    const pendingInputs = this.context.queue.projection(room.id);
    for (const projection of pendingInputs) {
      const input = this.context.queue.get(room.id, projection.requestId);
      if (!input?.identity || !input.nativeFingerprint || !this.context.queue.isActive(input))
        continue;
      try {
        const native = await this.context.requestGateway<{
          send: TeamDiscussionSend;
          entryId: string;
        }>(TeamDiscussionGateway.HoldingRead, {
          identity: input.identity,
          requestId: input.requestId,
          fingerprint: input.nativeFingerprint,
          ...(input.entryId ? { entryId: input.entryId } : {}),
        });
        const send = parseTeamDiscussionSend(native.send);
        if (
          send.requestId === input.requestId &&
          send.roomId === room.id &&
          pendingInputFingerprint(send) === input.nativeFingerprint
        )
          projection.message = send.message;
      } catch {
        /* Metadata remains readable; unavailable native body is not reconstructed. */
      }
    }
    return { ...room, pendingInputs };
  }
  async reconcile(): Promise<void> {
    const { queue, metadata, requestConnectedGateway: request } = this.context;
    if (!request) return;
    // Explicit plugin disable cancels native saved receipts; connection loss does not.
    for (const room of metadata.list().filter(item => queue.hasActive(item.id))) {
      for (const input of queue.list(room.id, true)) {
        if (['dispatching', 'unknown'].includes(input.state)) {
          if (this.dispatching.has(room.id)) continue;
          const run = metadata.runs(room.id).find(item => item.requestId === input.requestId);
          if (run) {
            try {
              const status = await request<{ roomId: string; discussionId: string; state: string }>(
                TeamDiscussionGateway.Status,
                { roomId: room.id, discussionId: run.discussionId },
              );
              if (
                status.roomId === room.id &&
                status.discussionId === run.discussionId &&
                ['running', 'completed', 'failed', 'cancelled'].includes(status.state)
              ) {
                queue.transition(input, ['dispatching', 'unknown'], 'dispatched');
                this.context.onChanged();
              }
            } catch {
              /* Metadata or a stop request cannot prove native admission. */
            }
          }
          if (queue.get(room.id, input.requestId)?.state === 'dispatching') {
            queue.transition(input, ['dispatching'], 'unknown');
          }
          continue;
        }
        if (
          !input.identity ||
          !input.nativeFingerprint ||
          !['receiving_unknown', 'queued'].includes(input.state)
        )
          continue;
        try {
          const receipt = await request<SavedInput>(TeamDiscussionGateway.HoldingStatus, {
            identity: input.identity,
            requestId: input.requestId,
            fingerprint: input.nativeFingerprint,
          });
          if (receipt.state === 'cancelled')
            queue.transition(input, ['receiving_unknown', 'queued'], 'cancelled');
          else if (
            receipt.state === 'saved' &&
            receipt.entryId &&
            receipt.requestId === input.requestId &&
            receipt.fingerprint === input.nativeFingerprint
          )
            queue.confirm(input, receipt.entryId);
        } catch {
          /* No write, no retry and no inference from a missing receipt. */
        }
      }
      await this.dispatch(room.id);
    }
  }
  private async dispatch(roomId: string): Promise<void> {
    const { queue, metadata, requestConnectedGateway: request } = this.context;
    if (!request || this.dispatching.has(roomId)) return;
    const input = queue.list(roomId, true)[0];
    if (
      !input ||
      input.state !== 'queued' ||
      !input.identity ||
      !input.entryId ||
      !input.nativeFingerprint
    )
      return;
    // Read-only health before claiming prevents a closed optional service from releasing a queue.
    try {
      const health = await request<{ available: boolean }>(TeamDiscussionGateway.Health);
      if (!health.available) return;
    } catch {
      return;
    }
    if (!queue.claim(input)) return;
    this.dispatching.add(roomId);
    let started = false;
    try {
      this.assertCurrent(input, 'dispatching');
      const read = await request<{ send: TeamDiscussionSend; entryId: string }>(
        TeamDiscussionGateway.HoldingRead,
        {
          identity: input.identity,
          requestId: input.requestId,
          fingerprint: input.nativeFingerprint,
          entryId: input.entryId,
        },
      );
      const send = parseTeamDiscussionSend(read.send);
      if (
        read.entryId !== input.entryId ||
        send.requestId !== input.requestId ||
        send.roomId !== roomId ||
        pendingInputFingerprint(send) !== input.nativeFingerprint
      )
        throw new Error('teamDiscussionRequestConflict');
      if (
        (await discussionAttachmentFingerprint(send.attachmentPaths)) !==
        input.attachmentFingerprint
      )
        throw new Error('teamDiscussionAttachmentChanged');
      let resources: DiscussionResources;
      try {
        resources = this.context.resources(this.context.room(roomId), input.rounds);
      } catch {
        throw new Error('teamDiscussionResourcesChanged');
      }
      if (
        resources.maxRounds < input.resources.maxRounds ||
        resources.maxTurns < input.resources.maxTurns ||
        resources.maxConcurrent < input.resources.maxConcurrent
      )
        throw new Error('teamDiscussionResourcesChanged');
      this.assertCurrent(input, 'dispatching');
      started = true;
      await this.context.send(send, () => this.assertCurrent(input, 'dispatching'), input);
      queue.transition(input, ['dispatching', 'unknown'], 'dispatched');
    } catch (error) {
      const reserved = metadata.runs(roomId).find(run => run.requestId === input.requestId);
      const unknown = error instanceof Error && error.message === 'teamDiscussionOutcomeUnknown';
      const cancelled = queue.generation(roomId) !== input.generation && !unknown;
      queue.transition(
        input,
        ['dispatching', 'unknown'],
        cancelled ? 'cancelled' : started && unknown ? 'unknown' : 'blocked',
        reserved && unknown
          ? 'teamDiscussionOutcomeUnknown'
          : error instanceof Error && /^teamDiscussion[A-Za-z]+$/.test(error.message)
            ? error.message
            : 'teamDiscussionHistoryUnavailable',
      );
    } finally {
      this.dispatching.delete(roomId);
      this.context.onChanged();
    }
  }
}
