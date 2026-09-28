/** @vitest-environment jsdom */
import { configureStore } from '@reduxjs/toolkit';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { afterEach, expect, it, vi } from 'vitest';

import { selectDraftAttachments } from '@/features/cowork/coworkSelectors';
import coworkReducer from '@/features/cowork/coworkSlice';
import type { RootState } from '@/store';

import AttachmentCard from './AttachmentCard';
import { useComposerAttachments } from './useComposerAttachments';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function HomeComposer({ isRunActive = false }: { isRunActive?: boolean }) {
  const dispatch = useDispatch();
  const attachments = useSelector((state: RootState) => selectDraftAttachments(state, '__home__'));
  const [isAddingFile, setIsAddingFile] = useState(false);
  const [, setIsDraggingFiles] = useState(false);
  const [, setImageVisionHint] = useState(false);
  const handlers = useComposerAttachments({
    dispatch,
    draftKey: '__home__',
    workingDirectory: '',
    disabled: false,
    isRunActive,
    modelSupportsImage: true,
    setImageVisionHint,
    supportsAttachments: true,
    isAddingFile,
    setIsAddingFile,
    attachments,
    dragDepthRef: useRef(0),
    setIsDraggingFiles,
  });
  return (
    <div data-testid="composer" onDrop={handlers.handleDrop}>
      {attachments.map(attachment => (
        <AttachmentCard
          key={attachment.path}
          attachment={attachment}
          onRemove={handlers.handleRemoveAttachment}
        />
      ))}
    </div>
  );
}

function setup(isRunActive = false) {
  const dialog = {
    getPathForFile: vi.fn<(file: File) => string>().mockReturnValue(''),
    saveInlineFile: vi.fn().mockResolvedValue({ success: false, path: null }),
    readFileAsDataUrl: vi.fn().mockResolvedValue({ success: false }),
  };
  vi.stubGlobal('electron', { dialog });
  const store = configureStore({ reducer: { cowork: coworkReducer } });
  render(
    <Provider store={store}>
      <HomeComposer isRunActive={isRunActive} />
    </Provider>,
  );
  const drop = (...files: File[]) =>
    fireEvent.drop(screen.getByTestId('composer'), { dataTransfer: { files, types: ['Files'] } });
  return { dialog, store, drop };
}

it('keeps multiple native file cards in the home draft without staging even above 25 MB', async () => {
  const { dialog, store, drop } = setup();
  const files = [new File(['report'], 'report.pdf'), new File(['archive'], 'archive.zip')];
  Object.defineProperty(files[1], 'size', { value: 30 * 1024 * 1024 });
  dialog.getPathForFile.mockImplementation(file => `C:\\用户 文件\\${file.name}`);

  drop(...files);

  await waitFor(() => expect(screen.getByText('archive.zip')).toBeTruthy());
  expect(screen.getByText('report.pdf')).toBeTruthy();
  expect(store.getState().cowork.draftAttachments.__home__?.map(item => item.path)).toEqual([
    'C:\\用户 文件\\report.pdf',
    'C:\\用户 文件\\archive.zip',
  ]);
  expect(dialog.saveInlineFile).not.toHaveBeenCalled();
});

it('keeps a native image attachment when its preview cannot be read', async () => {
  const { dialog, store, drop } = setup();
  dialog.getPathForFile.mockReturnValue('C:\\photo.png');

  drop(new File(['image'], 'photo.png', { type: 'image/png' }));

  await waitFor(() => expect(screen.getByText('photo.png')).toBeTruthy());
  expect(store.getState().cowork.draftAttachments.__home__?.[0]).toMatchObject({
    path: 'C:\\photo.png',
    isImage: true,
  });
  expect(dialog.saveInlineFile).not.toHaveBeenCalled();
});

it('stages files without native paths and displays the resulting attachment', async () => {
  const { dialog, drop } = setup();
  dialog.saveInlineFile.mockResolvedValue({ success: true, path: 'C:\\temp\\note.txt' });

  drop(new File(['note'], 'note.txt', { type: 'text/plain' }));

  await waitFor(() => expect(screen.getByText('note.txt')).toBeTruthy());
  expect(dialog.saveInlineFile).toHaveBeenCalledWith({
    dataBase64: 'bm90ZQ==',
    fileName: 'note.txt',
    mimeType: 'text/plain',
    cwd: '',
  });
});

it('does not add dropped files while a run is active', () => {
  const { dialog, store, drop } = setup(true);

  drop(new File(['note'], 'note.txt'));

  expect(dialog.getPathForFile).not.toHaveBeenCalled();
  expect(store.getState().cowork.draftAttachments.__home__).toBeUndefined();
});
