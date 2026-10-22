import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Persistent product metadata; native session extension state is only a projection. */
export class AgentTeamLaunchLedger {
  readonly directory: string;

  constructor(stateDir: string) {
    this.directory = path.resolve(stateDir, 'runtime-services', 'agent-team-launch');
  }

  private file(sessionKey: string): string {
    return path.join(
      this.directory,
      `${createHash('sha256').update(sessionKey).digest('hex')}.json`,
    );
  }

  read(sessionKey: string): unknown {
    const file = this.file(sessionKey);
    try {
      if (statSync(file).size > 32 * 1024) return { unreadable: true };
      return JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch (error) {
      // Only proven absence means no intent. A malformed or unreadable ledger
      // must not revert to an empty native namespace and lift the guard.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return { unreadable: true };
    }
  }

  write(sessionKey: string, metadata: object): void {
    mkdirSync(this.directory, { recursive: true });
    const file = this.file(sessionKey);
    const temporary = `${file}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(metadata));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
