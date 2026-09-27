import {
  ChatBubbleLeftEllipsisIcon,
  CommandLineIcon,
  FolderIcon,
  GlobeAltIcon,
} from '@heroicons/react/24/outline';

import { i18nService } from '@/services/i18n';

interface DisplayPanelLauncherProps {
  browserDisabled?: boolean;
  filesDisabled?: boolean;
  onCreateBrowser: () => void;
  onCreateSideChat?: () => void;
  onCreateTerminal: () => void;
  onOpenFiles?: () => void;
  onOpenReview?: () => void;
  sideChatDisabled?: boolean;
  terminalDisabled?: boolean;
}

const launcherButtonClassName =
  'mx-auto flex h-10 w-full max-w-72 items-center gap-2.5 rounded-lg bg-surface-raised px-3 text-left text-sm font-medium text-foreground transition-colors hover:bg-surface-overlay disabled:cursor-not-allowed disabled:opacity-40';

const DisplayPanelLauncher = ({
  browserDisabled = false,
  filesDisabled = false,
  onCreateBrowser,
  onCreateSideChat,
  onCreateTerminal,
  onOpenFiles,
  onOpenReview,
  sideChatDisabled = false,
  terminalDisabled = false,
}: DisplayPanelLauncherProps) => (
  <div className="flex h-full flex-col justify-center gap-1.5 bg-background p-6">
    {onCreateSideChat && (
      <button
        type="button"
        disabled={sideChatDisabled}
        onClick={onCreateSideChat}
        className={launcherButtonClassName}
      >
        <ChatBubbleLeftEllipsisIcon className="h-4 w-4 shrink-0 text-secondary" />
        <span>{i18nService.t('sideChatTitle')}</span>
      </button>
    )}
    {onOpenReview && (
      <button type="button" className={launcherButtonClassName} onClick={onOpenReview}>
        <FolderIcon className="h-4 w-4 shrink-0 text-secondary" />
        <span>{i18nService.t('reviewTitle')}</span>
      </button>
    )}
    {onOpenFiles && (
      <button
        type="button"
        disabled={filesDisabled}
        onClick={onOpenFiles}
        className={launcherButtonClassName}
      >
        <FolderIcon className="h-4 w-4 shrink-0 text-secondary" />
        <span>{i18nService.t('coworkWorkspaceFiles')}</span>
      </button>
    )}
    <button
      type="button"
      disabled={browserDisabled}
      onClick={onCreateBrowser}
      className={launcherButtonClassName}
    >
      <GlobeAltIcon className="h-4 w-4 shrink-0 text-secondary" />
      <span>{i18nService.t('coworkNewBrowserTab')}</span>
    </button>
    <button
      type="button"
      disabled={terminalDisabled}
      onClick={onCreateTerminal}
      className={launcherButtonClassName}
    >
      <CommandLineIcon className="h-4 w-4 shrink-0 text-secondary" />
      <span>{i18nService.t('coworkNewTerminalTab')}</span>
    </button>
  </div>
);

export default DisplayPanelLauncher;
