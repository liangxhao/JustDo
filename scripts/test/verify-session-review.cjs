// Verifies T03 against a prepared v2026.9.6 Gateway. All sessions and Git data use an isolated temporary directory.
// Usage: node scripts/test/verify-session-review.cjs [runtime-dir] [evidence-json]
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

// Exercise the installed handler with a synthetic session entry and real native Git reads.
// This supplements the real create -> chat.send WS capture below with an unborn
// repository and a changed pre-existing file, without depending on a model run.
async function verifyNativeBaseline(root, workspace) {
  const dist = path.join(root, 'dist');
  const handlerFile = fs.readdirSync(dist).find(name => /^sessions-diff-.*\.mjs$/.test(name));
  const gitFile = fs
    .readdirSync(dist)
    .find(name => /^git-read-operations\.runtime-.*\.mjs$/.test(name));
  assert.ok(handlerFile && gitFile, 'Missing locked native review modules');
  const source = fs.readFileSync(path.join(dist, handlerFile), 'utf8');
  const start = source.indexOf('async function loadSessionDiff(');
  const end = source.indexOf('const sessionsDiffHandlers', start);
  assert.ok(start >= 0 && end > start, 'Native review handler shape changed');
  const { executeGitReadOperation } = await import(pathToFileURL(path.join(dist, gitFile)).href);
  const sessionId = 'review-baseline-instance';
  const baseline = {
    ...(await executeGitReadOperation({ type: 'checkout.baseline', input: { cwd: workspace } })),
    sessionId,
  };
  const before = JSON.stringify(baseline);
  const load = require('node:vm').runInNewContext(`${source.slice(start, end)}; loadSessionDiff`, {
    loadGatewaySessionEntryReadOnly: () => ({
      cfg: {},
      agentId: 'main',
      canonicalKey: 'agent:main:review-baseline',
      storePath: 'synthetic',
      entry: { sessionId, sessionDiffBaseline: baseline, spawnedCwd: workspace },
    }),
    normalizeAgentId: value => value,
    resolveRepositoryWorkspaceAccess: () => undefined,
    normalizeOptionalString: value => value,
    loadCheckoutDiff: async ({ sessionKey, ...input }) => ({
      ...(await executeGitReadOperation({ type: 'checkout.diff', input })),
      sessionKey,
    }),
  });
  for (const scope of ['all', 'uncommitted']) {
    const result = await load({ sessionKey: 'agent:main:review-baseline', scope }, {});
    assert.deepEqual(
      result.files.map(file => file.path),
      [],
      'Unchanged baseline files must be hidden',
    );
  }
  const manual = path.join(workspace, 'manual.txt');
  const original = fs.readFileSync(manual);
  const added = path.join(workspace, 'after-baseline.txt');
  try {
    fs.appendFileSync(manual, 'change after session baseline\n');
    fs.writeFileSync(added, 'new file after session baseline\n');
    for (const scope of ['all', 'uncommitted']) {
      const result = await load({ sessionKey: 'agent:main:review-baseline', scope }, {});
      assert.deepEqual(result.files.map(file => file.path).sort(), [
        'after-baseline.txt',
        'manual.txt',
      ]);
      const patch = result.files.find(file => file.path === 'manual.txt')?.patch;
      assert.ok(patch?.includes('+change after session baseline'));
      assert.ok(
        patch?.includes('+pre-existing manual change'),
        'Native diff retains earlier lines in changed files',
      );
    }
  } finally {
    fs.writeFileSync(manual, original);
    fs.unlinkSync(added);
  }
  assert.equal(JSON.stringify(baseline), before, 'Review mutated the native baseline');
}
(async () => {
  const root = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '../../vendor/openclaw-runtime/current');
  const state = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'review-gateway-'));
  const workspace = path.join(state, '项目 空格');
  fs.mkdirSync(workspace);
  const { execFileSync } = require('node:child_process');
  const git = (...args) =>
    execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true });
  git('init', '-b', 'main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'user.name', 'Review Test');
  git('config', 'user.email', 'review@example.invalid');
  for (const name of ['manual.txt', 'shell.txt', 'edit.txt', 'delete.txt', 'rename.txt'])
    fs.writeFileSync(path.join(workspace, name), name + ' initial\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  git('checkout', '-b', 'feature/review');
  fs.writeFileSync(path.join(workspace, 'committed.txt'), 'committed change\n');
  git('add', '.');
  git('commit', '-m', 'Feature change');
  fs.writeFileSync(path.join(workspace, 'manual.txt'), 'pre-existing manual change\n');
  const token = randomBytes(24).toString('hex');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const ids = [];
  const config = {
    gateway: { mode: 'local', bind: 'loopback', port, auth: { mode: 'token', token } },
    update: { checkOnStart: false, auto: { enabled: false } },
    agents: {
      entries: { main: {} },
      defaults: {
        workspace,
        systemAgent: { agentId: 'main' },
        skipBootstrap: true,
        model: { primary: 'review-fixture/review-fixture' },
        utilityModel: 'review-fixture/review-fixture',
      },
    },
    // A deliberately non-model loopback endpoint prevents real provider calls.
    models: {
      mode: 'replace',
      providers: {
        'review-fixture': {
          baseUrl: `http://127.0.0.1:${port}/review-fixture/v1`,
          apiKey: 'test-key',
          api: 'openai-completions',
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: 'review-fixture',
              name: 'Review fixture',
              reasoning: false,
              input: ['text'],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    plugins: { allow: ids, entries: Object.fromEntries(ids.map(id => [id, { enabled: true }])) },
  };
  fs.writeFileSync(path.join(state, 'openclaw.json'), JSON.stringify(config));
  process.env.OPENCLAW_HOME = state;
  process.env.OPENCLAW_STATE_DIR = state;
  process.env.OPENCLAW_CONFIG_PATH = path.join(state, 'openclaw.json');
  process.env.OPENCLAW_NO_RESPAWN = '1';
  await verifyNativeBaseline(root, workspace);
  const unborn = path.join(state, 'no-commits');
  fs.mkdirSync(unborn);
  execFileSync('git', ['init', '-b', 'main'], { cwd: unborn, windowsHide: true });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: unborn, windowsHide: true });
  fs.writeFileSync(path.join(unborn, 'manual.txt'), 'pre-existing manual change\n');
  await verifyNativeBaseline(root, unborn);
  const child = spawn(
    process.execPath,
    [
      path.join(root, 'openclaw.mjs'),
      'gateway',
      'run',
      '--allow-unconfigured',
      '--port',
      String(port),
    ],
    { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', b => {
    output += b;
  });
  child.stderr.on('data', b => {
    output += b;
  });
  let client;
  const deadline = setTimeout(() => {
    child.kill();
  }, 90_000);
  try {
    const started = Date.now();
    while (Date.now() - started < 60000) {
      if (child.exitCode !== null) throw new Error('Gateway exited: ' + child.exitCode);
      try {
        if (
          (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) })).ok
        )
          break;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    const file = fs
      .readdirSync(path.join(root, 'dist'))
      .find(
        f =>
          /^client-.*\.mjs$/.test(f) &&
          fs.readFileSync(path.join(root, 'dist', f), 'utf8').includes('GatewayClient as t'),
      );
    const { t: GatewayClient } = await import(pathToFileURL(path.join(root, 'dist', file)).href);
    const hello = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway handshake timed out')), 20000);
      client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        clientName: 'gateway-client',
        mode: 'backend',
        scopes: ['operator.admin'],
        onHelloOk: data => {
          clearTimeout(timer);
          resolve(data);
        },
        onConnectError: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
      client.start();
    });
    const methods = hello.features?.methods ?? [];
    if (!methods.includes('sessions.diff')) throw Error('Missing sessions.diff');
    const key = 'agent:main:justdo:review-smoke';
    await client.request('sessions.create', { key, cwd: workspace });
    // Match JustDo's create -> chat.send path. Creation only arms the capture;
    // execution must settle the native baseline before any filesystem edits.
    await client.request('chat.send', {
      sessionKey: key,
      message: 'Review baseline smoke; no tools needed.',
      deliver: false,
      idempotencyKey: randomBytes(16).toString('hex'),
    });
    let baselineReady = false;
    const baselineDeadline = Date.now() + 15000;
    while (Date.now() < baselineDeadline) {
      const initial = await client.request('sessions.diff', { sessionKey: key, scope: 'all' });
      if (!initial.unavailableReason && initial.files.length === 0) {
        baselineReady = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await client.request('chat.abort', { sessionKey: key });
    assert.ok(baselineReady, 'chat.send did not establish the native baseline');
    for (const [name, text] of [
      ['shell.txt', 'shell change\n'],
      ['edit.txt', 'edit change\n'],
      ['中文 文件.md', '# 新文件\n'],
    ])
      fs.writeFileSync(path.join(workspace, name), text);
    fs.unlinkSync(path.join(workspace, 'delete.txt'));
    git('mv', 'rename.txt', 'renamed.txt');
    fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3, 0]));
    fs.writeFileSync(path.join(workspace, 'large.txt'), 'x'.repeat(3 * 1024 * 1024));
    const describe = await client.request('sessions.describe', { key });
    const all = await client.request('sessions.diff', {
      sessionKey: key,
      scope: 'all',
    });
    const uncommitted = await client.request('sessions.diff', {
      sessionKey: key,
      scope: 'uncommitted',
    });
    const unknown = await client.request('sessions.diff', {
      sessionKey: key,
      scope: 'commit',
      commit: 'missing-review-commit',
    });
    const commit = await client.request('sessions.diff', {
      sessionKey: key,
      scope: 'commit',
      commit: 'HEAD',
    });
    const absent = await client.request('sessions.diff', {
      sessionKey: 'agent:main:justdo:missing',
      scope: 'all',
    });
    assert.deepEqual(
      commit.files.map(file => file.path),
      ['committed.txt'],
      'Commit scope leaked working-tree changes',
    );
    const nongit = path.join(state, 'not-git');
    fs.mkdirSync(nongit);
    await client.request('sessions.create', { key: 'agent:main:justdo:nongit', cwd: nongit });
    const notgit = await client.request('sessions.diff', {
      sessionKey: 'agent:main:justdo:nongit',
      scope: 'all',
    });
    if (notgit.unavailableReason !== 'not_git') throw Error('Incorrect non-Git result');
    const names = new Set(all.files.map(f => f.path));
    for (const name of [
      'shell.txt',
      'edit.txt',
      '中文 文件.md',
      'binary.bin',
      'large.txt',
      'delete.txt',
      'renamed.txt',
    ])
      if (!names.has(name)) throw Error('Missing expected diff ' + name);
    assert.deepEqual(
      uncommitted.files.map(file => file.path).sort(),
      [...names].sort(),
      'Uncommitted scope included a committed-only file or omitted working-tree changes',
    );
    assert.ok(!names.has('manual.txt'), 'Pre-existing unchanged manual file was not filtered');
    assert.ok(!names.has('committed.txt'), 'Pre-existing committed file was not filtered');
    assert.equal(all.files.find(file => file.path === 'renamed.txt')?.status, 'renamed');
    assert.equal(all.files.find(file => file.path === '中文 文件.md')?.untracked, true);
    if (
      unknown.unavailableReason !== 'unknown_commit' ||
      absent.unavailableReason !== 'unknown_session'
    )
      throw Error('Incorrect unavailable reason');
    if (!describe.session?.sessionId) throw Error('Descriptor missing instance identity');
    if (!all.files.find(f => f.path === 'binary.bin')?.binary) throw Error('Binary not flagged');
    if (!all.files.find(f => f.path === 'large.txt')?.truncated)
      throw Error('Large file not flagged');
    const evidence = {
      ok: true,
      protocol: hello.protocol,
      nativeInstance: true,
      nativeBaselineFiltering: true,
      chatSendBaselineCapture: true,
      unbornBaselineFiltering: true,
      all: all.files.map(({ path, status, binary, untracked, truncated }) => ({
        path,
        status,
        binary,
        untracked,
        truncated,
      })),
      uncommitted: uncommitted.files.length,
      commitFiles: commit.files.length,
      unknownCommit: unknown.unavailableReason,
      unknownSession: absent.unavailableReason,
      notGit: notgit.unavailableReason,
    };
    fs.writeFileSync(path.join(state, 'evidence.json'), JSON.stringify(evidence, null, 2));
    if (process.argv[3])
      fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    if (client) await client.stopAndWait().catch(() => client.stop());
    child.kill();
    fs.writeFileSync(path.join(state, 'smoke.log'), output.replaceAll(token, '<test-token>'));
    console.log('Smoke log: ' + path.join(state, 'smoke.log'));
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
