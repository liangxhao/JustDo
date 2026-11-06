'use strict';

// Test-only controlled Windows sharing fault. Actual fs.rename remains the
// source of every result; this module never synthesizes an errno or repeats it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { threadId } = require('node:worker_threads');
const { createHash } = require('node:crypto');

exports.install = ({ helperScript, holdMs, scenario }) => {
  assert.equal(process.platform, 'win32');
  assert.ok(Number.isSafeInteger(holdMs) && holdMs > 0 && holdMs <= 20000);
  const run = fs.realpathSync(process.env.PLUGIN_COPY_OBSERVER_RUN);
  const state = fs.realpathSync(process.env.OPENCLAW_STATE_DIR);
  assert.equal(path.dirname(state), run);
  helperScript = fs.realpathSync(helperScript);
  const extensions = path.join(state, 'extensions');
  const canonical = path.join(extensions, 'import-probe-update');
  const filename = path.join(run, `controlled-publication-lock-${process.pid}-${threadId}.json`);
  const probes = new Map();
  const realRename = fsp.rename;
  const identity = target => {
    try {
      const s = fs.lstatSync(target, { bigint: true });
      return { exists: true, dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), nlink: String(s.nlink), directory: s.isDirectory(), symlink: s.isSymbolicLink() };
    } catch (error) { return { exists: false, error: { code: error.code, message: error.message } }; }
  };
  const errorValue = error => ({ code: error.code, message: error.message, syscall: error.syscall, path: error.path, dest: error.dest });
  const flush = () => fs.writeFileSync(filename, JSON.stringify({ pid: process.pid, threadId, node: process.versions.node, scenario, holdMs, helperScript,
    helperScriptSha256: createHash('sha256').update(fs.readFileSync(helperScript)).digest('hex'), probes: [...probes.values()].map(p => p.report) }, null, 2));
  const release = probe => {
    if (probe.report.releaseRequestedAt) return;
    probe.report.releaseRequestedAt = Date.now();
    fs.writeFileSync(probe.release, 'Release only this explicitly owned test handle.');
    flush();
  };
  async function startProbe(from, to) {
    const prefix = path.join(run, `publication-holder-${process.pid}-${threadId}`);
    const probe = { ready: `${prefix}-ready.json`, release: `${prefix}-release`, closed: `${prefix}-closed.json`,
      report: { source: from, target: to, sourceIdentity: identity(from), heldFile: path.join(from, 'index.mjs'), holdMs, attempts: [] } };
    probes.set(from, probe);
    flush();
    const powershell = path.join(process.env.SystemRoot || process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperScript,
      '-Target', probe.report.heldFile, '-Ready', probe.ready, '-Release', probe.release, '-Closed', probe.closed,
      '-ShareMode', '3', '-MaxHoldMs', String(holdMs + 10000)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    probe.child = child;
    probe.report.helperPid = child.pid;
    probe.report.helperOutput = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
      probe.report.helperOutput = (probe.report.helperOutput + String(data)).slice(-20000);
    });
    child.once('error', error => { probe.report.spawnError = errorValue(error); flush(); });
    child.once('exit', (code, signal) => {
      probe.report.helperExit = { code, signal, at: Date.now() };
      if (fs.existsSync(probe.closed)) probe.report.helperClosed = JSON.parse(fs.readFileSync(probe.closed, 'utf8'));
      flush();
    });
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(probe.ready)) {
      assert.equal(probe.report.spawnError, undefined, 'The controlled handle helper must start');
      assert.equal(probe.report.helperExit, undefined, 'The controlled handle helper must stay alive until ready');
      assert.ok(Date.now() < deadline, 'The controlled handle helper must publish its readiness');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    probe.report.helperReady = JSON.parse(fs.readFileSync(probe.ready, 'utf8'));
    assert.equal(probe.report.helperReady.success, true, JSON.stringify(probe.report.helperReady));
    assert.equal(probe.report.helperReady.pid, child.pid);
    assert.equal(probe.report.helperReady.sharesDelete, false);
    assert.equal(probe.report.helperReady.target, probe.report.heldFile);
    probe.report.helperReadyAt = Date.now();
    probe.timer = setTimeout(() => release(probe), holdMs);
    flush();
    return probe;
  }
  const isV2Publication = (from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string' || path.resolve(to) !== canonical ||
      path.dirname(path.resolve(from)) !== extensions || !path.basename(from).startsWith('.fs-safe-move-')) return false;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8'));
      return pkg.name === 'import-probe-update' && pkg.version === '1.1.0' && fs.existsSync(path.join(from, 'index.mjs'));
    } catch { return false; }
  };
  fsp.rename = function (from, to) {
    const existing = probes.get(from);
    if (!existing && !isV2Publication(from, to)) return realRename.apply(this, arguments);
    const receiver = this;
    const args = arguments;
    const publish = probe => {
      const attempt = { ordinal: probe.report.attempts.length + 1, startedAt: Date.now(), sourceIdentity: identity(from), targetBefore: identity(to) };
      probe.report.attempts.push(attempt);
      // After the explicit test handle is ready, every attempt dispatches the
      // original syscall once. There is no test retry or permission bypass.
      return realRename.apply(receiver, args).then(value => {
        Object.assign(attempt, { success: true, finishedAt: Date.now(), targetAfter: identity(to) });
        flush();
        return value;
      }, error => {
        Object.assign(attempt, { success: false, finishedAt: Date.now(), error: errorValue(error), sourceAfter: identity(from), targetAfter: identity(to) });
        flush();
        throw error;
      });
    };
    return existing ? publish(existing) : startProbe(from, to).then(publish);
  };
  process.once('exit', () => {
    for (const probe of probes.values()) {
      if (!probe.report.helperExit) {
        try { release(probe); } catch { /* The helper also has its own finite deadline. */ }
      }
    }
  });
  require('node:module').syncBuiltinESMExports();
};
