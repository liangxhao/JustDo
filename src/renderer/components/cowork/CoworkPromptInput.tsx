import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { FolderIcon, PaperAirplaneIcon, StopIcon } from '@heroicons/react/24/solid';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { agentService } from '../../services/agent';
import { configService } from '../../services/config';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { selectDraftPrompts, selectDraftAttachments } from '../../store/selectors/coworkSelectors';
import {
  addDraftAttachment,
  clearDraftAttachments,
  type DraftAttachment,
  setDraftAttachments,
  setDraftPrompt,
} from '../../store/slices/coworkSlice';
import { setSelectedModel } from '../../store/slices/modelSlice';
import { setSkills } from '../../store/slices/skillSlice';
import { CoworkImageAttachment } from '../../types/cowork';
import { toOpenClawModelRef } from '../../utils/openclawModelRef';
import { getCompactFolderName } from '../../utils/path';
import PaperClipIcon from '../icons/PaperClipIcon';
import XMarkIcon from '../icons/XMarkIcon';
import ModelSelector from '../ModelSelector';
import { ActiveSkillBadge } from '../skills';
import { resolveAgentModelSelection } from './agentModelSelection';
import AttachmentCard from './AttachmentCard';
import FolderSelectorPopover from './FolderSelectorPopover';

// CoworkAttachment is aliased from the Redux-persisted DraftAttachment type
// so that attachment state survives view switches (cowork ↔ skills, etc.)
type CoworkAttachment = DraftAttachment;

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.tiff',
  '.tif',
  '.ico',
  '.avif',
]);

const isImagePath = (filePath: string): boolean => {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = filePath.slice(dotIndex).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
};

const isImageMimeType = (mimeType: string): boolean => {
  return mimeType.startsWith('image/');
};

const extractBase64FromDataUrl = (
  dataUrl: string,
): { mimeType: string; base64Data: string } | null => {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
};

const getFileNameFromPath = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
};

const SEND_SHORTCUT_OPTIONS = [
  { value: 'Enter', label: 'Enter', labelMac: 'Enter' },
  { value: 'Ctrl+Enter', label: 'Ctrl+Enter', labelMac: 'Cmd+Enter' },
] as const;

const isMacPlatform = navigator.platform.includes('Mac');

const getSendShortcutLabel = (value: string): string => {
  const option = SEND_SHORTCUT_OPTIONS.find(o => o.value === value);
  if (!option) return value;
  return isMacPlatform ? option.labelMac : option.label;
};

export interface CoworkPromptInputRef {
  /** 设置输入框值 */
  setValue: (value: string) => void;
  /** 设置图片附件（用于重新编辑消息时还原图片） */
  setImageAttachments: (images: CoworkImageAttachment[]) => void;
  /** 聚焦输入框 */
  focus: () => void;
}

interface CoworkPromptInputProps {
  onSubmit: (
    prompt: string,
    imageAttachments?: CoworkImageAttachment[],
  ) => boolean | void | Promise<boolean | void>;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  size?: 'normal' | 'large';
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  showFolderSelector?: boolean;
  showModelSelector?: boolean;
  sessionId?: string;
  /** When true, hides attachment/skill buttons but keeps the input box visible (disabled) */
  remoteManaged?: boolean;
}

const CoworkPromptInput = React.forwardRef<CoworkPromptInputRef, CoworkPromptInputProps>(
  (props, ref) => {
    const {
      onSubmit,
      onStop,
      isStreaming = false,
      placeholder = 'Enter your task...',
      disabled = false,
      size = 'normal',
      workingDirectory = '',
      onWorkingDirectoryChange,
      showFolderSelector = false,
      showModelSelector = false,
      sessionId,
      remoteManaged = false,
    } = props;
    const dispatch = useDispatch();
    const draftKey = sessionId || '__home__';
    const draftPrompt = useSelector(
      (state: RootState) => selectDraftPrompts(state)[draftKey] || '',
    );
    const attachments = useSelector((state: RootState) =>
      selectDraftAttachments(state, draftKey),
    ) as CoworkAttachment[];
    const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
    const agents = useSelector((state: RootState) => state.agent.agents);
    const coworkAgentEngine = useSelector((state: RootState) => state.cowork.config.agentEngine);
    const availableModels = useSelector((state: RootState) => state.model.availableModels);
    const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);
    const currentAgent = agents.find(agent => agent.id === currentAgentId);
    const { selectedModel: agentSelectedModel, hasInvalidExplicitModel: agentModelIsInvalid } =
      resolveAgentModelSelection({
        agentModel: currentAgent?.model ?? '',
        availableModels,
        fallbackModel: globalSelectedModel,
        engine: coworkAgentEngine,
      });
    const [value, setValue] = useState(draftPrompt);
    const [showFolderMenu, setShowFolderMenu] = useState(false);
    const [showFolderRequiredWarning, setShowFolderRequiredWarning] = useState(false);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [isAddingFile, setIsAddingFile] = useState(false);
    const [imageVisionHint, setImageVisionHint] = useState(false);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const folderButtonRef = useRef<HTMLButtonElement>(null);
    const dragDepthRef = useRef(0);
    const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);

    // 暴露方法给父组件
    React.useImperativeHandle(ref, () => ({
      setValue: (newValue: string) => {
        setValue(newValue);
        // 触发自动调整高度
        requestAnimationFrame(() => {
          const textarea = textareaRef.current;
          if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
          }
        });
      },
      setImageAttachments: (images: CoworkImageAttachment[]) => {
        const newAttachments: CoworkAttachment[] = images.map((img, idx) => ({
          path: `inline:${img.name}:reedit-${Date.now()}-${idx}`,
          name: img.name,
          isImage: true,
          dataUrl: `data:${img.mimeType};base64,${img.base64Data}`,
        }));
        dispatch(setDraftAttachments({ draftKey, attachments: newAttachments }));
      },
      focus: () => {
        textareaRef.current?.focus();
      },
    }));

    const isLarge = size === 'large';
    const minHeight = isLarge ? 60 : 24;
    const maxHeight = isLarge ? 200 : 200;

    // Load skills on mount
    useEffect(() => {
      const loadSkills = async () => {
        const loadedSkills = await skillService.loadSkills();
        dispatch(setSkills(loadedSkills));
      };
      loadSkills();
    }, [dispatch]);

    useEffect(() => {
      const unsubscribe = skillService.onSkillsChanged(async () => {
        const loadedSkills = await skillService.loadSkills();
        dispatch(setSkills(loadedSkills));
      });
      return () => {
        unsubscribe();
      };
    }, [dispatch]);

    // Auto-resize textarea
    useEffect(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
      }
    }, [value, minHeight, maxHeight]);

    useEffect(() => {
      const handleFocusInput = (event: Event) => {
        const detail = (event as CustomEvent<{ clear?: boolean }>).detail;
        const shouldClear = detail?.clear ?? true;
        if (shouldClear) {
          setValue('');
          dispatch(clearDraftAttachments(draftKey));
        }
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      };
      window.addEventListener('cowork:focus-input', handleFocusInput);
      return () => {
        window.removeEventListener('cowork:focus-input', handleFocusInput);
        if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
      };
    }, [dispatch, draftKey]);

    useEffect(() => {
      if (workingDirectory?.trim()) {
        setShowFolderRequiredWarning(false);
      }
    }, [workingDirectory]);

    // Sync value from draft when sessionId changes
    useEffect(() => {
      setValue(draftPrompt);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draftKey]); // intentionally omit draftPrompt to only trigger on session switch

    useEffect(() => {
      if (value !== draftPrompt) {
        const timer = setTimeout(() => {
          dispatch(setDraftPrompt({ sessionId: draftKey, draft: value }));
        }, 300);
        return () => clearTimeout(timer);
      }
    }, [value, draftPrompt, dispatch, draftKey]);

    const handleSubmit = useCallback(async () => {
      if (showFolderSelector && !workingDirectory?.trim()) {
        setShowFolderRequiredWarning(true);
        if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
        warningTimerRef.current = setTimeout(() => {
          setShowFolderRequiredWarning(false);
          warningTimerRef.current = null;
        }, 3000);
        return;
      }

      const trimmedValue = value.trim();
      if ((!trimmedValue && attachments.length === 0) || isStreaming || disabled) return;
      setShowFolderRequiredWarning(false);

      // Extract image attachments (with base64 data) for vision-capable models
      console.log('[CoworkPromptInput] handleSubmit: attachments:', {
        count: attachments.length,
        details: attachments.map(a => ({
          path: a.path,
          isImage: a.isImage,
          hasDataUrl: !!a.dataUrl,
          dataUrlLength: a.dataUrl?.length ?? 0,
        })),
      });
      const imageAtts: CoworkImageAttachment[] = [];
      for (const attachment of attachments) {
        if (attachment.isImage && attachment.dataUrl) {
          const extracted = extractBase64FromDataUrl(attachment.dataUrl);
          console.log('[CoworkPromptInput] handleSubmit: extracting base64 from', attachment.name, {
            extracted: !!extracted,
            mimeType: extracted?.mimeType,
            base64Length: extracted?.base64Data.length ?? 0,
          });
          if (extracted) {
            imageAtts.push({
              name: attachment.name,
              mimeType: extracted.mimeType,
              base64Data: extracted.base64Data,
            });
          }
        }
      }

      // Build prompt with NON-IMAGE attachments that have real file paths.
      // Images are processed purely through Gateway attachments mechanism (base64).
      // Gateway handles them appropriately (inline or media store).
      // Non-image files need text injection because Gateway does not process them.
      // Note: inline/clipboard images have pseudo-paths starting with 'inline:'.
      const attachmentLines = attachments
        .filter(a => !a.path.startsWith('inline:') && !a.isImage)
        .map(attachment => `${i18nService.t('inputFileLabel')}: ${attachment.path}`)
        .join('\n');
      const finalPrompt = trimmedValue
        ? attachmentLines
          ? `${trimmedValue}\n\n${attachmentLines}`
          : trimmedValue
        : attachmentLines;

      if (imageAtts.length > 0) {
        console.log('[CoworkPromptInput] handleSubmit: passing imageAtts to onSubmit', {
          count: imageAtts.length,
          names: imageAtts.map(a => a.name),
          base64Lengths: imageAtts.map(a => a.base64Data.length),
        });
      }
      const result = await onSubmit(finalPrompt, imageAtts.length > 0 ? imageAtts : undefined);
      if (result === false) return;
      setValue('');
      dispatch(setDraftPrompt({ sessionId: draftKey, draft: '' }));
      dispatch(clearDraftAttachments(draftKey));
      setImageVisionHint(false);
    }, [
      value,
      isStreaming,
      disabled,
      onSubmit,
      attachments,
      showFolderSelector,
      workingDirectory,
      dispatch,
      draftKey,
    ]);

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
      if (event.key !== 'Enter' || isComposing) return;

      // Use synced state (kept up-to-date via config-updated event) so that
      // changes made in the Settings panel are reflected immediately without
      // requiring a configService read at event time.
      const sendKey = currentSendShortcut;

      let isSendCombo = false;
      switch (sendKey) {
        case 'Enter':
          isSendCombo = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
          break;
        case 'Shift+Enter':
          isSendCombo = event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
          break;
        case 'Ctrl+Enter':
          isSendCombo = isMacPlatform
            ? event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
            : event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
          break;
        case 'Alt+Enter':
          isSendCombo = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
          break;
        default:
          // Unknown config value — fall back to bare Enter so the user can always send
          isSendCombo = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
          break;
      }

      if (isSendCombo && !isStreaming && !disabled) {
        event.preventDefault();
        handleSubmit();
      } else {
        // Any non-send Enter combo inserts a newline.
        // Shift+Enter inserts newline natively; for other combos use execCommand.
        if (!event.shiftKey) {
          event.preventDefault();
          document.execCommand('insertText', false, '\n');
        }
      }
    };

    const handleStopClick = () => {
      if (onStop) {
        onStop();
      }
    };

    const containerClass = isLarge
      ? 'relative rounded-2xl border border-border bg-surface shadow-card focus-within:shadow-elevated focus-within:ring-1 focus-within:ring-primary/40 focus-within:border-primary'
      : 'relative flex items-end gap-2 p-3 rounded-xl border border-border bg-surface';

    const textareaClass = isLarge
      ? `w-full resize-none bg-transparent px-4 pt-2.5 pb-2 text-foreground placeholder:dark:text-foregroundSecondary/60 placeholder:text-secondary/60 focus:outline-none text-[15px] leading-6 min-h-[${minHeight}px] max-h-[${maxHeight}px]`
      : 'flex-1 resize-none bg-transparent text-foreground placeholder:placeholder:text-secondary focus:outline-none text-sm leading-relaxed min-h-[24px] max-h-[200px]';

    const truncatePath = (path: string, maxLength = 30): string => {
      if (!path) return i18nService.t('noFolderSelected');
      return getCompactFolderName(path, maxLength) || i18nService.t('noFolderSelected');
    };

    const handleFolderSelect = (path: string) => {
      if (onWorkingDirectoryChange) {
        onWorkingDirectoryChange(path);
      }
    };

    const effectiveSelectedModel =
      coworkAgentEngine === 'openclaw' ? agentSelectedModel : globalSelectedModel;
    const modelSupportsImage = !!effectiveSelectedModel?.supportsImage;

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
        if (disabled || isStreaming) return;
        const files = Array.from(fileList ?? []);
        if (files.length === 0) return;

        let hasImageWithoutVision = false;
        for (const file of files) {
          const nativePath = getNativeFilePath(file);

          // Check if this is an image file and model supports images
          const fileIsImage = nativePath ? isImagePath(nativePath) : isImageMimeType(file.type);

          if (fileIsImage) {
            if (modelSupportsImage) {
              // For images on vision-capable models, read as data URL
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
                // Fallback: add as regular file attachment
                addAttachment(nativePath);
              } else {
                // No native path (clipboard/drag from browser):
                // 1. Read as dataUrl for preview + base64 vision
                // 2. Save to disk so the agent can access the file in later turns
                let dataUrl: string | null = null;
                try {
                  dataUrl = await fileToDataUrl(file);
                  console.log('[CoworkPromptInput] handleIncomingFiles: clipboard image dataUrl', {
                    success: !!dataUrl,
                    length: dataUrl?.length ?? 0,
                    mimeType: file.type,
                  });
                } catch (error) {
                  console.error('Failed to read clipboard image as data URL:', error);
                }

                const stagedPath = await saveInlineFile(file);
                console.log('[CoworkPromptInput] handleIncomingFiles: saveInlineFile result', {
                  stagedPath,
                  hasDataUrl: !!dataUrl,
                });

                if (stagedPath) {
                  addAttachment(stagedPath, {
                    isImage: true,
                    dataUrl: dataUrl ?? undefined,
                  });
                } else if (dataUrl) {
                  console.warn('Clipboard image saved only in memory (disk save failed)');
                  addImageAttachmentFromDataUrl(file.name, dataUrl);
                } else {
                  console.error(
                    'Failed to process clipboard image: both dataUrl and disk save failed',
                  );
                }
              }
              continue;
            }
            // Model doesn't support image input — add as file path and show hint
            hasImageWithoutVision = true;
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
        isStreaming,
        modelSupportsImage,
        saveInlineFile,
      ],
    );

    const handleAddFile = useCallback(async () => {
      if (isAddingFile || disabled || isStreaming) return;
      setIsAddingFile(true);
      try {
        const result = await window.electron.dialog.selectFiles({
          title: i18nService.t('coworkAddFile'),
        });
        if (!result.success || result.paths.length === 0) return;
        let hasImageWithoutVision = false;
        for (const filePath of result.paths) {
          if (isImagePath(filePath)) {
            if (modelSupportsImage) {
              try {
                const readResult = await window.electron.dialog.readFileAsDataUrl(filePath);
                if (readResult.success && readResult.dataUrl) {
                  addAttachment(filePath, { isImage: true, dataUrl: readResult.dataUrl });
                  continue;
                }
              } catch (error) {
                console.error('Failed to read image as data URL:', error);
              }
            } else {
              hasImageWithoutVision = true;
            }
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
    }, [addAttachment, isAddingFile, disabled, isStreaming, modelSupportsImage]);

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
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current += 1;
      if (!disabled && !isStreaming) {
        setIsDraggingFiles(true);
      }
    };

    const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = disabled || isStreaming ? 'none' : 'copy';
    };

    const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDraggingFiles(false);
      }
    };

    const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      setIsDraggingFiles(false);
      if (disabled || isStreaming) return;
      void handleIncomingFiles(event.dataTransfer.files);
    };

    const handlePaste = useCallback(
      (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (disabled || isStreaming) return;
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        void handleIncomingFiles(files);
      },
      [disabled, handleIncomingFiles, isStreaming],
    );

    // Context menu handling for textarea
    const handleContextMenu = useCallback((event: React.MouseEvent<HTMLTextAreaElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const textarea = textareaRef.current;
      if (!textarea) return;

      // Calculate menu position
      const x = event.clientX;
      const y = event.clientY;

      // Adjust position if near screen edges
      const menuWidth = 140;
      const menuHeight = 100;
      const adjustedX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
      const adjustedY = y + menuHeight > window.innerHeight ? y - menuHeight : y;

      setContextMenuPos({ x: adjustedX, y: adjustedY });
    }, []);

    const closeContextMenu = useCallback(() => {
      setContextMenuPos(null);
    }, []);

    // Close context menu on click outside or scroll
    useEffect(() => {
      if (!contextMenuPos) return;

      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target as Node;
        if (!contextMenuRef.current?.contains(target)) {
          closeContextMenu();
        }
      };

      const handleScroll = () => {
        closeContextMenu();
      };

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          closeContextMenu();
        }
      };

      document.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('scroll', handleScroll, true);
      window.addEventListener('resize', handleScroll);
      document.addEventListener('keydown', handleKeyDown);

      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        window.removeEventListener('scroll', handleScroll, true);
        window.removeEventListener('resize', handleScroll);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }, [contextMenuPos, closeContextMenu]);

    const handleContextMenuAction = useCallback(
      async (action: 'cut' | 'copy' | 'paste' | 'selectAll') => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        closeContextMenu();
        textarea.focus();

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const selectedText = value.substring(start, end);
        const hasSelection = start !== end;

        switch (action) {
          case 'cut':
            if (hasSelection) {
              await navigator.clipboard.writeText(selectedText);
              const newValue = value.substring(0, start) + value.substring(end);
              setValue(newValue);
              // Reset selection to start position
              requestAnimationFrame(() => {
                textarea.selectionStart = start;
                textarea.selectionEnd = start;
              });
            }
            break;

          case 'copy':
            if (hasSelection) {
              await navigator.clipboard.writeText(selectedText);
            }
            break;

          case 'paste':
            try {
              const clipText = await navigator.clipboard.readText();
              if (clipText) {
                const newValue = value.substring(0, start) + clipText + value.substring(end);
                setValue(newValue);
                requestAnimationFrame(() => {
                  const newPos = start + clipText.length;
                  textarea.selectionStart = newPos;
                  textarea.selectionEnd = newPos;
                });
              }
            } catch {
              // Clipboard read permission denied or empty
            }
            break;

          case 'selectAll':
            requestAnimationFrame(() => {
              textarea.selectionStart = 0;
              textarea.selectionEnd = value.length;
            });
            break;
        }
      },
      [value, setValue, closeContextMenu],
    );

    const contextMenuItems = useMemo(() => {
      // Directly read textarea selection at render time when menu is open
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? 0;
      const end = textarea?.selectionEnd ?? 0;
      const hasSelection = contextMenuPos ? start !== end : false;

      return [
        {
          action: 'cut' as const,
          label: i18nService.t('contextMenuCut'),
          disabled: !hasSelection || disabled,
        },
        {
          action: 'copy' as const,
          label: i18nService.t('contextMenuCopy'),
          disabled: !hasSelection,
        },
        {
          action: 'paste' as const,
          label: i18nService.t('contextMenuPaste'),
          disabled: disabled || isStreaming,
        },
        {
          action: 'selectAll' as const,
          label: i18nService.t('contextMenuSelectAll'),
          disabled: value.length === 0,
        },
      ];
    }, [disabled, isStreaming, value, contextMenuPos]);

    const canSubmit =
      !disabled && !agentModelIsInvalid && (!!value.trim() || attachments.length > 0);
    const enhancedContainerClass = isDraggingFiles
      ? `${containerClass} ring-2 ring-primary/50 border-primary/60`
      : containerClass;

    // Sync send shortcut from config
    const [currentSendShortcut, setCurrentSendShortcut] = useState(
      () => configService.getConfig().shortcuts?.sendMessage ?? 'Enter',
    );

    // Sync when config is updated elsewhere (e.g. Settings panel)
    useEffect(() => {
      const syncFromConfig = () => {
        const latest = configService.getConfig().shortcuts?.sendMessage ?? 'Enter';
        setCurrentSendShortcut(latest);
      };
      window.addEventListener('config-updated', syncFromConfig);
      return () => window.removeEventListener('config-updated', syncFromConfig);
    }, []);

    return (
      <div className="relative">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map(attachment => (
              <AttachmentCard
                key={attachment.path}
                attachment={attachment}
                onRemove={handleRemoveAttachment}
              />
            ))}
          </div>
        )}
        {imageVisionHint && (
          <div className="mb-2 flex items-start gap-1.5 rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
            <ExclamationTriangleIcon className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
            <span>{i18nService.t('imageVisionHint')}</span>
            <button
              type="button"
              onClick={() => setImageVisionHint(false)}
              className="ml-auto flex-shrink-0 rounded-full p-0.5 hover:bg-amber-200/50 dark:hover:bg-amber-800/50"
            >
              <XMarkIcon className="h-3 w-3" />
            </button>
          </div>
        )}
        <div
          className={enhancedContainerClass}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDraggingFiles && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-primary/10 text-xs font-medium text-primary">
              {i18nService.t('coworkDropFileHint')}
            </div>
          )}
          {isLarge ? (
            <>
              <textarea
                ref={textareaRef}
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onContextMenu={handleContextMenu}
                placeholder={placeholder}
                disabled={disabled}
                rows={isLarge ? 2 : 1}
                className={textareaClass}
                style={{ minHeight: `${minHeight}px` }}
              />
              <div className="flex items-center justify-between px-4 pb-2 pt-1.5">
                <div className="flex items-center gap-2 relative">
                  {showModelSelector && !remoteManaged && (
                    <div className="flex flex-col items-start gap-1">
                      <ModelSelector
                        dropdownDirection="up"
                        value={
                          coworkAgentEngine === 'openclaw'
                            ? agentSelectedModel
                            : globalSelectedModel
                        }
                        onChange={async nextModel => {
                          if (!nextModel) return;
                          if (coworkAgentEngine === 'openclaw') {
                            // Update agent model if we have a currentAgent
                            if (currentAgent) {
                              await agentService.updateAgent(currentAgent.id, {
                                model: toOpenClawModelRef(nextModel),
                              });
                            } else {
                              // No currentAgent - update default model in app_config
                              await coworkService.setDefaultModel({
                                modelId: nextModel.id,
                                providerKey: nextModel.providerKey,
                              });
                            }
                            // Patch session model in real-time via sessions.patch API
                            if (sessionId) {
                              const modelRef = toOpenClawModelRef(nextModel);
                              if (modelRef) {
                                await coworkService.patchSessionModel({
                                  sessionId,
                                  model: modelRef,
                                });
                              }
                            }
                          }
                          // Always update global state so the selection is persisted
                          dispatch(setSelectedModel(nextModel));
                        }}
                      />
                      {coworkAgentEngine === 'openclaw' && agentModelIsInvalid && (
                        <span className="max-w-60 text-[11px] leading-4 text-red-500">
                          {i18nService.t('agentModelInvalidHint')}
                        </span>
                      )}
                    </div>
                  )}
                  {showFolderSelector && (
                    <>
                      <div className="flex items-center">
                        <button
                          ref={folderButtonRef as React.RefObject<HTMLButtonElement>}
                          type="button"
                          onClick={() => setShowFolderMenu(!showFolderMenu)}
                          className={`flex items-center gap-1.5 pl-2.5 pr-1.5 py-1.5 rounded-lg text-sm transition-colors ${
                            showFolderRequiredWarning
                              ? 'ring-1 ring-warning text-warning animate-shake'
                              : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                          }`}
                        >
                          <FolderIcon className="h-4 w-4 flex-shrink-0" />
                          <span className="max-w-[150px] truncate text-xs">
                            {truncatePath(workingDirectory)}
                          </span>
                          {workingDirectory && (
                            <span
                              role="button"
                              tabIndex={-1}
                              onClick={e => {
                                e.stopPropagation();
                                handleFolderSelect('');
                              }}
                              className="flex-shrink-0 ml-0.5 p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                            >
                              <XMarkIcon className="h-3 w-3" />
                            </span>
                          )}
                        </button>
                      </div>
                      <FolderSelectorPopover
                        isOpen={showFolderMenu}
                        onClose={() => setShowFolderMenu(false)}
                        onSelectFolder={handleFolderSelect}
                        anchorRef={folderButtonRef as React.RefObject<HTMLElement>}
                      />
                      {showFolderRequiredWarning && (
                        <div className="absolute left-0 top-full mt-1 px-2 py-1 rounded-md bg-surface-raised text-warning text-xs whitespace-nowrap animate-fade-in-up shadow-subtle z-10">
                          {i18nService.t('coworkSelectFolderFirst')}
                        </div>
                      )}
                    </>
                  )}
                  {!remoteManaged && (
                    <button
                      type="button"
                      onClick={handleAddFile}
                      className="flex items-center justify-center p-1.5 rounded-lg text-sm text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
                      title={i18nService.t('coworkAddFile')}
                      aria-label={i18nService.t('coworkAddFile')}
                      disabled={disabled || isStreaming || isAddingFile}
                    >
                      <PaperClipIcon className="h-4 w-4" />
                    </button>
                  )}
                  {!remoteManaged && <ActiveSkillBadge />}
                </div>
                <div className="flex items-center gap-2">
                  {isStreaming ? (
                    <button
                      type="button"
                      onClick={handleStopClick}
                      className="p-2 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
                      aria-label="Stop"
                    >
                      <StopIcon className="h-5 w-5" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={!canSubmit}
                      className={`p-2 rounded-xl bg-primary hover:bg-primary-hover text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:cursor-not-allowed ${!canSubmit ? 'opacity-50' : ''}`}
                      aria-label="Send"
                      title={getSendShortcutLabel(currentSendShortcut)}
                    >
                      <PaperAirplaneIcon className="h-5 w-5" />
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <textarea
                ref={textareaRef}
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onContextMenu={handleContextMenu}
                placeholder={placeholder}
                disabled={disabled}
                rows={1}
                className={textareaClass}
              />

              {!remoteManaged && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleAddFile}
                    className="flex-shrink-0 p-1.5 rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
                    title={i18nService.t('coworkAddFile')}
                    aria-label={i18nService.t('coworkAddFile')}
                    disabled={disabled || isStreaming || isAddingFile}
                  >
                    <PaperClipIcon className="h-4 w-4" />
                  </button>
                </div>
              )}

              {isStreaming ? (
                <button
                  type="button"
                  onClick={handleStopClick}
                  className="flex-shrink-0 p-2 rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
                  aria-label="Stop"
                >
                  <StopIcon className="h-4 w-4" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!canSubmit}
                  className={`flex-shrink-0 p-2 rounded-lg bg-primary hover:bg-primary-hover text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:cursor-not-allowed ${!canSubmit ? 'opacity-50' : ''}`}
                  aria-label="Send"
                  title={getSendShortcutLabel(currentSendShortcut)}
                >
                  <PaperAirplaneIcon className="h-4 w-4" />
                </button>
              )}
            </>
          )}
        </div>

        {/* Context menu for textarea */}
        {contextMenuPos && (
          <div
            ref={contextMenuRef}
            className="fixed z-50 min-w-[140px] rounded-lg border border-border bg-surface shadow-lg overflow-hidden py-1"
            style={{ top: contextMenuPos.y, left: contextMenuPos.x }}
            role="menu"
          >
            {contextMenuItems.map(item => (
              <button
                key={item.action}
                type="button"
                onClick={() => {
                  if (!item.disabled) {
                    handleContextMenuAction(item.action);
                  }
                }}
                className={`w-full px-3 py-1.5 text-sm text-left transition-colors ${
                  item.disabled
                    ? 'text-gray-400 dark:text-gray-500'
                    : 'text-foreground hover:bg-surface-raised'
                }`}
                role="menuitem"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  },
);

CoworkPromptInput.displayName = 'CoworkPromptInput';

export default CoworkPromptInput;
