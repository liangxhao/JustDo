import { coworkService } from '@/features/cowork/coworkService';
import type { CoworkAttachmentPayload } from '@/features/cowork/coworkTypes';
import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

/** Keep both the native send and its metadata bound to the same member controller. */
export async function sendNativeHistoryMessage(
  controller: ChatController,
  target: { productSessionId: string; sessionKey: string },
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
): Promise<'accepted' | 'unknown'> {
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
      controller.state.sessionKey !== target.sessionKey ||
      controller.state.currentSessionId !== nativeSessionId ||
      !controller.state.initialHistoryReady ||
      controller.state.historyReadFailed ||
      controller.state.chatSending ||
      controller.state.transcript.activeTurn?.status === 'running' ||
      controller.hasUnconfirmedQueuedInput()
    )
      throw new Error('appPluginSubmitUnavailable');
  };
  assertMember();
  const permission = await service.reconcileSessionPermissionMode(target.productSessionId);
  if (!permission.success) throw new Error(permission.error || 'permissionModeSaveFailed');
  assertMember();
  const timing = await service.beginSessionRun({
    sessionId: target.productSessionId,
    clientTurnId,
    startedAt: Date.now(),
  });
  let unknown = false;
  try {
    await beforeSend();
    assertMember();
    await controller.sendMessage(message, images, message, {
      propagateRequestFailure: true,
      expectedSessionKey: target.sessionKey,
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
      onRunBound: runId => service.bindSessionRun(timing.id, runId, target.productSessionId),
      onRequestUnknown: async () => {
        unknown = true;
        await service.markSessionRunUnknown({ sessionId: target.productSessionId, id: timing.id });
      },
    });
    return 'accepted';
  } catch (error) {
    if (unknown) return 'unknown';
    await service.failSessionRun(target.productSessionId, timing.id);
    throw error;
  }
}
