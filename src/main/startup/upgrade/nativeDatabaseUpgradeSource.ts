/** Executed only by the admitted bundled Node. Native owners retain SQL, backup, and lease authority. */
export const NATIVE_DATABASE_UPGRADE_SOURCE = String.raw`
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const input = JSON.parse(process.argv[1]);
const { runtimeRoot, stateDir, configPath, operation, identity, contract, expectedInventory } =
  input;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cancelled = new AbortController();
process.on('message', (message) => {
  if (message?.type === 'abort')
    cancelled.abort(new Error('Database maintenance was interrupted.'));
});
process.on('disconnect', () =>
  cancelled.abort(new Error('Database maintenance lost its application owner.')),
);
const current = () => cancelled.signal.throwIfAborted();
const send = (value) => {
  if (process.connected) process.send(value);
};
const progress = (activity) => {
  current();
  send({ type: 'activity', activity });
};
const unsupported = (message) => Object.assign(new Error(message), { code: input.unsupportedCode });
const nativeFailureCode = (error) => {
  const pending = [error];
  const visited = new Set();
  while (pending.length && visited.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (typeof current.code === 'string' && input.nativeFailureCodes.includes(current.code))
      return current.code;
    // node:sqlite exposes a numeric primary/extended result in errcode, independently of its text.
    if (current.code === 'ERR_SQLITE_ERROR' && Number.isSafeInteger(current.errcode) &&
        current.errcode > 0 && current.errcode < 2 ** 31) {
      const code = { 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED', 8: 'SQLITE_READONLY',
        13: 'SQLITE_FULL', 14: 'SQLITE_CANTOPEN' }[current.errcode & 255];
      if (code) return code;
    }
    pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 16));
  }
};
assert.ok(['inspect', 'upgrade', 'prepare'].includes(operation));
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(identity.executable));
assert.equal(
  hash(fs.readFileSync(path.join(runtimeRoot, 'runtime-patch-manifest.json'))),
  identity.manifestSha256,
);
const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
assert.equal('v' + pkg.version, contract.openclawVersion);
assert.deepEqual(pkg.openclaw.schemaVersions, contract.schemaVersions);
assert.equal(process.env.OPENCLAW_STATE_DIR, stateDir);
assert.equal(process.env.OPENCLAW_CONFIG_PATH, configPath);
const modules = new Map();
async function native(role, symbol) {
  current();
  const selected = contract.modules[role];
  assert.ok(selected?.exports[symbol], 'Native database owner contract is incomplete.');
  const file = path.join(runtimeRoot, selected.path);
  const source = fs.readFileSync(file);
  assert.equal(hash(source), selected.sha256, 'Native database owner bytes changed.');
  const tail = source.toString('utf8').slice(source.lastIndexOf('\nexport {'));
  for (const [name, alias] of Object.entries(selected.exports)) {
    const exports = [
      ...tail.matchAll(new RegExp('\\b' + name + '(?: as ([\\w$]+))?\\s*[,}]', 'g')),
    ];
    assert.equal(exports.length, 1, 'Native database export must be unique.');
    assert.equal(exports[0][1] ?? name, alias, 'Native database export binding changed.');
  }
  if (!modules.has(role)) modules.set(role, await import(pathToFileURL(file).href));
  current();
  const value = modules.get(role)[selected.exports[symbol]];
  assert.equal(typeof value, 'function', 'Native database export is not callable.');
  return value;
}
const prepare = await native('schemaContracts', 'prepareOpenClawDatabaseSchemaContracts');
prepare();
const preflight = await native('preflight', 'prepareDoctorDatabasePreflight');
const fullPreflight = await native('readiness', 'preflightOpenClawDatabaseSchemas');
const ready = await native('readiness', 'assertOpenClawDatabasesReady');
const readScope = await native('readScope', 'withSqliteReadOnlyWorkerScope');
const closeAgents = await native('agentLifecycle', 'closeOpenClawAgentDatabasesAsync');
const closeState = await native('stateLifecycle', 'closeOpenClawStateDatabaseAsync');
const statePath = (await native('paths', 'resolveOpenClawStateSqlitePath'))(process.env);
const configBytes = fs.existsSync(configPath) ? fs.readFileSync(configPath) : undefined;
// Application-managed configuration is JSON. This owner never repairs or rewrites configuration.
const cfg = configBytes ? JSON.parse(configBytes.toString('utf8')) : {};
const assertConfig = () => {
  current();
  assert.equal(
    fs.existsSync(configPath),
    configBytes !== undefined,
    'Configuration changed during native inspection.',
  );
  if (configBytes)
    assert.ok(
      fs.readFileSync(configPath).equals(configBytes),
      'Configuration changed during native maintenance.',
    );
};
const fileIdentity = (file) => {
  const realPath = fs.realpathSync.native(file);
  const stat = fs.lstatSync(file, { bigint: true });
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n,
    'Native database must be an owned regular file.',
  );
  return { path: path.resolve(file), realPath, dev: String(stat.dev), ino: String(stat.ino) };
};
const inventoryKey = (rows) =>
  JSON.stringify(
    rows
      .map(({ agentId, path, realPath, dev, ino }) => ({ agentId, path, realPath, dev, ino }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
function assertInspection(report) {
  if (report.incompatible.length)
    throw unsupported('A newer native database cannot be downgraded.');
  assert.deepEqual(report.indeterminate, [], 'An unknown native database cannot be upgraded.');
  assert.deepEqual(report.agentRefusals ?? [], [], 'Native database ownership was refused.');
  assert.deepEqual(
    report.deferredSchemaPublications ?? [],
    [],
    'Native schema publication is not settled.',
  );
  for (const row of report.pendingMigrations ?? []) {
    if (
      !contract.sourceSchemaVersions[row.kind === 'state' ? 'state' : 'agent'].includes(
        row.foundVersion,
      )
    )
      throw unsupported(
        'This native database generation is outside the supported normal-upgrade range.',
      );
    assert.equal(
      row.supportedVersion,
      contract.schemaVersions[row.kind === 'state' ? 'state' : 'agent'],
    );
  }
}
async function inspect(strict) {
  assertConfig();
  progress('nativeInspect');
  const report = await preflight({ cfg, preserveSourceArtifacts: true });
  assertConfig();
  assertInspection(report);
  const discovery = report.agentDatabaseMigrationDiscovery?.discovery;
  assert.deepEqual(discovery?.failures ?? [], [], 'Native database inventory is incomplete.');
  assert.deepEqual(
    discovery?.unverifiedTargets ?? [],
    [],
    'Native database inventory contains an unknown owner.',
  );
  const targets = discovery?.targets ?? [];
  const inventory = targets.map((target) => ({
    agentId: target.agentId,
    ...fileIdentity(target.path),
  }));
  if (fs.existsSync(statePath)) inventory.push({ agentId: null, ...fileIdentity(statePath) });
  else assert.equal(targets.length, 0, 'Agent history exists without its shared native state.');
  const needsUpgrade = (report.pendingMigrations?.length ?? 0) > 0;
  if (strict || !needsUpgrade) {
    const full = await fullPreflight(
      {
        env: process.env,
        preserveSourceArtifacts: true,
        verifyCurrentSchemaShape: true,
        requireStartupMigrationReadiness: true,
        agentAdmissionConfig: cfg,
        configuredAgentDatabaseTargets: targets,
      },
      'maintenance',
    );
    assertInspection(full);
    assert.deepEqual(full.pendingMigrations ?? [], [], 'Native schema upgrade did not finish.');
  }
  assertConfig();
  return { report, targets, inventory, needsUpgrade };
}
let result;
let failure;
try {
  await readScope(
    async () => {
      const initial = await inspect(false);
      if (operation === 'inspect') {
        result = {
          needsUpgrade: initial.needsUpgrade,
          inventory: initial.inventory,
          verified: !initial.needsUpgrade,
        };
        return;
      }
      if (expectedInventory)
        assert.equal(
          inventoryKey(initial.inventory),
          inventoryKey(expectedInventory),
          'Native database inventory changed after routing.',
        );
      if (operation === 'prepare') {
        assert.equal(initial.needsUpgrade, false, 'Native schema must be current before canonical preparation.');
        if (!initial.inventory.length) {
          result = { needsUpgrade: false, inventory: [], verified: true };
          return;
        }
      }
      const lock = await native('maintenanceLock', 'withDoctorSqliteMaintenanceLock');
      const paths = initial.inventory.map((row) => row.path);
      await closeAgents();
      await closeState();
      current();
      await lock({
        env: process.env,
        operation: operation === 'prepare' ? 'native session canonical preparation' : 'native database schema upgrade',
        protectedPaths: paths.flatMap((file) => [
          file,
          file + '-wal',
          file + '-shm',
          file + '-journal',
        ]),
        run: async (authority) => {
          const locked = await inspect(false);
          assert.equal(
            inventoryKey(locked.inventory),
            inventoryKey(initial.inventory),
            'Native database inventory changed before exclusive maintenance.',
          );
          const scope = (await native('resourceScope', 'getOpenClawDatabaseMaintenanceScope'))();
          assert.ok(scope?.ownsSchemaMaintenance, 'Native exclusive maintenance scope is missing.');
          scope.addAgentSchemaMigrationCheck(() => {
            current();
            authority.assertCurrent();
            assertConfig();
          });
          if (operation === 'prepare') {
            assert.equal(locked.needsUpgrade, false, 'Native schema changed before canonical preparation.');
            const lease = await native('lease', 'withAgentDatabaseMaintenanceLease');
            const certify = await native('canonicalValidation', 'certifySessionCanonicalValidationPending');
            const withWorker = await native('canonicalWorker', 'withSqliteCanonicalValidationWorker');
            let backedUp = false;
            const assertSource = () => {
              authority.assertCurrent();
              assertConfig();
              assert.equal(
                inventoryKey(initial.inventory.map((row) => ({ agentId: row.agentId, ...fileIdentity(row.path) }))),
                inventoryKey(initial.inventory),
                'Native database physical identity changed during canonical preparation.',
              );
            };
            const inspectFleet = async () => {
              assertSource();
              const checked = await inspect(true);
              assert.equal(inventoryKey(checked.inventory), inventoryKey(initial.inventory),
                'Native database fleet changed during canonical preparation.');
              assertSource();
              return checked;
            };
            const probe = async (maintenance) => {
              let needsWork = false;
              const undispatched = new Error('Canonical preparation requires a native worker.');
              const assertOwned = () => { assertSource(); maintenance.assertOwned(); };
              for (const target of locked.targets) {
                assertOwned();
                try {
                  // The unique sentinel is thrown before worker creation or canonical mutation.
                  await certify({ agentId: target.agentId, path: target.path, env: process.env },
                    async () => { needsWork = true; throw undispatched; }, assertOwned);
                } catch (error) {
                  if (error !== undispatched) throw error;
                }
                assertOwned();
              }
              return needsWork;
            };
            await lease({ env: process.env, schemaPolicy: 'existing', processBound: true }, async (maintenance) => {
              await inspectFleet();
              if (await probe(maintenance)) {
                progress('nativeBackup');
                const backup = await native('backup', 'backupDoctorSqliteDatabases');
                const saved = await backup({ env: process.env, pendingDatabasePaths: paths,
                  databasePaths: paths, authority, requireSnapshots: true });
                assert.deepEqual(saved.warnings ?? [], [], 'Native database backup did not complete.');
                for (const file of paths.map((file) => fs.realpathSync.native(file)))
                  assert.ok(saved.snapshots?.some((row) => row.sourcePath === file),
                    'A verified native database backup is missing.');
                maintenance.assertOwned();
                await inspectFleet();
                backedUp = true;
              }
              maintenance.assertOwned();
              assertSource();
            });
            // Ordinary native workers intentionally cannot borrow the maintenance lease.
            // Release it normally; the Gateway/Doctor state lock remains held throughout.
            await inspectFleet();
            progress('nativeUpgrade');
            await withWorker(async (useWorker) => {
              for (const target of locked.targets) {
                assertSource();
                await certify({ agentId: target.agentId, path: target.path, env: process.env },
                  async (...args) => {
                    assert.ok(backedUp, 'Canonical mutation requires a complete pre-operation backup.');
                    assertSource();
                    return useWorker(...args);
                  }, assertSource);
                assertSource();
              }
            });
            // The whole worker scope has joined before exclusive post-operation validation.
            progress('nativeVerify');
            await lease({ env: process.env, schemaPolicy: 'existing', processBound: true }, async (maintenance) => {
              const verified = await inspectFleet();
              assert.equal(await probe(maintenance), false, 'Native canonical preparation did not settle.');
              await ready({ env: process.env, config: cfg, operation: 'doctor',
                configuredAgentDatabaseTargets: verified.targets });
              maintenance.assertOwned();
              assertSource();
              if (backedUp) {
                const complete = await native('backupCompletion', 'completeDoctorMigrationBackups');
                complete(process.env, paths);
              }
              maintenance.assertOwned();
              assertSource();
              result = { needsUpgrade: false, inventory: verified.inventory, verified: true };
            });
            return;
          }
          const maintain = async (maintenance) => {
            const admitted = await inspect(false);
            assert.equal(
              inventoryKey(admitted.inventory),
              inventoryKey(locked.inventory),
              'Native inventory changed before maintenance lease admission.',
            );
            current();
            authority.assertCurrent();
            maintenance?.assertOwned();
            if (locked.needsUpgrade) {
              progress('nativeBackup');
              const backup = await native('backup', 'backupDoctorSqliteDatabases');
              const saved = await backup({
                env: process.env,
                pendingDatabasePaths: paths,
                databasePaths: paths,
                authority,
                requireSnapshots: true,
              });
              current();
              authority.assertCurrent();
              assertConfig();
              assert.deepEqual(
                saved.warnings ?? [],
                [],
                'Native database backup did not complete.',
              );
              const expected = new Set(paths.map((file) => fs.realpathSync.native(file)));
              for (const file of expected)
                assert.ok(
                  saved.snapshots?.some((row) => row.sourcePath === file),
                  'A verified native database backup is missing.',
                );
              progress('nativeUpgrade');
              current();
              authority.assertCurrent();
              assertConfig();
              const migrate = await native(
                'migration',
                'migrateOpenClawAgentDatabaseForMaintenance',
              );
              const register = await native('registry', 'registerOpenClawAgentDatabase');
              const clearFailure = await native('agent', 'clearOpenClawAgentDatabaseOpenFailure');
              for (const target of locked.targets) {
                current();
                authority.assertCurrent();
                maintenance.assertOwned();
                assertConfig();
                await migrate({ agentId: target.agentId, pathname: target.path }, maintenance);
                current();
                authority.assertCurrent();
                maintenance.assertOwned();
                assertConfig();
                // The native migration validates exact owner/schema before its caller publishes registration.
                assert.ok(
                  clearFailure(target.path, { env: process.env }),
                  'Native quarantine clearance was not confirmed.',
                );
                register({ agentId: target.agentId, path: target.path, env: process.env });
              }
            }
            progress('nativeVerify');
            const verified = await inspect(true);
            assert.equal(
              inventoryKey(verified.inventory),
              inventoryKey(initial.inventory),
              'Native database inventory changed during schema upgrade.',
            );
            await ready({
              env: process.env,
              config: cfg,
              operation: 'doctor',
              configuredAgentDatabaseTargets: verified.targets,
            });
            assertConfig();
            authority.assertCurrent();
            const complete = await native('backupCompletion', 'completeDoctorMigrationBackups');
            complete(process.env, paths);
            result = { needsUpgrade: false, inventory: verified.inventory, verified: true };
          };
          if (paths.length) {
            const sharedReady = await fullPreflight(
              {
                env: process.env,
                scope: 'state',
                preserveSourceArtifacts: true,
                verifyCurrentSchemaShape: true,
                requireStartupMigrationReadiness: true,
              },
              'maintenance',
            );
            assertInspection(sharedReady);
            assert.deepEqual(
              sharedReady.pendingMigrations ?? [],
              [],
              'Shared native schema is not current.',
            );
            const lease = await native('lease', 'withAgentDatabaseMaintenanceLease');
            // Shared20 is already current. Existing-schema admission excludes agent writers
            // before any backup and stays held through complete-fleet verification.
            await lease(
              { env: process.env, schemaPolicy: 'existing', processBound: true },
              maintain,
            );
          } else await maintain(undefined);
        },
      });
    },
    { signal: cancelled.signal, deadlineOwnedByCaller: true },
  );
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  for (const close of [closeAgents, closeState])
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length)
    failure = new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      'Native database maintenance did not close cleanly.',
    );
}
if (!failure)
  try {
    current();
    assertConfig();
  } catch (error) {
    failure = error;
  }
if (failure) {
  // Native Doctor preflight exposes typed schema refusal records; never classify English messages.
  if (
    Array.isArray(failure.incompatibleDatabases) &&
    failure.incompatibleDatabases.length &&
    failure.incompatibleDatabases.every(
      (row) =>
        ['state', 'agent'].includes(row.kind) &&
        Number.isSafeInteger(row.foundVersion) &&
        row.foundVersion > row.supportedVersion &&
        row.supportedVersion === contract.schemaVersions[row.kind],
    )
  )
    failure = unsupported(failure.message);
  const code = nativeFailureCode(failure);
  send({
    type: 'failure',
    message: failure instanceof Error ? failure.message : 'Native database maintenance failed.',
    ...(code ? { code } : {}),
  });
  process.exitCode = 1;
} else {
  send({
    type: 'result',
    operation,
    identity: { runtimeVersion: identity.runtimeVersion, runtimeBuildId: identity.runtimeBuildId },
    ...result,
  });
}
if (process.connected) process.disconnect();
`;
