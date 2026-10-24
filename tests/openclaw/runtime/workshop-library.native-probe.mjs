// Real frozen Workshop filesystem + SQLite worker proof. No Gateway, model, or mocked library.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const { runtimeRoot, identity } = resolveNativeSmokeTarget();
const artifacts = path.resolve('.agent-tasks/runtime/workshop-library');
await fs.mkdir(artifacts, { recursive: true });
// Keep business state separate from project observers and preserve only audit evidence here.
// This isolates the fixture; it does not assert the cause of any earlier Windows EPERM.
const state = await fs.mkdtemp(path.join(os.tmpdir(), 'workshop-native-'));
const evidenceDir = path.join(artifacts, path.basename(state));
await fs.mkdir(evidenceDir, { recursive: true });
console.log('NATIVE_WORKSHOP_PROFILE=' + JSON.stringify({ state, evidenceDir, layout: 'system-temp' }));
for (const name of Object.keys(process.env)) {
  const upper = name.toUpperCase();
  if (upper.startsWith('OPENCLAW_') || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(upper)) delete process.env[name];
}
Object.assign(process.env, {
  OPENCLAW_HOME: state, OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'), OPENCLAW_NO_RESPAWN: '1',
});
const config = {
  agents: { ownership: 'explicit', entries: { main: { workspace: path.join(state, 'workspace') } },
    defaults: { embeddedAgent: { cyberFailover: { mode: 'off' } } } },
  skills: { workshop: { autonomous: { mode: 'off' } } },
  plugins: { enabled: false, allow: [], entries: {} },
  update: { checkOnStart: false, auto: { enabled: false } },
};
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
const dist = path.join(runtimeRoot, 'dist');
const files = await fs.readdir(dist);
async function native(prefix, symbol) {
  const matches = [];
  for (const name of files.filter(name => name.startsWith(prefix) && name.endsWith('.mjs'))) {
    const source = await fs.readFile(path.join(dist, name), 'utf8');
    if (!source.includes('function ' + symbol + '(')) continue;
    const tail = source.slice(source.lastIndexOf('\nexport {'));
    const match = tail.match(new RegExp('\\b' + symbol + '(?: as (\\w+))?\\s*[,}]'));
    if (match) matches.push({ name, alias: match[1] ?? symbol });
  }
  assert.equal(matches.length, 1, 'one exact native owner: ' + symbol);
  const value = (await import(pathToFileURL(path.join(dist, matches[0].name)).href))[matches[0].alias];
  assert.equal(typeof value, 'function', 'native callable: ' + symbol);
  return value;
}
const create = await native('library-', 'createWorkshopSkill');
const write = await native('library-', 'writeWorkshopSkillFile');
const patch = await native('library-', 'patchWorkshopSkill');
const archive = await native('library-', 'archiveWorkshopSkill');
const restore = await native('library-', 'restoreWorkshopSkill');
const read = await native('library-', 'viewWorkshopSkill');
const list = await native('workshop-list-', 'buildSkillsWorkshopListResult');
const changes = await native('library-', 'listWorkshopChanges');
const closeAgents = await native('openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabasesAsync');
const closeState = await native('openclaw-state-db-cache-', 'closeOpenClawStateDatabaseAsync');
let admitted = true;
const context = { config, agentId: 'main', actor: 'user',
  assertLive() { assert.equal(admitted, true, 'fixture authority revoked'); } };
const checks = [];
try {
  const content = '---\nname: release\ndescription: Repeatable release checks\n---\n\nInitial instructions.\n';
  await create(context, { name: 'release', content });
  await write(context, { name: 'release', filePath: 'references/check.md', content: 'Complete support instructions.\n' });
  const patched = await patch(context, { name: 'release', oldText: 'Initial instructions.', newText: 'Updated instructions.' });
  assert.ok(patched.versionId);
  const live = await list({ config, agentId: 'main' });
  assert.equal(live.mode, 'off');
  assert.equal(live.skills[0].name, 'release');
  assert.deepEqual(live.skills[0].files, ['SKILL.md', 'references/check.md']);
  assert.equal(live.archived[0].live, true);
  checks.push('native inventory distinguishes a live skill with saved versions');
  const version = await read(config, 'main', 'release', 'SKILL.md', patched.versionId);
  assert.ok(version.content.includes('Initial instructions.'));
  assert.equal((await read(config, 'main', 'release', 'references/check.md', patched.versionId)).content, 'Complete support instructions.\n');
  checks.push('exact saved-version SKILL.md and support file contents are real');
  const restored = await restore(context, { name: 'release', versionId: patched.versionId });
  assert.ok(restored.versionId);
  assert.notEqual(restored.versionId, patched.versionId);
  assert.ok((await read(config, 'main', 'release')).content.includes('Initial instructions.'));
  assert.ok((await read(config, 'main', 'release', 'SKILL.md', restored.versionId)).content.includes('Updated instructions.'));
  checks.push('explicit restore applies the selected version and returns a distinct pre-change backup');
  const archived = await archive(context, { name: 'release', reason: 'Temporary retirement' });
  const absent = await list({ config, agentId: 'main' });
  assert.deepEqual(absent.skills, []);
  assert.equal(absent.archived[0].live, false);
  await assert.rejects(read(config, 'main', 'release'), /archived/);
  await restore(context, { name: 'release', versionId: archived.versionId });
  assert.equal((await list({ config, agentId: 'main' })).archived[0].live, true);
  checks.push('archive hides the live copy and its exact snapshot restores files');
  const feed = await changes('main', { limit: 200 });
  assert.equal(feed.length, 6);
  assert.deepEqual(feed.map(item => item.action).reverse(), ['create', 'write_file', 'patch', 'restore', 'archive', 'restore']);
  assert.ok(feed.every(item => item.agentId === 'main' && item.actor === 'user'));
  assert.ok(feed.every((item, index) => !index || item.createdAtMs <= feed[index - 1].createdAtMs));
  const boundary = feed[0].createdAtMs;
  assert.ok((await changes('main', { limit: 200, beforeMs: boundary })).every(item => item.createdAtMs < boundary));
  checks.push('real SQLite worker persists newest-first change receipts and exclusive timestamp bounds');
  admitted = false;
  await assert.rejects(archive(context, { name: 'release' }), /authority revoked/);
  assert.equal((await changes('main', { limit: 200 })).length, feed.length);
  assert.ok((await read(config, 'main', 'release')).content.includes('Initial instructions.'));
  checks.push('revoked native assertLive rejects the mutation without changing files or change feed');
  admitted = true;
  await assert.rejects(read(config, 'main', 'release', '../outside.md'));
  await assert.rejects(restore(context, { name: 'release', versionId: 'missing-version' }), /no version/);
  assert.equal((await changes('main', { limit: 200 })).length, feed.length);
  checks.push('native traversal and unknown-version boundaries reject without a mutation');
} catch (error) {
  await fs.writeFile(path.join(evidenceDir, 'failure.json'), JSON.stringify({
    identity, nativeStateDir: state, checks,
    error: { message: error.message, code: error.code, syscall: error.syscall,
      path: error.path, dest: error.dest },
  }, null, 2)).catch(() => {});
  throw error;
} finally {
  try { await closeAgents(); } finally { await closeState(); }
}
const result = { identity, nativeStateDir: state, profileLayout: 'system-temp', checks,
  limits: 'Real frozen library/files/SQLite worker; no Gateway handshake, model learning, OS UI or installer acceptance.' };
await fs.writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(result, null, 2));
console.log('NATIVE_WORKSHOP_LIBRARY=' + JSON.stringify({ passed: checks.length, evidence: path.join(evidenceDir, 'result.json'), identity }));
