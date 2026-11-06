import React from 'react';
import { flushSync } from 'react-dom';
import { appJsxRuntime } from '@/features/plugins/app/jsxRuntime';

import ChatAvatar from '@/features/cowork/components/chat/ChatAvatar';
import ChatMessageDisplay from '@/features/cowork/components/chat/ChatMessageDisplay';
import NativeSessionHistory from '@/features/cowork/components/chat/NativeSessionHistory';
import { UserMessageContent } from '@/features/cowork/components/chat/UserMessageContent';
import ComposerFeatureMenu from '@/features/cowork/components/composer/ComposerFeatureMenu';
import * as composerStyles from '@/features/cowork/components/composer/draft/composerStyles';
import { LocalSpeechInputButton } from '@/features/cowork/components/composer/speech/LocalSpeechInputButton';
import { RunControlButton } from '@/features/cowork/components/composer/submission/RunControlButton';
import { isComposerSendShortcut } from '@/features/cowork/components/composer/sendShortcut';
import PreviewMarkdown from '@/features/cowork/components/preview/PreviewMarkdown';
import SessionSubtaskButton from '@/features/cowork/components/subagents/SessionSubtaskButton';
import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown/markdown';
import { normalizeMessage } from '@/libs/openclaw-chat/pipeline/message-normalizer';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import LoadingDots from '@/shared/components/ui/LoadingDots';
import { OwnerDocumentContext, useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';
import { createStyleScopedPortal } from '@/shared/dom/styleScope';

export const runtime = {
  React,
  createPortal: createStyleScopedPortal,
  flushSync,
  ...appJsxRuntime,
  services: {
    ui: {
      i18n: i18nService,
      Modal,
      useOwnerDocument,
      useOwnerWindow,
      isComposerSendShortcut,
      OwnerDocumentProvider: OwnerDocumentContext.Provider,
    },
    composerStyles,
    primitives: {
      LoadingDots,
      ChatMessageDisplay,
      ChatAvatar,
      PreviewMarkdown,
      LocalSpeechInputButton,
      SessionSubtaskButton,
      UserMessageContent,
      ComposerFeatureMenu,
      RunControlButton,
    },
    rendering: { toSanitizedMarkdownHtml, normalizeMessage },
  },
};
export { NativeSessionHistory };
