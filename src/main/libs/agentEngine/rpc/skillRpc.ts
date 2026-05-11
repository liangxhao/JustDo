/**
 * Skill management RPC and title generation methods.
 *
 * Extracted from openclawRuntimeAdapter.ts to reduce file size.
 * Handles gateway RPC calls for skill status, install, update, search, and detail.
 * Also handles session title generation.
 */

import type { GatewayClientLike } from '../gateway/types';
import type {
  GatewaySkillStatus,
  SkillInstallParams,
  SkillUpdateParams,
  SkillRpcResult,
  ClawHubSearchResult,
  ClawHubDetail,
} from '../types';
import type { CoworkStore } from '../../../coworkStore';

export interface SkillRpcCallbacks {
  ensureGatewayClientReady(): Promise<void>;
  requireGatewayClient(): GatewayClientLike;
  getGatewayClient(): GatewayClientLike | null;
  store: CoworkStore;
}

export class SkillRpcHandler {
  constructor(private readonly callbacks: SkillRpcCallbacks) {}

  // ─── Title Generation ──────────────────────────────────────────────────────

  async generateTitle(userIntent: string | null, timeoutMs = 8000): Promise<string> {
    const SESSION_TITLE_MAX_CHARS = 50;
    const SESSION_TITLE_FALLBACK = 'New Session';

    const normalizedInput = typeof userIntent === 'string' ? userIntent.trim() : '';
    const fallbackTitle = this.buildFallbackTitle(
      normalizedInput,
      SESSION_TITLE_FALLBACK,
      SESSION_TITLE_MAX_CHARS,
    );

    // CRITICAL: Skip gateway-based title generation entirely.
    // The gateway's bootstrapContextMode: 'lightweight' does NOT prevent skill context injection,
    // causing the title session to spawn subagents for skill processing instead of just generating a title.
    console.log(
      '[OpenClawRuntime] generateTitle: using fallback title to avoid skill injection (input="' +
        normalizedInput.slice(0, 50) +
        '...") -> "' +
        fallbackTitle +
        '"',
    );
    return fallbackTitle;
  }

  private buildFallbackTitle(input: string, fallback: string, maxChars: number): string {
    if (!input) return fallback;
    const firstLine =
      input
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(Boolean) || '';
    return this.normalizeTitle(firstLine, fallback, maxChars);
  }

  private normalizeTitle(value: string, fallback: string, maxChars: number): string {
    let title = value.trim();

    // Strip markdown code fences
    const fenced = /```(?:[\w-]+)?\s*([\s\S]*?)```/i.exec(title);
    if (fenced?.[1]) {
      title = fenced[1].trim();
    }

    // Strip markdown formatting
    title = title
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/_([^_\n]+)_/g, '$1')
      .replace(/^#{1,6}\s+/, '')
      .trim();

    // Extract from "title: xxx" format
    const labeled = /^(?:title|标题)\s*[:：]\s*(.+)$/i.exec(title);
    if (labeled?.[1]) {
      title = labeled[1].trim();
    }

    // Strip quotes
    title = title
      .replace(/^["'`"''']+/, '')
      .replace(/["'`"''']+$/, '')
      .trim();

    // Only use first line (model may return multi-line content)
    title = title.split(/\r?\n/)[0].trim();

    // Strip suffix after dash/hyphen (e.g., "Sorting Algorithms - Part 1/2")
    const dashMatch = title.match(/^(.+?)[-—–.]/);
    if (dashMatch?.[1]) {
      title = dashMatch[1].trim();
    }

    if (title.length > maxChars) {
      title = title.slice(0, maxChars).trimEnd();
    }

    return title || fallback;
  }

  extractTitleFromAgentResult(result: unknown): string | null {
    if (!result) return null;

    const obj = result as Record<string, unknown>;

    // Check for Gateway agent final response structure
    if (obj.status === 'ok' && obj.result !== undefined) {
      const innerResult = obj.result as Record<string, unknown>;
      const payloads = innerResult.payloads as unknown[];
      if (Array.isArray(payloads) && payloads.length > 0) {
        const firstPayload = payloads[0] as Record<string, unknown>;
        if (typeof firstPayload?.text === 'string') {
          return firstPayload.text;
        }
      }
      return this.extractTitleFromAgentResult(obj.result);
    }

    if (typeof result === 'string') {
      return result;
    }

    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    if (typeof obj.result === 'string') return obj.result;
    if (typeof obj.summary === 'string') return obj.summary;

    const payloads = obj.payloads as unknown[];
    if (Array.isArray(payloads) && payloads.length > 0) {
      const firstPayload = payloads[0] as Record<string, unknown>;
      if (typeof firstPayload?.text === 'string') {
        return firstPayload.text;
      }
    }

    const messages = obj.messages as unknown[];
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (typeof msg === 'string') return msg;
        if (msg && typeof msg === 'object') {
          const msgObj = msg as Record<string, unknown>;
          if (typeof msgObj.text === 'string') return msgObj.text;
          if (typeof msgObj.content === 'string') return msgObj.content;
        }
      }
    }

    return null;
  }

  // ─── Session Model Patching ────────────────────────────────────────────────

  async patchSessionModel(
    sessionId: string,
    model: string,
    agentId?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const client = this.callbacks.getGatewayClient();
    if (!client) {
      return { ok: false, error: 'OpenClaw gateway client not connected' };
    }

    const session = this.callbacks.store.getSession(sessionId);
    const effectiveAgentId = agentId || session?.agentId || 'main';
    const sessionKey = `agent:${effectiveAgentId}:gucciai:${sessionId}`;

    const normalizedModel = model.trim();
    if (!normalizedModel) {
      return { ok: false, error: 'Model reference is required' };
    }

    console.log(
      '[OpenClawRuntime] patchSessionModel: sessionId=%s, agentId=%s, key=%s, model=%s',
      sessionId,
      effectiveAgentId,
      sessionKey,
      normalizedModel,
    );

    try {
      const result = await client.request<{ ok?: boolean; key?: string; entry?: unknown }>(
        'sessions.patch',
        {
          key: sessionKey,
          model: normalizedModel,
        },
      );
      console.log('[OpenClawRuntime] patchSessionModel: success, result=', result);
      return { ok: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn('[OpenClawRuntime] patchSessionModel: failed:', errorMsg);
      return { ok: false, error: errorMsg };
    }
  }

  // ─── Skill Management RPC ──────────────────────────────────────────────────

  async getSkillsStatus(agentId?: string): Promise<GatewaySkillStatus> {
    await this.callbacks.ensureGatewayClientReady();
    const client = this.callbacks.requireGatewayClient();
    const result = await client.request<GatewaySkillStatus>('skills.status', {
      agentId,
    });
    console.log('[OpenClawRuntime] getSkillsStatus response:', {
      workspaceDir: result.workspaceDir,
      managedSkillsDir: result.managedSkillsDir,
      skillCount: result.skills?.length || 0,
      firstSkillPath: result.skills?.[0]?.filePath,
      firstSkillBaseDir: result.skills?.[0]?.baseDir,
    });
    return result;
  }

  async installSkill(params: SkillInstallParams): Promise<SkillRpcResult> {
    await this.callbacks.ensureGatewayClientReady();
    const client = this.callbacks.requireGatewayClient();
    console.log('[OpenClawRuntime] installSkill: params=', params);
    const result = await client.request<SkillRpcResult>('skills.install', params);
    console.log('[OpenClawRuntime] installSkill: result=', result);
    return result;
  }

  async updateSkillConfig(params: SkillUpdateParams): Promise<SkillRpcResult> {
    await this.callbacks.ensureGatewayClientReady();
    const client = this.callbacks.requireGatewayClient();
    console.log(
      '[OpenClawRuntime] updateSkillConfig: skillKey=',
      params.skillKey,
      'enabled=',
      params.enabled,
    );
    const result = await client.request<SkillRpcResult>('skills.update', params);
    console.log('[OpenClawRuntime] updateSkillConfig: result=', result);
    return result;
  }

  async searchClawHubSkills(query?: string, limit?: number): Promise<ClawHubSearchResult[]> {
    await this.callbacks.ensureGatewayClientReady();
    const client = this.callbacks.requireGatewayClient();
    const result = await client.request<{ results?: ClawHubSearchResult[] }>(
      'skills.search',
      { query, limit: limit || 20 },
    );
    console.log(
      '[OpenClawRuntime] searchClawHubSkills: received',
      result.results?.length || 0,
      'results',
    );
    return result.results || [];
  }

  async getClawHubSkillDetail(slug: string): Promise<ClawHubDetail | null> {
    await this.callbacks.ensureGatewayClientReady();
    const client = this.callbacks.requireGatewayClient();
    const result = await client.request<ClawHubDetail>('skills.detail', { slug });
    console.log('[OpenClawRuntime] getClawHubSkillDetail: slug=', slug, 'result=', result);
    return result;
  }
}
