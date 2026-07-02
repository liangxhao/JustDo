import { ClawHubSkill, ClawHubSkillDetail, Skill } from '../types/skill';

type SkillListResult = {
  success: boolean;
  skills?: Skill[];
  error?: string;
  gatewayOffline?: boolean;
};

class SkillService {
  private skills: Skill[] = [];
  private initialized = false;
  private gatewayOffline = false;
  private loadPromise: Promise<Skill[]> | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadSkills();
    this.initialized = true;
  }

  async loadSkills(): Promise<Skill[]> {
    if (this.loadPromise) return this.loadPromise;

    this.loadPromise = this.fetchSkills().finally(() => {
      this.loadPromise = null;
    });
    return this.loadPromise;
  }

  private async fetchSkills(): Promise<Skill[]> {
    try {
      const result: SkillListResult = await window.electron.skills.list();
      if (result.success && result.skills) {
        this.skills = result.skills;
        this.gatewayOffline = false;
      } else {
        this.skills = [];
        this.gatewayOffline = result.gatewayOffline || false;
      }
      return this.skills;
    } catch (error) {
      console.error('Failed to load skills:', error);
      this.skills = [];
      this.gatewayOffline = true;
      return this.skills;
    }
  }

  /** Check if Gateway is offline (skills unavailable) */
  isGatewayOffline(): boolean {
    return this.gatewayOffline;
  }

  async setSkillEnabled(id: string, enabled: boolean): Promise<Skill[]> {
    try {
      const result: SkillListResult = await window.electron.skills.setEnabled({ id, enabled });
      if (result.success && result.skills) {
        this.skills = result.skills;
        this.gatewayOffline = false;
        return this.skills;
      }
      this.gatewayOffline = result.gatewayOffline || false;
      throw new Error(result.error || 'Failed to update skill');
    } catch (error) {
      console.error('Failed to update skill:', error);
      throw error;
    }
  }

  async deleteSkill(id: string): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    try {
      const result = await window.electron.skills.delete(id);
      if (result.success && result.skills) {
        this.skills = result.skills;
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

  // ============================================================
  // Marketplace methods (Gateway ClawHub integration)
  // ============================================================

  /** Search ClawHub marketplace for skills */
  async searchMarketplace(query?: string, limit?: number): Promise<ClawHubSkill[]> {
    try {
      const result = await window.electron.skills.search({ query, limit });
      if (result.success && result.results) {
        return result.results;
      }
      return [];
    } catch (error) {
      console.error('Failed to search marketplace:', error);
      return [];
    }
  }

  /** Get detailed info for a ClawHub skill */
  async getMarketplaceDetail(slug: string): Promise<ClawHubSkillDetail | null> {
    try {
      const result = await window.electron.skills.detail({ slug });
      if (result.success && result.detail) {
        return result.detail;
      }
      return null;
    } catch (error) {
      console.error('Failed to get skill detail:', error);
      return null;
    }
  }

  /** Install a skill from ClawHub marketplace */
  async installSkill(
    slug: string,
    version?: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const result = await window.electron.skills.install({
        source: 'clawhub',
        slug,
        version,
      });
      return { success: result.success, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install skill';
      console.error('Failed to install skill:', error);
      return { success: false, error: message };
    }
  }

  /** Import a skill from a local archive (ZIP or TGZ) */
  async importSkill(
    archivePath: string,
  ): Promise<{ success: boolean; skillId?: string; error?: string }> {
    try {
      const result = await window.electron.skills.import(archivePath);
      return { success: result.success, skillId: result.skillId, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import skill';
      console.error('Failed to import skill:', error);
      return { success: false, error: message };
    }
  }

  /** Import a skill from a local folder */
  async importSkillFromFolder(
    folderPath: string,
  ): Promise<{ success: boolean; skillId?: string; error?: string }> {
    try {
      const result = await window.electron.skills.importFolder(folderPath);
      return { success: result.success, skillId: result.skillId, error: result.error };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to import skill from folder';
      console.error('Failed to import skill from folder:', error);
      return { success: false, error: message };
    }
  }

  getLocalizedSkillDescription(_skillId: string, _skillName: string, fallback: string): string {
    return fallback;
  }
}

export const skillService = new SkillService();
