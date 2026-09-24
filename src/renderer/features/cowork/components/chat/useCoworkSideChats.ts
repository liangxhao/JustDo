import type { Dispatch, UnknownAction } from '@reduxjs/toolkit';
import { useCallback } from 'react';

import { type JustDoChatWrapperRef } from '@/features/cowork/components/chat/JustDoChatWrapper';
import { setDraftPrompt } from '@/features/cowork/coworkSlice';
import type {
  SideChatResult,
  SideChatStreamUpdate,
} from '@/libs/openclaw-chat/gateway/chat-controller';
import { i18nService } from '@/services/i18n';

import type { CoworkSideChatTab } from '../preview/useSessionDisplayState';

const SIDE_CHAT_DISPLAY_TAB_PREFIX = 'side-chat:';

interface CoworkSideChatsOptions {
  currentSessionId: string | null;
  isOpenClawEngine: boolean;
  sideChatSequenceRef: React.MutableRefObject<number>;
  setSideChatTabs: React.Dispatch<React.SetStateAction<CoworkSideChatTab[]>>;
  setPreferredDisplayTabId: React.Dispatch<React.SetStateAction<string | null>>;
  setIsDisplayPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  dispatch: Dispatch<UnknownAction>;
  selectAdjacentDisplayTabAfterClose: (closingId: string) => void;
  chatWrapperRef: React.RefObject<JustDoChatWrapperRef>;
}

export function useCoworkSideChats({
  currentSessionId,
  isOpenClawEngine,
  sideChatSequenceRef,
  setSideChatTabs,
  setPreferredDisplayTabId,
  setIsDisplayPanelOpen,
  dispatch,
  selectAdjacentDisplayTabAfterClose,
  chatWrapperRef,
}: CoworkSideChatsOptions) {
  const handleCreateSideChat = useCallback(() => {
    if (!currentSessionId || currentSessionId.startsWith('temp-') || !isOpenClawEngine) return;
    sideChatSequenceRef.current += 1;
    const number = sideChatSequenceRef.current;
    const id = `${SIDE_CHAT_DISPLAY_TAB_PREFIX}${crypto.randomUUID()}`;
    setSideChatTabs(current => [
      ...current,
      {
        id,
        label: i18nService.t('sideChatTabTitle').replace('{number}', String(number)),
        messages: [],
        sessionId: currentSessionId,
      },
    ]);
    setPreferredDisplayTabId(id);
    setIsDisplayPanelOpen(true);
  }, [
    currentSessionId,
    isOpenClawEngine,
    setIsDisplayPanelOpen,
    setPreferredDisplayTabId,
    setSideChatTabs,
    sideChatSequenceRef,
  ]);

  const closeSideChat = useCallback(
    (tabId: string) => {
      dispatch(setDraftPrompt({ sessionId: tabId, draft: '' }));
      selectAdjacentDisplayTabAfterClose(tabId);
      setSideChatTabs(current => current.filter(tab => tab.id !== tabId));
    },
    [dispatch, selectAdjacentDisplayTabAfterClose, setSideChatTabs],
  );

  const handleSideChatResult = useCallback(
    (result: SideChatResult) => {
      setSideChatTabs(current =>
        current.map(tab => {
          const index = tab.messages.findIndex(message => message.runId === result.runId);
          if (index < 0) return tab;
          const messages = [...tab.messages];
          const previousMessage = messages[index];
          messages[index] = {
            ...previousMessage,
            runId: result.runId,
            question: result.question,
            answer: result.text || i18nService.t('sideChatRunInterrupted'),
            activeTurn: undefined,
            answeredAt: previousMessage.activeTurn?.endedAt ?? Date.now(),
            modelRef: previousMessage.activeTurn?.modelRef ?? previousMessage.modelRef,
            startedAt: previousMessage.activeTurn?.startedAt ?? previousMessage.startedAt,
            status: result.isError ? 'error' : 'complete',
          };
          return { ...tab, messages };
        }),
      );
    },
    [setSideChatTabs],
  );

  const handleSideChatStream = useCallback(
    (update: SideChatStreamUpdate) => {
      setSideChatTabs(current =>
        current.map(tab => {
          const index = tab.messages.findIndex(message => message.runId === update.runId);
          if (index < 0) return tab;
          const messages = [...tab.messages];
          messages[index] = {
            ...messages[index],
            activeTurn: update.turn ?? undefined,
            modelRef: update.turn?.modelRef ?? messages[index].modelRef,
            startedAt: update.turn?.startedAt ?? messages[index].startedAt,
          };
          return { ...tab, messages };
        }),
      );
    },
    [setSideChatTabs],
  );

  const handleSendSideChat = useCallback(
    async (tabId: string, question: string, modelRef?: string | null): Promise<boolean> => {
      const normalizedQuestion = question.trim().replace(/\s*[\r\n]+\s*/g, ' ');
      if (!normalizedQuestion) return false;
      const runId = `justdo-btw-${Date.now()}-${crypto.randomUUID()}`;
      setSideChatTabs(current =>
        current.map(tab =>
          tab.id === tabId
            ? {
                ...tab,
                messages: [
                  ...tab.messages,
                  {
                    runId,
                    question: normalizedQuestion,
                    askedAt: Date.now(),
                    ...(modelRef ? { modelRef } : {}),
                    status: 'pending',
                  },
                ],
              }
            : tab,
        ),
      );
      try {
        const acceptedRunId = await chatWrapperRef.current?.sendSideQuestion(
          normalizedQuestion,
          runId,
        );
        if (!acceptedRunId) throw new Error('Chat controller is not ready');
        if (acceptedRunId !== runId) {
          setSideChatTabs(current =>
            current.map(tab =>
              tab.id === tabId
                ? {
                    ...tab,
                    messages: tab.messages.map(message =>
                      message.runId === runId ? { ...message, runId: acceptedRunId } : message,
                    ),
                  }
                : tab,
            ),
          );
        }
        return true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setSideChatTabs(current =>
          current.map(tab =>
            tab.id === tabId
              ? {
                  ...tab,
                  messages: tab.messages.map(message =>
                    message.runId === runId
                      ? {
                          ...message,
                          answer: i18nService.t('sideChatSendFailed').replace('{error}', detail),
                          activeTurn: undefined,
                          answeredAt: Date.now(),
                          status: 'error',
                        }
                      : message,
                  ),
                }
              : tab,
          ),
        );
        return false;
      }
    },
    [chatWrapperRef, setSideChatTabs],
  );
  return {
    handleCreateSideChat,
    closeSideChat,
    handleSideChatResult,
    handleSideChatStream,
    handleSendSideChat,
  };
}
