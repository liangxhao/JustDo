import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** App code trust is deliberately separate from native capability review tokens. */
export class AppApprovalStore {
  private lane: Promise<void> = Promise.resolve();
  constructor(private readonly filename: string) {}
  async read(): Promise<Record<string, string>> {
    return (await this.readRecord()).current;
  }
  async history(): Promise<Record<string, string[]>> {
    return (await this.readRecord()).history;
  }
  private async readRecord(): Promise<{
    current: Record<string, string>;
    history: Record<string, string[]>;
  }> {
    try {
      const input: unknown = JSON.parse(await readFile(this.filename, 'utf8'));
      const record = input as { version?: unknown; current?: unknown; history?: unknown } | null;
      if (
        !record ||
        record.version !== 1 ||
        !record.current ||
        !record.history ||
        typeof record.current !== 'object' ||
        typeof record.history !== 'object'
      )
        throw new Error('Invalid trust receipts');
      const validId = (id: string) => /^[a-z][a-z0-9-]{0,95}$/u.test(id);
      const validHash = (hash: unknown): hash is string =>
        typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash);
      const current = Object.fromEntries(
        Object.entries(record.current).filter(([id, hash]) => validId(id) && validHash(hash)),
      ) as Record<string, string>;
      const history = Object.fromEntries(
        Object.entries(record.history).filter(
          ([id, hashes]) =>
            validId(id) && Array.isArray(hashes) && hashes.length <= 128 && hashes.every(validHash),
        ),
      ) as Record<string, string[]>;
      if (
        Object.keys(history).length > 128 ||
        Object.entries(current).some(([id, hash]) => !history[id]?.includes(hash))
      )
        throw new Error('Invalid trust receipts');
      return { current, history };
    } catch {
      return { current: {}, history: {} };
    }
  }
  async approve(id: string, hash: string): Promise<void> {
    if (!/^[a-z][a-z0-9-]{0,95}$/u.test(id) || !/^[a-f0-9]{64}$/u.test(hash))
      throw new Error('appPluginInvalidRequest');
    const next = this.lane
      .catch((): void => undefined)
      .then(async () => {
        const record = await this.readRecord();
        record.current[id] = hash;
        record.history[id] = [...new Set([...(record.history[id] ?? []), hash])];
        if (record.history[id].length > 128 || Object.keys(record.history).length > 128)
          throw new Error('App trust receipt limit reached');
        await mkdir(path.dirname(this.filename), { recursive: true });
        const staged = `${this.filename}.pending`;
        await writeFile(staged, JSON.stringify({ version: 1, ...record }), { mode: 0o600 });
        await rename(staged, this.filename);
      });
    this.lane = next;
    return next;
  }
}
