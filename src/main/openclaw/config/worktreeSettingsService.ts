import path from 'path';

import type {
  WorktreeSettings,
  WorktreeSettingsErrorCode,
  WorktreeSettingsResult,
} from '../../../shared/openclaw/worktrees';

type Request = <T>(method: string, params?: unknown) => Promise<T>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const resolveRoot = (value: string): string | null => {
  if (value.length > 4096 || /[\0\r\n]/.test(value)) return null;
  // config.get already normalizes native home-relative paths. Accept absolute
  // edits only, avoiding a second home resolver that can differ from Gateway.
  if (!path.isAbsolute(value) || (process.platform === 'win32' &&
    /^[\\/]$/.test(path.parse(value).root))) return null;
  return path.normalize(value);
};

const errorCode = (error: unknown): WorktreeSettingsErrorCode => {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid worktree configuration/i.test(message)) return 'configuration';
  if (/baseHash|config.*changed|revision.*(?:mismatch|conflict)|conflict/i.test(message)) return 'conflict';
  if (/forbidden|unauthorized|permission|scope|not authorized/i.test(message)) return 'forbidden';
  if (/disconnect|not connected|not running|unavailable|timeout|timed out|ENGINE_NOT_READY/i.test(message)) return 'unavailable';
  return 'unknown';
};

/** Gateway owns global policy. Only worktree settings cross the bridge. */
export class WorktreeSettingsService {
  private writing = false;

  constructor(private readonly request: Request, private readonly getStateDir: () => string) {}

  private async result(operation: () => Promise<WorktreeSettings>): Promise<WorktreeSettingsResult> {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      return { success: false, code: errorCode(error) };
    }
  }

  private async read(): Promise<WorktreeSettings> {
    const snapshot = await this.request<{
      config?: unknown; valid?: unknown; hash?: unknown;
      configRevisionHash?: unknown; appliedConfigHash?: unknown;
    }>('config.get', {});
    if (snapshot.valid !== true || !isRecord(snapshot.config) ||
      typeof snapshot.hash !== 'string' || !snapshot.hash.trim()) {
      throw new Error('Invalid worktree configuration');
    }
    const { worktreeRoot, worktreeAcceleration } = snapshot.config;
    if ((worktreeRoot !== undefined && (typeof worktreeRoot !== 'string' || !resolveRoot(worktreeRoot))) ||
      (worktreeAcceleration !== undefined && typeof worktreeAcceleration !== 'boolean')) {
      throw new Error('Invalid worktree configuration');
    }
    const root = typeof worktreeRoot === 'string' ? worktreeRoot : null;
    return {
      root,
      effectiveRoot: root ? resolveRoot(root)! : path.join(this.getStateDir(), 'worktrees'),
      acceleration: worktreeAcceleration !== false,
      revision: snapshot.hash,
      applied: typeof snapshot.configRevisionHash === 'string' && !!snapshot.configRevisionHash &&
        snapshot.configRevisionHash === snapshot.appliedConfigHash,
    };
  }

  getSettings = (): Promise<WorktreeSettingsResult> => this.result(() => this.read());

  saveSettings = async (input: unknown): Promise<WorktreeSettingsResult> => {
    if (!isRecord(input) || (input.root !== null && typeof input.root !== 'string') ||
      typeof input.acceleration !== 'boolean' || typeof input.revision !== 'string' ||
      !input.revision.trim() || Object.keys(input).some(key => !['root', 'acceleration', 'revision'].includes(key))) {
      return { success: false, code: 'invalid' };
    }
    const root = typeof input.root === 'string' ? input.root.trim() : '';
    if (root && !resolveRoot(root)) return { success: false, code: 'invalid' };
    if (this.writing) return { success: false, code: 'busy' };
    this.writing = true;
    try {
      return await this.result(async () => {
        await this.request('config.patch', {
          baseHash: input.revision,
          raw: JSON.stringify({ worktreeRoot: root || null, worktreeAcceleration: input.acceleration }),
        });
        // Do not retry an uncertain write. Reading again exposes native apply status.
        const confirmed = await this.read();
        const expectedRoot = root ? resolveRoot(root) : path.join(this.getStateDir(), 'worktrees');
        if (confirmed.effectiveRoot !== expectedRoot || confirmed.acceleration !== input.acceleration ||
          (!root && confirmed.root !== null)) {
          throw new Error('Worktree config changed after saving');
        }
        return confirmed;
      });
    } finally {
      this.writing = false;
    }
  };
}
