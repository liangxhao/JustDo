import { OpenClawExtensionId, OpenClawToolName } from '../../../shared/plugins/nativeIds';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { asComputerConfigRecord } from '../config/policies/computerControlConfig';

type Preparation = {
  client: GatewayClientLike;
  config: unknown;
  processGeneration: number;
  configGeneration: number;
  isCurrent: () => boolean;
};

// This is only a resource preparation hint. Native tool/model/placement policy
// still decides whether a run may expose computer control.
function hasEnabledComputerHost(config: unknown): boolean {
  const root = asComputerConfigRecord(config);
  const plugins = asComputerConfigRecord(root.plugins);
  const id = OpenClawExtensionId.CUA_COMPUTER;
  if (plugins.enabled === false ||
    asComputerConfigRecord(asComputerConfigRecord(plugins.entries)[id]).enabled !== true ||
    (Array.isArray(plugins.deny) && plugins.deny.includes(id)) ||
    (Array.isArray(plugins.allow) && plugins.allow.length > 0 && !plugins.allow.includes(id))) {
    return false;
  }
  const deny = asComputerConfigRecord(root.tools).deny;
  return !Array.isArray(deny) || !deny.some(value =>
    typeof value === 'string' && ['*', OpenClawToolName.COMPUTER].includes(value.trim().toLowerCase()));
}

export class ComputerHostPreparation {
  private readonly pending = new WeakMap<GatewayClientLike, {
    processGeneration: number;
    configGeneration: number;
  }>();

  start(preparation: Preparation): void {
    if (!hasEnabledComputerHost(preparation.config) || !preparation.isCurrent()) return;
    const { client, processGeneration, configGeneration, isCurrent } = preparation;
    const pending = this.pending.get(client);
    if (pending?.processGeneration === processGeneration && pending.configGeneration === configGeneration) return;

    const startedAt = Date.now();
    const entry = { processGeneration, configGeneration };
    this.pending.set(client, entry);
    // Never await host startup on the admission/configuration queue. Use only
    // this already-connected client; background work must not launch Gateway.
    void Promise.resolve().then(async () => {
      if (!isCurrent()) return;
      const result = await client.request<{ available?: unknown }>(
        'computer.status', {}, { timeoutMs: 60_000 },
      );
      if (!isCurrent()) return;
      console.info('[ComputerHostPreparation]', {
        elapsedMs: Date.now() - startedAt,
        available: result.available === true,
      });
    }).catch(() => {
      if (isCurrent()) console.info('[ComputerHostPreparation]', {
        elapsedMs: Date.now() - startedAt,
        available: false,
      });
    }).finally(() => {
      if (this.pending.get(client) === entry) this.pending.delete(client);
    });
  }
}
