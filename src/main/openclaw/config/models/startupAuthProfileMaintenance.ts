import type { GatewayClientLike } from '../../../engine/gateway/types';
import type { OpenClawEngineManager } from '../../runtime/openclawEngineManager';

export type StartupAuthProfileMaintenanceDependencies = {
  getGatewayClient: () => GatewayClientLike | null;
  manager: Pick<OpenClawEngineManager, 'getStatus' | 'getGatewayProcessGeneration'>;
  runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const managedOrphanProviders = (snapshot: unknown): Set<string> => {
  if (!isRecord(snapshot)) return new Set();
  if (snapshot.unavailable) throw new Error('Native model authentication status is unavailable.');
  if (!Array.isArray(snapshot.providers)) return new Set();

  const candidates = new Set<string>();
  const excluded = new Set<string>();
  for (const entry of snapshot.providers) {
    if (!isRecord(entry) || typeof entry.provider !== 'string') continue;
    const provider = entry.provider.trim().toLowerCase();
    if (!provider) continue;
    const profiles = entry.profiles;
    if (
      !Array.isArray(profiles) || profiles.length === 0 ||
      !profiles.every(profile => isRecord(profile) &&
        profile.profileId === `${provider}:default` &&
        profile.type === 'api_key' &&
        (profile.source === 'saved' || profile.source === 'inherited'))
    ) {
      excluded.add(provider);
    } else {
      candidates.add(provider);
    }
  }
  for (const provider of excluded) candidates.delete(provider);
  return candidates;
};

const configuredProviders = (snapshot: unknown): Set<string> | null => {
  if (!isRecord(snapshot) || !isRecord(snapshot.config)) return null;
  const models = snapshot.config.models;
  if (models === undefined) return new Set();
  if (!isRecord(models)) return null;
  const providers = models.providers;
  if (providers === undefined) return new Set();
  return isRecord(providers)
    ? new Set(Object.keys(providers).map(provider => provider.trim().toLowerCase()))
    : null;
};

// This one-shot maintenance uses only the connected client. Discovery must not
// occupy the config queue or become part of the first-send readiness barrier.
export async function maintainStartupAuthProfiles({
  getGatewayClient,
  manager,
  runExclusive,
}: StartupAuthProfileMaintenanceDependencies): Promise<void> {
  const client = getGatewayClient();
  if (!client || manager.getStatus().phase !== 'running') return;
  const generation = manager.getGatewayProcessGeneration();
  const isCurrent = () => manager.getStatus().phase === 'running' &&
    manager.getGatewayProcessGeneration() === generation && getGatewayClient() === client;

  const [discovered, discoveryConfig] = await Promise.all([
    client.request('models.authStatus', { agentId: 'main' }),
    client.request('config.get'),
  ]);
  if (!isCurrent()) return;
  const configuredAtDiscovery = configuredProviders(discoveryConfig);
  if (!configuredAtDiscovery) return;

  for (const provider of managedOrphanProviders(discovered)) {
    if (configuredAtDiscovery.has(provider)) continue;
    if (!isCurrent()) return;
    await runExclusive(async () => {
      if (!isCurrent()) return;
      const [config, auth] = await Promise.all([
        client.request('config.get'),
        client.request('models.authStatus', { agentId: 'main' }),
      ]);
      if (!isCurrent()) return;
      const configured = configuredProviders(config);
      if (!configured || configured.has(provider) || !managedOrphanProviders(auth).has(provider)) return;

      // An orphan discovery never authorizes a provider-wide logout: another
      // profile can be added while startup discovery is still in flight.
      await client.request('models.authLogout', {
        provider,
        agentId: 'main',
        profileIds: [`${provider}:default`],
      });
    });
  }
}
