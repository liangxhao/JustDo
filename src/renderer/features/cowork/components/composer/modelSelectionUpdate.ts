import type { Model } from '@/features/models/modelSlice';
import { toOpenClawModelRef } from '@/features/models/openclawModelRef';

interface ModelSelectionUpdateResult {
  sessionModelRef?: string;
}

interface ModelSelectionUpdateServices {
  setDefaultModel: (options: {
    modelId: string;
    providerKey?: string;
    modelRef?: string;
    agentId: string;
  }) => Promise<{ success: boolean; error?: string }>;
  patchSessionModel: (options: {
    sessionId: string;
    model: string;
    agentId: string;
  }) => Promise<{ success: boolean; modelRef?: string; error?: string }>;
}

interface ApplyModelSelectionUpdateOptions {
  sessionId?: string;
  agentId: string;
  model: Model;
  onDefaultModelUpdated: () => void;
  /** Existing sessions can finish switching while the future-chat default saves. */
  onBackgroundDefaultError?: (error: DefaultModelApplyError) => void;
  onBackgroundDefaultStart?: () => void;
}

export class SessionModelApplyError extends Error {
  readonly currentModelRef?: string;

  constructor(message: string, currentModelRef?: string) {
    super(message);
    this.name = 'SessionModelApplyError';
    this.currentModelRef = currentModelRef;
  }
}

export class DefaultModelApplyError extends Error {
  readonly sessionModelRef: string;

  constructor(message: string, sessionModelRef: string) {
    super(message);
    this.name = 'DefaultModelApplyError';
    this.sessionModelRef = sessionModelRef;
  }
}

export const resolvePersistedSessionModelRefAfterApplyError = (
  error: unknown,
  requestedModel: Model,
): string | undefined => {
  if (error instanceof DefaultModelApplyError) return error.sessionModelRef;
  if (
    error instanceof SessionModelApplyError &&
    error.currentModelRef &&
    error.currentModelRef === toOpenClawModelRef(requestedModel)
  ) {
    return error.currentModelRef;
  }
  return undefined;
};

export const applyModelSelectionUpdate = async (
  options: ApplyModelSelectionUpdateOptions,
  services: ModelSelectionUpdateServices,
): Promise<ModelSelectionUpdateResult> => {
  const modelRef = toOpenClawModelRef(options.model);

  let sessionModelRef: string | undefined;
  if (options.sessionId && modelRef) {
    // v2026.9.6 pins concrete selections, including the current default.
    // Confirm the session first; a failed switch must not change future chats.
    let sessionResult: Awaited<ReturnType<ModelSelectionUpdateServices['patchSessionModel']>>;
    try {
      sessionResult = await services.patchSessionModel({
        sessionId: options.sessionId,
        model: modelRef,
        agentId: options.agentId,
      });
    } catch (error) {
      throw new SessionModelApplyError(error instanceof Error ? error.message : String(error));
    }
    if (!sessionResult.success) {
      throw new SessionModelApplyError(
        sessionResult.error || 'patchSessionModel failed',
        sessionResult.modelRef,
      );
    }
    sessionModelRef = sessionResult.modelRef?.trim();
    if (!sessionModelRef) {
      throw new SessionModelApplyError('patchSessionModel returned no confirmed model');
    }
  }

  const saveDefault = async () => {
    let defaultResult: Awaited<ReturnType<ModelSelectionUpdateServices['setDefaultModel']>>;
    try {
      defaultResult = await services.setDefaultModel({
        modelId: options.model.id,
        providerKey: options.model.providerKey,
        modelRef,
        agentId: options.agentId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sessionModelRef) throw new DefaultModelApplyError(message, sessionModelRef);
      throw error;
    }
    if (!defaultResult.success) {
      if (sessionModelRef) {
        throw new DefaultModelApplyError(
          defaultResult.error || 'setDefaultModel failed',
          sessionModelRef,
        );
      }
      throw new Error(defaultResult.error || 'setDefaultModel failed');
    }

    options.onDefaultModelUpdated();
  };
  if (sessionModelRef && options.onBackgroundDefaultError) {
    const confirmedRef = sessionModelRef;
    const onError = options.onBackgroundDefaultError;
    options.onBackgroundDefaultStart?.();
    void saveDefault().catch(error => {
      onError(error instanceof DefaultModelApplyError
        ? error
        : new DefaultModelApplyError(String(error), confirmedRef));
    });
  } else {
    // New chats have no pinned session yet: their default must be applied
    // before the selection completes and sending becomes available.
    await saveDefault();
  }
  return sessionModelRef ? { sessionModelRef } : {};
};
