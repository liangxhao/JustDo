import { TEAM_DISCUSSION_CHANNEL } from '../../../shared/cowork/agent-team/teamDiscussion';
import {
  collectCanonicalAgentEntries,
  withoutRetiredHeartbeatFields,
} from './agents/agentProjection';
import { isRecord } from './configShape';

/** The discussion surface permits native ambient silence without relaxing direct replies. */
export const buildManagedOpenClawSurfaces = (existing: unknown): Record<string, unknown> => {
  const surfaces = isRecord(existing) ? existing : {};
  return {
    ...surfaces,
    [TEAM_DISCUSSION_CHANNEL]: {
      ...(isRecord(surfaces[TEAM_DISCUSSION_CHANNEL]) ? surfaces[TEAM_DISCUSSION_CHANNEL] : {}),
      silentReply: { group: 'allow' },
    },
  };
};

/**
 * Remove application-owned fields not accepted by OpenClaw v2026.10.7 and translate the
 * two renamed config surfaces. This is deliberately narrow: unrelated
 * operator-owned config remains untouched and is still validated by Gateway.
 */
// The retained symbol identifies the shared 10.6/10.7 configuration contract.
export const sanitizeOpenClawV2026_10_6Config = (
  config: Record<string, unknown>,
): Record<string, unknown> => {
  const next = { ...config };

  if (isRecord(config.meta)) {
    const meta = { ...config.meta };
    delete meta.lastTouchedAt;
    next.meta = meta;
  }

  if (isRecord(config.diagnostics)) {
    const diagnostics = { ...config.diagnostics };
    delete diagnostics.stuckSessionWarnMs;
    delete diagnostics.stuckSessionAbortMs;
    next.diagnostics = diagnostics;
  }

  if (isRecord(config.models)) {
    const models = { ...config.models };
    delete models.pricing;
    next.models = models;
  }

  if (isRecord(config.skills) && isRecord(config.skills.workshop)) {
    const workshop = { ...config.skills.workshop };
    delete workshop.approvalPolicy;
    delete workshop.maxPending;
    next.skills = { ...config.skills, workshop };
  }

  if (isRecord(config.browser) || (process.platform === 'win32' && config.browser === undefined)) {
    const browser = isRecord(config.browser) ? { ...config.browser } : {};
    delete browser.color;
    const profiles = isRecord(browser.profiles) ? { ...browser.profiles } : {};
    // Native Browser also synthesizes user outside User mode. Materialize only
    // that missing profile so every Windows attach uses the managed launcher.
    if (process.platform === 'win32' && profiles.user === undefined) {
      profiles.user = { driver: 'existing-session', attachOnly: true };
    }
    if (isRecord(browser.profiles) || Object.keys(profiles).length > 0) {
      browser.profiles = Object.fromEntries(
        Object.entries(profiles).map(([profileId, rawProfile]) => {
          if (!isRecord(rawProfile)) return [profileId, rawProfile];
          const profile = { ...rawProfile };
          delete profile.color;
          if (
            process.platform === 'win32' &&
            profile.driver === 'existing-session' &&
            (profile.mcpCommand === undefined || profile.mcpCommand === 'npx')
          ) {
            profile.mcpCommand = 'chrome-mcp.cmd';
          }
          return [profileId, profile];
        }),
      );
    }
    next.browser = browser;
  }

  if (isRecord(config.mcp)) {
    const mcp = { ...config.mcp };
    if (isRecord(mcp.servers)) {
      mcp.servers = Object.fromEntries(
        Object.entries(mcp.servers).map(([name, rawServer]) => {
          if (!isRecord(rawServer)) return [name, rawServer];
          const server = { ...rawServer };
          if (
            typeof server.timeout === 'number' &&
            Number.isFinite(server.timeout) &&
            server.timeout > 0 &&
            server.requestTimeoutMs === undefined
          ) {
            server.requestTimeoutMs = server.timeout * 1_000;
          }
          delete server.timeout;
          return [name, server];
        }),
      );
    }
    next.mcp = mcp;
  }

  if (isRecord(config.tools)) {
    const tools = { ...config.tools };
    const experimental = isRecord(tools.experimental) ? tools.experimental : undefined;
    if (
      typeof experimental?.planTool === 'boolean' &&
      !Object.prototype.hasOwnProperty.call(tools, 'updatePlan')
    ) {
      tools.updatePlan = experimental.planTool;
    }
    delete tools.experimental;
    next.tools = tools;
  }

  if (isRecord(config.agents)) {
    const agents = { ...config.agents };
    const defaults = isRecord(agents.defaults) ? { ...agents.defaults } : {};
    const legacyMemorySearch = isRecord(defaults.memorySearch) ? defaults.memorySearch : undefined;
    delete defaults.memorySearch;
    if (Object.prototype.hasOwnProperty.call(defaults, 'heartbeat')) {
      defaults.heartbeat = withoutRetiredHeartbeatFields(defaults.heartbeat);
    }

    const entries = collectCanonicalAgentEntries(agents);
    delete agents.list;
    agents.defaults = defaults;
    if (Object.keys(entries).length > 0) {
      agents.ownership = 'explicit';
      agents.entries = entries;
    }
    next.agents = agents;

    if (legacyMemorySearch) {
      const memory = isRecord(next.memory) ? next.memory : {};
      next.memory = {
        ...memory,
        ...(isRecord(memory.search) ? {} : { search: legacyMemorySearch }),
      };
    }
  }

  return next;
};

export const buildOpenClawConfigMeta = (
  version: string | null | undefined,
  existingMeta?: unknown,
): Record<string, unknown> => {
  // Gateway owns migration receipts. Dropping them makes native startup and
  // auth operations repeat completed migrations and rewrite the config.
  const meta = isRecord(existingMeta) ? { ...existingMeta } : {};
  delete meta.lastTouchedAt;
  return { ...meta, lastTouchedVersion: version || 'unknown' };
};
