import { PluginKind } from '@shared/plugins/marketplace';
import {
  PluginOperationAction,
  type PluginOperationFeedback,
  PluginOperationStage,
} from '@shared/plugins/pluginOperation';

import {
  pluginOperationFailure,
  pluginOperationRefreshFailure,
} from '@/features/plugins/shared/pluginMutationFeedback';
import {
  pluginSourceLabel,
  startPluginOperation,
} from '@/features/plugins/shared/pluginOperationService';
import { Skill } from '@/features/plugins/skills/skill';
import { i18nService } from '@/services/i18n';

type SkillListResult = PluginOperationFeedback & {
  success: boolean;
  skills?: Skill[];
  error?: string;
  gatewayOffline?: boolean;
};

const INVENTORY_REFRESH_DELAYS_MS = [200, 400, 800, 1_600, 2_000, 5_000];
// Windows native skill-tree discovery can take one 30-second polling interval.
const INVENTORY_REFRESH_WINDOW_MS = 45_000;
const INVENTORY_RECOVERY_INTERVAL_MS = 3_000;

class SkillService {
  private skills: Skill[] = [];
  private initialized = false;
  private gatewayOffline = false;
  private loadPromise: Promise<Skill[]> | null = null;
  private loadGeneration = 0;
  private skillUpdateQueue: Promise<void> = Promise.resolve();
  private pendingSkillUpdates = new Map<string, { enabled: boolean; promise: Promise<Skill[]> }>();
  private inventoryListeners = new Set<(skills: Skill[]) => void>();
  private inventoryRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private inventoryRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private inventoryReadFailed = false;
  private inventoryRefreshGeneration = 0;
  private inventoryRefreshDeadline = 0;
  private deletedPaths = new Map<string, { id: string; name: string; expiresAt: number }>();

  subscribeInventory(listener: (skills: Skill[]) => void): () => void {
    this.inventoryListeners.add(listener);
    this.scheduleInventoryRecovery();
    if (!this.inventoryRefreshTimer && this.inventoryRefreshDeadline > Date.now()) {
      this.scheduleInventoryRefresh(this.inventoryRefreshGeneration, 0);
    }
    return () => {
      this.inventoryListeners.delete(listener);
      if (this.inventoryListeners.size === 0) {
        this.inventoryRefreshGeneration += 1;
        if (this.inventoryRefreshTimer) clearTimeout(this.inventoryRefreshTimer);
        this.inventoryRefreshTimer = null;
        if (this.inventoryRecoveryTimer) clearTimeout(this.inventoryRecoveryTimer);
        this.inventoryRecoveryTimer = null;
      }
    };
  }

  async refreshInventoryAfterMutation(): Promise<Skill[]> {
    this.beginInventoryRefresh();
    return this.loadSkills({ force: true });
  }

  private scheduleInventoryRecovery(): void {
    if (
      !this.inventoryReadFailed ||
      this.inventoryListeners.size === 0 ||
      this.inventoryRecoveryTimer
    )
      return;
    // skills.list uses only an existing connection. A running engine does not
    // prove its RPC connection is ready, so recovery follows real read results.
    this.inventoryRecoveryTimer = setTimeout(async () => {
      this.inventoryRecoveryTimer = null;
      if (this.inventoryListeners.size === 0 || !this.inventoryReadFailed) return;
      if (this.inventoryRefreshTimer) {
        this.scheduleInventoryRecovery();
        return;
      }
      const generation = this.inventoryRefreshGeneration;
      await this.loadSkills();
      if (
        generation === this.inventoryRefreshGeneration &&
        !this.inventoryReadFailed &&
        !this.inventoryRefreshTimer
      ) {
        // A successful reconnect can still read the native watcher's old cache.
        // Resume only the remaining window, using its existing slowest interval.
        this.scheduleInventoryRefresh(generation, INVENTORY_REFRESH_DELAYS_MS.length - 1);
      }
    }, INVENTORY_RECOVERY_INTERVAL_MS);
  }

  private beginInventoryRefresh(): void {
    this.inventoryRefreshGeneration += 1;
    this.inventoryRefreshDeadline = Date.now() + INVENTORY_REFRESH_WINDOW_MS;
    if (this.inventoryRefreshTimer) clearTimeout(this.inventoryRefreshTimer);
    this.inventoryRefreshTimer = null;
    this.scheduleInventoryRefresh(this.inventoryRefreshGeneration, 0);
  }

  private scheduleInventoryRefresh(generation: number, index: number): void {
    const remaining = this.inventoryRefreshDeadline - Date.now();
    if (this.inventoryRefreshTimer || this.inventoryListeners.size === 0 || remaining <= 0) return;
    const delayMs =
      INVENTORY_REFRESH_DELAYS_MS[Math.min(index, INVENTORY_REFRESH_DELAYS_MS.length - 1)];
    this.inventoryRefreshTimer = setTimeout(
      async () => {
        this.inventoryRefreshTimer = null;
        if (generation !== this.inventoryRefreshGeneration || this.inventoryListeners.size === 0)
          return;
        await this.loadSkills();
        if (generation === this.inventoryRefreshGeneration && !this.gatewayOffline) {
          this.scheduleInventoryRefresh(generation, index + 1);
        }
      },
      Math.min(delayMs, remaining),
    );
  }

  private projectConfirmedDeletions(skills: Skill[]): Skill[] {
    const paths = new Set(skills.map(skill => `${skill.source}\0${skill.skillPath}`));
    for (const [key, removal] of this.deletedPaths) {
      if (!paths.has(key) || removal.expiresAt <= Date.now()) this.deletedPaths.delete(key);
    }
    return skills.filter(skill => !this.deletedPaths.has(`${skill.source}\0${skill.skillPath}`));
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadSkills();
    this.initialized = true;
  }

  async loadSkills(options: { force?: boolean } = {}): Promise<Skill[]> {
    // A remounted page must read the confirmed switch state, rather than offer
    // the same action again while its previous request is still running.
    await this.waitForPendingSkillUpdates();
    if (options.force) this.invalidateListRead();
    const generation = this.loadGeneration;
    const loaded = await this.readSkills();
    if (this.pendingSkillUpdates.size > 0) {
      await this.waitForPendingSkillUpdates();
      return this.loadPromise ?? this.skills;
    }
    return generation === this.loadGeneration ? loaded : (this.loadPromise ?? this.skills);
  }

  private async waitForPendingSkillUpdates(): Promise<void> {
    while (this.pendingSkillUpdates.size > 0) {
      await Promise.allSettled(
        [...this.pendingSkillUpdates.values()].map(update => update.promise),
      );
    }
  }

  private async readSkills(options: { force?: boolean } = {}): Promise<Skill[]> {
    if (options.force) this.invalidateListRead();
    const generation = this.loadGeneration;
    if (this.loadPromise) {
      const loaded = await this.loadPromise;
      return generation === this.loadGeneration ? loaded : (this.loadPromise ?? this.skills);
    }

    const pending = this.fetchSkills(this.loadGeneration).finally(() => {
      if (this.loadPromise === pending) this.loadPromise = null;
    });
    this.loadPromise = pending;
    const loaded = await pending;
    return generation === this.loadGeneration ? loaded : (this.loadPromise ?? this.skills);
  }

  private invalidateListRead(): void {
    this.loadGeneration += 1;
    this.loadPromise = null;
  }

  private async reconcileFailedMutation(
    operation: ReturnType<typeof startPluginOperation>,
    generation: number,
  ) {
    if (generation !== this.loadGeneration) return;
    operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
    // This read belongs to the current switch and must not wait on its own queue entry.
    await this.readSkills({ force: true });
    if (this.inventoryReadFailed) operation.fail(pluginOperationRefreshFailure());
  }

  private async fetchSkills(generation: number): Promise<Skill[]> {
    try {
      const result: SkillListResult = await window.electron.skills.list();
      if (generation !== this.loadGeneration) return this.loadPromise ?? this.skills;
      if (result.success && result.skills) {
        this.skills = this.projectConfirmedDeletions(result.skills);
        this.gatewayOffline = false;
        this.inventoryReadFailed = false;
        if (this.inventoryRecoveryTimer) clearTimeout(this.inventoryRecoveryTimer);
        this.inventoryRecoveryTimer = null;
      } else {
        this.gatewayOffline = result.gatewayOffline || false;
        this.inventoryReadFailed = true;
        this.scheduleInventoryRecovery();
      }
      if (this.pendingSkillUpdates.size === 0) {
        this.inventoryListeners.forEach(listener => listener(this.skills));
      }
      return this.skills;
    } catch (error) {
      if (generation !== this.loadGeneration) return this.loadPromise ?? this.skills;
      console.error('Failed to load skills:', error);
      this.gatewayOffline = true;
      this.inventoryReadFailed = true;
      this.scheduleInventoryRecovery();
      if (this.pendingSkillUpdates.size === 0) {
        this.inventoryListeners.forEach(listener => listener(this.skills));
      }
      return this.skills;
    }
  }

  /** Check if Gateway is offline (skills unavailable) */
  isGatewayOffline(): boolean {
    return this.gatewayOffline;
  }

  hasInventoryReadFailed(): boolean {
    return this.inventoryReadFailed;
  }

  setSkillEnabled(id: string, enabled: boolean): Promise<Skill[]> {
    const existing = this.pendingSkillUpdates.get(id);
    if (existing?.enabled === enabled) return existing.promise;

    const operation = startPluginOperation({
      kind: PluginKind.SKILL,
      action: enabled ? PluginOperationAction.ENABLE : PluginOperationAction.DISABLE,
      label: this.skills.find(skill => skill.id === id)?.name || id,
    });
    const pending = this.skillUpdateQueue
      .then(() => this.updateSkillEnabled(id, enabled, operation))
      .catch(error => {
        operation.fail({
          message: error instanceof Error ? error.message : i18nService.t('skillUpdateFailed'),
        });
        throw error;
      })
      .finally(() => {
        operation.finish();
        if (this.pendingSkillUpdates.get(id)?.promise === pending) {
          this.pendingSkillUpdates.delete(id);
          if (this.pendingSkillUpdates.size === 0) {
            for (const listener of this.inventoryListeners) {
              try {
                listener(this.skills);
              } catch {
                /* Inventory observers cannot replace a mutation receipt. */
              }
            }
          }
        }
      });
    this.pendingSkillUpdates.set(id, { enabled, promise: pending });
    this.skillUpdateQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async updateSkillEnabled(
    id: string,
    enabled: boolean,
    operation: ReturnType<typeof startPluginOperation>,
  ): Promise<Skill[]> {
    const generation = this.loadGeneration;
    try {
      const result: SkillListResult = await window.electron.skills.setEnabled(
        { id, enabled },
        operation.context,
      );
      if (result.success && result.skills) {
        // Internal reads cannot wait for the operation that owns this promise,
        // or for later switches queued behind it.
        if (generation !== this.loadGeneration) {
          operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
          const skills = await this.readSkills({ force: true });
          if (this.inventoryReadFailed || result.refreshWarning)
            operation.fail(pluginOperationRefreshFailure(result));
          return skills;
        }
        this.invalidateListRead();
        this.skills = this.projectConfirmedDeletions(result.skills);
        this.gatewayOffline = false;
        if (result.refreshWarning) operation.fail(pluginOperationRefreshFailure(result));
        return this.skills;
      }
      if (generation === this.loadGeneration) {
        this.gatewayOffline = result.gatewayOffline || false;
        this.inventoryReadFailed = true;
        this.scheduleInventoryRecovery();
      }
      operation.fail(pluginOperationFailure(result, i18nService.t('skillUpdateFailed')));
      throw new Error(result.error || i18nService.t('skillUpdateFailed'));
    } catch (error) {
      console.error('Failed to update skill:', error);
      operation.fail({
        message: error instanceof Error ? error.message : i18nService.t('skillUpdateFailed'),
      });
      await this.reconcileFailedMutation(operation, generation);
      throw error;
    }
  }

  async deleteSkill(id: string, source?: Skill['source']): Promise<SkillListResult> {
    const generation = this.loadGeneration;
    const removed = this.skills.find(skill => skill.id === id && skill.source === source);
    const operation = startPluginOperation({
      kind: PluginKind.SKILL,
      action: PluginOperationAction.REMOVE,
      label: removed?.name || id,
    });
    try {
      const result = await window.electron.skills.delete({ id, source }, operation.context);
      if (result.success && result.skills) {
        // Main retains a same-path entry only when files already exist again.
        // Otherwise suppress this confirmed removal while the watcher catches up.
        if (
          removed?.skillPath &&
          !result.skills.some(
            skill => skill.source === removed.source && skill.skillPath === removed.skillPath,
          )
        ) {
          this.deletedPaths.set(`${removed.source}\0${removed.skillPath}`, {
            id: removed.id,
            name: removed.name,
            expiresAt: Date.now() + INVENTORY_REFRESH_WINDOW_MS,
          });
        }
        this.beginInventoryRefresh();
        if (generation !== this.loadGeneration) {
          operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
          const skills = await this.loadSkills({ force: true });
          const refreshFailed = this.inventoryReadFailed || result.refreshWarning;
          if (refreshFailed) operation.fail(pluginOperationRefreshFailure(result));
          return {
            ...result,
            success: true,
            skills,
            ...(refreshFailed ? { refreshWarning: true as const } : {}),
          };
        }
        this.invalidateListRead();
        this.skills = result.skills.filter(
          skill => !this.deletedPaths.has(`${skill.source}\0${skill.skillPath}`),
        );
        if (result.refreshWarning) operation.fail(pluginOperationRefreshFailure(result));
        return { ...result, success: true, skills: this.skills };
      }
      operation.fail(pluginOperationFailure(result, i18nService.t('skillDeleteFailed')));
      await this.reconcileFailedMutation(operation, generation);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete skill';
      operation.fail({ message });
      await this.reconcileFailedMutation(operation, generation);
      return { success: false, error: message };
    } finally {
      operation.finish();
    }
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  getEnabledSkills(): Skill[] {
    return this.skills.filter(s => s.enabled);
  }

  getSkillById(id: string): Skill | undefined {
    return this.skills.find(s => s.id === id);
  }

  /** Import a skill from a local folder or archive */
  async importSkill(
    sourcePath: string,
    options: { reportFailure?: boolean } = {},
  ): Promise<PluginOperationFeedback & { success: boolean; skillId?: string; error?: string }> {
    const operation = startPluginOperation({
      kind: PluginKind.SKILL,
      action: PluginOperationAction.INSTALL,
      label: pluginSourceLabel(sourcePath),
    });
    try {
      const result = await window.electron.skills.importPath(sourcePath, operation.context);
      if (
        result.success ||
        result.installationCommitted ||
        result.installSourceInUse ||
        result.operationUnconfirmed
      ) {
        for (const [key, removal] of this.deletedPaths) {
          if (removal.id === result.skillId || removal.name === result.skillId)
            this.deletedPaths.delete(key);
        }
        this.invalidateListRead();
        this.beginInventoryRefresh();
      }
      if (options.reportFailure !== false) {
        if (!result.success)
          operation.fail(pluginOperationFailure(result, i18nService.t('skillImportFailed')));
        else if (result.refreshWarning) operation.fail(pluginOperationRefreshFailure(result));
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import skill';
      console.error('Failed to import skill:', error);
      if (options.reportFailure !== false) operation.fail({ message });
      return { success: false, error: message };
    } finally {
      operation.finish();
    }
  }

  getLocalizedSkillDescription(_skillId: string, _skillName: string, fallback: string): string {
    return fallback;
  }
}

export const skillService = new SkillService();
