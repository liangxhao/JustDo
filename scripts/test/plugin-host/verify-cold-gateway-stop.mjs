// Execute the current EngineManager method bodies against disposable process doubles.
// No process is launched or signalled; timers are advanced by this probe.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { transformSync } from 'esbuild';

const source = transformSync(
  await readFile('src/main/openclaw/runtime/openclawEngineManager.ts', 'utf8'),
  { loader: 'ts', target: 'es2022' },
).code;
const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const declaration = syntax.body
  .map(item => item.declaration ?? item)
  .find(item => item.type === 'ClassDeclaration' && item.id.name === 'OpenClawEngineManager');
assert.ok(declaration);
const names = [
  'withStoppedGatewayForMutation',
  'stopGateway',
  'stopGatewayProcess',
  'startGateway',
  'startGatewayOnce',
  'restartGateway',
];
const methods = names
  .map(name => {
    const method = declaration.body.body.find(item => item.key?.name === name);
    assert.ok(method, name);
    return source.slice(method.start, method.end);
  })
  .join('\n');
const schedule = (callback, _delay) => {
  const timer = { active: true };
  queueMicrotask(() => {
    if (timer.active) callback();
  });
  return timer;
};
const cancel = timer => {
  if (timer) timer.active = false;
};
const Probe = new Function(
  'setTimeout',
  'clearTimeout',
  'OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE',
  `return class Probe {${methods}};`,
)(schedule, cancel, { type: 'fixture-shutdown' });
const fresh = child =>
  Object.assign(new Probe(), {
    gatewayProcess: child,
    expectedGatewayExits: new WeakSet(),
    gatewayMutationLease: false,
    startGatewayPromise: null,
    restartGatewayPromise: null,
    shutdownRequested: false,
    applicationShuttingDown: false,
    gatewayRestartTimer: null,
    resolveRuntimeMetadata: () => ({ root: 'fixture', version: 'fixture' }),
    setStatus() {},
    getStatus: () => ({ phase: 'ready' }),
    doStartGateway: async () => {
      throw new Error('Start must be fenced');
    },
  });
class Child extends EventEmitter {
  pid = -1;
  exitCode = null;
  connected = false;
  constructor(exits) {
    super();
    this.exits = exits;
  }
  kill() {
    if (this.exits) {
      this.exitCode = 0;
      this.emit('exit', 0);
    }
    return this.exits;
  }
}
const checks = {};
const ordinary = new Child(true);
const manager = fresh(ordinary);
await manager.withStoppedGatewayForMutation(async () => {
  checks.operationRunsAfterConfirmedExit = ordinary.exitCode === 0;
  await manager.startGateway();
  await manager.startGatewayOnce();
  await manager.restartGateway();
  checks.startsRemainFencedDuringMutation = manager.gatewayMutationLease;
});
checks.leaseReleasesAfterSuccess = manager.gatewayMutationLease === false;
for (const name of ['startGatewayPromise', 'restartGatewayPromise']) {
  const lateChild = new Child(true);
  const pending = fresh(null);
  pending[name] = Promise.resolve().then(() => {
    pending.gatewayProcess = lateChild;
    return pending.getStatus();
  });
  await pending.withStoppedGatewayForMutation(async () => {
    checks[`${name}DrainsBeforeMutation`] = lateChild.exitCode === 0;
  });
}
const immortal = new Child(false);
const unknown = fresh(immortal);
let effects = 0;
let rejected = false;
try {
  await unknown.withStoppedGatewayForMutation(async () => {
    effects++;
  });
} catch {
  rejected = true;
}
checks.unconfirmedExitVetoesMutation = rejected && effects === 0;
checks.unconfirmedProcessIdentityRemainsFenced = unknown.gatewayProcess === immortal;
await unknown.startGateway();
await unknown.startGatewayOnce();
await unknown.restartGateway();
checks.unconfirmedRetirementBlocksLaterStarts = unknown.gatewayMutationUnresolved === true;
immortal.exitCode = 0;
await unknown.withStoppedGatewayForMutation(async () => {
  effects++;
});
checks.exactConfirmedRetirementAllowsRetry =
  effects === 1 && unknown.gatewayMutationUnresolved === false;
const previousUnknownChild = new Child(false);
const previouslyStopped = fresh(previousUnknownChild);
try {
  await previouslyStopped.stopGateway();
} catch {
  /* A strict ordinary stop may reject safely. */
}
let priorEffects = 0;
let priorRejected = false;
try {
  await previouslyStopped.withStoppedGatewayForMutation(async () => {
    priorEffects++;
  });
} catch {
  priorRejected = true;
}
checks.priorUnconfirmedOrdinaryStopCannotHideLiveOwner = priorRejected && priorEffects === 0;
console.log(JSON.stringify({ actualEngineMethodBodies: true, fakeProcessesOnly: true, checks }));
assert.ok(
  Object.values(checks).every(Boolean),
  'Native package mutation requires observed process retirement',
);
