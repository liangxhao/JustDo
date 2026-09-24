import { randomBytes, randomUUID } from 'crypto';
import { dialog, ipcMain, type IpcMainEvent, session, webContents } from 'electron';
import fs from 'fs';
import path from 'path';

import { createPropertyContext } from '../../shared/app/propertyContext';
import {
  BROWSER_AGENT_INTERACTION_ACK_TIMEOUT_MS,
  BROWSER_AGENT_PANEL_TARGET_ID,
  type BrowserAgentProfile,
  type BrowserAgentTabReference,
  type BrowserAgentTabRegistration,
  BrowserIpc,
  browserPartitionForProfile,
  isBrowserAgentProfile,
} from '../../shared/browser/browser';
import { BrowserRecordingChannel } from '../../shared/browser/browserRecording';
import { t } from '../core/i18n';
import { registerBrowserProxySession } from '../core/network/systemProxyPreference';
import * as browserAgentActions from './browserAgentActions';
import { type BrowserAgentActionsContext } from './browserAgentActions';
import { cancelBrowserAgentDownloadsForWebContents } from './browserAgentDownloadCoordinator';
import {
  AGENT_INTERACTION_ACTIONS,
  AgentBrowserCommand,
  ARMED_INTERACTION_TIMEOUT_MS,
  asRecord,
  BROWSER_AGENT_WORLD_ID,
  BrowserAgentInteractionLease,
  BrowserDialogResponse,
  BrowserDialogState,
  BrowserInteractionAckWaiter,
  BrowserLabelAnnotation,
  BrowserLogEntry,
  browserScopeId,
  BrowserSnapshot,
  BrowserUploadResponse,
  COMMAND_TIMEOUT_MS,
  EMBEDDED_PROFILE,
  EMBEDDED_PROFILE_COLOR,
  ENSURE_TAB_TIMEOUT_MS,
  FRAME_PATH_SEPARATOR,
  IMPORTED_PROFILE,
  LEGACY_FLATTENED_ACT_KEYS,
  LONG_COMMAND_TIMEOUT_MS,
  MAX_BROWSER_TABS,
  MAX_LOG_ENTRIES,
  normalizeNavigationUrl,
  normalizeSessionId,
  parseCommand,
  RegisteredTab,
  sanitizeErrorForModel,
  serializeError,
  TabWaiter,
  USER_LOCK_READ_ACTIONS,
} from './browserAgentProtocol';
import * as browserAgentSnapshots from './browserAgentSnapshots';
import { type BrowserAgentSnapshotsContext } from './browserAgentSnapshots';
import {
  importChromeData,
  listChromeImportSources,
  listImportedBrowserProfiles,
  recordImportedBrowserProfile,
} from './browserDataImportService';
import { sanitizeBrowserUrl as sanitizeUrlForModel } from './browserDataSanitizers';

export class BrowserAgentBridge {
  private readonly tabsBySession = new Map<string, Map<string, RegisteredTab>>();
  private readonly activeTargets = new Map<string, string>();
  private readonly labelsBySession = new Map<string, Map<string, string>>();
  private readonly tabHandlesBySession = new Map<string, Map<string, string>>();
  private readonly nextTabHandleBySession = new Map<string, number>();
  private readonly startedSessions = new Set<string>();
  private readonly profiles = new Set<BrowserAgentProfile>([EMBEDDED_PROFILE, IMPORTED_PROFILE]);
  private readonly tabWaiters = new Map<string, Set<TabWaiter>>();
  private readonly snapshots = new Map<number, BrowserSnapshot>();
  private readonly snapshotLabelAnnotations = new Map<
    number,
    { snapshotId: string; visibleRefs: string[]; annotations: BrowserLabelAnnotation[] }
  >();
  private readonly snapshotDeltaState = new Map<
    number,
    Map<string, { url: string; keys: Set<string> }>
  >();
  private readonly commandQueues = new Map<number, Promise<void>>();
  private readonly pendingCommandRejectors = new Set<(error: Error) => void>();
  private readonly consoleLogs = new Map<number, BrowserLogEntry[]>();
  private readonly requestLogs = new Map<number, BrowserLogEntry[]>();
  private readonly errorLogs = new Map<number, BrowserLogEntry[]>();
  private readonly pendingNetworkRequests = new Map<number, Set<string>>();
  private readonly networkRequestsById = new Map<number, Map<string, BrowserLogEntry>>();
  private readonly lastNetworkActivity = new Map<number, number>();
  private readonly dialogs = new Map<number, BrowserDialogState>();
  private readonly armedDialogs = new Map<number, BrowserDialogResponse>();
  private readonly armedUploads = new Map<number, BrowserUploadResponse>();
  private readonly runtimeCleanup = new Map<number, () => void>();
  private readonly ownedDebuggerGuests = new Set<number>();
  private readonly activeEvaluations = new Map<number, Electron.Debugger>();
  private readonly navigationGenerations = new Map<number, number>();
  private readonly userInteractionLocks = new Set<number>();
  private readonly recordingLocks = new Map<
    string,
    {
      ownerId: number;
      sessionId: string;
      profile: BrowserAgentProfile;
      recordingId: string;
      release: () => void;
    }
  >();
  private readonly agentInteractionLeases = new Map<number, BrowserAgentInteractionLease>();
  private readonly panelInteractionLeases = new Map<string, BrowserAgentInteractionLease>();
  private readonly interactionAckWaiters = new Map<string, BrowserInteractionAckWaiter>();
  private readonly ariaRefState = new Map<
    number,
    {
      next: number;
      byNodeKey: Map<string, string>;
      refs: Set<string>;
      frameSelectors: Map<string, string>;
      worldFrameSelectors: Map<string, string>;
    }
  >();

  constructor(
    private readonly sendToRenderer: (channel: string, payload: unknown) => void,
    private readonly isTrustedRenderer: (webContentsId: number) => boolean,
    private readonly getSessionWorkspace: (sessionId: string) => string | null = () => null,
    private readonly requireRendererInteractionAck = false,
  ) {
    try {
      for (const profile of listImportedBrowserProfiles()) {
        if (isBrowserAgentProfile(profile)) this.profiles.add(profile);
      }
    } catch {
      // Profile persistence is advisory during early startup; built-ins remain available.
    }
  }

  registerIpc(): void {
    ipcMain.on(BrowserIpc.AgentRegisterTab, (event, value: unknown) => {
      const registration = this.validateRegistration(event, value);
      if (!registration) return;
      const scopeId = browserScopeId(registration.sessionId, registration.profile);
      const tabs = this.tabsBySession.get(scopeId) ?? new Map();
      const previous = tabs.get(registration.targetId);
      if (previous && previous.webContentsId !== registration.webContentsId) {
        this.discardTabRuntime(previous);
      }
      const tab = { ...registration, ownerId: event.sender.id };
      tabs.set(registration.targetId, tab);
      this.tabsBySession.set(scopeId, tabs);
      console.info(
        `[BrowserAgentBridge] Registered embedded browser tab (session=${registration.sessionId}, target=${registration.targetId}, guest=${registration.webContentsId})`,
      );
      if (!this.activeTargets.has(scopeId)) {
        this.activeTargets.set(scopeId, registration.targetId);
      }
      this.installGuestRuntime(tab);
      this.startedSessions.add(scopeId);
      const handles = this.tabHandlesBySession.get(scopeId) ?? new Map();
      if (!handles.has(registration.targetId)) {
        const next = this.nextTabHandleBySession.get(scopeId) ?? 1;
        handles.set(registration.targetId, `t${next}`);
        this.nextTabHandleBySession.set(scopeId, next + 1);
        this.tabHandlesBySession.set(scopeId, handles);
      }
      this.tabWaiters.get(scopeId)?.forEach(waiter => {
        if (waiter.targetId && waiter.targetId !== tab.targetId) return;
        clearTimeout(waiter.timer);
        waiter.resolve(tab);
      });
      const remainingWaiters = this.tabWaiters.get(scopeId);
      if (!remainingWaiters?.size) this.tabWaiters.delete(scopeId);
    });
    ipcMain.on(BrowserIpc.AgentUnregisterTab, (event, value: unknown) => {
      if (!this.isTrustedIpcSender(event)) return;
      const reference = this.parseReference(value);
      if (!reference) return;
      const scopeId = this.resolveReferenceScope(reference, event.sender.id);
      if (!scopeId) return;
      const tabs = this.tabsBySession.get(scopeId);
      const tab = tabs?.get(reference.targetId);
      if (!tab || tab.ownerId !== event.sender.id) return;
      this.discardTabRuntime(tab);
      this.removeRegisteredTab(scopeId, reference.targetId);
    });
    ipcMain.on(BrowserIpc.AgentSetActiveTab, (event, value: unknown) => {
      if (!this.isTrustedIpcSender(event)) return;
      const reference = this.parseReference(value);
      const scopeId = reference ? this.resolveReferenceScope(reference, event.sender.id) : null;
      const tab =
        reference && scopeId ? this.tabsBySession.get(scopeId)?.get(reference.targetId) : null;
      if (tab?.ownerId === event.sender.id) {
        this.activeTargets.set(scopeId!, reference!.targetId);
      }
    });
    ipcMain.handle(BrowserRecordingChannel.Lease, (event, value: unknown) => {
      if (!this.isTrustedIpcSender(event)) return false;
      const v = asRecord(value);
      if (
        !v ||
        typeof v.recordingId !== 'string' ||
        v.recordingId.length > 80 ||
        typeof v.sessionId !== 'string' ||
        !isBrowserAgentProfile(v.profile) ||
        typeof v.acquire !== 'boolean'
      )
        return false;
      const profile = v.profile as BrowserAgentProfile;
      const key = `${event.sender.id}:${profile}`;
      const existing = this.recordingLocks.get(key);
      if (!v.acquire) {
        if (existing?.recordingId === v.recordingId && existing.sessionId === v.sessionId)
          existing.release();
        return true;
      }
      if (existing)
        return existing.recordingId === v.recordingId && existing.sessionId === v.sessionId;
      if ([...this.recordingLocks.values()].some(lock => lock.ownerId === event.sender.id))
        return false;
      if (
        !this.listLiveTabsForSession(v.sessionId).some(
          tab => tab.ownerId === event.sender.id && tab.profile === profile,
        )
      )
        return false;
      if (
        [...this.agentInteractionLeases.values(), ...this.panelInteractionLeases.values()].some(
          lease => lease.profile === profile,
        )
      )
        return false;
      const release = () => {
        if (this.recordingLocks.get(key)?.recordingId === v.recordingId)
          this.recordingLocks.delete(key);
        event.sender.removeListener('destroyed', release);
        event.sender.removeListener('render-process-gone', release);
        event.sender.removeListener('did-start-navigation', release);
      };
      this.recordingLocks.set(key, {
        ownerId: event.sender.id,
        sessionId: v.sessionId,
        profile,
        recordingId: v.recordingId,
        release,
      });
      event.sender.once('destroyed', release);
      event.sender.once('render-process-gone', release);
      event.sender.once('did-start-navigation', release);
      return true;
    });
    ipcMain.on(BrowserIpc.UserInteractionState, (event, value: unknown) => {
      if (!this.isTrustedIpcSender(event)) return;
      const state = asRecord(value);
      if (typeof state?.busy !== 'boolean') return;
      const reference = this.parseReference(value);
      const scopeId = reference ? this.resolveReferenceScope(reference, event.sender.id) : null;
      const tab =
        reference && scopeId ? this.tabsBySession.get(scopeId)?.get(reference.targetId) : null;
      if (!tab || tab.ownerId !== event.sender.id) return;
      if (state.busy) {
        this.userInteractionLocks.add(tab.webContentsId);
        const interactionError = new Error('The user started interacting with the browser.');
        this.rejectInteractionAcksForTab(tab.webContentsId, interactionError);
        this.rejectInteractionAcksForSession(tab.sessionId, interactionError);
      } else this.userInteractionLocks.delete(tab.webContentsId);
    });
    ipcMain.on(BrowserIpc.AgentInteractionReady, (event, value: unknown) => {
      if (!this.isTrustedIpcSender(event)) return;
      const candidate = asRecord(value);
      if (
        typeof candidate?.operationId !== 'string' ||
        typeof candidate.sessionId !== 'string' ||
        typeof candidate.targetId !== 'string'
      ) {
        return;
      }
      const waiter = this.interactionAckWaiters.get(candidate.operationId);
      if (!waiter) return;
      const candidateProfile =
        typeof candidate.profile === 'string' ? candidate.profile : EMBEDDED_PROFILE;
      if (
        candidate.sessionId !== waiter.sessionId ||
        candidate.targetId !== waiter.targetId ||
        candidateProfile !== waiter.profile
      ) {
        return;
      }
      if (waiter.webContentsId !== undefined) {
        const scopeId = browserScopeId(waiter.sessionId, waiter.profile);
        const tab = this.tabsBySession.get(scopeId)?.get(waiter.targetId);
        if (
          !tab ||
          tab.ownerId !== event.sender.id ||
          waiter.ownerId !== event.sender.id ||
          waiter.webContentsId !== tab.webContentsId
        ) {
          return;
        }
      }
      waiter.resolve();
    });
  }

  async stop(): Promise<void> {
    const stoppedError = new Error('The browser bridge is stopping.');
    for (const waiters of this.tabWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(stoppedError);
      }
    }
    for (const reject of this.pendingCommandRejectors) reject(stoppedError);
    this.pendingCommandRejectors.clear();
    this.tabsBySession.clear();
    this.activeTargets.clear();
    this.labelsBySession.clear();
    this.tabHandlesBySession.clear();
    this.nextTabHandleBySession.clear();
    this.startedSessions.clear();
    this.tabWaiters.clear();
    this.snapshots.clear();
    this.snapshotLabelAnnotations.clear();
    this.snapshotDeltaState.clear();
    this.commandQueues.clear();
    for (const cleanup of this.runtimeCleanup.values()) cleanup();
    this.runtimeCleanup.clear();
    this.consoleLogs.clear();
    this.requestLogs.clear();
    this.errorLogs.clear();
    this.pendingNetworkRequests.clear();
    this.networkRequestsById.clear();
    this.lastNetworkActivity.clear();
    this.dialogs.clear();
    for (const response of this.armedDialogs.values()) clearTimeout(response.timer);
    for (const response of this.armedUploads.values()) {
      clearTimeout(response.timer);
      response.reject(stoppedError);
    }
    this.armedDialogs.clear();
    this.armedUploads.clear();
    this.ownedDebuggerGuests.clear();
    this.activeEvaluations.clear();
    this.navigationGenerations.clear();
    this.ariaRefState.clear();
    this.userInteractionLocks.clear();
    for (const lock of this.recordingLocks.values()) lock.release();
    this.recordingLocks.clear();
    ipcMain.removeHandler(BrowserRecordingChannel.Lease);
    for (const lease of this.agentInteractionLeases.values()) {
      lease.readyController.abort(stoppedError);
    }
    for (const lease of this.panelInteractionLeases.values()) {
      lease.readyController.abort(stoppedError);
    }
    this.agentInteractionLeases.clear();
    this.panelInteractionLeases.clear();
    for (const waiter of this.interactionAckWaiters.values()) {
      waiter.reject(stoppedError);
    }
    this.interactionAckWaiters.clear();
  }

  private rejectInteractionAcksForTab(webContentsId: number, error: Error): void {
    for (const waiter of this.interactionAckWaiters.values()) {
      if (waiter.webContentsId !== webContentsId) continue;
      waiter.reject(error);
    }
  }

  private rejectInteractionAcksForSession(sessionId: string, error: Error): void {
    for (const waiter of this.interactionAckWaiters.values()) {
      if (waiter.sessionId !== sessionId) continue;
      waiter.reject(error);
    }
  }

  private async awaitInteractionLeaseReady(
    readyPromise: Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const handleAbort = () => {
        cleanup();
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Browser request was cancelled.'),
        );
      };
      const cleanup = () => signal.removeEventListener('abort', handleAbort);
      signal.addEventListener('abort', handleAbort, { once: true });
      readyPromise.then(
        () => {
          cleanup();
          resolve();
        },
        error => {
          cleanup();
          reject(error);
        },
      );
      if (signal.aborted) handleAbort();
    });
  }

  private waitForRendererInteractionAck(
    identity: {
      sessionId: string;
      targetId: string;
      profile: BrowserAgentProfile;
      webContentsId?: number;
      ownerId?: number;
    },
    operationId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (!operationId || !this.requireRendererInteractionAck) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const handleAbort = () =>
        finish(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Browser request was cancelled.'),
        );
      const finish = (error?: Error) => {
        const waiter = this.interactionAckWaiters.get(operationId);
        if (!waiter) return;
        this.interactionAckWaiters.delete(operationId);
        clearTimeout(waiter.timer);
        waiter.removeAbortListener();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error('The browser panel did not acknowledge the interaction lock.')),
        BROWSER_AGENT_INTERACTION_ACK_TIMEOUT_MS,
      );
      this.interactionAckWaiters.set(operationId, {
        ...identity,
        resolve: () => finish(),
        reject: finish,
        timer,
        removeAbortListener: () => signal.removeEventListener('abort', handleAbort),
      });
      signal.addEventListener('abort', handleAbort, { once: true });
      if (signal.aborted) handleAbort();
    });
  }

  private async withAgentInteractionLease<T>(
    tab: RegisteredTab,
    sessionId: string,
    profile: BrowserAgentProfile,
    signal: AbortSignal,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    this.assertNoRecording(profile);
    if (this.userInteractionLocks.has(tab.webContentsId)) {
      throw new Error('The user is annotating the browser. Retry after they finish.');
    }
    let lease = this.agentInteractionLeases.get(tab.webContentsId);
    const createdLease = !lease;
    if (lease) {
      lease.count += 1;
    } else {
      const operationId = this.requireRendererInteractionAck ? randomUUID() : undefined;
      const readyController = new AbortController();
      const readyPromise = this.waitForRendererInteractionAck(
        {
          sessionId,
          targetId: tab.targetId,
          profile,
          webContentsId: tab.webContentsId,
          ownerId: tab.ownerId,
        },
        operationId,
        readyController.signal,
      );
      lease = {
        count: 1,
        sessionId,
        targetId: tab.targetId,
        profile,
        ...(operationId ? { operationId } : {}),
        readyPromise,
        readyController,
      };
      this.agentInteractionLeases.set(tab.webContentsId, lease);
    }
    try {
      if (createdLease) {
        this.sendToRenderer(BrowserIpc.AgentInteractionState, {
          sessionId,
          targetId: tab.targetId,
          profile,
          busy: true,
          ...(lease.operationId ? { operationId: lease.operationId } : {}),
        });
      }
      await this.awaitInteractionLeaseReady(lease.readyPromise, signal);
      signal.throwIfAborted();
      this.assertNoRecording(profile);
      if (this.userInteractionLocks.has(tab.webContentsId)) {
        throw new Error('The user is annotating the browser. Retry after they finish.');
      }
      return await operation();
    } finally {
      const armedUpload = this.armedUploads.get(tab.webContentsId);
      const armedDialog = this.armedDialogs.get(tab.webContentsId);
      if (armedUpload?.leaseOwner === 'current') armedUpload.leaseOwner = 'persistent';
      else if (armedDialog?.leaseOwner === 'current') armedDialog.leaseOwner = 'persistent';
      else this.releaseAgentInteractionLease(tab.webContentsId);
    }
  }

  private async withPanelInteractionLease<T>(
    sessionId: string,
    profile: BrowserAgentProfile,
    signal: AbortSignal,
    operation: () => Promise<T> | T,
  ): Promise<T> {
    this.assertNoRecording(profile);
    const scopeId = browserScopeId(sessionId, profile);
    if (
      this.listLiveTabsForSession(sessionId).some(tab =>
        this.userInteractionLocks.has(tab.webContentsId),
      )
    ) {
      throw new Error('The user is annotating the browser. Retry after they finish.');
    }
    let lease = this.panelInteractionLeases.get(scopeId);
    const createdLease = !lease;
    if (lease) {
      lease.count += 1;
    } else {
      const operationId = this.requireRendererInteractionAck ? randomUUID() : undefined;
      const readyController = new AbortController();
      const readyPromise = this.waitForRendererInteractionAck(
        {
          sessionId,
          targetId: BROWSER_AGENT_PANEL_TARGET_ID,
          profile,
        },
        operationId,
        readyController.signal,
      );
      lease = {
        count: 1,
        sessionId,
        targetId: BROWSER_AGENT_PANEL_TARGET_ID,
        profile,
        ...(operationId ? { operationId } : {}),
        readyPromise,
        readyController,
      };
      this.panelInteractionLeases.set(scopeId, lease);
    }
    try {
      if (createdLease) {
        this.sendToRenderer(BrowserIpc.AgentInteractionState, {
          sessionId,
          targetId: BROWSER_AGENT_PANEL_TARGET_ID,
          profile,
          busy: true,
          ...(lease.operationId ? { operationId: lease.operationId } : {}),
        });
      }
      await this.awaitInteractionLeaseReady(lease.readyPromise, signal);
      signal.throwIfAborted();
      this.assertNoRecording(profile);
      if (
        this.listLiveTabsForSession(sessionId).some(tab =>
          this.userInteractionLocks.has(tab.webContentsId),
        )
      ) {
        throw new Error('The user is annotating the browser. Retry after they finish.');
      }
      return await operation();
    } finally {
      this.releasePanelInteractionLease(scopeId);
    }
  }

  private assertNoRecording(profile: BrowserAgentProfile): void {
    if ([...this.recordingLocks.values()].some(lock => lock.profile === profile)) {
      throw new Error('The user is recording a browser demonstration. Retry after they finish.');
    }
  }

  private listLiveTabsForSession(sessionId: string): RegisteredTab[] {
    const tabs: RegisteredTab[] = [];
    for (const profileTabs of this.tabsBySession.values()) {
      for (const tab of profileTabs.values()) {
        if (tab.sessionId === sessionId && this.isRegisteredGuestAvailable(tab)) tabs.push(tab);
      }
    }
    return tabs;
  }

  private releasePanelInteractionLease(scopeId: string): void {
    const lease = this.panelInteractionLeases.get(scopeId);
    if (!lease) return;
    lease.count -= 1;
    if (lease.count > 0) return;
    this.panelInteractionLeases.delete(scopeId);
    lease.readyController.abort(new Error('The browser interaction lease was released.'));
    this.sendToRenderer(BrowserIpc.AgentInteractionState, {
      sessionId: lease.sessionId,
      targetId: lease.targetId,
      profile: lease.profile,
      busy: false,
      ...(lease.operationId ? { operationId: lease.operationId } : {}),
    });
  }

  private releaseAgentInteractionLease(webContentsId: number): void {
    const lease = this.agentInteractionLeases.get(webContentsId);
    if (!lease) return;
    lease.count -= 1;
    if (lease.count > 0) return;
    this.agentInteractionLeases.delete(webContentsId);
    lease.readyController.abort(new Error('The browser interaction lease was released.'));
    this.sendToRenderer(BrowserIpc.AgentInteractionState, {
      sessionId: lease.sessionId,
      targetId: lease.targetId,
      profile: lease.profile,
      busy: false,
      ...(lease.operationId ? { operationId: lease.operationId } : {}),
    });
  }

  private validateRegistration(
    event: IpcMainEvent,
    value: unknown,
  ): BrowserAgentTabRegistration | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (
      !this.isTrustedIpcSender(event) ||
      typeof candidate.sessionId !== 'string' ||
      !candidate.sessionId.trim() ||
      typeof candidate.targetId !== 'string' ||
      !candidate.targetId.trim() ||
      !isBrowserAgentProfile(candidate.profile) ||
      !this.profiles.has(candidate.profile) ||
      !Number.isInteger(candidate.webContentsId)
    ) {
      return null;
    }
    const guest = webContents.fromId(candidate.webContentsId as number);
    const expectedStoragePath = session.fromPartition(
      browserPartitionForProfile(candidate.profile as BrowserAgentProfile),
    ).storagePath;
    const actualStoragePath = guest?.session.storagePath;
    if (
      !guest ||
      guest.isDestroyed() ||
      guest.getType() !== 'webview' ||
      guest.hostWebContents?.id !== event.sender.id ||
      !expectedStoragePath ||
      !actualStoragePath ||
      path.resolve(expectedStoragePath).toLowerCase() !==
        path.resolve(actualStoragePath).toLowerCase()
    ) {
      return null;
    }
    return {
      sessionId: candidate.sessionId.trim(),
      targetId: candidate.targetId.trim(),
      webContentsId: candidate.webContentsId as number,
      profile: candidate.profile as BrowserAgentProfile,
    };
  }

  private isTrustedIpcSender(event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>): boolean {
    const senderFrame = event.senderFrame;
    const mainFrame = event.sender.mainFrame;
    return (
      event.sender.getType() === 'window' &&
      senderFrame !== null &&
      senderFrame.processId === mainFrame.processId &&
      senderFrame.routingId === mainFrame.routingId &&
      this.isTrustedRenderer(event.sender.id)
    );
  }

  private parseReference(value: unknown): BrowserAgentTabReference | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.sessionId !== 'string' || typeof candidate.targetId !== 'string') {
      return null;
    }
    const sessionId = candidate.sessionId.trim();
    const targetId = candidate.targetId.trim();
    const profile = candidate.profile;
    if (profile !== undefined && !isBrowserAgentProfile(profile)) {
      return null;
    }
    return sessionId && targetId
      ? { sessionId, targetId, ...(profile ? { profile: profile as BrowserAgentProfile } : {}) }
      : null;
  }

  private resolveReferenceScope(
    reference: BrowserAgentTabReference,
    ownerId: number,
  ): string | null {
    if (reference.profile) return browserScopeId(reference.sessionId, reference.profile);
    for (const profile of this.profiles) {
      const scopeId = browserScopeId(reference.sessionId, profile);
      if (this.tabsBySession.get(scopeId)?.get(reference.targetId)?.ownerId === ownerId) {
        return scopeId;
      }
    }
    return null;
  }

  private removeRegisteredTab(sessionId: string, targetId: string): string | null {
    const tabs = this.tabsBySession.get(sessionId);
    if (!tabs?.has(targetId)) return this.activeTargets.get(sessionId) ?? null;
    const orderedTargets = [...tabs.keys()];
    const closingIndex = orderedTargets.indexOf(targetId);
    tabs.delete(targetId);
    this.tabHandlesBySession.get(sessionId)?.delete(targetId);
    const labels = this.labelsBySession.get(sessionId);
    for (const [label, labeledTargetId] of labels ?? []) {
      if (labeledTargetId === targetId) labels?.delete(label);
    }
    if (!labels?.size) this.labelsBySession.delete(sessionId);
    if (!tabs.size) {
      this.tabsBySession.delete(sessionId);
      this.tabHandlesBySession.delete(sessionId);
      this.nextTabHandleBySession.delete(sessionId);
      this.activeTargets.delete(sessionId);
      return null;
    }
    const currentTarget = this.activeTargets.get(sessionId);
    if (currentTarget !== targetId && currentTarget && tabs.has(currentTarget)) {
      return currentTarget;
    }
    const remainingTargets = orderedTargets.filter(candidate => candidate !== targetId);
    const nextTarget =
      remainingTargets[Math.min(closingIndex, remainingTargets.length - 1)] ?? null;
    if (nextTarget) this.activeTargets.set(sessionId, nextTarget);
    else this.activeTargets.delete(sessionId);
    return nextTarget;
  }

  async executeCommand(sessionKey: string, value: unknown, signal?: AbortSignal): Promise<unknown> {
    const command = parseCommand(
      value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>), sessionKey }
        : null,
    );
    if (!command) throw new Error('Invalid browser command.');
    try {
      return await this.execute(command, signal);
    } catch (error) {
      throw new Error(sanitizeErrorForModel(error));
    }
  }

  private listLiveTabs(sessionId: string): RegisteredTab[] {
    const tabs = this.tabsBySession.get(sessionId);
    if (!tabs?.size) return [];
    for (const [targetId, tab] of tabs) {
      if (this.isRegisteredGuestAvailable(tab)) continue;
      this.discardTabRuntime(tab);
      tabs.delete(targetId);
    }
    if (!tabs.size) {
      this.tabsBySession.delete(sessionId);
      this.activeTargets.delete(sessionId);
      this.labelsBySession.delete(sessionId);
      return [];
    }
    return [...tabs.values()];
  }

  private resolveTab(sessionId: string, targetReference?: string): RegisteredTab | null {
    const tabs = this.listLiveTabs(sessionId);
    if (!tabs.length) return null;
    const reference = targetReference?.trim();
    if (reference) {
      const labelTarget = this.labelsBySession.get(sessionId)?.get(reference);
      if (labelTarget) return tabs.find(tab => tab.targetId === labelTarget) ?? null;
      const handleTarget = [...(this.tabHandlesBySession.get(sessionId)?.entries() ?? [])].find(
        ([, handle]) => handle === reference,
      )?.[0];
      if (handleTarget) return tabs.find(tab => tab.targetId === handleTarget) ?? null;
      const exact = tabs.find(tab => tab.targetId === reference);
      if (exact) return exact;
      const prefixMatches = tabs.filter(tab => tab.targetId.startsWith(reference));
      return prefixMatches.length === 1 ? prefixMatches[0]! : null;
    }
    const active = this.activeTargets.get(sessionId);
    const resolved = (active ? tabs.find(tab => tab.targetId === active) : null) ?? tabs[0]!;
    this.activeTargets.set(sessionId, resolved.targetId);
    return resolved;
  }

  private async getActiveTab(
    scopeId: string,
    rendererSessionId: string,
    profile: BrowserAgentProfile,
    signal?: AbortSignal,
    options: {
      initialUrl?: string;
      targetId?: string;
      label?: string;
      forceNew?: boolean;
    } = {},
  ): Promise<RegisteredTab> {
    signal?.throwIfAborted();
    await registerBrowserProxySession(session.fromPartition(browserPartitionForProfile(profile)));
    signal?.throwIfAborted();
    const existing = options.forceNew ? null : this.resolveTab(scopeId, options.targetId);
    if (existing) return existing;
    if (options.targetId && !options.forceNew) {
      throw new Error(`Browser tab not found: ${options.targetId}`);
    }
    const pendingNewTabs = this.tabWaiters.get(scopeId)?.size ?? 0;
    if (this.listLiveTabs(scopeId).length + pendingNewTabs >= MAX_BROWSER_TABS) {
      throw new Error(`The embedded browser supports at most ${MAX_BROWSER_TABS} tabs per task.`);
    }

    const requestedTargetId = options.targetId ?? `embedded-${randomUUID()}`;

    return new Promise<RegisteredTab>((resolve, reject) => {
      const existingWaiters = this.tabWaiters.get(scopeId);
      const waiters = existingWaiters ?? new Set();
      const shouldRequestTab = ![...waiters].some(waiter => waiter.targetId === requestedTargetId);
      const waiter = {} as TabWaiter;
      const cleanup = () => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', handleAbort);
        waiters.delete(waiter);
        if (waiters.size === 0) this.tabWaiters.delete(scopeId);
      };
      const handleAbort = () => {
        cleanup();
        reject(new Error('Browser request was cancelled.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        console.warn(
          `[BrowserAgentBridge] Timed out waiting for embedded browser tab (session=${rendererSessionId}, profile=${profile}, registered=${this.tabsBySession.get(scopeId)?.size ?? 0})`,
        );
        reject(new Error('The browser panel is not available for this task.'));
      }, ENSURE_TAB_TIMEOUT_MS);
      waiter.resolve = tab => {
        cleanup();
        resolve(tab);
      };
      waiter.reject = error => {
        cleanup();
        reject(error);
      };
      waiter.timer = timer;
      waiter.targetId = requestedTargetId;
      waiters.add(waiter);
      this.tabWaiters.set(scopeId, waiters);
      signal?.addEventListener('abort', handleAbort, { once: true });
      if (signal?.aborted) {
        handleAbort();
        return;
      }
      if (shouldRequestTab) {
        console.info(
          `[BrowserAgentBridge] Requesting embedded browser tab (session=${rendererSessionId}, profile=${profile}, target=${requestedTargetId}, hasInitialUrl=${Boolean(options.initialUrl)})`,
        );
        this.sendToRenderer(BrowserIpc.AgentEnsureTab, {
          sessionId: rendererSessionId,
          profile,
          targetId: requestedTargetId,
          ...(options.initialUrl ? { url: options.initialUrl } : {}),
          ...(options.label ? { label: options.label } : {}),
        });
      }
    });
  }

  private async execute(command: AgentBrowserCommand, signal?: AbortSignal): Promise<unknown> {
    let cancelled = false;
    let activeGuest: Electron.WebContents | null = null;
    let activeGuestId: number | null = null;
    const operationController = new AbortController();
    const locksInteraction = AGENT_INTERACTION_ACTIONS.has(command.action);
    const nestedRequest =
      command.action === 'act' ? this.readActRequest(command) : asRecord(command.request);
    const nestedKind = typeof nestedRequest?.kind === 'string' ? nestedRequest.kind : undefined;
    const explicitTimeout =
      command.action === 'act' && typeof nestedRequest?.timeoutMs === 'number'
        ? nestedRequest.timeoutMs
        : typeof command.timeoutMs === 'number'
          ? command.timeoutMs
          : undefined;
    const usesLongTimeout =
      [
        'importprofile',
        'screenshot',
        'navigate',
        'emulate',
        'pdf',
        'download',
        'waitfordownload',
        'upload',
        'dialog',
      ].includes(command.action) ||
      (command.action === 'act' && ['batch', 'wait', 'evaluate'].includes(nestedKind ?? ''));
    const requestedTimeoutMs =
      typeof explicitTimeout === 'number' && Number.isInteger(explicitTimeout)
        ? Math.max(1, Math.min(LONG_COMMAND_TIMEOUT_MS, explicitTimeout))
        : usesLongTimeout
          ? LONG_COMMAND_TIMEOUT_MS
          : COMMAND_TIMEOUT_MS;
    const assertActive = (): void => {
      if (cancelled) throw new Error('Browser command timed out.');
      if (
        locksInteraction &&
        activeGuestId !== null &&
        this.userInteractionLocks.has(activeGuestId)
      ) {
        throw new Error('The user is annotating the browser. Retry after they finish.');
      }
    };
    const operation = (async () => {
      const sessionId = normalizeSessionId(command.sessionKey);
      if (!sessionId) throw new Error('This browser tool is only available in desktop tasks.');
      if (command.profile && !isBrowserAgentProfile(command.profile)) {
        throw new Error(`Browser profile not found: ${command.profile}`);
      }

      const profile = (command.profile?.trim() || EMBEDDED_PROFILE) as BrowserAgentProfile;
      if (!this.profiles.has(profile)) throw new Error(`Browser profile not found: ${profile}`);
      const scopeId = browserScopeId(sessionId, profile);

      const describeTab = (tab: RegisteredTab) => {
        const guest = this.resolveRegisteredGuest(tab);
        const label = [...(this.labelsBySession.get(scopeId)?.entries() ?? [])].find(
          ([, targetId]) => targetId === tab.targetId,
        )?.[0];
        const tabId = this.tabHandlesBySession.get(scopeId)?.get(tab.targetId) ?? tab.targetId;
        return {
          suggestedTargetId: label ?? tabId,
          tabId,
          ...(label ? { label } : {}),
          targetId: tab.targetId,
          title: guest.getTitle(),
          url: sanitizeUrlForModel(guest.getURL()),
          type: 'page',
        };
      };
      const tabListResult = () => {
        const tabs = this.listLiveTabs(scopeId).map(describeTab);
        return {
          ok: true,
          profile,
          running: this.startedSessions.has(scopeId),
          tabs,
          tabCount: tabs.length,
        };
      };

      const statusResult = (): Record<string, unknown> => ({
        enabled: true,
        running: this.startedSessions.has(scopeId),
        profile,
        driver: 'existing-session' as const,
        transport: 'cdp' as const,
        cdpReady: this.startedSessions.has(scopeId),
        cdpHttp: false,
        pageReady: this.listLiveTabs(scopeId).length > 0,
        pid: process.pid,
        cdpPort: null,
        cdpUrl: null,
        chosenBrowser: 'electron',
        detectedBrowser: 'electron',
        detectedExecutablePath: process.execPath,
        detectError: null,
        userDataDir: null,
        color: EMBEDDED_PROFILE_COLOR,
        headless: false,
        noSandbox: false,
        executablePath: process.execPath,
        attachOnly: true,
      });

      if (command.action === 'doctor' || command.action === 'status') {
        const tabs = tabListResult();
        const status = statusResult();
        if (command.action === 'status') return { ...status, tabCount: tabs.tabCount };
        return {
          ok: true,
          profile,
          transport: 'cdp' as const,
          checks: [
            {
              id: 'plugin-enabled',
              label: 'Browser plugin',
              status: 'pass',
              summary: 'enabled',
            },
            {
              id: 'profile',
              label: 'Profile',
              status: 'pass',
              summary: `${profile} via cdp`,
            },
            {
              id: 'embedded-page',
              label: 'Embedded browser page',
              status: tabs.tabCount > 0 ? 'pass' : 'info',
              summary:
                tabs.tabCount > 0
                  ? `${tabs.tabCount} live page${tabs.tabCount === 1 ? '' : 's'}`
                  : 'No page is open; the first page will be created lazily.',
            },
          ],
          status,
        };
      }
      if (command.action === 'start') {
        this.startedSessions.add(scopeId);
        return {
          ok: true,
          enabled: true,
          running: true,
          ...statusResult(),
        };
      }
      if (command.action === 'stop') {
        return this.withPanelInteractionLease(
          sessionId,
          profile,
          operationController.signal,
          () => {
            const tabs = this.listLiveTabs(scopeId);
            for (const tab of tabs) {
              this.sendToRenderer(BrowserIpc.AgentCloseTab, {
                sessionId,
                targetId: tab.targetId,
              });
              this.discardTabRuntime(tab);
            }
            this.tabsBySession.delete(scopeId);
            this.activeTargets.delete(scopeId);
            this.labelsBySession.delete(scopeId);
            this.tabHandlesBySession.delete(scopeId);
            this.nextTabHandleBySession.delete(scopeId);
            this.startedSessions.delete(scopeId);
            return { ...statusResult(), running: false };
          },
        );
      }
      if (command.action === 'profiles') {
        return {
          ok: true,
          defaultProfile: EMBEDDED_PROFILE,
          profiles: [...this.profiles].map(profileName => ({
            name: profileName,
            driver: 'existing-session' as const,
            transport: 'cdp' as const,
            cdpPort: null as number | null,
            cdpUrl: null as string | null,
            color: profileName === EMBEDDED_PROFILE ? EMBEDDED_PROFILE_COLOR : '#7c3aed',
            running: this.startedSessions.has(browserScopeId(sessionId, profileName)),
            tabCount: this.listLiveTabs(browserScopeId(sessionId, profileName)).length,
            isDefault: profileName === EMBEDDED_PROFILE,
            isRemote: false,
          })),
          systemProfiles: listChromeImportSources().map(source => ({
            browser: source.browser,
            id: source.profileId ?? source.id,
            name: source.name,
            hasCookies: source.hasCookies === true,
          })),
        };
      }
      if (command.action === 'importprofile') {
        const into = command.into?.trim() || IMPORTED_PROFILE;
        if (!isBrowserAgentProfile(into)) {
          throw new Error(`Browser profile not found: ${command.into}`);
        }
        const performImport = async () => {
          operationController.signal.throwIfAborted();
          const systemProfile = command.systemProfile?.trim() || 'Default';
          const requestedBrowser = command.browser?.trim().toLowerCase() || 'chrome';
          const source = listChromeImportSources().find(
            candidate =>
              candidate.browser === requestedBrowser &&
              (candidate.profileId ?? candidate.id) === systemProfile,
          );
          if (!source) throw new Error('The selected browser profile is unavailable.');
          const confirmation = await dialog.showMessageBox({
            type: 'question',
            buttons: [t('browserAgentImportConfirm'), t('browserAgentImportCancel')],
            defaultId: 1,
            cancelId: 1,
            noLink: true,
            title: t('browserAgentImportTitle'),
            message: t('browserAgentImportMessage', { source: source.name }),
            detail: t('browserAgentImportDetail'),
          });
          operationController.signal.throwIfAborted();
          if (confirmation.response !== 0) throw new Error('Browser profile import was cancelled.');
          this.profiles.add(into);
          recordImportedBrowserProfile(into);
          const imported = await importChromeData(
            {
              sourceId: source.id,
              passwords: false,
              cookies: true,
              history: false,
              approved: true,
              domains: command.domains,
              destinationProfile: into,
            },
            operationController.signal,
          );
          operationController.signal.throwIfAborted();
          if (!imported.success)
            throw new Error(imported.error ?? 'Browser profile import failed.');
          return {
            ok: true,
            systemProfile,
            into,
            browser: source.browser,
            cookies: {
              total:
                (imported.imported?.cookies ?? 0) +
                (imported.skippedAppBound?.cookies ?? 0) +
                (imported.failed?.cookies ?? 0),
              imported: imported.imported?.cookies ?? 0,
              failed: imported.failed?.cookies ?? 0,
              skipped: imported.skippedAppBound?.cookies ?? 0,
            },
            domains: command.domains ?? [],
          };
        };
        return this.withPanelInteractionLease(
          sessionId,
          into,
          operationController.signal,
          performImport,
        );
      }
      if (command.action === 'tabs') return tabListResult();

      if (command.action === 'open') {
        const url = normalizeNavigationUrl(command.targetUrl ?? command.url);
        const label = command.label?.trim();
        if (label && this.labelsBySession.get(scopeId)?.has(label)) {
          throw new Error(`Browser tab label already exists: ${label}`);
        }
        return this.withPanelInteractionLease(
          sessionId,
          profile,
          operationController.signal,
          async () => {
            const tab = await this.getActiveTab(
              scopeId,
              sessionId,
              profile,
              operationController.signal,
              {
                targetId: `embedded-${randomUUID()}`,
                ...(label ? { label } : {}),
                forceNew: true,
              },
            );
            if (label) {
              const labels = this.labelsBySession.get(scopeId) ?? new Map<string, string>();
              labels.set(label, tab.targetId);
              this.labelsBySession.set(scopeId, labels);
            }
            const guest = this.resolveRegisteredGuest(tab);
            activeGuest = guest;
            activeGuestId = tab.webContentsId;
            if (guest.getURL() !== url) await guest.loadURL(url);
            assertActive();
            this.activeTargets.set(scopeId, tab.targetId);
            return { ok: true, ...describeTab(tab) };
          },
        );
      }

      const targetId =
        command.targetId?.trim() ||
        (command.action === 'act' && typeof nestedRequest?.targetId === 'string'
          ? nestedRequest.targetId.trim()
          : undefined);
      if (command.action === 'focus' || command.action === 'close') {
        const tab = this.resolveTab(scopeId, targetId);
        if (!tab)
          throw new Error(targetId ? `Browser tab not found: ${targetId}` : 'No browser tab.');
        if (command.action === 'focus') {
          return this.withPanelInteractionLease(
            sessionId,
            profile,
            operationController.signal,
            () => {
              this.sendToRenderer(BrowserIpc.AgentFocusTab, {
                sessionId,
                targetId: tab.targetId,
              });
              this.activeTargets.set(scopeId, tab.targetId);
              return { ok: true, ...describeTab(tab) };
            },
          );
        }
        return this.withPanelInteractionLease(
          sessionId,
          profile,
          operationController.signal,
          () => {
            this.sendToRenderer(BrowserIpc.AgentCloseTab, { sessionId, targetId: tab.targetId });
            this.discardTabRuntime(tab);
            this.removeRegisteredTab(scopeId, tab.targetId);
            return { ok: true, targetId: tab.targetId };
          },
        );
      }

      let tab = this.resolveTab(scopeId, targetId);
      if (!tab && targetId) throw new Error(`Browser tab not found: ${targetId}`);
      if (!tab && command.action === 'navigate') {
        return this.withPanelInteractionLease(
          sessionId,
          profile,
          operationController.signal,
          async () => {
            const createdTab = await this.getActiveTab(
              scopeId,
              sessionId,
              profile,
              operationController.signal,
            );
            return this.enqueue(createdTab.webContentsId, async () => {
              const guest = this.resolveRegisteredGuest(createdTab);
              activeGuest = guest;
              activeGuestId = createdTab.webContentsId;
              return this.executeOnGuest(
                command,
                createdTab,
                guest,
                assertActive,
                sessionId,
                profile,
                operationController.signal,
              );
            });
          },
        );
      }
      if (!tab) throw new Error('No browser tab is open. Use action=open first.');
      const lockedTabs = this.listLiveTabs(scopeId).filter(candidate =>
        this.userInteractionLocks.has(candidate.webContentsId),
      );
      if (lockedTabs.length && !this.userInteractionLocks.has(tab.webContentsId)) {
        throw new Error('The user is annotating another browser tab. Retry after they finish.');
      }
      if (
        this.userInteractionLocks.has(tab.webContentsId) &&
        !USER_LOCK_READ_ACTIONS.has(command.action)
      ) {
        throw new Error('The user is annotating the browser. Retry after they finish.');
      }
      return this.enqueue(tab.webContentsId, async () => {
        if (cancelled) throw new Error('Browser command timed out.');
        const queuedLockedTabs = this.listLiveTabs(scopeId).filter(candidate =>
          this.userInteractionLocks.has(candidate.webContentsId),
        );
        if (queuedLockedTabs.length && !this.userInteractionLocks.has(tab.webContentsId)) {
          throw new Error('The user is annotating another browser tab. Retry after they finish.');
        }
        if (
          this.userInteractionLocks.has(tab.webContentsId) &&
          !USER_LOCK_READ_ACTIONS.has(command.action)
        ) {
          throw new Error('The user is annotating the browser. Retry after they finish.');
        }
        const guest = this.resolveRegisteredGuest(tab);
        activeGuest = guest;
        activeGuestId = tab.webContentsId;
        const executeOnGuest = () =>
          this.executeOnGuest(
            command,
            tab,
            guest,
            assertActive,
            sessionId,
            profile,
            operationController.signal,
          );
        return locksInteraction
          ? this.withPanelInteractionLease(sessionId, profile, operationController.signal, () => {
              this.sendToRenderer(BrowserIpc.AgentFocusTab, {
                sessionId,
                targetId: tab.targetId,
              });
              return this.withAgentInteractionLease(
                tab,
                sessionId,
                profile,
                operationController.signal,
                executeOnGuest,
              );
            })
          : executeOnGuest();
      });
    })();
    return this.withCommandDeadline(
      operation,
      error => {
        cancelled = true;
        operationController.abort(error);
        const guestDebugger =
          activeGuestId === null ? undefined : this.activeEvaluations.get(activeGuestId);
        if (guestDebugger) {
          void guestDebugger.sendCommand('Runtime.terminateExecution').catch((): void => undefined);
        }
        if (typeof activeGuest?.stop === 'function') activeGuest.stop();
        if (activeGuest) this.snapshots.delete(activeGuest.id);
        return error;
      },
      signal,
      requestedTimeoutMs,
    );
  }

  private withCommandDeadline<T>(
    operation: Promise<T>,
    onCancel: (error: Error) => Error,
    signal?: AbortSignal,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', handleAbort);
        this.pendingCommandRejectors.delete(rejectPending);
        callback();
      };
      const rejectPending = (error: Error) => finish(() => reject(onCancel(error)));
      const handleAbort = () => rejectPending(new Error('Browser request was cancelled.'));
      const timer = setTimeout(
        () => rejectPending(new Error('Browser command timed out.')),
        timeoutMs,
      );
      this.pendingCommandRejectors.add(rejectPending);
      if (signal?.aborted) handleAbort();
      else signal?.addEventListener('abort', handleAbort, { once: true });
      operation.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      );
    });
  }

  private executeInBrowserWorld<T>(guest: Electron.WebContents, code: string): Promise<T> {
    return guest.executeJavaScriptInIsolatedWorld(
      BROWSER_AGENT_WORLD_ID,
      [{ code }],
      false,
    ) as Promise<T>;
  }

  private focusGuestForKeyboardInput(guest: Electron.WebContents): void {
    if (guest.isDestroyed()) throw new Error('The browser tab is no longer available.');
    guest.focus();
  }

  private async executeInDebuggerWorld<T>(
    guestDebugger: Electron.Debugger,
    frameId: string,
    code: string,
  ): Promise<T> {
    const world = (await guestDebugger.sendCommand('Page.createIsolatedWorld', {
      frameId,
      worldName: 'browser-agent-frame',
      grantUniveralAccess: false,
    })) as { executionContextId?: number };
    if (!world.executionContextId) throw new Error('The frame execution context is unavailable.');
    const response = (await guestDebugger.sendCommand('Runtime.evaluate', {
      expression: code,
      contextId: world.executionContextId,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          'Browser frame evaluation failed.',
      );
    }
    return response.result?.value as T;
  }

  private async executeInTargetWorld<T>(
    tab: RegisteredTab,
    guest: Electron.WebContents,
    frameSelector: string,
    code: string,
  ): Promise<T> {
    if (!frameSelector) return this.executeInBrowserWorld<T>(guest, code);
    const guestDebugger = await this.enableDebuggerDomains(tab, guest);
    const { frameId } = await this.resolveBrowserFrameContext(guestDebugger, frameSelector);
    return this.executeInDebuggerWorld<T>(guestDebugger, frameId, code);
  }

  private async resolveBrowserFrameContext(
    guestDebugger: Electron.Debugger,
    frameSelector = '',
    requireDocumentNode = false,
  ): Promise<{ frameId: string; documentNodeId: number; offsetX: number; offsetY: number }> {
    const frameTree = (await guestDebugger.sendCommand('Page.getFrameTree')) as {
      frameTree?: { frame?: { id?: string } };
    };
    const rootFrameId = frameTree.frameTree?.frame?.id;
    if (!rootFrameId) throw new Error('The page execution context is unavailable.');
    if (!frameSelector && !requireDocumentNode) {
      return { frameId: rootFrameId, documentNodeId: 0, offsetX: 0, offsetY: 0 };
    }
    const documentNode = (await guestDebugger.sendCommand('DOM.getDocument', {
      depth: 1,
      pierce: true,
    })) as { root?: { nodeId?: number } };
    const rootNodeId = documentNode.root?.nodeId;
    if (!rootNodeId) throw new Error('The page document is unavailable.');
    if (!frameSelector) {
      return { frameId: rootFrameId, documentNodeId: rootNodeId, offsetX: 0, offsetY: 0 };
    }
    const selectors = frameSelector.split(FRAME_PATH_SEPARATOR).filter(Boolean);
    let currentDocumentNodeId = rootNodeId;
    let currentFrameId = rootFrameId;
    let offsetX = 0;
    let offsetY = 0;
    for (const [index, selector] of selectors.entries()) {
      const frameNode = (await guestDebugger.sendCommand('DOM.querySelector', {
        nodeId: currentDocumentNodeId,
        selector,
      })) as { nodeId?: number };
      if (!frameNode.nodeId) throw new Error('The snapshot frame is no longer available.');
      const described = (await guestDebugger.sendCommand('DOM.describeNode', {
        nodeId: frameNode.nodeId,
        depth: 1,
        pierce: true,
      })) as {
        node?: {
          frameId?: string;
          contentDocument?: { nodeId?: number; frameId?: string };
        };
      };
      const nextFrameId = described.node?.frameId ?? described.node?.contentDocument?.frameId;
      const nextDocumentNodeId = described.node?.contentDocument?.nodeId;
      if (!nextFrameId || (index < selectors.length - 1 && !nextDocumentNodeId)) {
        throw new Error('The snapshot frame is no longer available.');
      }
      const box = (await guestDebugger.sendCommand('DOM.getBoxModel', {
        nodeId: frameNode.nodeId,
      })) as { model?: { content?: number[] } };
      const content = box.model?.content;
      offsetX = Number(content?.[0]) || 0;
      offsetY = Number(content?.[1]) || 0;
      currentFrameId = nextFrameId;
      currentDocumentNodeId = nextDocumentNodeId ?? 0;
    }
    if (requireDocumentNode && !currentDocumentNodeId) {
      throw new Error('The snapshot frame is no longer available.');
    }
    return {
      frameId: currentFrameId,
      documentNodeId: currentDocumentNodeId,
      offsetX,
      offsetY,
    };
  }

  private async resolveTargetFrameOffset(
    tab: RegisteredTab,
    guest: Electron.WebContents,
    frameSelector: string,
  ): Promise<{ x: number; y: number }> {
    if (!frameSelector) return { x: 0, y: 0 };
    const guestDebugger = await this.enableDebuggerDomains(tab, guest);
    const context = await this.resolveBrowserFrameContext(guestDebugger, frameSelector);
    return { x: context.offsetX, y: context.offsetY };
  }

  private async evaluateWithDebugger(
    tab: RegisteredTab,
    guest: Electron.WebContents,
    fn: string,
    timeoutMs: number,
    ref?: {
      expression: string;
      frameSelector: string;
      worldFrameSelector: string;
      aria: boolean;
    },
    assertActive: () => void = () => undefined,
  ): Promise<unknown> {
    const marker = ref ? `browser-agent-evaluate-${randomBytes(12).toString('hex')}` : null;
    if (ref) {
      const marked = await this.executeInTargetWorld<boolean>(
        tab,
        guest,
        ref.worldFrameSelector,
        `(() => {
          const element = ${ref.expression};
          if (!element?.isConnected) return false;
          const autocompleteTokens = (element.getAttribute('autocomplete') || '')
            .toLowerCase()
            .split(/\\s+/)
            .filter(Boolean);
          if (
            element.matches('input[type="password"], input[type="hidden"]') ||
            autocompleteTokens.some(token =>
              ['current-password', 'new-password', 'one-time-code'].includes(token),
            )
          ) return false;
          element.setAttribute('data-browser-agent-evaluate', ${JSON.stringify(marker)});
          return true;
        })()`,
      );
      if (!marked) throw new Error('The element ref is stale. Take a new snapshot.');
    }
    const guestDebugger = await this.enableDebuggerDomains(tab, guest);
    try {
      const { frameId } = await this.resolveBrowserFrameContext(
        guestDebugger,
        ref?.frameSelector ?? '',
      );
      const world = (await guestDebugger.sendCommand('Page.createIsolatedWorld', {
        frameId,
        worldName: 'browser-agent-evaluate',
        grantUniveralAccess: false,
      })) as { executionContextId?: number };
      if (!world.executionContextId) throw new Error('The page execution context is unavailable.');
      const expression = `(async () => {
        const fnSource = ${JSON.stringify(fn)};
        let callable;
        try { callable = (0, eval)('(' + fnSource + ')'); }
        catch { callable = new Function('el', 'return (async () => {' + fnSource + '})()'); }
        if (typeof callable !== 'function') throw new Error('fn must evaluate to a function.');
        const element = ${marker ? `document.querySelector('[data-browser-agent-evaluate="${marker}"]')` : 'undefined'};
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Browser evaluation timed out.')), ${timeoutMs}));
        return await Promise.race([Promise.resolve(callable(element)), timeout]);
      })()`;
      this.activeEvaluations.set(tab.webContentsId, guestDebugger);
      assertActive();
      const response = (await guestDebugger.sendCommand('Runtime.evaluate', {
        expression,
        contextId: world.executionContextId,
        awaitPromise: true,
        returnByValue: true,
        timeout: timeoutMs,
        userGesture: false,
      })) as {
        result?: { value?: unknown; unserializableValue?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      if (response.exceptionDetails) {
        throw new Error(
          response.exceptionDetails.exception?.description ??
            response.exceptionDetails.text ??
            'Browser evaluation failed.',
        );
      }
      return response.result?.value ?? response.result?.unserializableValue ?? null;
    } catch (error) {
      if (/timed out|timeout|execution was terminated/i.test(serializeError(error))) {
        await guestDebugger.sendCommand('Runtime.terminateExecution').catch((): void => undefined);
      }
      throw error;
    } finally {
      if (this.activeEvaluations.get(tab.webContentsId) === guestDebugger) {
        this.activeEvaluations.delete(tab.webContentsId);
      }
      if (marker && !guest.isDestroyed()) {
        await this.executeInTargetWorld(
          tab,
          guest,
          ref?.worldFrameSelector ?? '',
          `(${ref?.expression ?? 'null'})?.removeAttribute('data-browser-agent-evaluate')`,
        ).catch((): void => undefined);
      }
    }
  }

  private resolveRegisteredGuest(tab: RegisteredTab): Electron.WebContents {
    const guest = webContents.fromId(tab.webContentsId);
    if (!guest || !this.isRegisteredGuestAvailable(tab)) {
      throw new Error('The browser tab is no longer available.');
    }
    return guest;
  }

  private isRegisteredGuestAvailable(tab: RegisteredTab): boolean {
    const guest = webContents.fromId(tab.webContentsId);
    // Ownership and webContents type are stable across Electron wrapper
    // recreation; Session object identity is not.
    return Boolean(
      guest &&
      !guest.isDestroyed() &&
      guest.getType() === 'webview' &&
      guest.hostWebContents?.id === tab.ownerId &&
      this.isTrustedRenderer(tab.ownerId),
    );
  }

  private ensureOwnedDebugger(tab: RegisteredTab, guest: Electron.WebContents): Electron.Debugger {
    const guestDebugger = guest.debugger;
    if (guestDebugger.isAttached()) {
      if (!this.ownedDebuggerGuests.has(tab.webContentsId)) {
        throw new Error(
          'Browser diagnostics are unavailable because another debugger is attached to this tab.',
        );
      }
      return guestDebugger;
    }
    guestDebugger.attach('1.3');
    this.ownedDebuggerGuests.add(tab.webContentsId);
    return guestDebugger;
  }

  private async enableDebuggerDomains(
    tab: RegisteredTab,
    guest: Electron.WebContents,
  ): Promise<Electron.Debugger> {
    const guestDebugger = this.ensureOwnedDebugger(tab, guest);
    await Promise.all([
      guestDebugger.sendCommand('Network.enable'),
      guestDebugger.sendCommand('Runtime.enable'),
      guestDebugger.sendCommand('Page.enable'),
    ]);
    return guestDebugger;
  }

  private clearArmedDialog(webContentsId: number): BrowserDialogResponse | undefined {
    const armed = this.armedDialogs.get(webContentsId);
    if (armed) {
      clearTimeout(armed.timer);
      if (armed.leaseOwner === 'persistent') this.releaseAgentInteractionLease(webContentsId);
    }
    this.armedDialogs.delete(webContentsId);
    return armed;
  }

  private blockedDialogResult(webContentsId: number): Record<string, unknown> | null {
    const pending = this.dialogs.get(webContentsId);
    if (!pending) return null;
    return {
      blockedByDialog: true,
      browserState: {
        dialogs: {
          pending: [
            {
              id: pending.id,
              type: pending.type,
              message: pending.message,
              ...(pending.defaultPrompt !== undefined
                ? { defaultPrompt: pending.defaultPrompt }
                : {}),
            },
          ],
          recent: [],
        },
      },
    };
  }

  private clearArmedUpload(
    webContentsId: number,
    guest?: Electron.WebContents,
    error = new Error('The pending file chooser was cancelled.'),
  ): BrowserUploadResponse | undefined {
    const armed = this.armedUploads.get(webContentsId);
    if (armed) {
      clearTimeout(armed.timer);
      armed.reject(error);
      if (armed.leaseOwner === 'persistent') this.releaseAgentInteractionLease(webContentsId);
    }
    this.armedUploads.delete(webContentsId);
    if (guest && !guest.isDestroyed() && guest.debugger.isAttached()) {
      void guest.debugger
        .sendCommand('Page.setInterceptFileChooserDialog', { enabled: false })
        .catch((): void => undefined);
    }
    return armed;
  }

  private async armUpload(
    tab: RegisteredTab,
    guest: Electron.WebContents,
    files: string[],
  ): Promise<{ completion: Promise<void> }> {
    this.clearArmedUpload(tab.webContentsId, guest);
    const guestDebugger = await this.enableDebuggerDomains(tab, guest);
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    void completion.catch((): void => undefined);
    const timer = setTimeout(() => {
      this.clearArmedUpload(
        tab.webContentsId,
        guest,
        new Error('Timed out waiting for a file chooser.'),
      );
    }, ARMED_INTERACTION_TIMEOUT_MS);
    timer.unref?.();
    this.armedUploads.set(tab.webContentsId, {
      files,
      timer,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      leaseOwner: 'current',
    });
    try {
      await guestDebugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    } catch (error) {
      this.clearArmedUpload(tab.webContentsId, guest);
      throw error;
    }
    return { completion };
  }

  private appendLog(
    store: Map<number, BrowserLogEntry[]>,
    id: number,
    entry: BrowserLogEntry,
  ): void {
    const entries = store.get(id) ?? [];
    entries.push(entry);
    if (entries.length > MAX_LOG_ENTRIES) entries.splice(0, entries.length - MAX_LOG_ENTRIES);
    store.set(id, entries);
  }

  private installGuestRuntime(tab: RegisteredTab): void {
    if (this.runtimeCleanup.has(tab.webContentsId)) return;
    const guest = webContents.fromId(tab.webContentsId);
    if (!guest || guest.isDestroyed()) return;

    const handleConsole = (...args: unknown[]) => {
      const details = args.find(
        value => value && typeof value === 'object' && 'message' in (value as object),
      ) as { level?: string; message?: string; sourceId?: string } | undefined;
      const legacyLevel = typeof args[1] === 'number' ? args[1] : undefined;
      const legacyMessage = typeof args[2] === 'string' ? args[2] : undefined;
      const level = details?.level ?? (legacyLevel === 3 ? 'error' : 'log');
      const text = (details?.message ?? legacyMessage ?? '').slice(0, 4_000);
      if (!text) return;
      const entry = {
        timestamp: Date.now(),
        level,
        text,
        ...(details?.sourceId ? { url: sanitizeUrlForModel(details.sourceId) } : {}),
      };
      this.appendLog(this.consoleLogs, tab.webContentsId, entry);
      if (level === 'error') this.appendLog(this.errorLogs, tab.webContentsId, entry);
    };
    const canObserveConsole = typeof guest.on === 'function' && typeof guest.off === 'function';
    if (canObserveConsole) guest.on('console-message', handleConsole);

    const handleDebuggerMessage = (
      _event: Electron.Event,
      method: string,
      params: Record<string, unknown>,
    ) => {
      if (method === 'Network.requestWillBeSent') {
        const request = params.request as Record<string, unknown> | undefined;
        const url = typeof request?.url === 'string' ? sanitizeUrlForModel(request.url) : '';
        const type = typeof params.type === 'string' ? params.type : 'Other';
        const requestId = typeof params.requestId === 'string' ? params.requestId : null;
        if (url) {
          const entry: BrowserLogEntry = {
            timestamp: Date.now(),
            level: type,
            text: url,
            url,
            ...(typeof request?.method === 'string' ? { method: request.method } : {}),
          };
          this.appendLog(this.requestLogs, tab.webContentsId, entry);
          if (requestId) {
            const entries = this.networkRequestsById.get(tab.webContentsId) ?? new Map();
            entries.set(requestId, entry);
            this.networkRequestsById.set(tab.webContentsId, entries);
          }
        }
        if (requestId) {
          const pending = this.pendingNetworkRequests.get(tab.webContentsId) ?? new Set<string>();
          pending.add(requestId);
          this.pendingNetworkRequests.set(tab.webContentsId, pending);
          this.lastNetworkActivity.set(tab.webContentsId, Date.now());
        }
      } else if (method === 'Network.responseReceived') {
        const requestId = typeof params.requestId === 'string' ? params.requestId : null;
        const response = asRecord(params.response);
        const entry = requestId
          ? this.networkRequestsById.get(tab.webContentsId)?.get(requestId)
          : undefined;
        if (entry && typeof response?.status === 'number') {
          entry.status = response.status;
          entry.ok = response.status >= 200 && response.status < 400;
        }
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        const requestId = typeof params.requestId === 'string' ? params.requestId : null;
        if (requestId) this.pendingNetworkRequests.get(tab.webContentsId)?.delete(requestId);
        if (method === 'Network.loadingFailed' && requestId) {
          const entry = this.networkRequestsById.get(tab.webContentsId)?.get(requestId);
          if (entry) {
            entry.ok = false;
            entry.failureText =
              typeof params.errorText === 'string' ? params.errorText.slice(0, 1_000) : 'failed';
          }
        }
        this.lastNetworkActivity.set(tab.webContentsId, Date.now());
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails as Record<string, unknown> | undefined;
        const exception = asRecord(details?.exception);
        const text =
          typeof exception?.description === 'string'
            ? exception.description.slice(0, 4_000)
            : typeof details?.text === 'string'
              ? details.text.slice(0, 4_000)
              : 'Page exception';
        this.appendLog(this.errorLogs, tab.webContentsId, {
          timestamp: Date.now(),
          level: 'error',
          text,
          url: sanitizeUrlForModel(guest.getURL()),
        });
      } else if (method === 'Page.javascriptDialogOpening') {
        const dialogState = {
          id: randomUUID(),
          type: typeof params.type === 'string' ? params.type : 'alert',
          message: typeof params.message === 'string' ? params.message.slice(0, 4_000) : '',
          ...(typeof params.defaultPrompt === 'string'
            ? { defaultPrompt: params.defaultPrompt.slice(0, 4_000) }
            : {}),
        };
        this.dialogs.set(tab.webContentsId, dialogState);
        const armed = this.armedDialogs.get(tab.webContentsId);
        if (armed) {
          clearTimeout(armed.timer);
          this.armedDialogs.delete(tab.webContentsId);
          void guest.debugger
            .sendCommand('Page.handleJavaScriptDialog', {
              accept: armed.accept,
              ...(armed.accept && dialogState.type === 'prompt' && armed.promptText !== undefined
                ? { promptText: armed.promptText }
                : {}),
            })
            .then(() => this.dialogs.delete(tab.webContentsId))
            .catch(error =>
              this.appendLog(this.errorLogs, tab.webContentsId, {
                timestamp: Date.now(),
                level: 'error',
                text: sanitizeErrorForModel(error),
              }),
            )
            .finally(() => {
              if (armed.leaseOwner === 'persistent') {
                this.releaseAgentInteractionLease(tab.webContentsId);
              }
            });
        }
      } else if (method === 'Page.javascriptDialogClosed') {
        this.dialogs.delete(tab.webContentsId);
      } else if (method === 'Page.fileChooserOpened') {
        const armed = this.armedUploads.get(tab.webContentsId);
        if (armed) clearTimeout(armed.timer);
        this.armedUploads.delete(tab.webContentsId);
        if (armed) {
          const backendNodeId = params.backendNodeId;
          void (async () => {
            try {
              if (typeof backendNodeId !== 'number') {
                throw new Error('The file chooser did not identify its input element.');
              }
              const files = this.resolveUploadPaths(tab.sessionId, armed.files);
              await guest.debugger.sendCommand('DOM.setFileInputFiles', {
                files,
                backendNodeId,
              });
              armed.resolve();
            } catch (error) {
              armed.reject(new Error(sanitizeErrorForModel(error)));
            } finally {
              await guest.debugger
                .sendCommand('Page.setInterceptFileChooserDialog', { enabled: false })
                .catch((): void => undefined);
              if (armed.leaseOwner === 'persistent') {
                this.releaseAgentInteractionLease(tab.webContentsId);
              }
            }
          })();
        }
      }
    };

    const handleDebuggerDetach = () => {
      this.ownedDebuggerGuests.delete(tab.webContentsId);
      this.pendingNetworkRequests.delete(tab.webContentsId);
      this.networkRequestsById.delete(tab.webContentsId);
    };
    const handleNavigation = (...args: unknown[]) => {
      const isMainFrame = typeof args[3] === 'boolean' ? args[3] : true;
      if (!isMainFrame) return;
      this.navigationGenerations.set(
        tab.webContentsId,
        (this.navigationGenerations.get(tab.webContentsId) ?? 0) + 1,
      );
      this.snapshots.delete(tab.webContentsId);
      this.ariaRefState.delete(tab.webContentsId);
      this.clearArmedDialog(tab.webContentsId);
      this.clearArmedUpload(tab.webContentsId, guest);
    };
    if (canObserveConsole) guest.on('did-start-navigation', handleNavigation);

    const guestDebugger = guest.debugger;
    guestDebugger.on('detach', handleDebuggerDetach);
    guestDebugger.on('message', handleDebuggerMessage);
    try {
      void this.enableDebuggerDomains(tab, guest).catch((): void => undefined);
    } catch (error) {
      console.warn(
        `[BrowserAgentBridge] Failed to initialize guest diagnostics (guest=${tab.webContentsId}): ${serializeError(error)}`,
      );
    }

    this.runtimeCleanup.set(tab.webContentsId, () => {
      if (canObserveConsole) guest.off('console-message', handleConsole);
      if (canObserveConsole) guest.off('did-start-navigation', handleNavigation);
      try {
        guestDebugger.off('message', handleDebuggerMessage);
        guestDebugger.off('detach', handleDebuggerDetach);
        if (this.ownedDebuggerGuests.has(tab.webContentsId) && guestDebugger.isAttached()) {
          guestDebugger.detach();
        }
      } catch {
        // The guest may already be destroyed.
      } finally {
        this.ownedDebuggerGuests.delete(tab.webContentsId);
      }
    });
  }

  private discardTabRuntime(tab: RegisteredTab): void {
    this.userInteractionLocks.delete(tab.webContentsId);
    cancelBrowserAgentDownloadsForWebContents(tab.webContentsId);
    const activeEvaluation = this.activeEvaluations.get(tab.webContentsId);
    if (activeEvaluation) {
      void activeEvaluation.sendCommand('Runtime.terminateExecution').catch((): void => undefined);
      this.activeEvaluations.delete(tab.webContentsId);
    }
    this.snapshots.delete(tab.webContentsId);
    this.snapshotLabelAnnotations.delete(tab.webContentsId);
    this.snapshotDeltaState.delete(tab.webContentsId);
    this.runtimeCleanup.get(tab.webContentsId)?.();
    this.runtimeCleanup.delete(tab.webContentsId);
    this.consoleLogs.delete(tab.webContentsId);
    this.requestLogs.delete(tab.webContentsId);
    this.errorLogs.delete(tab.webContentsId);
    this.pendingNetworkRequests.delete(tab.webContentsId);
    this.networkRequestsById.delete(tab.webContentsId);
    this.lastNetworkActivity.delete(tab.webContentsId);
    this.navigationGenerations.delete(tab.webContentsId);
    this.ariaRefState.delete(tab.webContentsId);
    this.dialogs.delete(tab.webContentsId);
    this.clearArmedDialog(tab.webContentsId);
    const guest = webContents.fromId(tab.webContentsId) ?? undefined;
    this.clearArmedUpload(tab.webContentsId, guest);
    // Keep an in-flight queue barrier until its operation settles. A session
    // promotion can unregister and immediately re-register the same guest;
    // dropping the barrier here would allow two commands to mutate it at once.
  }

  private async enqueue<T>(webContentsId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.commandQueues.get(webContentsId) ?? Promise.resolve();
    const queued = previous.catch((): void => undefined).then(operation);
    const settled = queued.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.commandQueues.set(webContentsId, settled);
    try {
      return await queued;
    } finally {
      if (this.commandQueues.get(webContentsId) === settled) {
        this.commandQueues.delete(webContentsId);
      }
    }
  }

  private resolveManagedOutputPath(
    sessionId: string,
    requestedPath: string | undefined,
    defaultName: string,
  ): string {
    const workspace = this.getSessionWorkspace(sessionId);
    if (!workspace || !path.isAbsolute(workspace)) {
      throw new Error('The task workspace is unavailable.');
    }
    const workspaceReal = fs.realpathSync(workspace);
    const candidate = requestedPath?.trim()
      ? path.resolve(workspaceReal, requestedPath)
      : path.join(workspaceReal, '.justdo-tasks', 'browser-artifacts', defaultName);
    const lexicalRelative = path.relative(workspaceReal, candidate);
    if (
      lexicalRelative.startsWith('..') ||
      path.isAbsolute(lexicalRelative) ||
      lexicalRelative === ''
    ) {
      throw new Error('The output path must stay inside the task workspace.');
    }
    const parent = path.dirname(candidate);
    const parentReal = this.ensureManagedOutputDirectory(workspaceReal, parent);
    const relativeToWorkspace = path.relative(
      workspaceReal,
      path.join(parentReal, path.basename(candidate)),
    );
    if (
      relativeToWorkspace.startsWith('..') ||
      path.isAbsolute(relativeToWorkspace) ||
      relativeToWorkspace === ''
    ) {
      throw new Error('The output path must stay inside the task workspace.');
    }
    const outputPath = path.join(parentReal, path.basename(candidate));
    if (fs.existsSync(outputPath)) {
      throw new Error('The output path already exists. Choose a new path.');
    }
    return outputPath;
  }

  private ensureManagedOutputDirectory(workspaceReal: string, directory: string): string {
    const lexicalRelative = path.relative(workspaceReal, directory);
    if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) {
      throw new Error('The output path must stay inside the task workspace.');
    }
    const missingSegments: string[] = [];
    let existingAncestor = directory;
    while (!fs.existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw new Error('The output path must stay inside the task workspace.');
      }
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = parent;
    }
    let current = fs.realpathSync(existingAncestor);
    const existingRelative = path.relative(workspaceReal, current);
    if (existingRelative.startsWith('..') || path.isAbsolute(existingRelative)) {
      throw new Error('The output path must stay inside the task workspace.');
    }
    for (const segment of missingSegments) {
      current = path.join(current, segment);
      fs.mkdirSync(current);
      const createdReal = fs.realpathSync(current);
      const createdRelative = path.relative(workspaceReal, createdReal);
      if (createdRelative.startsWith('..') || path.isAbsolute(createdRelative)) {
        throw new Error('The output path must stay inside the task workspace.');
      }
      current = createdReal;
    }
    if (!fs.statSync(current).isDirectory()) {
      throw new Error('The output path parent must be a directory.');
    }
    return current;
  }

  private assertManagedOutputPath(sessionId: string, outputPath: string): void {
    const workspace = this.getSessionWorkspace(sessionId);
    if (!workspace || !path.isAbsolute(workspace)) {
      throw new Error('The task workspace is unavailable.');
    }
    const workspaceReal = fs.realpathSync(workspace);
    const parentReal = fs.realpathSync(path.dirname(outputPath));
    const relative = path.relative(workspaceReal, path.join(parentReal, path.basename(outputPath)));
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
      throw new Error('The output path must stay inside the task workspace.');
    }
    if (fs.existsSync(outputPath)) {
      throw new Error('The output path already exists. Choose a new path.');
    }
  }

  private resolveUploadPaths(sessionId: string, requestedPaths: unknown): string[] {
    if (!Array.isArray(requestedPaths) || requestedPaths.length < 1 || requestedPaths.length > 20) {
      throw new Error('paths required.');
    }
    const workspace = this.getSessionWorkspace(sessionId);
    if (!workspace || !path.isAbsolute(workspace)) {
      throw new Error('The task workspace is unavailable.');
    }
    const workspaceReal = fs.realpathSync(workspace);
    return requestedPaths.map(rawPath => {
      if (typeof rawPath !== 'string' || !rawPath.trim()) throw new Error('Invalid upload path.');
      const resolved = path.resolve(workspaceReal, rawPath);
      const real = fs.realpathSync(resolved);
      const relative = path.relative(workspaceReal, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('Upload files must stay inside the task workspace.');
      }
      if (!fs.statSync(real).isFile())
        throw new Error('Upload paths must reference regular files.');
      return real;
    });
  }

  private readActRequest(command: AgentBrowserCommand): Record<string, unknown> {
    const flattenedKey = LEGACY_FLATTENED_ACT_KEYS.find(key => Object.hasOwn(command, key));
    if (flattenedKey) {
      throw new Error(
        `action=act does not accept top-level ${flattenedKey}; put every act parameter inside request.`,
      );
    }
    const nested = asRecord(command.request);
    if (!nested || typeof nested.kind !== 'string') {
      throw new Error('action=act requires request.kind and nested act parameters.');
    }
    return { ...nested };
  }

  private captureAriaSnapshot(
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    snapshotId: string,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
    return browserAgentSnapshots.captureAriaSnapshot.call(
      this.browserAgentSnapshotsContext,
      command,
      tab,
      guest,
      snapshotId,
    );
  }

  private captureSnapshot(
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
  ): Promise<{
    content: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    >;
    details: Record<string, unknown>;
  }> {
    return browserAgentSnapshots.captureSnapshot.call(
      this.browserAgentSnapshotsContext,
      command,
      tab,
      guest,
    );
  }

  private normalizeScreenshotData(
    data: string,
    imageType: 'png' | 'jpeg',
  ): { data: string; width: number; height: number } {
    return browserAgentSnapshots.normalizeScreenshotData.call(
      this.browserAgentSnapshotsContext,
      data,
      imageType,
    );
  }

  private captureScreenshot(
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
  ): Promise<Record<string, unknown>> {
    return browserAgentSnapshots.captureScreenshot.call(
      this.browserAgentSnapshotsContext,
      command,
      tab,
      guest,
    );
  }

  private assertCurrentRef(
    request: Record<string, unknown>,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    key = 'ref',
  ): {
    ref: string;
    index: number;
    snapshotId: string;
    expression: string;
    aria: boolean;
    frameSelector: string;
    worldFrameSelector: string;
  } {
    return browserAgentSnapshots.assertCurrentRef.call(
      this.browserAgentSnapshotsContext,
      request,
      tab,
      guest,
      key,
    );
  }

  private resolveActElement(
    request: Record<string, unknown>,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    refKey = 'ref',
    selectorKey = 'selector',
  ): { expression: string; label: string; frameSelector: string } {
    return browserAgentSnapshots.resolveActElement.call(
      this.browserAgentSnapshotsContext,
      request,
      tab,
      guest,
      refKey,
      selectorKey,
    );
  }

  private waitWhileActive(milliseconds: number, assertActive: () => void): Promise<void> {
    return browserAgentActions.waitWhileActive.call(
      this.browserAgentActionsContext,
      milliseconds,
      assertActive,
    );
  }

  private waitForPossibleNavigation(
    guest: Electron.WebContents,
    beforeGeneration: number,
    beforeUrl = guest.getURL(),
    assertActive: () => void = () => undefined,
  ): Promise<'navigation' | 'closed' | 'dialog' | null> {
    return browserAgentActions.waitForPossibleNavigation.call(
      this.browserAgentActionsContext,
      guest,
      beforeGeneration,
      beforeUrl,
      assertActive,
    );
  }

  private executeAct(
    request: Record<string, unknown>,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    sessionId: string,
    profile: BrowserAgentProfile,
    preserveSnapshot = false,
    assertActive: () => void = () => undefined,
  ): Promise<Record<string, unknown>> {
    return browserAgentActions.executeAct.call(
      this.browserAgentActionsContext,
      request,
      tab,
      guest,
      sessionId,
      profile,
      preserveSnapshot,
      assertActive,
    );
  }

  private setFileInputFiles(
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    files: string[],
    sessionId: string,
    profile: BrowserAgentProfile,
    assertActive: () => void,
  ): Promise<void> {
    return browserAgentActions.setFileInputFiles.call(
      this.browserAgentActionsContext,
      command,
      tab,
      guest,
      files,
      sessionId,
      profile,
      assertActive,
    );
  }

  private executeOnGuest(
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    assertActive: () => void,
    sessionId: string,
    profile: BrowserAgentProfile,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return browserAgentActions.executeOnGuest.call(
      this.browserAgentActionsContext,
      command,
      tab,
      guest,
      assertActive,
      sessionId,
      profile,
      signal,
    );
  }

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly browserAgentSnapshotsContext: BrowserAgentSnapshotsContext =
    createPropertyContext<BrowserAgentSnapshotsContext>({
      enableDebuggerDomains: { get: () => this.enableDebuggerDomains.bind(this) },
      resolveBrowserFrameContext: { get: () => this.resolveBrowserFrameContext.bind(this) },
      ariaRefState: { get: () => this.ariaRefState },
      executeInDebuggerWorld: { get: () => this.executeInDebuggerWorld.bind(this) },
      executeInBrowserWorld: { get: () => this.executeInBrowserWorld.bind(this) },
      snapshots: { get: () => this.snapshots },
      dialogs: { get: () => this.dialogs },
      snapshotLabelAnnotations: { get: () => this.snapshotLabelAnnotations },
      captureAriaSnapshot: { get: () => this.captureAriaSnapshot.bind(this) },
      executeInTargetWorld: { get: () => this.executeInTargetWorld.bind(this) },
      resolveTargetFrameOffset: { get: () => this.resolveTargetFrameOffset.bind(this) },
      snapshotDeltaState: { get: () => this.snapshotDeltaState },
      navigationGenerations: { get: () => this.navigationGenerations },
      captureScreenshot: { get: () => this.captureScreenshot.bind(this) },
      captureSnapshot: { get: () => this.captureSnapshot.bind(this) },
      assertCurrentRef: { get: () => this.assertCurrentRef.bind(this) },
      normalizeScreenshotData: { get: () => this.normalizeScreenshotData.bind(this) },
    });

  // Resolve dependencies at call time so cancellation, session changes, and teardown stay authoritative.
  private readonly browserAgentActionsContext: BrowserAgentActionsContext =
    createPropertyContext<BrowserAgentActionsContext>({
      resolveTab: { get: () => this.resolveTab.bind(this) },
      navigationGenerations: { get: () => this.navigationGenerations },
      executeAct: { get: () => this.executeAct.bind(this) },
      blockedDialogResult: { get: () => this.blockedDialogResult.bind(this) },
      waitForPossibleNavigation: { get: () => this.waitForPossibleNavigation.bind(this) },
      snapshots: { get: () => this.snapshots },
      resolveActElement: { get: () => this.resolveActElement.bind(this) },
      executeInTargetWorld: { get: () => this.executeInTargetWorld.bind(this) },
      resolveTargetFrameOffset: { get: () => this.resolveTargetFrameOffset.bind(this) },
      waitWhileActive: { get: () => this.waitWhileActive.bind(this) },
      focusGuestForKeyboardInput: { get: () => this.focusGuestForKeyboardInput.bind(this) },
      enableDebuggerDomains: { get: () => this.enableDebuggerDomains.bind(this) },
      assertCurrentRef: { get: () => this.assertCurrentRef.bind(this) },
      executeInBrowserWorld: { get: () => this.executeInBrowserWorld.bind(this) },
      evaluateWithDebugger: { get: () => this.evaluateWithDebugger.bind(this) },
      pendingNetworkRequests: { get: () => this.pendingNetworkRequests },
      lastNetworkActivity: { get: () => this.lastNetworkActivity },
      sendToRenderer: { get: () => this.sendToRenderer },
      discardTabRuntime: { get: () => this.discardTabRuntime.bind(this) },
      removeRegisteredTab: { get: () => this.removeRegisteredTab.bind(this) },
      armUpload: { get: () => this.armUpload.bind(this) },
      clearArmedUpload: { get: () => this.clearArmedUpload.bind(this) },
      resolveUploadPaths: { get: () => this.resolveUploadPaths.bind(this) },
      captureSnapshot: { get: () => this.captureSnapshot.bind(this) },
      captureScreenshot: { get: () => this.captureScreenshot.bind(this) },
      consoleLogs: { get: () => this.consoleLogs },
      requestLogs: { get: () => this.requestLogs },
      errorLogs: { get: () => this.errorLogs },
      resolveManagedOutputPath: { get: () => this.resolveManagedOutputPath.bind(this) },
      assertManagedOutputPath: { get: () => this.assertManagedOutputPath.bind(this) },
      setFileInputFiles: { get: () => this.setFileInputFiles.bind(this) },
      dialogs: { get: () => this.dialogs },
      clearArmedDialog: { get: () => this.clearArmedDialog.bind(this) },
      armedDialogs: { get: () => this.armedDialogs },
      readActRequest: { get: () => this.readActRequest.bind(this) },
    });
}
