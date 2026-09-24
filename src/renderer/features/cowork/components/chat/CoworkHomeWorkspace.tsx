import type { BrowserPanelTab } from '@shared/browser/browser';
import { HOME_WORKSPACE_SESSION_ID } from '@shared/preview/filePreview';

import CoworkPromptInput, {
  type CoworkPromptInputRef,
} from '@/features/cowork/components/composer/CoworkPromptInput';
import CoworkDisplayPanel, {
  type CoworkDisplayTab,
} from '@/features/cowork/components/preview/CoworkDisplayPanel';
import DisplayPanelLauncher from '@/features/cowork/components/preview/DisplayPanelLauncher';
import FilePreviewDrawer, {
  type FilePreviewDrawerHandle,
} from '@/features/cowork/components/preview/FilePreviewDrawer';
import NewDisplayTabMenu from '@/features/cowork/components/preview/NewDisplayTabMenu';
import UnsupportedFilePreview from '@/features/cowork/components/preview/UnsupportedFilePreview';
import WorkspaceFilesPanel from '@/features/cowork/components/preview/WorkspaceFilesPanel';
import { coworkService } from '@/features/cowork/coworkService';
import type { CoworkAttachmentPayload, CoworkConfig } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';
import FolderIcon from '@/shared/components/icons/FolderIcon';

import logoUrl from '../../../../../../resources/logo.png';
import { fileDisplayTabId, MAX_BROWSER_TABS, MAX_TERMINAL_TABS } from '../preview/displayTabIds';
import type { FilePreview } from '../preview/FilePreviewDrawer';
import type { CoworkTerminalTab, SessionDisplayState } from '../preview/useSessionDisplayState';

interface CoworkHomeWorkspaceProps {
  windowHeader: React.JSX.Element;
  homeConversationHeader: React.JSX.Element;
  greetingKey: string;
  promptInputRef: React.RefObject<CoworkPromptInputRef>;
  handleStartSession: (
    prompt: string,
    attachments?: CoworkAttachmentPayload[],
    gatewayPrompt?: string,
  ) => Promise<boolean | void>;
  handleStopSession: () => Promise<boolean>;
  isStreaming: boolean;
  isEngineReady: true;
  config: CoworkConfig;
  isDisplayPanelOpen: boolean;
  hasBrowserPanelOpened: boolean;
  terminalTabs: CoworkTerminalTab[];
  filePreviews: FilePreview[];
  unsupportedFilePreviews: string[];
  recordingReviewTabs: {
    tabs: CoworkDisplayTab[];
    panels: (activeId: string | null) => React.JSX.Element[];
  };
  hasRetainedRuntimePanels: boolean;
  activeDisplayTabId: string;
  closeDisplayPanel: () => void;
  browserPanelWidth: number;
  setSessionField: <K extends keyof SessionDisplayState>(
    targetSessionKey: string,
    field: K,
    value: React.SetStateAction<SessionDisplayState[K]>,
  ) => void;
  displaySessionKey: string;
  homeDisplayTabs: CoworkDisplayTab[];
  isWorkspaceFilesOpen: boolean;
  browserTabs: BrowserPanelTab[];
  handleCreateBrowserTab: () => void;
  handleCreateTerminalTab: () => void;
  homeWorkspaceFolderPath: string;
  handleOpenWorkspaceFiles: () => void;
  terminalWorkingDirectory: string;
  activeFilePreview: FilePreview | undefined;
  activeUnsupportedFilePath: string | undefined;
  retainedRuntimePanels: React.JSX.Element[];
  filePreviewDrawerRefs: React.MutableRefObject<Map<string, FilePreviewDrawerHandle>>;
  closeFilePreview: (filePath: string) => Promise<boolean>;
  closeUnsupportedFilePreview: (filePath: string) => void;
}

export function CoworkHomeWorkspace({
  windowHeader,
  homeConversationHeader,
  greetingKey,
  promptInputRef,
  handleStartSession,
  handleStopSession,
  isStreaming,
  isEngineReady,
  config,
  isDisplayPanelOpen,
  hasBrowserPanelOpened,
  terminalTabs,
  filePreviews,
  unsupportedFilePreviews,
  recordingReviewTabs,
  hasRetainedRuntimePanels,
  activeDisplayTabId,
  closeDisplayPanel,
  browserPanelWidth,
  setSessionField,
  displaySessionKey,
  homeDisplayTabs,
  isWorkspaceFilesOpen,
  browserTabs,
  handleCreateBrowserTab,
  handleCreateTerminalTab,
  homeWorkspaceFolderPath,
  handleOpenWorkspaceFiles,
  terminalWorkingDirectory,
  activeFilePreview,
  activeUnsupportedFilePath,
  retainedRuntimePanels,
  filePreviewDrawerRefs,
  closeFilePreview,
  closeUnsupportedFilePreview,
}: CoworkHomeWorkspaceProps) {
  return (
    <div className="cowork-home flex-1 flex flex-col h-full">
      {windowHeader}
      <div className="cowork-display-host relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {homeConversationHeader}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center px-4 py-10">
              <div className="space-y-12">
                {/* Welcome Section */}
                <div className="text-center space-y-5">
                  <img src={logoUrl} alt="logo" className="mx-auto h-[5.333rem] w-[5.333rem]" />
                  <h2 className="text-3xl font-bold tracking-tight text-foreground">
                    {i18nService.t(greetingKey)}
                  </h2>
                  <p className="text-sm text-secondary max-w-md mx-auto">
                    {i18nService.t('coworkGreetingSupport')}
                  </p>
                </div>

                {/* Prompt Input Area - Large version with folder selector */}
                <div className="space-y-3">
                  <div className="shadow-glow-accent rounded-2xl">
                    <CoworkPromptInput
                      ref={promptInputRef}
                      onSubmit={handleStartSession}
                      onStop={handleStopSession}
                      isStreaming={isStreaming}
                      disabled={!isEngineReady}
                      placeholder={i18nService.t('coworkPlaceholder')}
                      size="large"
                      workingDirectory={config.workingDirectory}
                      onWorkingDirectoryChange={async (dir: string) => {
                        await coworkService.updateConfig({ workingDirectory: dir });
                      }}
                      showFolderSelector={true}
                      showModelSelector={true}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {(isDisplayPanelOpen ||
          hasBrowserPanelOpened ||
          terminalTabs.length > 0 ||
          filePreviews.length > 0 ||
          unsupportedFilePreviews.length > 0 ||
          recordingReviewTabs.tabs.length > 0 ||
          hasRetainedRuntimePanels) && (
          <CoworkDisplayPanel
            key="cowork-display-panel"
            activeTabId={activeDisplayTabId ?? ''}
            isOpen={isDisplayPanelOpen}
            onClose={closeDisplayPanel}
            width={browserPanelWidth}
            onWidthChange={width => setSessionField(displaySessionKey, 'browserPanelWidth', width)}
            showEmptyState={homeDisplayTabs.length === 0}
            tabs={homeDisplayTabs}
            emptyState={
              isWorkspaceFilesOpen ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 bg-background p-6 text-center">
                  <FolderIcon className="h-7 w-7 text-muted" />
                  <div className="text-sm font-semibold text-foreground">
                    {i18nService.t('coworkWorkspaceFilesOpenTitle')}
                  </div>
                  <div className="text-xs text-secondary">
                    {i18nService.t('coworkWorkspaceFilesOpenDescription')}
                  </div>
                </div>
              ) : (
                <DisplayPanelLauncher
                  browserDisabled={browserTabs.length >= MAX_BROWSER_TABS}
                  onCreateBrowser={handleCreateBrowserTab}
                  onCreateTerminal={handleCreateTerminalTab}
                  onOpenFiles={homeWorkspaceFolderPath ? handleOpenWorkspaceFiles : undefined}
                  terminalDisabled={
                    !terminalWorkingDirectory || terminalTabs.length >= MAX_TERMINAL_TABS
                  }
                />
              )
            }
            sidePanel={
              isWorkspaceFilesOpen && homeWorkspaceFolderPath ? (
                <WorkspaceFilesPanel
                  key={`${HOME_WORKSPACE_SESSION_ID}:${homeWorkspaceFolderPath}`}
                  activeFilePath={activeFilePreview?.filePath ?? activeUnsupportedFilePath}
                  sessionId={HOME_WORKSPACE_SESSION_ID}
                  onOpenFile={filePath => {
                    window.dispatchEvent(
                      new CustomEvent('cowork:preview-file', {
                        detail: {
                          filePath,
                          keepWorkspaceFilesOpen: true,
                          workingDirectory: homeWorkspaceFolderPath,
                        },
                      }),
                    );
                  }}
                />
              ) : undefined
            }
            actions={
              <NewDisplayTabMenu
                browserDisabled={browserTabs.length >= MAX_BROWSER_TABS}
                onCreateBrowser={handleCreateBrowserTab}
                onCreateTerminal={handleCreateTerminalTab}
                onOpenFiles={homeWorkspaceFolderPath ? handleOpenWorkspaceFiles : undefined}
                terminalDisabled={
                  !terminalWorkingDirectory || terminalTabs.length >= MAX_TERMINAL_TABS
                }
              />
            }
          >
            {retainedRuntimePanels}
            {recordingReviewTabs.panels(activeDisplayTabId)}
            {filePreviews.map(preview => (
              <FilePreviewDrawer
                key={fileDisplayTabId(preview.filePath)}
                ref={drawer => {
                  const tabId = fileDisplayTabId(preview.filePath);
                  if (drawer) filePreviewDrawerRefs.current.set(tabId, drawer);
                  else filePreviewDrawerRefs.current.delete(tabId);
                }}
                preview={preview}
                onClose={() => void closeFilePreview(preview.filePath)}
                isObscured={activeFilePreview?.filePath !== preview.filePath}
                embedded
              />
            ))}
            {unsupportedFilePreviews.map(filePath => (
              <UnsupportedFilePreview
                key={fileDisplayTabId(filePath)}
                filePath={filePath}
                onClose={() => closeUnsupportedFilePreview(filePath)}
                isObscured={activeUnsupportedFilePath !== filePath}
              />
            ))}
          </CoworkDisplayPanel>
        )}
      </div>
    </div>
  );
}
