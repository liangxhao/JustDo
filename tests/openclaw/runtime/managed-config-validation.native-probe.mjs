// Validates isolated Main projections with immutable schema, legacy rules and reload planning.
// Frozen admission intentionally proves archived native bytes, not the current Main recipe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const expectedVersion = `v${require('../../../package.json').openclaw.version.replace(/^v/u, '')}`;
const runtime = fs.realpathSync(process.argv[2]);
const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
assert.ok(Array.isArray(input));
const { verifyFrozenOpenClawRuntime } = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
const { hostTarget, targetContract } = require('../../../scripts/runtime/setup-node-runtime.cjs');
const { manifest } = verifyFrozenOpenClawRuntime(runtime, { expectedVersion, requireBundle: true });
assert.equal(manifest.target, hostTarget());
const executable = path.join(runtime, 'node-runtime', targetContract(hostTarget()).executable);
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(executable));
const asar = require('@electron/asar');
const dist = path.join(runtime, 'dist');
const names = fs.readdirSync(dist);
async function owner(prefix, symbol, declaration) {
  const matches = [];
  for (const file of names.filter(name => name.startsWith(prefix) && name.endsWith('.mjs'))) {
    const content = fs.readFileSync(path.join(dist, file), 'utf8');
    if (!content.includes(declaration)) continue;
    const tail = content.slice(content.lastIndexOf('\nexport {'));
    const match = tail.match(new RegExp('\\b' + symbol + '(?: as ([\\w$]+))?\\s*[,}]'));
    if (match) matches.push({ file, alias: match[1] ?? symbol, content });
  }
  assert.equal(matches.length, 1, 'one actual native owner: ' + symbol);
  const selected = matches[0];
  assert.ok(asar.extractFile(path.join(runtime, 'gateway.asar'), 'dist/' + selected.file)
    .equals(Buffer.from(selected.content)), 'selected native module matches the verified immutable archive');
  return (await import(pathToFileURL(path.join(dist, selected.file)).href))[selected.alias];
}
const schema = await owner('zod-schema-', 'OpenClawSchema', 'const OpenClawSchema =');
const findLegacy = await owner('legacy-', 'findLegacyConfigIssues', 'function findLegacyConfigIssues(');
let reload;
if (input.some(value => value.previousConfig)) {
  const createRegistry = await owner('registry-empty-', 'createEmptyPluginRegistry', 'function createEmptyPluginRegistry(');
  const setRegistry = await owner('runtime-', 'setActivePluginRegistry', 'function setActivePluginRegistry(');
  const memoryEntry = path.join('dist', 'extensions', 'memory-core', 'index.js');
  assert.ok(asar.extractFile(path.join(runtime, 'gateway.asar'), memoryEntry)
    .equals(fs.readFileSync(path.join(runtime, memoryEntry))), 'memory reload policy matches the immutable archive');
  const memory = (await import(pathToFileURL(path.join(runtime, memoryEntry)).href)).default;
  reload = {
    createRegistry, setRegistry, memory,
    prefixes: await owner('config-reload-plan-', 'listConfigReloadRefinementPrefixes', 'function listConfigReloadRefinementPrefixes('),
    diff: await owner('config-reload-plan-', 'diffGatewayReloadPaths', 'function diffGatewayReloadPaths('),
    plan: await owner('config-reload-plan-', 'buildGatewayReloadPlan', 'function buildGatewayReloadPlan('),
  };
}
const results = input.map(({ label, config, previousConfig }) => {
  const parsed = schema.safeParse(config);
  let reloadPlan;
  if (previousConfig) {
    const registry = reload.createRegistry();
    // Capture actual native service declarations, without starting services,
    // opening a database, registering a watcher or executing any tool/hook.
    if (previousConfig.plugins?.entries?.['memory-core']?.enabled !== false) {
      const unexpected = () => { throw new Error('Reload planning must not access runtime resources.'); };
      reload.memory.register({
        id: 'memory-core', config: previousConfig,
        runtime: { llm: { acquireLocalService: unexpected }, state: { openKeyedStore: unexpected } },
        lifecycle: { onDispose() {} }, logger: {},
        registerService(service) { registry.services.push({ pluginId: 'memory-core', id: service.id, service }); },
        registerMemoryCapability() {}, registerTool() {}, on() {},
        registerCommand() {}, registerCli() {}, registerGatewayMethod() {},
      });
    }
    reload.setRegistry(registry);
    const changedPaths = reload.diff(previousConfig, config, reload.prefixes());
    const plan = reload.plan(changedPaths, { previousConfig, candidateConfig: config });
    reloadPlan = { changedPaths, restartGateway: plan.restartGateway,
      restartReasons: plan.restartReasons, hotReasons: plan.hotReasons,
      restartServices: [...plan.restartServices] };
  }
  return { label, schemaSuccess: parsed.success,
    schemaIssues: parsed.success ? [] : parsed.error.issues.map(issue => ({
      path: issue.path.join('.'), code: issue.code, ...(issue.keys ? { keys: issue.keys } : {}),
    })),
    legacyIssues: findLegacy(config).map(issue => ({ path: issue.path, message: issue.message })),
    ...(reloadPlan ? { reloadPlan } : {}),
  };
});
process.stdout.write('NATIVE_MANAGED_CONFIG=' + JSON.stringify({
  identity: { runtime, version: manifest.openclawVersion, nodeVersion: process.version,
    patchSetSha256: manifest.patchSetSha256, archivedRecipeSha256: manifest.buildRecipeSha256,
    evidence: 'immutable-native-schema-and-legacy-rules; optional reload planning uses native memory service declarations; Main projection is current test subject' },
  results,
}) + '\n');
