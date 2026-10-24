import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const patch = require('../../../../scripts/patches/v2026.10.6/_execution-settled-publication.js');
const { extractNativeFunction } = require('../../../../scripts/openclaw/native-support-contract.cjs');
const { findMatchingDelimiter } = require('../../../../scripts/patches/v2026.10.6/_patch-utils.js');
const root = path.resolve(process.argv[2]);
const dist = path.join(root, 'dist');
const nativeGraphRoot = path.resolve(process.argv[3] ?? root);
const nativeDist = path.join(nativeGraphRoot, 'dist');
const frozenGraph = process.argv[4] === '--frozen-graph';
let runtimeIdentity;
if (frozenGraph) {
  const { resolveNativeSmokeTarget } = await import('../../runtime/native-smoke-target.mjs');
  runtimeIdentity = resolveNativeSmokeTarget(nativeGraphRoot).identity;
}
const fixtureRoot = path.resolve('.agent-tasks/runtime/publication-owner');
fs.mkdirSync(fixtureRoot, { recursive: true });
const fixture = fs.mkdtempSync(path.join(fixtureRoot, 'probe-'));
for (const key of Object.keys(process.env))
  if (/^OPENCLAW_/i.test(key) || /^(NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete process.env[key];
Object.assign(process.env, { OPENCLAW_HOME: fixture, OPENCLAW_STATE_DIR: path.join(fixture, 'state'),
  OPENCLAW_CONFIG_PATH: path.join(fixture, 'config.json'), HOME: fixture, USERPROFILE: fixture });
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, '2026.10.6');
assert.equal(JSON.parse(fs.readFileSync(path.join(nativeGraphRoot, 'package.json'), 'utf8')).version, '2026.10.6');
function owner(prefix, declaration, directory = nativeDist) {
  const files = fs.readdirSync(directory).filter(name => new RegExp(`^${prefix}-[\\w-]+\\.mjs$`).test(name) &&
    fs.readFileSync(path.join(directory, name), 'utf8').includes(`function ${declaration}(`));
  assert.equal(files.length, 1, declaration);
  return path.join(directory, files[0]);
}
function get(module, name) {
  const matches = Object.values(module).filter(value => typeof value === 'function' && value.name === name);
  assert.equal(matches.length, 1, name);
  return matches[0];
}
const sourceFile = owner('agent-events', 'reserveAgentTerminalEvent', frozenGraph ? nativeDist : dist);
const original = fs.readFileSync(sourceFile, 'utf8');
if (frozenGraph) patch.assertExecutionSettledPublication(original, sourceFile);
const patched = frozenGraph ? original : patch.transformExecutionSettledPublication(original, sourceFile);
const source = patched.replace(/from "(\.\/[^"\n]+)"/g,
  (_match, relative) => `from ${JSON.stringify(pathToFileURL(path.resolve(nativeDist, relative)).href)}`);
const events = await import(`data:text/javascript;base64,${Buffer.from(source + '\n//# sourceURL=execution-settled-publication-native-owner.mjs').toString('base64')}`);
const registry = await import(pathToFileURL(owner('agent-run-registry', 'registerAgentRunContext')).href);
const termination = await import(pathToFileURL(owner('run-termination', 'resolveAgentRunErrorLifecycleFields')).href);
const outcomes = await import(pathToFileURL(owner('agent-run-terminal-outcome', 'buildAgentRunTerminalOutcomeFromLifecycleEvent')).href);
const normalization = await import(pathToFileURL(owner('agent-run-terminal-outcome', 'classifyAgentRunTerminalOutcome')).href);
const lifecycleBody = extractNativeFunction(fs.readFileSync(owner('agent-command', 'createAgentCommandLifecycle', frozenGraph ? nativeDist : dist), 'utf8'),
  'createAgentCommandLifecycle', findMatchingDelimiter).body;
// Execute the unmodified native producer. Error display formatting has no
// bearing on its actual executionSettled/abort fields or publication custody.
const createLifecycle = vm.runInNewContext(`(${lifecycleBody})`, {
  emitAgentEvent: get(events, 'emitAgentEvent'), formatLifecycleError: error => String(error),
});
const rows = [];
let captures = [];
const stop = get(events, 'onAgentRuntimeEvent')(event => {
  const admitted = event.admitLifecyclePublication();
  captures.push({ data: event.data, admitted, secondAdmission: event.admitLifecyclePublication(),
    sessionId: event.sessionId, sessionKey: event.sessionKey });
});
function scenario(name, run) {
  get(events, 'resetAgentEventsForTest')();
  // resetAgentEventsForTest also drops listeners; restore the one publisher.
  get(events, 'onAgentRuntimeEvent')(event => {
    const admitted = event.admitLifecyclePublication();
    captures.push({ data: event.data, admitted, secondAdmission: event.admitLifecyclePublication(),
      sessionId: event.sessionId, sessionKey: event.sessionKey });
  });
  captures = [];
  run();
  assert(captures.every(row => row.secondAdmission === false), 'one admission per actual event');
  rows.push({ name, captures: structuredClone(captures) });
}
function identity(runId = 'publication-fixture') {
  return { runId, sessionKey: 'agent:main:publication-fixture', sessionId: 'session-one',
    agentId: 'main',
    lifecycleGeneration: get(events, 'getAgentEventLifecycleGeneration')() };
}
function emit(id, data) { return get(events, 'emitAgentEventIfCurrent')({ ...id, stream: 'lifecycle', data }); }
const cancel = { phase: 'end', status: 'cancelled', aborted: true, stopReason: 'rpc' };
const settled = { phase: 'error', executionSettled: true, aborted: true, stopReason: 'aborted' };
try {
  scenario('native producer cancellation settles exactly once after ordinary cancel', () => {
    const id = identity();
    get(registry, 'registerAgentRunContext')(id.runId, id);
    emit(id, { phase: 'start', startedAt: 1 });
    const reservation = get(events, 'reserveAgentTerminalEvent')(id);
    reservation(cancel);
    const controller = new AbortController();
    controller.abort(new Error('fixture stop'));
    const lifecycle = createLifecycle({ runId: id.runId, lifecycleGeneration: () => id.lifecycleGeneration,
      startedAt: 1, state: { lifecycleEnded: false, lifecycleFinishing: false } });
    lifecycle.emitBasicError(new Error('fixture transport closed'),
      get(termination, 'resolveAgentRunErrorLifecycleFields')(new Error('fixture transport closed'), controller.signal));
    emit(id, settled);
    emit(id, { phase: 'finishing', executionSettled: true });
    emit(id, { phase: 'start', startedAt: 2, executionSettled: true });
    assert.deepEqual(captures.map(row => row.admitted), [true, true, true, false, false, false]);
    const terminal = captures[2];
    assert.equal(terminal.data.executionSettled, true);
    assert.equal(terminal.data.aborted, true);
    assert.equal(terminal.data.stopReason, 'aborted');
    const outcome = get(outcomes, 'buildAgentRunTerminalOutcomeFromLifecycleEvent')({ phase: terminal.data.phase,
      data: terminal.data, endedAt: Date.now() });
    assert.equal(get(normalization, 'classifyAgentRunTerminalOutcome')(outcome), 'cancellation');
  });
  scenario('a reentrant whole terminal wins before the reserved cancel', () => {
    const id = identity();
    get(registry, 'registerAgentRunContext')(id.runId, id);
    const reservation = get(events, 'reserveAgentTerminalEvent')(id);
    emit(id, settled);
    reservation(cancel);
    emit(id, settled);
    assert.deepEqual(captures.map(row => row.admitted), [true, false, false]);
  });
  scenario('only exact whole end or error can consume the reserved settlement', () => {
    const id = identity();
    get(registry, 'registerAgentRunContext')(id.runId, id);
    get(events, 'reserveAgentTerminalEvent')(id)(cancel);
    emit(id, { phase: 'error', executionSettled: 'true' });
    emit(id, { phase: 'error', executionSettled: false });
    emit(id, { phase: 'end' });
    emit(id, { phase: 'finishing', executionSettled: true });
    emit(id, { phase: 'end', executionSettled: true });
    emit(id, { phase: 'end', executionSettled: true });
    assert.deepEqual(captures.map(row => row.admitted), [true, false, false, false, false, true, false]);
  });
  for (const field of ['sessionId', 'sessionKey', 'agentId']) {
    scenario(`a pending cancellation cannot authorize a different ${field}`, () => {
      const id = { ...identity(), agentId: 'main' };
      get(registry, 'registerAgentRunContext')(id.runId, id);
      get(events, 'reserveAgentTerminalEvent')(id)(cancel);
      emit({ ...id, [field]: 'replacement-identity' }, settled);
      emit(id, settled);
      assert.deepEqual(captures.map(row => row.admitted), [true, false, true]);
    });
  }
  scenario('a cleared context cannot supply implicit gateway generation to late settlement', () => {
    const id = { ...identity(), agentId: 'main' };
    get(events, 'withAgentRunLifecycleGeneration')(id.lifecycleGeneration, () => {
      get(registry, 'registerAgentRunContext')(id.runId, id);
      get(events, 'reserveAgentTerminalEvent')(id)(cancel);
      get(registry, 'clearAgentRunContext')(id.runId);
      const withoutGeneration = { ...id };
      delete withoutGeneration.lifecycleGeneration;
      emit(withoutGeneration, settled);
      emit(id, settled);
    });
    assert.deepEqual(captures.map(row => row.admitted), [true, false, true]);
  });
  for (const field of ['context', 'sessionId']) {
    scenario(`an unknown native ${field} cannot establish a late-settlement exception`, () => {
      const id = identity();
      if (field !== 'context') {
        const context = { ...id };
        delete context.sessionId;
        get(registry, 'registerAgentRunContext')(id.runId, context);
      }
      get(events, 'reserveAgentTerminalEvent')(id)(cancel);
      emit(id, settled);
      assert.deepEqual(captures.map(row => row.admitted), [true, false]);
    });
  }
  scenario('multiple reservations cannot duplicate cancel or whole settlement', () => {
    const id = identity();
    get(registry, 'registerAgentRunContext')(id.runId, id);
    const first = get(events, 'reserveAgentTerminalEvent')(id);
    const second = get(events, 'reserveAgentTerminalEvent')(id);
    second(cancel);
    first(cancel);
    emit(id, settled);
    emit(id, settled);
    assert.deepEqual(captures.map(row => row.admitted), [false, true, true, false]);
  });
  scenario('settled reserved callback consumes its own pending marker', () => {
    const id = identity();
    get(registry, 'registerAgentRunContext')(id.runId, id);
    get(events, 'reserveAgentTerminalEvent')(id)(settled);
    emit(id, settled);
    get(events, 'reserveAgentTerminalEvent')(id)(cancel);
    emit(id, settled);
    assert.deepEqual(captures.map(row => row.admitted), [true, false, false, false]);
  });
  scenario('unreserved ordinary terminal preserves the original dedupe contract', () => {
    const id = identity();
    get(registry, 'registerAgentRunContext')(id.runId, id);
    emit(id, { phase: 'end' });
    emit(id, settled);
    assert.deepEqual(captures.map(row => row.admitted), [true, false]);
  });
  scenario('normal native producer requires no reservation and preserves one terminal', () => {
    const id = identity();
    get(registry, 'registerAgentRunContext')(id.runId, id);
    emit(id, { phase: 'start', startedAt: 1 });
    const lifecycle = createLifecycle({ runId: id.runId, lifecycleGeneration: () => id.lifecycleGeneration,
      startedAt: 1, state: { lifecycleEnded: false, lifecycleFinishing: false } });
    lifecycle.emitBasicError(new Error('fixture failure'));
    get(events, 'reserveAgentTerminalEvent')(id)(cancel);
    emit(id, settled);
    assert.deepEqual(captures.map(row => row.admitted), [true, true, false, false]);
  });
  scenario('replaced registration cannot borrow the old pending reservation', () => {
    const id = identity();
    get(events, 'withAgentRunLifecycleGeneration')(id.lifecycleGeneration, () => {
      get(registry, 'registerAgentRunContext')(id.runId, id);
      const oldOwner = get(registry, 'getAgentRunContext')(id.runId);
      const reservation = get(events, 'reserveAgentTerminalEvent')(id);
      get(registry, 'clearAgentRunContext')(id.runId);
      get(registry, 'registerAgentRunContext')(id.runId, { ...id, sessionId: 'replacement-session' });
      reservation(cancel);
      get(events, 'emitAgentEventForRunContext')({ ...id, stream: 'lifecycle', data: settled }, oldOwner);
    });
    assert.equal(captures.length, 0);
    emit({ ...id, sessionId: 'replacement-session' }, settled);
    assert.deepEqual(captures.map(row => row.admitted), [true]);
  });
  scenario('exclusive claims continue to reject unclaimed reservation and event', () => {
    const id = identity();
    const claim = get(registry, 'claimAgentRunContext')(id.runId, id,
      { exclusive: true, trackOwner: true, ownsContext: true });
    assert(claim);
    get(events, 'reserveAgentTerminalEvent')(id)(cancel);
    assert.equal(emit(id, settled), false);
    get(events, 'emitAgentEventForOwner')({ ...id, stream: 'lifecycle', data: settled }, claim);
    get(events, 'emitAgentEventForOwner')({ ...id, stream: 'lifecycle', data: settled }, claim);
    assert.deepEqual(captures.map(row => row.admitted), [true, false]);
    get(registry, 'clearAgentRunContext')(id.runId, id.lifecycleGeneration, claim);
    get(registry, 'releaseAgentRunContext')(id.runId, claim);
    const before = captures.length;
    get(events, 'emitAgentEventForOwner')({ ...id, stream: 'lifecycle', data: settled }, claim);
    assert.equal(captures.length, before);
  });
  scenario('gateway lifecycle rotation retires a pending reservation', () => {
    const id = identity();
    get(registry, 'registerAgentRunContext')(id.runId, id);
    const reservation = get(events, 'reserveAgentTerminalEvent')(id);
    get(events, 'rotateAgentEventLifecycleGeneration')();
    reservation(cancel);
    assert.equal(emit(id, settled), false);
    assert.equal(captures.length, 0);
    const next = identity();
    assert(get(registry, 'claimAgentRunContext')(next.runId, next, { ownsContext: true, trackOwner: true }));
    emit(next, settled);
    assert.deepEqual(captures.map(row => row.admitted), [true]);
  });
  console.log(JSON.stringify({ nativeVersion: '2026.10.6', sourceFile, nativeGraphRoot,
    evidence: frozenGraph ? 'strict-frozen-artifact-native-graph' : 'source-native-graph-diagnostic',
    runtimeIdentity, scenarios: rows }));
} finally {
  stop();
  get(events, 'resetAgentEventsForTest')();
  assert.equal(path.dirname(fixture), fixtureRoot);
  fs.rmSync(fixture, { recursive: true, force: true });
}
