import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { type CustodyIdentity, type CustodyReceipt, type ExecutionReceipt,INERT_CUSTODY_HARNESS } from '../sdk/custody';

export interface CustodyScope {
  resourceId: string;
  ownerId: string;
  epoch: number;
  closed: boolean;
}
export interface CustodySlot {
  resourceId: string;
  epoch: number;
  ownerId: string;
  agentId: string;
  sessionKey: string;
  cwd: string;
  identity?: CustodyIdentity;
  deleted?: boolean;
}
export interface StoredCustodyReceipt extends CustodyReceipt {
  writerRegistrationId: string;
  timestamp: number;
}
const id = (value: string) => {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('Invalid custody resource identity.');
  return value;
};
const epoch = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid custody epoch.');
  return String(value);
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const bounded = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
function validateExecution(value: unknown, ownerId?: string, operationId?: string): ExecutionReceipt {
  if (!record(value) || !bounded(value.ownerId, 256) || !bounded(value.writerRegistrationId, 256) ||
      (ownerId !== undefined && value.ownerId !== ownerId) || (operationId !== undefined && value.operationId !== operationId) ||
      typeof value.operationId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.operationId) ||
      typeof value.inputSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.inputSha256) ||
      !['open', 'unknown', 'settled'].includes(String(value.state)) || typeof value.cleanupComplete !== 'boolean' ||
      typeof value.cancelRequested !== 'boolean' || !Array.isArray(value.subjects) || value.subjects.length > 256 ||
      !Array.isArray(value.settledRunIds) || value.settledRunIds.length > 256) throw new Error('Invalid execution receipt metadata.');
  const subjects = value.subjects;
  const settledRunIds = value.settledRunIds;
  for (const subject of subjects) if (!record(subject) || !bounded(subject.agentId, 64) || !bounded(subject.sessionKey) ||
      !bounded(subject.sessionId, 256) || !bounded(subject.lifecycleRevision, 256) || !bounded(subject.runId, 256) ||
      (subject.outcome !== undefined && !['completed', 'failed', 'cancelled'].includes(String(subject.outcome)))) throw new Error('Invalid enrolled execution identity.');
  if (new Set(subjects.map(subject => subject.runId)).size !== subjects.length ||
      new Set(settledRunIds).size !== settledRunIds.length ||
      settledRunIds.some(runId => !bounded(runId, 256) || !subjects.some(subject => subject.runId === runId && subject.outcome)) ||
      (value.state === 'settled' && (!value.cleanupComplete || subjects.length === 0 || subjects.some(subject => !settledRunIds.includes(subject.runId) || !subject.outcome))))
    throw new Error('Execution receipt lacks exact settlement evidence.');
  return value as unknown as ExecutionReceipt;
}
/** Identities, digests and fences only. Opaque bodies remain exclusively in native storage. */
export class CustodyLedger {
  readonly instanceId = randomUUID();
  constructor(private readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  private read<T>(file: string): T | undefined {
    try {
      if (statSync(file).size > 1024 * 1024) throw new Error('Custody metadata exceeds its limit.');
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private write(file: string, value: unknown) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flush: true });
    renameSync(temporary, file);
  }
  private resource(resourceId: string) { return path.join(this.directory, 'resources', id(resourceId)); }
  private generation(resourceId: string, value: number) { return path.join(this.resource(resourceId), epoch(value)); }
  private receiptDirectory(resourceId: string, value: number) { return path.join(this.resource(resourceId), 'receipts', epoch(value)); }
  scope(resourceId: string): CustodyScope | undefined {
    const value = this.read<unknown>(path.join(this.resource(resourceId), 'scope.json'));
    if (value === undefined) return;
    if (!record(value) || value.resourceId !== resourceId || !Number.isSafeInteger(value.epoch) || Number(value.epoch) < 1 ||
        typeof value.closed !== 'boolean' || !bounded(value.ownerId, 256)) throw new Error('Invalid custody scope metadata.');
    return value as unknown as CustodyScope;
  }
  advance(resourceId: string, value: number, ownerId?: string): CustodyScope {
    epoch(value);
    const previous = this.scope(resourceId);
    if (!previous && !bounded(ownerId, 256)) throw new Error('A new custody scope requires its proven owner.');
    if (previous?.closed || (previous?.ownerId && ownerId && previous.ownerId !== ownerId))
      throw new Error('Custody scope is closed or belongs to another owner.');
    if (previous && previous.epoch > value) throw new Error('Custody epoch is retired.');
    const next = { resourceId, ownerId: previous?.ownerId ?? ownerId!, epoch: value, closed: false };
    if (!previous || previous.epoch < value || (!previous.ownerId && ownerId))
      this.write(path.join(this.resource(resourceId), 'scope.json'), next);
    return previous && previous.epoch === value && previous.ownerId ? previous : next;
  }
  assertOpen(resourceId: string, value: number) {
    const current = this.scope(resourceId);
    if (!current || current.closed || current.epoch !== value) throw new Error('Custody scope is retired.');
  }
  close(resourceId: string) {
    const previous = this.scope(resourceId);
    if (!previous) throw new Error('Custody scope is unknown.');
    this.write(path.join(this.resource(resourceId), 'scope.json'), { ...previous, closed: true });
  }
  slot(resourceId: string, value: number): CustodySlot | undefined {
    const slot = this.read<unknown>(path.join(this.generation(resourceId, value), 'slot.json'));
    if (slot === undefined) return;
    if (!record(slot) || slot.resourceId !== resourceId || slot.epoch !== value || !bounded(slot.ownerId, 256) ||
        !bounded(slot.agentId, 64) || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(slot.agentId) || !bounded(slot.cwd, 4096) || !path.isAbsolute(slot.cwd) ||
        slot.sessionKey !== `agent:${slot.agentId}:harness:${INERT_CUSTODY_HARNESS}:${resourceId}:${value}` ||
        (slot.deleted !== undefined && typeof slot.deleted !== 'boolean')) throw new Error('Invalid custody slot metadata.');
    if (slot.identity !== undefined) {
      const identity = slot.identity;
      if (!record(identity) || identity.resourceId !== resourceId || identity.epoch !== value || identity.agentId !== slot.agentId ||
          identity.sessionKey !== slot.sessionKey || !bounded(identity.sessionId, 256) || !bounded(identity.lifecycleRevision, 256)) throw new Error('Invalid custody incarnation metadata.');
    }
    return slot as unknown as CustodySlot;
  }
  saveSlot(value: CustodySlot) { this.write(path.join(this.generation(value.resourceId, value.epoch), 'slot.json'), value); }
  slots(resourceId: string): CustodySlot[] {
    const directory = this.resource(resourceId);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return entries.filter(value => value.isDirectory() && /^[1-9]\d*$/u.test(value.name)).flatMap(value => {
      const slot = this.slot(resourceId, Number(value.name));
      if (!slot) throw new Error('An existing custody epoch has no slot metadata.');
      return [slot];
    });
  }
  private operation(value: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value)) throw new Error('Invalid custody operation identity.');
    return value;
  }
  receipt(resourceId: string, value: number, operationId: string): StoredCustodyReceipt | undefined {
    const receipt = this.read<StoredCustodyReceipt>(path.join(this.receiptDirectory(resourceId, value), this.operation(operationId) + '.json'));
    if (!receipt) return;
    if (!record(receipt) || receipt.resourceId !== resourceId || receipt.epoch !== value || receipt.operationId !== operationId ||
        !['receiving', 'saved', 'unknown', 'cancelled'].includes(String(receipt.state)) ||
        typeof receipt.sha256 !== 'string' || !(receipt.state === 'cancelled' && receipt.sha256 === '') && !/^[a-f0-9]{64}$/u.test(receipt.sha256) ||
        typeof receipt.writerRegistrationId !== 'string' || (receipt.state !== 'cancelled' && !bounded(receipt.writerRegistrationId, 256)) ||
        !Number.isSafeInteger(receipt.timestamp) || receipt.timestamp < 0 ||
        (receipt.entryId !== undefined && !bounded(receipt.entryId, 256)) || (receipt.state === 'saved' && !receipt.entryId))
      throw new Error('Custody receipt identity mismatch.');
    const current = this.scope(resourceId);
    return current?.closed || current?.epoch !== value ? { ...receipt, state: 'cancelled' } : receipt;
  }
  saveReceipt(value: StoredCustodyReceipt) { this.write(path.join(this.receiptDirectory(value.resourceId, value.epoch), this.operation(value.operationId) + '.json'), value); }
  cancel(resourceId: string, value: number, operationIds?: string[]) {
    const current = this.scope(resourceId);
    if (current?.closed || (current && current.epoch > value)) return;
    this.advance(resourceId, value);
    for (const operationId of operationIds ?? []) {
      // An explicit cancellation may precede this inert append. This negative
      // fence consumes only the operation inside an existing resource/epoch;
      // it is never execution settlement or permission to recreate a scope.
      const previous = this.receipt(resourceId, value, operationId);
      this.saveReceipt({ ...previous, resourceId, epoch: value, operationId, state: 'cancelled', sha256: previous?.sha256 ?? '', writerRegistrationId: previous?.writerRegistrationId ?? '', timestamp: previous?.timestamp ?? Date.now() });
    }
  }
  private executionFile(ownerId: string, operationId: string) {
    id(operationId);
    if (!ownerId || ownerId.length > 256) throw new Error('Invalid receipt owner.');
    const key = createHash('sha256').update(JSON.stringify([ownerId, operationId])).digest('hex');
    return path.join(this.directory, 'executions', key + '.json');
  }
  execution(ownerId: string, operationId: string): ExecutionReceipt | undefined {
    const value = this.read<unknown>(this.executionFile(ownerId, operationId));
    return value === undefined ? undefined : validateExecution(value, ownerId, operationId);
  }
  saveExecution(value: ExecutionReceipt) { validateExecution(value); this.write(this.executionFile(value.ownerId, value.operationId), value); }
  executions(onInvalid?: () => void): ExecutionReceipt[] {
    let files: string[];
    try { files = readdirSync(path.join(this.directory, 'executions')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    if (files.length > 10000) throw new Error('Custody execution inventory exceeds its limit.');
    return files.filter(file => /^[a-f0-9]{64}\.json$/u.test(file)).flatMap(file => {
      try {
        const value = this.read<unknown>(path.join(this.directory, 'executions', file));
        if (value === undefined) throw new Error('Execution receipt disappeared during discovery.');
        const receipt = validateExecution(value);
        if (path.basename(this.executionFile(receipt.ownerId, receipt.operationId)) !== file) throw new Error('Execution receipt file identity mismatch.');
        return [receipt];
      } catch (error) { if (!onInvalid) throw error; onInvalid(); return []; }
    });
  }
}
