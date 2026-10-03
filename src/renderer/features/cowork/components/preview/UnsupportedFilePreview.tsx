import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  FolderOpenIcon,
  Squares2X2Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useContext, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';

import { FilePreviewToolbarContext } from './FilePreviewToolbarContext';
import WorkspaceFileIcon from './WorkspaceFileIcon';

interface UnsupportedFilePreviewProps {
  filePath: string;
  isObscured?: boolean;
  onClose: () => void;
}

type PendingAction = 'default' | 'folder' | 'open-with' | null;

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const UnsupportedFilePreview = ({
  filePath,
  isObscured = false,
  onClose,
}: UnsupportedFilePreviewProps) => {
  const toolbarTarget = useContext(FilePreviewToolbarContext);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const fileName = filePath.split(/[\\/]/).pop() || filePath;

  const runAction = async (
    action: Exclude<PendingAction, null>,
    operation: () => Promise<{
      success: boolean;
      error?: string;
      notFound?: boolean;
      unavailable?: boolean;
    }>,
  ) => {
    setPendingAction(action);
    try {
      const result = await operation();
      if (result.success) return;
      if (result.notFound) {
        showToast(i18nService.t('coworkUnsupportedFileNotFound'));
      } else if (result.unavailable) {
        showToast(i18nService.t('coworkUnsupportedFileOpenWithUnavailable'));
      } else {
        showToast(result.error || i18nService.t('coworkUnsupportedFileOpenFailed'));
      }
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : i18nService.t('coworkUnsupportedFileOpenFailed'),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const compactButtonClass =
    'inline-flex h-8 w-8 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-50';
  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-secondary hover:bg-surface-raised hover:text-foreground"
      aria-label={i18nService.t('close')}
      title={i18nService.t('close')}
    >
      <XMarkIcon className="h-4 w-4" />
    </button>
  );
  const fileActions = (
    <>
      <button
        type="button"
        title={i18nService.t('coworkUnsupportedFileShowInFolder')}
        disabled={pendingAction !== null}
        onClick={() =>
          void runAction('folder', () => window.electron.shell.showItemInFolder(filePath))
        }
        className={
          toolbarTarget
            ? compactButtonClass
            : 'flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface-raised px-4 text-sm font-medium text-foreground hover:bg-surface-overlay disabled:opacity-50'
        }
      >
        {pendingAction === 'folder' ? (
          <ArrowPathIcon className="h-4 w-4 animate-spin" />
        ) : (
          <FolderOpenIcon className="h-4 w-4" />
        )}
        <span className={toolbarTarget ? 'sr-only' : undefined}>
          {i18nService.t('coworkUnsupportedFileShowInFolder')}
        </span>
      </button>
      <button
        type="button"
        title={i18nService.t('coworkUnsupportedFileOpenDefault')}
        disabled={pendingAction !== null}
        onClick={() => void runAction('default', () => window.electron.shell.openPath(filePath))}
        className={
          toolbarTarget
            ? compactButtonClass
            : 'flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50'
        }
      >
        {pendingAction === 'default' ? (
          <ArrowPathIcon className="h-4 w-4 animate-spin" />
        ) : (
          <ArrowTopRightOnSquareIcon className="h-4 w-4" />
        )}
        <span className={toolbarTarget ? 'sr-only' : undefined}>
          {i18nService.t('coworkUnsupportedFileOpenDefault')}
        </span>
      </button>
      <button
        type="button"
        title={i18nService.t('coworkUnsupportedFileOpenWith')}
        disabled={pendingAction !== null}
        onClick={() =>
          void runAction('open-with', () => window.electron.shell.openPathWith(filePath))
        }
        className={
          toolbarTarget
            ? compactButtonClass
            : 'flex h-10 items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-surface-raised disabled:opacity-50'
        }
      >
        {pendingAction === 'open-with' ? (
          <ArrowPathIcon className="h-4 w-4 animate-spin" />
        ) : (
          <Squares2X2Icon className="h-4 w-4" />
        )}
        <span className={toolbarTarget ? 'sr-only' : undefined}>
          {i18nService.t('coworkUnsupportedFileOpenWith')}
        </span>
      </button>
    </>
  );

  return (
    <section
      className={`absolute inset-0 flex min-h-0 flex-col bg-background ${isObscured ? 'hidden' : ''}`}
      aria-hidden={isObscured || undefined}
      aria-label={i18nService.t('coworkUnsupportedFilePreviewTitle')}
    >
      {!toolbarTarget && (
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <WorkspaceFileIcon fileName={fileName} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground" title={fileName}>
              {fileName}
            </div>
            <div className="truncate text-xs text-muted" title={filePath}>
              {filePath}
            </div>
          </div>
          {closeButton}
        </header>
      )}
      {toolbarTarget &&
        !isObscured &&
        createPortal(
          <div className="flex shrink-0 items-center gap-1">{fileActions}</div>,
          toolbarTarget,
        )}

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
        <div className="flex w-full max-w-md flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-surface-raised">
            <WorkspaceFileIcon fileName={fileName} />
          </div>
          <h2 className="text-base font-semibold text-foreground">
            {i18nService.t('coworkUnsupportedFilePreviewTitle')}
          </h2>
          <p className="mt-2 text-sm leading-6 text-secondary">
            {i18nService.t('coworkUnsupportedFilePreviewDescription')}
          </p>
          {!toolbarTarget && <div className="mt-6 grid w-full gap-2">{fileActions}</div>}
        </div>
      </div>
    </section>
  );
};

export default UnsupportedFilePreview;
