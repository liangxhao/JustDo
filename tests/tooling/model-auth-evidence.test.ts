import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const projectRoot = path.resolve(__dirname, '../..');
const buildRoot = path.join(projectRoot, 'build');
const script = path.join(projectRoot, 'scripts/diagnostics/collect-model-auth-evidence.ps1');
const directories: string[] = [];
const windowsPowerShell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const powerShell7 = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell/7/pwsh.exe');
const shells = [windowsPowerShell, ...(fs.existsSync(powerShell7) ? [powerShell7] : [])];
const prefix = '[BuiltinModelAuth] ';
const diagnostic = (time: string, facts: Record<string, unknown>) => `[${time}] [info] ${prefix}${JSON.stringify(facts)}`;
const nativeTime = '2026-11-04T21:30:00.055+08:00';
const degraded = `${nativeTime} [secrets] [SECRETS_PROVIDER_DEGRADED] exec:justdo_login: secret provider failed. Affected owners: cold provider:builtin_models.`;

function fixture() {
  fs.mkdirSync(buildRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(buildRoot, 'model-auth-evidence-'));
  directories.push(directory);
  const logs = path.join(directory, 'received logs [测试]');
  const output = path.join(directory, 'output');
  fs.mkdirSync(logs);
  fs.mkdirSync(output);
  return { directory, logs, output };
}

function run(shell: string, data: ReturnType<typeof fixture>, inputs: string[], maxKiB = 16, errorTime = '') {
  const manifest = path.join(data.directory, 'fixture.json');
  const runner = path.join(data.directory, 'run.ps1');
  fs.writeFileSync(manifest, JSON.stringify({ inputs, output: data.output, maxKiB, errorTime }));
  fs.writeFileSync(runner, [
    'param([string]$ScriptPath, [string]$ManifestPath)',
    "$ErrorActionPreference = 'Stop'",
    '$fixtureSpec = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json',
    '& $ScriptPath -LogPaths @($fixtureSpec.inputs) -OutputDirectory $fixtureSpec.output -MaxKiB $fixtureSpec.maxKiB -ErrorTime $fixtureSpec.errorTime',
  ].join('\r\n'));
  execFileSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner,
    '-ScriptPath', script, '-ManifestPath', manifest], {
    encoding: 'utf8', windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024,
  });
  const reports = fs.readdirSync(data.output).filter(name => /^model-auth-evidence-.*\.txt$/.test(name));
  expect(reports).toHaveLength(1);
  const bytes = fs.readFileSync(path.join(data.output, reports[0]));
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const rows = text.split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  return { bytes, text, rows };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(path.resolve(directory)) !== buildRoot) throw new Error('Fixture cleanup left the build directory.');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform !== 'win32')('minimal model authentication evidence', () => {
  test.each(shells)('selects the latest real incident and sanitizes mixed received logs with %s', shell => {
    const data = fixture();
    const main = path.join(data.logs, 'main-SENSITIVE_FILE_NAME [副本].log');
    const gateway = path.join(data.logs, 'gateway.log.old');
    const native = path.join(data.logs, 'openclaw-native.jsonl');
    fs.writeFileSync(main, [
      '[2026-11-04 09:00:00.000] [error] [OpenClaw stderr] 2026-11-04T09:00:00.000+08:00 [secrets] [SECRETS_PROVIDER_DEGRADED] exec:justdo_login: secret provider failed.',
      '[2026-11-04 21:29:50.000] [error] [BuiltinModelTokenExchange] exchange failed: {',
      "  stage: 'credential',",
      "  credentialCode: 'expired-or-expiring',",
      "  userAccount: 'PRIVATE_PERSON',",
      '}',
      diagnostic('2026-11-04 21:29:57.000', { event: 'exchange.succeeded', generation: 7, expiresInSeconds: 1700 }),
      diagnostic('2026-11-04 21:29:58.000', { event: 'snapshot.published', remainingSeconds: 1699, changed: true }),
      diagnostic('2026-11-04 21:29:59.000', {
        event: 'exchange.failed', stage: 'request', reason: 'SYNTHETIC_PRIVATE_VALUE',
        errorCode: 'SYNTHETIC_PRIVATE_VALUE', networkCode: 'ECONNRESET',
        token: 'eyJprivate.eyJprivate.signature', account: 'PRIVATE_PERSON',
        path: 'C:\\Users\\PRIVATE_PERSON\\credentials.bin', url: 'https://private.example/internal',
      }),
      `[2026-11-04 21:30:00.200] [error] [OpenClaw stderr] ${degraded}`,
      diagnostic('2026-11-04 21:30:00.500', { event: 'snapshot.observed', basis: 'snapshot_observation', snapshotState: 'valid', sessionMatch: 'mismatch' }),
      diagnostic('2026-11-04 21:30:01.000', { event: 'reload.acknowledged', ackState: 'accepted', warningCount: 2 }),
      '[2026-11-04 21:30:01.300] [info] [OpenClaw stdout] 2026-11-04T21:30:01.250+08:00 [ws] ⇄ res ✓ secrets.reload 620ms bytes=111 conn=SYNTHETIC_CONNECTION_ID',
      '[2026-11-04 21:30:01.700] [error] [OpenClaw stderr] 2026-11-04T21:30:01.600+08:00 [agent/embedded] embedded run agent end: runId=SYNTHETIC_CONNECTION_ID isError=true error=Secret owner provider:builtin_models is configured but unavailable (secret provider failed)',
      diagnostic('2026-11-04 21:30:01.900', {
        event: 'request_credentials_rejected', reason: 'secret_resolution_failed',
        resolverStage: 'sdk_load', resolverCode: 'ERR_MODULE_NOT_FOUND', resolverReason: 'PRIVATE_PERSON',
      }),
      diagnostic('2026-11-04 21:30:02.000', {
        event: 'request_credentials_rejected', reason: 'secret_resolution_failed',
        resolverStage: 'secret_ref', resolverCode: 'SECRET_PROVIDER_UNAVAILABLE',
        resolverReason: 'session_mismatch',
      }),
      '[2026-11-04 22:00:00.000] [info] [Chat] User quoted: Secret owner provider:builtin_models is configured but unavailable (secret provider failed)',
      diagnostic('2026-11-04 23:00:00.000', { event: 'discovery.optional-http-rejected', discoveryStage: 'model-info', httpStatus: 404 }),
      diagnostic('2026-11-04 23:01:00.000', { event: 'SYNTHETIC_PRIVATE_VALUE', reason: 'PRIVATE_PERSON' }),
      '',
    ].join('\r\n'));
    fs.writeFileSync(gateway, `[2026-11-04T13:30:00.100Z] [stderr] ${degraded}\r\n`);
    fs.writeFileSync(native, `${JSON.stringify({
      time: '2026-11-04T13:30:00.055Z', '0': '{"subsystem":"secrets"}',
      '1': '[SECRETS_PROVIDER_DEGRADED] exec:justdo_login: secret provider failed. Affected owners: cold provider:builtin_models.',
    })}\n`);
    const hashes = [main, gateway, native].map(file => createHash('sha256').update(fs.readFileSync(file)).digest('hex'));

    // Deliberately select an older source and UTC source before Main.
    const report = run(shell, data, [native, gateway, main]);

    const anchor = report.text.match(/^Anchor: (.+)$/m)?.[1]?.trim();
    expect(anchor).toBeTruthy();
    expect(new Date(anchor!).toISOString()).toBe('2026-11-04T13:30:02.000Z');
    expect(report.text).toContain('Input files: 3');
    expect(report.bytes.length).toBeLessThanOrEqual(16 * 1024);
    expect(report.text).not.toMatch(/SYNTHETIC_PRIVATE_VALUE|PRIVATE_PERSON|SENSITIVE_FILE_NAME|SYNTHETIC_CONNECTION_ID|eyJprivate|private\.example|credentials\.bin|User quoted/);
    expect(report.rows).toContainEqual(expect.objectContaining({ event: 'snapshot.observed', sessionMatch: 'mismatch' }));
    expect(report.rows).toContainEqual(expect.objectContaining({ event: 'exchange.succeeded' }));
    expect(report.rows).toContainEqual(expect.objectContaining({ event: 'reload.acknowledged', warningCount: 2 }));
    expect(report.rows).toContainEqual(expect.objectContaining({ event: 'exchange.failed', stage: 'credential', credentialCode: 'expired-or-expiring' }));
    expect(report.rows).toContainEqual(expect.objectContaining({ event: 'native.reload-acknowledged', elapsedMs: 620 }));
    expect(report.rows).toContainEqual(expect.objectContaining({ event: 'native.owner-unavailable', builtinOwner: true }));
    expect(report.rows).toContainEqual(expect.objectContaining({
      event: 'request_credentials_rejected', resolverStage: 'sdk_load', resolverCode: 'ERR_MODULE_NOT_FOUND',
    }));
    expect(report.rows).toContainEqual(expect.objectContaining({
      event: 'request_credentials_rejected', resolverStage: 'secret_ref', resolverCode: 'SECRET_PROVIDER_UNAVAILABLE',
      resolverReason: 'session_mismatch',
    }));
    expect(report.rows.some(row => row.recordCount >= 3 && row.sources.length >= 2)).toBe(true);
    expect([main, gateway, native].map(file => createHash('sha256').update(fs.readFileSync(file)).digest('hex'))).toEqual(hashes);
  }, 60_000);

  test('enforces the UTF-8 byte cap while retaining failure evidence and complete JSON rows', () => {
    const data = fixture();
    const main = path.join(data.logs, 'main.log');
    const eventNames = [
      'exchange.started', 'exchange.succeeded', 'exchange.failed', 'exchange.superseded',
      'refresh.triggered', 'refresh.completed', 'application.queued', 'application.started',
      'application.completed', 'application.failed', 'config-sync.queued', 'config-sync.started',
      'config-sync.completed', 'config-sync.failed', 'snapshot.published', 'snapshot.publication-failed',
      'snapshot.observed', 'reload.started', 'reload.acknowledged', 'reload.failed',
      'discovery.started', 'discovery.succeeded', 'discovery.failed',
    ];
    const lines = [`[2026-11-04 21:28:00.000] [info] [Chat] ${'PRIVATE_NOISE'.repeat(10_000)}`];
    for (let index = 0; index < 2500; index += 1) {
      const time = new Date(Date.parse('2026-11-04T21:29:00+08:00') + index * 10).toISOString();
      lines.push(diagnostic(time, { event: eventNames[index % eventNames.length], generation: index,
        remainingSeconds: 300 - index, elapsedMs: index, attempt: index % 3 + 1,
        snapshotState: 'expired', sessionMatch: 'matches', errorCode: 'EACCES', reason: 'snapshot-write-failed' }));
    }
    lines.push(diagnostic('2026-11-04T21:29:59.500+08:00', { event: 'exchange.succeeded', generation: 85001, expiresInSeconds: 600 }));
    lines.push(diagnostic('2026-11-04T21:29:59.600+08:00', { event: 'snapshot.published', generation: 85002, remainingSeconds: 600 }));
    lines.push(`[2026-11-04 21:30:00.200] [error] [OpenClaw stderr] ${degraded}`);
    lines.push(diagnostic('2026-11-04T21:30:00.100+08:00', { event: 'exchange.succeeded', generation: 85003, expiresInSeconds: 600 }));
    lines.push(diagnostic('2026-11-04T21:30:00.200+08:00', { event: 'snapshot.published', generation: 85004, remainingSeconds: 600 }));
    fs.writeFileSync(main, lines.join('\r\n'));
    const report = run(windowsPowerShell, data, [main], 4, '2026-11-04T21:30:00+08:00');
    expect(report.bytes.length).toBeLessThanOrEqual(4 * 1024);
    expect(report.text).toMatch(/^Truncated: true\r?$/m);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.rows.some(row => row.event === 'snapshot.observed' || String(row.event).includes('degraded'))).toBe(true);
    expect(report.rows.map(row => row.generation)).toEqual(expect.arrayContaining([85001, 85002, 85003, 85004]));
    expect(report.text).not.toContain('PRIVATE_NOISE');
  }, 60_000);
});
