import type {
  SessionStorageErrorCode,
  SessionStoragePolicy,
  SessionStorageResult,
  SessionStorageStatus,
} from '../../../shared/openclaw/sessionStorage';

type Request = <T>(method: string, params?: unknown) => Promise<T>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

export function storageErrorCode(error: unknown): SessionStorageErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/configuration application pending/i.test(message)) return 'pending';
  if (/unknown method|method not found|unsupported/i.test(message)) return 'unsupported';
  if (/forbidden|unauthorized|permission|scope|not authorized|no longer authorized/i.test(message))
    return 'forbidden';
  if (/baseHash|config.*changed|revision.*(?:mismatch|conflict)|conflict/i.test(message))
    return 'conflict';
  if (
    /disconnect|not connected|not running|unavailable|timeout|timed out|ENGINE_NOT_READY/i.test(
      message,
    )
  )
    return 'unavailable';
  if (/invalid archive policy/i.test(message)) return 'configuration';
  if (/cold storage is disabled/i.test(message)) return 'disabled';
  return 'unknown';
}

export class SessionStorageService {
  private writing = false;
  constructor(private readonly request: Request) {}

  private async result<T>(operation: () => Promise<T>): Promise<SessionStorageResult<T>> {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      return { success: false, code: storageErrorCode(error) };
    }
  }

  private async write<T>(operation: () => Promise<T>): Promise<SessionStorageResult<T>> {
    if (this.writing) return { success: false, code: 'busy' };
    this.writing = true;
    try {
      return await this.result(operation);
    } finally {
      this.writing = false;
    }
  }

  private async readPolicy(): Promise<SessionStoragePolicy> {
    const snapshot = await this.request<{
      config: unknown;
      valid: boolean;
      hash: string;
      configRevisionHash: string | null;
      appliedConfigHash: string | null;
    }>('config.get', {});
    // config.get also succeeds for invalid diagnostic snapshots; their empty config
    // must not be mistaken for an unset (disabled) policy.
    if (snapshot.valid !== true || !isRecord(snapshot.config))
      throw new Error('Invalid archive policy');
    if (typeof snapshot.hash !== 'string' || !snapshot.hash.trim())
      throw new Error('Configuration revision unavailable');
    let policy: Record<string, unknown> = snapshot.config;
    for (const key of ['session', 'maintenance', 'coldStorage']) {
      const value = policy[key];
      if (value !== undefined && !isRecord(value)) throw new Error('Invalid archive policy');
      policy = record(value);
    }
    const afterDays = policy.afterDays === undefined ? 30 : policy.afterDays;
    if (
      (policy.enabled !== undefined && typeof policy.enabled !== 'boolean') ||
      !Number.isSafeInteger(afterDays) ||
      Number(afterDays) <= 0
    )
      throw new Error('Invalid archive policy');
    return {
      enabled: policy.enabled === true,
      afterDays: Number(afterDays),
      revision: snapshot.hash,
      applied:
        !!snapshot.configRevisionHash && snapshot.configRevisionHash === snapshot.appliedConfigHash,
    };
  }

  private async readStatus(method = 'sessions.storage.status'): Promise<SessionStorageStatus> {
    const status = await this.request<SessionStorageStatus>(method, {});
    // Project only the public fields; native database paths stay in Main.
    return {
      agents: status.agents.map(agent => ({
        agentId: agent.agentId,
        hotTranscripts: agent.hotTranscripts,
        coldTranscripts: agent.coldTranscripts,
        databaseBytes: agent.databaseBytes,
        walBytes: agent.walBytes,
        archiveBytes: agent.archiveBytes,
        embeddedArchiveBytes: agent.embeddedArchiveBytes,
      })),
      maintenance: {
        running: status.maintenance.running,
        lastStartedAt: status.maintenance.lastStartedAt,
        lastCompletedAt: status.maintenance.lastCompletedAt,
        // Native errors may include database/archive paths or arbitrary worker diagnostics.
        // Renderer receives only a classified error and supplies localized wording.
        lastError: status.maintenance.lastError
          ? storageErrorCode(status.maintenance.lastError)
          : null,
        archivedTranscripts: status.maintenance.archivedTranscripts,
        externalizedTranscripts: status.maintenance.externalizedTranscripts,
      },
    };
  }

  getStatus = () => this.result(() => this.readStatus());
  getPolicy = () => this.result(() => this.readPolicy());

  savePolicy = (input: unknown): Promise<SessionStorageResult<SessionStoragePolicy>> => {
    const policy = record(input);
    if (
      typeof policy.enabled !== 'boolean' ||
      !Number.isSafeInteger(policy.afterDays) ||
      Number(policy.afterDays) <= 0 ||
      typeof policy.revision !== 'string' ||
      !policy.revision.trim()
    ) {
      return Promise.resolve({ success: false, code: 'invalid' });
    }
    return this.write(async () => {
      // A successful native status read verifies this runtime's capability before writing config.
      await this.readStatus();
      await this.request('config.patch', {
        baseHash: policy.revision,
        raw: JSON.stringify({
          session: {
            maintenance: {
              coldStorage: {
                enabled: policy.enabled,
                afterDays: policy.afterDays,
              },
            },
          },
        }),
      });
      return this.readPolicy();
    });
  };

  run = () =>
    this.write(async () => {
      const policy = await this.readPolicy();
      if (!policy.applied) throw new Error('Configuration application pending');
      if (!policy.enabled) throw new Error('Transcript cold storage is disabled');
      return this.readStatus('sessions.storage.run');
    });
}
