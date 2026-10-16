// Opt-in, isolated native SQLite probe. Never imports the Gateway or application configuration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const esbuild = require('esbuild');
const ts = require('typescript');
const shapes = require('../../../../scripts/patches/v2026.10.4/prepared-read-patch-shapes.js');
const patch27 = require('../../../../scripts/patches/v2026.10.4/027-canonical-readiness-owner-path.cjs');
const patch28 = require('../../../../scripts/patches/v2026.10.4/028-prepared-history-response-publication.cjs');
const frozen = process.env.JUSTDO_EXECUTION_RUNTIME;
const pristine = process.env.JUSTDO_EXECUTION_PRISTINE_DIR;
if (!frozen && !pristine)
  throw new Error('Set JUSTDO_EXECUTION_RUNTIME or JUSTDO_EXECUTION_PRISTINE_DIR');
const root = frozen ?? pristine;
const bundle = frozen ? fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8') : undefined;
if (bundle) {
  // These are verification-only calls. Execute the original final bundle functions below.
  assert.equal(patch27.__testing.transform(bundle, 'gateway-bundle.mjs'), bundle);
  assert.equal(patch28.__testing.transform(bundle, 'gateway-bundle.mjs'), bundle);
}
function source(name, patch) {
  if (bundle) return bundle;
  const file = path.join(root, 'dist', name);
  const original = fs.readFileSync(file, 'utf8');
  return patch ? patch.__testing.transform(original, file) : original;
}
const cacheSource = source('openclaw-agent-db-validation-cache-_HDeZNQr.mjs', patch27);
const canonicalSource = source('session-canonical-key-D1TSJMmX.mjs', patch28);
const canonical =
  bundle ?? patch27.__testing.transform(canonicalSource, 'session-canonical-key-D1TSJMmX.mjs');
const handlerSource = source('chat-history-handler-BKMKq528.mjs', patch28);
const preparedSource = source('session-row-prepared-read-XTl_DJgr.mjs');
const functionText = (text, name) => shapes.functionRange(text, name).text;
const workerFile = path.join(root, 'dist', 'state', 'openclaw-state-read.worker.js');
const workerOriginal = fs.readFileSync(workerFile, 'utf8');
const workerSource = frozen
  ? workerOriginal
  : patch27.__testing.transform(workerOriginal, workerFile);
if (frozen) assert.equal(patch27.__testing.transform(workerOriginal, workerFile), workerOriginal);
const workerCode = ['canonicalValidationReceipt', 'deferCanonicalSessionValidation']
  .map(name => functionText(workerSource, name))
  .join('\n');
function aliases(code, values) {
  const result = { ...values };
  for (const [base, value] of Object.entries(values)) {
    const pattern = new RegExp(`^${base}(?:\\d+|\\$\\d+)?$`);
    for (const node of shapes.collect(shapes.parse(code), ts.isIdentifier))
      if (pattern.test(node.text)) result[node.text] = value;
  }
  return result;
}
const cacheNames = [
  'registerOpenClawAgentDatabaseIdentity',
  'readOpenClawAgentDatabaseIdentity',
  'findOpenClawAgentDatabaseIdentity',
  'isOpenClawAgentDatabasePathCurrent',
  'bindValidationLifetime',
  'matchesValidation',
  'hasRevokedOpenClawAgentDatabaseValidation',
  'canonicalValidationReceipt',
  'hasOpenClawAgentCanonicalValidation',
  'markOpenClawAgentCanonicalValidation',
  'createValidationReceipt',
];
const cacheCode = cacheNames.map(name => functionText(cacheSource, name)).join('\n');
const deferralCode = [
  'deferCanonicalSessionValidation',
  'withCanonicalSessionValidationDeferral',
  'assertSessionReadPublicationReady',
]
  .map(name => functionText(canonical, name))
  .join('\n');
const handler = shapes.parse('async ' + functionText(handlerSource, 'handleChatHistoryRequest'))
  .statements[0];
const rawRespond = handler.parameters[0].name.elements.find(
  element => (element.propertyName ?? element.name).getText() === 'respond',
).name.text;
const first = handler.body.statements[0];
assert(ts.isVariableStatement(first));
const responseDeclaration = first.declarationList.declarations[0];
const localRespond = responseDeclaration.name.text;
const wrapperCode = `function wrap(${rawRespond}) { const ${responseDeclaration.getText()}; return ${localRespond}; }`;
// The raw incoming response function is used only by the checked wrapper; all original
// validation, sharing and permission callbacks continue to receive its local binding.
assert.equal(
  shapes.collect(handler.body, ts.isIdentifier).filter(node => node.text === rawRespond).length,
  1,
);

let readyCode = 'async ' + functionText(preparedSource, 'withReadySessionRows');
if (!bundle) {
  // Compile the pristine native dynamic import into an in-memory fixture module. Final-runtime
  // mode never compiles, transforms or repairs a function before executing it.
  const built = await esbuild.build({
    stdin: {
      contents: readyCode + '\nglobalThis.readyFunction = withReadySessionRows;',
      resolveDir: root,
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'iife',
    logLevel: 'silent',
    plugins: [
      {
        name: 'isolated-readiness',
        setup(build) {
          build.onResolve({ filter: /session-canonical-validation-readiness/ }, () => ({
            path: 'readiness',
            namespace: 'probe',
          }));
          build.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({
            contents:
              'export const certifySessionCanonicalValidationPending = (...args) => globalThis.certify(...args);',
          }));
        },
      },
    ],
  });
  readyCode = built.outputFiles[0].text;
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ready-probe-'));
const filename = path.join(directory, 'agent.sqlite');
const namespace = process.platform === 'win32' ? path.toNamespacedPath(filename) : filename;
const database = new DatabaseSync(namespace);
database.exec("CREATE TABLE proof(receipt TEXT); INSERT INTO proof VALUES ('unready')");
const identities = new WeakMap();
const validatedPaths = new Map();
const deferral = {};
const normalize = value =>
  process.platform === 'win32'
    ? value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
    : value;
const signalState = { signal: undefined };
const context = vm.createContext(
  aliases(cacheCode + deferralCode + readyCode + workerCode, {
    path,
    statSync: fs.statSync,
    randomUUID,
    identities,
    validatedPaths,
    validationBindings: new WeakMap(),
    deferral,
    Error,
    process,
    normalizeDatabasePath: normalize,
    readDatabasePathIdentitySync: value => {
      const info = fs.statSync(value, { bigint: true });
      return {
        key: `file:${info.dev}:${info.ino}`,
        birthtime: info.birthtimeNs.toString(),
        canonicalPath: normalize(value),
      };
    },
    registerNodeSqliteDisposeCallback: () => () => {},
    hasPersistedOpenClawAgentCanonicalValidation: owner =>
      owner.db.isOpen &&
      identities.has(owner.db) &&
      owner.db.prepare('SELECT receipt FROM proof').get()?.receipt === 'ready',
    stageSqliteTransactionState: () => {
      throw new Error('Probe must not invent a transaction commit');
    },
    isPromiseLike: value =>
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof value.then === 'function',
    getAsyncWorkSignal: () => signalState.signal,
    CanonicalSessionValidationDeferred: class extends Error {},
  }),
);
vm.runInContext(cacheCode + '\n' + deferralCode + '\n' + wrapperCode, context);
if (bundle) {
  // esbuild's actual import namespace and initializer are dependency boundaries, not rewritten code.
  const imported = /\(\s*(init_[\w$]+)\(\),\s*([\w$]+_exports)\s*\)/.exec(readyCode);
  assert(imported, 'Final bundle native readiness import topology changed');
  context[imported[1]] = () => {};
  context[imported[2]] = {
    certifySessionCanonicalValidationPending: (...args) => context.certify(...args),
  };
  vm.runInContext(readyCode + '\nthis.readyFunction = withReadySessionRows;', context);
} else vm.runInContext(readyCode, context);

const native = vm.runInContext(
  '({registerOpenClawAgentDatabaseIdentity, readOpenClawAgentDatabaseIdentity, canonicalValidationReceipt, hasOpenClawAgentCanonicalValidation, markOpenClawAgentCanonicalValidation, deferCanonicalSessionValidation, withCanonicalSessionValidationDeferral, wrap})',
  context,
);
const owner = { agentId: 'main', db: database, path: filename };
native.registerOpenClawAgentDatabaseIdentity(database);
assert.equal(native.readOpenClawAgentDatabaseIdentity(owner).filename, filename);
let checks = 0;
function seed(ready = false, overrides = {}) {
  validatedPaths.clear();
  const proof = {
    agentId: 'main',
    identity: native.readOpenClawAgentDatabaseIdentity(owner).identity,
    valid: new SharedArrayBuffer(4),
    canonicalReady: new SharedArrayBuffer(4),
    ...overrides,
  };
  Atomics.store(new Int32Array(proof.valid), 0, 1);
  Atomics.store(new Int32Array(proof.canonicalReady), 0, ready ? 1 : 0);
  validatedPaths.set(path.resolve(filename), { validation: proof, integrityVerified: true });
  return proof;
}
try {
  seed(true);
  assert.equal(native.hasOpenClawAgentCanonicalValidation({ agentId: 'main', db: database }), true);
  assert.equal(native.hasOpenClawAgentCanonicalValidation(owner), true);
  checks += 2;
  if (process.platform === 'win32') {
    assert.notEqual(path.resolve(namespace), path.resolve(filename));
    assert.equal(native.canonicalValidationReceipt({ ...owner, path: namespace }), undefined);
    checks += 2;
  }
  for (const invalid of [
    { ...owner, path: path.join(directory, 'foreign.sqlite') },
    { ...owner, agentId: 'other' },
    { agentId: 'main', db: { isOpen: true, isTransaction: false, location: () => namespace } },
    { ...owner, db: { isOpen: false } },
  ]) {
    assert.equal(native.canonicalValidationReceipt(invalid), undefined);
    checks++;
  }
  seed(true, { identity: 'foreign-generation' });
  assert.equal(native.canonicalValidationReceipt(owner), undefined);
  checks++;
  const revoked = seed(true);
  Atomics.store(new Int32Array(revoked.valid), 0, 0);
  assert.equal(native.canonicalValidationReceipt(owner), undefined);
  checks++;
  assert.equal(
    native.withCanonicalSessionValidationDeferral(() =>
      native.deferCanonicalSessionValidation({ agentId: 'main', db: { location: () => null } }),
    ).kind,
    'complete',
  );
  checks++;

  for (const mode of ['success', 'failure', 'abort', 'replaced']) {
    seed(false);
    database.prepare('UPDATE proof SET receipt = ?').run('unready');
    const responses = [];
    let consumed = 0;
    let certified = 0;
    let alive = true;
    const controller = new AbortController();
    signalState.signal = controller.signal;
    const respond = native.wrap((...args) => responses.push(args));
    context.certify = async pending => {
      certified++;
      assert.equal(pending.agentId, 'main');
      assert.equal(pending.path, filename);
      assert.equal(
        native.markOpenClawAgentCanonicalValidation({ ...owner, path: pending.path }),
        true,
      );
      database.prepare('UPDATE proof SET receipt = ?').run('ready');
      if (mode === 'abort') controller.abort(new Error('connection closed'));
      if (mode === 'replaced') alive = false;
    };
    const projection = {
      withPreparedExactRows(_queries, consume) {
        if (!alive) throw new Error('physical session replaced');
        return native.withCanonicalSessionValidationDeferral(() =>
          consume({ permission: 'current' }),
        );
      },
    };
    const operation = context.readyFunction(
      projection,
      () => [],
      read => {
        consumed++;
        assert.equal(read.permission, 'current');
        if (!native.hasOpenClawAgentCanonicalValidation({ agentId: 'main', db: database })) {
          // Native ACP/usage fallback readers can swallow this private readiness signal.
          try {
            native.deferCanonicalSessionValidation({ agentId: 'main', db: database });
          } catch {}
        }
        if (mode === 'failure') respond(false, undefined, { code: 'UNAVAILABLE' });
        else respond(true, { messages: [], sessionKey: 'agent:main:empty' });
      },
    );
    if (mode === 'abort' || mode === 'replaced') {
      await assert.rejects(operation, /connection closed|physical session replaced/);
      assert.equal(responses.length, 0);
      assert.equal(consumed, 1);
    } else {
      await operation;
      assert.equal(consumed, 2);
      assert.equal(responses.length, 1);
      assert.equal(responses[0][0], mode === 'success');
    }
    assert.equal(certified, 1);
    checks += 4;
    signalState.signal = undefined;
  }
  const outside = [];
  native.wrap((...args) => outside.push(args))(false, undefined, { code: 'INVALID_REQUEST' });
  assert.equal(outside.length, 1);
  checks++;
  // The published native state-read worker is an independent compiled copy. Execute its
  // unmodified functions as well, rather than assuming that patching the root chunk covered it.
  vm.runInContext(workerCode, context);
  const workerFunctions = vm.runInContext(
    '({canonicalValidationReceipt, deferCanonicalSessionValidation})',
    context,
  );
  seed(true);
  assert.notEqual(
    workerFunctions.canonicalValidationReceipt({ agentId: 'main', db: database }),
    undefined,
  );
  seed(false);
  const pending = native.withCanonicalSessionValidationDeferral(() => {
    try {
      workerFunctions.deferCanonicalSessionValidation({ agentId: 'main', db: database });
    } catch {}
  });
  assert.equal(pending.kind, 'pending');
  assert.equal(pending.database.path, filename);
  checks += 3;
  console.log(
    JSON.stringify({
      checks,
      finalBundle: Boolean(frozen),
      actualSqlite: true,
      windowsNamespace: process.platform === 'win32',
      workerCovered: true,
    }),
  );
} finally {
  database.close();
  // Every path is created under this probe's fixed absolute temporary directory.
  for (const name of fs.readdirSync(directory)) fs.rmSync(path.join(directory, name));
  fs.rmdirSync(directory);
}
