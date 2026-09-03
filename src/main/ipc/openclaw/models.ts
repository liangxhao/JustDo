import { ipcMain } from 'electron';

import {
  OpenClawModelsIpc,
  type OpenClawModelsListResult,
} from '../../../shared/openclaw/models';
import type { OpenClawRuntimeAdapter } from '../../engine';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

const nonNegativeInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

const modelInputKinds = new Set(['text', 'image', 'audio', 'video', 'document']);
const unavailableReasons = new Set(['missing-auth', 'auth-failed', 'cooldown']);

export const normalizeOpenClawModelChoices = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  const models: OpenClawModelsListResult['models'] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = nonEmptyString(record.id);
    const name = nonEmptyString(record.name);
    const provider = nonEmptyString(record.provider);
    if (!id || !name || !provider) continue;
    const input = Array.isArray(record.input)
      ? record.input.filter(
          (kind): kind is NonNullable<OpenClawModelsListResult['models'][number]['input']>[number] =>
            typeof kind === 'string' && modelInputKinds.has(kind),
        )
      : undefined;
    const unavailableReason = nonEmptyString(record.unavailableReason);
    models.push({
      id,
      name,
      provider,
      ...(nonEmptyString(record.alias) ? { alias: nonEmptyString(record.alias) } : {}),
      ...(Array.isArray(record.tags)
        ? { tags: record.tags.map(nonEmptyString).filter((tag): tag is string => !!tag) }
        : {}),
      ...(typeof record.available === 'boolean' ? { available: record.available } : {}),
      ...(unavailableReason && unavailableReasons.has(unavailableReason)
        ? {
            unavailableReason:
              unavailableReason as OpenClawModelsListResult['models'][number]['unavailableReason'],
          }
        : {}),
      ...(nonNegativeInteger(record.unavailableUntil) !== undefined
        ? { unavailableUntil: nonNegativeInteger(record.unavailableUntil) }
        : {}),
      ...(positiveInteger(record.contextWindow) !== undefined
        ? { contextWindow: positiveInteger(record.contextWindow) }
        : {}),
      ...(typeof record.reasoning === 'boolean' ? { reasoning: record.reasoning } : {}),
      ...(typeof record.supportsTools === 'boolean'
        ? { supportsTools: record.supportsTools }
        : {}),
      ...(input ? { input } : {}),
    });
  }
  return models;
};

export const registerOpenClawModelHandlers = ({ getRuntime }: Dependencies): void => {
  ipcMain.handle(
    OpenClawModelsIpc.List,
    async (_event, options?: { agentId?: string }): Promise<OpenClawModelsListResult> => {
      try {
        const runtime = getRuntime();
        if (!runtime) {
          return { success: false, models: [], error: 'OpenClaw runtime is not available' };
        }
        const agentId = nonEmptyString(options?.agentId);
        const result = await runtime.requestGateway<{ models?: unknown }>('models.list', {
          ...(agentId ? { agentId } : {}),
          // This view reflects only models authored in JustDo's provider config while
          // retaining the v2026.8.2 runtime availability and input-capability projection.
          view: 'provider-config',
        });
        return { success: true, models: normalizeOpenClawModelChoices(result?.models) };
      } catch (error) {
        return {
          success: false,
          models: [],
          error: error instanceof Error ? error.message : 'Failed to list OpenClaw models',
        };
      }
    },
  );
};
