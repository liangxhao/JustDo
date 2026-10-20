import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect } from 'react';

import { i18nService } from '@/services/i18n';

import type { OpenMcpAppFile } from '../mcpApps/fileApps';
import type { FilePreview } from './FilePreviewDrawer';
import { isCurrentFilePreviewRequest } from './filePreviewNavigation';
import { createImageFilePreview, IMAGE_PREVIEW_EVENT, isImageFilePath } from './imageFilePreview';

interface FilePreviewEventsOptions {
  currentSessionIdRef: MutableRefObject<string | null>;
  fileDisplayTabId: (filePath: string) => string;
  filePreviewRequestIdRef: MutableRefObject<number>;
  filePreviewsRef: MutableRefObject<FilePreview[]>;
  unsupportedFilePreviewsRef: MutableRefObject<string[]>;
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setIsDisplayPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsWorkspaceFilesOpen: Dispatch<SetStateAction<boolean>>;
  setPreferredDisplayTabId: Dispatch<SetStateAction<string | null>>;
  setUnsupportedFilePreviews: Dispatch<SetStateAction<string[]>>;
  openAppFile?: OpenMcpAppFile;
}

export function useFilePreviewEvents({
  currentSessionIdRef,
  fileDisplayTabId,
  filePreviewRequestIdRef,
  filePreviewsRef,
  unsupportedFilePreviewsRef,
  setFilePreviews,
  setIsDisplayPanelOpen,
  setIsWorkspaceFilesOpen,
  setPreferredDisplayTabId,
  setUnsupportedFilePreviews,
  openAppFile,
}: FilePreviewEventsOptions): void {
  useEffect(() => {
    const openImage = (
      src: string,
      label = '',
      workingDirectory?: string,
      keepWorkspaceFilesOpen = true,
    ) => {
      const preview = createImageFilePreview(src, label, workingDirectory);
      if (!preview) return;
      filePreviewRequestIdRef.current += 1;
      const existing = filePreviewsRef.current.find(
        item =>
          item.kind === 'image' && (item.src === preview.src || item.filePath === preview.filePath),
      );
      if (!existing) {
        filePreviewsRef.current = [...filePreviewsRef.current, preview];
        setFilePreviews(current => [...current, preview]);
      }
      if (!keepWorkspaceFilesOpen) setIsWorkspaceFilesOpen(false);
      setPreferredDisplayTabId(fileDisplayTabId(existing?.filePath ?? preview.filePath));
      setIsDisplayPanelOpen(true);
    };
    const handlePreviewImage = (event: Event) => {
      const detail = (event as CustomEvent<{ src: string; alt?: string }>).detail;
      if (typeof detail?.src === 'string') openImage(detail.src, detail.alt);
    };
    const handlePreviewFile = async (event: Event) => {
      const detail = (
        event as CustomEvent<{
          filePath?: string;
          keepWorkspaceFilesOpen?: boolean;
          workingDirectory?: string;
          openUnsupportedInSystem?: boolean;
          isCurrent?: () => boolean;
        }>
      ).detail;
      if (!detail?.filePath || detail.isCurrent?.() === false) return;
      if (isImageFilePath(detail.filePath)) {
        openImage(detail.filePath, '', detail.workingDirectory, detail.keepWorkspaceFilesOpen);
        return;
      }
      const activeRequestId = ++filePreviewRequestIdRef.current;
      const sourceSessionId = currentSessionIdRef.current;
      const requestIsCurrent = () =>
        detail.isCurrent?.() !== false &&
        isCurrentFilePreviewRequest(
          activeRequestId,
          filePreviewRequestIdRef.current,
          sourceSessionId,
          currentSessionIdRef.current,
        );
      const openInSystem = async () => {
        if (!requestIsCurrent()) return;
        try {
          const result = await window.electron.shell.openPath(
            detail.filePath!,
            detail.workingDirectory,
          );
          if (!result.success && requestIsCurrent()) {
            window.dispatchEvent(
              new CustomEvent('app:showToast', {
                detail: result.notFound
                  ? i18nService
                      .t('coworkAttachmentNotFound')
                      .replace('{filepath}', detail.filePath!)
                  : i18nService.t('coworkUnsupportedFileOpenFailed'),
              }),
            );
          }
        } catch {
          if (requestIsCurrent()) {
            window.dispatchEvent(
              new CustomEvent('app:showToast', {
                detail: i18nService.t('coworkUnsupportedFileOpenFailed'),
              }),
            );
          }
        }
      };
      const requestedTabId = fileDisplayTabId(detail.filePath);
      const existingPreview = filePreviewsRef.current.find(
        preview => fileDisplayTabId(preview.filePath) === requestedTabId,
      );
      const existingUnsupportedPreview = unsupportedFilePreviewsRef.current.find(
        filePath => fileDisplayTabId(filePath) === requestedTabId,
      );
      let result: Awaited<ReturnType<typeof window.electron.shell.readPreviewFile>>;
      try {
        if (!existingPreview && !detail.openUnsupportedInSystem && openAppFile) {
          const opened = await openAppFile({
            filePath: detail.filePath,
            isCurrent: requestIsCurrent,
          });
          if (!requestIsCurrent()) return;
          if (opened) {
            if (detail.keepWorkspaceFilesOpen === false) setIsWorkspaceFilesOpen(false);
            return;
          }
        }
        if (existingPreview || existingUnsupportedPreview) {
          if (!existingPreview && detail.openUnsupportedInSystem) {
            await openInSystem();
            return;
          }
          if (detail.keepWorkspaceFilesOpen === false) setIsWorkspaceFilesOpen(false);
          setPreferredDisplayTabId(requestedTabId);
          setIsDisplayPanelOpen(true);
          return;
        }
        result = await window.electron.shell.readPreviewFile(
          detail.filePath,
          detail.workingDirectory,
        );
      } catch {
        if (requestIsCurrent()) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkFilePreviewFailed'),
            }),
          );
        }
        return;
      }
      if (!requestIsCurrent()) {
        if (result.success) {
          void window.electron.shell
            .revokePreviewFileEdit(result.editToken)
            .catch((): undefined => undefined);
        }
        return;
      }
      if (result.success) {
        const resolvedTabId = fileDisplayTabId(result.filePath);
        const duplicate = filePreviewsRef.current.find(
          preview => fileDisplayTabId(preview.filePath) === resolvedTabId,
        );
        if (duplicate) {
          void window.electron.shell
            .revokePreviewFileEdit(result.editToken)
            .catch((): undefined => undefined);
          if (detail.keepWorkspaceFilesOpen === false) setIsWorkspaceFilesOpen(false);
          setPreferredDisplayTabId(resolvedTabId);
          setIsDisplayPanelOpen(true);
          return;
        }
        const preview: FilePreview = {
          content: result.content,
          editToken: result.editToken,
          filePath: result.filePath,
          version: result.version,
        };
        setFilePreviews(current => [...current, preview]);
        if (detail.keepWorkspaceFilesOpen === false) setIsWorkspaceFilesOpen(false);
        setPreferredDisplayTabId(resolvedTabId);
        setIsDisplayPanelOpen(true);
        return;
      }
      if (detail.openUnsupportedInSystem && (result.unsupportedType || result.tooLarge)) {
        await openInSystem();
        return;
      }
      if (result.unsupportedType) {
        setUnsupportedFilePreviews(current =>
          current.some(filePath => fileDisplayTabId(filePath) === requestedTabId)
            ? current
            : [...current, detail.filePath!],
        );
        if (detail.keepWorkspaceFilesOpen === false) setIsWorkspaceFilesOpen(false);
        setPreferredDisplayTabId(requestedTabId);
        setIsDisplayPanelOpen(true);
        return;
      }
      window.dispatchEvent(
        new CustomEvent('app:showToast', {
          detail: result.notFound
            ? i18nService.t('coworkAttachmentNotFound').replace('{filepath}', detail.filePath)
            : result.tooLarge
              ? i18nService.t('coworkFilePreviewTooLarge')
              : result.error || i18nService.t('coworkFilePreviewFailed'),
        }),
      );
    };
    window.addEventListener('cowork:preview-file', handlePreviewFile);
    window.addEventListener(IMAGE_PREVIEW_EVENT, handlePreviewImage);
    return () => {
      window.removeEventListener('cowork:preview-file', handlePreviewFile);
      window.removeEventListener(IMAGE_PREVIEW_EVENT, handlePreviewImage);
    };
  }, [
    currentSessionIdRef,
    fileDisplayTabId,
    filePreviewRequestIdRef,
    filePreviewsRef,
    unsupportedFilePreviewsRef,
    setFilePreviews,
    setIsDisplayPanelOpen,
    setIsWorkspaceFilesOpen,
    setPreferredDisplayTabId,
    setUnsupportedFilePreviews,
    openAppFile,
  ]);
}
