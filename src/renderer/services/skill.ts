import { Skill, LocalizedText, ClawHubSkill, ClawHubSkillDetail } from '../types/skill';
import { i18nService } from './i18n';

export function resolveLocalizedText(text: string | LocalizedText): string {
  if (!text) return '';
  if (typeof text === 'string') return text;
  const lang = i18nService.getLanguage();
  return text[lang] || text.en || '';
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

type EmailConnectivityCheck = {
  code: 'imap_connection' | 'smtp_connection';
  level: 'pass' | 'fail';
  message: string;
  durationMs: number;
};

type EmailConnectivityTestResult = {
  testedAt: number;
  verdict: 'pass' | 'fail';
  checks: EmailConnectivityCheck[];
};

type SkillListResult = {
  success: boolean;
  skills?: Skill[];
  error?: string;
  gatewayOffline?: boolean;
};

class SkillService {
  private skills: Skill[] = [];
  private initialized = false;
  private localSkillDescriptions: Map<string, string | LocalizedText> = new Map();
  private marketplaceSkillDescriptions: Map<string, string | LocalizedText> = new Map();
  private gatewayOffline = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadSkills();
    this.initialized = true;
  }

  async loadSkills(): Promise<Skill[]> {
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

  async deleteSkill(_id: string): Promise<{ success: boolean; skills?: Skill[]; error?: string }> {
    // Skill deletion not supported via Gateway - use disable instead
    return {
      success: false,
      error: 'Skill deletion not supported. Please disable the skill instead.',
    };
  }

  async getSkillsRoot(): Promise<string | null> {
    // No longer needed - Gateway manages skill locations
    return null;
  }

  onSkillsChanged(callback: () => void): () => void {
    return window.electron.skills.onChanged(callback);
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

  async getSkillConfig(_skillId: string): Promise<Record<string, string>> {
    // No longer supported - use Gateway skills.update
    return {};
  }

  async setSkillConfig(_skillId: string, _config: Record<string, string>): Promise<boolean> {
    // No longer supported - use Gateway skills.update
    return false;
  }

  async testEmailConnectivity(
    _skillId: string,
    _config: Record<string, string>,
  ): Promise<EmailConnectivityTestResult | null> {
    // No longer supported - Gateway manages skill connectivity
    return null;
  }

  async getAutoRoutingPrompt(): Promise<string | null> {
    // No longer needed - Gateway handles skill routing
    return null;
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

  getLocalizedSkillDescription(skillId: string, skillName: string, fallback: string): string {
    const localDesc = this.localSkillDescriptions.get(skillName);
    if (localDesc != null) return resolveLocalizedText(localDesc);
    const marketDesc = this.marketplaceSkillDescriptions.get(skillId);
    if (marketDesc != null) return resolveLocalizedText(marketDesc);
    return fallback;
  }
}

export const skillService = new SkillService();
