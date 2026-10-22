// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { CoworkPromptInputRef } from '@/features/cowork/components/composer/CoworkPromptInput';
import type { FilePreviewDrawerHandle } from '@/features/cowork/components/preview/FilePreviewDrawer';
import { i18nService } from '@/services/i18n';

import { fileDisplayTabId } from '../display/tabs/displayTabIds';
import { renderCoworkHomeWorkspace } from './CoworkHomeWorkspace';

vi.mock('@/features/cowork/components/composer/CoworkPromptInput', () => ({
  default: () => null,
}));
vi.mock('@/features/cowork/components/status/CoworkPet', () => ({ CoworkPet: () => null }));

function HomeMediaWorkspace({ detached = false }: { detached?: boolean }) {
  const [open, setOpen] = useState(true);
  const promptInputRef = useRef<CoworkPromptInputRef>(null);
  const filePreviewDrawerRefs = useRef(new Map<string, FilePreviewDrawerHandle>());
  const preview = {
    kind: 'audio' as const,
    filePath: 'E:/work/sound.mp3',
    url: 'file:///E:/work/sound.mp3',
  };
  const tabId = fileDisplayTabId(preview.filePath);
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen workspace</button>
      {renderCoworkHomeWorkspace({
        homeConversationHeader: <div />,
        maximumBrowserTabs: 20,
        greetingKey: 'coworkGreetingMorning',
        promptInputRef,
        handleStartSession: async () => undefined,
        handleStopSession: async () => true,
        isStreaming: false,
        isEngineReady: true,
        config: {
          workingDirectory: 'E:/work',
          executionMode: 'local',
          agentEngine: 'openclaw',
          permissionMode: 'auto',
        },
        isDisplayPanelOpen: open,
        isWorkspaceDetached: detached,
        hasBrowserPanelOpened: false,
        terminalTabs: [],
        filePreviews: [preview],
        unsupportedFilePreviews: [],
        recordingReviewTabs: { tabs: [], panels: () => [] },
        mcpAppTabs: { tabs: [], panels: () => [] },
        hasRetainedRuntimePanels: false,
        activeDisplayTabId: tabId,
        closeDisplayPanel: () => setOpen(false),
        browserPanelWidth: 760,
        setSessionField: () => undefined,
        displaySessionKey: '__home__',
        homeDisplayTabs: [{ id: tabId, label: 'sound.mp3', icon: null, onSelect: () => undefined }],
        isWorkspaceFilesOpen: false,
        browserTabs: [],
        handleCreateBrowserTab: () => undefined,
        handleCreateTerminalTab: () => undefined,
        homeWorkspaceFolderPath: '',
        handleOpenWorkspaceFiles: () => undefined,
        terminalWorkingDirectory: '',
        activeFilePreview: preview,
        activeUnsupportedFilePath: undefined,
        retainedRuntimePanels: [],
        filePreviewDrawerRefs,
        closeFilePreview: async () => true,
        closeUnsupportedFilePreview: () => undefined,
      })}
    </>
  );
}

beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  Object.defineProperty(window, 'electron', { configurable: true, value: {} });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.restoreAllMocks();
});

it('pauses retained media when the home workspace closes and waits for user playback on reopen', async () => {
  render(<HomeMediaWorkspace />);
  const media = document.querySelector('audio')!;
  await act(async () => media.play());
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkDisplayPanelClose') }));
  expect(media.pause).toHaveBeenCalledOnce();
  expect(document.querySelector('audio')).toBe(media);
  expect(media.getAttribute('src')).toBe('localmedia://local/E:/work/sound.mp3');
  fireEvent.click(screen.getByRole('button', { name: 'Reopen workspace' }));
  expect(document.querySelector('audio')).toBe(media);
  expect(media.play).toHaveBeenCalledOnce();
  expect(media.autoplay).toBe(false);
});

it('keeps media playing while the workspace remains visible in a detached window', async () => {
  render(<HomeMediaWorkspace detached />);
  const media = document.querySelector('audio')!;
  await act(async () => media.play());
  fireEvent.click(screen.getByRole('button', { name: i18nService.t('coworkDisplayPanelClose') }));
  expect(document.querySelector('audio')).toBe(media);
  expect(media.pause).not.toHaveBeenCalled();
});
