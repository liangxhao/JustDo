import { runtime } from '@app-plugin/sdk/browser-runtime';

import type { AppUiServices } from '@app-plugin/sdk/ui';
import { rendering } from '@app-plugin/sdk/rendering';

const services = runtime.services.ui as AppUiServices;
export const i18nService = services.i18n;
export const Modal = services.Modal;
export const useOwnerDocument = services.useOwnerDocument;
export const OwnerDocumentProvider = services.OwnerDocumentProvider;
export const useOwnerWindow = services.useOwnerWindow;
export const isComposerSendShortcut = services.isComposerSendShortcut;
export const isDomNode = (value: unknown): value is Node =>
  Boolean(value && typeof value === 'object' && 'nodeType' in value);
export const toSanitizedMarkdownHtml = rendering.toSanitizedMarkdownHtml;
export const normalizeMessage = rendering.normalizeMessage;
const primitives = runtime.services.primitives;
export const ChatAvatar = primitives.ChatAvatar;
export const LoadingDots = primitives.LoadingDots;
export const ChatMessageDisplay = primitives.ChatMessageDisplay;
export const PreviewMarkdown = primitives.PreviewMarkdown;
export const SessionSubtaskButton = primitives.SessionSubtaskButton;
export const LocalSpeechInputButton = primitives.LocalSpeechInputButton;
export const RunControlButton = primitives.RunControlButton;
export const {
  COMPOSER_FRAME_CLASS,
  COMPOSER_SURFACE_CLASS,
  COMPOSER_TEXTAREA_CLASS,
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  resizeComposerTextarea,
} = runtime.services.composerStyles;
