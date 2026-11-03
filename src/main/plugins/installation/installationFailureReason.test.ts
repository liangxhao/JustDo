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

test.each([
  String.raw`C:\Users\Example\插件 目录`,
  String.raw`\\server\shared plugins\插件`,
  '/Users/Example/Library/Application Support/extensions/插件',
  '/home/example/local plugins/插件',
])('preserves an opted-in local directory across repeated host sanitization: %s', directory => {
  const reason = `Extension directory:\n"${directory}"\nBackup recovery path: "${directory}/backup"`;
  const options = { preserveLocalPaths: true } as const;

  const first = sanitizeInstallationFailureReason(reason, [directory], options)!;
  const second = sanitizeInstallationFailureReason(first, [directory], options)!;

  expect(first).toBe(reason);
  expect(second).toBe(reason);
  expect(second).not.toContain('[REDACTED PATH]');
  expect(sanitizeInstallationFailureReason(reason, [directory])).not.toContain(directory);
});

test('preserves local paths while still masking credentials, URLs, control sequences and stack frames', () => {
  const directory = String.raw`C:\extensions\插件 目录`;
  const secretPath = String.raw`C:\credential-secret\value`;
  const reason = [
    `\u001b[31mExtension directory: "${directory}"\u001b[0m`,
    'Authorization: Bearer fixture-private-bearer',
    'Cookie: fixture-private-cookie',
    `password="${secretPath}" accessCode=fixture-private-access _authToken=fixture-private-npm`,
    'Download: https://account:fixture-private-password@example.test/package?token=fixture-private-query',
    'File URL: file:///private-source/package.zip',
    String.raw`    at install (C:\private-stack\installer.js:2:3)`,
  ].join('\n');
  const options = { preserveLocalPaths: true } as const;

  const first = sanitizeInstallationFailureReason(reason, [directory, secretPath], options)!;
  const second = sanitizeInstallationFailureReason(first, [directory, secretPath], options)!;

  for (const sanitized of [first, second]) {
    expect(sanitized).toContain(directory);
    expect(sanitized).toContain('[REDACTED URL]');
    for (const privateText of [
      'fixture-private-', 'credential-secret', 'private-source', 'private-stack', '\u001b', '    at ',
    ]) expect(sanitized).not.toContain(privateText);
  }
});

test('retains input and output bounds when local paths are visible', () => {
  const options = { preserveLocalPaths: true } as const;
  expect(sanitizeInstallationFailureReason('x'.repeat(65537), [], options)).toBeUndefined();
  const directory = String.raw`C:\extensions\插件 目录`;
  const sanitized = sanitizeInstallationFailureReason(
    `Extension directory: "${directory}"\naccessCode="${'fixture-secret'.repeat(800)}"\n${'reason '.repeat(1000)}`,
    [directory], options,
  )!;
  expect(sanitized).toContain(directory);
  expect(sanitized).not.toContain('fixture-secret');
  expect(sanitized.length).toBeLessThanOrEqual(4000);
});

test.each([
  String.raw`--token "C:\fixture-private\私密 credential-tail\secret"`,
  String.raw`--api-key "\\fixture-private\shared\私密 credential-tail\secret"`,
  'access_code=\'/fixture-private/私密 credential-tail/value\'',
  '--accessCode "/fixture-private/私密 credential-tail/value"',
  String.raw`--auth-token "C:\fixture-private\私密 credential-tail\secret"`,
  String.raw`clientSecret="C:\fixture-private\私密 credential-tail\secret"`,
  String.raw`--passwd "C:\fixture-private\私密 credential-tail\secret"`,
  String.raw`private_key="C:\fixture-private\私密 credential-tail\secret"`,
  '"api key": "/fixture-private/私密 credential-tail/value"',
  String.raw`--token "fixture-private \"credential-tail\" spaced-value" after=visible`,
  String.raw`password='fixture-private \'credential-tail\' spaced-value' after=visible`,
])('fully redacts quoted credentials before preserving local directories: %s', argument => {
  const directory = String.raw`C:\extensions\可见 插件`;
  const reason = `Extension directory: "${directory}"\nFailed: ${argument}\nBackup path: "${directory}\\backup"`;

  for (const options of [{ preserveLocalPaths: undefined }, { preserveLocalPaths: true }] as const) {
    const first = sanitizeInstallationFailureReason(reason, [directory], options)!;
    const second = sanitizeInstallationFailureReason(first, [directory], options)!;
    for (const sanitized of [first, second]) {
      expect(sanitized).not.toMatch(/fixture-private|credential-tail|spaced-value/);
      expect(sanitized).toContain('Extension directory:');
      expect(sanitized).toContain('Backup path:');
      if (options.preserveLocalPaths) {
        expect(sanitized).toContain(directory);
        expect(sanitized).toContain(`${directory}\\backup`);
      } else {
        expect(sanitized).not.toContain(directory);
      }
    }
  }
});

test.each([
  String.raw`password="C:\fixture-private\私密 credential-tail\"`,
  String.raw`--access-code "C:\fixture-private\私密 credential-tail`,
  String.raw`password="C:\fixture-private\私密 credential-tail\" trailing-credential-tail`,
  String.raw`password="C:\fixture-private\私密 credential-tail\" next="credential-tail"`,
  String.raw`--token "fixture-private"credential-tail`,
])('redacts the remaining diagnostic when a credential has malformed quoting: %s', argument => {
  const directory = String.raw`C:\extensions\可见 插件`;
  const reason = `Extension directory: "${directory}"\nFailed: ${argument}\nRemaining private details: credential-tail`;
  for (const options of [{ preserveLocalPaths: undefined }, { preserveLocalPaths: true }] as const) {
    const first = sanitizeInstallationFailureReason(reason, [directory], options)!;
    const second = sanitizeInstallationFailureReason(first, [directory], options)!;
    for (const sanitized of [first, second]) {
      expect(sanitized).not.toMatch(/fixture-private|credential-tail|Remaining private details/);
      expect(sanitized).toContain('Extension directory:');
      if (options.preserveLocalPaths) expect(sanitized).toContain(directory);
    }
  }
});

test('keeps JSON quoted values valid so nested credential objects remain masked', () => {
  const directory = String.raw`C:\extensions\可见 插件`;
  const prefix = 'Host failure: ';
  const reason = prefix + JSON.stringify({
    directory,
    token: 'C:\\fixture-private\\私密 credential-tail\\',
    credentials: { arbitraryValue: 'fixture-private-nested' },
    nested: { 'private key': { value: 'fixture-private-key' } },
  });
  const options = { preserveLocalPaths: true } as const;
  const first = sanitizeInstallationFailureReason(reason, [], options)!;
  const second = sanitizeInstallationFailureReason(first, [], options)!;

  for (const sanitized of [first, second]) {
    expect(sanitized).not.toMatch(/fixture-private|credential-tail/);
    expect(JSON.parse(sanitized.slice(prefix.length))).toEqual({
      directory,
      token: '[REDACTED]',
      credentials: '[REDACTED]',
      nested: { 'private key': '[REDACTED]' },
    });
  }
  expect(sanitizeInstallationFailureReason(reason)).not.toMatch(/fixture-private|credential-tail/);
});

test('redacts decoded JSON message credentials while preserving ordinary extension directories', () => {
  const directory = String.raw`C:\extensions\可见 插件`;
  const prefix = 'EPERM: ';
  const reason = prefix + JSON.stringify({
    message: String.raw`--token "C:\fixture-private\私密 credential-tail\secret"`,
    details: JSON.stringify({ message: 'password="fixture-private\ncredential-tail"' }),
    directory,
  });
  for (const options of [{ preserveLocalPaths: undefined }, { preserveLocalPaths: true }] as const) {
    const first = sanitizeInstallationFailureReason(reason, [], options)!;
    const second = sanitizeInstallationFailureReason(first, [], options)!;
    for (const sanitized of [first, second]) {
      expect(sanitized).not.toMatch(/fixture-private|credential-tail/);
      if (options.preserveLocalPaths) {
        expect(JSON.parse(sanitized.slice(prefix.length)).directory).toBe(directory);
      }
    }
  }
});
