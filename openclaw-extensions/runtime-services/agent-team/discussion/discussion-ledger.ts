import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isTeamDiscussionId, type TeamDiscussionExecution } from '../contracts/discussion';

export interface DiscussionReceipt {
  roomId: string;
  discussionId: string;
  fingerprint: string;
  owner: string;
  state: 'running' | 'unknown' | 'completed' | 'failed' | 'cancelled';
  executions: TeamDiscussionExecution[];
  settledRunIds?: string[];
  cleanupComplete?: boolean;
  publicReferences?: { agentId: string; sessionId: string; entryId: string }[];
  outputEntryIds?: string[];
  interrupted?: boolean;
}

/** Native extension admission receipts contain identities, never message bodies. */
export class DiscussionLedger {
  readonly owner = randomUUID();
  constructor(
    private readonly directory: string,
    private readonly preserveInterrupted = false,
  ) {
    mkdirSync(directory, { recursive: true });
  }
  private file(id: string): string {
    if (!isTeamDiscussionId(id)) throw new Error('teamDiscussionInvalidInput');
    return path.join(this.directory, `${id}.json`);
  }
  closeRoom(id: string): void {
    writeFileSync(`${this.file(id)}.closed`, '', { mode: 0o600 });
  }
  isRoomClosed(id: string): boolean {
    return existsSync(`${this.file(id)}.closed`);
  }
  read(id: string, recoverPreviousOwner = true): DiscussionReceipt | undefined {
    let text: string;
    try {
      text = readFileSync(this.file(id), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const receipt = JSON.parse(text) as DiscussionReceipt;
    if (
      receipt.discussionId !== id ||
      !isTeamDiscussionId(receipt.roomId) ||
      !Array.isArray(receipt.executions)
    )
      throw new Error('teamDiscussionExecutionConflict');
    // A previous service instance cannot resume execution. Its admission stays
    // consumed; reconnect never turns it into a second native model invocation.
    const unsupportedTerminal =
      ['completed', 'failed', 'cancelled'].includes(receipt.state) &&
      receipt.fingerprint !== 'cancelled-before-admission' &&
      (receipt.cleanupComplete !== true ||
        receipt.executions.some(
          execution =>
            !receipt.settledRunIds?.includes(execution.runId) ||
            !['completed', 'failed', 'cancelled'].includes(execution.outcome ?? ''),
        ));
    if (
      recoverPreviousOwner &&
      ((receipt.owner !== this.owner && receipt.state === 'running') || unsupportedTerminal)
    ) {
      if (this.preserveInterrupted) receipt.interrupted = true;
      // Losing the dispatcher owner proves neither native settlement nor tool
      // cleanup. Preserve the exact admission and every unresolved execution.
      receipt.state = 'unknown';
      this.write(receipt);
    }
    return receipt;
  }
  write(receipt: DiscussionReceipt): void {
    const target = this.file(receipt.discussionId);
    const temporary = `${target}.${this.owner}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(temporary, target);
  }
}
