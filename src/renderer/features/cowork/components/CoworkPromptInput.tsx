import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { FolderIcon, PaperAirplaneIcon, StopIcon } from '@heroicons/react/24/solid';
import {
  GoalExecutionPhase,
  type GoalExecutionSnapshot,
  type SessionGoal,
  SessionGoalStatus,
} from '@shared/sessionGoal';
import {
  isGoalClearCommand,
  isGoalSlashCommand,
  parseGoalStartObjective,
  shouldClearSlashCommandComposerBeforeExecution,
} from '@shared/slashCommands';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { updateAgent } from '@/features/agents/agentSlice';
import {
  resolveAgentModelSelection,
  resolveAutomaticAgentModelRepair,
} from '@/features/cowork/components/agentModelSelection';
import AttachmentCard from '@/features/cowork/components/AttachmentCard';
import {
  type ContextUsageSnapshot,
  mergeContextUsageSnapshot,
  startContextUsageRefresh,
} from '@/features/cowork/components/contextUsageRefresh';
import {
  canStopCoworkRun,
  isCoworkRunActive,
} from '@/features/cowork/components/coworkRunActivity';
import FolderSelectorPopover from '@/features/cowork/components/FolderSelectorPopover';
import { runGoalActionSingleFlight } from '@/features/cowork/components/goalActionSingleFlight';
import {
  shouldDiscardGoalCompletionFeedback,
  submitGoalCompletionFeedback,
} from '@/features/cowork/components/goalCompletionFeedback';
import {
  resolveGoalClearFetch,
  resolvePendingGoalObjectiveOnSessionChange,
} from '@/features/cowork/components/goalPendingObjective';
import type { GoalRunProgress } from '@/features/cowork/components/goalRunProgress';
import GoalStatusCard from '@/features/cowork/components/GoalStatusCard';
import { LatestSerialTaskQueue } from '@/features/cowork/components/latestSerialTaskQueue';
import PermissionModeSelector from '@/features/cowork/components/PermissionModeSelector';
import {
  getHiddenCommandCount,
  getSlashCommandByName,
  getSlashCommandCompletions,
  SLASH_COMMANDS,
  type SlashCommandCategory,
  SlashCommandCategoryLabels,
  type SlashCommandDef,
} from '@/features/cowork/components/slashCommands';
import { selectDraftAttachments, selectDraftPrompts } from '@/features/cowork/coworkSelectors';
import { coworkService } from '@/features/cowork/coworkService';
import {
  addDraftAttachment,
  clearDraftAttachments,
  type DraftAttachment,
  hydrateDraftImageAttachment,
  setDraftAttachments,
  setDraftPrompt,
  updateCurrentSessionModelRef,
} from '@/features/cowork/coworkSlice';
import { CoworkAttachmentPayload } from '@/features/cowork/coworkTypes';
import ModelSelector from '@/features/models/ModelSelector';
import { type Model, setSelectedModel } from '@/features/models/modelSlice';
import { resolveOpenClawModelRef, toOpenClawModelRef } from '@/features/models/openclawModelRef';
import { ActiveSkillBadge } from '@/features/plugins/components/skills';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import PaperClipIcon from '@/shared/components/icons/PaperClipIcon';
import XMarkIcon from '@/shared/components/icons/XMarkIcon';
import { RootState } from '@/store';
import { getCompactFolderName } from '@/utils/path';

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

const isImageAttachment = (attachment: DraftAttachment): boolean =>
  attachment.isImage === true ||
  isImagePath(attachment.path) ||
  attachment.dataUrl?.startsWith('data:image/') === true;

const extractBase64FromDataUrl = (
  dataUrl: string,
): { mimeType: string; base64Data: string } | null => {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
};

const toMediaDirectivePath = (filePath: string): string => {
  return filePath.replace(/[\r\n]+/g, ' ').trim();
};

const appendMediaDirectiveLines = (prompt: string, filePaths: string[]): string => {
  const mediaLines = filePaths
    .map(toMediaDirectivePath)
    .filter(Boolean)
    .map(filePath => `MEDIA:${filePath}`);
  if (mediaLines.length === 0) return prompt;
  return prompt ? `${prompt}\n\n${mediaLines.join('\n')}` : mediaLines.join('\n');
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
  setAttachments: (attachments: CoworkAttachmentPayload[]) => void;
  /** 聚焦输入框 */
  focus: () => void;
}

interface CoworkPromptInputProps {
  onSubmit: (
    prompt: string,
    attachments?: CoworkAttachmentPayload[],
    gatewayPrompt?: string,
  ) => boolean | void | Promise<boolean | void>;
  onStop?: () => boolean | void | Promise<boolean | void>;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  size?: 'normal' | 'large';
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  showFolderSelector?: boolean;
  showModelSelector?: boolean;
  sessionId?: string;
  /** Agent that owns the session. Defaults to the agent selected on the home screen. */
  modelAgentId?: string;
  /** Last Gateway-confirmed model for this session. */
  sessionModelRef?: string;
  /** Whether the session has completed at least one Gateway-backed turn. */
  hasAssistantMessage?: boolean;
  /** Objective inferred from the optimistic first message while the real session is being created. */
  initialGoalObjective?: string | null;
  /** Live execution phase projected from the Gateway chat stream. */
  goalRunProgress?: GoalRunProgress | null;
  /** When true, hides attachment/skill buttons but keeps the input box visible (disabled) */
  remoteManaged?: boolean;
}

interface GoalCompletionFeedbackState {
  completedGoalId: string;
  preparedObjective?: string;
}

const goalFeedbackStorageKey = (sessionId: string): string =>
  `justdo:goal-completion-feedback:${sessionId}`;

const formatContextLength = (tokens: number): string => {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${parseFloat(k.toFixed(1))}k`;
  }
  return `${tokens}`;
};

const InProgressBadge = () => (
  <span
    role="status"
    aria-live="polite"
    className="mr-1.5 inline-flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary/90 shadow-subtle"
  >
    <span className="relative flex h-2 w-2" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/30 motion-reduce:animate-none" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
    </span>
    {i18nService.t('coworkInProgress')}
  </span>
);

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
      modelAgentId,
      sessionModelRef,
      hasAssistantMessage = false,
      initialGoalObjective = null,
      goalRunProgress = null,
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
    const availableModels = useSelector((state: RootState) => state.model.availableModels);
    const globalSelectedModel = useSelector((state: RootState) => state.model.selectedModel);
    const effectiveAgentId = modelAgentId ?? currentAgentId;
    const currentAgent = agents.find(agent => agent.id === effectiveAgentId);
    const { selectedModel: agentSelectedModel, hasInvalidExplicitModel: agentModelIsInvalid } =
      resolveAgentModelSelection({
        agentModel: currentAgent?.model ?? '',
        availableModels,
        fallbackModel: globalSelectedModel,
      });
    const confirmedPropModel = sessionModelRef
      ? resolveOpenClawModelRef(sessionModelRef, availableModels)
      : null;
    const baseSelectedModel = confirmedPropModel ?? agentSelectedModel;
    const agentSelectedModelRef = useRef<Model | null>(baseSelectedModel);
    agentSelectedModelRef.current = baseSelectedModel;
    const [optimisticSessionModel, setOptimisticSessionModel] = useState<Model | null>(null);
    const [modelUpdatePending, setModelUpdatePending] = useState(false);
    const [modelUpdateError, setModelUpdateError] = useState<string | null>(null);
    const [goalActionPending, setGoalActionPending] = useState(false);
    const goalActionPendingRef = useRef(false);
    const [completionFeedback, setCompletionFeedback] =
      useState<GoalCompletionFeedbackState | null>(null);
    const completionFeedbackRef = useRef<GoalCompletionFeedbackState | null>(null);
    const [endingGoalId, setEndingGoalId] = useState<string | null>(null);
    const goalEndCancelButtonRef = useRef<HTMLButtonElement>(null);
    const goalEndConfirmButtonRef = useRef<HTMLButtonElement>(null);
    const optimisticSessionModelRef = useRef<Model | null>(null);
    const confirmedSessionModelRef = useRef<Model | null>(baseSelectedModel);
    const modelSelectionContextRef = useRef(0);
    const renderedSessionIdRef = useRef(sessionId);
    renderedSessionIdRef.current = sessionId;
    const modelSelectionQueueRef = useRef(new LatestSerialTaskQueue());
    const automaticModelRepairKeyRef = useRef('');
    const effectiveSelectedModel = optimisticSessionModel ?? baseSelectedModel;
    const hasNoAvailableModels = !remoteManaged && availableModels.length === 0;
    const modelSupportsImage = !!effectiveSelectedModel?.supportsImage;
    const [value, setValue] = useState(draftPrompt);
    const [showFolderMenu, setShowFolderMenu] = useState(false);
    const [showFolderRequiredWarning, setShowFolderRequiredWarning] = useState(false);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [isAddingFile, setIsAddingFile] = useState(false);
    const [imageVisionHint, setImageVisionHint] = useState(false);
    const [slashMenuOpen, setSlashMenuOpen] = useState(false);
    const [slashMenuItems, setSlashMenuItems] = useState<SlashCommandDef[]>([]);
    const [slashMenuIndex, setSlashMenuIndex] = useState(0);
    const [slashMenuMode, setSlashMenuMode] = useState<'command' | 'args'>('command');
    const [slashMenuCommand, setSlashMenuCommand] = useState<SlashCommandDef | null>(null);
    const [slashMenuArgItems, setSlashMenuArgItems] = useState<string[]>([]);
    const [slashMenuExpanded, setSlashMenuExpanded] = useState(false);
    const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot | null>(null);
    const [sessionGoal, setSessionGoal] = useState<SessionGoal | null>(null);
    const [goalExecution, setGoalExecution] = useState<GoalExecutionSnapshot | null>(null);
    const sessionGoalRef = useRef<SessionGoal | null>(null);
    const [pendingGoalObjective, setPendingGoalObjective] = useState<string | null>(
      initialGoalObjective,
    );
    const goalStateSessionIdRef = useRef(sessionId);
    const initialGoalObjectiveRef = useRef(initialGoalObjective);
    initialGoalObjectiveRef.current = initialGoalObjective;
    const isRunActive = isCoworkRunActive(isStreaming, goalRunProgress);
    const canStopRun = canStopCoworkRun(isStreaming, goalRunProgress);

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const slashMenuRef = useRef<HTMLDivElement>(null);
    const folderButtonRef = useRef<HTMLButtonElement>(null);
    const dragDepthRef = useRef(0);
    const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement>(null);
    const [slashCommands, setSlashCommands] = useState<SlashCommandDef[]>(SLASH_COMMANDS);
    const slashCommandRefreshPendingRef = useRef(false);
    const slashCommandRefreshSeqRef = useRef(0);
    const goalClearPendingRef = useRef(false);
    const goalClearTargetIdRef = useRef<string | null>(null);
    const latestValueRef = useRef(value);
    const contextUsageRunRef = useRef<{ sessionId?: string; active: boolean }>({
      sessionId,
      active: isRunActive,
    });
    const updateCompletionFeedback = useCallback((next: GoalCompletionFeedbackState | null) => {
      completionFeedbackRef.current = next;
      setCompletionFeedback(next);
    }, []);
    const applyAcceptedGoalClear = useCallback(() => {
      sessionGoalRef.current = null;
      setSessionGoal(null);
      setPendingGoalObjective(null);
      setGoalExecution(null);
      if (sessionId && !sessionId.startsWith('temp-')) {
        window.localStorage.removeItem(goalFeedbackStorageKey(sessionId));
      }
      updateCompletionFeedback(null);
    }, [sessionId, updateCompletionFeedback]);
    const beginGoalClear = useCallback(() => {
      goalClearPendingRef.current = true;
      goalClearTargetIdRef.current = sessionGoalRef.current?.id ?? null;
    }, []);
    const cancelGoalClear = useCallback(() => {
      goalClearPendingRef.current = false;
      goalClearTargetIdRef.current = null;
    }, []);

    useEffect(() => {
      const previousSessionId = goalStateSessionIdRef.current;
      goalStateSessionIdRef.current = sessionId;
      cancelGoalClear();
      modelSelectionContextRef.current += 1;
      modelSelectionQueueRef.current.invalidate();
      automaticModelRepairKeyRef.current = '';
      optimisticSessionModelRef.current = null;
      confirmedSessionModelRef.current = agentSelectedModelRef.current;
      setOptimisticSessionModel(null);
      setModelUpdatePending(false);
      setModelUpdateError(null);
      setContextUsage(null);
      setSessionGoal(null);
      sessionGoalRef.current = null;
      setGoalExecution(null);
      let restoredFeedback: GoalCompletionFeedbackState | null = null;
      if (sessionId && !sessionId.startsWith('temp-')) {
        try {
          const raw = window.localStorage.getItem(goalFeedbackStorageKey(sessionId));
          const parsed = raw ? (JSON.parse(raw) as Partial<GoalCompletionFeedbackState>) : null;
          if (parsed?.completedGoalId) {
            restoredFeedback = {
              completedGoalId: parsed.completedGoalId,
              ...(parsed.preparedObjective ? { preparedObjective: parsed.preparedObjective } : {}),
            };
          }
        } catch {
          window.localStorage.removeItem(goalFeedbackStorageKey(sessionId));
        }
      }
      updateCompletionFeedback(restoredFeedback);
      setEndingGoalId(null);
      setPendingGoalObjective(current =>
        resolvePendingGoalObjectiveOnSessionChange({
          previousSessionId,
          nextSessionId: sessionId,
          currentObjective: current,
          initialObjective: initialGoalObjectiveRef.current,
        }),
      );
    }, [cancelGoalClear, sessionId, effectiveAgentId, updateCompletionFeedback]);

    useEffect(() => {
      if (!sessionId || remoteManaged) return;
      const selectionContext = modelSelectionContextRef.current;
      let cancelled = false;
      void coworkService
        .getSessionModel({ sessionId, agentId: effectiveAgentId })
        .then(result => {
          if (cancelled || selectionContext !== modelSelectionContextRef.current) return;
          if (!result.success || !result.modelRef) return;
          const confirmedModel = resolveOpenClawModelRef(result.modelRef, availableModels);
          if (!confirmedModel) return;
          confirmedSessionModelRef.current = confirmedModel;
          optimisticSessionModelRef.current = confirmedModel;
          setOptimisticSessionModel(confirmedModel);
          dispatch(updateCurrentSessionModelRef({ sessionId, modelRef: result.modelRef }));
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [availableModels, dispatch, effectiveAgentId, remoteManaged, sessionId]);

    useEffect(() => {
      if (!confirmedPropModel || modelUpdatePending) return;
      confirmedSessionModelRef.current = confirmedPropModel;
      optimisticSessionModelRef.current = confirmedPropModel;
      setOptimisticSessionModel(confirmedPropModel);
    }, [confirmedPropModel, modelUpdatePending]);

    useEffect(() => {
      if (endingGoalId) goalEndCancelButtonRef.current?.focus();
    }, [endingGoalId]);

    useEffect(() => {
      if (!agentModelIsInvalid || remoteManaged) return;
      const repairModel = resolveAutomaticAgentModelRepair(
        currentAgent?.model ?? '',
        agentSelectedModel,
      );
      if (!repairModel) return;

      const modelRef = toOpenClawModelRef(repairModel);
      if (!modelRef) return;
      const repairKey = [
        effectiveAgentId,
        sessionId ?? '',
        currentAgent?.model ?? '',
        modelRef,
      ].join(':');
      if (automaticModelRepairKeyRef.current === repairKey) return;
      automaticModelRepairKeyRef.current = repairKey;

      void (async () => {
        try {
          if (sessionId) {
            const sessionResult = await coworkService.patchSessionModel({
              sessionId,
              model: modelRef,
              agentId: effectiveAgentId,
            });
            if (!sessionResult.success) {
              throw new Error(sessionResult.error || 'patchSessionModel failed');
            }
          }

          const defaultResult = await coworkService.setDefaultModel({
            modelId: repairModel.id,
            providerKey: repairModel.providerKey,
            agentId: effectiveAgentId,
          });
          if (!defaultResult.success) {
            throw new Error(defaultResult.error || 'setDefaultModel failed');
          }
          if (automaticModelRepairKeyRef.current !== repairKey) return;

          dispatch(updateAgent({ id: effectiveAgentId, updates: { model: modelRef } }));
          dispatch(setSelectedModel(repairModel));
        } catch (error) {
          console.warn('[CoworkPromptInput] Failed to repair unavailable Agent model', {
            agentId: effectiveAgentId,
            sessionId,
            error,
          });
        }
      })();
    }, [
      agentModelIsInvalid,
      currentAgent?.model,
      dispatch,
      effectiveAgentId,
      agentSelectedModel,
      remoteManaged,
      sessionId,
    ]);

    const resetSlashMenuState = useCallback(() => {
      setSlashMenuOpen(false);
      setSlashMenuItems([]);
      setSlashMenuIndex(0);
      setSlashMenuMode('command');
      setSlashMenuCommand(null);
      setSlashMenuArgItems([]);
      setSlashMenuExpanded(false);
    }, []);

    const updateSlashMenu = useCallback(
      (
        nextValue: string,
        options?: { commandsOverride?: SlashCommandDef[]; keepExpanded?: boolean },
      ) => {
        const showAll = options?.keepExpanded ?? slashMenuExpanded;
        const activeSlashCommands = options?.commandsOverride ?? slashCommands;
        const argMatch = nextValue.match(/^\/(\S+)\s(.*)$/);
        if (argMatch) {
          const command = getSlashCommandByName(argMatch[1], activeSlashCommands);
          const filter = argMatch[2].toLowerCase();
          if (command?.argOptions?.length) {
            const filtered = filter
              ? command.argOptions.filter(option => option.toLowerCase().startsWith(filter))
              : command.argOptions;
            if (filtered.length > 0) {
              setSlashMenuMode('args');
              setSlashMenuCommand(command);
              setSlashMenuArgItems(filtered);
              setSlashMenuItems([]);
              setSlashMenuIndex(0);
              setSlashMenuOpen(true);
              return;
            }
          }
          resetSlashMenuState();
          return;
        }

        const commandMatch = nextValue.match(/^\/(\S*)$/);
        if (!commandMatch) {
          resetSlashMenuState();
          return;
        }

        const items = getSlashCommandCompletions(commandMatch[1], {
          commands: activeSlashCommands,
          showAll,
        });
        setSlashMenuMode('command');
        setSlashMenuCommand(null);
        setSlashMenuArgItems([]);
        setSlashMenuItems(items);
        setSlashMenuIndex(0);
        setSlashMenuOpen(items.length > 0);
      },
      [resetSlashMenuState, slashCommands, slashMenuExpanded],
    );

    const refreshSlashCommands = useCallback(
      (nextValue: string) => {
        if (!/^\/(?:\S*(?:\s.*)?)?$/.test(nextValue) || slashCommandRefreshPendingRef.current) {
          return;
        }

        const seq = ++slashCommandRefreshSeqRef.current;
        slashCommandRefreshPendingRef.current = true;
        void window.electron.slashCommands
          .list({ agentId: currentAgentId })
          .then(result => {
            if (seq !== slashCommandRefreshSeqRef.current) return;
            if (!result.success || !result.commands?.length) return;
            setSlashCommands(result.commands);
            updateSlashMenu(latestValueRef.current, {
              commandsOverride: result.commands,
              keepExpanded: slashMenuExpanded,
            });
          })
          .finally(() => {
            if (seq === slashCommandRefreshSeqRef.current) {
              slashCommandRefreshPendingRef.current = false;
            }
          });
      },
      [currentAgentId, slashMenuExpanded, updateSlashMenu],
    );

    const commitValue = useCallback(
      (nextValue: string) => {
        latestValueRef.current = nextValue;
        setValue(nextValue);
        updateSlashMenu(nextValue);
      },
      [updateSlashMenu],
    );

    const focusInputAtEnd = useCallback((nextValue: string) => {
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(nextValue.length, nextValue.length);
      });
    }, []);

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
      setAttachments: (payloads: CoworkAttachmentPayload[]) => {
        const newAttachments: CoworkAttachment[] = payloads.map((attachment, idx) => ({
          path: `inline:${attachment.name}:reedit-${Date.now()}-${idx}`,
          name: attachment.name,
          isImage: attachment.mimeType.startsWith('image/'),
          dataUrl: `data:${attachment.mimeType};base64,${attachment.base64Data}`,
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

    const handleSubmit = useCallback(
      async (promptOverride?: string) => {
        if (showFolderSelector && !workingDirectory?.trim()) {
          setShowFolderRequiredWarning(true);
          if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
          warningTimerRef.current = setTimeout(() => {
            setShowFolderRequiredWarning(false);
            warningTimerRef.current = null;
          }, 3000);
          return;
        }

        const promptValue = promptOverride ?? value;
        const trimmedValue = promptValue.trim();
        const submissionContext = modelSelectionContextRef.current;
        const submittedCompletionFeedback = completionFeedbackRef.current;
        const submissionIsCurrent = () =>
          modelSelectionContextRef.current === submissionContext &&
          renderedSessionIdRef.current === sessionId;
        // Require user text even when attachments exist; empty prompts produce poor session titles.
        if (!trimmedValue || isRunActive || disabled || modelUpdatePending) return;
        setShowFolderRequiredWarning(false);

        const attachmentPayloads: CoworkAttachmentPayload[] = [];
        const mediaDirectivePaths: string[] = [];
        let attachmentPreparationFailed = false;
        let imagePreparationFailed = false;
        for (const attachment of attachments) {
          const attachmentIsImage = isImageAttachment(attachment);
          let dataUrl = attachment.dataUrl;

          if (
            attachmentIsImage &&
            modelSupportsImage &&
            !dataUrl &&
            !attachment.path.startsWith('inline:')
          ) {
            try {
              const result = await window.electron.dialog.readFileAsDataUrl(attachment.path);
              dataUrl = result.success ? result.dataUrl : undefined;
            } catch (error) {
              console.error('Failed to read image before submit:', error);
            }
          }

          if (!dataUrl) {
            if (!attachment.path.startsWith('inline:')) {
              mediaDirectivePaths.push(attachment.path);
            } else {
              attachmentPreparationFailed = true;
              imagePreparationFailed ||= attachmentIsImage;
            }
            continue;
          }

          const extracted = extractBase64FromDataUrl(dataUrl);
          if (extracted && (!attachmentIsImage || modelSupportsImage)) {
            attachmentPayloads.push({
              name: attachment.name,
              mimeType: extracted.mimeType,
              base64Data: extracted.base64Data,
            });
          } else if (!attachment.path.startsWith('inline:')) {
            mediaDirectivePaths.push(attachment.path);
          } else if (extracted && attachmentIsImage) {
            const staged = await window.electron.dialog.saveInlineFile({
              dataBase64: extracted.base64Data,
              fileName: attachment.name,
              mimeType: extracted.mimeType,
              cwd: workingDirectory,
            });
            if (staged.success && staged.path) {
              mediaDirectivePaths.push(staged.path);
            } else {
              attachmentPreparationFailed = true;
              imagePreparationFailed = true;
              console.error('Failed to stage image for non-vision model:', staged.error);
            }
          } else if (!extracted) {
            attachmentPreparationFailed = true;
            imagePreparationFailed ||= attachmentIsImage;
          }
        }

        if (attachmentPreparationFailed) {
          if (!modelSupportsImage && imagePreparationFailed) {
            setImageVisionHint(true);
          }
          return;
        }

        const clearSubmittedInput = (clearVisibleValue = true) => {
          if (clearVisibleValue) setValue('');
          dispatch(setDraftPrompt({ sessionId: draftKey, draft: '' }));
          dispatch(clearDraftAttachments(draftKey));
          setImageVisionHint(false);
        };
        const finalPrompt = appendMediaDirectiveLines(trimmedValue, mediaDirectivePaths);
        const feedback = submittedCompletionFeedback;
        if (feedback && sessionId && !trimmedValue.startsWith('/')) {
          const outcome = await submitGoalCompletionFeedback({
            completedGoalId: feedback.completedGoalId,
            preparedObjective: feedback.preparedObjective,
            restart: (goalId, objective) =>
              window.electron.cowork.restartCompletedGoalForFeedback(sessionId, goalId, objective),
            onPrepared: objective => {
              const nextFeedback = {
                completedGoalId: feedback.completedGoalId,
                preparedObjective: objective,
              };
              window.localStorage.setItem(
                goalFeedbackStorageKey(sessionId),
                JSON.stringify(nextFeedback),
              );
              if (submissionIsCurrent()) updateCompletionFeedback(nextFeedback);
            },
            canSend: submissionIsCurrent,
            feedback: finalPrompt,
            send: async gatewayPrompt =>
              onSubmit(
                finalPrompt,
                attachmentPayloads.length > 0 ? attachmentPayloads : undefined,
                gatewayPrompt,
              ),
          });
          if (outcome === 'context_changed') return;
          if (outcome === 'restart_failed') {
            if (!submissionIsCurrent()) return;
            window.dispatchEvent(
              new CustomEvent('app:showToast', {
                detail: i18nService.t('coworkGoalContinueImprovingFailed'),
              }),
            );
            return;
          }
          if (outcome === 'send_failed') {
            if (submissionIsCurrent()) {
              window.dispatchEvent(
                new CustomEvent('app:showToast', {
                  detail: i18nService.t('coworkGoalFeedbackSendFailed'),
                }),
              );
            }
            return;
          }
          const submissionStillCurrent = submissionIsCurrent();
          clearSubmittedInput(submissionStillCurrent);
          if (submissionStillCurrent) {
            window.localStorage.removeItem(goalFeedbackStorageKey(sessionId));
            updateCompletionFeedback(null);
          }
          return;
        }
        if (
          sessionId &&
          (sessionGoalRef.current?.status === SessionGoalStatus.Blocked ||
            goalExecution?.phase === GoalExecutionPhase.AwaitingInput) &&
          !isGoalSlashCommand(trimmedValue)
        ) {
          const resumed = await window.electron.cowork.resumeGoalForUserInput(sessionId);
          if (!resumed.success) {
            window.dispatchEvent(
              new CustomEvent('app:showToast', {
                detail: i18nService.t('coworkGoalResumeForInputFailed'),
              }),
            );
            return;
          }
        }
        const goalObjective = parseGoalStartObjective(trimmedValue);
        const goalClear = isGoalClearCommand(trimmedValue);
        if (goalObjective) {
          cancelGoalClear();
          setPendingGoalObjective(goalObjective);
        }
        if (goalClear) {
          beginGoalClear();
        }

        const clearBeforeSubmit = shouldClearSlashCommandComposerBeforeExecution(trimmedValue);
        if (clearBeforeSubmit) {
          clearSubmittedInput();
        }
        let result: boolean | void;
        try {
          result = await onSubmit(
            finalPrompt,
            attachmentPayloads.length > 0 ? attachmentPayloads : undefined,
          );
        } catch (error) {
          if (goalClear) cancelGoalClear();
          if (goalObjective) {
            setPendingGoalObjective(current => (current === goalObjective ? null : current));
          }
          throw error;
        }
        if (result === false) {
          if (goalClear) cancelGoalClear();
          if (goalObjective) {
            setPendingGoalObjective(current => (current === goalObjective ? null : current));
          }
          return;
        }
        if (goalClear) applyAcceptedGoalClear();
        if (!clearBeforeSubmit) {
          clearSubmittedInput();
        }
      },
      [
        value,
        isRunActive,
        disabled,
        onSubmit,
        attachments,
        showFolderSelector,
        workingDirectory,
        dispatch,
        draftKey,
        modelSupportsImage,
        modelUpdatePending,
        sessionId,
        goalExecution?.phase,
        applyAcceptedGoalClear,
        beginGoalClear,
        cancelGoalClear,
        updateCompletionFeedback,
      ],
    );

    const handleSlashCommandSelect = useCallback(
      (command: SlashCommandDef, executeInstant = true) => {
        if (command.argOptions?.length) {
          const nextValue = `/${command.name} `;
          commitValue(nextValue);
          setSlashMenuMode('args');
          setSlashMenuCommand(command);
          setSlashMenuArgItems(command.argOptions);
          setSlashMenuItems([]);
          setSlashMenuIndex(0);
          setSlashMenuOpen(true);
          focusInputAtEnd(nextValue);
          return;
        }

        const nextValue = command.args ? `/${command.name} ` : `/${command.name}`;
        commitValue(nextValue);
        resetSlashMenuState();
        focusInputAtEnd(nextValue);

        if (executeInstant && command.executeLocal && !command.args) {
          requestAnimationFrame(() => {
            void handleSubmit(nextValue);
          });
        }
      },
      [commitValue, focusInputAtEnd, handleSubmit, resetSlashMenuState],
    );

    const handleSlashArgSelect = useCallback(
      (arg: string, execute = true) => {
        const commandName = slashMenuCommand?.name ?? '';
        if (!commandName) return;
        const nextValue = `/${commandName} ${arg}`;
        commitValue(nextValue);
        resetSlashMenuState();
        focusInputAtEnd(nextValue);
        if (execute) {
          requestAnimationFrame(() => {
            void handleSubmit(nextValue);
          });
        }
      },
      [commitValue, focusInputAtEnd, handleSubmit, resetSlashMenuState, slashMenuCommand?.name],
    );

    const handleSlashButtonClick = useCallback(() => {
      const textarea = textareaRef.current;
      if (!textarea) {
        const nextValue = value ? `${value}/` : '/';
        commitValue(nextValue);
        if (!value) {
          refreshSlashCommands(nextValue);
        }
        return;
      }

      textarea.focus();
      const start = textarea.selectionStart ?? value.length;
      const end = textarea.selectionEnd ?? value.length;
      const nextValue = `${value.slice(0, start)}/${value.slice(end)}`;
      const nextCaret = start + 1;
      latestValueRef.current = nextValue;
      setValue(nextValue);
      if (value.length === 0) {
        updateSlashMenu(nextValue);
        refreshSlashCommands(nextValue);
      } else {
        resetSlashMenuState();
      }
      requestAnimationFrame(() => {
        textarea.selectionStart = nextCaret;
        textarea.selectionEnd = nextCaret;
      });
    }, [commitValue, refreshSlashCommands, resetSlashMenuState, updateSlashMenu, value]);

    const handleInputChange = useCallback(
      (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        const nextValue = event.target.value;
        latestValueRef.current = nextValue;
        setValue(nextValue);
        updateSlashMenu(nextValue);
        refreshSlashCommands(nextValue);
      },
      [refreshSlashCommands, updateSlashMenu],
    );

    const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
      if (isComposing) return;

      if (slashMenuOpen && slashMenuMode === 'args' && slashMenuArgItems.length > 0) {
        const len = slashMenuArgItems.length;
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            setSlashMenuIndex(index => (index + 1) % len);
            return;
          case 'ArrowUp':
            event.preventDefault();
            setSlashMenuIndex(index => (index - 1 + len) % len);
            return;
          case 'Tab':
            event.preventDefault();
            handleSlashArgSelect(slashMenuArgItems[slashMenuIndex] ?? slashMenuArgItems[0], false);
            return;
          case 'Enter':
            event.preventDefault();
            handleSlashArgSelect(slashMenuArgItems[slashMenuIndex] ?? slashMenuArgItems[0], true);
            return;
          case 'Escape':
            event.preventDefault();
            resetSlashMenuState();
            return;
        }
      }

      if (slashMenuOpen && slashMenuItems.length > 0) {
        const len = slashMenuItems.length;
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            setSlashMenuIndex(index => (index + 1) % len);
            return;
          case 'ArrowUp':
            event.preventDefault();
            setSlashMenuIndex(index => (index - 1 + len) % len);
            return;
          case 'Tab':
            event.preventDefault();
            handleSlashCommandSelect(slashMenuItems[slashMenuIndex] ?? slashMenuItems[0], false);
            return;
          case 'Enter':
            event.preventDefault();
            handleSlashCommandSelect(slashMenuItems[slashMenuIndex] ?? slashMenuItems[0], true);
            return;
          case 'Escape':
            event.preventDefault();
            resetSlashMenuState();
            return;
        }
      }

      if (event.key !== 'Enter') return;

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

      if (isSendCombo && !isRunActive && !disabled) {
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
        void onStop();
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

    const hasImageAttachment = attachments.some(isImageAttachment);

    useEffect(() => {
      setImageVisionHint(!modelSupportsImage && hasImageAttachment);
    }, [draftKey, hasImageAttachment, modelSupportsImage]);

    useEffect(() => {
      if (!modelSupportsImage) return;

      const imagesToHydrate = attachments.filter(
        attachment =>
          !attachment.dataUrl &&
          !attachment.path.startsWith('inline:') &&
          isImagePath(attachment.path),
      );
      if (imagesToHydrate.length === 0) return;

      let cancelled = false;
      void Promise.all(
        imagesToHydrate.map(async attachment => {
          try {
            const result = await window.electron.dialog.readFileAsDataUrl(attachment.path);
            return result.success && result.dataUrl
              ? { path: attachment.path, dataUrl: result.dataUrl }
              : null;
          } catch (error) {
            console.error('Failed to hydrate image after model switch:', error);
            return null;
          }
        }),
      ).then(results => {
        if (cancelled) return;
        for (const result of results) {
          if (!result) continue;
          dispatch(
            hydrateDraftImageAttachment({
              draftKey,
              path: result.path,
              dataUrl: result.dataUrl,
            }),
          );
        }
      });

      return () => {
        cancelled = true;
      };
    }, [attachments, dispatch, draftKey, modelSupportsImage]);

    const contextUsageText = useMemo(() => {
      if (!contextUsage) return null;
      const contextTokens =
        contextUsage.contextTokens || effectiveSelectedModel?.contextLength || 200_000;
      if (contextTokens <= 0) return null;
      const usedTokens = Math.max(0, contextUsage.totalTokens);
      const percentage = Math.round((usedTokens / contextTokens) * 100);
      return `${formatContextLength(usedTokens)} / ${formatContextLength(contextTokens)} · ${percentage}%`;
    }, [contextUsage, effectiveSelectedModel?.contextLength]);
    const contextUsageStatusText = sessionId && contextUsageText ? contextUsageText : null;
    const contextUsageBadge = contextUsageStatusText ? (
      <span
        className="inline-flex h-7 max-w-[190px] items-center rounded-md border border-border/60 bg-surface-raised/70 px-2 text-[11px] font-medium leading-none text-secondary tabular-nums select-none shadow-subtle"
        title={i18nService.t('coworkContextUsageFullLabel')}
      >
        <span className="truncate">{contextUsageStatusText}</span>
      </span>
    ) : null;

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
        isRunActive,
        modelSupportsImage,
        saveInlineFile,
      ],
    );

    const handleAddFile = useCallback(async () => {
      if (isAddingFile || disabled || isRunActive) return;
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
    }, [addAttachment, isAddingFile, disabled, isRunActive, modelSupportsImage]);

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
      if (!disabled && !isRunActive) {
        setIsDraggingFiles(true);
      }
    };

    const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = disabled || isRunActive ? 'none' : 'copy';
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
      if (disabled || isRunActive) return;
      void handleIncomingFiles(event.dataTransfer.files);
    };

    const handlePaste = useCallback(
      (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
        if (disabled || isRunActive) return;
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return;
        event.preventDefault();
        void handleIncomingFiles(files);
      },
      [disabled, handleIncomingFiles, isRunActive],
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
          disabled: disabled || isRunActive,
        },
        {
          action: 'selectAll' as const,
          label: i18nService.t('contextMenuSelectAll'),
          disabled: value.length === 0,
        },
      ];
    }, [disabled, isRunActive, value, contextMenuPos]);

    const canSubmit = !disabled && !modelUpdatePending && !hasNoAvailableModels && !!value.trim();
    const effectivePlaceholder = completionFeedback
      ? i18nService.t('coworkGoalCompletionFeedbackPlaceholder')
      : placeholder;
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

    // OpenClaw owns Goal lifecycle state. Refresh from exact session events instead of polling
    // an idle active Goal, which cannot change without a Gateway event or a new run.
    useEffect(() => {
      if (!sessionId || sessionId.startsWith('temp-')) return;
      let cancelled = false;
      let retryId: number | null = null;
      let requestInFlight = false;
      let refreshQueued = false;
      const fetchGoal = async (allowRetry = true) => {
        if (cancelled) return;
        if (requestInFlight) {
          refreshQueued = true;
          return;
        }
        requestInFlight = true;
        try {
          const result = await window.electron.cowork.getSessionGoal(sessionId);
          if (cancelled) return;
          if (!result.success) {
            if (allowRetry) {
              retryId = window.setTimeout(() => void fetchGoal(false), 1_500);
            }
            return;
          }
          const nextGoal = result.goal ?? null;
          if (goalClearPendingRef.current) {
            const clearDecision = resolveGoalClearFetch(
              goalClearTargetIdRef.current,
              nextGoal?.id ?? null,
            );
            if (clearDecision === 'cleared') {
              cancelGoalClear();
              applyAcceptedGoalClear();
              return;
            }
            if (clearDecision === 'ignore_old_goal') return;
            cancelGoalClear();
          }
          sessionGoalRef.current = nextGoal;
          setSessionGoal(nextGoal);
          const feedback = completionFeedbackRef.current;
          if (
            feedback &&
            shouldDiscardGoalCompletionFeedback(feedback.completedGoalId, nextGoal?.id)
          ) {
            window.localStorage.removeItem(goalFeedbackStorageKey(sessionId));
            updateCompletionFeedback(null);
          }
          // A successful null response can occur between command acceptance and Gateway metadata
          // convergence. Keep the optimistic card mounted until a canonical Goal replaces it;
          // submission failures and unrelated session changes clear the pending objective explicitly.
          if (nextGoal) {
            setPendingGoalObjective(null);
          }
        } catch {
          if (allowRetry) {
            retryId = window.setTimeout(() => void fetchGoal(false), 1_500);
          }
        } finally {
          requestInFlight = false;
          if (refreshQueued && !cancelled) {
            refreshQueued = false;
            void fetchGoal(allowRetry);
          }
        }
      };
      void fetchGoal();
      void window.electron.cowork.getGoalExecution(sessionId).then(result => {
        if (!cancelled && result.success) setGoalExecution(result.execution ?? null);
      });
      const removeGoalListener = window.electron.cowork.onSessionGoalChanged(data => {
        if (data.sessionId === sessionId) void fetchGoal();
      });
      const removeExecutionListener = window.electron.cowork.onGoalExecutionChanged(snapshot => {
        if (snapshot.sessionId !== sessionId) return;
        setGoalExecution(snapshot);
        void fetchGoal();
      });
      return () => {
        cancelled = true;
        removeGoalListener();
        removeExecutionListener();
        if (retryId !== null) window.clearTimeout(retryId);
      };
    }, [applyAcceptedGoalClear, cancelGoalClear, sessionId, updateCompletionFeedback]);

    // During a run, Gateway can expose a live prompt estimate before the final usage lands.
    // Keep the last valid value visible and refresh it without overlapping requests.
    useEffect(() => {
      const previousRun = contextUsageRunRef.current;
      const justFinishedRun =
        previousRun.sessionId === sessionId && previousRun.active && !isRunActive;
      contextUsageRunRef.current = { sessionId, active: isRunActive };
      if (!sessionId || sessionId.startsWith('temp-') || (!hasAssistantMessage && !isRunActive)) {
        return;
      }
      return startContextUsageRefresh({
        isRunActive,
        retryAfterSuccess: justFinishedRun,
        fetchUsage: () => window.electron.cowork.getContextUsage(sessionId),
        onUsage: result => {
          setContextUsage(previous =>
            mergeContextUsageSnapshot(previous, {
              totalTokens: result.totalTokens,
              contextTokens: result.contextTokens ?? effectiveSelectedModel?.contextLength ?? 0,
              totalTokensFresh: result.totalTokensFresh ?? true,
              compactionCount: result.compactionCount ?? previous?.compactionCount ?? 0,
              generationKey: [
                result.gatewaySessionId ?? sessionId,
                result.modelRef ?? effectiveSelectedModel?.id ?? '',
              ].join(':'),
            }),
          );
        },
        schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
        cancelSchedule: handle => window.clearTimeout(handle),
      });
    }, [
      sessionId,
      isRunActive,
      hasAssistantMessage,
      effectiveSelectedModel?.contextLength,
      effectiveSelectedModel?.id,
    ]);

    const runGoalAction = useCallback(
      (action: () => void | Promise<void>) =>
        runGoalActionSingleFlight(goalActionPendingRef, setGoalActionPending, action),
      [],
    );
    const submitGoalCommand = useCallback(
      async (command: string) => {
        const goalClear = isGoalClearCommand(command);
        if (goalClear) beginGoalClear();
        try {
          const result = await onSubmit(command);
          if (result === false) {
            if (goalClear) cancelGoalClear();
            return false;
          }
          if (goalClear) applyAcceptedGoalClear();
          return true;
        } catch (error) {
          if (goalClear) cancelGoalClear();
          throw error;
        }
      },
      [applyAcceptedGoalClear, beginGoalClear, cancelGoalClear, onSubmit],
    );

    const handleGoalCommand = useCallback(
      (command: string) => {
        if (disabled || isRunActive) return;
        void runGoalAction(async () => {
          await submitGoalCommand(command);
        });
      },
      [disabled, isRunActive, runGoalAction, submitGoalCommand],
    );

    const handleGoalEdit = useCallback(
      async (objective: string): Promise<boolean> => {
        const currentGoal = sessionGoalRef.current;
        const stoppedCurrentGoal =
          goalExecution?.phase === GoalExecutionPhase.Stopped &&
          !!currentGoal &&
          (!goalExecution.goalId || goalExecution.goalId === currentGoal.id);
        const normalizedObjective = objective.trim();
        if (
          !currentGoal ||
          currentGoal.status === SessionGoalStatus.Complete ||
          goalExecution?.phase === GoalExecutionPhase.AwaitingConfirmation ||
          !normalizedObjective ||
          disabled ||
          (isRunActive && !stoppedCurrentGoal) ||
          goalActionPendingRef.current
        ) {
          return false;
        }
        let accepted = false;
        try {
          const started = await runGoalAction(async () => {
            accepted = await submitGoalCommand(`/goal edit ${normalizedObjective}`);
          });
          if (started && accepted) return true;
        } catch {
          // submitGoalCommand failures are surfaced as a Goal-specific toast below.
        }
        window.dispatchEvent(
          new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkGoalEditFailed'),
          }),
        );
        return false;
      },
      [
        disabled,
        goalExecution?.goalId,
        goalExecution?.phase,
        isRunActive,
        runGoalAction,
        submitGoalCommand,
      ],
    );

    const handleGoalPause = useCallback(async () => {
      if (disabled || !onStop) return;
      await runGoalAction(async () => {
        const stopped = await onStop();
        if (stopped === false) return;
        await onSubmit('/goal pause');
      });
    }, [disabled, onStop, onSubmit, runGoalAction]);

    const handleGoalContinue = useCallback(async () => {
      if (
        !sessionId ||
        sessionId.startsWith('temp-') ||
        disabled ||
        (isRunActive && goalExecution?.phase !== GoalExecutionPhase.Stopped)
      ) {
        return;
      }
      await runGoalAction(async () => {
        const result = await window.electron.cowork.continueGoal(sessionId);
        if (!result.success) {
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkGoalContinueFailed'),
            }),
          );
          return;
        }
        if (result.execution) setGoalExecution(result.execution);
      });
    }, [disabled, goalExecution?.phase, isRunActive, runGoalAction, sessionId]);

    const handleGoalContinueImproving = useCallback(() => {
      const goal = sessionGoalRef.current;
      const completionVisible =
        goal?.status === SessionGoalStatus.Complete ||
        goalExecution?.phase === GoalExecutionPhase.AwaitingConfirmation;
      if (!goal || !completionVisible || disabled) return;
      const nextFeedback = {
        completedGoalId: goal.id,
        preparedObjective: goal.objective,
      };
      if (sessionId && !sessionId.startsWith('temp-')) {
        window.localStorage.setItem(
          goalFeedbackStorageKey(sessionId),
          JSON.stringify(nextFeedback),
        );
      }
      updateCompletionFeedback(nextFeedback);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    }, [disabled, goalExecution?.phase, sessionId, updateCompletionFeedback]);

    const handleGoalCancelImproving = useCallback(() => {
      if (sessionId && !sessionId.startsWith('temp-')) {
        window.localStorage.removeItem(goalFeedbackStorageKey(sessionId));
      }
      updateCompletionFeedback(null);
    }, [sessionId, updateCompletionFeedback]);

    const handleGoalEndRequest = useCallback(() => {
      const goal = sessionGoalRef.current;
      if (!goal || disabled || goalActionPendingRef.current) return;
      setEndingGoalId(goal.id);
    }, [disabled]);

    const handleGoalEndConfirm = useCallback(async () => {
      const goalId = endingGoalId;
      setEndingGoalId(null);
      if (!goalId || disabled || sessionGoalRef.current?.id !== goalId) return;
      await runGoalAction(async () => {
        await submitGoalCommand('/goal clear');
      });
    }, [disabled, endingGoalId, runGoalAction, submitGoalCommand]);

    const handleGoalEndDialogKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Escape' && !goalActionPending) {
          event.preventDefault();
          setEndingGoalId(null);
          return;
        }
        if (event.key !== 'Tab') return;
        const firstButton = goalEndCancelButtonRef.current;
        const lastButton = goalEndConfirmButtonRef.current;
        if (!firstButton || !lastButton) return;
        if (event.shiftKey && document.activeElement === firstButton) {
          event.preventDefault();
          lastButton.focus();
        } else if (!event.shiftKey && document.activeElement === lastButton) {
          event.preventDefault();
          firstButton.focus();
        }
      },
      [goalActionPending],
    );

    const slashMenuVisible =
      slashMenuOpen &&
      (slashMenuMode === 'args'
        ? !!slashMenuCommand && slashMenuArgItems.length > 0
        : slashMenuItems.length > 0);

    useEffect(() => {
      if (!slashMenuVisible) return;

      const selectedOption = slashMenuRef.current?.querySelector<HTMLElement>(
        '[role="option"][aria-selected="true"]',
      );
      selectedOption?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [slashMenuArgItems, slashMenuIndex, slashMenuItems, slashMenuMode, slashMenuVisible]);

    const groupedSlashItems = useMemo(() => {
      const grouped = new Map<
        SlashCommandCategory,
        Array<{ command: SlashCommandDef; index: number }>
      >();
      slashMenuItems.forEach((command, index) => {
        const category = command.category ?? 'session';
        const existing = grouped.get(category) ?? [];
        existing.push({ command, index });
        grouped.set(category, existing);
      });
      return Array.from(grouped.entries());
    }, [slashMenuItems]);
    const hiddenCommandCount = slashMenuExpanded ? 0 : getHiddenCommandCount(slashCommands);

    return (
      <div className="relative">
        {(sessionGoal || pendingGoalObjective) && (
          <GoalStatusCard
            goal={sessionGoal}
            pendingObjective={pendingGoalObjective}
            execution={goalExecution}
            isRunning={isRunActive}
            completionFeedbackActive={completionFeedback !== null}
            disabled={disabled || goalActionPending}
            onCommand={handleGoalCommand}
            onEdit={handleGoalEdit}
            onPause={handleGoalPause}
            onContinue={handleGoalContinue}
            onContinueImproving={handleGoalContinueImproving}
            onCancelContinueImproving={handleGoalCancelImproving}
            onEnd={handleGoalEndRequest}
          />
        )}
        {endingGoalId && (
          <Modal
            onClose={() => setEndingGoalId(null)}
            className="mx-4 w-full max-w-sm overflow-hidden rounded-2xl bg-surface shadow-xl"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="cowork-goal-end-confirm-title"
              aria-describedby="cowork-goal-end-confirm-message"
              onKeyDown={handleGoalEndDialogKeyDown}
            >
              <div className="flex items-center gap-3 px-5 py-4">
                <div className="rounded-full bg-red-100 p-2 dark:bg-red-900/30">
                  <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
                </div>
                <h2
                  id="cowork-goal-end-confirm-title"
                  className="text-base font-semibold text-foreground"
                >
                  {i18nService.t('coworkGoalEndConfirmTitle')}
                </h2>
              </div>
              <div className="px-5 pb-4">
                <p id="cowork-goal-end-confirm-message" className="text-sm text-secondary">
                  {i18nService.t('coworkGoalEndConfirmMessage')}
                </p>
              </div>
              <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
                <button
                  ref={goalEndCancelButtonRef}
                  type="button"
                  onClick={() => setEndingGoalId(null)}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-raised"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  ref={goalEndConfirmButtonRef}
                  type="button"
                  disabled={goalActionPending}
                  onClick={() => void handleGoalEndConfirm()}
                  className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {i18nService.t('coworkGoalEnd')}
                </button>
              </div>
            </div>
          </Modal>
        )}
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
        {slashMenuVisible && (
          <div
            ref={slashMenuRef}
            className="absolute bottom-full left-0 right-0 z-40 mb-2 max-h-80 overflow-y-auto rounded-lg border border-border bg-surface p-1.5 shadow-elevated"
            role="listbox"
            aria-label="Slash commands"
          >
            {slashMenuMode === 'args' && slashMenuCommand ? (
              <div>
                <div className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-primary/75">
                  /{slashMenuCommand.name} {slashMenuCommand.description}
                </div>
                {slashMenuArgItems.map((arg, index) => (
                  <button
                    key={arg}
                    type="button"
                    onClick={() => handleSlashArgSelect(arg, false)}
                    onMouseEnter={() => setSlashMenuIndex(index)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                      index === slashMenuIndex ? 'bg-primary-muted' : 'hover:bg-surface-raised'
                    }`}
                    role="option"
                    aria-selected={index === slashMenuIndex}
                  >
                    <span className="font-mono text-sm font-semibold text-primary">{arg}</span>
                    <span className="min-w-0 flex-1 truncate text-right text-xs text-secondary">
                      /{slashMenuCommand.name} {arg}
                    </span>
                  </button>
                ))}
                <div className="mt-1 border-t border-border px-2.5 py-1.5 text-[11px] text-secondary">
                  ↑↓ navigate · Tab fill · Enter run · Esc close
                </div>
              </div>
            ) : (
              <>
                {groupedSlashItems.map(([category, entries]) => (
                  <div
                    key={category}
                    className="border-border pt-1 first:pt-0 [&:not(:first-child)]:mt-1 [&:not(:first-child)]:border-t"
                  >
                    <div className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-primary/75">
                      {SlashCommandCategoryLabels[category]}
                    </div>
                    {entries.map(({ command, index }) => (
                      <button
                        key={command.key}
                        type="button"
                        onClick={() => handleSlashCommandSelect(command, true)}
                        onMouseEnter={() => setSlashMenuIndex(index)}
                        className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${
                          index === slashMenuIndex ? 'bg-primary-muted' : 'hover:bg-surface-raised'
                        }`}
                        role="option"
                        aria-selected={index === slashMenuIndex}
                      >
                        <span className="font-mono text-sm font-semibold text-primary">
                          /{command.name}
                        </span>
                        {command.args && (
                          <span className="font-mono text-xs text-secondary/70">
                            {command.args}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-right text-xs text-secondary">
                          {command.description}
                        </span>
                        {command.argOptions?.length ? (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                            {command.argOptions.length} options
                          </span>
                        ) : command.executeLocal && !command.args ? (
                          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                            instant
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ))}
                {hiddenCommandCount > 0 && (
                  <button
                    type="button"
                    onClick={event => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSlashMenuExpanded(true);
                      updateSlashMenu(value, { keepExpanded: true });
                    }}
                    className="mt-1 w-full border-t border-border px-2.5 py-2 text-center text-xs font-semibold text-primary hover:bg-primary/10"
                  >
                    Show {hiddenCommandCount} more command{hiddenCommandCount !== 1 ? 's' : ''}
                  </button>
                )}
                <div className="mt-1 border-t border-border px-2.5 py-1.5 text-[11px] text-secondary">
                  ↑↓ navigate · Tab fill · Enter select · Esc close
                </div>
              </>
            )}
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
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onContextMenu={handleContextMenu}
                placeholder={effectivePlaceholder}
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
                        value={effectiveSelectedModel}
                        loading={modelUpdatePending}
                        onChange={async nextModel => {
                          if (!nextModel) return;
                          confirmedSessionModelRef.current ??= agentSelectedModelRef.current;
                          const selectionContext = modelSelectionContextRef.current;
                          optimisticSessionModelRef.current = nextModel;
                          setOptimisticSessionModel(nextModel);
                          setModelUpdatePending(true);
                          setModelUpdateError(null);
                          const { taskId, completion } = modelSelectionQueueRef.current.enqueue(
                            async () => {
                              if (!sessionId) {
                                const result = await coworkService.setDefaultModel({
                                  modelId: nextModel.id,
                                  providerKey: nextModel.providerKey,
                                  agentId: effectiveAgentId,
                                });
                                if (!result.success) {
                                  throw new Error(result.error || 'setDefaultModel failed');
                                }
                              } else {
                                // Keep the managed OpenClaw default and agent model in sync
                                // with the session selection. The session patch below applies
                                // it immediately to the current Gateway session.
                                const defaultResult = await coworkService.setDefaultModel({
                                  modelId: nextModel.id,
                                  providerKey: nextModel.providerKey,
                                  agentId: effectiveAgentId,
                                });
                                if (!defaultResult.success) {
                                  throw new Error(defaultResult.error || 'setDefaultModel failed');
                                }
                                const modelRef = toOpenClawModelRef(nextModel);
                                if (modelRef) {
                                  const result = await coworkService.patchSessionModel({
                                    sessionId,
                                    model: modelRef,
                                    agentId: effectiveAgentId,
                                  });
                                  if (!result.success) {
                                    if (
                                      result.modelRef &&
                                      selectionContext === modelSelectionContextRef.current &&
                                      modelSelectionQueueRef.current.isLatest(taskId)
                                    ) {
                                      const authoritative = resolveOpenClawModelRef(
                                        result.modelRef,
                                        availableModels,
                                      );
                                      if (authoritative) {
                                        confirmedSessionModelRef.current = authoritative;
                                      }
                                      dispatch(
                                        updateCurrentSessionModelRef({
                                          sessionId,
                                          modelRef: result.modelRef,
                                        }),
                                      );
                                    }
                                    throw new Error(result.error || 'patchSessionModel failed');
                                  }
                                  if (result.modelRef) {
                                    if (
                                      selectionContext !== modelSelectionContextRef.current ||
                                      !modelSelectionQueueRef.current.isLatest(taskId)
                                    ) {
                                      return;
                                    }
                                    const confirmed = resolveOpenClawModelRef(
                                      result.modelRef,
                                      availableModels,
                                    );
                                    if (confirmed) {
                                      confirmedSessionModelRef.current = confirmed;
                                      optimisticSessionModelRef.current = confirmed;
                                      setOptimisticSessionModel(confirmed);
                                    }
                                    dispatch(
                                      updateCurrentSessionModelRef({
                                        sessionId,
                                        modelRef: result.modelRef,
                                      }),
                                    );
                                  }
                                }
                              }
                            },
                          );
                          try {
                            await completion;
                            if (
                              !sessionId &&
                              selectionContext === modelSelectionContextRef.current
                            ) {
                              confirmedSessionModelRef.current = nextModel;
                            }
                            if (!sessionId) {
                              const modelRef = toOpenClawModelRef(nextModel);
                              if (modelRef) {
                                dispatch(
                                  updateAgent({
                                    id: effectiveAgentId,
                                    updates: { model: modelRef },
                                  }),
                                );
                              }
                              dispatch(setSelectedModel(nextModel));
                            }
                            if (!modelSelectionQueueRef.current.isLatest(taskId)) return;
                            setModelUpdatePending(false);
                          } catch (error) {
                            if (!modelSelectionQueueRef.current.isLatest(taskId)) return;
                            const confirmedModel = confirmedSessionModelRef.current;
                            optimisticSessionModelRef.current = confirmedModel;
                            setOptimisticSessionModel(confirmedModel);
                            setModelUpdatePending(false);
                            setModelUpdateError(
                              error instanceof Error ? error.message : String(error),
                            );
                            console.warn('[CoworkPromptInput] Failed to update session model', {
                              sessionId,
                              error,
                            });
                          }
                        }}
                      />
                      {modelUpdateError && (
                        <span className="max-w-60 text-[11px] leading-4 text-red-500" role="alert">
                          {i18nService
                            .t('coworkModelApplyFailed')
                            .replace('{error}', modelUpdateError)}
                        </span>
                      )}
                      {hasNoAvailableModels && (
                        <span className="max-w-60 text-[11px] leading-4 text-red-500">
                          {i18nService.t('noModelAvailableHint')}
                        </span>
                      )}
                    </div>
                  )}
                  {!remoteManaged && (
                    <>
                      <button
                        type="button"
                        onClick={handleSlashButtonClick}
                        className="flex items-center justify-center p-1.5 rounded-lg text-sm text-secondary hover:bg-surface-raised hover:text-foreground transition-colors font-mono font-semibold"
                        title={i18nService.t('slashCommandButton')}
                        aria-label={i18nService.t('slashCommandButton')}
                        disabled={disabled || isRunActive}
                      >
                        /
                      </button>
                      <button
                        type="button"
                        onClick={handleAddFile}
                        className="flex items-center justify-center p-1.5 rounded-lg text-sm text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
                        title={i18nService.t('coworkAddFile')}
                        aria-label={i18nService.t('coworkAddFile')}
                        disabled={disabled || isRunActive || isAddingFile}
                      >
                        <PaperClipIcon className="h-4 w-4" />
                      </button>
                      <PermissionModeSelector />
                      {showFolderSelector && (
                        <>
                          <div className="flex items-center">
                            <button
                              ref={folderButtonRef as React.RefObject<HTMLButtonElement>}
                              type="button"
                              onClick={() => setShowFolderMenu(!showFolderMenu)}
                              aria-haspopup="dialog"
                              aria-expanded={showFolderMenu}
                              aria-label={i18nService.t('workspacePickerTitle')}
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
                            currentFolder={workingDirectory}
                          />
                          {showFolderRequiredWarning && (
                            <div className="absolute left-0 top-full mt-1 px-2 py-1 rounded-md bg-surface-raised text-warning text-xs whitespace-nowrap animate-fade-in-up shadow-subtle z-10">
                              {i18nService.t('coworkSelectFolderFirst')}
                            </div>
                          )}
                        </>
                      )}
                      {contextUsageBadge}
                    </>
                  )}
                  {!remoteManaged && <ActiveSkillBadge />}
                </div>
                <div className="flex items-center gap-2">
                  {isRunActive && <InProgressBadge />}
                  {canStopRun ? (
                    <button
                      type="button"
                      onClick={handleStopClick}
                      className="p-2 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
                      aria-label="Stop"
                    >
                      <StopIcon className="h-5 w-5" />
                    </button>
                  ) : !isRunActive ? (
                    <button
                      type="button"
                      onClick={() => void handleSubmit()}
                      disabled={!canSubmit}
                      className={`p-2 rounded-xl bg-primary hover:bg-primary-hover text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:cursor-not-allowed ${!canSubmit ? 'opacity-50' : ''}`}
                      aria-label="Send"
                      title={getSendShortcutLabel(currentSendShortcut)}
                    >
                      <PaperAirplaneIcon className="h-5 w-5" />
                    </button>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <>
              <textarea
                ref={textareaRef}
                value={value}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onContextMenu={handleContextMenu}
                placeholder={effectivePlaceholder}
                disabled={disabled}
                rows={1}
                className={textareaClass}
              />

              {!remoteManaged && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleSlashButtonClick}
                    className="flex-shrink-0 p-1.5 rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors font-mono font-semibold"
                    title={i18nService.t('slashCommandButton')}
                    aria-label={i18nService.t('slashCommandButton')}
                    disabled={disabled || isRunActive}
                  >
                    /
                  </button>
                  <button
                    type="button"
                    onClick={handleAddFile}
                    className="flex-shrink-0 p-1.5 rounded-lg text-secondary hover:bg-surface-raised hover:text-foreground transition-colors"
                    title={i18nService.t('coworkAddFile')}
                    aria-label={i18nService.t('coworkAddFile')}
                    disabled={disabled || isRunActive || isAddingFile}
                  >
                    <PaperClipIcon className="h-4 w-4" />
                  </button>
                  <PermissionModeSelector />
                  {contextUsageBadge}
                </div>
              )}

              {isRunActive && <InProgressBadge />}
              {canStopRun ? (
                <button
                  type="button"
                  onClick={handleStopClick}
                  className="flex-shrink-0 p-2 rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
                  aria-label="Stop"
                >
                  <StopIcon className="h-4 w-4" />
                </button>
              ) : !isRunActive ? (
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                  className={`flex-shrink-0 p-2 rounded-lg bg-primary hover:bg-primary-hover text-white transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:cursor-not-allowed ${!canSubmit ? 'opacity-50' : ''}`}
                  aria-label="Send"
                  title={getSendShortcutLabel(currentSendShortcut)}
                >
                  <PaperAirplaneIcon className="h-4 w-4" />
                </button>
              ) : null}
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
