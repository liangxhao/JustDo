import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ExecutionAdmissionReceipt } from '../sdk/admission';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
export function parseExecutionAdmission(value: unknown): ExecutionAdmissionReceipt | undefined {
  if (!record(value) || value.version !== 2 || !id(value.id) || !id(value.sessionKey) || !id(value.sessionId) ||
      !id(value.runId) || !(value.lifecycleRevision === null || id(value.lifecycleRevision)) ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) < 1 ||
      !record(value.owner) || !id(value.owner.pluginId) || !id(value.owner.registrationId) || !id(value.owner.providerScope) ||
      !['held', 'revoked', 'released'].includes(String(value.state)) || typeof value.verified !== 'boolean' ||
      typeof value.effectIssued !== 'boolean' || (value.acceptedReceiptId !== undefined && !id(value.acceptedReceiptId))) return;
  const terminal = value.sourceTerminal;
  if (value.cleanupReceipt !== undefined && (!record(value.cleanupReceipt) || !id(value.cleanupReceipt.id) ||
      value.cleanupReceipt.registrationId !== value.owner.registrationId ||
      !['owner-attestation', 'backend-reconciliation'].includes(String(value.cleanupReceipt.source)))) return;
  if (terminal !== undefined && (!record(terminal) || terminal.executionSettled !== true || terminal.runId !== value.runId ||
      terminal.sessionId !== value.sessionId || !['end', 'error'].includes(String(terminal.phase)) ||
      !Number.isSafeInteger(terminal.seq) || Number(terminal.seq) < 0)) return;
  if ((value.effectIssued && !value.verified) || (value.acceptedReceiptId !== undefined && !value.effectIssued) ||
      (value.state === 'released' && ((value.effectIssued && terminal === undefined) ||
        (terminal !== undefined && value.cleanupReceipt === undefined)))) return;
  const cleanup = value.cleanupReceipt as Record<string, unknown> | undefined;
  const whole = terminal as Record<string, unknown> | undefined;
  return {
    version: 2, id: value.id, sessionKey: value.sessionKey, sessionId: value.sessionId,
    lifecycleRevision: value.lifecycleRevision, runId: value.runId, generation: Number(value.generation),
    owner: { pluginId: value.owner.pluginId, registrationId: value.owner.registrationId, providerScope: value.owner.providerScope },
    state: value.state as ExecutionAdmissionReceipt['state'], verified: value.verified, effectIssued: value.effectIssued,
    ...(value.acceptedReceiptId === undefined ? {} : { acceptedReceiptId: value.acceptedReceiptId }),
    ...(cleanup === undefined ? {} : { cleanupReceipt: { id: String(cleanup.id), registrationId: String(cleanup.registrationId),
      source: cleanup.source as 'owner-attestation' | 'backend-reconciliation' } }),
    ...(whole === undefined ? {} : { sourceTerminal: { runId: String(whole.runId), sessionId: String(whole.sessionId),
      phase: whole.phase as 'end' | 'error', seq: Number(whole.seq), executionSettled: true as const } }),
  };
}

/** Content-free receipts are authoritative; a missing native projection cannot release one. */
export class ExecutionAdmissionStore {
  private readonly directory: string;
  readonly uncertain = new Set<string>();
  constructor(stateDir: string) { this.directory = path.join(stateDir, 'runtime-services', 'execution-admissions'); }
  private file(sessionKey: string): string {
    return path.join(this.directory, createHash('sha256').update(sessionKey).digest('hex') + '.json');
  }
  read(sessionKey: string): { present: boolean; receipt?: ExecutionAdmissionReceipt } {
    if (this.uncertain.has(sessionKey)) return { present: true };
    try {
      const file = this.file(sessionKey);
      if (statSync(file).size > 32 * 1024) return { present: true };
      const receipt = parseExecutionAdmission(JSON.parse(readFileSync(file, 'utf8')));
      return { present: true, receipt: receipt?.sessionKey === sessionKey ? receipt : undefined };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { present: false } : { present: true };
    }
  }
  write(receipt: ExecutionAdmissionReceipt): void {
    this.uncertain.add(receipt.sessionKey);
    mkdirSync(this.directory, { recursive: true });
    const target = this.file(receipt.sessionKey);
    const temporary = target + '.' + randomUUID() + '.tmp';
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(receipt));
      fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(temporary, target);
      this.uncertain.delete(receipt.sessionKey);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
