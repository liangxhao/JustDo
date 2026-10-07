import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeRoot = fileURLToPath(new URL('../../../vendor/openclaw-runtime/current/', import.meta.url));
const stateDir = mkdtempSync(path.join(os.tmpdir(), 'justdo-native-bootstrap-'));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, 'openclaw.json');

async function nativeExport(prefix, symbol) {
  const dist = path.join(runtimeRoot, 'dist');
  for (const name of readdirSync(dist).filter(name => name.startsWith(prefix) && name.endsWith('.mjs'))) {
    const source = readFileSync(path.join(dist, name), 'utf8');
    const exported = source.match(new RegExp(`\\b${symbol} as (\\w+)\\b`));
    if (exported) return (await import(pathToFileURL(path.join(dist, name))))[exported[1]];
  }
  throw new Error(`Missing native runtime export: ${symbol}`);
}

test('native skipBootstrap leaves task projects unseeded and existing rules injectable', async () => {
  try {
    const ensureAgentWorkspace = await nativeExport('workspace-', 'ensureAgentWorkspace');
    const resolveBootstrapContextForRun = await nativeExport('bootstrap-files-', 'resolveBootstrapContextForRun');
    const emptyProject = path.join(stateDir, 'empty-project');
    const project = path.join(stateDir, 'existing-project');
    const role = path.join(stateDir, 'agent-workspaces', 'main');
    mkdirSync(project, { recursive: true });
    mkdirSync(role, { recursive: true });
    writeFileSync(path.join(project, 'AGENTS.md'), 'Project build and test rules');
    writeFileSync(path.join(role, 'AGENTS.md'), 'Assistant role instructions');
    writeFileSync(path.join(role, 'SOUL.md'), 'Assistant persona');
    const config = {
      agents: {
        defaults: { workspace: role, skipBootstrap: true },
        entries: { main: { workspace: role } },
      },
      plugins: { enabled: false },
    };
    writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));

    await ensureAgentWorkspace({ dir: emptyProject, ensureBootstrapFiles: !config.agents.defaults.skipBootstrap });
    await ensureAgentWorkspace({ dir: project, ensureBootstrapFiles: !config.agents.defaults.skipBootstrap });
    assert.deepEqual(readdirSync(emptyProject), []);
    assert.deepEqual(readdirSync(project), ['AGENTS.md']);
    assert.equal(readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), 'Project build and test rules');

    const params = { config, agentId: 'main', sessionKey: 'agent:main:main' };
    const roleContext = await resolveBootstrapContextForRun({ ...params, workspaceDir: role });
    const projectContext = await resolveBootstrapContextForRun({ ...params, workspaceDir: project });
    assert.ok(roleContext.contextFiles.some(file => file.content === 'Assistant role instructions'));
    assert.ok(roleContext.contextFiles.some(file => file.content === 'Assistant persona'));
    assert.ok(projectContext.contextFiles.some(file => file.content === 'Project build and test rules'));
  } finally {
    const closeStateDatabase = await nativeExport('openclaw-state-db-cache-', 'closeOpenClawStateDatabaseAsync');
    await closeStateDatabase();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
