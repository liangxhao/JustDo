import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { buildSync } from 'esbuild';
import { beforeAll, expect, test } from 'vitest';

import { SkillWorkshopService } from '../../../src/main/plugins/skills/skillWorkshopService';
import { projectDiagnosticEvent } from '../../../src/main/engine/openclaw/runtimeDiagnostics';

const candidates = [process.env.OPENCLAW_TEST_UPSTREAM_ROOT, process.env.OPENCLAW_SOURCE, path.resolve('../openclaw'), path.resolve('../../../openclaw')].filter(Boolean) as string[];
const upstream = candidates.find(root => fs.existsSync(path.join(root, 'packages/gateway-protocol/src/schema/agents-models-skills.ts')));
const required = process.env.OPENCLAW_REQUIRE_MANAGEMENT_CONTRACTS === '1';
if (required && !upstream) throw new Error('Required real OpenClaw management contract source is unavailable.');
type Native = { check: (schema: string, value: unknown) => boolean;
  retired: Record<string, (invocation: unknown) => unknown>; specs: unknown[][];
  resolveAgentRunLifecycleTerminalFacts: (input: unknown) => Record<string, unknown> };
let native: Native;
beforeAll(() => {
  if (!upstream) return;
  const target = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).openclaw.version.replace(/^v/u, '');
  expect(JSON.parse(fs.readFileSync(path.join(upstream, 'package.json'), 'utf8')).version).toBe(target);
  const source = (relative: string) => JSON.stringify(path.join(upstream, relative).replaceAll('\\', '/'));
  const code = [
    'import { Compile } from "typebox/schema";',
    'import * as skills from ' + source('packages/gateway-protocol/src/schema/agents-models-skills.ts') + ';',
    'import * as cron from ' + source('packages/gateway-protocol/src/schema/cron.ts') + ';',
    'import * as config from ' + source('packages/gateway-protocol/src/schema/config.ts') + ';',
    'import * as plugins from ' + source('packages/gateway-protocol/src/schema/plugins.ts') + ';',
    'import * as hooks from ' + source('packages/gateway-protocol/src/schema/hooks.ts') + ';',
    'import * as worker from ' + source('packages/gateway-protocol/src/schema/worker-admission.ts') + ';',
    'export { resolveAgentRunLifecycleTerminalFacts } from ' + source('packages/normalization-core/src/agent-run-terminal-outcome.ts') + ';',
    'export { CORE_GATEWAY_METHOD_SPECS as specs } from ' + source('src/gateway/methods/core-descriptors.ts') + ';',
    'export { skillsRetiredHandlers as retired } from ' + source('src/gateway/server-methods/skills-retired.ts') + ';',
    'const schemas = {...skills,...cron,...config,...plugins,...hooks,...worker};',
    'export const check=(name,value)=>{if(!schemas[name])throw Error("Missing upstream schema: "+name);return Compile(schemas[name]).Check(value)};',
  ].join('\n');
  const directory = path.resolve('build/upgrade-audit/module-contract-audit');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, 'native-management-contracts.cjs');
  buildSync({ stdin: { contents: code, resolveDir: upstream, loader: 'ts' }, outfile: output,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent' });
  native = createRequire(import.meta.url)(output);
}, 30_000);
const nativeTest = test.skipIf(!upstream);
const inventory = { agentId: 'main', mode: 'off', root: '/native/skills',
  skills: [{ name: 'release', description: 'Release', updatedAtMs: 10, sizeBytes: 5, files: ['SKILL.md'] }],
  archived: [{ name: 'release', live: true, versions: [{ id: 'saved', action: 'patch', createdAtMs: 9 }] }] };
const change = { id: 'c1', agentId: 'main', skillName: 'release', action: 'restore',
  actor: 'user', summary: 'Restored', versionId: 'backup-current', createdAtMs: 11 };

nativeTest('the locked target closed Workshop validators accept all five product RPCs and reject old proposal fields', async () => {
  const values: Record<string, unknown> = {
    List: { agentId: 'main' }, Changes: { agentId: 'main', limit: 200, beforeMs: 10 },
    Read: { agentId: 'main', name: 'release', filePath: 'SKILL.md', versionId: 'saved' },
    Archive: { agentId: 'main', name: 'release', reason: 'Obsolete' },
    Restore: { agentId: 'main', name: 'release', versionId: 'saved' },
  };
  for (const [name, params] of Object.entries(values)) {
    expect(native.check('SkillsWorkshop' + name + 'ParamsSchema', params), name).toBe(true);
    expect(native.check('SkillsWorkshop' + name + 'ParamsSchema', { ...params as object, expectedRevisionHash: 'a'.repeat(64) }), name + ' rejects old CAS').toBe(false);
    expect(native.check('SkillsWorkshop' + name + 'ParamsSchema', { ...params as object, correlationId: 'old-client' }), name + ' rejects old receipt').toBe(false);
  }
  expect(native.check('SkillsWorkshopListResultSchema', inventory)).toBe(true);
  expect(native.check('SkillsWorkshopListResultSchema', { proposals: [] })).toBe(false);
  expect(native.check('SkillsWorkshopChangeResultSchema', { change })).toBe(true);
  expect(native.check('SkillsWorkshopChangesResultSchema', { changes: [change] })).toBe(true);
  expect(native.check('SkillsWorkshopReadResultSchema', { name: 'release', filePath: 'SKILL.md', files: ['SKILL.md'], content: '' })).toBe(true);
  expect(native.check('SkillsWorkshopChangesParamsSchema', { limit: 501 })).toBe(false);
  expect(native.check('SkillsWorkshopArchiveParamsSchema', { name: 'release', reason: '' })).toBe(false);
});

nativeTest('the native tool execution timeout passes its real schema and retains its phase through the app projection', () => {
  const payload = { phase: 'error', endedAt: 100, error: 'Tool execution timed out',
    timeoutPhase: 'tool_execution', stopReason: 'timeout', aborted: true };
  expect(native.check('WorkerLiveEventSchema', { kind: 'lifecycle', payload })).toBe(true);
  expect(native.check('WorkerLiveEventSchema', { kind: 'lifecycle', payload: {
    ...payload, timeoutPhase: 'unknown_tool_phase',
  } })).toBe(false);
  const facts = native.resolveAgentRunLifecycleTerminalFacts({ phase: 'error', data: payload });
  expect(facts).toMatchObject({ reason: 'hard_timeout', status: 'timeout', timeoutPhase: 'tool_execution' });
  const project = (data: Record<string, unknown>) => projectDiagnosticEvent({ event: 'agent', payload: {
    runId: 'native-run', sessionKey: 'native-session', stream: 'lifecycle', data,
  } }, 'connection-epoch');
  expect(project({ ...payload, ...facts, executionSettled: true })?.event).toMatchObject({
    phase: 'error', timeoutPhase: 'tool_execution', stopReason: 'timeout', executionSettled: true,
  });
  expect(project({ ...payload, timeoutPhase: 'unknown_tool_phase' })?.event.timeoutPhase).toBeUndefined();
  expect(project(payload)?.event.executionSettled).toBeUndefined();
});

nativeTest('service outgoing requests and parsed receipts pass the actual target schemas, including the restore backup distinction', async () => {
  const requests: string[] = [];
  const service = new SkillWorkshopService(async (method, params) => {
    const operation = method.split('.').at(-1)!;
    const stem = operation[0].toUpperCase() + operation.slice(1);
    expect(native.check('SkillsWorkshop' + stem + 'ParamsSchema', params)).toBe(true);
    requests.push(method);
    const result = operation === 'list' ? inventory : operation === 'changes' ? { changes: [change] }
      : operation === 'read' ? { name: 'release', filePath: 'SKILL.md', files: ['SKILL.md'], content: 'Complete' }
        : { change: { ...change, action: operation } };
    expect(native.check('SkillsWorkshop' + (operation === 'archive' || operation === 'restore' ? 'Change' : stem) + 'ResultSchema', result)).toBe(true);
    return result as never;
  });
  await service.list('main'); await service.changes({ agentId: 'main' });
  await service.read({ agentId: 'main', name: 'release', versionId: 'saved' });
  await service.archive({ agentId: 'main', name: 'release' });
  expect((await service.restore({ agentId: 'main', name: 'release', versionId: 'saved' })).versionId).toBe('backup-current');
  expect(requests).toEqual(['skills.workshop.list', 'skills.workshop.changes', 'skills.workshop.read', 'skills.workshop.archive', 'skills.workshop.restore']);
});

nativeTest('retired RPCs still appear in the catalog but the actual native handlers reject them with INVALID_REQUEST', async () => {
  const retired = ['skills.proposals.list', 'skills.proposals.inspect', 'skills.proposals.apply', 'skills.proposals.reject'];
  for (const method of retired) {
    expect(native.specs.some(row => row[0] === method)).toBe(true);
    let response: unknown[] | undefined;
    await native.retired[method]({ params: {}, respond: (...args: unknown[]) => { response = args; } });
    expect(response).toEqual([false, undefined, { code: 'INVALID_REQUEST', message: expect.stringContaining('retired') }]);
  }
  const scopes = new Map(native.specs.map(row => [row[0], row[2]]));
  expect(scopes.get('skills.workshop.list')).toBe('operator.read');
  expect(scopes.get('skills.workshop.read')).toBe('operator.read');
  expect(scopes.get('skills.workshop.changes')).toBe('operator.read');
  expect(scopes.get('skills.workshop.archive')).toBe('operator.admin');
  expect(scopes.get('skills.workshop.restore')).toBe('operator.admin');
  const old = execFileSync('git', ['show', 'v2026.10.4:src/gateway/server-methods/skills.ts'],
    { cwd: upstream, encoding: 'utf8', windowsHide: true });
  expect(old).toContain('skills.proposals.list');
});

nativeTest.each([
  ['CronListParamsSchema', { includeDisabled: true, limit: 200, offset: 0, includeDeliveryPreviews: false }],
  ['CronGetParamsSchema', { id: 'job-1' }],
  ['CronRunParamsSchema', { id: 'job-1', mode: 'force' }],
  ['CronRunsParamsSchema', { scope: 'job', id: 'job-1', limit: 20, offset: 0, sortDir: 'desc' }],
  ['CronRemoveParamsSchema', { id: 'job-1' }],
  ['CronUpdateParamsSchema', { id: 'job-1', patch: { enabled: false } }],
  ['ConfigGetParamsSchema', {}],
  ['ConfigPatchParamsSchema', { raw: JSON.stringify({ skills: { workshop: { autonomous: { mode: 'off' } } } }), baseHash: 'native-current-hash' }],
  ['SkillsStatusParamsSchema', { agentId: 'main' }],
  ['HooksStatusParamsSchema', { agentId: 'main' }],
  ['PluginsListParamsSchema', {}],
  ['PluginsRefreshParamsSchema', {}],
  ['PluginsSetEnabledParamsSchema', { pluginId: 'optional-plugin', enabled: false }],
  ['PluginsUninstallParamsSchema', { pluginId: 'optional-plugin', keepFiles: true }],
  ['PluginsReloadParamsSchema', { plugins: [{ pluginId: 'optional-plugin' }], waitForDrain: true }],
])('actual target %s accepts the app request and rejects extra legacy control fields', (schema, params) => {
  expect(native.check(schema, params)).toBe(true);
  expect(native.check(schema, { ...params, migrationMode: 'legacy' })).toBe(false);
});
