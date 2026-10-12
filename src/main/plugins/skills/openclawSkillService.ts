import { MAIN_USER_AGENT_ID } from '../../../shared/agents/agents';
import { t } from '../../core/i18n';
import type {
  GatewaySkillEntry,
  GatewaySkillStatus,
  SkillRpcResult,
  SkillUpdateParams,
} from '../../engine/types';

const SKILL_STATE_CONFIRM_INTERVAL_MS = 100;
const SKILL_STATE_CONFIRM_MAX_INTERVAL_MS = 1_000;
const SKILL_STATE_CONFIRM_TIMEOUT_MS = 30_000;
const SKILL_STATE_READ_TIMEOUT_MS = 5_000;
const RETRYABLE_STATUS_ERROR_CODES = new Set([
  'CLIENT_TIMEOUT',
  'UNAVAILABLE',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
]);
const isTransportUnavailable = (error: unknown): boolean =>
  error instanceof Error &&
  /gateway.*(?:not connected|disconnected|closed|stopped|retired)|websocket.*closed|ECONNRESET|ECONNREFUSED|EPIPE/i.test(
    error.message,
  );
const isRetryableStatusError = (error: unknown): boolean => {
  const code =
    (error as { gatewayCode?: unknown; code?: unknown } | null)?.gatewayCode ??
    (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return RETRYABLE_STATUS_ERROR_CODES.has(code);
  return isTransportUnavailable(error);
};

class SkillStatusReadTimeoutError extends Error {
  readonly code = 'CLIENT_TIMEOUT';

  constructor() {
    super('Gateway skill status request timed out');
  }
}

export const isGatewaySkillEnabled = (entry: GatewaySkillEntry): boolean =>
  !entry.disabled && !entry.missing.config.includes(`skills.entries.${entry.skillKey}.enabled`);

export class SkillStateConfirmationError extends Error {
  readonly gatewayOffline: boolean;

  constructor(cause?: unknown) {
    super(t('skillSettingApplyUnconfirmed'), { cause });
    this.gatewayOffline = isTransportUnavailable(cause);
  }
}

export interface OpenClawSkillGateway {
  requestGateway<T>(method: string, params?: unknown): Promise<T>;
}

export type OpenClawSkillGatewayResolver = () => OpenClawSkillGateway | null;

export interface OpenClawConnectedSkillGateway {
  request<T>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
}

type SkillStatusReadOptions = {
  connectedOnly?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class OpenClawSkillService {
  constructor(
    private readonly resolveGateway: OpenClawSkillGatewayResolver,
    private readonly resolveConnectedGateway: () => OpenClawConnectedSkillGateway | null = () =>
      null,
  ) {}

  async getStatus(
    agentId: string = MAIN_USER_AGENT_ID,
    options: SkillStatusReadOptions = {},
  ): Promise<GatewaySkillStatus> {
    const params = { agentId };
    if (options.connectedOnly) {
      const gateway = this.resolveConnectedGateway();
      if (!gateway) throw new Error('Gateway not connected');
      return gateway.request<GatewaySkillStatus>('skills.status', params, {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
    }
    return this.requireGateway().requestGateway<GatewaySkillStatus>('skills.status', params);
  }

  updateConfig(params: SkillUpdateParams): Promise<SkillRpcResult> {
    return this.requireGateway().requestGateway('skills.update', params);
  }

  async waitForEnabledStatus(skillKey: string, enabled: boolean): Promise<GatewaySkillStatus> {
    // skills.update acknowledges the saved entry before the asynchronous native
    // config publication. Only a matching status proves the switch has applied.
    const deadline = Date.now() + SKILL_STATE_CONFIRM_TIMEOUT_MS;
    let interval = SKILL_STATE_CONFIRM_INTERVAL_MS;
    let lastError: unknown;
    while (true) {
      const remainingBeforeRead = deadline - Date.now();
      if (remainingBeforeRead <= 0) throw new SkillStateConfirmationError(lastError);
      const timeoutMs = Math.min(SKILL_STATE_READ_TIMEOUT_MS, remainingBeforeRead);
      const controller = new AbortController();
      let readTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const status = await Promise.race([
          this.getStatus(undefined, { connectedOnly: true, timeoutMs, signal: controller.signal }),
          new Promise<never>((_resolve, reject) => {
            readTimeout = setTimeout(() => reject(new SkillStatusReadTimeoutError()), timeoutMs);
          }),
        ]);
        lastError = undefined;
        const entry = status.skills.find(skill => skill.skillKey === skillKey);
        if (entry && isGatewaySkillEnabled(entry) === enabled) return status;
      } catch (error) {
        if (!isRetryableStatusError(error)) throw new SkillStateConfirmationError(error);
        lastError = error;
      } finally {
        clearTimeout(readTimeout);
        // Native cancellation retires any request that lost the local timeout
        // race, so late replies cannot survive into a subsequent confirmation.
        controller.abort();
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new SkillStateConfirmationError(lastError);
      await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)));
      interval = Math.min(interval * 2, SKILL_STATE_CONFIRM_MAX_INTERVAL_MS);
    }
  }

  private requireGateway(): OpenClawSkillGateway {
    const gateway = this.resolveGateway();
    if (!gateway) {
      throw new Error('Gateway not connected');
    }
    return gateway;
  }
}
