import { Skill } from '@/features/plugins/skills/skill';

type SkillListResult = {
  success: boolean;
  skills?: Skill[];
  error?: string;
  gatewayOffline?: boolean;
};

const INVENTORY_REFRESH_DELAYS_MS = [200, 400, 800, 1_600, 2_000];
const INVENTORY_REFRESH_WINDOW_MS = 5_000;
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
      await this.loadSkills();
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
    if (
      this.inventoryListeners.size === 0 ||
      remaining <= 0 ||
      index >= INVENTORY_REFRESH_DELAYS_MS.length
    )
      return;
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
      Math.min(INVENTORY_REFRESH_DELAYS_MS[index], remaining),
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

  setSkillEnabled(id: string, enabled: boolean): Promise<Skill[]> {
    const existing = this.pendingSkillUpdates.get(id);
    if (existing?.enabled === enabled) return existing.promise;

    const pending = this.skillUpdateQueue
      .then(() => this.updateSkillEnabled(id, enabled))
      .finally(() => {
        if (this.pendingSkillUpdates.get(id)?.promise === pending) {
          this.pendingSkillUpdates.delete(id);
        }
      });
    this.pendingSkillUpdates.set(id, { enabled, promise: pending });
    this.skillUpdateQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async updateSkillEnabled(id: string, enabled: boolean): Promise<Skill[]> {
    const generation = this.loadGeneration;
    try {
      const result: SkillListResult = await window.electron.skills.setEnabled({ id, enabled });
      if (result.success && result.skills) {
        // Internal reads cannot wait for the operation that owns this promise,
        // or for later switches queued behind it.
        if (generation !== this.loadGeneration) return this.readSkills({ force: true });
        this.invalidateListRead();
        this.skills = this.projectConfirmedDeletions(result.skills);
        this.gatewayOffline = false;
        return this.skills;
      }
      if (generation === this.loadGeneration) {
        this.gatewayOffline = result.gatewayOffline || false;
        this.inventoryReadFailed = true;
        this.scheduleInventoryRecovery();
      }
      throw new Error(result.error || 'Failed to update skill');
    } catch (error) {
      console.error('Failed to update skill:', error);
      throw error;
    }
  }

  async deleteSkill(
    id: string,
    source?: Skill['source'],
  ): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    const generation = this.loadGeneration;
    const removed = this.skills.find(skill => skill.id === id && skill.source === source);
    try {
      const result = await window.electron.skills.delete({ id, source });
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
          return { success: true, skills: await this.loadSkills({ force: true }) };
        }
        this.invalidateListRead();
        this.skills = result.skills.filter(
          skill => !this.deletedPaths.has(`${skill.source}\0${skill.skillPath}`),
        );
        return { success: true, skills: this.skills };
      }
      return { success: false, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete skill';
      return { success: false, error: message };
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
  ): Promise<{ success: boolean; skillId?: string; error?: string }> {
    try {
      const result = await window.electron.skills.importPath(sourcePath);
      if (result.success) {
        for (const [key, removal] of this.deletedPaths) {
          if (removal.id === result.skillId || removal.name === result.skillId)
            this.deletedPaths.delete(key);
        }
        this.invalidateListRead();
        this.beginInventoryRefresh();
      }
      return { success: result.success, skillId: result.skillId, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import skill';
      console.error('Failed to import skill:', error);
      return { success: false, error: message };
    }
  }

  getLocalizedSkillDescription(_skillId: string, _skillName: string, fallback: string): string {
    return fallback;
  }
}

export const skillService = new SkillService();
