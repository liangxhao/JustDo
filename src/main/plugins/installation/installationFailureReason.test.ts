import { expect, test } from 'vitest';

import { sanitizeInstallationFailureReason } from './installationFailureReason';

test('preserves concrete validation reasons and relative package entry names', () => {
  const reason =
    'Package validation failed:\nTypeScript entry ./index.ts requires compiled runtime output ./dist/index.js.';
  expect(sanitizeInstallationFailureReason(reason)).toBe(reason);
  expect(sanitizeInstallationFailureReason(reason, ['.', './'])).toBe(reason);
  expect(sanitizeInstallationFailureReason('accessCode is required')).toBe(
    'accessCode is required',
  );
});

test('removes credentials, private locations, control sequences and stack frames from a host failure', () => {
  const sourcePath = String.raw`C:\Users\Example\临时 安装包`;
  const reason = [
    '\u001b[31mPackage validation failed\u001b[0m',
    `Cannot read "${sourcePath}\\openclaw.plugin.json"`,
    'Bearer private-bearer accessCode="private-access" password=private-password',
    'Download: https://example.test/private-path?token=private-query',
    String.raw`    at validate (C:\private\installer.js:12:3)`,
  ].join('\n');
  const sanitized = sanitizeInstallationFailureReason(reason, [sourcePath])!;
  expect(sanitized).toContain('Package validation failed');
  expect(sanitized).toContain('[REDACTED');
  for (const privateText of [
    'Example',
    '临时 安装包',
    'private-',
    'installer.js',
    '\u001b',
    '    at ',
  ]) {
    expect(sanitized).not.toContain(privateText);
  }
});

test.each([
  String.raw`Cannot open C:\private source\plugin.json`,
  String.raw`Cannot open \\private-server\private-share\plugin.json`,
  'Cannot open "/private-source/plugin.json"',
  String.raw`Cannot open \private\secret.dll`,
])('removes unknown absolute paths from a diagnostic: %s', reason => {
  expect(sanitizeInstallationFailureReason(reason)).not.toContain('private');
});

test('rejects absent or oversized reasons and redacts before applying the output bound', () => {
  expect(sanitizeInstallationFailureReason(undefined)).toBeUndefined();
  expect(sanitizeInstallationFailureReason('   ')).toBeUndefined();
  expect(sanitizeInstallationFailureReason('x'.repeat(65537))).toBeUndefined();
  const sanitized = sanitizeInstallationFailureReason(
    `accessCode="${'private'.repeat(1000)}"\n${'reason '.repeat(1000)}`,
  )!;
  expect(sanitized).not.toContain('private');
  expect(sanitized.length).toBeLessThanOrEqual(4000);
});

test.each([
  [
    String.raw`Cannot enable plugin at C:\runtime\extension: accessCode is required`,
    'accessCode is required',
  ],
  [
    'Invalid manifest at /private/staging/plugin: configSchema is required',
    'configSchema is required',
  ],
  [
    String.raw`Plugin C:\runtime\extension has invalid manifest: missing runtime entry`,
    'has invalid manifest: missing runtime entry',
  ],
])('keeps the cause following an unknown native path: %s', (reason, cause) => {
  const sanitized = sanitizeInstallationFailureReason(reason)!;
  expect(sanitized).toContain(cause);
  expect(sanitized).toContain('[REDACTED PATH]');
  expect(sanitized).not.toMatch(/runtime\\extension|private\/staging/);
});

test.each([
  '--access-code private-access',
  '--accessCode "private access"',
  "--access_code 'private access'",
])('removes authentication codes passed as command arguments: %s', argument => {
  const sanitized = sanitizeInstallationFailureReason(`Authentication failed: ${argument}`)!;
  expect(sanitized).toContain('Authentication failed');
  expect(sanitized).not.toContain('private');
});
