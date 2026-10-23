import path from 'path';

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
const SKILL_DISCOVERY_CONFIRM_TIMEOUT_MS = 45_000;
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

const matchesSkillDirectory = (entry: GatewaySkillEntry, directory: string): boolean =>
  path.resolve(entry.baseDir) === path.resolve(directory);

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

  waitForEnabledStatus(
    skillKey: string,
    enabled: boolean,
    identity?: Pick<GatewaySkillEntry, 'source' | 'baseDir'>,
  ): Promise<GatewaySkillStatus> {
    // skills.update acknowledges the saved entry before the asynchronous native
    // config publication. Only a matching status proves the switch has applied.
    return OpenClawSkillService.waitForStatus(
      this,
      status => {
        const entry = status.skills.find(
          skill =>
            skill.skillKey === skillKey &&
            (!identity ||
              (skill.source === identity.source && matchesSkillDirectory(skill, identity.baseDir))),
        );
        return Boolean(entry && isGatewaySkillEnabled(entry) === enabled);
      },
      SKILL_STATE_CONFIRM_TIMEOUT_MS,
    );
  }

  async waitForInstalledStatus(installPath: string): Promise<GatewaySkillStatus> {
    try {
      // Windows directory polling can take 30 seconds. Read native discovery
      // without restarting it or guessing a key from a local manifest.
      return await OpenClawSkillService.waitForStatus(
        this,
        status =>
          status.skills.some(
            entry =>
              entry.source === 'openclaw-managed' && matchesSkillDirectory(entry, installPath),
          ),
        SKILL_DISCOVERY_CONFIRM_TIMEOUT_MS,
      );
    } catch (cause) {
      throw new Error('Skill installed, but its native identity could not be confirmed.', {
        cause,
      });
    }
  }

  private static async waitForStatus(
    service: Pick<OpenClawSkillService, 'getStatus'>,
    matches: (status: GatewaySkillStatus) => boolean,
    timeoutMs: number,
  ): Promise<GatewaySkillStatus> {
    const deadline = Date.now() + timeoutMs;
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
          service.getStatus(undefined, {
            connectedOnly: true,
            timeoutMs,
            signal: controller.signal,
          }),
          new Promise<never>((_resolve, reject) => {
            readTimeout = setTimeout(() => reject(new SkillStatusReadTimeoutError()), timeoutMs);
          }),
        ]);
        lastError = undefined;
        if (matches(status)) return status;
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
