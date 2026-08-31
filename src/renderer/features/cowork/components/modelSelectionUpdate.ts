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
    // OpenClaw clears a session override when it matches the current agent
    // default. Patch first so a selection that differs from the old default
    // remains an explicit override when the default changes afterward.
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
    sessionModelRef = sessionResult.modelRef || modelRef;
  }

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
  return sessionModelRef ? { sessionModelRef } : {};
};
