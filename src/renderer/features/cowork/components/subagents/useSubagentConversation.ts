import type { CoworkSubagentConversationTarget } from '@shared/cowork/subagentDetails';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { sendNativeHistoryMessage } from '@/features/cowork/components/chat/nativeHistorySend';
import { coworkService } from '@/features/cowork/coworkService';
import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '@/services/i18n';

interface Options {
  controller: ChatController | null;
  parentSessionId: string;
  sessionKey?: string;
  isObscured: boolean;
  childRunning: boolean;
}

function readConnection(controller: ChatController | null, sessionKey?: string) {
  if (!controller || !sessionKey) return null;
  const state = controller.state;
  if (
    state.sessionKey !== sessionKey ||
    !state.connected ||
    !state.client ||
    !state.hello ||
    !state.currentSessionId ||
    !state.initialHistoryReady ||
    state.historyReadFailed ||
    state.historyPreparationPending
  )
    return null;
  return {
    controller,
    client: state.client,
    generation: state.client.generation,
    hello: state.hello,
    sessionId: state.currentSessionId,
  };
}

type Connection = NonNullable<ReturnType<typeof readConnection>>;

function sameConnection(left: Connection | null, right: Connection | null): boolean {
  if (left === right) return true;
  return Boolean(
    left &&
    right &&
    left.controller === right.controller &&
    left.client === right.client &&
    left.generation === right.generation &&
    left.hello === right.hello &&
    left.sessionId === right.sessionId,
  );
}

export function useSubagentConversation({
  controller,
  parentSessionId,
  sessionKey,
  isObscured,
  childRunning,
}: Options) {
  const [connection, setConnection] = useState(() => readConnection(controller, sessionKey));
  const [controllerBusy, setControllerBusy] = useState(false);
  const [target, setTarget] = useState<{
    connection: Connection;
    conversation: CoworkSubagentConversationTarget;
    parentSessionId: string;
  }>();
  const [sendError, setSendError] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const operationPending = useRef(false);
  const drawerScope = useRef<symbol | null>(null);

  useLayoutEffect(() => {
    drawerScope.current = isObscured ? null : Symbol();
    return () => {
      drawerScope.current = null;
    };
  }, [controller, isObscured, parentSessionId, sessionKey]);

  useEffect(() => {
    if (!controller) return;
    const refresh = () => {
      const next = readConnection(controller, sessionKey);
      setConnection(previous => (sameConnection(previous, next) ? previous : next));
      setControllerBusy(
        controller.state.chatSending ||
          controller.state.transcript.activeTurn?.status === 'running' ||
          controller.hasUnconfirmedQueuedInput(),
      );
    };
    refresh();
    return controller.subscribe(refresh);
  }, [controller, sessionKey]);

  useEffect(() => {
    if (!sessionKey || !connection || connection.controller !== controller) return;
    let current = true;
    void window.electron?.cowork
      ?.getSubagentConversation?.(parentSessionId, sessionKey, connection.sessionId)
      .then(result => {
        if (!current || !sameConnection(connection, readConnection(controller, sessionKey))) return;
        const conversation = result.success ? result.target : undefined;
        setTarget(
          conversation?.sessionKey === sessionKey && conversation.sessionId === connection.sessionId
            ? { connection, conversation, parentSessionId }
            : undefined,
        );
      })
      .catch(() => {
        if (current) setTarget(undefined);
      });
    return () => {
      current = false;
    };
  }, [connection, controller, parentSessionId, sessionKey]);

  useEffect(() => {
    setSendError(undefined);
  }, [parentSessionId, sessionKey]);

  const bound =
    target?.connection.controller === controller &&
    target.parentSessionId === parentSessionId &&
    target.conversation.sessionKey === sessionKey &&
    (!connection || target.conversation.sessionId === connection.sessionId)
      ? target
      : undefined;
  const ready = bound && sameConnection(bound.connection, connection) && !isObscured && !deleting;
  const sendDisabled =
    !ready || bound?.conversation.canSend === false || childRunning || controllerBusy;

  const send = async (message: string): Promise<boolean> => {
    const scope = drawerScope.current;
    if (!bound || !controller || !scope || sendDisabled || operationPending.current) return false;
    const assertCurrent = () => {
      if (
        drawerScope.current !== scope ||
        !sameConnection(bound.connection, readConnection(controller, sessionKey))
      )
        throw new Error('subtaskSendUnavailable');
    };
    operationPending.current = true;
    setSendError(undefined);
    try {
      const result = await sendNativeHistoryMessage(
        controller,
        bound.conversation,
        message,
        [],
        crypto.randomUUID(),
        assertCurrent,
        async () => undefined,
      );
      if (result === 'unknown') {
        void coworkService.refreshSessionRuntimeActivity(bound.conversation.productSessionId, {
          includeSubagents: true,
          forceRefresh: true,
          fullScan: true,
        }).catch(() => undefined);
        if (drawerScope.current === scope) setSendError(i18nService.t('subtaskSendOutcomeUnknown'));
      }
      return true;
    } catch (error) {
      if (drawerScope.current === scope) {
        const message = error instanceof Error ? error.message : 'subtaskSendFailed';
        setSendError(
          i18nService.t(
            message === 'appPluginSubmitUnavailable' ? 'subtaskSendUnavailable' : message,
          ),
        );
      }
      return false;
    } finally {
      operationPending.current = false;
    }
  };

  const remove = async (): Promise<'deleted' | 'failed' | 'stale'> => {
    const scope = drawerScope.current;
    if (
      !bound ||
      !scope ||
      !ready ||
      operationPending.current ||
      !sameConnection(bound.connection, readConnection(controller, sessionKey))
    )
      return 'stale';
    operationPending.current = true;
    setDeleting(true);
    try {
      const { productSessionId, sessionKey, sessionId, lifecycleRevision } = bound.conversation;
      const deleted = await coworkService.deleteSession(productSessionId, {
        sessionKey,
        sessionId,
        ...(lifecycleRevision !== undefined ? { lifecycleRevision } : {}),
      });
      const currentSessionId = controller?.state.currentSessionId;
      if (
        drawerScope.current !== scope ||
        (currentSessionId && currentSessionId !== bound.conversation.sessionId)
      )
        return 'stale';
      return deleted ? 'deleted' : 'failed';
    } catch {
      return drawerScope.current === scope ? 'failed' : 'stale';
    } finally {
      operationPending.current = false;
      setDeleting(false);
    }
  };

  return {
    conversation: bound?.conversation,
    send,
    sendDisabled,
    sendError,
    remove,
    deleting,
    deleteDisabled: !ready,
  };
}
