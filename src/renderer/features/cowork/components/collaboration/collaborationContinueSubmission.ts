import type { CollaborationContinueTarget } from '@shared/cowork/agent-team/collaboration';
import { isLocalAudioAttachment } from '@shared/speech/localAsr';

import { coworkService } from '@/features/cowork/coworkService';
import type { CoworkAttachmentPayload } from '@/features/cowork/coworkTypes';
import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import { isImagePath } from '../composer/composerAttachmentFiles';
import type {
  CollaborationContinueRequest,
  CollaborationContinueStatus,
} from './collaborationContinueDraft';
import { collaborationMemberTurnId } from './collaborationContinueDraft';

interface ContinueSubmissionContext {
  target: CollaborationContinueTarget;
  cwd: string;
  assertCurrent: () => void;
  supportsImages: () => boolean;
  stageAudio: (
    path: string,
    cwd: string,
  ) => Promise<{ success: boolean; path?: string; error?: string }>;
  readImage: (path: string) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  /** Refresh the exact source/room/member admission after any slow attachment work. */
  beforeSubmit: () => Promise<void>;
  submit: (
    target: CollaborationContinueTarget,
    message: string,
    images: CoworkAttachmentPayload[],
    clientTurnId: string,
  ) => Promise<CollaborationContinueStatus>;
}

/** A user turn for the selected member, independent of the source chat and its drafts. */
export async function submitCollaborationContinuation(
  input: CollaborationContinueRequest,
  context: ContinueSubmissionContext,
): Promise<CollaborationContinueStatus> {
  if (!input.message.trim() || input.message.trimStart().startsWith('/')) return 'rejected';
  context.assertCurrent();
  const images: CoworkAttachmentPayload[] = [];
  const media: string[] = [];
  for (const path of input.attachmentPaths ?? []) {
    context.assertCurrent();
    if (isLocalAudioAttachment(path)) {
      const staged = await context.stageAudio(path, context.cwd);
      context.assertCurrent();
      if (!staged.success || !staged.path)
        throw new Error(staged.error || 'collaborationContinuationUnavailable');
      media.push(staged.path);
    } else if (isImagePath(path)) {
      if (!context.supportsImages()) throw new Error('imageInputNotSupported');
      const read = await context.readImage(path);
      context.assertCurrent();
      const match = read.success && read.dataUrl?.match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (!match) throw new Error(read.error || 'collaborationContinuationUnavailable');
      images.push({
        name: path.split(/[\\/]/).pop() ?? path,
        mimeType: match[1],
        base64Data: match[2],
      });
    } else media.push(path);
  }
  const display = [
    input.message,
    ...media.map(path => `MEDIA:${path.replace(/[\r\n]/g, '')}`),
  ].join('\n');
  context.assertCurrent();
  await context.beforeSubmit();
  context.assertCurrent();
  return context.submit(
    context.target,
    display,
    images,
    collaborationMemberTurnId(input.requestId),
  );
}

/** Keep both the native send and its metadata bound to the same member controller. */
export async function sendCollaborationMemberMessage(
  controller: ChatController,
  target: CollaborationContinueTarget,
  message: string,
  images: CoworkAttachmentPayload[],
  clientTurnId: string,
  assertCurrent: () => void,
  beforeSend: () => Promise<void>,
  service: Pick<
    typeof coworkService,
    | 'reconcileSessionPermissionMode'
    | 'beginSessionRun'
    | 'bindSessionRun'
    | 'markSessionRunUnknown'
    | 'failSessionRun'
  > = coworkService,
): Promise<CollaborationContinueStatus> {
  const client = controller.state.client;
  const nativeSessionId = controller.state.currentSessionId;
  const hello = controller.state.hello;
  const assertMember = () => {
    assertCurrent();
    if (
      !client ||
      !nativeSessionId ||
      controller.state.client !== client ||
      controller.state.hello !== hello ||
      !controller.state.connected ||
      controller.state.sessionKey !== target.targetSessionKey ||
      controller.state.currentSessionId !== nativeSessionId ||
      !controller.state.initialHistoryReady ||
      controller.state.historyReadFailed ||
      controller.state.chatSending ||
      controller.state.transcript.activeTurn?.status === 'running' ||
      controller.hasUnconfirmedQueuedInput()
    )
      throw new Error('collaborationContinuationUnavailable');
  };
  assertMember();
  const permission = await service.reconcileSessionPermissionMode(target.targetSessionId);
  if (!permission.success) throw new Error(permission.error || 'permissionModeSaveFailed');
  assertMember();
  const timing = await service.beginSessionRun({
    sessionId: target.targetSessionId,
    clientTurnId,
    startedAt: Date.now(),
  });
  let unknown = false;
  try {
    await beforeSend();
    assertMember();
    await controller.sendMessage(message, images, message, {
      propagateRequestFailure: true,
      expectedSessionKey: target.targetSessionKey,
      clientTurnId,
      isCancelled: () => {
        try {
          assertCurrent();
          return (
            controller.state.client !== client ||
            controller.state.hello !== hello ||
            controller.state.currentSessionId !== nativeSessionId
          );
        } catch {
          return true;
        }
      },
      onRunBound: runId => service.bindSessionRun(timing.id, runId, target.targetSessionId),
      onRequestUnknown: async () => {
        unknown = true;
        await service.markSessionRunUnknown({ sessionId: target.targetSessionId, id: timing.id });
      },
    });
    return 'target_accepted';
  } catch (error) {
    if (unknown) return 'unknown';
    await service.failSessionRun(target.targetSessionId, timing.id);
    throw error;
  }
}
