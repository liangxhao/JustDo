'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function verifySqliteModule(modulePath, env) {
  const script = [
    `const Database = require(${JSON.stringify(modulePath)});`,
    "const database = new Database(':memory:');",
    'database.close();',
  ].join('');
  const result = spawnSync(process.execPath, ['-e', script], {
    env, windowsHide: true, encoding: 'utf8',
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(`SQLite test module is incompatible with Node.js ${process.versions.node}: ` +
      (result.error?.message || result.stderr || result.signal || result.status));
  }
}

function prepareSqliteTestModule(projectRoot, env = process.env) {
  if (env.SQLITE_TEST_MODULE) {
    const modulePath = path.resolve(env.SQLITE_TEST_MODULE);
    verifySqliteModule(modulePath, env);
    return { modulePath, dispose() {} };
  }

  const source = path.dirname(require.resolve('better-sqlite3/package.json', { paths: [projectRoot] }));
  const buildRoot = path.join(fs.realpathSync(projectRoot), 'build');
  const dependenciesRoot = path.join(buildRoot, 'test-dependencies');
  const assertParents = () => {
    for (const parent of [buildRoot, dependenciesRoot]) {
      const stat = fs.lstatSync(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(parent) !== parent) {
        throw new Error('SQLite test dependency ancestors changed or are linked.');
      }
    }
  };
  for (const directory of [buildRoot, dependenciesRoot]) {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) {
      throw new Error(`SQLite test preparation requires an ordinary build directory: ${directory}`);
    }
  }
  const directory = fs.mkdtempSync(path.join(dependenciesRoot, 'sqlite-'));
  assertParents();
  const identity = fs.lstatSync(directory, { bigint: true });
  const dispose = () => {
    assertParents();
    if (!fs.existsSync(directory)) return;
    const current = fs.lstatSync(directory, { bigint: true });
    if (path.dirname(directory) !== dependenciesRoot || current.isSymbolicLink() ||
        !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new Error('SQLite test dependency cleanup lost its owned directory.');
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    // Copy the installed package's own JS/native sources, never its Electron build.
    for (const entry of ['package.json', 'binding.gyp', 'lib', 'src', 'deps']) {
      fs.cpSync(path.join(source, entry), path.join(directory, entry), { recursive: true });
    }
    const childEnv = { ...env, npm_config_runtime: 'node', npm_config_target: process.versions.node };
    const run = (script, args) => spawnSync(process.execPath, [script, ...args], {
      cwd: directory, env: childEnv, stdio: 'inherit', windowsHide: true,
    });
    const prebuilt = run(require.resolve('prebuild-install/bin.js'), [
      '--runtime', 'node', '--target', process.versions.node,
      '--platform', process.platform, '--arch', process.arch,
    ]);
    if (prebuilt.error || prebuilt.signal) {
      throw new Error(`SQLite test binary preparation could not complete: ${prebuilt.error?.message || prebuilt.signal}`);
    }
    if (prebuilt.status !== 0) {
      const compiled = run(require.resolve('node-gyp/bin/node-gyp.js'), [
        'rebuild', '--release', '--target', process.versions.node, '--arch', process.arch,
      ]);
      if (compiled.error || compiled.signal || compiled.status !== 0) {
        throw new Error(`SQLite test binary build failed: ${compiled.error?.message || compiled.signal || compiled.status}`);
      }
    }
    const modulePath = path.join(directory, 'lib', 'index.js');
    verifySqliteModule(modulePath, childEnv);
    return { modulePath, dispose };
  } catch (error) {
    try { dispose(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'SQLite test preparation and cleanup failed.');
    }
    throw error;
  }
}

module.exports = { prepareSqliteTestModule, verifySqliteModule };
