import { runtime } from '@app-plugin/sdk/browser-runtime';
import type { AppUiServices } from '@app-plugin/sdk/ui';

const ui = runtime.services.ui as AppUiServices;
const primitives = runtime.services.primitives;
const styles = runtime.services.composerStyles;
export const i18nService = ui.i18n;
export const useOwnerWindow = ui.useOwnerWindow;
export const ChatMessageDisplay = primitives.ChatMessageDisplay;
export const UserMessageContent = primitives.UserMessageContent;
export const ComposerFeatureMenu = primitives.ComposerFeatureMenu;
export const RunControlButton = primitives.RunControlButton;
export const COMPOSER_FRAME_CLASS = styles.COMPOSER_FRAME_CLASS;
export const COMPOSER_SURFACE_CLASS = styles.COMPOSER_SURFACE_CLASS;
export const COMPOSER_TEXTAREA_CLASS = styles.COMPOSER_TEXTAREA_CLASS;
export interface ComposerFeatureItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect(): void;
  children?: ComposerFeatureItem[];
}
