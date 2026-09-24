import type { Dispatch, UnknownAction } from '@reduxjs/toolkit';
import React, { useCallback } from 'react';

import {
  addDraftAttachment,
  type DraftAttachment,
  setDraftAttachments,
} from '@/features/cowork/coworkSlice';
import { i18nService } from '@/services/i18n';

import { getFileNameFromPath, isImageMimeType, isImagePath } from './composerAttachmentFiles';

interface ComposerAttachmentsOptions {
  dispatch: Dispatch<UnknownAction>;
  draftKey: string;
  workingDirectory: string;
  disabled: boolean;
  isRunActive: boolean;
  modelSupportsImage: boolean;
  setImageVisionHint: React.Dispatch<React.SetStateAction<boolean>>;
  supportsAttachments: boolean;
  isAddingFile: boolean;
  setIsAddingFile: React.Dispatch<React.SetStateAction<boolean>>;
  attachments: DraftAttachment[];
  dragDepthRef: React.MutableRefObject<number>;
  setIsDraggingFiles: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useComposerAttachments({
  dispatch,
  draftKey,
  workingDirectory,
  disabled,
  isRunActive,
  modelSupportsImage,
  setImageVisionHint,
  supportsAttachments,
  isAddingFile,
  setIsAddingFile,
  attachments,
  dragDepthRef,
  setIsDraggingFiles,
}: ComposerAttachmentsOptions) {
  const addAttachment = useCallback(
    (filePath: string, imageInfo?: { isImage: boolean; dataUrl?: string }) => {
      if (!filePath) return;
      dispatch(
        addDraftAttachment({
          draftKey,
          attachment: {
            path: filePath,
            name: getFileNameFromPath(filePath),
            isImage: imageInfo?.isImage,
            dataUrl: imageInfo?.dataUrl,
          },
        }),
      );
    },
    [dispatch, draftKey],
  );

  const addImageAttachmentFromDataUrl = useCallback(
    (name: string, dataUrl: string) => {
      // Use the dataUrl as the unique key (no file path for inline images)
      const pseudoPath = `inline:${name}:${Date.now()}`;
      dispatch(
        addDraftAttachment({
          draftKey,
          attachment: {
            path: pseudoPath,
            name,
            isImage: true,
            dataUrl,
          },
        }),
      );
    },
    [dispatch, draftKey],
  );

  const fileToDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }
        resolve(result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  const getNativeFilePath = useCallback((file: File): string | null => {
    const maybePath = (file as File & { path?: string }).path;
    if (typeof maybePath === 'string' && maybePath.trim()) {
      return maybePath;
    }
    return null;
  }, []);

  const saveInlineFile = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        const dataBase64 = await fileToBase64(file);
        if (!dataBase64) {
          return null;
        }
        const result = await window.electron.dialog.saveInlineFile({
          dataBase64,
          fileName: file.name,
          mimeType: file.type,
          cwd: workingDirectory,
        });
        if (result.success && result.path) {
          return result.path;
        }
        return null;
      } catch (error) {
        console.error('Failed to save inline file:', error);
        return null;
      }
    },
    [fileToBase64, workingDirectory],
  );

  const handleIncomingFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (disabled || isRunActive) return;
      const files = Array.from(fileList ?? []);
      if (files.length === 0) return;

      let hasImageWithoutVision = false;
      for (const file of files) {
        const nativePath = getNativeFilePath(file);

        // Check if this is an image file and model supports images
        const fileIsImage = nativePath ? isImagePath(nativePath) : isImageMimeType(file.type);

        if (fileIsImage) {
          hasImageWithoutVision ||= !modelSupportsImage;
          if (nativePath) {
            try {
              const result = await window.electron.dialog.readFileAsDataUrl(nativePath);
              if (result.success && result.dataUrl) {
                addAttachment(nativePath, { isImage: true, dataUrl: result.dataUrl });
                continue;
              }
            } catch (error) {
              console.error('Failed to read image as data URL:', error);
            }
            addAttachment(nativePath, { isImage: true });
            continue;
          }
          let dataUrl: string | null = null;
          try {
            dataUrl = await fileToDataUrl(file);
          } catch (error) {
            console.error('Failed to read clipboard image as data URL:', error);
          }
          const stagedPath = await saveInlineFile(file);
          if (stagedPath) {
            addAttachment(stagedPath, { isImage: true, dataUrl: dataUrl ?? undefined });
          } else if (dataUrl) {
            addImageAttachmentFromDataUrl(file.name, dataUrl);
          } else {
            console.error('Failed to process clipboard image');
          }
          continue;
        }

        // Non-image file or model doesn't support images: use original flow
        if (nativePath) {
          addAttachment(nativePath);
          continue;
        }

        const stagedPath = await saveInlineFile(file);
        if (stagedPath) {
          addAttachment(stagedPath);
        }
      }
      if (hasImageWithoutVision) {
        setImageVisionHint(true);
      }
    },
    [
      addAttachment,
      addImageAttachmentFromDataUrl,
      disabled,
      fileToDataUrl,
      getNativeFilePath,
      isRunActive,
      modelSupportsImage,
      saveInlineFile,
      setImageVisionHint,
    ],
  );

  const handleAddFile = useCallback(async () => {
    if (!supportsAttachments || isAddingFile || disabled || isRunActive) return;
    setIsAddingFile(true);
    try {
      const result = await window.electron.dialog.selectFiles({
        title: i18nService.t('coworkAddFile'),
      });
      if (!result.success || result.paths.length === 0) return;
      let hasImageWithoutVision = false;
      for (const filePath of result.paths) {
        if (isImagePath(filePath)) {
          hasImageWithoutVision ||= !modelSupportsImage;
          try {
            const readResult = await window.electron.dialog.readFileAsDataUrl(filePath);
            if (readResult.success && readResult.dataUrl) {
              addAttachment(filePath, { isImage: true, dataUrl: readResult.dataUrl });
              continue;
            }
          } catch (error) {
            console.error('Failed to read image as data URL:', error);
          }
          addAttachment(filePath, { isImage: true });
          continue;
        }
        addAttachment(filePath);
      }
      if (hasImageWithoutVision) {
        setImageVisionHint(true);
      }
    } catch (error) {
      console.error('Failed to select file:', error);
    } finally {
      setIsAddingFile(false);
    }
  }, [
    addAttachment,
    disabled,
    isAddingFile,
    isRunActive,
    modelSupportsImage,
    setImageVisionHint,
    setIsAddingFile,
    supportsAttachments,
  ]);

  const handleRemoveAttachment = useCallback(
    (path: string) => {
      dispatch(
        setDraftAttachments({
          draftKey,
          attachments: attachments.filter(attachment => attachment.path !== path),
        }),
      );
    },
    [attachments, dispatch, draftKey],
  );

  const hasFileTransfer = (dataTransfer: DataTransfer | null): boolean => {
    if (!dataTransfer) return false;
    if (dataTransfer.files.length > 0) return true;
    return Array.from(dataTransfer.types).includes('Files');
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!supportsAttachments || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (!disabled && !isRunActive) {
      setIsDraggingFiles(true);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!supportsAttachments || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled || isRunActive ? 'none' : 'copy';
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!supportsAttachments || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!supportsAttachments || !hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    if (disabled || isRunActive) return;
    void handleIncomingFiles(event.dataTransfer.files);
  };

  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!supportsAttachments || disabled || isRunActive) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void handleIncomingFiles(files);
    },
    [disabled, handleIncomingFiles, isRunActive, supportsAttachments],
  );
  return {
    handleAddFile,
    handleRemoveAttachment,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
  };
}
