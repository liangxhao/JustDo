import { modelRefFromIdentity, readModelRef } from '../../../shared/providers/modelRef';
import { matchesModelSelectionIdentity } from '../../../shared/providers/modelSelectionIdentity';
import { t } from '../../core/i18n';
import { parseModelReferenceV2026_10_6 } from '../openclaw/wire/v2026_10_6';
import { enqueueSessionModelOperation } from './sessionModelOperations';
import type { GatewayClientLike } from './types';

export type ManagedSessionModelConfig = {
  models?: { providers?: Record<string, { models?: Array<{ id?: unknown }> }> };
  agents?: {
    defaults?: { model?: unknown };
    entries?: Record<string, { model?: unknown }>;
  };
};

/** Share route repair policy without retaining a second model catalog. */
export function createManagedSessionModelPolicy(config?: ManagedSessionModelConfig) {
  const defaults = parseModelReferenceV2026_10_6(config?.agents?.defaults?.model);
  const targets = new Map<string, string>();
  for (const [agentId, agent] of Object.entries(config?.agents?.entries ?? {})) {
    const target = parseModelReferenceV2026_10_6(agent.model) ?? defaults;
    if (target) targets.set(agentId, target.reference);
  }
  if (defaults) targets.set('main', targets.get('main') ?? defaults.reference);

  const routes = new Set<string>();
  for (const [providerId, provider] of Object.entries(config?.models?.providers ?? {})) {
    for (const model of provider.models ?? []) {
      if (typeof model.id === 'string' && model.id.trim()) {
        routes.add(`${providerId}/${model.id.trim()}`);
      }
    }
  }
  const availableRoute = (reference: string | null | undefined): string | undefined =>
    reference
      ? routes.has(reference)
        ? reference
        : [...routes].find(route => matchesModelSelectionIdentity(route, reference))
      : undefined;

  return {
    hasTargets: targets.size > 0,
    availableRoute,
    repairTarget: (agentId: string, persistedRef: string | null | undefined) =>
      availableRoute(persistedRef) ?? targets.get(agentId),
  };
}

type PreparedManagedSessionModelOptions = {
  client: Pick<GatewayClientLike, 'request'>;
  isCurrentConnection: () => boolean;
  sessionKey: string;
  gatewaySessionId: string;
  agentId: string;
  getPersistedModelRef: () => string | null | undefined;
  persistModelRef: (modelRef: string) => void;
};

/** Repair only an existing override on the session about to run. */
export async function reconcilePreparedManagedSessionModel({
  client,
  isCurrentConnection,
  sessionKey,
  gatewaySessionId,
  agentId,
  getPersistedModelRef,
  persistModelRef,
}: PreparedManagedSessionModelOptions): Promise<void> {
  const assertCurrent = () => {
    if (!isCurrentConnection()) throw new Error(t('sessionModelPreparationChanged'));
  };
  assertCurrent();
  await enqueueSessionModelOperation(sessionKey, async () => {
    assertCurrent();
    const snapshot = await client.request<{ config?: ManagedSessionModelConfig }>('config.get', {});
    assertCurrent();
    if (!snapshot.config || typeof snapshot.config !== 'object' || Array.isArray(snapshot.config)) {
      throw new Error(t('sessionModelConfigurationUnavailable'));
    }
    const policy = createManagedSessionModelPolicy(snapshot.config);
    const described = await client.request<{ session?: Record<string, unknown> | null }>(
      'sessions.describe', { key: sessionKey },
    );
    assertCurrent();
    if (described.session?.key !== sessionKey ||
      described.session.sessionId !== gatewaySessionId) {
      throw new Error(t('sessionModelIdentityChanged'));
    }
    const selectedRef = readModelRef(described.session);
    const persistedRef = getPersistedModelRef();
    // Re-read after queued user switches; a valid native choice is authoritative.
    if (selectedRef && policy.availableRoute(selectedRef)) {
      if (selectedRef !== persistedRef) persistModelRef(selectedRef);
      return;
    }
    const target = policy.repairTarget(agentId, persistedRef);
    if (!target) throw new Error(t('selectedModelUnavailable'));
    const patched = await client.request<{
      key?: unknown;
      entry?: Record<string, unknown>;
      resolved?: unknown;
    }>('sessions.patch', { key: sessionKey, expectedSessionId: gatewaySessionId, model: target });
    assertCurrent();
    const resolvedRef = readModelRef(patched.resolved);
    const entryRef = modelRefFromIdentity(patched.entry?.modelOverride, patched.entry?.providerOverride);
    if (patched.key !== sessionKey || patched.entry?.sessionId !== gatewaySessionId ||
      !resolvedRef || !entryRef ||
      !matchesModelSelectionIdentity(target, resolvedRef) ||
      !matchesModelSelectionIdentity(target, entryRef)) {
      throw new Error(t('sessionModelPreparationUnconfirmed'));
    }
    persistModelRef(resolvedRef);
  });
}
