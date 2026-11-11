// Explicit prepared-runtime probe. Synthetic state only; never starts Gateway or a model.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), '../../..');
const runtimeRoot = path.resolve(process.argv[2] ?? 'vendor/openclaw-runtime/current');
const executable = path.join(runtimeRoot, 'node-runtime/node.exe');
const syntheticSessionKey = 'agent:main:storage-relocation-fixture';
const syntheticSessionId = 'storage-relocation-fixture';
const installedSkillId = 'relocation-installed-skill';
const externalSkillId = 'relocation-bundled-skill';
const syntheticMessage =
  'Synthetic relocation history preserved through the public native accessor.';
const contract = JSON.parse(
  await fs.readFile(
    path.join(repository, 'src/main/startup/upgrade/nativeDatabaseContract.json'),
    'utf8',
  ),
);
const relocationContract = JSON.parse(
  await fs.readFile(path.join(repository, 'src/main/storage/relocationNativeContract.json'), 'utf8'),
);
async function native(role, symbol) {
  const entry = contract.modules[role] ?? relocationContract.modules[role];
  return (await import(pathToFileURL(path.join(runtimeRoot, entry.path)).href))[
    entry.exports[symbol]
  ];
}
if (process.argv[3] === 'rebuild-skills-fixture') {
  const state = process.argv[4];
  Object.assign(process.env, {
    OPENCLAW_HOME: state,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
    OPENCLAW_NO_RESPAWN: '1',
  });
  const bundled = process.argv[5];
  const installed = path.join(state, 'extensions/relocation-installed-skill');
  const { r: resolvePluginSkillRoots } = await import(
    pathToFileURL(path.join(runtimeRoot, 'dist/plugin-skills-CFNC_I3s.mjs')).href
  );
  const ids = ['relocation-bundled-skill', 'relocation-installed-skill'];
  const roots = resolvePluginSkillRoots({
    workspaceDir: path.dirname(state),
    config: { plugins: { allow: ids, load: { paths: [bundled, installed] },
      entries: Object.fromEntries(ids.map(id => [id, { enabled: true }])) } },
    pluginSkillsDir: path.join(state, 'plugin-skills'),
  });
  for (const [index, directory] of [bundled, installed].entries()) {
    assert.ok(roots.some(root => root.dir === path.join(directory, 'skills')));
    const link = path.join(state, 'plugin-skills', ids[index]);
    assert.equal(await fs.readlink(link), path.join(directory, 'skills', ids[index]));
    assert.equal(await fs.readFile(path.join(link, 'SKILL.md'), 'utf8'), `# ${ids[index]}\n`);
  }
} else if (process.argv[3] === 'install-fixture-index' || process.argv[3] === 'check-fixture-index') {
  const stateDir = process.argv[4];
  const external = process.argv[5];
  const originalInstalled = process.argv[6];
  const configPath = path.join(stateDir, 'openclaw.json');
  Object.assign(process.env, {
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: '1',
  });
  (await native('schemaContracts', 'prepareOpenClawDatabaseSchemaContracts'))();
  const installed = path.join(stateDir, 'extensions', installedSkillId);
  if (process.argv[3] === 'install-fixture-index') {
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
    cfg.plugins.load = { paths: [installed, external] };
    cfg.plugins.allow = [installedSkillId, externalSkillId];
    await fs.writeFile(configPath, JSON.stringify(cfg));
    const refresh = await native('pluginIndexWrite', 'refreshPersistedInstalledPluginIndexWithReceipt');
    await refresh({ stateDir, config: cfg, reason: 'manual', installRecords: {
      [installedSkillId]: { source: 'path', sourcePath: external, installPath: installed, version: '1.0.0' },
      [externalSkillId]: { source: 'path', sourcePath: originalInstalled, installPath: external, version: '1.0.0' },
    } });
  }
  const read = await native('pluginRecords', 'readPersistedInstalledPluginIndexInstallRecords');
  const records = read({ stateDir });
  assert.equal(records[installedSkillId].installPath, installed);
  assert.equal(records[installedSkillId].sourcePath, external);
  assert.equal(records[externalSkillId].installPath, external);
  assert.equal(records[externalSkillId].sourcePath, installed);
  const peerLink = path.join(installed, 'node_modules/openclaw');
  if (installed === originalInstalled) {
    assert.equal(await fs.readlink(peerLink), path.join(path.dirname(external), 'retired-openclaw-runtime'));
    await assert.rejects(fs.realpath(peerLink), { code: 'ENOENT' });
  } else {
    assert.equal(await fs.realpath(peerLink), await fs.realpath(runtimeRoot));
  }
  const { i: loadInstalledPluginIndex } = await import(pathToFileURL(
    path.join(runtimeRoot, 'dist/installed-plugin-index-Do8faFKa.mjs')).href);
  const cfg = createRequire(path.join(runtimeRoot, 'package.json'))('json5').parse(await fs.readFile(configPath, 'utf8'));
  const index = loadInstalledPluginIndex({ stateDir, config: cfg });
  assert.ok(index.plugins.some(plugin => plugin.pluginId === installedSkillId && plugin.rootDir === installed),
    'Native discovery must select the current installed package root.');
  await (await native('stateLifecycle', 'closeOpenClawStateDatabaseAsync'))();
} else if (process.argv[3] === 'fixture' || process.argv[3] === 'read-fixture') {
  const state = process.argv[4];
  Object.assign(process.env, {
    OPENCLAW_HOME: state,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
    OPENCLAW_NO_RESPAWN: '1',
  });
  if (process.argv[3] === 'fixture') {
    await fs.mkdir(state, { recursive: true });
    const project = path.join(path.resolve(state, '../..'), 'project');
    if (process.env.STORAGE_RELOCATION_PLUGIN_FIXTURES === '1') await fs.mkdir(project);
    await fs.writeFile(
      process.env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        agents: { ownership: 'explicit',
          ...(process.env.STORAGE_RELOCATION_PLUGIN_FIXTURES === '1' ? {
            defaults: { workspace: path.join(state, 'agent-workspaces'), cwd: project },
          } : {}),
          entries: { main: process.env.STORAGE_RELOCATION_PLUGIN_FIXTURES === '1'
            ? { workspace: path.join(state, 'agent-workspaces/main'), cwd: project } : {} } },
        plugins: { allow: [], entries: {} },
        update: { checkOnStart: false, auto: { enabled: false } },
      }),
    );
  }
  (await native('schemaContracts', 'prepareOpenClawDatabaseSchemaContracts'))();
  const accessor = await import(
    pathToFileURL(path.join(runtimeRoot, 'dist/session-accessor-DHlzhHwY.mjs')).href
  );
  const scope = { agentId: 'main', sessionKey: syntheticSessionKey, env: process.env };
  if (process.argv[3] === 'fixture') {
    const created = await accessor.createSessionEntryWithTranscript(scope, () => ({
      ok: true,
      entry: { sessionId: syntheticSessionId, updatedAt: Date.now() },
    }));
    assert.equal(created.ok, true);
    const appended = await accessor.appendTranscriptMessage(
      { ...scope, sessionId: syntheticSessionId },
      { message: { role: 'assistant', content: [{ type: 'text', text: syntheticMessage }] } },
    );
    assert.equal(appended.appended, true);
  }
  const entry = await accessor.loadSessionEntry(scope);
  assert.equal(entry.sessionId, syntheticSessionId);
  const events = await accessor.loadTranscriptEvents({ ...scope, sessionId: syntheticSessionId });
  assert.ok(
    events.some(
      event =>
        event.type === 'message' &&
        event.message?.role === 'assistant' &&
        event.message.content?.some(part => part.type === 'text' && part.text === syntheticMessage),
    ),
  );
  await (
    await native('agentLifecycle', 'closeOpenClawAgentDatabasesAsync')
  )();
  await (
    await native('stateLifecycle', 'closeOpenClawStateDatabaseAsync')
  )();
} else {
  assert.equal(
    path.resolve(process.execPath),
    executable,
    'Run this explicit probe with the bundled Node.',
  );
  const buildRoot = path.join(repository, 'build');
  await fs.mkdir(buildRoot, { recursive: true });
  const fixtureRoots = [];
  const createFixtureRoot = async (parent, prefix) => {
    const resolvedParent = await fs.realpath(parent);
    const directory = await fs.mkdtemp(path.join(resolvedParent, prefix));
    assert.equal(path.dirname(directory), resolvedParent);
    fixtureRoots.push(directory);
    return directory;
  };
  let evidence;
  try {
    evidence = await runProbe(buildRoot, createFixtureRoot);
  } finally {
    for (const directory of fixtureRoots.reverse()) {
      try {
        // Only remove the exact directories created by this probe.
        assert.equal(await fs.realpath(directory), directory);
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
      } catch (error) {
        console.error(`Could not remove relocation probe fixture ${directory}:`, error);
        process.exitCode = 1;
      }
    }
  }
  const evidenceRoot = await fs.mkdtemp(path.join(buildRoot, 'storage-relocation-probe-'));
  const result = { root: evidenceRoot, ...evidence };
  await fs.writeFile(path.join(evidenceRoot, 'evidence.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}

async function runProbe(buildRoot, createFixtureRoot) {
  const require = createRequire(path.join(repository, 'package.json'));
  const { build } = require('esbuild');
  const output = await createFixtureRoot(buildRoot, 'storage-relocation-work-');
  const modulePath = path.join(output, 'owners.cjs');
  await build({
    stdin: {
      contents: `export { NativeRelocationSource } from ${JSON.stringify(path.join(repository, 'src/main/storage/relocationNativeRuntime.ts'))};
export { admitNativeDatabaseRuntime } from ${JSON.stringify(path.join(repository, 'src/main/startup/upgrade/nativeDatabaseIdentity.ts'))};
export { copyRelocationFiles, verifySourceManifest } from ${JSON.stringify(path.join(repository, 'src/main/storage/relocationFiles.ts'))};
export { readStorageLocator, writeStorageLocator, writeStorageRootIdentity, readRelocationJournal, writeRelocationJournal } from ${JSON.stringify(path.join(repository, 'src/main/storage/relocationState.ts'))};
export { executeStorageRelocation } from ${JSON.stringify(path.join(repository, 'src/main/storage/relocationTransaction.ts'))};
export { readStorageProcessIdentity, assertStorageProcessesRetired } from ${JSON.stringify(path.join(repository, 'src/main/storage/relocationProcessRetirement.ts'))};
export { NativeDatabaseUpgradeRuntime } from ${JSON.stringify(path.join(repository, 'src/main/startup/upgrade/nativeDatabaseUpgradeRuntime.ts'))};`,
      resolveDir: repository,
      loader: 'ts',
    },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'cjs',
    outfile: modulePath,
  });
  const {
    NativeRelocationSource,
    NativeDatabaseUpgradeRuntime,
    admitNativeDatabaseRuntime,
    copyRelocationFiles,
    verifySourceManifest,
    readStorageLocator,
    writeStorageLocator,
    writeStorageRootIdentity,
    readRelocationJournal,
    writeRelocationJournal,
    executeStorageRelocation,
    readStorageProcessIdentity,
    assertStorageProcessesRetired,
  } = require(modulePath);
  const { extractFile } = require('@electron/asar');
  const admit = root =>
    admitNativeDatabaseRuntime(root, {
      readArchiveModule: async (archive, member) => extractFile(archive, member),
    });
  const sourceRoot = await createFixtureRoot(os.tmpdir(), 'storage-relocation-source-');
  const targetContainer = process.env.STORAGE_RELOCATION_TARGET_PARENT
    ? await createFixtureRoot(process.env.STORAGE_RELOCATION_TARGET_PARENT, 'storage-relocation-probe-')
    : output;
  const targetRoot = path.join(targetContainer, 'target');
  const stateDir = path.join(sourceRoot, 'openclaw/state');
  const snapshotDir = path.join(output, 'snapshots');
  await fs.mkdir(snapshotDir);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, [script, runtimeRoot, 'fixture', stateDir], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', code =>
      code === 0 ? resolve() : reject(new Error('Native fixture initialization failed.')),
    );
  });
  const pluginFixtures = process.env.STORAGE_RELOCATION_PLUGIN_FIXTURES === '1';
  const bundledSkillFixture = path.join(output, 'bundled-skill-fixture');
  const sourceInstalledSkill = path.join(stateDir, 'extensions', installedSkillId);
  const pluginIndexFixture = (operation, state) => new Promise((resolve, reject) => {
    const child = spawn(executable, [script, runtimeRoot, operation, state, bundledSkillFixture, sourceInstalledSkill], {
      stdio: 'inherit', windowsHide: true, env: { ...process.env, XDG_CACHE_HOME: output },
    });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Native plugin install index fixture failed.')));
  });
  const pluginReceipt = JSON.stringify({ roomId: 'room', discussionId: 'batch', fingerprint: 'a'.repeat(64),
    owner: randomUUID(), state: 'unknown', executions: [{ discussionId: 'batch', agentId: 'alice',
      sessionKey: 'agent:alice:agent-team:group:room', sessionId: 'native-id', lifecycleRevision: 'revision',
      runId: 'exact-run', outcome: 'running' }], cleanupComplete: false, settledRunIds: [], interrupted: true,
    publicReferences: [{ agentId: 'alice', sessionId: 'native-id', entryId: 'public-entry' }] });
  if (pluginFixtures) {
    for (const pluginId of ['agent-team', 'swarm-workflow']) {
      const directory = path.join(stateDir, 'plugin-data', pluginId);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, '.owner.json'), JSON.stringify({ schemaVersion: 1,
        pluginId, dataId: randomUUID(), retention: 'retain' }));
    }
    const receiptDirectory = path.join(stateDir, 'plugin-data/agent-team/discussion-receipts');
    await fs.mkdir(receiptDirectory);
    await fs.writeFile(path.join(receiptDirectory, 'batch.json'), pluginReceipt);
    if (process.argv[3] === 'transaction') {
      const links = path.join(stateDir, 'plugin-skills');
      await fs.mkdir(links);
      for (const [id, directory] of [
        ['relocation-bundled-skill', bundledSkillFixture],
        ['relocation-installed-skill', path.join(stateDir, 'extensions/relocation-installed-skill')],
      ]) {
        const skill = path.join(directory, 'skills', id);
        await fs.mkdir(skill, { recursive: true });
        await fs.writeFile(path.join(skill, 'SKILL.md'), `# ${id}\n`);
        if (id === installedSkillId) {
          await fs.link(path.join(skill, 'SKILL.md'), path.join(directory, 'companion.md'));
          await fs.mkdir(path.join(directory, 'node_modules'));
          await fs.symlink(path.join(output, 'retired-openclaw-runtime'), path.join(directory, 'node_modules/openclaw'),
            process.platform === 'win32' ? 'junction' : 'dir');
        }
        await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: id, version: '1.0.0',
          type: 'module', peerDependencies: { openclaw: '*' }, openclaw: { extensions: ['./index.js'] } }));
        await fs.writeFile(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({ id,
          skills: ['./skills'], configSchema: { type: 'object', properties: {} } }));
        await fs.writeFile(path.join(directory, 'index.js'), "throw new Error('Metadata discovery must not execute plugin code');\n");
        const link = path.join(links, id);
        await fs.symlink(skill, link, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const dangling = path.join(links, 'missing-skill');
      const absent = path.join(output, 'absent-skill');
      await fs.symlink(absent, dangling, process.platform === 'win32' ? 'junction' : 'dir');
      await pluginIndexFixture('install-fixture-index', stateDir);
      await fs.appendFile(path.join(stateDir, 'openclaw.json'), '\n// Native JSON5 configuration fixture.\n');
    }
  }
  const profileId = randomUUID();
  const sourceRootId = randomUUID();
  const targetRootId = randomUUID();
  writeStorageRootIdentity(sourceRoot, { version: 1, profileId, rootId: sourceRootId });
  const locator = {
    version: 1,
    profileId,
    revision: 1,
    activeRoot: sourceRoot,
    activeRootId: sourceRootId,
  };
  writeStorageLocator(sourceRoot, locator, null);
  await fs.writeFile(
    path.join(sourceRoot, 'project-fixture.txt'),
    'Cross-volume synthetic file fixture.',
  );
  await fs.mkdir(targetRoot);
  writeStorageRootIdentity(targetRoot, { version: 1, profileId, rootId: targetRootId });
  const sourceVolume = (await fs.stat(sourceRoot, { bigint: true })).dev.toString();
  const targetVolume = (await fs.stat(targetRoot, { bigint: true })).dev.toString();
  const crossVolume = sourceVolume !== targetVolume;
  assert.equal(
    crossVolume,
    true,
    'This explicit probe requires different source temp and target build volumes.',
  );
  if (process.argv[3] === 'transaction') {
    const cleanupFixtures = {
      cache: 'GPUCache/synthetic-cache',
      protectedProject: 'local-speech-models/selected-project/deliverable.txt',
      mediaOriginal: 'openclaw/state/media/outgoing/originals/synthetic-original',
    };
    for (const relative of Object.values(cleanupFixtures)) {
      const filename = path.join(sourceRoot, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, 'Synthetic old-copy cleanup fixture.');
    }
    const transactionId = randomUUID();
    await fs.mkdir(path.join(sourceRoot, 'storage-relocation'), { recursive: true });
    writeRelocationJournal(sourceRoot, {
      version: 1,
      transactionId,
      profileId,
      sourceRoot,
      targetRoot,
      sourceRootId,
      targetRootId,
      sourceRevision: 1,
      stage: 'source-retired',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cleanShutdown: {
        pid: process.pid,
        transactionId,
        completedAt: Date.now(),
        processes: [],
      },
    });
    const sources = [];
    const targets = [];
    const observedIdentities = [];
    const nativeScratchDiagnostics = [];
    const transferDirectories = [];
    let snapshotVolume;
    let snapshotFiles = 0;
    const observeSpawn =
      original =>
      (...args) => {
        assert.equal(
          typeof original,
          'function',
          'The real transaction tracked spawn must be used.',
        );
        const [command, parameters, settings] = args;
        const stagingModule = pathToFileURL(
          path.join(runtimeRoot, 'dist/sqlite-snapshot-staging-DY9qNrgZ.mjs'),
        ).href;
        // Probe-only metadata witness: root still prepends its real admission handshake first.
        const diagnostic = `const __probeStaging=(await import(${JSON.stringify(stagingModule)})).m();
const __probeFs=await import('node:fs');
process.send({type:'storage-probe-scratch',pid:process.pid,cacheRoot:process.env.XDG_CACHE_HOME,stagingRoot:__probeStaging,
volume:String(__probeFs.statSync(__probeStaging,{bigint:true}).dev)});\n`;
        const workerSource = parameters[2].replace(
          "send({ type: 'failure', ...relocationNativeFailureDetails(",
          "send({ type: 'storage-probe-failure', message: String(failure?.message ?? cancelled.signal.reason).slice(0, 1000) }); send({ type: 'failure', ...relocationNativeFailureDetails(",
        );
        const child = original(
          command,
          [...parameters.slice(0, 2), diagnostic + workerSource, ...parameters.slice(3)],
          settings,
        );
        child.on('message', value => {
          if (value?.type === 'storage-probe-scratch') nativeScratchDiagnostics.push(value);
          if (value?.type === 'storage-probe-failure') console.error(value.message);
        });
        const recorded = readRelocationJournal(sourceRoot).maintenanceProcesses.findLast(
          row => row.pid === child.pid,
        );
        const actual = readStorageProcessIdentity(child.pid);
        assert.deepEqual(
          recorded,
          actual,
          'Every child must be durably bound to its actual OS creation time.',
        );
        observedIdentities.push(actual);
        return child;
      };
    await executeStorageRelocation({
      bootstrapRoot: sourceRoot,
      runtimeRoot,
      signal: new AbortController().signal,
      getProtectedPaths: () => ({
        directories: [path.dirname(path.join(sourceRoot, cleanupFixtures.protectedProject))],
        files: [],
      }),
      createSource: settings => {
        transferDirectories.push(settings.snapshotDir);
        assert.equal(path.dirname(settings.snapshotDir), path.dirname(targetRoot));
        const source = new NativeRelocationSource({
          ...settings,
          admit,
          spawn: observeSpawn(settings.spawn),
        });
        sources.push(source);
        return source;
      },
      prepareTarget: async (root, destination, signal, trackedSpawn, relocationPlugins) => {
        snapshotVolume = (await fs.stat(transferDirectories[0], { bigint: true })).dev.toString();
        assert.equal(snapshotVolume, targetVolume);
        snapshotFiles = (await fs.readdir(transferDirectories[0])).filter(name =>
          name.endsWith('.sqlite'),
        ).length;
        assert.ok(snapshotFiles >= 3);
        const targetState = path.join(destination, 'openclaw/state');
        const target = new NativeDatabaseUpgradeRuntime({
          getRuntimeRoot: () => root,
          stateDir: targetState,
          configPath: path.join(targetState, 'openclaw.json'),
          gatewayStopped: () => true,
          admit,
          spawn: observeSpawn(trackedSpawn),
          relocationPlugins,
        });
        targets.push(target);
        const abort = () => {
          void target.stop().catch(() => {});
        };
        signal?.addEventListener('abort', abort, { once: true });
        try {
          await target.prepareCanonical();
        } finally {
          signal?.removeEventListener('abort', abort);
          await target.stop();
          assert.equal(target.retirementConfirmed, true);
        }
      },
    });
    const finalJournal = readRelocationJournal(sourceRoot);
    assert.equal(finalJournal.stage, 'activated');
    assert.equal(readStorageLocator(sourceRoot).activeRoot, targetRoot);
    assert.equal(readStorageLocator(sourceRoot).revision, 2);
    assert.equal(finalJournal.maintenanceProcesses.length, 2);
    assert.equal(observedIdentities.length, finalJournal.maintenanceProcesses.length);
    assert.equal(nativeScratchDiagnostics.length, observedIdentities.length);
    for (const diagnostic of nativeScratchDiagnostics) {
      assert.equal(
        diagnostic.volume,
        targetVolume,
        'All private native inspection images must stay on the destination volume.',
      );
      assert.equal(path.dirname(diagnostic.cacheRoot), path.dirname(targetRoot));
      const relative = path.relative(diagnostic.cacheRoot, diagnostic.stagingRoot);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    }
    await assertStorageProcessesRetired(finalJournal.maintenanceProcesses);
    assert.ok(sources.every(source => source.retirementConfirmed));
    assert.ok(targets.every(target => target.retirementConfirmed));
    for (const directory of transferDirectories) {
      await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    }
    assert.equal(
      await fs.readFile(path.join(sourceRoot, 'project-fixture.txt'), 'utf8'),
      'Cross-volume synthetic file fixture.',
    );
    assert.equal(
      await fs.readFile(path.join(targetRoot, 'project-fixture.txt'), 'utf8'),
      'Cross-volume synthetic file fixture.',
    );
    if (pluginFixtures) {
      const targetState = path.join(targetRoot, 'openclaw/state');
      await pluginIndexFixture('check-fixture-index', targetState);
      assert.deepEqual(await fs.readdir(path.join(targetState, 'plugin-skills')), []);
      const companion = 'extensions/relocation-installed-skill/companion.md';
      assert.equal((await fs.stat(path.join(targetState, companion))).nlink, 1);
      assert.equal(await fs.readFile(path.join(targetState, companion), 'utf8'), '# relocation-installed-skill\n');
      await new Promise((resolve, reject) => {
        const child = spawn(executable, [script, runtimeRoot, 'rebuild-skills-fixture', targetState, bundledSkillFixture],
          { stdio: 'inherit', windowsHide: true });
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error('Native skill republication failed.')));
      });
      const targetConfig = JSON.parse(await fs.readFile(path.join(targetState, 'openclaw.json'), 'utf8'));
      assert.deepEqual(targetConfig.plugins.load.paths, [path.join(targetState, 'extensions', installedSkillId), bundledSkillFixture]);
      assert.equal(targetConfig.agents.defaults.cwd, path.join(sourceRoot, 'project'));
      assert.equal(targetConfig.agents.defaults.workspace, path.join(targetState, 'agent-workspaces'));
      assert.equal(await fs.readFile(path.join(targetState, 'plugin-data/agent-team/discussion-receipts/batch.json'), 'utf8'), pluginReceipt);
    }
    const nativeState = 'openclaw/state/agents/main/agent/openclaw-agent.sqlite';
    for (const relative of [cleanupFixtures.cache, 'openclaw']) {
      await assert.rejects(fs.lstat(path.join(sourceRoot, relative)), { code: 'ENOENT' });
    }
    for (const relative of [cleanupFixtures.protectedProject, cleanupFixtures.mediaOriginal, nativeState]) {
      await fs.stat(path.join(targetRoot, relative));
    }
    for (const relative of [cleanupFixtures.protectedProject, 'project-fixture.txt', 'storage-location.json']) {
      await fs.stat(path.join(sourceRoot, relative));
    }
    const readbackCache = path.join(output, 'readback-cache');
    await fs.mkdir(readbackCache);
    await new Promise((resolve, reject) => {
      const reader = spawn(
        executable,
        [script, runtimeRoot, 'read-fixture', path.join(targetRoot, 'openclaw/state')],
        {
          windowsHide: true,
          stdio: 'inherit',
          env: { ...process.env, XDG_CACHE_HOME: readbackCache },
        },
      );
      reader.once('error', reject);
      reader.once('close', code =>
        code === 0 ? resolve() : reject(new Error('Public target transcript readback failed.')),
      );
    });
    return {
      success: true,
      case: 'transaction',
      sourceRoot,
      targetRoot,
      sourceVolume,
      targetVolume,
      snapshotVolume,
      snapshotFiles,
      temporarySnapshotsRemoved: true,
      crossVolume,
      locatorRevision: 2,
      trackedNativeChildren: observedIdentities,
      nativeScratchDiagnostics,
      nativeScratchOnTargetVolume: true,
      publicNativeSyntheticHistoryReadback: true,
      oldOpenClawRemoved: true,
      pluginMetadataPreserved: pluginFixtures,
      generatedSkillLinksRebuilt: pluginFixtures,
      explicitProjectLocationPreserved: pluginFixtures,
      allNativeChildrenRetired: true,
      journalStage: readRelocationJournal(sourceRoot).stage,
    };
  } else {
    const custodian = new NativeRelocationSource({
      runtimeRoot,
      profileRoot: sourceRoot,
      stateDir,
      configPath: path.join(stateDir, 'openclaw.json'),
      snapshotDir,
      admit,
    });
    try {
      const files = await custodian.acquire();
      assert.ok(
        Object.keys(files.replaceFiles).length >= 2,
        'Source fleet snapshots must include state and main.',
      );
      await custodian.assertHeld();
      const peerSnapshots = path.join(output, 'peer-snapshots');
      await fs.mkdir(peerSnapshots);
      const peer = new NativeRelocationSource({
        runtimeRoot,
        profileRoot: sourceRoot,
        stateDir,
        configPath: path.join(stateDir, 'openclaw.json'),
        snapshotDir: peerSnapshots,
        admit,
      });
      await assert.rejects(peer.acquire(), /custody/);
      await peer.abort().catch(() => {});
      await custodian.assertHeld();
      const manifest = await copyRelocationFiles({
        sourceRoot,
        targetRoot,
        replaceFiles: new Map(
          Object.entries(files.replaceFiles).map(([relative, snapshot]) => [
            relative.replace(/\\/g, '/'),
            snapshot,
          ]),
        ),
        excludeRelativePaths: files.excludeRelativePaths,
      });
      assert.equal(
        await fs.readFile(path.join(targetRoot, 'project-fixture.txt'), 'utf8'),
        'Cross-volume synthetic file fixture.',
      );
      const targetState = path.join(targetRoot, 'openclaw/state');
      const target = new NativeDatabaseUpgradeRuntime({
        getRuntimeRoot: () => runtimeRoot,
        stateDir: targetState,
        configPath: path.join(targetState, 'openclaw.json'),
        gatewayStopped: () => true,
        admit,
      });
      assert.equal((await target.inspect()).needsUpgrade, false);
      await target.prepareCanonical();
      await target.stop();
      await verifySourceManifest(manifest);
      await custodian.assertHeld();
      assert.equal(readStorageLocator(sourceRoot).activeRoot, sourceRoot);
      writeStorageLocator(
        sourceRoot,
        { ...locator, revision: 2, activeRoot: targetRoot, activeRootId: targetRootId },
        1,
      );
      await custodian.release();
      assert.equal(readStorageLocator(sourceRoot).activeRoot, targetRoot);
      assert.equal(
        await fs.readFile(path.join(sourceRoot, 'project-fixture.txt'), 'utf8'),
        'Cross-volume synthetic file fixture.',
      );
      return {
        success: true,
        sourceRoot,
        targetRoot,
        sourceVolume,
        targetVolume,
        crossVolume,
        snapshots: Object.keys(files.replaceFiles).length,
        copiedFiles: manifest.entries.filter(row => row.kind === 'file').length,
        targetCanonicalWhileSourceHeld: true,
        locatorRevision: readStorageLocator(sourceRoot).revision,
      };
    } catch (error) {
      await custodian.abort().catch(() => {});
      throw error;
    }
  }
}
