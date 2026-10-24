import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const { runtimeRoot } = resolveNativeSmokeTarget();
const dist = path.join(runtimeRoot, 'dist');
// Resolve the actual frozen protocol owner rather than copying its schemas into a mock.
const owners = fs.readdirSync(dist).filter(name => /^src-.*\.mjs$/.test(name)).map(name => ({
  file: path.join(dist, name), source: fs.readFileSync(path.join(dist, name), 'utf8'),
})).filter(owner => owner.source.includes('const validateChatHistoryParams =') &&
  owner.source.includes('const validateWorktreesGcParams ='));
assert.equal(owners.length, 1, 'The frozen native Gateway protocol owner must be unambiguous.');
const owner = owners[0];
const exported = owner.source.slice(owner.source.lastIndexOf('export {'));
const aliases = new Map([...exported.matchAll(/\b(validate[A-Za-z]+) as ([\w$]+)/g)]
  .map(match => [match[1], match[2]]));
const protocol = await import(pathToFileURL(owner.file).href);
function validate(name, value) {
  const validator = protocol[aliases.get(name)];
  assert.equal(typeof validator, 'function', `Native validator missing: ${name}`);
  return { valid: validator(value), errors: validator.errors };
}

// Representative requests used by the product, plus the changed 10.6 fields.
// This layer checks native wire acceptance; domain tests separately prove response/identity semantics.
const accepted = [
  ['ChatHistory', { sessionKey: 'agent:main:chat', limit: 100, toolResultMaxChars: 500_000 }],
  ['ChatStartup', { sessionKey: 'agent:main:chat', toolResultMaxChars: 1 }],
  ['ChatMessageGet', { sessionKey: 'agent:main:chat', sessionId: 'physical-session', messageId: 'entry', maxChars: 8_000_000 }],
  ['AgentWait', { runId: 'run', timeoutMs: 0 }],
  ['SessionsCreate', { key: 'agent:main:chat', agentId: 'main', idempotencyKey: 'prepare' }],
  ['SessionsDescribe', { key: 'agent:main:chat' }],
  ['SessionsList', {}],
  ['SessionsPatch', { key: 'agent:main:chat', model: 'configured/model' }],
  ['ConfigGet', {}],
  ['ConfigPatch', { raw: '{}', baseHash: 'confirmed-hash' }],
  ['CronList', { includeDisabled: true, limit: 100 }],
  ['CronRuns', { id: 'job', limit: 50 }],
  ['CronRun', { id: 'job', mode: 'force' }],
  ['PluginsList', {}],
  ['PluginsInspect', { pluginId: 'agent-team' }],
  ['PluginsSetEnabled', { pluginId: 'agent-team', enabled: false }],
  ['SkillsWorkshopList', { agentId: 'main' }],
  ['SkillsWorkshopChanges', { agentId: 'main', limit: 500, beforeMs: 0 }],
  ['SkillsWorkshopRead', { name: 'skill', filePath: 'SKILL.md', versionId: 'version' }],
  ['SkillsWorkshopArchive', { name: 'skill', reason: 'User requested archive' }],
  ['SkillsWorkshopRestore', { name: 'skill', versionId: 'explicit-version' }],
  ['WorktreesList', {}],
  ['WorktreesGc', {}],
  ['WorktreesGc', { jobId: 'same-job' }],
  ['WorktreesRemove', { id: 'worktree', ifLossless: true }],
  ['WorktreesRestore', { id: 'worktree' }],
  ['TerminalAttach', { sessionId: 'native-terminal' }],
  ['TerminalInput', { sessionId: 'native-terminal', data: 'x' }],
  ['TerminalResize', { sessionId: 'native-terminal', cols: 80, rows: 24 }],
  ['TerminalClose', { sessionId: 'native-terminal' }],
];
for (const [family, value] of accepted) {
  test(`native ${family} accepts product request ${JSON.stringify(value)}`, () => {
    const result = validate(`validate${family}Params`, value);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
}

const rejected = [
  ['ChatHistory', { sessionKey: 'agent:main:chat', toolResultMaxChars: 0 }],
  ['ChatHistory', { sessionKey: 'agent:main:chat', toolResultMaxChars: 500_001 }],
  ['ChatHistory', { sessionKey: 'agent:main:chat', limit: 1001 }],
  ['ChatMessageGet', { sessionKey: 'agent:main:chat', messageId: 'entry', maxChars: 8_000_001 }],
  ['ChatMessageGet', { sessionKey: 'agent:main:chat', messageId: 'entry', sessionId: '' }],
  ['AgentWait', { runId: 'run', timeoutMs: -1 }],
  ['AgentWait', { runId: '' }],
  ['SessionsDescribe', {}],
  ['SessionsCreate', { key: 'agent:main:chat', surface: 'invented-surface' }],
  ['ConfigPatch', { raw: '{}', unrecognized: true }],
  ['CronRun', { id: 'job', mode: 'invented-mode' }],
  ['PluginsSetEnabled', { pluginId: 'agent-team', enabled: 'false' }],
  ['SkillsWorkshopRead', { proposalId: 'retired-proposal' }],
  ['SkillsWorkshopArchive', { name: 'skill', proposalId: 'retired-proposal' }],
  ['SkillsWorkshopRestore', { name: 'skill', expectedRevision: 'old-proposal-CAS' }],
  ['SkillsWorkshopChanges', { limit: 501 }],
  ['WorktreesGc', { jobId: '' }],
  ['WorktreesGc', { jobId: 'job', repeatedSubmission: true }],
  ['WorktreesRestore', { id: '' }],
  ['TerminalAttach', { sessionKey: 'agent:main:chat' }],
  ['TerminalResize', { sessionId: 'terminal', cols: 0, rows: 24 }],
];
for (const [family, value] of rejected) {
  test(`native ${family} rejects invalid or retired request ${JSON.stringify(value)}`, () => {
    assert.equal(validate(`validate${family}Params`, value).valid, false);
  });
}
