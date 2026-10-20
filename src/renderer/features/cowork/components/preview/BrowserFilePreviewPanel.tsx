import { ArrowTopRightOnSquareIcon, FolderOpenIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { BrowserFilePreview } from '@shared/preview/filePreview';
import { useContext, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';

import { FilePreviewToolbarContext } from '../shared/FilePreviewToolbarContext';
import MediaFilePreview from './MediaFilePreview';
import NativeFilePreview from './NativeFilePreview';

export default function BrowserFilePreviewPanel({
  preview,
  onClose,
  isObscured = false,
  embedded = false,
}: {
  preview: BrowserFilePreview;
  onClose: () => void;
  isObscured?: boolean;
  embedded?: boolean;
}) {
  const sharedToolbarTarget = useContext(FilePreviewToolbarContext);
  const toolbarTarget = embedded ? sharedToolbarTarget : null;
  const [isShowingInFolder, setIsShowingInFolder] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const actions = (
    <>
      <button
        type="button"
        className="rounded p-2 text-secondary hover:bg-surface-raised"
        disabled={isOpening}
        aria-label={i18nService.t('coworkUnsupportedFileOpenDefault')}
        title={i18nService.t('coworkUnsupportedFileOpenDefault')}
        onClick={() => {
          setIsOpening(true);
          void window.electron.shell
            .openPath(preview.filePath)
            .then(result => {
              if (!result.success) throw new Error('Unable to open file');
            })
            .catch(() =>
              window.dispatchEvent(
                new CustomEvent('app:showToast', {
                  detail: i18nService.t('coworkUnsupportedFileOpenFailed'),
                }),
              ),
            )
            .finally(() => setIsOpening(false));
        }}
      >
        <ArrowTopRightOnSquareIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        className="rounded p-2 text-secondary hover:bg-surface-raised"
        disabled={isShowingInFolder}
        aria-label={i18nService.t('coworkFilePreviewShowInFolder')}
        title={i18nService.t('coworkFilePreviewShowInFolder')}
        onClick={() => {
          setIsShowingInFolder(true);
          void window.electron.shell
            .showItemInFolder(preview.filePath)
            .then(result => {
              if (!result.success) throw new Error('Unable to show file');
            })
            .catch(() => {
              window.dispatchEvent(
                new CustomEvent('app:showToast', {
                  detail: i18nService.t('coworkFilePreviewShowInFolderFailed'),
                }),
              );
            })
            .finally(() => setIsShowingInFolder(false));
        }}
      >
        <FolderOpenIcon className="h-4 w-4" />
      </button>
      {!toolbarTarget && (
        <button
          type="button"
          className="rounded p-2 text-secondary hover:bg-surface-raised"
          aria-label={i18nService.t('close')}
          title={i18nService.t('close')}
          onClick={onClose}
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      )}
    </>
  );
  return (
    <section
      className={`absolute inset-0 flex min-h-0 flex-col bg-background ${isObscured ? 'invisible' : ''}`}
      aria-hidden={isObscured || undefined}
    >
      {!toolbarTarget && (
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {preview.filePath.split(/[\\/]/u).pop()}
          </span>
          {actions}
        </header>
      )}
      {toolbarTarget &&
        !isObscured &&
        createPortal(
          <div className="flex shrink-0 items-center gap-1">{actions}</div>,
          toolbarTarget,
        )}
      {preview.kind === 'pdf' ? (
        <NativeFilePreview
          key={preview.url}
          filePath={preview.filePath}
          url={preview.url}
          isVisible={!isObscured}
        />
      ) : (
        <MediaFilePreview
          key={preview.url}
          url={preview.url}
          kind={preview.kind}
          isVisible={!isObscured}
        />
      )}
    </section>
  );
}
