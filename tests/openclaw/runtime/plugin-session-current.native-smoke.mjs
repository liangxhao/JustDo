// Model-free proof of the frozen runtime's native execution-owner guard.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const { runtimeRoot: runtime, identity } = resolveNativeSmokeTarget();
const artifacts = path.resolve('.agent-tasks/runtime/plugin-session-current');
await fs.mkdir(artifacts, { recursive: true });
const state = await fs.mkdtemp(path.join(artifacts, 'native-'));
for (const name of Object.keys(process.env)) {
  const key = name.toUpperCase();
  if (key.startsWith('OPENCLAW_') ||
      ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete process.env[name];
}
Object.assign(process.env, {
  OPENCLAW_HOME: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
  OPENCLAW_NO_RESPAWN: '1',
});
await fs.writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
  agents: { ownership: 'explicit', entries: { main: {} },
    defaults: { embeddedAgent: { cyberFailover: { mode: 'off' } } } },
  plugins: { enabled: false, allow: [], entries: {} },
  update: { checkOnStart: false, auto: { enabled: false } },
}));
const dist = path.join(runtime, 'dist');
const files = await fs.readdir(dist);
async function native(prefix, symbol) {
  const matches = [];
  for (const file of files.filter(file => file.startsWith(prefix) && file.endsWith('.mjs'))) {
    const source = await fs.readFile(path.join(dist, file), 'utf8');
    if (!source.includes(`function ${symbol}(`)) continue;
    const alias = source.slice(source.lastIndexOf('\nexport {'))
      .match(new RegExp(`\\b${symbol}(?: as (\\w+))?\\s*[,}]`));
    if (alias) matches.push({ file, alias: alias[1] ?? symbol });
  }
  assert.equal(matches.length, 1, `one exact native owner: ${symbol}`);
  const value = (await import(pathToFileURL(path.join(dist, matches[0].file)).href))[matches[0].alias];
  assert.equal(typeof value, 'function', `callable native owner: ${symbol}`);
  return value;
}

const capture = await native('session-binding-runtime-', 'captureSessionEntryCurrentCheck');
const upsert = await native('session-accessor.sqlite-entry-', 'upsertSessionEntryCore');
const closeAgents = await native('openclaw-agent-db-lifecycle-', 'closeOpenClawAgentDatabasesAsync');
const closeState = await native('openclaw-state-db-cache-', 'closeOpenClawStateDatabaseAsync');
const scope = { agentId: 'main', sessionKey: 'agent:main:fixture:owner-proof' };
const entry = {
  sessionId: 'native-owner-session', lifecycleRevision: 'native-owner-revision',
  pluginOwnerId: 'owner-one', updatedAt: Date.now(), sessionRoot: state,
};
const checks = [];
try {
  await upsert(scope, entry);
  const proof = await capture({ ...scope, expectedSessionEntry: { ...entry }, matchGeneration: false });
  assert.equal(proof.isCurrent(), true);
  assert.equal(typeof proof.assertCurrent.prepareSessionSource, 'function');
  checks.push('full worker projection admits the exact owner with native source authority');
  await upsert(scope, { ...entry, pluginOwnerId: 'owner-two' });
  assert.equal(proof.isCurrent(), false);
  assert.throws(() => proof.assertCurrent());
  checks.push('owner-only native upsert invalidates the live guard with unchanged SID/revision');
  await assert.rejects(capture({ ...scope, expectedSessionEntry: { ...entry } }));
  checks.push('initial worker read refuses a stale owner');
  await upsert(scope, entry);
  const incarnation = await capture({ ...scope, expectedSessionEntry: { ...entry } });
  await upsert(scope, { ...entry, lifecycleRevision: 'replacement-revision' });
  assert.equal(incarnation.isCurrent(), false);
  checks.push('lifecycle replacement invalidates the native live guard');
} finally {
  try {
    await closeAgents();
  } finally {
    await closeState();
  }
}
const evidence = path.join(state, 'result.json');
await fs.writeFile(evidence, JSON.stringify({ ...identity, checks }, null, 2));
console.log(JSON.stringify({ passed: checks.length, evidence }));
