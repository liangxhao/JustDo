import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { isTeamDiscussionId, type TeamDiscussionHoldingIdentity } from '../contracts/discussion';

export interface HoldingReceipt {
  roomId: string;
  generation: number;
  requestId: string;
  fingerprint: string;
  state: 'receiving' | 'saved' | 'unknown' | 'cancelled';
  owner: string;
  timestamp: number;
  entryId?: string;
}
export interface HoldingSlot {
  roomId: string;
  generation: number;
  agentId: string;
  sessionKey: string;
  cwd: string;
  identity?: TeamDiscussionHoldingIdentity;
  deleted?: boolean;
}
interface HoldingRoom {
  roomId: string;
  generation: number;
  closed: boolean;
}

/** Only identities, hashes and cancellation fences; native storage owns all input text. */
export class DiscussionHoldingLedger {
  readonly owner = randomUUID();
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private roomPath(roomId: string): string {
    if (!isTeamDiscussionId(roomId)) throw new Error('teamDiscussionInvalidInput');
    return path.join(this.directory, roomId);
  }
  private generationPath(roomId: string, generation: number): string {
    if (!Number.isSafeInteger(generation) || generation < 1)
      throw new Error('teamDiscussionInvalidInput');
    return path.join(this.roomPath(roomId), String(generation));
  }
  private requestPath(roomId: string, generation: number, requestId: string): string {
    if (!isTeamDiscussionId(requestId)) throw new Error('teamDiscussionInvalidInput');
    return path.join(this.generationPath(roomId, generation), `${requestId}.receipt.json`);
  }
  private read<T>(file: string): T | undefined {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  private write(file: string, value: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flush: true });
    renameSync(temporary, file);
  }
  room(roomId: string): HoldingRoom | undefined {
    return this.read<HoldingRoom>(path.join(this.roomPath(roomId), 'room.json'));
  }
  assertOpen(roomId: string, generation: number): void {
    const room = this.room(roomId);
    if (!room || room.closed || room.generation !== generation)
      throw new Error('teamDiscussionHoldingCancelled');
  }
  advance(roomId: string, generation: number): void {
    this.generationPath(roomId, generation);
    const existing = this.room(roomId);
    if (existing?.closed) throw new Error('teamDiscussionNotFound');
    if (existing && existing.generation > generation)
      throw new Error('teamDiscussionHoldingCancelled');
    if (!existing || existing.generation < generation)
      this.write(path.join(this.roomPath(roomId), 'room.json'), {
        roomId,
        generation,
        closed: false,
      });
  }
  close(roomId: string): void {
    const room = this.room(roomId);
    this.write(path.join(this.roomPath(roomId), 'room.json'), {
      roomId,
      generation: room?.generation ?? 1,
      closed: true,
    });
  }
  slot(roomId: string, generation: number): HoldingSlot | undefined {
    return this.read<HoldingSlot>(path.join(this.generationPath(roomId, generation), 'slot.json'));
  }
  saveSlot(slot: HoldingSlot): void {
    this.write(path.join(this.generationPath(slot.roomId, slot.generation), 'slot.json'), slot);
  }
  slots(roomId: string): HoldingSlot[] {
    const directory = this.roomPath(roomId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
      .flatMap(entry => {
        const slot = this.slot(roomId, Number(entry.name));
        return slot ? [slot] : [];
      });
  }
  receipt(roomId: string, generation: number, requestId: string): HoldingReceipt | undefined {
    const receipt = this.read<HoldingReceipt>(this.requestPath(roomId, generation, requestId));
    if (!receipt) return;
    const room = this.room(roomId);
    if (room?.closed || room?.generation !== generation) return { ...receipt, state: 'cancelled' };
    if (receipt.state === 'receiving' && receipt.owner !== this.owner)
      return { ...receipt, state: 'unknown' };
    return receipt;
  }
  saveReceipt(receipt: HoldingReceipt): void {
    this.write(this.requestPath(receipt.roomId, receipt.generation, receipt.requestId), receipt);
  }
  cancel(roomId: string, generation: number, requestIds?: string[]): void {
    // An all-cancel carries the NEW Main epoch. Replays must not cancel new work in that epoch.
    this.advance(roomId, generation);
    if (!requestIds) return;
    for (const requestId of requestIds) {
      const existing = this.receipt(roomId, generation, requestId);
      this.saveReceipt({
        roomId,
        generation,
        requestId,
        fingerprint: existing?.fingerprint ?? '',
        state: 'cancelled',
        owner: this.owner,
        timestamp: existing?.timestamp ?? Date.now(),
        ...(existing?.entryId ? { entryId: existing.entryId } : {}),
      });
    }
  }
  cancelAllReceipts(): void {
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isTeamDiscussionId(entry.name)) continue;
      for (const slot of this.slots(entry.name)) {
        const directory = this.generationPath(slot.roomId, slot.generation);
        for (const file of readdirSync(directory)) {
          if (!file.endsWith('.receipt.json')) continue;
          const requestId = file.slice(0, -'.receipt.json'.length);
          const receipt = this.receipt(slot.roomId, slot.generation, requestId);
          if (receipt && receipt.state !== 'cancelled')
            this.saveReceipt({ ...receipt, state: 'cancelled' });
        }
      }
    }
  }
}
