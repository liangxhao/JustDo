import type { Dispatch, UnknownAction } from '@reduxjs/toolkit';

import { coworkService } from '@/features/cowork/coworkService';
import {
  beginManualModelSelection,
  completeManualModelSelection,
  confirmCurrentSessionModelSelection,
  confirmDefaultModelSelection,
  confirmManualModelSelection,
} from '@/features/cowork/coworkSlice';
import type { Model } from '@/features/models/modelSlice';
import { resolveOpenClawModelRef } from '@/features/models/openclawModelRef';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

import { syncDefaultModelSelectionState } from './defaultModelSelectionState';
import { LatestSerialTaskQueue } from './latestSerialTaskQueue';
import { applyModelSelectionUpdate } from './modelSelectionUpdate';

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
const pendingSelections = new Map<
  string,
  {
    taskId: number;
    confirmed: Promise<{ success: true } | { success: false; error: unknown }>;
  }
>();

/** Capture the current selection receipt before accepting a session send. */
export async function waitForComposerModelSelection(contextKey: string): Promise<boolean> {
  const pending = pendingSelections.get(contextKey);
  if (pending) {
    const result = await pending.confirmed;
    if (result.success) return true;
    throw result.error;
  }
  // A pending projection without its owning receipt cannot establish success.
  if (store.getState().cowork.pendingModelSelectionTaskIds[contextKey] !== undefined)
    throw new Error(i18nService.t('modelSelectorUnavailableSelection'));
  return true;
}

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
      const result = await applyModelSelectionUpdate(
        {
          sessionId,
          agentId: effectiveAgentId,
          model: nextModel,
          shouldSaveDefault: () =>
            modelSelectionTaskQueue.isLatestInScope(effectiveAgentId, taskId),
          onDefaultModelUpdated: () => {
            if (!modelSelectionTaskQueue.isLatestInScope(effectiveAgentId, taskId)) return;
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
            if (!modelSelectionTaskQueue.isLatestInScope(effectiveAgentId, taskId)) return;
            dispatch(
              beginManualModelSelection({
                contextKey: `__home__\0${effectiveAgentId}`,
                taskId,
                model: nextModel,
                previousModel: agentSelectedModel,
              }),
            );
          },
          // Saving a future-chat preference cannot undo the desired model
          // or reject a send whose native session was already confirmed.
          onBackgroundDefaultError: () => undefined,
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
    },
    effectiveAgentId,
  );
  const confirmed = completion.then(
    () => {
      dispatch(completeManualModelSelection({ contextKey: selectionContextKey, taskId }));
      if (pendingSelections.get(selectionContextKey)?.taskId === taskId)
        pendingSelections.delete(selectionContextKey);
      return { success: true as const };
    },
    error => {
      // Selection records intent immediately. Keep both that intent and its
      // failed receipt until another choice replaces it; only Send reports it.
      return { success: false as const, error };
    },
  );
  pendingSelections.set(selectionContextKey, { taskId, confirmed });
  dispatch(
    beginManualModelSelection({
      contextKey: selectionContextKey,
      taskId,
      model: nextModel,
      previousModel: effectiveSelectedModel,
    }),
  );
  await confirmed;
}
