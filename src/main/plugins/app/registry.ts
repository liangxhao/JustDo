import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type Database from 'better-sqlite3';

import type { AppSubmission } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import {
  AppPluginError,
  type AppPluginEvent,
  type AppPluginInvocation,
  type AppPluginSnapshot,
  isAppIdentifier,
  isAppWireValue,
} from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import type {
  AppAgent,
  AppMainHost,
  AppMainModule,
  AppMainRegistration,
  AppNativeRuntime,
  AppSessionExecution,
  AppSubmissionParticipant,
} from '../../../../plugins/sdk/app-plugin-sdk/main';
import { isAppNativeBinding } from '../../../../plugins/sdk/app-plugin-sdk/native-contract';
import {
  type PluginRequestBinding,
  runWithoutPluginRequestBinding,
  runWithPluginRequestBinding,
} from '../../engine/gateway/pluginRequestBinding';
import type { VerifiedAppArtifact } from './artifact';
import { createAppDatabasePort } from './databasePort';
import { AppProtectionJournal } from './protectionJournal';

export type AppHostResources = Omit<
  AppMainHost,
  | 'manifest'
  | 'epoch'
  | 'signal'
  | 'isEnabled'
  | 'assertActive'
  | 'onExecutionReceipt'
  | 'publishEvent'
>;
export interface AppNativeState {
  enabled: boolean;
  confirmed: boolean;
  configurationEnabled?: boolean;
  binding?: PluginRequestBinding;
}
interface Instance {
  origin: AppPluginRegistry;
  artifact: VerifiedAppArtifact;
  epoch: string;
  controller: AbortController;
  registration: AppMainRegistration;
  enabled: boolean;
  fenced: boolean;
  activated: boolean;
  blocked: boolean;
  removing?: boolean;
  businessAllowed: boolean;
  databasePort?: Database.Database;
  assertDatabaseEffect?: (write?: boolean) => void;
  businessEpoch?: string;
  pendingMutation?: { binding?: PluginRequestBinding };
  releaseBusiness?: () => void;
  disposed: boolean;
  resourceLeases: number;
  maintenanceTimer?: ReturnType<typeof setInterval>;
  maintenancePending?: Promise<void>;
}
interface CleanupOwner {
  id: string;
  instance: Instance;
  registration: AppMainRegistration;
  owned: boolean;
}

// Keep native ESM import when the Electron TypeScript compiler emits CommonJS.
// The function source is fixed; its argument is a verified retained artifact URL.
const importAppModule = new Function('specifier', 'return import(specifier)') as (
  url: string,
) => Promise<AppMainModule>;

export class AppPluginRegistry {
  private readonly instances = new Map<string, Instance>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private readonly invocation = new AsyncLocalStorage<{
    id: string;
    epoch: string;
    family: 'business' | 'cleanup' | 'schema' | 'receipt';
    schemaLease?: { active: boolean };
    cleanupLease?: { active: boolean };
  }>();
  private readonly preparingIds = new Set<string>();
  private readonly preparingNativeIds = new Set<string>();
  private readonly candidates = new Set<AbortController>();
  private readonly pendingRetirements = new Set<Instance>();
  private readonly mutatingInstances = new Set<Instance>();
  private disposed = false;
  private protection?: AppProtectionJournal;
  private inventoryUnresolved = false;
  private readonly unavailableOwners = new Set<string>();
  private packageAdmissionBlocked = false;
  private readonly cleanupOwners = new Map<string, CleanupOwner>();

  constructor(
    private readonly readNativeState: (id: string) => AppNativeState,
    private readonly publishEvent: (event: AppPluginEvent) => void = () => undefined,
  ) {}
  private isNativeEnabled(id: string): boolean {
    if (this.packageAdmissionBlocked) return false;
    const state = this.readNativeState(id);
    return (
      state.confirmed &&
      state.enabled &&
      isAppNativeBinding(state.binding) &&
      state.binding.pluginId === id
    );
  }

  async prepare(
    artifact: VerifiedAppArtifact,
    resources: AppHostResources,
    load: (url: string) => Promise<AppMainModule> = importAppModule,
    options: { cleanupOnly?: boolean } = {},
  ): Promise<void> {
    const manifest = artifact.artifact.manifest;
    if (this.disposed) throw new Error(AppPluginError.Retired);
    if (
      this.preparingIds.has(manifest.id) ||
      this.preparingNativeIds.has(manifest.nativePluginId) ||
      this.instances.has(manifest.id) ||
      [...this.instances.values()].some(
        instance => instance.artifact.artifact.manifest.nativePluginId === manifest.nativePluginId,
      )
    )
      throw new Error('Duplicate app plugin');
    this.preparingIds.add(manifest.id);
    this.preparingNativeIds.add(manifest.nativePluginId);
    const controller = new AbortController();
    this.candidates.add(controller);
    const epoch = randomUUID();
    const instance: Instance = {
      origin: this,
      artifact,
      epoch,
      controller,
      registration: { commands: [] },
      enabled: false,
      fenced: false,
      activated: false,
      blocked: false,
      businessAllowed: !options.cleanupOnly,
      disposed: false,
      resourceLeases: 0,
    };
    const assertActive = () => {
      const scope = this.invocation.getStore();
      if (
        !scope ||
        scope.family !== 'business' ||
        scope.id !== manifest.id ||
        scope.epoch !== instance.epoch ||
        controller.signal.aborted ||
        !instance.businessAllowed ||
        instance.blocked ||
        instance.fenced ||
        !instance.enabled ||
        !this.isNativeEnabled(manifest.nativePluginId)
      ) {
        throw new Error(AppPluginError.Unavailable);
      }
    };
    const assertRetained = () => {
      if (
        this.disposed ||
        controller.signal.aborted ||
        instance.removing ||
        this.invocation.getStore()?.cleanupLease?.active === false
      )
        throw new Error(AppPluginError.Retired);
    };
    const assertBusinessEffect = () => {
      assertRetained();
      assertActive();
    };
    const assertCleanupEffect = () => {
      assertRetained();
      const scope = this.invocation.getStore();
      if (scope?.id !== manifest.id || !['cleanup', 'business'].includes(scope.family))
        throw new Error(AppPluginError.Unavailable);
      if (scope.family === 'business') assertActive();
    };
    const assertDatabaseEffect = (write = false) => {
      assertRetained();
      const scope = this.invocation.getStore();
      if (scope?.family === 'business') assertActive();
      else if (scope?.family === 'schema' && !scope.schemaLease?.active)
        throw new Error(AppPluginError.Retired);
      else if (
        write &&
        (scope?.id !== manifest.id || !['schema', 'cleanup', 'receipt'].includes(scope.family))
      )
        throw new Error(AppPluginError.Unavailable);
    };
    const assertGatewayEffect = (method: string, params: unknown) => {
      if (this.invocation.getStore()?.family === 'cleanup') {
        assertCleanupEffect();
        if (!instance.registration.cleanupGatewayMethods?.includes(method))
          throw new Error(AppPluginError.Unavailable);
        const predicate = instance.registration.allowCleanupGatewayRequest;
        if (predicate) {
          const lease = { active: true };
          try {
            const allowed = this.invocation.run(
              { ...this.invocation.getStore()!, cleanupLease: lease },
              () =>
                requireSynchronous(
                  Reflect.apply(predicate, instance.registration, [method, params]),
                  'cleanup predicate',
                ),
            );
            if (allowed !== true) throw new Error(AppPluginError.Unavailable);
          } finally {
            lease.active = false;
          }
        }
      } else assertBusinessEffect();
    };
    instance.assertDatabaseEffect = assertDatabaseEffect;
    const databases = new WeakMap<Database.Database, Database.Database>();
    const runtimes = new WeakMap<AppNativeRuntime, AppNativeRuntime>();
    const executions = new WeakMap<AppSessionExecution, AppSessionExecution>();
    type NativeClient = NonNullable<ReturnType<AppNativeRuntime['getGatewayClient']>>;
    const gatewayClients = new WeakMap<NativeClient, NativeClient>();
    const scopedResources: AppHostResources = {
      ...resources,
      getDatabase: () => {
        if (instance.databasePort) return instance.databasePort;
        const database = resources.getDatabase();
        let port = databases.get(database);
        if (!port) {
          port = createAppDatabasePort(database, assertDatabaseEffect);
          databases.set(database, port);
        }
        return port;
      },
      getNativeStateDirectory: () =>
        path.join(resources.getNativeStateDirectory(), manifest.nativePluginId),
      getSessions: () => ({
        getSession: id => resources.getSessions().getSession(id),
        getSessionByNativeKey: key => resources.getSessions().getSessionByNativeKey(key),
        getAgent: id => resources.getSessions().getAgent(id),
        listAgents: () => resources.getSessions().listAgents(),
        getSessionRuns: id => resources.getSessions().getSessionRuns(id),
        getSessionRunByClientTurnId: id => resources.getSessions().getSessionRunByClientTurnId(id),
        getGoalExecutionSnapshot: id => resources.getSessions().getGoalExecutionSnapshot(id),
        listPlanHandoffs: id => resources.getSessions().listPlanHandoffs(id),
        createSession: (...args) => {
          assertBusinessEffect();
          return resources.getSessions().createSession(...args);
        },
        deleteSession: id => {
          assertCleanupEffect();
          resources.getSessions().deleteSession(id);
        },
      }),
      getExecution: () => {
        const execution = resources.getExecution();
        const retained = executions.get(execution);
        if (retained) return retained;
        const assertCurrent = () => {
          if (resources.getExecution() !== execution) throw new Error(AppPluginError.Unavailable);
        };
        const scopedExecution: AppSessionExecution = {
          prepareSession: id => {
            assertBusinessEffect();
            assertCurrent();
            return execution.prepareSession(id);
          },
          getSessionRuntimeStatus: (id, options) => {
            assertCurrent();
            return execution.getSessionRuntimeStatus(id, options);
          },
          stopSession: id => {
            assertCleanupEffect();
            assertCurrent();
            return execution.stopSession(id);
          },
          onSessionDeleted: (...args) => {
            assertCleanupEffect();
            assertCurrent();
            execution.onSessionDeleted(...args);
          },
        };
        executions.set(execution, scopedExecution);
        return scopedExecution;
      },
      requestGateway: (method, params) => {
        assertGatewayEffect(method, params);
        return resources.requestGateway(method, params);
      },
      requestConnectedGateway: (method, params) => {
        assertGatewayEffect(method, params);
        return resources.requestConnectedGateway(method, params);
      },
      ensureReady: () => {
        assertCleanupEffect();
        return resources.ensureReady();
      },
      createAssistant: (input, identity, check) =>
        resources.createAssistant(input, identity, () => {
          assertBusinessEffect();
          check();
        }),
      getRuntime: () => {
        const runtime = resources.getRuntime();
        if (!runtime) return null;
        const retained = runtimes.get(runtime);
        if (retained) return retained;
        const scopedRuntime: AppNativeRuntime = {
          captureGatewayResponseContext: () => {
            const context = runtime.captureGatewayResponseContext();
            if (!context) return null;
            const epoch = instance.epoch;
            return Object.freeze({
              isCurrent: () =>
                !this.disposed &&
                !controller.signal.aborted &&
                instance.epoch === epoch &&
                resources.getRuntime() === runtime &&
                context.isCurrent(),
            });
          },
          getPlanMode: id => runtime.getPlanMode(id),
          getGoalExecution: id => runtime.getGoalExecution(id),
          getSessionKeysForSession: id => runtime.getSessionKeysForSession(id),
          getGatewayClient: () => {
            const client = runtime.getGatewayClient();
            if (!client) return null;
            const retained = gatewayClients.get(client);
            if (retained) return retained;
            const scopedClient: NativeClient = {
              request: (method, params) => {
                assertGatewayEffect(method, params);
                return client.request(method, params);
              },
            };
            gatewayClients.set(client, scopedClient);
            return scopedClient;
          },
        };
        runtimes.set(runtime, scopedRuntime);
        return scopedRuntime;
      },
      onNativeEvent: listener => {
        assertBusinessEffect();
        const epoch = instance.epoch;
        return resources.onNativeEvent(event => {
          isolateObserver(() =>
            this.runBusiness(instance, epoch, () => {
              assertBusinessEffect();
              return listener(event);
            }),
          );
        });
      },
      onSessionStopped: listener =>
        resources.onSessionStopped(id =>
          isolateObserver(() => this.runCleanup(instance, () => listener(id))),
        ),
    };
    try {
      const module = await load(
        pathToFileURL(path.join(artifact.root, manifest.entries.main)).href,
      );
      if (this.disposed || controller.signal.aborted) throw new Error(AppPluginError.Retired);
      if (!module || typeof module.register !== 'function')
        throw new Error('App main registration is missing');
      instance.registration = requireSynchronous(
        module.register({
          ...scopedResources,
          manifest,
          get epoch() {
            return instance.epoch;
          },
          signal: controller.signal,
          publishEvent: (name, payload) => {
            assertBusinessEffect();
            if (!isAppIdentifier(name) || !isAppWireValue(payload))
              throw new Error(AppPluginError.Invalid);
            this.publishEvent({
              id: manifest.id,
              hash: artifact.artifact.hash,
              epoch: instance.epoch,
              name,
              payload,
            });
          },
          onExecutionReceipt: listener =>
            resources.onNativeEvent(event => {
              const receipt = projectExecutionReceipt(event);
              if (receipt && !this.disposed && !controller.signal.aborted) {
                isolateObserver(() =>
                  this.invocation.run(
                    { id: manifest.id, epoch: instance.epoch, family: 'receipt' },
                    () => listener(receipt),
                  ),
                );
              }
            }),
          isEnabled: () =>
            instance.businessAllowed &&
            instance.enabled &&
            !instance.fenced &&
            this.isNativeEnabled(manifest.nativePluginId),
          assertActive,
        }),
        'register',
      );
      if (
        instance.registration.cleanupGatewayMethods &&
        (instance.registration.cleanupGatewayMethods.length > 128 ||
          instance.registration.cleanupGatewayMethods.some(
            method =>
              !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/u.test(method) ||
              [
                'chat.send',
                'sessions.send',
                'sessions.create',
                'agents.create',
                'agents.update',
              ].includes(method),
          ))
      )
        throw new Error('Invalid cleanup capability');
      const policy = instance.registration.nativePolicy;
      if (
        policy &&
        (!isAppWireValue(policy) ||
          [policy.skills, policy.sandboxTools].some(
            ids =>
              ids &&
              (!Array.isArray(ids) ||
                ids.length > 128 ||
                ids.some(id => !/^[a-z][a-z0-9_-]{0,95}$/u.test(id))),
          ))
      )
        throw new Error('Invalid native policy');
      if (instance.registration.resources) {
        const participant = instance.registration.resources;
        const methods = [
          'protectedResources',
          'adoptResources',
          'expandResources',
          'acquireDeletion',
          'isDeleting',
          'isManaged',
          'prepareDelete',
          'deleteManaged',
        ] as const;
        const required = new Set<string>([
          'expandResources',
          'acquireDeletion',
          'isDeleting',
          'isManaged',
          'prepareDelete',
          'deleteManaged',
        ]);
        const wrapped: Record<string, unknown> = {};
        for (const name of methods) {
          const method = participant[name];
          if (method === undefined && !required.has(name)) continue;
          if (typeof method !== 'function') throw new Error('Invalid resource participant');
          wrapped[name] = (...args: unknown[]) =>
            this.runCleanup(instance, () => {
              const result: unknown = Reflect.apply(method, participant, args);
              if (name !== 'acquireDeletion') return result;
              if (typeof result !== 'function') throw new Error('Invalid resource cleanup lease');
              instance.resourceLeases++;
              let active = true;
              return () => {
                if (!active) return;
                active = false;
                try {
                  this.runCleanup(instance, () => Reflect.apply(result, participant, []));
                } finally {
                  instance.resourceLeases--;
                  this.finishPendingRetirement(instance);
                }
              };
            });
        }
        instance.registration.resources = wrapped as unknown as typeof participant;
      }
      if (instance.registration.submission) {
        const participant = instance.registration.submission;
        const wrapped: Record<string, unknown> = {};
        for (const name of [
          'matches',
          'register',
          'markSubmissionStarted',
          'cancel',
          'abortBeforeSend',
          'releaseIfSettled',
        ] as const) {
          const method = participant[name];
          if (typeof method !== 'function') throw new Error('Invalid submission participant');
          wrapped[name] = (...args: unknown[]) =>
            ['cancel', 'abortBeforeSend', 'releaseIfSettled'].includes(name)
              ? this.runCleanup(instance, () => Reflect.apply(method, participant, args))
              : Reflect.apply(method, participant, args);
        }
        instance.registration.submission = wrapped as unknown as typeof participant;
      }
      const commands = instance.registration.commands;
      if (
        instance.registration.maintenance !== undefined &&
        typeof instance.registration.maintenance !== 'function'
      )
        throw new Error('Invalid app maintenance callback');
      if (instance.registration.beforePackageMutation) {
        const operation = instance.registration.beforePackageMutation;
        const owner = instance.registration;
        instance.registration.beforePackageMutation = () =>
          this.runCleanup(instance, () => Reflect.apply(operation, owner, []));
      }
      if (
        !Array.isArray(commands) ||
        new Set(commands.map(command => command.id)).size !== commands.length ||
        commands.some(
          command =>
            !manifest.commands.includes(command.id) || typeof command.invoke !== 'function',
        )
      ) {
        throw new Error('Undeclared app command');
      }
      this.instances.set(manifest.id, instance);
    } catch (error) {
      controller.abort();
      isolateObserver(() => instance.registration.dispose?.());
      throw error;
    } finally {
      this.preparingIds.delete(manifest.id);
      this.preparingNativeIds.delete(manifest.nativePluginId);
      this.candidates.delete(controller);
    }
  }

  initializeDatabase(
    database: Database.Database,
    options: { skipSchemas?: boolean; skipInventory?: boolean; onlyIds?: readonly string[] } = {},
  ): void {
    this.protection = new AppProtectionJournal(database);
    for (const instance of this.instances.values()) {
      if (options.onlyIds && !options.onlyIds.includes(instance.artifact.artifact.manifest.id))
        continue;
      try {
        instance.databasePort = createAppDatabasePort(
          database,
          instance.assertDatabaseEffect ?? (() => undefined),
        );
        for (const schema of options.skipSchemas ? [] : (instance.registration.schemas ?? [])) {
          if (!isAppIdentifier(schema.id)) throw new Error('Invalid app schema');
          const schemaLease = { active: true };
          try {
            database.transaction(() =>
              this.invocation.run(
                {
                  id: instance.artifact.artifact.manifest.id,
                  epoch: instance.epoch,
                  family: 'schema',
                  schemaLease,
                },
                () => {
                  const result: unknown = schema.initialize(instance.databasePort!);
                  if (
                    result &&
                    (typeof result === 'object' || typeof result === 'function') &&
                    'then' in result
                  ) {
                    void Promise.resolve(result).catch((): undefined => undefined);
                    throw new Error('App schemas must initialize synchronously');
                  }
                },
              ),
            )();
          } finally {
            schemaLease.active = false;
          }
        }
      } catch {
        instance.blocked = true;
        instance.fenced = true;
      }
    }
    if (!options.skipInventory) this.refreshProtection();
  }
  hasReferencedOwner(id: string, hash: string): boolean {
    return this.protection?.prior(id, '').some(previous => previous.artifactHash === hash) ?? false;
  }
  refreshProtection(): void {
    if (!this.protection) return;
    for (const instance of this.instances.values()) {
      if (instance.blocked || !instance.registration.resources?.protectedResources) continue;
      try {
        const owner = instance.artifact.artifact.manifest.id;
        const hash = instance.artifact.artifact.hash;
        for (const previous of this.protection.prior(owner, hash)) {
          if (instance.registration.resources.adoptResources?.(previous) === true) {
            this.protection.adopt(owner, previous.artifactHash, hash, previous.resourceIds);
          }
        }
        this.protection.replace(
          instance.artifact.artifact.manifest.id,
          instance.artifact.artifact.hash,
          instance.registration.resources.protectedResources(),
        );
      } catch {
        instance.blocked = true;
        instance.fenced = true;
      }
    }
    this.pruneCleanupOwners();
  }
  assertResourceOwners(ids: readonly string[]): void {
    if (this.inventoryUnresolved || this.packageAdmissionBlocked)
      throw new Error(AppPluginError.Unavailable);
    this.refreshProtection();
    // A failed adoption cannot prove that old resources are safe to delete.
    if (
      [...this.instances.values()].some(
        instance => instance.blocked && instance.registration.resources,
      )
    )
      throw new Error(AppPluginError.Unavailable);
    for (const locator of this.protection?.owners(ids) ?? []) {
      const owner = this.instances.get(locator.ownerId);
      if (
        (!owner ||
          owner.blocked ||
          !owner.registration.resources ||
          owner.artifact.artifact.hash !== locator.artifactHash) &&
        (this.cleanupOwners.get(locator.artifactHash)?.id !== locator.ownerId ||
          !this.cleanupOwners.get(locator.artifactHash)?.registration.resources ||
          this.cleanupOwners.get(locator.artifactHash)?.instance.blocked ||
          this.cleanupOwners.get(locator.artifactHash)?.instance.controller.signal.aborted)
      )
        throw new Error(AppPluginError.Unavailable);
    }
  }
  confirmResourceDeletion(ids: readonly string[]): void {
    this.protection?.confirmDeleted(ids);
    this.pruneCleanupOwners();
  }
  blockResourceAdmission(ownerId?: string): void {
    if (ownerId && isAppIdentifier(ownerId)) this.unavailableOwners.add(ownerId);
    else this.inventoryUnresolved = true;
  }
  restoreResourceAdmission(ownerId: string): void {
    this.unavailableOwners.delete(ownerId);
  }
  /** Confirmed package absence detaches participation; product and native history stay intact. */
  removeOwner(ownerId: string): void {
    const instances = new Set<Instance>();
    const current = this.instances.get(ownerId);
    if (current) instances.add(current);
    for (const owner of this.cleanupOwners.values())
      if (owner.id === ownerId) instances.add(owner.instance);
    // Borrowed cleanup scopes and outstanding leases belong to their original registry.
    for (const instance of instances)
      if (instance.origin !== this) instance.origin.removeOwner(ownerId);
    for (const instance of instances) {
      if (instance.origin !== this) continue;
      instance.businessAllowed = false;
      instance.fenced = true;
      instance.removing = true;
      if (instance.maintenanceTimer) clearInterval(instance.maintenanceTimer);
      instance.maintenanceTimer = undefined;
      isolateObserver(() => instance.releaseBusiness?.());
      instance.releaseBusiness = undefined;
      instance.businessEpoch = undefined;
    }
    // Do not use confirmResourceDeletion: sources may still belong to other plugins.
    this.protection?.removeOwner(ownerId);
    this.instances.delete(ownerId);
    this.unavailableOwners.delete(ownerId);
    for (const [hash, owner] of this.cleanupOwners)
      if (owner.id === ownerId) this.cleanupOwners.delete(hash);
    for (const instance of instances)
      if (instance.origin === this) this.retireCleanupInstance(instance);
    this.changed();
  }
  inheritResourceAdmissionFailures(source: AppPluginRegistry): void {
    if (source.inventoryUnresolved) this.inventoryUnresolved = true;
    for (const ownerId of source.unavailableOwners) this.unavailableOwners.add(ownerId);
  }
  resourceOwners(): { ownerId: string; artifactHash: string }[] {
    return this.protection?.allOwners() ?? [];
  }
  setPackageAdmissionBlocked(blocked: boolean): void {
    this.packageAdmissionBlocked = blocked;
    this.refresh();
  }
  hasUnresolvedInventory(): boolean {
    return (
      this.inventoryUnresolved ||
      this.packageAdmissionBlocked ||
      this.unavailableOwners.size > 0 ||
      [...this.instances.values()].some(instance => instance.blocked)
    );
  }

  activate(): void {
    for (const instance of this.instances.values()) {
      if (!instance.activated && !instance.blocked) {
        try {
          const lease = { active: true };
          try {
            requireSynchronous(
              this.runCleanup(instance, () => instance.registration.activate?.(), lease),
              'activate',
            );
          } finally {
            lease.active = false;
          }
          instance.activated = true;
          this.startMaintenance(instance);
        } catch {
          instance.blocked = true;
          instance.fenced = true;
        }
      }
      this.updateEnabled(instance);
    }
    this.pruneCleanupOwners();
    this.changed();
  }

  refresh(): void {
    for (const instance of this.instances.values()) this.updateEnabled(instance);
    this.changed();
  }
  retireEpoch(nativeId: string): void {
    for (const instance of this.instances.values()) {
      if (instance.artifact.artifact.manifest.nativePluginId === nativeId)
        instance.epoch = randomUUID();
    }
  }

  snapshot(): AppPluginSnapshot[] {
    return [...this.instances.values()].map(instance => ({
      id: instance.artifact.artifact.manifest.id,
      version: instance.artifact.artifact.manifest.version,
      hash: instance.artifact.artifact.hash,
      epoch: instance.epoch,
      commands: [...instance.artifact.artifact.manifest.commands],
      slots: [...instance.artifact.artifact.manifest.slots],
      state: instance.blocked
        ? 'blocked'
        : !instance.businessAllowed ||
            instance.fenced ||
            !instance.enabled ||
            !this.isNativeEnabled(instance.artifact.artifact.manifest.nativePluginId)
          ? 'cleanup'
          : instance.activated
            ? 'active'
            : 'prepared',
    }));
  }

  async invoke(input: unknown): Promise<unknown> {
    if (!isAppWireValue(input) || !input || typeof input !== 'object')
      return { success: false, error: AppPluginError.Invalid };
    const request = input as AppPluginInvocation;
    if (
      !isAppIdentifier(request.id) ||
      !isAppIdentifier(request.command) ||
      typeof request.epoch !== 'string' ||
      !Array.isArray(request.args)
    )
      return { success: false, error: AppPluginError.Invalid };
    const instance = this.instances.get(request.id);
    if (!instance || instance.epoch !== request.epoch || instance.controller.signal.aborted)
      return { success: false, error: AppPluginError.Retired };
    if (
      !instance.businessAllowed ||
      instance.blocked ||
      instance.fenced ||
      !instance.enabled ||
      !instance.activated ||
      !this.isNativeEnabled(instance.artifact.artifact.manifest.nativePluginId)
    ) {
      return { success: false, error: AppPluginError.Unavailable };
    }
    const command = instance.registration.commands.find(
      candidate => candidate.id === request.command,
    );
    if (!command) return { success: false, error: AppPluginError.Invalid };
    let result: unknown;
    try {
      result = await this.runBusiness(instance, request.epoch, () =>
        command.invoke(...request.args),
      );
    } catch {
      return { success: false, error: AppPluginError.Unavailable };
    }
    if (
      instance.epoch !== request.epoch ||
      instance.blocked ||
      instance.fenced ||
      !instance.enabled ||
      instance.controller.signal.aborted ||
      !this.isNativeEnabled(instance.artifact.artifact.manifest.nativePluginId)
    )
      return { success: false, error: AppPluginError.Retired };
    return isAppWireValue(result) ? result : { success: false, error: AppPluginError.Invalid };
  }

  /** Fence before the native mutation; retain the cleanup implementation after disable. */
  async mutate<T>(
    id: string,
    enabled: boolean,
    operation: () => Promise<T>,
    options: { preflightVeto?: Error; packageMutation?: boolean } = {},
  ): Promise<T> {
    const previous = this.lanes.get(id) ?? Promise.resolve();
    const next = previous
      .catch((): void => undefined)
      .then(async () => {
        if (
          this.inventoryUnresolved ||
          this.packageAdmissionBlocked ||
          (!options.packageMutation && this.unavailableOwners.has(id))
        )
          throw new Error('appPluginCleanupUnresolved');
        const instance = this.instances.get(id);
        const previousBinding = instance
          ? this.readNativeState(instance.artifact.artifact.manifest.nativePluginId).binding
          : undefined;
        if (instance) this.mutatingInstances.add(instance);
        let release: (() => void) | undefined;
        if (instance && !enabled) {
          instance.fenced = true;
          instance.epoch = randomUUID();
          this.changed();
        }
        try {
          if (instance && !enabled) {
            try {
              release = await this.runCleanup(instance, () =>
                instance.registration.beforeDisable?.(),
              );
            } catch (error) {
              instance.blocked = true;
              throw error;
            }
          }
          try {
            const result = await operation();
            if (instance && !options.packageMutation) {
              const state = this.readNativeState(
                instance.artifact.artifact.manifest.nativePluginId,
              );
              if (
                (state.confirmed
                  ? state.enabled !== enabled
                  : state.configurationEnabled !== enabled) ||
                (result &&
                  typeof result === 'object' &&
                  'success' in result &&
                  result.success === false)
              )
                instance.pendingMutation = { binding: previousBinding };
            }
            return result;
          } catch (error) {
            // A known package veto proves no native mutation started. It may release
            // this temporary fence, but must preserve any inventory/schema failure.
            if (
              instance &&
              !options.packageMutation &&
              (!options.preflightVeto || error !== options.preflightVeto)
            )
              instance.pendingMutation = { binding: previousBinding };
            throw error;
          }
        } finally {
          try {
            if (release && instance) this.runCleanup(instance, release);
          } finally {
            if (instance) {
              this.mutatingInstances.delete(instance);
              if (this.pendingRetirements.has(instance)) this.finishPendingRetirement(instance);
              else {
                instance.fenced = instance.blocked || instance.pendingMutation !== undefined;
                this.updateEnabled(instance);
              }
            }
            this.changed();
          }
        }
      });
    this.lanes.set(id, next);
    try {
      return await next;
    } finally {
      if (this.lanes.get(id) === next) this.lanes.delete(id);
    }
  }

  projectNativeConfig(agents: AppAgent[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const instance of this.instances.values()) {
      if (instance.blocked || !instance.businessAllowed) continue;
      let configuration: Record<string, unknown> | undefined;
      try {
        configuration = this.invocation.exit(() =>
          requireSynchronous(
            instance.registration.projectNativeConfig?.(agents),
            'config projection',
          ),
        );
      } catch {
        instance.blocked = true;
        instance.fenced = true;
        continue;
      }
      if (configuration !== undefined) {
        if (!isAppWireValue(configuration)) {
          instance.blocked = true;
          instance.fenced = true;
          continue;
        }
        result[instance.artifact.artifact.manifest.nativePluginId] = { config: configuration };
      }
    }
    return result;
  }
  nativePolicy(nativeId?: string): NonNullable<AppMainRegistration['nativePolicy']> {
    const policies = [...this.instances.values()]
      .filter(
        instance =>
          !instance.blocked &&
          instance.businessAllowed &&
          (nativeId === undefined ||
            instance.artifact.artifact.manifest.nativePluginId === nativeId),
      )
      .map(instance => instance.registration.nativePolicy)
      .filter(policy => policy !== undefined);
    return {
      skills: [...new Set(policies.flatMap(policy => policy.skills ?? []))],
      sandboxTools: [...new Set(policies.flatMap(policy => policy.sandboxTools ?? []))],
      surfaces: Object.assign({}, ...policies.map(policy => policy.surfaces ?? {})),
    };
  }

  retainCleanupOwners(source: AppPluginRegistry): void {
    for (const [hash, owner] of source.cleanupOwners)
      this.setCleanupOwner(hash, { ...owner, owned: false });
    for (const instance of source.instances.values())
      this.setCleanupOwner(instance.artifact.artifact.hash, {
        id: instance.artifact.artifact.manifest.id,
        instance,
        registration: { ...instance.registration, commands: [], submission: undefined },
        owned: false,
      });
  }
  /** Replaced code loses business custody; referenced resources retain their cleanup owner. */
  retireForReplacement(id: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.fenced = true;
    instance.businessAllowed = false;
    instance.epoch = randomUUID();
    isolateObserver(() => instance.releaseBusiness?.());
    instance.releaseBusiness = undefined;
    instance.businessEpoch = undefined;
    if (this.hasReferencedOwner(id, instance.artifact.artifact.hash)) {
      this.setCleanupOwner(instance.artifact.artifact.hash, {
        id,
        instance,
        registration: { ...instance.registration, commands: [], submission: undefined },
        owned: true,
      });
    } else {
      // beforeDisable may still own a host cleanup lease. Its finally must run
      // under the old instance before disposal revokes that cleanup authority.
      this.retireCleanupInstance(instance);
    }
    this.instances.delete(id);
    this.changed();
  }
  private isCleanupReady(instance: Instance): boolean {
    return (
      instance.activated &&
      !instance.blocked &&
      !instance.disposed &&
      !instance.controller.signal.aborted &&
      !!instance.registration.resources
    );
  }
  private setCleanupOwner(hash: string, owner: CleanupOwner): void {
    const previous = this.cleanupOwners.get(hash);
    if (previous?.instance === owner.instance) {
      this.cleanupOwners.set(hash, { ...owner, owned: previous.owned || owner.owned });
      return;
    }
    if (
      previous &&
      this.isCleanupReady(previous.instance) &&
      !this.isCleanupReady(owner.instance)
    ) {
      if (owner.owned) this.retireCleanupInstance(owner.instance);
      return;
    }
    this.cleanupOwners.set(hash, owner);
    if (previous?.owned) this.retireCleanupInstance(previous.instance);
  }
  private pruneCleanupOwners(): void {
    if (!this.protection) return;
    for (const [hash, owner] of this.cleanupOwners) {
      if (!owner.owned) continue;
      const current = this.instances.get(owner.id);
      if (
        this.hasReferencedOwner(owner.id, hash) &&
        !(
          current &&
          current !== owner.instance &&
          current.artifact.artifact.hash === hash &&
          this.isCleanupReady(current)
        )
      )
        continue;
      this.cleanupOwners.delete(hash);
      this.retireCleanupInstance(owner.instance);
    }
  }
  private retireCleanupInstance(instance: Instance): void {
    if (this.mutatingInstances.has(instance) || instance.resourceLeases)
      this.pendingRetirements.add(instance);
    else this.disposeInstance(instance);
  }
  private finishPendingRetirement(instance: Instance): void {
    if (
      !this.mutatingInstances.has(instance) &&
      !instance.resourceLeases &&
      this.pendingRetirements.delete(instance)
    )
      this.disposeInstance(instance);
  }
  registrations(): readonly AppMainRegistration[] {
    const retained = [...this.cleanupOwners].flatMap(([hash, owner]) =>
      !owner.instance.blocked &&
      !owner.instance.controller.signal.aborted &&
      ![...this.instances.values()].some(instance => instance.artifact.artifact.hash === hash) &&
      this.protection?.prior(owner.id, '').some(previous => previous.artifactHash === hash)
        ? [owner.registration]
        : [],
    );
    return [...this.instances.values()].map(instance => instance.registration).concat(retained);
  }
  async preparePackageMutation(
    options: { allowPackageAdmissionBlocked?: boolean } = {},
  ): Promise<void> {
    this.refreshProtection();
    if (
      this.inventoryUnresolved ||
      (this.packageAdmissionBlocked && !options.allowPackageAdmissionBlocked) ||
      [...this.instances.values()].some(instance => instance.blocked)
    )
      throw new Error('appPluginCleanupUnresolved');
    for (const locator of this.protection?.allOwners() ?? []) {
      const current = this.instances.get(locator.ownerId);
      if (
        current?.artifact.artifact.hash === locator.artifactHash &&
        !current.blocked &&
        !current.controller.signal.aborted &&
        current.registration.resources
      )
        continue;
      const retained = this.cleanupOwners.get(locator.artifactHash);
      if (
        retained?.id !== locator.ownerId ||
        retained.instance.blocked ||
        retained.instance.controller.signal.aborted ||
        !retained.instance.activated ||
        !retained.registration.resources
      )
        throw new Error('appPluginCleanupUnresolved');
    }
    for (const registration of this.registrations()) {
      if (registration.beforePackageMutation) await registration.beforePackageMutation();
      else if (registration.resources?.protectedResources?.().length)
        throw new Error('appPluginCleanupUnresolved');
    }
  }
  restorePackageAdmissions(ids: readonly string[]): void {
    for (const id of ids) {
      const instance = this.instances.get(id);
      if (instance) {
        instance.fenced = instance.blocked;
        this.updateEnabled(instance);
      }
    }
    this.changed();
  }
  submissionIdentity(participant: AppSubmissionParticipant): AppSubmission {
    const instance = [...this.instances.values()].find(
      candidate => candidate.registration.submission === participant,
    );
    if (!instance) throw new Error(AppPluginError.Unavailable);
    return {
      pluginId: instance.artifact.artifact.manifest.id,
      epoch: instance.epoch,
      mode: 'launch',
    };
  }
  runSubmission<T>(
    participant: AppSubmissionParticipant,
    submission: AppSubmission | undefined,
    operation: () => T,
  ): T {
    const instance = [...this.instances.values()].find(
      candidate => candidate.registration.submission === participant,
    );
    if (
      !instance ||
      !instance.businessAllowed ||
      instance.blocked ||
      instance.fenced ||
      !instance.enabled ||
      !instance.activated ||
      !this.isNativeEnabled(instance.artifact.artifact.manifest.nativePluginId) ||
      (submission &&
        (submission.pluginId !== instance.artifact.artifact.manifest.id ||
          submission.epoch !== instance.epoch))
    ) {
      throw new Error(AppPluginError.Unavailable);
    }
    return this.runBusiness(instance, instance.epoch, operation);
  }
  private runBusiness<T>(instance: Instance, epoch: string, operation: () => T): T {
    const nativeId = instance.artifact.artifact.manifest.nativePluginId;
    const assertCurrent = () => {
      if (
        instance.epoch !== epoch ||
        instance.blocked ||
        instance.fenced ||
        instance.controller.signal.aborted ||
        !this.isNativeEnabled(nativeId)
      )
        throw new Error(AppPluginError.Retired);
    };
    return this.invocation.run(
      { id: instance.artifact.artifact.manifest.id, epoch, family: 'business' },
      () =>
        runWithPluginRequestBinding(
          this.readNativeState(nativeId).binding,
          assertCurrent,
          operation,
        ),
    );
  }
  private runCleanup<T>(
    instance: Instance,
    operation: () => T,
    cleanupLease?: { active: boolean },
  ): T {
    if (this.disposed || instance.controller.signal.aborted)
      throw new Error(AppPluginError.Retired);
    return this.invocation.run(
      {
        id: instance.artifact.artifact.manifest.id,
        epoch: instance.epoch,
        family: 'cleanup',
        cleanupLease,
      },
      () => runWithoutPluginRequestBinding(operation),
    );
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): void {
    for (const candidate of this.candidates) candidate.abort();
    const owned = new Set([
      ...this.instances.values(),
      ...this.pendingRetirements,
      ...[...this.cleanupOwners.values()].filter(owner => owner.owned).map(owner => owner.instance),
    ]);
    for (const instance of owned) {
      this.disposeInstance(instance);
    }
    this.disposed = true;
    this.instances.clear();
    this.cleanupOwners.clear();
    this.pendingRetirements.clear();
    this.mutatingInstances.clear();
    this.changed();
    this.listeners.clear();
  }
  private disposeInstance(instance: Instance): void {
    if (instance.disposed) return;
    instance.disposed = true;
    instance.fenced = true;
    if (instance.maintenanceTimer) clearInterval(instance.maintenanceTimer);
    instance.maintenanceTimer = undefined;
    isolateObserver(() => instance.releaseBusiness?.());
    isolateObserver(() => this.runCleanup(instance, () => instance.registration.dispose?.()));
    instance.controller.abort();
  }
  private startMaintenance(instance: Instance): void {
    if (!instance.registration.maintenance || instance.maintenanceTimer) return;
    const tick = () => {
      if (this.disposed || instance.disposed || instance.maintenancePending) return;
      const lease = { active: true };
      const pending = Promise.resolve()
        .then(() =>
          this.runCleanup(instance, () => instance.registration.maintenance?.(), lease),
        )
        .then((): void => undefined)
        .catch(() => {
          // A failed receipt read is not terminal evidence; the next tick only reconciles.
        })
        .finally(() => {
          lease.active = false;
          if (instance.maintenancePending === pending) instance.maintenancePending = undefined;
        });
      instance.maintenancePending = pending;
    };
    instance.maintenanceTimer = setInterval(tick, 3000);
    instance.maintenanceTimer.unref?.();
    tick();
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private updateEnabled(instance: Instance): void {
    const native = this.readNativeState(instance.artifact.artifact.manifest.nativePluginId);
    const enabled = this.isNativeEnabled(instance.artifact.artifact.manifest.nativePluginId);
    // A lost mutation response is not a permanent schema/cleanup failure. Only a
    // fresh authenticated Native proof can reopen business; never replay the mutation.
    if (
      instance.pendingMutation &&
      enabled &&
      native.binding &&
      native.binding !== instance.pendingMutation.binding &&
      !this.mutatingInstances.has(instance)
    ) {
      instance.pendingMutation = undefined;
      instance.fenced = instance.blocked;
    }
    if (enabled !== instance.enabled) instance.epoch = randomUUID();
    instance.enabled = enabled;
    if (
      instance.businessEpoch !== instance.epoch ||
      !enabled ||
      instance.fenced ||
      !instance.businessAllowed
    ) {
      isolateObserver(() => instance.releaseBusiness?.());
      instance.releaseBusiness = undefined;
      instance.businessEpoch = undefined;
    }
    if (
      instance.activated &&
      instance.businessAllowed &&
      enabled &&
      !instance.blocked &&
      !instance.fenced &&
      instance.businessEpoch !== instance.epoch
    ) {
      try {
        const release = requireSynchronous(
          this.runBusiness(instance, instance.epoch, () => instance.registration.onEnable?.()),
          'onEnable',
        );
        instance.releaseBusiness =
          typeof release === 'function' ? () => this.runCleanup(instance, release) : undefined;
        instance.businessEpoch = instance.epoch;
      } catch {
        instance.blocked = true;
        instance.fenced = true;
      }
    }
  }
}

function projectExecutionReceipt(event: {
  event: string;
  payload: unknown;
}): Parameters<AppMainHost['onExecutionReceipt']>[0] extends (payload: infer R) => void
  ? R | undefined
  : never {
  if (event.event !== 'agent' || !event.payload || typeof event.payload !== 'object')
    return undefined;
  const value = event.payload as Record<string, unknown>;
  const data = value.data as Record<string, unknown> | undefined;
  if (
    value.stream !== 'lifecycle' ||
    !data ||
    data.executionSettled !== true ||
    !['end', 'error'].includes(String(data.phase)) ||
    typeof value.sessionKey !== 'string' ||
    value.sessionKey.length > 1024 ||
    typeof value.runId !== 'string' ||
    value.runId.length > 256
  )
    return undefined;
  return {
    stream: 'lifecycle',
    sessionKey: value.sessionKey,
    runId: value.runId,
    ...(typeof value.sessionId === 'string' && value.sessionId.length <= 256
      ? { sessionId: value.sessionId }
      : {}),
    data: {
      phase: data.phase as 'end' | 'error',
      executionSettled: true,
      ...(typeof data.aborted === 'boolean' ? { aborted: data.aborted } : {}),
    },
  };
}

/** Event observers must never propagate a synchronous or deferred failure into the host emitter. */
function isolateObserver(operation: () => unknown): void {
  try {
    void Promise.resolve(operation()).catch((): undefined => undefined);
  } catch {
    /* The observer's admission or lifetime has ended. */
  }
}

/** Lifecycle registration is synchronous; drain invalid promises before rejecting admission. */
function requireSynchronous<T>(value: T, phase: string): T {
  if (
    value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(value).catch((): undefined => undefined);
    throw new Error(`App ${phase} must be synchronous`);
  }
  return value;
}
