import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { parse } from 'acorn';
import type Database from 'better-sqlite3';

import type {
  AppPluginReview,
  AppPluginSnapshot,
} from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import { APP_PLUGIN_ARTIFACT, AppPluginError, AppPluginIpc } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import { resolvePluginDataDirectory } from '../../../../plugins/sdk/app-plugin-sdk/data';
import type {
  AppExecutionSessionQuery,
  AppMainModule,
  AppResolvedExecutionSession,
} from '../../../../plugins/sdk/app-plugin-sdk/main';
import {
  appNativeHandshakeMethod,
  isAppNativeHandshake,
  parseAppNativeHandshakeReceipt,
} from '../../../../plugins/sdk/app-plugin-sdk/native-contract';
import {
  APP_NATIVE_PROFILE,
  verifyAppNativeModule,
} from '../../../../plugins/sdk/app-plugin-sdk/native-profile';
import { redactLogText } from '../../../shared/diagnostics/redaction';
import { t } from '../../core/i18n';
import { runWithoutPluginRequestBinding } from '../../engine/gateway/pluginRequestBinding';
import { preparePluginDataDirectory } from '../data/pluginDataService';
import {
  type ApplyExtensionPackageMutation,
  ExtensionPackageLifecycleMode,
  type ExtensionPackageMutationTarget,
} from '../extensions/extensionPackageLifecycle';
import { inspectAppArtifact, retainAppArtifact, type VerifiedAppArtifact } from './artifact';
import { appAssetPath, appPresentationAssetPath, publishAppAssets } from './assets';
import type { AppHostResources, AppNativeState } from './registry';
import { AppPluginRegistry } from './registry';
import { AppSessionParticipants } from './sessionParticipants';

export interface AppCandidate {
  root: string;
  nativeRoot: string;
  trusted: boolean;
  bundled?: boolean;
  cleanupOnly?: boolean;
  /** Native inventory presence also survives an unapproved or broken app companion. */
  nativePluginId?: string;
  /** Catalog or prior trust receipt identity, retained even when package files are absent. */
  identity?: { id: string; hash: string };
  retainedReceipt?: { id: string; hash: string };
  /** Complete readable metadata explicitly declares no app companion. */
  nativeOnly?: boolean;
  inventoryUnresolved?: boolean;
}
interface Selected {
  artifact: VerifiedAppArtifact;
  nativeRoot: string;
  nativeHash: string;
  nativeEntry: string;
  cleanupOnly: boolean;
}
const NATIVE_HANDSHAKE_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 5000, 5000] as const;
const NATIVE_PLUGIN_CHANGE_EVENTS = new Set(['plugins.changed', 'config.changed']);
export interface AppManagerDependencies {
  retentionRoot: string;
  resources: AppHostResources;
  readDesiredEnabled(id: string): boolean | undefined;
  candidates(): Promise<AppCandidate[]>;
  broadcast(channel: string, value: unknown): void;
  isGatewayConnected(): boolean;
  getGatewayProcessId?(): number | null;
  getGatewayProcessGeneration?(): number;
  loadModule?(url: string): Promise<AppMainModule>;
  approveArtifact?(id: string, hash: string): Promise<void>;
  withStoppedGateway?<T>(operation: () => Promise<T>): Promise<T>;
}

/** Trusted companions use a public, caller-authenticated Native registration handshake. */
export class AppPluginManager {
  private readonly bundledPolicies = new Map<
    string,
    { defaultEnabled: boolean; userToggleable: boolean }
  >();
  getBundledNativePolicies(): Record<string, { defaultEnabled: boolean; userToggleable: boolean }> {
    return this.disposed ? {} : Object.fromEntries(this.bundledPolicies);
  }
  isAppCompanion(id: string): boolean {
    const selected = this.selected.get(id);
    return !this.disposed && selected !== undefined && !selected.cleanupOnly;
  }
  private readonly states = new Map<string, AppNativeState>();
  readonly registry = new AppPluginRegistry(
    id => this.states.get(id) ?? { enabled: false, confirmed: false },
    event => this.dependencies.broadcast(AppPluginIpc.Event, event),
  );
  readonly sessions = new AppSessionParticipants(this.registry);
  private readonly bootstrap = new AppPluginRegistry(() => ({
    enabled: false,
    confirmed: true,
  }));
  private readonly retained = new Map<string, { id: string; registry?: AppPluginRegistry }>();
  private readonly retainedCandidates: AppCandidate[] = [];
  private discoveryComplete = false;
  private readonly currentOwnerIds = new Set<string>();
  private readonly absentNativeOwners = new Set<string>();
  private readonly presentNativeOwners = new Set<string>();
  private readonly removedOwnerIds = new Set<string>();
  private readonly selected = new Map<string, Selected>();
  private readonly assets = new Map<string, { epoch: string; release(): void }>();
  private readonly presentationAssets = new Map<string, { hash: string; release(): void }>();
  private refreshLane: Promise<void> = Promise.resolve();
  private mutationLane: Promise<unknown> = Promise.resolve();
  private ready = false;
  private executionSourceInventoryComplete = false;
  private readonly executionSessionListeners = new Set<(metadataOnly?: boolean) => void>();
  private publishedExecutionSourceState?: string;
  private readonly knownAppExecutionOwners = new Set<string>();
  private disposed = false;
  private readonly pendingRetained = new Set<AppPluginRegistry>();
  private databaseInitialized = false;
  private activated = false;
  private packageMutation = false;
  private stoppedPackageMutation?: object;
  private packageRepairPending = false;
  private invalidation = 0;
  private readonly nativeIdentities = new Map<string, string>();
  private readonly pendingDatabaseIds = new Set<string>();
  private nativeRefreshTimer?: ReturnType<typeof setTimeout>;
  private nativeRefreshAttempt = 0;
  private releaseNativeEvents?: () => void;
  private readonly reviews = new Map<
    string,
    { candidate: AppCandidate; review: AppPluginReview; issued: number }
  >();
  constructor(private readonly dependencies: AppManagerDependencies) {
    this.registry.subscribe(() => this.publish());
    this.registry.onExecutionSessionsChanged(() => this.notifyExecutionSessionsChanged(true));
  }

  async prepare(): Promise<void> {
    this.assertAvailable();
    if (this.ready) return;
    let discovered = true;
    let candidates: AppCandidate[];
    try {
      candidates = await this.dependencies.candidates();
      this.captureCurrentOwners(candidates);
    } catch {
      discovered = false;
      this.registry.blockResourceAdmission();
      candidates = [];
    }
    const knownCandidates = this.rememberExecutionSourceCandidates(candidates);
    this.assertAvailable();
    for (const candidate of candidates.filter(item => item.trusted && item.bundled)) {
      try {
        const { artifact } = await inspectCandidateArtifact(candidate);
        this.rememberExecutionSourceCandidate(
          candidate,
          artifact.manifest.nativePluginId,
          knownCandidates,
        );
        this.assertAvailable();
        if (artifact.manifest.native)
          this.bundledPolicies.set(artifact.manifest.nativePluginId, artifact.manifest.native);
      } catch {
        this.registry.blockResourceAdmission(candidate.identity?.id);
      }
    }
    // Bootstrap old trusted inventories independently of an installed rewrite's schemas.
    for (const candidate of candidates.filter(
      item => item.trusted && item.cleanupOnly && !item.retainedReceipt,
    )) {
      try {
        const artifact = await retainAppArtifact(
          await inspectCandidateArtifact(candidate),
          this.dependencies.retentionRoot,
        );
        this.rememberExecutionSourceCandidate(
          candidate,
          artifact.artifact.manifest.nativePluginId,
          knownCandidates,
        );
        this.assertAvailable();
        await this.bootstrap.prepare(
          artifact,
          this.dependencies.resources,
          this.dependencies.loadModule,
          {
            cleanupOnly: true,
          },
        );
      } catch {
        this.registry.blockResourceAdmission(candidate.identity?.id);
        console.warn('[AppPlugins] Retained resource inventory could not be prepared');
      }
    }
    this.assertAvailable();
    this.retainedCandidates.push(
      ...candidates.filter(item => item.trusted && item.retainedReceipt),
    );
    for (const candidate of candidates) {
      if (candidate.retainedReceipt) continue;
      let ownerId = candidate.identity?.id;
      try {
        // A native capability consent is not app trust. External artifacts require separate approval.
        if (!candidate.trusted) continue;
        const inspected = await inspectCandidateArtifact(candidate);
        ownerId = inspected.artifact.manifest.id;
        this.captureCurrentOwner(candidate, ownerId);
        this.rememberExecutionSourceCandidate(
          candidate,
          inspected.artifact.manifest.nativePluginId,
          knownCandidates,
        );
        const artifact = await retainAppArtifact(inspected, this.dependencies.retentionRoot);
        const selected = await selectCandidateArtifact(candidate, artifact);
        const id = artifact.artifact.manifest.nativePluginId;
        if (this.selected.has(id)) continue;
        this.assertAvailable();
        await this.prepareSelectedData(selected, !!this.dependencies.getGatewayProcessId &&
          this.dependencies.getGatewayProcessId() === null && !this.dependencies.isGatewayConnected());
        this.assertAvailable();
        await this.registry.prepare(artifact, this.dependencies.resources, this.dependencies.loadModule, {
          cleanupOnly: selected.cleanupOnly,
        });
        this.assertAvailable();
        this.selected.set(id, selected);
        this.registry.restoreResourceAdmission(ownerId);
      } catch {
        if (candidate.trusted) this.registry.blockResourceAdmission(ownerId);
        // Never load a fallback version under an installed replacement's native identity.
        console.warn('[AppPlugins] Candidate could not be admitted');
      }
    }
    this.assertAvailable();
    this.executionSourceInventoryComplete =
      discovered &&
      candidates.every(
        candidate => knownCandidates.has(candidate) && candidate.inventoryUnresolved !== true,
      );
    this.ready = true;
    this.publish();
  }
  initializeDatabase(database: Database.Database): void {
    this.assertAvailable();
    this.bootstrap.initializeDatabase(database);
    this.registry.inheritResourceAdmissionFailures(this.bootstrap);
    this.registry.retainCleanupOwners(this.bootstrap);
    this.registry.initializeDatabase(database);
    this.databaseInitialized = true;
    this.removeAbsentOwners();
    this.publish();
  }
  async activate(): Promise<void> {
    this.assertAvailable();
    if (!this.releaseNativeEvents && this.dependencies.resources.onNativeEvent) {
      this.releaseNativeEvents = this.dependencies.resources.onNativeEvent(event => {
        if (!NATIVE_PLUGIN_CHANGE_EVENTS.has(event.event)) return;
        this.nativeRefreshAttempt = 0;
        void this.refresh().catch(() => this.withdrawNativeProof());
      });
    }
    this.registry.activate();
    this.activated = true;
    this.bootstrap.activate();
    this.registry.retainCleanupOwners(this.bootstrap);
    this.removeAbsentOwners();
    const retained = new Map(
      this.retainedCandidates.splice(0).map(candidate => [candidate.retainedReceipt!.hash, candidate]),
    );
    // Bundled artifacts have journal trust receipts even when no external approval was needed.
    for (const owner of this.registry.resourceOwners()) {
      if (!isOwnerReceipt(owner.ownerId, owner.artifactHash)) {
        this.registry.blockResourceAdmission();
        continue;
      }
      if (!retained.has(owner.artifactHash))
        retained.set(owner.artifactHash, {
          root: path.join(this.dependencies.retentionRoot, owner.ownerId, owner.artifactHash),
          nativeRoot: '',
          trusted: true,
          cleanupOnly: true,
          retainedReceipt: { id: owner.ownerId, hash: owner.artifactHash },
        });
    }
    for (const candidate of retained.values()) {
      const receipt = candidate.retainedReceipt!;
      if (
        this.removedOwnerIds.has(receipt.id) ||
        !this.registry.hasReferencedOwner(receipt.id, receipt.hash) ||
        this.registry.snapshot().some(item => item.hash === receipt.hash)
      )
        continue;
      const registry = new AppPluginRegistry(() => ({ enabled: false, confirmed: true }));
      this.pendingRetained.add(registry);
      try {
        const artifact = await inspectAppArtifact(candidate.root);
        this.assertAvailable();
        if (artifact.artifact.hash !== receipt.hash || artifact.artifact.manifest.id !== receipt.id)
          throw new Error('Retained trust receipt mismatch');
        await registry.prepare(
          artifact,
          this.dependencies.resources,
          this.dependencies.loadModule,
          {
            cleanupOnly: true,
          },
        );
        this.assertAvailable();
        registry.initializeDatabase(this.dependencies.resources.getDatabase(), {
          skipSchemas: true,
          skipInventory: true,
        });
        registry.activate();
        this.retained.set(receipt.hash, { id: receipt.id, registry });
        this.registry.retainCleanupOwners(registry);
        this.registry.restoreResourceAdmission(receipt.id);
      } catch {
        registry.dispose();
        if (!this.disposed) this.registry.blockResourceAdmission(receipt.id);
      } finally {
        this.pendingRetained.delete(registry);
      }
    }
    this.publish();
  }

  snapshot(): AppPluginSnapshot[] {
    if (this.disposed) return [];
    return this.registry.snapshot().map(snapshot => {
      const selected = [...this.selected.values()].find(
        item => item.artifact.artifact.manifest.id === snapshot.id,
      );
      const presentationEntry =
        !this.packageRepairPending &&
        selected &&
        !selected.cleanupOnly &&
        selected.artifact.artifact.hash === snapshot.hash &&
        selected.artifact.artifact.manifest.entries.presentation;
      const display = presentationEntry
        ? { presentationEntry: `/${appPresentationAssetPath(snapshot.hash, presentationEntry)}` }
        : {};
      const ownership =
        selected && !selected.cleanupOnly && selected.artifact.artifact.hash === snapshot.hash
          ? { installed: true as const }
          : {};
      return snapshot.state === 'active' &&
        selected &&
        selected.artifact.artifact.hash === snapshot.hash
        ? {
            ...snapshot,
            ...display,
            ...ownership,
            browserEntry: `/${appAssetPath(snapshot.hash, snapshot.epoch, selected.artifact.artifact.manifest.entries.browser)}`,
            ...(selected.artifact.artifact.files['browser.css']
              ? {
                  browserStyle: `/${appAssetPath(snapshot.hash, snapshot.epoch, 'browser.css')}`,
                }
              : {}),
          }
        : { ...snapshot, ...display, ...ownership };
    });
  }
  async resolveExecutionSession(
    query: AppExecutionSessionQuery,
  ): Promise<AppResolvedExecutionSession | null> {
    if (this.disposed) return null;
    const resolved = await this.registry.resolveExecutionSession(query);
    if (
      !resolved ||
      this.disposed ||
      !this.registry
        .snapshot()
        .some(
          item =>
            item.id === resolved.pluginId &&
            item.epoch === resolved.epoch &&
            item.state === 'active',
        )
    )
      return null;
    if (
      resolved.ownerSessionId &&
      (!this.dependencies.resources.getSessions().getSession(resolved.ownerSessionId) ||
        this.sessions.isDeleting(resolved.ownerSessionId))
    )
      return null;
    return resolved;
  }
  onExecutionSessionsChanged(listener: (metadataOnly?: boolean) => void): () => void {
    this.executionSessionListeners.add(listener);
    return () => {
      this.executionSessionListeners.delete(listener);
    };
  }
  /** The caller must already carry a current Native V2 execution identity. */
  isNativeOnlyExecutionSource(nativePluginId: string): boolean {
    return (
      typeof nativePluginId === 'string' &&
      nativePluginId.length > 0 &&
      nativePluginId.length <= 128 &&
      nativePluginId.trim() === nativePluginId &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(nativePluginId) &&
      this.ready &&
      this.activated &&
      this.databaseInitialized &&
      !this.disposed &&
      this.executionSourceInventoryComplete &&
      !this.packageMutation &&
      !this.packageRepairPending &&
      !this.registry.hasUnresolvedInventory() &&
      !this.knownAppExecutionOwners.has(nativePluginId)
    );
  }
  private rememberExecutionSourceCandidates(
    candidates: readonly AppCandidate[],
  ): Set<AppCandidate> {
    const known = new Set<AppCandidate>();
    for (const candidate of candidates) {
      const id = candidate.nativePluginId ?? candidate.identity?.id ?? candidate.retainedReceipt?.id;
      if (typeof id === 'string' && /^[a-z][a-z0-9-]{0,95}$/u.test(id)) {
        if (candidate.nativeOnly !== true) this.knownAppExecutionOwners.add(id);
        known.add(candidate);
      }
    }
    return known;
  }
  private rememberExecutionSourceCandidate(
    candidate: AppCandidate,
    id: string,
    known: Set<AppCandidate>,
  ): void {
    this.knownAppExecutionOwners.add(id);
    if (candidate.nativePluginId !== undefined && candidate.nativePluginId !== id) {
      candidate.inventoryUnresolved = true;
      return;
    }
    known.add(candidate);
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const invalidation = this.invalidation;
    const next = this.refreshLane
      .catch((): void => undefined)
      .then(async () => {
        if (this.disposed || this.packageMutation || this.packageRepairPending) return;
        if (!this.dependencies.isGatewayConnected()) {
          this.withdrawNativeProof();
          return;
        }
        const processGeneration = this.dependencies.getGatewayProcessGeneration?.();
        const handshakes = await Promise.all(
          [...this.selected.keys()].map(async id => {
            if (this.selected.get(id)?.cleanupOnly || this.dependencies.readDesiredEnabled(id) !== true)
              return [id, null] as const;
            const receipt = await runWithoutPluginRequestBinding(() =>
              this.dependencies.resources.requestConnectedGateway<unknown>(
                appNativeHandshakeMethod(id),
                {},
              ),
            ).catch((): null => null);
            return [
              id,
              isAppNativeHandshake(receipt) && receipt.pluginId === id
                ? parseAppNativeHandshakeReceipt(receipt)
                : null,
            ] as const;
          }),
        );
        if (this.disposed || this.packageMutation || invalidation !== this.invalidation) return;
        if (processGeneration !== this.dependencies.getGatewayProcessGeneration?.()) {
          this.withdrawNativeProof();
          return;
        }
        if (!this.dependencies.isGatewayConnected()) {
          this.withdrawNativeProof();
          return;
        }
        const receipts = new Map(handshakes);
        let awaitingNative = false;
        for (const [id, selected] of this.selected) {
          if (selected.cleanupOnly) {
            this.states.set(id, { enabled: false, confirmed: true,
              configurationEnabled: this.dependencies.readDesiredEnabled(id) });
            continue;
          }
          const receipt = receipts.get(id);
          let sourceMatches = false;
          try {
            const expected = realpathSync(path.join(selected.nativeRoot, selected.nativeEntry));
            const actual = receipt?.nativeEntry;
            // Source receipts are captured at registration. New package bytes are adopted
            // only inside a confirmed Gateway stop, never from a live directory change.
            sourceMatches =
              actual !== undefined &&
              realpathSync(actual) === expected &&
              receipt?.sourceSha256 === selected.nativeHash &&
              createHash('sha256').update(readFileSync(expected)).digest('hex') ===
                selected.nativeHash;
          } catch {
            sourceMatches = false;
          }
          const desired = this.dependencies.readDesiredEnabled(id);
          const validOwner =
            !!receipt &&
            (!this.dependencies.getGatewayProcessId ||
              receipt.processId === this.dependencies.getGatewayProcessId());
          if (desired === true && !validOwner) awaitingNative = true;
          const identity = validOwner
            ? `${processGeneration ?? ''}:${receipt.processId}:${receipt.registrationId}:${JSON.stringify(receipt.gatewayMethods)}`
            : '';
          if (identity !== (this.nativeIdentities.get(id) ?? '')) this.registry.retireEpoch(id);
          this.nativeIdentities.set(id, identity);
          this.states.set(id, {
            enabled: desired === true && validOwner && sourceMatches,
            configurationEnabled: desired,
            ...(validOwner && receipt
              ? {
                  binding: Object.freeze({
                    pluginId: id,
                    processId: receipt.processId,
                    registrationId: receipt.registrationId,
                    gatewayMethods: receipt.gatewayMethods,
                  }),
                }
              : {}),
            confirmed: desired !== undefined && (!desired || (validOwner && sourceMatches)),
          });
        }
        this.registry.refresh();
        if (awaitingNative) this.scheduleNativeRefresh();
        else this.clearNativeRefresh();
      });
    this.refreshLane = next;
    return next;
  }

  async invoke(input: unknown): Promise<unknown> {
    this.assertAvailable();
    await this.refresh();
    this.assertAvailable();
    return this.registry.invoke(input);
  }
  async review(id: string): Promise<AppPluginReview | null> {
    this.assertAvailable();
    if (!/^[a-z][a-z0-9-]{0,95}$/u.test(id)) return null;
    for (const candidate of await this.dependencies.candidates()) {
      if (candidate.retainedReceipt || candidate.cleanupOnly) continue;
      const artifact = await inspectAppArtifact(candidate.root).catch((): null => null);
      if (artifact?.artifact.manifest.nativePluginId !== id) continue;
      this.assertAvailable();
      const review: AppPluginReview = {
        id,
        version: artifact.artifact.manifest.version,
        hash: artifact.artifact.hash,
        capabilities: artifact.artifact.manifest.capabilities,
        token: randomUUID(),
        approved: candidate.trusted,
        restartRequired:
          !this.selected.has(id) ||
          this.selected.get(id)?.artifact.artifact.hash !== artifact.artifact.hash,
      };
      this.reviews.set(id, { candidate, review, issued: Date.now() });
      return review;
    }
    return null;
  }
  async approve(input: {
    id: string;
    hash: string;
    token: string;
  }): Promise<{ success: boolean; restartRequired?: boolean }> {
    this.assertAvailable();
    const pending = this.reviews.get(input?.id);
    this.reviews.delete(input?.id);
    if (
      !pending ||
      input.token !== pending.review.token ||
      input.hash !== pending.review.hash ||
      Date.now() - pending.issued > 10 * 60 * 1000 ||
      !this.dependencies.approveArtifact
    )
      return { success: false };
    const current = await inspectAppArtifact(pending.candidate.root).catch((): null => null);
    if (!current || current.artifact.hash !== input.hash) return { success: false };
    try {
      await readNativeBinding(current, pending.candidate.nativeRoot, true);
    } catch {
      return { success: false };
    }
    await this.mutatePackage(async () => {
      const checked = await inspectAppArtifact(pending.candidate.root);
      if (checked.artifact.hash !== input.hash) throw new Error('appPluginInvalidRequest');
      await readNativeBinding(checked, pending.candidate.nativeRoot, true);
      await retainAppArtifact(checked, this.dependencies.retentionRoot);
      this.assertAvailable();
      await this.dependencies.approveArtifact!(input.id, input.hash);
    });
    return { success: true };
  }
  /** A confirmed installation may trust only its exact companion inside the existing cold owner. */
  async approveInstalledPackage(input: {
    nativePluginId: string;
    installPath: string;
  }): Promise<void> {
    const owner = this.stoppedPackageMutation;
    const generation = this.dependencies.getGatewayProcessGeneration?.();
    const assertOwner = () => {
      this.assertAvailable();
      if (!owner || owner !== this.stoppedPackageMutation || !this.packageMutation ||
          this.dependencies.isGatewayConnected() || this.dependencies.getGatewayProcessId?.() != null ||
          generation !== this.dependencies.getGatewayProcessGeneration?.())
        throw new Error(t('extensionInstallMutationUnavailable'));
    };
    const identityMismatch = () => new Error(t('extensionAppCodeIdentityMismatch'));
    assertOwner();
    const nativePluginId = input?.nativePluginId;
    const installPath = input?.installPath;
    if (typeof nativePluginId !== 'string' || !nativePluginId.trim() || nativePluginId.length > 512 ||
        typeof installPath !== 'string' || !path.isAbsolute(installPath))
      throw identityMismatch();
    const nativeRoot = path.resolve(installPath);
    const appRoot = path.join(nativeRoot, 'app');
    const samePath = (left: string, right: string): boolean => {
      const normalize = (value: string) => process.platform === 'win32'
        ? path.resolve(value).toLowerCase() : path.resolve(value);
      return normalize(left) === normalize(right);
    };
    const inspectInstalled = async (expectedHash?: string): Promise<VerifiedAppArtifact | null> => {
      assertOwner();
      let indexStats: ReturnType<typeof lstatSync>;
      try { indexStats = lstatSync(path.join(appRoot, APP_PLUGIN_ARTIFACT)); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
          return null;
        throw error;
      }
      if (!indexStats.isFile() || indexStats.isSymbolicLink()) throw identityMismatch();
      const candidates = await this.dependencies.candidates();
      assertOwner();
      const installed = candidates.filter(candidate =>
        !candidate.bundled && !candidate.cleanupOnly && !candidate.retainedReceipt &&
        candidate.nativePluginId === nativePluginId,
      );
      if (installed.length !== 1 || !samePath(installed[0].nativeRoot, nativeRoot) ||
          !samePath(installed[0].root, appRoot))
        throw identityMismatch();
      const appStats = lstatSync(appRoot);
      if (realpathSync(nativeRoot) !== nativeRoot || !lstatSync(nativeRoot).isDirectory() ||
          !appStats.isDirectory() || appStats.isSymbolicLink() || realpathSync(appRoot) !== appRoot)
        throw identityMismatch();
      const identity = installed[0].identity && { ...installed[0].identity };
      const artifact = await inspectAppArtifact(appRoot);
      assertOwner();
      if (artifact.root !== appRoot || artifact.artifact.manifest.id !== nativePluginId ||
          artifact.artifact.manifest.nativePluginId !== nativePluginId ||
          (identity && (!isOwnerReceipt(identity.id, identity.hash) ||
            identity.id !== nativePluginId || identity.hash !== artifact.artifact.hash)) ||
          (expectedHash !== undefined && artifact.artifact.hash !== expectedHash))
        throw identityMismatch();
      try { await readNativeBinding(artifact, nativeRoot, true); }
      catch { throw identityMismatch(); }
      assertOwner();
      return artifact;
    };
    const artifact = await inspectInstalled();
    if (!artifact) return;
    const approveArtifact = this.dependencies.approveArtifact;
    if (!approveArtifact) throw new Error(t('extensionAppCodeTrustUnavailable'));
    await retainAppArtifact(artifact, this.dependencies.retentionRoot);
    assertOwner();
    if (!await inspectInstalled(artifact.artifact.hash)) throw identityMismatch();
    await approveArtifact(nativePluginId, artifact.artifact.hash);
    assertOwner();
    if (!await inspectInstalled(artifact.artifact.hash)) throw identityMismatch();
  }
  async mutate<T>(id: string, enabled: boolean, operation: () => Promise<T>): Promise<T> {
    const selected = this.selected.get(id);
    if (enabled && !selected) {
      for (const candidate of await this.dependencies.candidates()) {
        if (candidate.retainedReceipt) continue;
        const artifact = await inspectAppArtifact(candidate.root).catch((): null => null);
        if (artifact?.artifact.manifest.nativePluginId === id)
          throw new Error(AppPluginError.ApprovalRequired);
      }
    }
    if (enabled && selected?.cleanupOnly) throw new Error(AppPluginError.ApprovalRequired);
    return this.serialMutation(() =>
      this.registry.mutate(selected?.artifact.artifact.manifest.id ?? id, enabled, async () => {
        this.assertAvailable();
        try {
          return await operation();
        } finally {
          this.assertAvailable();
          const nativeId = selected?.artifact.artifact.manifest.nativePluginId ?? id;
          this.states.set(nativeId, {
            ...(this.states.get(nativeId) ?? { enabled: false, confirmed: false }),
            configurationEnabled: this.dependencies.readDesiredEnabled(nativeId),
          });
          await this.refresh();
        }
      }),
    );
  }
  /** Reserve Main before the extension queue; only App package changes retire its lifetimes. */
  async withExtensionPackageMutation<T>(
    operation: (apply: ApplyExtensionPackageMutation) => Promise<T>,
  ): Promise<T> {
    return this.serialMutation(() => this.sessions.withPackageMutation(async () => {
      let active = true;
      let used = false;
      let pending: Promise<unknown> | undefined;
      const assertReservation = () => {
        this.assertAvailable();
        if (!active) throw new Error(t('extensionInstallMutationUnavailable'));
      };
      const apply: ApplyExtensionPackageMutation = (target, write) => {
        const result = (async () => {
          assertReservation();
          if (used) throw new Error(t('extensionInstallMutationUnavailable'));
          used = true;
          this.assertExtensionMutationTarget(target);
          // Restore unresolved App inventory before choosing a new path. An
          // ordinary package can stay hot on the repaired connection.
          if (this.packageRepairPending) await this.repairPackageInventory();
          assertReservation();
          const stopped = await this.requiresStoppedExtensionMutation(target);
          assertReservation();
          return stopped
            ? this.mutatePackageExclusive(() => write(ExtensionPackageLifecycleMode.STOPPED), assertReservation)
            : write(ExtensionPackageLifecycleMode.HOT);
        })();
        pending ??= result;
        // Retain ownership even if an internal caller accidentally detaches apply.
        void result.catch((): void => undefined);
        return result;
      };
      try {
        return await operation(apply);
      } finally {
        active = false;
        await pending?.catch((): void => undefined);
      }
    }));
  }
  private assertExtensionMutationTarget(target: ExtensionPackageMutationTarget): void {
    if (!target || !Array.isArray(target.nativePluginIds) || !target.nativePluginIds.length ||
        target.nativePluginIds.length > 4096 || target.nativePluginIds.some(id =>
          typeof id !== 'string' || !id.trim() || id !== id.trim() || id.length > 512) ||
        [target.installPath, target.sourceDirectory].some(directory =>
          directory !== undefined && (typeof directory !== 'string' || !path.isAbsolute(directory))) ||
        (target.requireStopped !== undefined && target.requireStopped !== true))
      throw new Error(AppPluginError.Invalid);
  }
  private async requiresStoppedExtensionMutation(target: ExtensionPackageMutationTarget): Promise<boolean> {
    if (target.requireStopped === true) return true;
    const ids = new Set(target.nativePluginIds);
    const installPath = target.installPath;
    const matchesPath = (nativeRoot: string) =>
      !!installPath && !!nativeRoot && samePackagePath(installPath, nativeRoot);
    if ([target.sourceDirectory, installPath].some(directory =>
      directory !== undefined && hasAppCompanionMarker(directory))) return true;
    for (const [nativeId, selected] of this.selected) {
      if (ids.has(nativeId) || ids.has(selected.artifact.artifact.manifest.id) ||
          matchesPath(selected.nativeRoot)) return true;
    }
    if ([...this.registry.resourceOwners(), ...this.bootstrap.resourceOwners()]
      .some(owner => ids.has(owner.ownerId)) ||
        [...this.retained.values()].some(owner => ids.has(owner.id))) return true;
    const candidates = await this.dependencies.candidates();
    this.assertAvailable();
    for (const candidate of candidates) {
      if (!ids.has(candidate.nativePluginId ?? '') && !ids.has(candidate.identity?.id ?? '') &&
          !ids.has(candidate.retainedReceipt?.id ?? '') && !matchesPath(candidate.nativeRoot)) continue;
      if (candidate.identity || candidate.retainedReceipt || candidate.bundled ||
          candidate.cleanupOnly || candidate.trusted ||
          (candidate.nativeRoot && hasAppCompanionMarker(candidate.nativeRoot))) return true;
    }
    // Offline writes need the startup fence, even when no App companion is involved.
    // An alive disconnected process stays on the hot path, whose native admission
    // must fail before send rather than stopping a Gateway solely for reconnect.
    return !this.dependencies.isGatewayConnected() && this.dependencies.getGatewayProcessId?.() == null;
  }
  /** Package changes stop only Gateway; retained Main/UI companions are reconciled in this process. */
  async mutatePackage<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialMutation(() =>
      this.sessions.withPackageMutation(() => this.mutatePackageExclusive(operation)),
    );
  }
  private async mutatePackageExclusive<T>(operation: () => Promise<T>, assertCurrent = () => this.assertAvailable()): Promise<T> {
    assertCurrent();
    if (this.packageRepairPending) await this.repairPackageInventory();
    await this.registry.preparePackageMutation();
    assertCurrent();
    const ids = this.registry.snapshot().map(item => item.id);
    const veto = new Error('appPluginCleanupUnresolved');
    let rejectedBeforeMutation = false;
    let entered = false;
    const wasRunning = this.dependencies.isGatewayConnected() ||
      this.dependencies.getGatewayProcessId?.() != null;
    const guarded = async () => {
      try {
        await this.registry.preparePackageMutation();
      } catch {
        throw veto;
      }
      assertCurrent();
      if (!this.dependencies.withStoppedGateway) throw veto;
      return this.dependencies.withStoppedGateway(async () => {
        assertCurrent();
        entered = true;
        this.packageMutation = true;
        this.stoppedPackageMutation = {};
        try {
          this.invalidate();
          let outcome: { value: T } | { error: unknown };
          try { outcome = { value: await operation() }; }
          catch (error) { outcome = { error }; }
          // The operation may have committed before returning an error. Read the
          // actual inventory once; never retry an unknown package mutation.
          try {
            await this.reconcileStoppedPackages();
          } catch (error) {
            this.packageRepairPending = true;
            this.registry.setPackageAdmissionBlocked(true);
            throw error;
          }
          if ('error' in outcome) throw outcome.error;
          return outcome.value;
        } finally {
          this.stoppedPackageMutation = undefined;
        }
      });
    };
    const next = (index: number): Promise<T> =>
      index === ids.length
        ? guarded()
        : this.registry.mutate(ids[index], false, () => next(index + 1), {
            preflightVeto: veto,
            packageMutation: true,
          });
    let outcome: { value: T } | { error: unknown };
    try {
      outcome = { value: await next(0) };
    } catch (error) {
      outcome = { error };
      if (error === veto) {
        rejectedBeforeMutation = true;
        this.registry.restorePackageAdmissions(ids);
        await this.refresh();
      }
    } finally {
      this.packageMutation = false;
      if (!rejectedBeforeMutation) this.invalidate();
    }
    if (!rejectedBeforeMutation && entered && wasRunning) {
      // The stop lease has been released. Reconnect the existing application,
      // then admit only the new registration's independently checked receipt.
      try {
        await this.dependencies.resources.ensureReady();
        await this.refresh();
      } catch (recoveryError) {
        if (!('error' in outcome)) throw recoveryError;
        // A pending recovery must not hide an earlier reconciliation failure.
        throw new AggregateError(
          [outcome.error, recoveryError],
          [outcome.error, recoveryError]
            .map(error => error instanceof Error ? error.message : AppPluginError.Unavailable)
            .join('\n'),
        );
      }
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }
  /** Retry only read/admission recovery, never the package operation with an unknown result. */
  private async repairPackageInventory(): Promise<void> {
    if (!this.dependencies.withStoppedGateway) throw new Error('appPluginCleanupUnresolved');
    await this.registry.preparePackageMutation({ allowPackageAdmissionBlocked: true });
    const wasRunning =
      this.dependencies.isGatewayConnected() || this.dependencies.getGatewayProcessId?.() != null;
    let entered = false;
    try {
      this.packageMutation = true;
      this.invalidate();
      await this.dependencies.withStoppedGateway(async () => {
        entered = true;
        await this.reconcileStoppedPackages();
        this.packageRepairPending = false;
        this.registry.setPackageAdmissionBlocked(false);
      });
    } finally {
      this.packageMutation = false;
      this.invalidate();
      if (entered && wasRunning && !this.disposed) {
        await this.dependencies.resources.ensureReady();
        await this.refresh();
      }
    }
  }
  private async reconcileStoppedPackages(): Promise<void> {
    this.executionSourceInventoryComplete = false;
    const candidates = await this.dependencies.candidates();
    const knownCandidates = this.rememberExecutionSourceCandidates(candidates);
    this.assertAvailable();
    this.captureCurrentOwners(candidates);
    const next = new Map<string, Selected>();
    for (const candidate of candidates) {
      if (!candidate.trusted || candidate.retainedReceipt) continue;
      let ownerId = candidate.identity?.id;
      try {
        const inspected = await inspectCandidateArtifact(candidate);
        ownerId = inspected.artifact.manifest.id;
        this.captureCurrentOwner(candidate, ownerId);
        const artifact = await retainAppArtifact(inspected, this.dependencies.retentionRoot);
        const id = artifact.artifact.manifest.nativePluginId;
        this.rememberExecutionSourceCandidate(candidate, id, knownCandidates);
        if (next.has(id)) continue;
        const selected = await selectCandidateArtifact(candidate, artifact);
        await this.prepareSelectedData(selected, true);
        this.assertAvailable();
        next.set(id, selected);
        this.registry.restoreResourceAdmission(ownerId);
      } catch (error) {
        if (!ownerId) throw error;
        this.registry.blockResourceAdmission(ownerId);
        console.warn('[AppPlugins] Candidate could not be admitted');
      }
    }
    for (const [id, current] of this.selected) {
      const replacement = next.get(id);
      if (
        replacement &&
        replacement.artifact.artifact.hash === current.artifact.artifact.hash &&
        replacement.nativeRoot === current.nativeRoot &&
        replacement.cleanupOnly === current.cleanupOnly
      )
        continue;
      this.registry.retireForReplacement(current.artifact.artifact.manifest.id);
      this.pendingDatabaseIds.delete(current.artifact.artifact.manifest.id);
      this.selected.delete(id);
    }
    for (const [id, selected] of next) {
      if (this.selected.has(id)) continue;
      await this.registry.prepare(
        selected.artifact,
        this.dependencies.resources,
        this.dependencies.loadModule,
        { cleanupOnly: selected.cleanupOnly },
      );
      this.assertAvailable();
      this.selected.set(id, selected);
      this.pendingDatabaseIds.add(selected.artifact.artifact.manifest.id);
      if (this.databaseInitialized) {
        this.registry.initializeDatabase(this.dependencies.resources.getDatabase(), {
          onlyIds: [selected.artifact.artifact.manifest.id],
        });
        this.pendingDatabaseIds.delete(selected.artifact.artifact.manifest.id);
      }
    }
    if (this.databaseInitialized) {
      this.registry.initializeDatabase(this.dependencies.resources.getDatabase(), {
        onlyIds: [...this.pendingDatabaseIds],
      });
      this.pendingDatabaseIds.clear();
    }
    if (this.activated) this.registry.activate();
    if (this.databaseInitialized) this.removeAbsentOwners();
    this.executionSourceInventoryComplete = candidates.every(
      candidate => knownCandidates.has(candidate) && candidate.inventoryUnresolved !== true,
    );
  }
  private async prepareSelectedData(selected: Selected, gatewayStopped: boolean): Promise<void> {
    const manifest = selected.artifact.artifact.manifest;
    if (selected.cleanupOnly || !manifest.data) return;
    const stateDirectory = this.dependencies.resources.getNativeStateDirectory();
    try {
      if (gatewayStopped) {
        await preparePluginDataDirectory(stateDirectory, manifest.nativePluginId, manifest.data);
      } else {
        // A disconnected process is still alive. Only read already prepared data here;
        // creation and legacy migration wait for the normal stopped package lifecycle.
        resolvePluginDataDirectory(stateDirectory, manifest.nativePluginId,
          manifest.data.retention === 'retain' ? { retention: 'retain' } : undefined);
      }
    } catch (error) {
      console.warn('[AppPlugins] Plugin data preparation failed', manifest.nativePluginId,
        redactLogText(error instanceof Error ? error.message : 'Plugin data is unavailable'));
      throw error;
    }
  }
  private captureCurrentOwner(candidate: AppCandidate, id: string): void {
    if (!/^[a-z][a-z0-9-]{0,95}$/u.test(id) || candidate.retainedReceipt) return;
    this.currentOwnerIds.add(id);
    // A shadowed bundled copy is not the installed Native owner.
    if (candidate.cleanupOnly || !candidate.nativeRoot) return;
    try {
      lstatSync(candidate.nativeRoot);
      this.presentNativeOwners.add(id);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        try {
          // Missing or unreadable inventory is unknown; only a readable parent's absent child is removed.
          const entries = readdirSync(path.dirname(candidate.nativeRoot));
          if (!entries.includes(path.basename(candidate.nativeRoot))) this.absentNativeOwners.add(id);
        } catch {
          // Preserve metadata when the entire runtime/extensions root is unavailable.
        }
      }
    }
  }
  private captureCurrentOwners(candidates: readonly AppCandidate[]): void {
    this.discoveryComplete = true;
    this.currentOwnerIds.clear();
    this.absentNativeOwners.clear();
    this.presentNativeOwners.clear();
    this.removedOwnerIds.clear();
    for (const candidate of candidates) {
      const id = candidate.identity?.id ?? candidate.nativePluginId;
      if (id) this.captureCurrentOwner(candidate, id);
    }
  }
  private removeAbsentOwners(): void {
    if (!this.discoveryComplete || !this.databaseInitialized) return;
    const previousOwners = this.registry.resourceOwners();
    for (const owner of previousOwners) {
      if (!isOwnerReceipt(owner.ownerId, owner.artifactHash)) {
        this.registry.blockResourceAdmission();
        continue;
      }
      // Keep prior App provenance fenced even after confirmed uninstall detaches its resources.
      this.knownAppExecutionOwners.add(owner.ownerId);
      if (!this.currentOwnerIds.has(owner.ownerId)) this.removedOwnerIds.add(owner.ownerId);
    }
    for (const id of this.absentNativeOwners)
      if (!this.presentNativeOwners.has(id)) this.removedOwnerIds.add(id);
    for (const id of this.removedOwnerIds) {
      this.registry.removeOwner(id);
      this.bootstrap.removeOwner(id);
      this.registry.restoreResourceAdmission(id);
      for (const [nativeId, selected] of this.selected) {
        if (selected.artifact.artifact.manifest.id !== id) continue;
        this.selected.delete(nativeId);
        this.states.delete(nativeId);
        this.nativeIdentities.delete(nativeId);
        this.pendingDatabaseIds.delete(id);
      }
      for (let index = this.retainedCandidates.length - 1; index >= 0; index--)
        if (this.retainedCandidates[index].retainedReceipt?.id === id)
          this.retainedCandidates.splice(index, 1);
      for (const [hash, owner] of this.retained) {
        if (owner.id !== id) continue;
        owner.registry?.dispose();
        this.retained.delete(hash);
      }
    }
  }
  private async serialMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationLane
      .catch((): undefined => undefined)
      .then(() => {
        this.assertAvailable();
        return operation();
      });
    this.mutationLane = result;
    return result;
  }
  invalidate(): void {
    this.clearNativeRefresh();
    this.invalidation++;
    for (const id of this.selected.keys()) this.registry.retireEpoch(id);
    this.nativeIdentities.clear();
    this.states.clear();
    this.registry.refresh();
  }
  private withdrawNativeProof(): void {
    if (this.disposed) return;
    for (const [id, state] of this.states) {
      this.states.set(id, {
        enabled: false,
        confirmed: false,
        configurationEnabled: state.configurationEnabled,
      });
    }
    this.nativeIdentities.clear();
    this.registry.refresh();
  }
  /** HELLO/readiness may precede config settlement. Retry only the read-only handshake. */
  private scheduleNativeRefresh(): void {
    if (
      this.nativeRefreshTimer ||
      this.disposed ||
      this.packageMutation ||
      this.packageRepairPending ||
      this.nativeRefreshAttempt >= NATIVE_HANDSHAKE_RETRY_DELAYS_MS.length
    )
      return;
    const invalidation = this.invalidation;
    const delay = NATIVE_HANDSHAKE_RETRY_DELAYS_MS[this.nativeRefreshAttempt++];
    this.nativeRefreshTimer = setTimeout(() => {
      this.nativeRefreshTimer = undefined;
      if (this.disposed || invalidation !== this.invalidation) return;
      void this.refresh().catch(() => this.withdrawNativeProof());
    }, delay);
    this.nativeRefreshTimer.unref?.();
  }
  private clearNativeRefresh(): void {
    if (this.nativeRefreshTimer) clearTimeout(this.nativeRefreshTimer);
    this.nativeRefreshTimer = undefined;
    this.nativeRefreshAttempt = 0;
  }
  private assertAvailable(): void {
    if (this.disposed) throw new Error('appPluginRetired');
  }
  private notifyExecutionSessionsChanged(metadataOnly = false): void {
    if (this.disposed) return;
    for (const listener of this.executionSessionListeners) {
      try {
        listener(metadataOnly);
      } catch {
        /* Observers must never change plugin lifecycle admission. */
      }
    }
  }
  private executionSourceState(snapshots: readonly AppPluginSnapshot[]): string {
    return JSON.stringify({
      plugins: snapshots
        .map(({ id, hash, epoch, state }) => ({ id, hash, epoch, state }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      native: [...this.states]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, state]) => ({
          id,
          enabled: state.enabled,
          confirmed: state.confirmed,
          configurationEnabled: state.configurationEnabled ?? null,
          binding: state.binding && {
            pluginId: state.binding.pluginId,
            registrationId: state.binding.registrationId,
            processId: state.binding.processId,
            gatewayMethods: state.binding.gatewayMethods
              .map(({ method, alias }) => ({ method, alias }))
              .sort((left, right) =>
                left.method.localeCompare(right.method) || left.alias.localeCompare(right.alias)),
          },
        })),
      inventory: [
        this.ready,
        this.activated,
        this.databaseInitialized,
        this.executionSourceInventoryComplete,
        this.packageMutation,
        this.packageRepairPending,
        this.registry.hasUnresolvedInventory(),
      ],
      appOwners: [...this.knownAppExecutionOwners].sort(),
    });
  }
  private publish(): void {
    if (this.disposed) return;
    const executionSourceState = this.executionSourceState(this.snapshot());
    if (executionSourceState !== this.publishedExecutionSourceState) {
      // Store before callbacks: observers may synchronously refresh the same inventory.
      this.publishedExecutionSourceState = executionSourceState;
      this.notifyExecutionSessionsChanged();
    }
    const snapshots = this.snapshot();
    for (const [id, asset] of this.assets) {
      if (
        !snapshots.some(
          snapshot =>
            snapshot.id === id && snapshot.state === 'active' && snapshot.epoch === asset.epoch,
        )
      ) {
        asset.release();
        this.assets.delete(id);
      }
    }
    for (const [id, asset] of this.presentationAssets) {
      if (
        !snapshots.some(
          snapshot =>
            snapshot.id === id && snapshot.hash === asset.hash && snapshot.presentationEntry,
        )
      ) {
        asset.release();
        this.presentationAssets.delete(id);
      }
    }
    for (const selected of this.selected.values()) {
      const id = selected.artifact.artifact.manifest.id;
      const snapshot = snapshots.find(item => item.id === id);
      if (snapshot?.presentationEntry && this.presentationAssets.get(id)?.hash !== snapshot.hash) {
        this.presentationAssets.set(id, {
          hash: snapshot.hash,
          release: publishAppAssets(selected.artifact, 'presentation', 'presentation'),
        });
      }
      if (snapshot?.state === 'active') {
        if (this.assets.get(id)?.epoch !== snapshot.epoch) {
          this.assets.get(id)?.release();
          this.assets.set(id, {
            epoch: snapshot.epoch,
            release: publishAppAssets(selected.artifact, snapshot.epoch),
          });
        }
      } else {
        this.assets.get(id)?.release();
        this.assets.delete(id);
      }
    }
    this.dependencies.broadcast(AppPluginIpc.Changed, snapshots);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.executionSessionListeners.clear();
    this.clearNativeRefresh();
    this.releaseNativeEvents?.();
    this.invalidation++;
    this.reviews.clear();
    this.states.clear();
    this.pendingRetained.forEach(registry => registry.dispose());
    this.pendingRetained.clear();
    this.assets.forEach(asset => asset.release());
    this.assets.clear();
    this.presentationAssets.forEach(asset => asset.release());
    this.presentationAssets.clear();
    this.registry.dispose();
    this.bootstrap.dispose();
    this.retained.forEach(item => item.registry?.dispose());
  }
}

const samePackagePath = (left: string, right: string): boolean => {
  const normalize = (value: string) => process.platform === 'win32'
    ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
};

/** Presence, including an invalid marker, requires App lifecycle reconciliation. */
const hasAppCompanionMarker = (nativeRoot: string): boolean => {
  try {
    if (lstatSync(nativeRoot).isSymbolicLink()) return true;
    const appRoot = path.join(nativeRoot, 'app');
    const appStats = lstatSync(appRoot);
    if (appStats.isSymbolicLink()) return true;
    if (!appStats.isDirectory()) return !appStats.isFile();
    lstatSync(path.join(appRoot, APP_PLUGIN_ARTIFACT));
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
};

/** Discovery is data-driven. An installed native owner shadows the shipped companion even if untrusted. */
export const discoverAppCandidates = async (
  bundled: string,
  runtimeRoot: string | null,
  installed: { id: string; installPath?: string }[],
  approved: Readonly<Record<string, string>>,
  retentionRoot?: string,
  history: Readonly<Record<string, readonly string[]>> = {},
): Promise<AppCandidate[]> => {
  const result: AppCandidate[] = [];
  const owned = new Set(installed.map(item => item.id));
  if (retentionRoot)
    for (const [id, hashes] of Object.entries(history)) {
      if (!/^[a-z][a-z0-9-]{0,95}$/u.test(id)) continue;
      for (const hash of hashes)
        if (/^[a-f0-9]{64}$/u.test(hash))
          result.push({
            root: path.join(retentionRoot, id, hash),
            nativeRoot: '',
            trusted: true,
            cleanupOnly: true,
            identity: { id, hash },
            retainedReceipt: { id, hash },
          });
    }
  for (const item of installed) {
    if (!item.installPath) {
      result.push({
        root: '',
        nativeRoot: '',
        trusted: false,
        nativePluginId: item.id,
        inventoryUnresolved: true,
      });
      continue;
    }
    const root = path.join(item.installPath, 'app');
    if (!existsSync(path.join(root, 'app.artifact.json'))) {
      let declared =
        existsSync(path.join(root, 'app.plugin.json')) ||
        existsSync(path.join(item.installPath, 'app.plugin.json'));
      try {
        const metadata: unknown = JSON.parse(
          await readFile(path.join(item.installPath, 'package.json'), 'utf8'),
        );
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
          throw new Error('Invalid Native package metadata');
        declared ||= Boolean((metadata as { app?: unknown }).app);
      } catch {
        declared = true; /* Unreadable metadata cannot prove Native-only ownership. */
      }
      result.push({
        root,
        nativeRoot: item.installPath,
        trusted: false,
        nativePluginId: item.id,
        ...(declared ? { inventoryUnresolved: true } : { nativeOnly: true }),
      });
      continue;
    }
    const artifact = await inspectAppArtifact(root).catch((): null => null);
    result.push({
      root,
      nativeRoot: item.installPath,
      nativePluginId: item.id,
      ...(!artifact || artifact.artifact.manifest.nativePluginId !== item.id
        ? { inventoryUnresolved: true }
        : {}),
      trusted: !!artifact && approved[item.id] === artifact.artifact.hash,
      ...(artifact ? { identity: { id: item.id, hash: artifact.artifact.hash } } : {}),
    });
  }
  const catalog: unknown = JSON.parse(await readFile(path.join(bundled, 'catalog.json'), 'utf8'));
  if (!Array.isArray(catalog) || catalog.some(entry =>
    !entry || typeof entry !== 'object' || typeof entry.id !== 'string' ||
    typeof entry.hash !== 'string' || !isOwnerReceipt(entry.id, entry.hash)) ||
    new Set(catalog.map(entry => entry.id)).size !== catalog.length)
    throw new Error('Invalid app plugin catalog');
  // The managed `current` runtime may be a directory junction. Pin its target
  // once, while retaining strict link checks inside each native plugin package.
  const nativeRuntimeRoot = runtimeRoot && existsSync(runtimeRoot) ? realpathSync(runtimeRoot) : null;
  for (const entry of catalog) {
    result.push({
      root: path.join(bundled, entry.id, entry.hash),
      nativePluginId: entry.id,
      nativeRoot: nativeRuntimeRoot ? path.join(nativeRuntimeRoot, 'dist/extensions', entry.id) : '',
      trusted: true,
      bundled: true,
      cleanupOnly: owned.has(entry.id),
      identity: { id: entry.id, hash: entry.hash },
    });
  }
  return result;
};

const isOwnerReceipt = (id: string, hash: string): boolean =>
  /^[a-z][a-z0-9-]{0,95}$/u.test(id) && /^[a-f0-9]{64}$/u.test(hash);

async function inspectCandidateArtifact(candidate: AppCandidate): Promise<VerifiedAppArtifact> {
  const artifact = await inspectAppArtifact(candidate.root);
  if (candidate.identity &&
      (!isOwnerReceipt(candidate.identity.id, candidate.identity.hash) ||
        artifact.artifact.manifest.id !== candidate.identity.id ||
        artifact.artifact.manifest.nativePluginId !== candidate.identity.id ||
        artifact.artifact.hash !== candidate.identity.hash))
    throw new Error('App candidate trust receipt mismatch');
  return artifact;
}

async function selectCandidateArtifact(
  candidate: AppCandidate,
  artifact: VerifiedAppArtifact,
): Promise<Selected> {
  const binding = await readNativeBinding(artifact, candidate.nativeRoot, false);
  let cleanupOnly = candidate.cleanupOnly === true || !candidate.nativeRoot;
  if (!cleanupOnly) {
    try {
      await readNativeBinding(artifact, candidate.nativeRoot, true);
    } catch {
      // Trusted Main bytes can still inventory and clean old metadata without Native business.
      cleanupOnly = true;
    }
  }
  return { artifact, nativeRoot: path.resolve(candidate.nativeRoot), nativeHash: binding.sha256,
    nativeEntry: binding.entry, cleanupOnly };
}

async function readNativeBinding(
  artifact: VerifiedAppArtifact,
  nativeRoot: string,
  verifyNative: boolean,
) {
  const binding = JSON.parse(
    await readFile(path.join(artifact.root, 'native.binding.json'), 'utf8'),
  ) as { entry: string; sha256: string; profile: string };
  if (
    binding.entry !== 'index.js' ||
    !/^[a-f0-9]{64}$/u.test(binding.sha256) ||
    binding.profile !== APP_NATIVE_PROFILE
  )
    throw new Error('Invalid app native binding');
  if (verifyNative) {
    const entry = path.resolve(nativeRoot, binding.entry);
    if (realpathSync(entry) !== entry) throw new Error('Native entry must not be a link');
    const bytes = await readFile(entry);
    if (createHash('sha256').update(bytes).digest('hex') !== binding.sha256)
      throw new Error('Native source differs from its app companion');
    verifyAppNativeModule(bytes.toString('utf8'), parse, isBuiltin);
  }
  return binding;
}
