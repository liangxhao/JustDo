import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { parse } from 'acorn';
import type Database from 'better-sqlite3';

import type {
  AppPluginReview,
  AppPluginSnapshot,
} from '../../../../packages/app-plugin-sdk/contracts';
import { AppPluginError, AppPluginIpc } from '../../../../packages/app-plugin-sdk/contracts';
import type { AppMainModule } from '../../../../packages/app-plugin-sdk/main';
import {
  appNativeHandshakeMethod,
  isAppNativeHandshake,
  parseAppNativeHandshakeReceipt,
} from '../../../../packages/app-plugin-sdk/native-contract';
import {
  APP_NATIVE_PROFILE,
  verifyAppNativeModule,
} from '../../../../packages/app-plugin-sdk/native-profile';
import { runWithoutPluginRequestBinding } from '../../engine/gateway/pluginRequestBinding';
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
  retainedReceipt?: { id: string; hash: string };
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
  private readonly selected = new Map<string, Selected>();
  private readonly assets = new Map<string, { epoch: string; release(): void }>();
  private readonly presentationAssets = new Map<string, { hash: string; release(): void }>();
  private refreshLane: Promise<void> = Promise.resolve();
  private mutationLane: Promise<unknown> = Promise.resolve();
  private ready = false;
  private disposed = false;
  private readonly pendingRetained = new Set<AppPluginRegistry>();
  private databaseInitialized = false;
  private activated = false;
  private packageMutation = false;
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
  }

  async prepare(): Promise<void> {
    this.assertAvailable();
    if (this.ready) return;
    const candidates = await this.dependencies.candidates().catch((): AppCandidate[] => {
      this.registry.blockResourceAdmission();
      return [];
    });
    this.assertAvailable();
    for (const candidate of candidates.filter(item => item.trusted && item.bundled)) {
      try {
        const { artifact } = await inspectAppArtifact(candidate.root);
        this.assertAvailable();
        if (artifact.manifest.native)
          this.bundledPolicies.set(artifact.manifest.nativePluginId, artifact.manifest.native);
      } catch {
        this.registry.blockResourceAdmission();
      }
    }
    // Bootstrap old trusted inventories independently of an installed rewrite's schemas.
    for (const candidate of candidates.filter(
      item => item.trusted && item.cleanupOnly && !item.retainedReceipt,
    )) {
      try {
        const artifact = await retainAppArtifact(
          await inspectAppArtifact(candidate.root),
          this.dependencies.retentionRoot,
        );
        this.assertAvailable();
        await this.bootstrap.prepare(artifact, this.dependencies.resources, this.dependencies.loadModule, {
          cleanupOnly: true,
        });
      } catch {
        this.registry.blockResourceAdmission();
        console.warn('[AppPlugins] Retained resource inventory could not be prepared');
      }
    }
    this.assertAvailable();
    this.retainedCandidates.push(
      ...candidates.filter(item => item.trusted && item.retainedReceipt),
    );
    for (const candidate of candidates) {
      if (candidate.retainedReceipt) continue;
      try {
        // A native capability consent is not app trust. External artifacts require separate approval.
        if (!candidate.trusted) continue;
        const inspected = await inspectAppArtifact(candidate.root);
        const artifact = await retainAppArtifact(inspected, this.dependencies.retentionRoot);
        const binding = await readNativeBinding(
          artifact,
          candidate.nativeRoot,
          candidate.cleanupOnly !== true,
        );
        const id = artifact.artifact.manifest.nativePluginId;
        if (this.selected.has(id)) continue;
        this.assertAvailable();
        await this.registry.prepare(artifact, this.dependencies.resources, this.dependencies.loadModule, {
          cleanupOnly: candidate.cleanupOnly,
        });
        this.assertAvailable();
        this.selected.set(id, {
          artifact,
          nativeRoot: path.resolve(candidate.nativeRoot),
          nativeHash: binding.sha256,
          nativeEntry: binding.entry,
          cleanupOnly: candidate.cleanupOnly === true,
        });
      } catch {
        if (candidate.trusted) this.registry.blockResourceAdmission();
        // Never load a fallback version under an installed replacement's native identity.
        console.warn('[AppPlugins] Candidate could not be admitted');
      }
    }
    this.assertAvailable();
    this.ready = true;
    this.publish();
  }
  initializeDatabase(database: Database.Database): void {
    this.assertAvailable();
    this.bootstrap.initializeDatabase(database);
    if (this.bootstrap.hasUnresolvedInventory()) this.registry.blockResourceAdmission();
    this.registry.retainCleanupOwners(this.bootstrap);
    this.registry.initializeDatabase(database);
    this.databaseInitialized = true;
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
    for (const candidate of this.retainedCandidates.splice(0)) {
      const receipt = candidate.retainedReceipt!;
      if (
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
        await registry.prepare(artifact, this.dependencies.resources, this.dependencies.loadModule, {
          cleanupOnly: true,
        });
        this.assertAvailable();
        registry.initializeDatabase(this.dependencies.resources.getDatabase(), {
          skipSchemas: true,
          skipInventory: true,
        });
        registry.activate();
        this.retained.set(receipt.hash, { id: receipt.id, registry });
        this.registry.retainCleanupOwners(registry);
      } catch {
        registry.dispose();
        if (!this.disposed) this.registry.blockResourceAdmission();
      } finally {
        this.pendingRetained.delete(registry);
      }
    }
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
            if (this.dependencies.readDesiredEnabled(id) !== true) return [id, null] as const;
            const receipt = await runWithoutPluginRequestBinding(() =>
              this.dependencies.resources.requestConnectedGateway<unknown>(
                appNativeHandshakeMethod(id), {},
              ),
            ).catch((): null => null);
            return [id, isAppNativeHandshake(receipt) && receipt.pluginId === id
              ? parseAppNativeHandshakeReceipt(receipt) : null] as const;
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
          const validOwner = !!receipt &&
            (!this.dependencies.getGatewayProcessId ||
              receipt.processId === this.dependencies.getGatewayProcessId());
          if (desired === true && !validOwner) awaitingNative = true;
          const identity = validOwner
            ? `${processGeneration ?? ''}:${receipt.processId}:${receipt.registrationId}:${JSON.stringify(receipt.gatewayMethods)}` : '';
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
            confirmed:
              desired !== undefined &&
              (!desired || (validOwner && sourceMatches)),
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
  /** Package changes stop only Gateway; retained Main/UI companions are reconciled in this process. */
  async mutatePackage<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialMutation(() =>
      this.sessions.withPackageMutation(async () => {
        if (this.packageRepairPending) await this.repairPackageInventory();
        await this.registry.preparePackageMutation();
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
          if (!this.dependencies.withStoppedGateway) throw veto;
          return this.dependencies.withStoppedGateway(async () => {
            this.assertAvailable();
            entered = true;
            this.packageMutation = true;
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
          });
        };
        const next = (index: number): Promise<T> =>
          index === ids.length
            ? guarded()
            : this.registry.mutate(ids[index], false, () => next(index + 1), {
                preflightVeto: veto,
                packageMutation: true,
              });
        try {
          return await next(0);
        } catch (error) {
          if (error === veto) {
            rejectedBeforeMutation = true;
            this.registry.restorePackageAdmissions(ids);
            await this.refresh();
          }
          throw error;
        } finally {
          this.packageMutation = false;
          if (!rejectedBeforeMutation) {
            this.invalidate();
            if (entered && wasRunning) {
              // The stop lease has been released. Reconnect the existing application,
              // then admit only the new registration's independently checked receipt.
              await this.dependencies.resources.ensureReady();
              await this.refresh();
            }
          }
        }
      }),
    );
  }
  /** Retry only read/admission recovery, never the package operation with an unknown result. */
  private async repairPackageInventory(): Promise<void> {
    if (!this.dependencies.withStoppedGateway) throw new Error('appPluginCleanupUnresolved');
    await this.registry.preparePackageMutation({ allowPackageAdmissionBlocked: true });
    const wasRunning = this.dependencies.isGatewayConnected() ||
      this.dependencies.getGatewayProcessId?.() != null;
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
    const candidates = await this.dependencies.candidates();
    this.assertAvailable();
    const next = new Map<string, Selected>();
    for (const candidate of candidates) {
      if (!candidate.trusted || candidate.retainedReceipt) continue;
      const artifact = await retainAppArtifact(
        await inspectAppArtifact(candidate.root), this.dependencies.retentionRoot,
      );
      const id = artifact.artifact.manifest.nativePluginId;
      if (next.has(id)) continue;
      const binding = await readNativeBinding(artifact, candidate.nativeRoot, !candidate.cleanupOnly);
      next.set(id, { artifact, nativeRoot: path.resolve(candidate.nativeRoot),
        nativeHash: binding.sha256, nativeEntry: binding.entry, cleanupOnly: candidate.cleanupOnly === true });
    }
    for (const [id, current] of this.selected) {
      const replacement = next.get(id);
      if (replacement && replacement.artifact.artifact.hash === current.artifact.artifact.hash &&
          replacement.nativeRoot === current.nativeRoot && replacement.cleanupOnly === current.cleanupOnly)
        continue;
      this.registry.retireForReplacement(current.artifact.artifact.manifest.id);
      this.pendingDatabaseIds.delete(current.artifact.artifact.manifest.id);
      this.selected.delete(id);
    }
    for (const [id, selected] of next) {
      if (this.selected.has(id)) continue;
      await this.registry.prepare(selected.artifact, this.dependencies.resources, this.dependencies.loadModule,
        { cleanupOnly: selected.cleanupOnly });
      this.assertAvailable();
      this.selected.set(id, selected);
      this.pendingDatabaseIds.add(selected.artifact.artifact.manifest.id);
      if (this.databaseInitialized) {
        this.registry.initializeDatabase(this.dependencies.resources.getDatabase(),
          { onlyIds: [selected.artifact.artifact.manifest.id] });
        this.pendingDatabaseIds.delete(selected.artifact.artifact.manifest.id);
      }
    }
    if (this.databaseInitialized) {
      this.registry.initializeDatabase(this.dependencies.resources.getDatabase(),
        { onlyIds: [...this.pendingDatabaseIds] });
      this.pendingDatabaseIds.clear();
    }
    if (this.activated) this.registry.activate();
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
    if (this.nativeRefreshTimer || this.disposed || this.packageMutation || this.packageRepairPending ||
        this.nativeRefreshAttempt >= NATIVE_HANDSHAKE_RETRY_DELAYS_MS.length) return;
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
  private publish(): void {
    if (this.disposed) return;
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
            retainedReceipt: { id, hash },
          });
    }
  for (const item of installed) {
    if (!item.installPath) continue;
    const root = path.join(item.installPath, 'app');
    if (!existsSync(path.join(root, 'app.artifact.json'))) continue;
    const artifact = await inspectAppArtifact(root).catch((): null => null);
    if (artifact)
      result.push({
        root,
        nativeRoot: item.installPath,
        trusted: approved[item.id] === artifact.artifact.hash,
      });
  }
  const catalog = JSON.parse(await readFile(path.join(bundled, 'catalog.json'), 'utf8')) as {
    id: string;
    hash: string;
  }[];
  // The managed `current` runtime may be a directory junction. Pin its target
  // once, while retaining strict link checks inside each native plugin package.
  const nativeRuntimeRoot =
    runtimeRoot && existsSync(runtimeRoot) ? realpathSync(runtimeRoot) : runtimeRoot;
  for (const entry of catalog) {
    if (!/^[a-z][a-z0-9-]{0,95}$/u.test(entry.id) || !/^[a-f0-9]{64}$/u.test(entry.hash)) continue;
    result.push({
      root: path.join(bundled, entry.id, entry.hash),
      nativeRoot: path.join(nativeRuntimeRoot ?? '', 'dist/extensions', entry.id),
      trusted: true,
      bundled: true,
      cleanupOnly: owned.has(entry.id),
    });
  }
  return result;
};

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
