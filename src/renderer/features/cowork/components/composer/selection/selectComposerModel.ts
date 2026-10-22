import type { Dispatch, UnknownAction } from '@reduxjs/toolkit';

import { coworkService } from '@/features/cowork/coworkService';
import {
  beginManualModelSelection,
  completeManualModelSelection,
  confirmCurrentSessionModelSelection,
  confirmDefaultModelSelection,
  confirmManualModelSelection,
  rollbackManualModelSelection,
} from '@/features/cowork/coworkSlice';
import type { Model } from '@/features/models/modelSlice';
import { resolveOpenClawModelRef } from '@/features/models/openclawModelRef';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import { syncDefaultModelSelectionState } from './defaultModelSelectionState';
import { LatestSerialTaskQueue } from './latestSerialTaskQueue';
import {
  applyModelSelectionUpdate,
  DefaultModelApplyError,
  resolvePersistedSessionModelRefAfterApplyError,
} from './modelSelectionUpdate';

interface ComposerModelSelectionContext {
  dispatch: Dispatch<UnknownAction>;
  modelSelectionContextKey: string;
  sessionId?: string;
  effectiveAgentId: string;
  agentSelectedModel: Model | null;
  effectiveSelectedModel: Model | null;
  availableModels: Model[];
}

// Keep native model changes ordered across composer unmounts and session navigation.
const modelSelectionTaskQueue = new LatestSerialTaskQueue();

export async function selectComposerModel(
  nextModel: Model | null,
  context: ComposerModelSelectionContext,
): Promise<void> {
  const {
    dispatch,
    modelSelectionContextKey,
    sessionId,
    effectiveAgentId,
    agentSelectedModel,
    effectiveSelectedModel,
    availableModels,
  } = context;

  if (!nextModel) return;
  const selectionContextKey = modelSelectionContextKey;
  const { taskId, completion } = modelSelectionTaskQueue.enqueueLatest(
    selectionContextKey,
    async () => {
      try {
        const result = await applyModelSelectionUpdate(
          {
            sessionId,
            agentId: effectiveAgentId,
            model: nextModel,
            shouldSaveDefault: () =>
              modelSelectionTaskQueue.isLatestInScope(effectiveAgentId, taskId),
            onDefaultModelUpdated: () => {
              syncDefaultModelSelectionState(dispatch, effectiveAgentId, nextModel);
              if (sessionId) {
                dispatch(
                  confirmDefaultModelSelection({
                    contextKey: `__home__\0${effectiveAgentId}`,
                    model: nextModel,
                  }),
                );
                dispatch(
                  completeManualModelSelection({
                    contextKey: `__home__\0${effectiveAgentId}`,
                    taskId,
                  }),
                );
              }
            },
            onBackgroundDefaultStart: () => {
              dispatch(
                beginManualModelSelection({
                  contextKey: `__home__\0${effectiveAgentId}`,
                  taskId,
                  model: nextModel,
                  previousModel: agentSelectedModel,
                }),
              );
            },
            onBackgroundDefaultError: error => {
              // The native session is already pinned. A late
              // default-save failure must never undo its model.
              dispatch(
                rollbackManualModelSelection({
                  contextKey: `__home__\0${effectiveAgentId}`,
                  taskId,
                }),
              );
              window.dispatchEvent(
                new CustomEvent('app:showToast', {
                  detail: i18nService
                    .t('coworkDefaultModelApplyFailedSessionUpdated')
                    .replace('{error}', error.message),
                }),
              );
            },
          },
          coworkService,
        );
        if (result.defaultSaveSkipped) return;
        if (!sessionId || !result.sessionModelRef) {
          dispatch(
            confirmManualModelSelection({
              contextKey: selectionContextKey,
              taskId,
              model: nextModel,
            }),
          );
          return;
        }
        const confirmed =
          resolveOpenClawModelRef(result.sessionModelRef, availableModels) ?? nextModel;
        dispatch(
          confirmManualModelSelection({
            contextKey: selectionContextKey,
            taskId,
            model: confirmed,
          }),
        );
        dispatch(
          confirmCurrentSessionModelSelection({
            sessionId,
            modelRef: result.sessionModelRef,
          }),
        );
      } catch (error) {
        const persistedModelRef = resolvePersistedSessionModelRefAfterApplyError(error, nextModel);
        if (persistedModelRef && sessionId) {
          const persistedModel =
            resolveOpenClawModelRef(persistedModelRef, availableModels) ?? nextModel;
          dispatch(
            confirmManualModelSelection({
              contextKey: selectionContextKey,
              taskId,
              model: persistedModel,
            }),
          );
          dispatch(
            confirmCurrentSessionModelSelection({
              sessionId,
              modelRef: persistedModelRef,
            }),
          );
        }
        throw error;
      }
    },
    effectiveAgentId,
  );
  dispatch(
    beginManualModelSelection({
      contextKey: selectionContextKey,
      taskId,
      model: nextModel,
      previousModel: effectiveSelectedModel,
    }),
  );
  try {
    await completion;
    dispatch(
      completeManualModelSelection({
        contextKey: selectionContextKey,
        taskId,
      }),
    );
  } catch (error) {
    const isLatestSelection =
      store.getState().cowork.pendingModelSelectionTaskIds[selectionContextKey] === taskId;
    dispatch(
      rollbackManualModelSelection({
        contextKey: selectionContextKey,
        taskId,
      }),
    );
    if (!isLatestSelection) return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const userMessage = i18nService
      .t(
        error instanceof DefaultModelApplyError
          ? 'coworkDefaultModelApplyFailedSessionUpdated'
          : 'coworkModelApplyFailed',
      )
      .replace('{error}', errorMessage);
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: userMessage }));
    console.warn('[CoworkPromptInput] Failed to update session model', {
      sessionId,
      error,
    });
  }
}
