import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';

import type { OpenClawHookStore } from '../../libs/openclaw/hooks/openclawHookStore';
import type { OpenClawEngineManager } from '../../libs/openclaw/runtime/openclawEngineManager';

interface HookHandlerDependencies {
  getManager: () => OpenClawEngineManager;
  getStore: () => OpenClawHookStore;
  syncConfig: () => Promise<{ hooks: number; error?: string }>;
}

type HookReport = {
  workspaceDir: string;
  managedHooksDir: string;
  hooks: Array<Record<string, unknown>>;
};

const readJsonFile = (filePath: string): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const getNestedRecord = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const next = value[key];
  return next && typeof next === 'object' && !Array.isArray(next)
    ? (next as Record<string, unknown>)
    : {};
};

const readHookEntriesFromConfig = (
  config: Record<string, unknown>,
): Record<string, unknown> => {
  const hooks = getNestedRecord(config, 'hooks');
  const internal = getNestedRecord(hooks, 'internal');
  return getNestedRecord(internal, 'entries');
};

const readStringFrontmatterField = (frontmatter: string, field: string): string => {
  const match = frontmatter.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  if (!match) return '';
  return match[1].trim().replace(/^['"]|['"]$/g, '');
};

const readQuotedArray = (value: string, field: string): string[] => {
  const match = value.match(new RegExp(`"${field}"\\s*:\\s*\\[([^\\]]*)\\]`, 's'));
  if (!match) return [];
  return Array.from(match[1].matchAll(/"([^"]+)"/g)).map(item => item[1]);
};

const parseHookFile = (
  hookDir: string,
  source: string,
  config: Record<string, unknown>,
  hookStates: Map<string, boolean>,
): Record<string, unknown> | null => {
  const filePath = path.join(hookDir, 'HOOK.md');
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf8');
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const frontmatter = frontmatterMatch?.[1] ?? '';
  const name = readStringFrontmatterField(frontmatter, 'name') || path.basename(hookDir);
  const description = readStringFrontmatterField(frontmatter, 'description');
  const homepage = readStringFrontmatterField(frontmatter, 'homepage');
  const emoji = frontmatter.match(/"emoji"\s*:\s*"([^"]+)"/)?.[1];
  const events = readQuotedArray(frontmatter, 'events');
  const requiredConfig = readQuotedArray(frontmatter, 'config');
  const enabled = hookStates.get(name) === true;
  const configChecks = requiredConfig.map(configPath => ({
    path: configPath,
    satisfied:
      configPath === 'workspace.dir'
        ? Boolean(
            getNestedRecord(getNestedRecord(config, 'agents'), 'defaults').workspace
              || getNestedRecord(config, 'workspace').dir,
          )
        : false,
  }));
  const missingConfig = configChecks.filter(check => !check.satisfied).map(check => check.path);
  const requirementsSatisfied = missingConfig.length === 0;

  return {
    name,
    hookKey: name,
    description,
    emoji,
    eligible: enabled && requirementsSatisfied,
    disabled: !enabled,
    enabledByConfig: enabled,
    requirementsSatisfied,
    loadable: enabled && requirementsSatisfied,
    blockedReason: requirementsSatisfied ? undefined : 'missing requirements',
    source,
    events,
    homepage,
    filePath,
    baseDir: hookDir,
    handlerPath: path.join(hookDir, 'handler.js'),
    missing: {
      bins: [],
      anyBins: [],
      env: [],
      config: missingConfig,
      os: [],
    },
    managedByPlugin: false,
  };
};

const readHookDirectories = (root: string): string[] => {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name))
      .filter(dir => fs.existsSync(path.join(dir, 'HOOK.md')));
  } catch {
    return [];
  }
};

const buildLocalHookReport = async (
  manager: OpenClawEngineManager,
  hookStore: OpenClawHookStore,
): Promise<HookReport> => {
  const cliEnvironment = await manager.buildCliEnvironment();
  const config = readJsonFile(manager.getConfigPath());
  const configHookEntries = readHookEntriesFromConfig(config);
  if (Object.keys(configHookEntries).length > 0) {
    hookStore.importEntries(configHookEntries);
  }
  const hookStates = new Map(hookStore.listHooks().map(hook => [hook.id, hook.enabled]));
  const managedHooksDir = path.join(manager.getStateDir(), 'hooks');
  const workspaceDir =
    String(getNestedRecord(getNestedRecord(config, 'agents'), 'defaults').workspace || '')
    || String(getNestedRecord(config, 'workspace').dir || '');
  const bundledHooksDir = path.join(cliEnvironment.runtimeRoot, 'dist', 'bundled');
  const hooks = [
    ...readHookDirectories(bundledHooksDir)
      .map(dir => parseHookFile(dir, 'openclaw-bundled', config, hookStates))
      .filter((hook): hook is Record<string, unknown> => hook !== null),
    ...readHookDirectories(managedHooksDir)
      .map(dir => parseHookFile(dir, 'openclaw-managed', config, hookStates))
      .filter((hook): hook is Record<string, unknown> => hook !== null),
  ];

  return {
    workspaceDir,
    managedHooksDir,
    hooks,
  };
};

const syncHookConfigInBackground = (
  syncConfig: HookHandlerDependencies['syncConfig'],
): void => {
  void syncConfig().catch(error => {
    console.error('[OpenClawHooks] background configuration sync error:', error);
  });
};

export const registerHookHandlers = ({
  getManager,
  getStore,
  syncConfig,
}: HookHandlerDependencies): void => {
  ipcMain.handle('hooks:list', async () => {
    try {
      const report = await buildLocalHookReport(getManager(), getStore());
      return {
        success: true,
        ...report,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to load hooks';
      console.error('[Hooks] hooks:list error:', errorMsg);
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle('hooks:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      const hookId = options.id?.trim();
      if (!hookId) {
        return { success: false, error: 'Hook id is required' };
      }

      const manager = getManager();
      const hookStore = getStore();
      const currentReport = await buildLocalHookReport(manager, hookStore);
      const hookExists = currentReport.hooks.some(hook => hook.hookKey === hookId || hook.name === hookId);
      if (!hookExists) {
        return { success: false, error: `Hook "${hookId}" not found` };
      }

      hookStore.setEnabled(hookId, options.enabled);
      syncHookConfigInBackground(syncConfig);
      const report = await buildLocalHookReport(manager, hookStore);
      return {
        success: true,
        restartRequired: true,
        ...report,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to update hook';
      console.error('[Hooks] hooks:setEnabled error:', errorMsg);
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });
};
