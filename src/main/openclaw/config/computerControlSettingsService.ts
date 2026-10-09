import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';
import type { ComputerControlResult } from '../../../shared/security/computerControl';
import { asComputerConfigRecord, buildComputerControlPatch } from './computerControlConfig';

type Request = <T>(method: string, params?: unknown) => Promise<T>;

export class ComputerControlSettingsService {
  constructor(
    private readonly request: Request,
    private readonly isAvailable: () => boolean,
    private readonly isToolAdmitted: (tools: Record<string, unknown>) => Promise<boolean>,
  ) {}

  private async snapshot() {
    if (!this.isAvailable()) throw new Error('unavailable');
    const result = await this.request<{ config?: unknown; valid?: boolean; hash?: string }>(
      'config.get',
      {},
    );
    if (
      result.valid !== true ||
      typeof result.hash !== 'string' ||
      !result.hash.trim() ||
      !result.config ||
      typeof result.config !== 'object' ||
      Array.isArray(result.config)
    ) {
      throw new Error('Invalid computer control configuration');
    }
    return { config: asComputerConfigRecord(result.config), hash: result.hash };
  }

  private async result(operation: () => Promise<boolean>): Promise<ComputerControlResult> {
    try {
      return { success: true, enabled: await operation() };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = /conflict|baseHash|changed since/i.test(message)
        ? 'conflict'
        : /unavailable|not connected|not running|timeout|ENGINE_NOT_READY/i.test(message)
          ? 'unavailable'
          : 'failed';
      return { success: false, code };
    }
  }

  get = (): Promise<ComputerControlResult> =>
    this.result(async () => {
      const { config } = await this.snapshot();
      const plugins = asComputerConfigRecord(config.plugins);
      const entry = asComputerConfigRecord(
        asComputerConfigRecord(plugins.entries)[OpenClawExtensionId.CUA_COMPUTER],
      );
      const id = OpenClawExtensionId.CUA_COMPUTER;
      return (
        plugins.enabled !== false &&
        entry.enabled === true &&
        !(Array.isArray(plugins.deny) && plugins.deny.includes(id)) &&
        (!Array.isArray(plugins.allow) || !plugins.allow.length || plugins.allow.includes(id)) &&
        (await this.isToolAdmitted(asComputerConfigRecord(config.tools)))
      );
    });

  setEnabled = (enabled: unknown): Promise<ComputerControlResult> => {
    if (typeof enabled !== 'boolean') return Promise.resolve({ success: false, code: 'invalid' });
    return this.result(async () => {
      const { config, hash } = await this.snapshot();
      if (enabled && asComputerConfigRecord(config.plugins).enabled === false)
        throw new Error('Plugin policy prevents computer control');
      const patch = buildComputerControlPatch(config, enabled);
      if (
        enabled &&
        !(await this.isToolAdmitted({
          ...asComputerConfigRecord(config.tools),
          ...JSON.parse(patch.raw).tools,
        }))
      ) {
        // Keep broader denials/profile restrictions intact instead of reporting a false success.
        throw new Error('Tool policy prevents computer control');
      }
      // One revision-bound native write updates both choices and applies the native reload plan.
      await this.request('config.patch', {
        baseHash: hash,
        ...patch,
      });
      return enabled;
    });
  };
}
