import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtime, fixture, targetVersion] = process.argv.slice(2);
assert.ok(path.isAbsolute(fixture) && fs.readdirSync(fixture).length === 0);
const runtimePackage = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
assert.equal(runtimePackage.name, 'openclaw');
assert.equal(runtimePackage.version, targetVersion);

const state = path.join(fixture, 'state');
const role = path.join(state, 'agent-workspaces', 'main');
const projectA = path.join(fixture, 'project-a');
const projectB = path.join(fixture, 'project-b');
const plugin = path.join(fixture, 'plugin');
const bundledSkills = path.join(fixture, 'bundled-skills');
const bundledPlugins = path.join(fixture, 'bundled-plugins');
const pluginId = 'precedence-fixture';
const skillName = 'zz-precedence-collision';
const configPath = path.join(state, 'openclaw.json');

for (const directory of [role, projectA, projectB, plugin, bundledSkills, bundledPlugins]) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeSkill(root, name, description, skillKey = name) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'SKILL.md');
  const metadata = JSON.stringify({ openclaw: { skillKey } });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\nmetadata: ${metadata}\n---\n\n# ${description}\n`);
  return file;
}

const pluginFile = writeSkill(path.join(plugin, 'skills'), skillName, 'Plugin version', 'plugin-fixture');
fs.writeFileSync(path.join(path.dirname(pluginFile), 'support.txt'), 'Plugin support\n');
const projectBFile = writeSkill(path.join(projectB, 'skills'), skillName, 'Project B version', 'project-b-fixture');
writeSkill(path.join(role, 'skills'), 'aa-role-fixture', 'Role skill');
fs.writeFileSync(path.join(plugin, 'index.mjs'), 'export default { id: "precedence-fixture" };\n');
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
  name: pluginId,
  version: '1.0.0',
  openclaw: { extensions: ['./index.mjs'] },
}));
fs.writeFileSync(path.join(plugin, 'openclaw.plugin.json'), JSON.stringify({
  id: pluginId,
  skills: ['./skills'],
  configSchema: { type: 'object', additionalProperties: false },
}));

const config = {
  agents: { entries: { main: { workspace: role } } },
  plugins: {
    allow: [pluginId],
    load: { paths: [plugin] },
    entries: { [pluginId]: { enabled: true } },
  },
  skills: { limits: { maxSkillsInPrompt: 1 }, load: { watch: false } },
};
fs.writeFileSync(configPath, JSON.stringify(config));
Object.assign(process.env, {
  OPENCLAW_HOME: fixture,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkills,
  OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPlugins,
});

const dist = path.join(runtime, 'dist');
const files = fs.readdirSync(dist);
async function nativeFunction(prefix, name) {
  const candidates = files.filter(file =>
    file.startsWith(prefix) && file.endsWith('.mjs') &&
    fs.readFileSync(path.join(dist, file), 'utf8').includes(`function ${name}(`),
  );
  assert.equal(candidates.length, 1, `Expected one native ${name} owner`);
  const module = await import(pathToFileURL(path.join(dist, candidates[0])).href);
  const exports = Object.values(module).filter(value =>
    typeof value === 'function' && value.name === name,
  );
  assert.equal(exports.length, 1, `Expected one native ${name} export`);
  return exports[0];
}

const resolveSnapshot = await nativeFunction('session-snapshot-', 'resolveReusableWorkspaceSkillSnapshot');
const bumpVersion = await nativeFunction('refresh-state-', 'bumpSkillsSnapshotVersion');

async function snapshot(executionWorkspaceDir, existingSnapshot, selectedConfig = config) {
  return (await resolveSnapshot({
    workspaceDir: role,
    executionWorkspaceDir,
    config: selectedConfig,
    agentId: 'main',
    existingSnapshot,
    watch: false,
  })).snapshot;
}

function assertWinner(catalog, file, key) {
  const candidates = catalog.skills.filter(skill => skill.name === skillName);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].skillKey, key);
  assert.equal(fs.realpathSync(candidates[0].source.filePath), fs.realpathSync(file));
}

function refreshProjectA() {
  bumpVersion({ workspaceDir: role, sourceScopes: [{ executionWorkspaceDir: projectA }], reason: 'manual' });
}

// A real enabled plugin contributes the initial winner to the session catalog.
const before = await snapshot(projectA);
assertWinner(before, pluginFile, 'plugin-fixture');
const publishedPlugin = path.join(state, 'plugin-skills', skillName, 'SKILL.md');
assert.equal(fs.realpathSync(publishedPlugin), fs.realpathSync(pluginFile));

const projectAFile = writeSkill(path.join(projectA, 'skills'), skillName, 'Project A version', 'project-a-fixture');
const projectAgentsFile = writeSkill(path.join(projectA, '.agents', 'skills'), skillName, 'Project A agents version', 'project-a-agents-fixture');
fs.writeFileSync(path.join(path.dirname(projectAFile), 'support.txt'), 'Project A support\n');
refreshProjectA();

const [first, second] = await Promise.all([snapshot(projectA, before), snapshot(projectB)]);
assertWinner(first, projectAFile, 'project-a-fixture');
assertWinner(second, projectBFile, 'project-b-fixture');
assert.deepEqual(first.resolvedSkills.map(skill => skill.description), ['Project A version']);
assert.deepEqual(second.resolvedSkills.map(skill => skill.description), ['Project B version']);

const sandbox = path.join(fixture, 'sandbox-a');
fs.mkdirSync(sandbox);
const { syncWorkspaceSkills } = await import(
  pathToFileURL(path.join(dist, 'workspace-skill-sync.runtime.js')).href
);
const materialized = (await syncWorkspaceSkills({
  sourceWorkspaceDir: projectA,
  targetWorkspaceDir: sandbox,
  config,
  agentId: 'main',
  skillsSnapshot: first,
})).filter(skill => skill.skillName === skillName);
assert.equal(materialized.length, 1);
const [winner] = materialized;
assert.equal(fs.realpathSync(winner.skillFile), fs.realpathSync(projectAFile));
assert.equal(winner.readPath, path.join(sandbox, 'skills', skillName, 'SKILL.md'));
assert.equal(fs.readFileSync(winner.readPath, 'utf8'), fs.readFileSync(projectAFile, 'utf8'));
assert.equal(fs.readFileSync(path.join(path.dirname(winner.readPath), 'support.txt'), 'utf8'), 'Project A support\n');

// A source-specific disabled project winner must not revive the enabled plugin copy.
const disabled = await snapshot(projectA, undefined, {
  ...config,
  skills: { ...config.skills, entries: { 'project-a-fixture': { enabled: false } } },
});
assert.deepEqual(disabled.skills.map(skill => skill.name), ['aa-role-fixture']);

// Native revision refresh changes sources only after the corresponding files disappear.
fs.rmSync(projectAFile);
refreshProjectA();
const agentsFallback = await snapshot(projectA, first);
assertWinner(agentsFallback, projectAgentsFile, 'project-a-agents-fixture');
fs.rmSync(projectAgentsFile);
refreshProjectA();
assertWinner(await snapshot(projectA, agentsFallback), pluginFile, 'plugin-fixture');

console.log('PROJECT_SKILL_PRECEDENCE_OK');
