import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  type WebLaunchActualInput,
  WebLaunchLimits,
  WebLaunchMethod,
  type WebLaunchPermissionMode,
  type WebLaunchReceipt,
  type WebLaunchResponse,
  WebLaunchSendMode,
  type WebLaunchSitePolicy,
  type WebLaunchSource,
} from '../../../plugins/chrome-extensions/chrome-assistant/contracts/webLaunch';
import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import { normalizeAgentEvent } from '../../shared/openclaw/agentEvent';
import { PermissionMode } from '../../shared/security/approvals';
import type { AppServerOperation, AppServerResult } from '../clients/appServer/protocol/appServerProtocol';
import { resolveTaskWorkingDirectory } from '../core/filesystem/taskWorkspace';
import type { CoworkStore } from '../data/coworkStore';
import type { GatewayClientLike } from '../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../engine/openclaw/openclawRuntimeAdapter';
import type { CoworkNativeSendBinding } from '../engine/types';
import type { ChromeExtensionChatController } from './chromeExtensionChatController';
import { readWebLaunchFinal, type WebLaunchFinalOutput, type WebLaunchResultCandidate } from './chromeWebLaunchResult';
import {
  type ChromeWebLaunchState,
  ChromeWebLaunchStore,
  type WebLaunchDocumentLease,
  type WebLaunchNativeBinding,
  type WebLaunchStoredReceipt,
} from './chromeWebLaunchStore';
import {
  assertWebLaunchKeys, buildStrictWebLaunchContext, ChromeWebLaunchError, failWebLaunch,
  parseWebLaunchActualInput, parseWebLaunchPrepare, parseWebLaunchSource, parseWebLaunchSubmit,
  webLaunchActualDigest, webLaunchBoolean, webLaunchDigest, webLaunchInteger, webLaunchOrigin,
  webLaunchRecord, webLaunchSourceKey, webLaunchString, webLaunchWindowKey,
} from './chromeWebLaunchValidation';

interface Dependencies {
  getDatabase: () => Database.Database;
  getStore: () => CoworkStore;
  chat: ChromeExtensionChatController;
  getRuntime: () => OpenClawRuntimeAdapter | null;
  getDefaultModelRef?: () => string | undefined;
  onChanged?: () => void;
  onSessionsChanged?: () => void;
  now?: () => number;
  uuid?: () => string;
}
interface Owner {
  id: string;
  composeRevision: number;
  active: boolean;
  dispatched: boolean;
  stopIntent: boolean;
  delegated: boolean;
  closedReason?: string;
  prepared?: CoworkNativeSendBinding;
  binding?: WebLaunchNativeBinding;
  runtime?: OpenClawRuntimeAdapter;
  client?: GatewayClientLike;
  candidates: Map<string, WebLaunchResultCandidate>;
  dispose?: () => void;
  candidateExpiry?: ReturnType<typeof setTimeout>;
}
const settled = (receipt: WebLaunchStoredReceipt) => receipt.executionSettled;
const closedRequestStatuses = new Set<WebLaunchStoredReceipt['requestStatus']>([
  'cancelled', 'expired', 'rejected',
]);
const strippedSource = (source: WebLaunchSource): WebLaunchSource => {
  const { url: _url, title: _title, ...identity } = source;
  return identity;
};

/** Owns webpage admission and metadata. OpenClaw continues to own execution/history. */
export class ChromeWebLaunchService {
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly epoch: string;
  private readonly store: ChromeWebLaunchStore;
  private readonly owners = new Map<string, Owner>();
  private readonly refreshing = new Map<string, Promise<void>>();
  private readonly resultReads = new Map<string, Promise<WebLaunchFinalOutput | undefined>>();
  private readonly resultAttempts = new Map<string, number>();
  private closed = false;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? randomUUID;
    this.epoch = this.uuid();
    this.store = new ChromeWebLaunchStore(deps.getDatabase, this.now);
    let draftVisibilityChanged = false;
    this.store.mutate(state => {
      for (const receipt of Object.values(state.receipts)) {
        // Old prepares left the shell in the desktop list. A detached draft may
        // already have been sent as ordinary Chrome chat; preserve that history.
        if (receipt.executionStatus === 'not-started' && !receipt.executionSettled &&
            !receipt.dispatchAttempted && !receipt.nativeBinding) {
          const store = deps.getStore();
          const thread = store.getSession(receipt.threadId);
          if (thread && !thread.historyBinding && store.markSessionPendingFirstSend(thread.id))
            draftVisibilityChanged = true;
        }
        if (receipt.processEpoch === this.epoch || settled(receipt) || closedRequestStatuses.has(receipt.requestStatus)) continue;
        receipt.autoAllowed = false;
        receipt.composeRevision += 1;
        if (receipt.clientTurnId && !receipt.notSent) {
          receipt.executionStatus = 'unknown';
          receipt.errorCode = 'UNKNOWN_EXECUTION';
          if (!state.unknownOrigins.includes(receipt.source.origin)) state.unknownOrigins.push(receipt.source.origin);
        } else receipt.requestStatus = 'awaiting-confirmation';
        receipt.receiptRevision += 1;
      }
    });
    if (draftVisibilityChanged) {
      try { deps.onSessionsChanged?.(); } catch { /* The markers are already committed. */ }
    }
  }

  getOperations(): Partial<Record<WebLaunchMethod, AppServerOperation>> {
    const safe = (
      operation: (params: unknown) => unknown | Promise<unknown>,
      rejectBeforeSubmission = false,
    ): AppServerOperation => async params => {
      try {
        if (this.closed) return failWebLaunch('NATIVE_UNAVAILABLE');
        if (Buffer.byteLength(JSON.stringify(params)) > WebLaunchLimits.requestBytes) return failWebLaunch('REQUEST_TOO_LARGE');
        return await operation(params) as AppServerResult;
      } catch (error) {
        if (error instanceof ChromeWebLaunchError) {
          // Synchronous submit validation can fail before this call claims a send.
          if (rejectBeforeSubmission) Object.assign(error, { requestSent: false });
          throw error;
        }
        throw new ChromeWebLaunchError('INTERNAL_ERROR');
      }
    };
    return {
      [WebLaunchMethod.SitesRead]: safe(() => this.sites()),
      [WebLaunchMethod.SitesWrite]: safe(params => this.writeSite(params)),
      [WebLaunchMethod.SendModeSet]: safe(params => this.setSendMode(params)),
      [WebLaunchMethod.Prepare]: safe(params => this.prepare(params)),
      [WebLaunchMethod.Revise]: safe(params => this.revise(params)),
      [WebLaunchMethod.Submit]: safe(params => this.submit(params), true),
      [WebLaunchMethod.Read]: safe(params => this.read(params)),
      [WebLaunchMethod.Cancel]: safe(params => this.cancel(params)),
      [WebLaunchMethod.Stop]: safe(params => this.stop(params)),
      [WebLaunchMethod.Abandon]: safe(params => this.abandon(params)),
      [WebLaunchMethod.Observations]: safe(() => this.observations()),
      [WebLaunchMethod.RevokeDocument]: safe(params => this.revokeDocument(params)),
    };
  }

  sites() {
    const state = this.store.read();
    return { revision: state.policyRevision, sites: state.sites, sendMode: state.sendMode ?? WebLaunchSendMode.Website };
  }

  setSendMode(raw: unknown) {
    const value = webLaunchRecord(raw);
    assertWebLaunchKeys(value, ['expectedRevision', 'sendMode']);
    const expectedRevision = webLaunchInteger(value.expectedRevision, 0);
    const sendMode = value.sendMode;
    if (sendMode !== WebLaunchSendMode.Website && sendMode !== WebLaunchSendMode.Draft && sendMode !== WebLaunchSendMode.Direct)
      return failWebLaunch('INVALID_REQUEST');
    const changed = this.store.mutate(state => {
      if (expectedRevision !== state.policyRevision) return failWebLaunch('POLICY_CONFLICT');
      if (sendMode === (state.sendMode ?? WebLaunchSendMode.Website)) return false;
      state.sendMode = sendMode;
      state.policyRevision += 1;
      // Changing how future clicks send leaves existing site grants and receipts intact.
      return true;
    });
    if (changed) this.changed();
    return this.sites();
  }

  private changed(): void { try { this.deps.onChanged?.(); } catch { /* Observer retirement cannot alter admission. */ } }
  private policy(state: ChromeWebLaunchState, origin: string): WebLaunchSitePolicy {
    const policy = state.sites.find(site => site.origin === origin);
    if (!policy?.enabled) return failWebLaunch('SITE_NOT_ALLOWED');
    return policy;
  }
  private get(state: ChromeWebLaunchState, launchId: string): WebLaunchStoredReceipt {
    const receipt = Object.hasOwn(state.receipts, launchId) ? state.receipts[launchId] : undefined;
    if (!receipt) return failWebLaunch('EXPIRED');
    return receipt;
  }
  private bump(receipt: WebLaunchStoredReceipt): void { receipt.receiptRevision += 1; }
  private ownsProduct(receipt: WebLaunchStoredReceipt): boolean {
    const session = this.deps.getStore().getSession(receipt.threadId);
    return session?.id === receipt.threadId && session.source === CoworkSessionSource.ChromeExtension;
  }
  private metadata(receipt: WebLaunchStoredReceipt, output?: WebLaunchFinalOutput): WebLaunchResponse {
    const receiptValue: WebLaunchReceipt = {
      requestId: receipt.requestId, launchId: receipt.launchId, receiptRevision: receipt.receiptRevision,
      request: { status: receipt.requestStatus },
      execution: { status: receipt.executionStatus, executionSettled: receipt.executionSettled },
      output: {
        status: receipt.outputStatus,
        ...(output?.text !== undefined ? { text: output.text, format: 'text' as const } : {}),
        ...(output?.artifacts?.length ? { artifacts: output.artifacts } : {}),
      },
      delivery: { status: receipt.deliveryRevoked ? 'revoked' : 'connected' },
      ...(receipt.errorCode ? { error: { code: receipt.errorCode, messageKey: `webLaunchError${receipt.errorCode}` } } : {}),
    };
    return { receipt: receiptValue, internal: {
      threadId: receipt.threadId, documentLeaseId: receipt.leaseId,
      composeRevision: receipt.composeRevision, deadlineAt: receipt.deadlineAt,
      effectiveMode: receipt.mode,
      permissionMode: receipt.permissionMode ?? PermissionMode.Ask,
      requiresSendConfirmation: !receipt.autoAllowed,
      requiresResultConsent: receipt.result === 'final' && !receipt.shareResult,
      requiresUnknownConfirmation: receipt.requiresUnknownConfirmation,
      ...(receipt.clientTurnId ? { clientTurnId: receipt.clientTurnId } : {}),
      ...(receipt.nativeBinding ? { nativeRunId: receipt.nativeBinding.nativeRunId } : {}),
      ...(receipt.notSent === true ? { notSent: true } : {}),
    } };
  }

  writeSite(raw: unknown) {
    const value = webLaunchRecord(raw);
    assertWebLaunchKeys(value, ['expectedRevision', 'origin', 'enabled', 'allowSend', 'allowResult']);
    const expectedRevision = webLaunchInteger(value.expectedRevision, 0);
    const origin = webLaunchOrigin(value.origin);
    const enabled = webLaunchBoolean(value.enabled);
    const allowSend = webLaunchBoolean(value.allowSend);
    const allowResult = webLaunchBoolean(value.allowResult);
    this.store.mutate(state => {
      if (expectedRevision !== state.policyRevision) return failWebLaunch('POLICY_CONFLICT');
      let site = state.sites.find(item => item.origin === origin);
      if (!site) {
        if (state.sites.length >= 128) return failWebLaunch('CAPACITY_EXCEEDED');
        site = { origin, enabled, allowSend, allowResult, revision: 0 };
        state.sites.push(site);
      }
      Object.assign(site, { enabled, allowSend, allowResult, revision: site.revision + 1 });
      state.policyRevision += 1;
      for (const receipt of Object.values(state.receipts).filter(item => item.source.origin === origin)) {
        receipt.autoAllowed = false;
        if (!enabled || !allowResult) { receipt.shareRevoked = true; receipt.shareResult = false; receipt.outputStatus = receipt.result === 'final' ? 'withheld' : 'not-requested'; }
        if (!enabled) {
          receipt.deliveryRevoked = true;
          if (!settled(receipt) && !closedRequestStatuses.has(receipt.requestStatus) &&
            !receipt.dispatchAttempted && (!receipt.clientTurnId || receipt.notSent)) {
            receipt.notSent = true;
            receipt.requestStatus = 'cancelled';
            receipt.errorCode = 'SITE_NOT_ALLOWED';
          }
        }
        this.bump(receipt);
      }
      if (!enabled) for (const lease of Object.values(state.leases)) if (lease.source.origin === origin) lease.active = false;
    });
    for (const [id, owner] of this.owners) {
      const receipt = this.store.read().receipts[id];
      if (receipt?.source.origin === origin) {
        owner.candidates.clear();
        clearTimeout(owner.candidateExpiry);
        if (!owner.dispatched) this.closeUnsent(id, 'SITE_NOT_ALLOWED');
      }
    }
    this.changed();
    return this.sites();
  }

  private verifyLease(state: ChromeWebLaunchState, id: string, source: WebLaunchSource): WebLaunchDocumentLease {
    const lease = Object.hasOwn(state.leases, id) ? state.leases[id] : undefined;
    if (!lease?.active || lease.expiresAt <= this.now() || lease.sourceKey !== webLaunchSourceKey(source)) return failWebLaunch('EXPIRED');
    if (source.channelGeneration < lease.source.channelGeneration) return failWebLaunch('EXPIRED');
    lease.source.channelGeneration = source.channelGeneration;
    return lease;
  }

  private prune(state: ChromeWebLaunchState): void {
    for (const [id, receipt] of Object.entries(state.receipts)) {
      if (!receipt.clientTurnId && !receipt.executionSettled && receipt.deadlineAt <= this.now()) {
        receipt.notSent = true;
        receipt.autoAllowed = false;
        receipt.requestStatus = 'expired';
        receipt.errorCode = 'EXPIRED';
        this.bump(receipt);
      }
      // The admission deadline must not consume a long run's result retention.
      const retentionStart = Math.max(receipt.deadlineAt, receipt.terminal?.endedAt ?? receipt.deadlineAt);
      if ((settled(receipt) || receipt.notSent) && this.now() > retentionStart + WebLaunchLimits.confirmationMs) delete state.receipts[id];
    }
    const used = new Set(Object.values(state.receipts).map(receipt => receipt.leaseId));
    for (const [id, lease] of Object.entries(state.leases)) if ((!lease.active || lease.expiresAt <= this.now()) && !used.has(id)) delete state.leases[id];
  }

  private retireMemory(): void {
    const receipts = this.store.read().receipts;
    for (const [id, owner] of this.owners) if (!Object.hasOwn(receipts, id)) {
      owner.active = false;
      owner.dispose?.();
      owner.candidates.clear();
      clearTimeout(owner.candidateExpiry);
      this.owners.delete(id);
      this.resultAttempts.delete(id);
      this.resultReads.delete(id);
      this.refreshing.delete(id);
    }
  }

  prepare(raw: unknown): WebLaunchResponse {
    const value = parseWebLaunchPrepare(raw);
    buildStrictWebLaunchContext(value.source.origin, value.input.context?.text);
    this.policy(this.store.read(), value.source.origin);
    const productStore = this.deps.getStore();
    const config = productStore.getConfig();
    const cwd = resolveTaskWorkingDirectory(config.workingDirectory.trim());
    if (!cwd) return failWebLaunch('NATIVE_UNAVAILABLE');
    let error: string | undefined;
    let prepared!: WebLaunchStoredReceipt;
    this.store.mutate(state => {
      this.prune(state);
      if (value.expectedQueuedPolicyRevision !== undefined &&
          value.expectedQueuedPolicyRevision !== state.policyRevision)
        return failWebLaunch('POLICY_CONFLICT');
      if (value.connectionOnly) {
        this.policy(state, value.source.origin);
        if (value.expectedPolicyRevision !== state.policyRevision) return failWebLaunch('POLICY_CONFLICT');
      }
      const sourceKey = webLaunchSourceKey(value.source);
      const watermarkKey = webLaunchDigest(sourceKey);
      const existing = Object.values(state.receipts).find(receipt => receipt.sourceKey === sourceKey && receipt.requestId === value.requestId);
      if (existing) {
        this.verifyLease(state, existing.leaseId, value.source);
        if (existing.payloadDigest !== value.payloadDigest || existing.clickSequence !== value.clickSequence || existing.bindingRevision !== value.bindingRevision) return failWebLaunch('REQUEST_CONFLICT');
        if (value.connectionOnly && (existing.autoAllowed || existing.shareResult)) return failWebLaunch('REQUEST_CONFLICT');
        prepared = existing;
        return;
      }
      let lease: WebLaunchDocumentLease | undefined;
      if (value.documentLeaseId) lease = this.verifyLease(state, value.documentLeaseId, value.source);
      else {
        const active = Object.values(state.leases).find(item => item.sourceKey === sourceKey && item.active && item.expiresAt > this.now());
        if (active) lease = this.verifyLease(state, active.id, value.source);
        else {
          if (Object.keys(state.leases).length >= 256) return failWebLaunch('CAPACITY_EXCEEDED');
          if (!(watermarkKey in state.watermarks) && Object.keys(state.watermarks).length >= 8192) return failWebLaunch('CAPACITY_EXCEEDED');
        }
      }
      if (value.clickSequence <= (lease?.highWater ?? state.watermarks[watermarkKey] ?? 0)) return failWebLaunch('EXPIRED');
      if (lease) lease.highWater = value.clickSequence; // Rejected clicks are consumed too.
      state.watermarks[watermarkKey] = value.clickSequence;
      const site = state.sites.find(item => item.origin === value.source.origin);
      if (!site?.enabled) { error = 'SITE_NOT_ALLOWED'; return; }
      const windowKey = webLaunchWindowKey(value.source);
      if (Object.values(state.receipts).some(receipt => receipt.observed && receipt.windowKey === windowKey && !settled(receipt) && !receipt.notSent)) { error = 'COMPOSER_BUSY'; return; }
      if (Object.values(state.receipts).filter(receipt => receipt.observed && !settled(receipt) && !receipt.notSent).length >= WebLaunchLimits.activeReceipts || Object.keys(state.receipts).length >= 300) { error = 'CAPACITY_EXCEEDED'; return; }
      if (!lease) {
        lease = {
          id: this.uuid(), sourceKey, source: strippedSource(value.source), highWater: value.clickSequence,
          active: true, expiresAt: this.now() + 24 * 60 * 60_000,
        };
        state.leases[lease.id] = lease;
      }
      const title = value.input.prompt.trim().split(/\r?\n/u, 1)[0].trim().slice(0, 50);
      const permissionMode = PermissionMode.Full;
      const thread = productStore.createSession(title, cwd, config.executionMode || 'local', [], 'main', permissionMode, this.deps.getDefaultModelRef?.(), undefined, CoworkSessionSource.ChromeExtension);
      productStore.markSessionPendingFirstSend(thread.id);
      const requiresUnknownConfirmation = state.unknownOrigins.includes(value.source.origin);
      const preference = state.sendMode ?? WebLaunchSendMode.Website;
      const mode = value.connectionOnly || preference === WebLaunchSendMode.Website ? value.input.mode : preference;
      const autoAllowed = !value.connectionOnly && mode === WebLaunchSendMode.Direct && site.allowSend && (value.input.result === 'none' || site.allowResult) && !requiresUnknownConfirmation;
      const shareResult = !value.connectionOnly && value.input.result === 'final' && site.allowResult;
      prepared = {
        launchId: this.uuid(), requestId: value.requestId, receiptRevision: 1, leaseId: lease.id,
        source: strippedSource(value.source), sourceKey, windowKey, clickSequence: value.clickSequence,
        bindingRevision: value.bindingRevision, payloadDigest: value.payloadDigest,
        actualDigest: webLaunchActualDigest({ prompt: value.input.prompt, ...(value.input.context ? { context: value.input.context } : {}), permissionMode }),
        permissionMode,
        mode, result: value.input.result, composeRevision: 1, threadId: thread.id,
        createdAt: this.now(), deadlineAt: this.now() + (autoAllowed ? WebLaunchLimits.automaticAdmissionMs : WebLaunchLimits.confirmationMs),
        confirmationStarted: !autoAllowed, grantRevision: site.revision,
        requestStatus: mode === WebLaunchSendMode.Draft ? 'drafted' : autoAllowed ? 'drafted' : 'awaiting-confirmation',
        executionStatus: 'not-started', executionSettled: false,
        outputStatus: value.input.result === 'none' ? 'not-requested' : shareResult ? 'pending' : 'awaiting-consent',
        shareResult, shareRevoked: false,
        deliveryRevoked: false, autoAllowed, requiresUnknownConfirmation, observed: true, processEpoch: this.epoch,
      };
      state.receipts[prepared.launchId] = prepared;
    });
    this.retireMemory();
    if (error) return failWebLaunch(error);
    this.changed();
    return this.metadata(prepared);
  }

  private confirmation(receipt: WebLaunchStoredReceipt): void {
    if (!receipt.confirmationStarted) {
      receipt.confirmationStarted = true;
      receipt.deadlineAt = this.now() + WebLaunchLimits.confirmationMs;
    }
    receipt.autoAllowed = false;
    receipt.requestStatus = 'awaiting-confirmation';
  }

  revise(raw: unknown): WebLaunchResponse {
    const value = webLaunchRecord(raw);
    assertWebLaunchKeys(value, ['launchId', 'expectedComposeRevision', 'composeRevision', 'input', 'shareResult']);
    const id = webLaunchString(value.launchId);
    const expected = webLaunchInteger(value.expectedComposeRevision ?? value.composeRevision);
    const input = parseWebLaunchActualInput(value.input);
    const old = this.get(this.store.read(), id);
    if (closedRequestStatuses.has(old.requestStatus)) return failWebLaunch('EXPIRED');
    buildStrictWebLaunchContext(old.source.origin, input.context?.text);
    const owner = this.owners.get(id);
    if (owner?.dispatched || old.dispatchAttempted && !old.notSent) return failWebLaunch('TOO_LATE');
    if (owner) this.closeUnsent(id, 'COMPOSE_CHANGED');
    const result = this.store.mutate(state => {
      const receipt = this.get(state, id);
      if (receipt.composeRevision !== expected) return failWebLaunch('COMPOSE_CHANGED');
      if (receipt.deliveryRevoked || this.now() >= receipt.deadlineAt) return failWebLaunch('EXPIRED');
      this.policy(state, receipt.source.origin);
      receipt.composeRevision += 1;
      receipt.permissionMode = input.permissionMode ?? receipt.permissionMode ?? PermissionMode.Ask;
      receipt.actualDigest = webLaunchActualDigest({ ...input, permissionMode: receipt.permissionMode });
      if (value.shareResult !== undefined) {
        receipt.shareResult = webLaunchBoolean(value.shareResult) && receipt.result === 'final';
        if (!receipt.shareResult && receipt.result === 'final') receipt.outputStatus = 'withheld';
      }
      this.confirmation(receipt);
      this.bump(receipt);
      return receipt;
    });
    this.changed();
    return this.metadata(result);
  }

  submit(raw: unknown): WebLaunchResponse {
    const value = parseWebLaunchSubmit(raw);
    const current = this.get(this.store.read(), value.launchId);
    if (closedRequestStatuses.has(current.requestStatus)) return failWebLaunch('EXPIRED');
    const input = { ...value.input, permissionMode: value.input.permissionMode ?? current.permissionMode ?? PermissionMode.Ask };
    const digest = webLaunchActualDigest(input);
    const context = buildStrictWebLaunchContext(current.source.origin, input.context?.text);
    const existingOwner = this.owners.get(value.launchId);
    if (current.clientTurnId && !current.notSent) {
      if (current.composeRevision !== value.composeRevision || current.actualDigest !== digest) return failWebLaunch('COMPOSE_CHANGED');
      if (existingOwner?.active || current.dispatchAttempted) return this.metadata(current);
      return failWebLaunch('COMPOSER_BUSY');
    }
    if (current.notSent && value.submission !== 'confirmed') return failWebLaunch('CONFIRMATION_REQUIRED');
    const confirmedNewTask = value.submission === 'confirmed' && value.confirmNewTask === true;
    const owner: Owner = { id: this.uuid(), composeRevision: value.composeRevision, active: true, dispatched: false, stopIntent: false, delegated: false, candidates: new Map() };
    const receipt = this.store.mutate(state => {
      const item = this.get(state, value.launchId);
      const policy = this.policy(state, item.source.origin);
      const lease = state.leases[item.leaseId];
      if (!lease?.active || lease.expiresAt <= this.now() || item.deliveryRevoked || item.deadlineAt <= this.now()) return failWebLaunch('EXPIRED');
      if (item.composeRevision !== value.composeRevision || item.actualDigest !== digest) return failWebLaunch('COMPOSE_CHANGED');
      if (settled(item)) return failWebLaunch('TOO_LATE');
      const unknown = state.unknownOrigins.includes(item.source.origin);
      if (unknown && !confirmedNewTask) return failWebLaunch('UNKNOWN_EXECUTION');
      if (value.submission === 'automatic' && (!item.autoAllowed || item.mode !== WebLaunchSendMode.Direct || item.grantRevision !== policy.revision
        || !policy.allowSend || value.rememberSend || value.rememberResult || input.modelRef || input.permissionMode !== (item.permissionMode ?? PermissionMode.Ask))) return failWebLaunch('CONFIRMATION_REQUIRED');
      if (value.shareResult && item.result !== 'final') return failWebLaunch('RESULT_CONSENT_REQUIRED');
      if (value.submission === 'automatic' && value.shareResult && !policy.allowResult) return failWebLaunch('RESULT_CONSENT_REQUIRED');
      if (value.submission === 'confirmed' && (value.rememberSend || value.rememberResult)) {
        if (value.rememberResult && !value.shareResult) return failWebLaunch('RESULT_CONSENT_REQUIRED');
        policy.allowSend ||= value.rememberSend === true;
        policy.allowResult ||= value.rememberResult === true;
        policy.revision += 1;
        state.policyRevision += 1;
      }
      item.grantRevision = policy.revision;
      item.clientTurnId = this.uuid();
      item.nativeBinding = undefined;
      item.terminal = undefined;
      item.resultRef = undefined;
      item.dispatchAttempted = false;
      item.notSent = false;
      item.processEpoch = this.epoch;
      item.requestStatus = 'submitting';
      item.executionStatus = 'not-started';
      item.errorCode = undefined;
      item.shareResult = value.shareResult;
      item.shareRevoked = !value.shareResult;
      item.confirmedNewTask = confirmedNewTask;
      item.requiresUnknownConfirmation = false;
      item.outputStatus = item.result === 'none' ? 'not-requested' : value.shareResult ? 'pending' : 'withheld';
      this.bump(item);
      return item;
    });
    this.owners.set(value.launchId, owner);
    this.changed();
    void this.dispatch(receipt.launchId, owner, input, context);
    return this.metadata(receipt);
  }

  private assertOwner(launchId: string, owner: Owner): WebLaunchStoredReceipt {
    if (this.closed || !owner.active || owner.stopIntent || this.owners.get(launchId) !== owner) return failWebLaunch(owner.closedReason ?? 'EXPIRED');
    const state = this.store.read();
    const receipt = this.get(state, launchId);
    if (!this.ownsProduct(receipt)) return failWebLaunch('EXPIRED');
    const policy = this.policy(state, receipt.source.origin);
    const lease = state.leases[receipt.leaseId];
    if (!lease?.active || lease.expiresAt <= this.now() || receipt.deliveryRevoked || receipt.deadlineAt <= this.now()) return failWebLaunch('EXPIRED');
    if (receipt.composeRevision !== owner.composeRevision) return failWebLaunch('COMPOSE_CHANGED');
    if (policy.revision !== receipt.grantRevision) return failWebLaunch('POLICY_CONFLICT');
    if (state.unknownOrigins.includes(receipt.source.origin) && !receipt.confirmedNewTask) return failWebLaunch('UNKNOWN_EXECUTION');
    return receipt;
  }

  private async dispatch(launchId: string, owner: Owner, input: WebLaunchActualInput & { permissionMode: WebLaunchPermissionMode }, untrustedContext?: string): Promise<void> {
    try {
      this.assertOwner(launchId, owner);
      const receipt = this.get(this.store.read(), launchId);
      const dispose = await this.deps.chat.subscribeThreadEvents(receipt.threadId, event => {
        if (event.kind === 'agent') this.capture(launchId, owner, event.event);
      });
      owner.dispose = dispose;
      this.assertOwner(launchId, owner);
      owner.delegated = true;
      await this.deps.chat.sendMessage({
        sessionId: receipt.threadId, clientTurnId: receipt.clientTurnId,
        message: input.prompt, permissionMode: input.permissionMode,
        ...(input.modelRef ? { modelRef: input.modelRef } : {}),
      }, {
        assertCurrent: () => { this.assertOwner(launchId, owner); },
        untrustedContext,
        finalSyncAdmission: binding => {
          this.assertOwner(launchId, owner);
          const runtime = this.deps.getRuntime();
          const client = runtime?.getGatewayClient();
          if (!runtime || !client || runtime.getGatewayClientGeneration() !== binding.clientGeneration) return failWebLaunch('NATIVE_UNAVAILABLE');
          this.store.mutate(state => {
            const item = this.get(state, launchId);
            if (item.clientTurnId !== receipt.clientTurnId || item.composeRevision !== owner.composeRevision) return failWebLaunch('COMPOSE_CHANGED');
            item.dispatchAttempted = true;
            item.executionStatus = 'unknown';
            this.bump(item);
          });
          owner.prepared = binding;
          owner.runtime = runtime;
          owner.client = client;
          owner.dispatched = true;
        },
        onNativeAccepted: binding => {
          if (this.owners.get(launchId) !== owner || !owner.dispatched || binding.clientTurnId !== receipt.clientTurnId) return;
          if (!owner.prepared || binding.sessionKey !== owner.prepared.sessionKey || binding.nativeSessionId !== owner.prepared.nativeSessionId
            || binding.lifecycleRevision !== owner.prepared.lifecycleRevision || binding.clientGeneration !== owner.prepared.clientGeneration) return;
          owner.binding = binding;
          this.store.mutate(state => {
            const item = this.get(state, launchId);
            item.nativeBinding = binding;
            item.requestStatus = 'submitted';
            item.executionStatus = 'running';
            if (item.errorCode === 'UNKNOWN_EXECUTION') item.errorCode = undefined;
            if (!state.abandonedUnknownOrigins.includes(item.source.origin) && !Object.values(state.receipts).some(candidate => candidate.source.origin === item.source.origin && candidate.executionStatus === 'unknown')) state.unknownOrigins = state.unknownOrigins.filter(origin => origin !== item.source.origin);
            this.bump(item);
          });
          if (owner.stopIntent) void this.abortBound(launchId, owner).catch(() => {});
          void this.refresh(launchId).catch(() => {});
          this.changed();
        },
        onNativeSendAbandoned: async () => { this.markNotSent(launchId, owner); },
      });
      if (owner.dispatched && !owner.binding && this.store.read().receipts[launchId]) this.markUnknown(launchId);
    } catch (error) {
      if (!owner.dispatched || (error as { requestSent?: boolean })?.requestSent === false) {
        if (error instanceof ChromeWebLaunchError) owner.closedReason ??= error.code;
        this.markNotSent(launchId, owner);
      }
      else if (this.store.read().receipts[launchId]) {
        this.store.mutate(state => {
          const item = this.get(state, launchId);
          if (!settled(item)) {
            item.executionStatus = 'unknown';
            item.errorCode = 'UNKNOWN_EXECUTION';
            if (!state.unknownOrigins.includes(item.source.origin)) state.unknownOrigins.push(item.source.origin);
            this.bump(item);
          }
        });
        this.changed();
      }
    }
  }

  private markNotSent(launchId: string, owner: Owner): void {
    if (this.owners.get(launchId) !== owner || !this.store.read().receipts[launchId]) return;
    const current = this.get(this.store.read(), launchId);
    if (current.nativeBinding || settled(current)) return;
    owner.active = false;
    owner.dispatched = false;
    owner.dispose?.();
    owner.candidates.clear();
    clearTimeout(owner.candidateExpiry);
    this.store.mutate(state => {
      const item = this.get(state, launchId);
      if (item.nativeBinding || settled(item)) return;
      item.notSent = true;
      item.dispatchAttempted = false;
      item.executionStatus = 'not-started';
      item.autoAllowed = false;
      if (owner.closedReason === 'CANCELLED') item.requestStatus = 'cancelled';
      else if (owner.closedReason === 'EXPIRED' || item.deadlineAt <= this.now()) item.requestStatus = 'expired';
      else if (owner.closedReason && owner.closedReason !== 'COMPOSE_CHANGED') item.requestStatus = 'cancelled';
      else this.confirmation(item);
      item.errorCode = owner.closedReason === 'CANCELLED' ? undefined : owner.closedReason ?? 'NATIVE_UNAVAILABLE';
      this.bump(item);
    });
    this.changed();
  }

  private closeUnsent(id: string, reason: string): boolean {
    const owner = this.owners.get(id);
    if (owner?.dispatched) return false;
    if (owner) {
      owner.closedReason = reason;
      owner.active = false;
      if (!owner.delegated || this.get(this.store.read(), id).notSent) this.markNotSent(id, owner);
    } else this.store.mutate(state => {
      const item = this.get(state, id);
      if (item.dispatchAttempted || item.clientTurnId && !item.notSent) return;
      item.notSent = true;
      item.requestStatus = reason === 'EXPIRED' ? 'expired' : 'cancelled';
      item.autoAllowed = false;
      this.bump(item);
    });
    return true;
  }

  private expireUnsent(receipt: WebLaunchStoredReceipt): void {
    if (!receipt.executionSettled && !closedRequestStatuses.has(receipt.requestStatus)
        && !receipt.dispatchAttempted && (!receipt.clientTurnId || receipt.notSent)
        && receipt.deadlineAt <= this.now()) this.closeUnsent(receipt.launchId, 'EXPIRED');
  }

  private capture(launchId: string, owner: Owner, event: ReturnType<typeof normalizeAgentEvent>['event']): void {
    if (!event || !owner.prepared || this.owners.get(launchId) !== owner || event.stream !== 'lifecycle'
      || event.data.executionSettled !== true || !['end', 'error'].includes(String(event.data.phase))
      || event.sessionKey !== owner.prepared.sessionKey || event.sessionId !== owner.prepared.nativeSessionId
      || event.agentSeq === undefined) return;
    const receipt = this.store.read().receipts[launchId];
    if (!receipt) return;
    const reply = event.data.terminalReply && typeof event.data.terminalReply === 'object'
      ? event.data.terminalReply as Record<string, unknown> : undefined;
    const candidate: WebLaunchResultCandidate = { agentSeq: event.agentSeq };
    if (receipt.result === 'final' && receipt.shareResult && !receipt.shareRevoked) {
      candidate.disposition = typeof reply?.disposition === 'string' ? reply.disposition : undefined;
      candidate.emptyWithReason = candidate.disposition === 'empty' && reply?.code !== undefined;
      if (typeof reply?.text === 'string' && Buffer.byteLength(reply.text) <= WebLaunchLimits.resultBytes) candidate.text = reply.text;
      else if (typeof reply?.text === 'string') candidate.disposition = 'oversized';
    }
    if (owner.candidates.size >= 8 && !owner.candidates.has(event.runId)) owner.candidates.delete(owner.candidates.keys().next().value!);
    owner.candidates.set(event.runId, candidate);
    clearTimeout(owner.candidateExpiry);
    owner.candidateExpiry = setTimeout(() => {
      owner.candidates.clear();
      const item = this.store.read().receipts[launchId];
      if (item && !item.resultRef && item.outputStatus === 'pending') this.store.mutate(state => {
        const current = this.get(state, launchId);
        current.outputStatus = 'unavailable';
        this.bump(current);
      });
    }, WebLaunchLimits.confirmationMs);
    owner.candidateExpiry.unref?.();
    // Runtime's own event admission runs after gatewayEvent listeners. Never
    // interpret this raw callback as terminal evidence before that owner runs.
    queueMicrotask(() => { void this.refresh(launchId).catch(() => {}); });
  }

  private bindingCurrent(owner: Owner, binding: CoworkNativeSendBinding): boolean {
    return this.deps.getRuntime() === owner.runtime && owner.runtime?.getGatewayClient() === owner.client
      && owner.runtime?.getGatewayClientGeneration() === binding.clientGeneration;
  }

  private markUnknown(launchId: string): void {
    let changed = false;
    this.store.mutate(state => {
      const receipt = state.receipts[launchId];
      if (!receipt || receipt.executionSettled) return;
      const missingOrigin = !state.unknownOrigins.includes(receipt.source.origin);
      if (receipt.executionStatus === 'unknown' && receipt.errorCode === 'UNKNOWN_EXECUTION' && !missingOrigin) return;
      receipt.executionStatus = 'unknown';
      receipt.errorCode = 'UNKNOWN_EXECUTION';
      if (missingOrigin) state.unknownOrigins.push(receipt.source.origin);
      this.bump(receipt);
      changed = true;
    });
    const owner = this.owners.get(launchId);
    owner?.candidates.clear();
    clearTimeout(owner?.candidateExpiry);
    if (changed) this.changed();
  }

  private refresh(launchId: string): Promise<void> {
    const current = this.refreshing.get(launchId);
    if (current) return current;
    const promise = this.refreshOnce(launchId).finally(() => { if (this.refreshing.get(launchId) === promise) this.refreshing.delete(launchId); });
    this.refreshing.set(launchId, promise);
    return promise;
  }

  private async refreshOnce(launchId: string): Promise<void> {
    const stored = this.store.read().receipts[launchId];
    const owner = this.owners.get(launchId);
    const binding = owner?.binding;
    if (!stored || settled(stored)) return;
    if (!owner || !owner.runtime || !owner.client) {
      if (stored.dispatchAttempted || stored.nativeBinding) this.markUnknown(launchId);
      return;
    }
    if (!binding) {
      if (owner.prepared && !this.bindingCurrent(owner, owner.prepared)) this.markUnknown(launchId);
      return; // Retain the bounded pre-ACK terminal candidate, without admitting it.
    }
    if (!this.bindingCurrent(owner, binding)) { this.markUnknown(launchId); return; }
    const terminal = owner.runtime.getRunTerminalReceipt(binding.nativeRunId);
    if (!terminal || terminal.executionSettled !== true || terminal.runId !== binding.nativeRunId || terminal.sessionId !== binding.nativeSessionId
      || terminal.sessionKey !== binding.sessionKey || terminal.clientGeneration !== binding.clientGeneration) return;
    const before = await owner.client.request<{ session?: { key?: string; sessionId?: string; lifecycleRevision?: string } }>('sessions.describe', { key: binding.sessionKey });
    if (this.owners.get(launchId) !== owner) return;
    if (!this.bindingCurrent(owner, binding) || before.session?.sessionId !== binding.nativeSessionId
      || before.session.lifecycleRevision !== binding.lifecycleRevision || before.session.key !== binding.sessionKey) {
      this.markUnknown(launchId);
      return;
    }
    const latest = owner.runtime.getRunTerminalReceipt(binding.nativeRunId);
    if (!latest || latest.agentSeq !== terminal.agentSeq || latest.sessionId !== terminal.sessionId) return;
    this.store.mutate(state => {
      const item = state.receipts[launchId];
      if (!item || item.clientTurnId !== binding.clientTurnId || item.nativeBinding?.nativeRunId !== binding.nativeRunId) return;
      item.executionStatus = terminal.status;
      item.executionSettled = true;
      if (terminal.status === 'completed' && item.errorCode === 'UNKNOWN_EXECUTION') item.errorCode = undefined;
      item.terminal = { status: terminal.status, endedAt: terminal.endedAt, agentSeq: terminal.agentSeq };
      if (terminal.status !== 'completed') {
        item.errorCode = terminal.status === 'interrupted' ? 'EXECUTION_INTERRUPTED' : 'EXECUTION_FAILED';
        if (item.result === 'final' && item.shareResult && !item.shareRevoked) item.outputStatus = 'unavailable';
      }
      this.bump(item);
      if (!state.abandonedUnknownOrigins.includes(item.source.origin) && !Object.values(state.receipts).some(candidate => candidate.source.origin === item.source.origin && candidate.executionStatus === 'unknown')) state.unknownOrigins = state.unknownOrigins.filter(origin => origin !== item.source.origin);
    });
    owner.dispose?.();
    this.changed();
  }

  private reference(raw: unknown): { receipt: WebLaunchStoredReceipt; source: WebLaunchSource } {
    const value = webLaunchRecord(raw);
    assertWebLaunchKeys(value, ['source', 'documentLeaseId', 'launchId', 'requestId']);
    const source = parseWebLaunchSource(value.source);
    const sourceKey = webLaunchSourceKey(source);
    let receipt!: WebLaunchStoredReceipt;
    this.store.mutate(state => {
      receipt = value.launchId !== undefined ? this.get(state, webLaunchString(value.launchId))
        : Object.values(state.receipts).find(item => item.sourceKey === sourceKey && item.requestId === webLaunchString(value.requestId)) ?? failWebLaunch('EXPIRED');
      if (receipt.sourceKey !== sourceKey || value.documentLeaseId !== undefined && value.documentLeaseId !== receipt.leaseId) return failWebLaunch('EXPIRED');
      this.verifyLease(state, receipt.leaseId, source);
      this.policy(state, source.origin);
      receipt.source.channelGeneration = source.channelGeneration;
    });
    return { receipt, source };
  }

  async read(raw: unknown): Promise<WebLaunchResponse> {
    const reference = this.reference(raw);
    await this.refresh(reference.receipt.launchId);
    this.expireUnsent(this.get(this.store.read(), reference.receipt.launchId));
    let receipt = this.get(this.store.read(), reference.receipt.launchId);
    let output: WebLaunchFinalOutput | undefined;
    if (receipt.executionStatus === 'completed' && receipt.result === 'final' && receipt.shareResult && !receipt.shareRevoked && !receipt.deliveryRevoked
      && !['unavailable', 'unsupported', 'empty', 'withheld'].includes(receipt.outputStatus)) output = await this.readResult(receipt.launchId);
    this.reference(raw); // Recheck source/channel/grant after every awaited read.
    const state = this.store.read();
    receipt = this.get(state, receipt.launchId);
    // This synchronous block is the result release boundary. Inner readers
    // cannot cover a revoke/cancel queued between their return and our await.
    if (output !== undefined) {
      const policy = state.sites.find(item => item.origin === receipt.source.origin);
      const owner = this.owners.get(receipt.launchId);
      const native = owner?.binding;
      const lease = state.leases[receipt.leaseId];
      const allowed = receipt.executionSettled && receipt.executionStatus === 'completed'
        && receipt.result === 'final' && receipt.shareResult && !receipt.shareRevoked && !receipt.deliveryRevoked
        && policy?.enabled && policy.revision === receipt.grantRevision && lease?.active && lease.expiresAt > this.now()
        && owner && native && native.clientTurnId === receipt.clientTurnId && native.nativeRunId === receipt.nativeBinding?.nativeRunId
        && this.bindingCurrent(owner, native) && this.ownsProduct(receipt);
      if (!allowed) {
        output = undefined;
        if (receipt.outputStatus === 'available') {
          this.store.mutate(next => {
            const item = this.get(next, receipt.launchId);
            item.outputStatus = item.shareRevoked || !item.shareResult || item.deliveryRevoked ? 'withheld' : 'unavailable';
            this.bump(item);
          });
          receipt = this.get(this.store.read(), receipt.launchId);
        }
      }
    }
    return this.metadata(receipt, output);
  }

  private readResult(launchId: string): Promise<WebLaunchFinalOutput | undefined> {
    const existing = this.resultReads.get(launchId);
    if (existing) return existing;
    const promise = this.readResultOnce(launchId).finally(() => { if (this.resultReads.get(launchId) === promise) this.resultReads.delete(launchId); });
    this.resultReads.set(launchId, promise);
    return promise;
  }

  private async readResultOnce(launchId: string): Promise<WebLaunchFinalOutput | undefined> {
    const receipt = this.get(this.store.read(), launchId);
    const owner = this.owners.get(launchId);
    const binding = owner?.binding;
    if (!owner || !binding || !owner.runtime || !owner.client || !receipt.terminal || !this.bindingCurrent(owner, binding)) {
      this.store.mutate(state => { const item = this.get(state, launchId); item.outputStatus = 'unavailable'; this.bump(item); });
      return undefined;
    }
    const assertCurrent = () => {
      const state = this.store.read();
      const item = this.get(state, launchId);
      const policy = this.policy(state, item.source.origin);
      if (this.owners.get(launchId) !== owner || !this.bindingCurrent(owner, binding) || item.clientTurnId !== binding.clientTurnId
        || item.terminal?.agentSeq !== receipt.terminal?.agentSeq || item.shareRevoked || item.deliveryRevoked || !item.shareResult
        || !state.leases[item.leaseId]?.active || policy.revision !== item.grantRevision || !this.ownsProduct(item)) return failWebLaunch('RESULT_UNAVAILABLE');
    };
    try {
      assertCurrent();
      const candidate = owner.candidates.get(binding.nativeRunId);
      if (candidate && candidate.agentSeq !== receipt.terminal.agentSeq) return undefined;
      const result = candidate?.disposition === 'oversized' ? { status: 'unsupported' as const }
        : await readWebLaunchFinal({ runtime: owner.runtime, client: owner.client, binding, candidate, reference: receipt.resultRef, assertCurrent });
      assertCurrent();
      const attempts = (this.resultAttempts.get(launchId) ?? 0) + 1;
      this.resultAttempts.set(launchId, attempts);
      this.store.mutate(state => {
        const item = this.get(state, launchId);
        item.outputStatus = result.status === 'pending' && attempts >= 10 ? 'unavailable' : result.status;
        if ('reference' in result && result.reference) item.resultRef = result.reference;
        this.bump(item);
      });
      if (result.status === 'available' && result.output) {
        owner.candidates.clear();
        clearTimeout(owner.candidateExpiry);
        return result.output;
      }
      if (result.status !== 'pending' || attempts >= 10) { owner.candidates.clear(); clearTimeout(owner.candidateExpiry); }
    } catch {
      this.store.mutate(state => { const item = state.receipts[launchId]; if (item && !item.shareRevoked && !item.deliveryRevoked) { item.outputStatus = 'unavailable'; this.bump(item); } });
    }
    return undefined;
  }

  cancel(raw: unknown): WebLaunchResponse {
    const { receipt } = this.reference(raw);
    const tooLate = receipt.dispatchAttempted && !receipt.notSent;
    this.store.mutate(state => {
      const item = this.get(state, receipt.launchId);
      item.shareRevoked = true;
      item.shareResult = false;
      item.outputStatus = item.result === 'none' ? 'not-requested' : 'withheld';
      if (tooLate) item.errorCode = 'TOO_LATE';
      this.bump(item);
    });
    if (!tooLate) this.closeUnsent(receipt.launchId, 'CANCELLED');
    this.owners.get(receipt.launchId)?.candidates.clear();
    this.changed();
    return this.metadata(this.get(this.store.read(), receipt.launchId));
  }

  async stop(raw: unknown): Promise<WebLaunchResponse> {
    const value = webLaunchRecord(raw);
    assertWebLaunchKeys(value, ['launchId']);
    const id = webLaunchString(value.launchId);
    const receipt = this.get(this.store.read(), id);
    const owner = this.owners.get(id);
    if (!owner) {
      if (receipt.clientTurnId && !receipt.notSent) return failWebLaunch('UNKNOWN_EXECUTION');
      this.closeUnsent(id, 'CANCELLED');
    } else {
      owner.stopIntent = true;
      if (!owner.dispatched) this.closeUnsent(id, 'CANCELLED');
      else if (owner.binding) await this.abortBound(id, owner);
    }
    this.changed();
    return this.metadata(this.get(this.store.read(), id));
  }

  private async abortBound(id: string, owner: Owner): Promise<void> {
    const binding = owner.binding;
    if (!binding || !owner.client || !this.bindingCurrent(owner, binding)) return failWebLaunch('UNKNOWN_EXECUTION');
    const current = this.get(this.store.read(), id);
    if (current.clientTurnId !== binding.clientTurnId || current.executionSettled) return;
    await owner.client.request('sessions.abort', { key: binding.sessionKey, runId: binding.nativeRunId });
  }

  async observations() {
    const active = Object.values(this.store.read().receipts).filter(item => item.observed && !item.executionSettled);
    for (const item of active) this.expireUnsent(item);
    const ids = active.map(item => item.launchId);
    for (let offset = 0; offset < ids.length; offset += 4) await Promise.allSettled(ids.slice(offset, offset + 4).map(id => this.refresh(id)));
    return { observations: Object.values(this.store.read().receipts).filter(item => item.observed).map(item => ({
      ...this.metadata(item), origin: item.source.origin, createdAt: item.createdAt,
    })) };
  }

  abandon(raw: unknown) {
    const value = webLaunchRecord(raw);
    assertWebLaunchKeys(value, ['launchId', 'confirm']);
    if (value.confirm !== true) return failWebLaunch('CONFIRMATION_REQUIRED');
    const id = webLaunchString(value.launchId);
    const receipt = this.get(this.store.read(), id);
    const owner = this.owners.get(id);
    if (owner && !owner.dispatched) { owner.active = false; owner.closedReason = 'EXPIRED'; }
    owner?.dispose?.();
    this.store.mutate(state => {
      const item = this.get(state, id);
      const lease = state.leases[item.leaseId];
      if (lease) lease.active = false;
      if (!item.executionSettled && item.clientTurnId && !item.notSent) {
        if (!state.unknownOrigins.includes(item.source.origin)) state.unknownOrigins.push(item.source.origin);
        if (!state.abandonedUnknownOrigins.includes(item.source.origin)) state.abandonedUnknownOrigins.push(item.source.origin);
      }
      delete state.receipts[id]; // Revoked missing leases/envelopes never regain admission.
    });
    this.owners.delete(id);
    owner?.candidates.clear();
    clearTimeout(owner?.candidateExpiry);
    this.resultAttempts.delete(id);
    this.resultReads.delete(id);
    this.refreshing.delete(id);
    this.changed();
    return { status: 'abandoned', executionSettled: receipt.executionSettled };
  }

  revokeDocument(raw: unknown) {
    const value = webLaunchRecord(raw);
    assertWebLaunchKeys(value, ['source', 'documentLeaseId', 'reason']);
    const source = parseWebLaunchSource(value.source);
    const leaseId = webLaunchString(value.documentLeaseId);
    const reasons = ['navigation', 'pagehide', 'bfcache', 'all-bindings-removed', 'permission-revoked'];
    if (!reasons.includes(String(value.reason))) return failWebLaunch('INVALID_REQUEST');
    const ids = this.store.mutate(state => {
      const lease = this.verifyLease(state, leaseId, source);
      lease.active = false;
      const selected = Object.values(state.receipts).filter(item => item.leaseId === leaseId);
      for (const item of selected) {
        item.deliveryRevoked = true;
        item.shareRevoked = true;
        item.shareResult = false;
        item.outputStatus = item.result === 'none' ? 'not-requested' : 'withheld';
        this.bump(item);
      }
      return selected.map(item => item.launchId);
    });
    for (const id of ids) {
      this.closeUnsent(id, 'EXPIRED');
      const owner = this.owners.get(id);
      owner?.candidates.clear();
      clearTimeout(owner?.candidateExpiry);
    }
    this.changed();
    return { status: 'revoked' };
  }

  close(): void {
    this.closed = true;
    for (const owner of this.owners.values()) { owner.active = false; owner.dispose?.(); owner.candidates.clear(); clearTimeout(owner.candidateExpiry); }
    this.owners.clear();
    this.resultAttempts.clear();
    this.resultReads.clear();
    this.refreshing.clear();
  }
}
