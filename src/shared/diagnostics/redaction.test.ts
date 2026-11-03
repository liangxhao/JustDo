import { expect, test } from 'vitest';

import { redactLogText } from './redaction';

test.each([
  String.raw`--token "C:\fixture-private\私密 credential-tail\secret"`,
  String.raw`--api-key "\\fixture-private\shared\私密 credential-tail\secret"`,
  'access_code=\'/fixture-private/私密 credential-tail/value\'',
  String.raw`private_key="fixture-private \"credential-tail\" spaced-value"`,
  '"api key": "/fixture-private/私密 credential-tail/value"',
])('redacts complete quoted credentials while retaining ordinary local paths: %s', argument => {
  const directory = String.raw`C:\extensions\可见 插件`;
  const reason = `Directory: "${directory}"\n${argument}\nBackup: "${directory}\\backup"`;
  const first = redactLogText(reason);
  const second = redactLogText(first);

  for (const sanitized of [first, second]) {
    expect(sanitized).not.toMatch(/fixture-private|credential-tail|spaced-value/);
    expect(sanitized).toContain(directory);
    expect(sanitized).toContain(`${directory}\\backup`);
  }
});

test('redacts decoded prefixed JSON message leaves, nested JSON strings and secret objects', () => {
  const directory = String.raw`C:\extensions\可见 插件`;
  const prefix = 'EPERM: ';
  const reason = prefix + JSON.stringify({
    message: String.raw`--token "C:\fixture-private\私密 credential-tail\secret"`,
    details: JSON.stringify({ message: 'password="fixture-private\ncredential-tail"' }),
    directory,
    credentials: { arbitraryField: 'fixture-private-object' },
    access_code: { value: 'fixture-private-access' },
  });
  const first = redactLogText(reason);
  const second = redactLogText(first);

  for (const sanitized of [first, second]) {
    expect(sanitized).not.toMatch(/fixture-private|credential-tail/);
    const decoded = JSON.parse(sanitized.slice(prefix.length));
    expect(decoded.directory).toBe(directory);
    expect(decoded.credentials).toBe('[REDACTED]');
    expect(decoded.access_code).toBe('[REDACTED]');
    expect(JSON.parse(decoded.details).message).toContain('[REDACTED]');
  }
});

test.each([
  'password="fixture-private\ncredential-tail"',
  "--access-code 'fixture-private\ncredential-tail'",
])('redacts every line of a valid quoted credential: %s', argument => {
  const first = redactLogText(`${argument}\nAfter: retained`);
  const second = redactLogText(first);
  for (const sanitized of [first, second]) {
    expect(sanitized).not.toMatch(/fixture-private|credential-tail/);
    expect(sanitized).toContain('After: retained');
  }
});

test('redacts full private-key blocks before processing quoted credential assignments', () => {
  const reason = [
    'password="fixture-private\ncredential-tail"',
    '-----BEGIN PRIVATE KEY-----',
    'password="fixture-private-key-body',
    '-----END PRIVATE KEY-----',
    'After: retained',
  ].join('\n');
  const first = redactLogText(reason);
  const second = redactLogText(first);
  for (const sanitized of [first, second]) {
    expect(sanitized).not.toMatch(/fixture-private|credential-tail/);
    expect(sanitized).toContain('[REDACTED PRIVATE KEY]');
    expect(sanitized).toContain('After: retained');
  }
});

test.each([
  String.raw`password="C:\fixture-private\私密 credential-tail\"`,
  String.raw`--token "fixture-private"credential-tail`,
])('redacts all remaining text when a quoted credential is malformed: %s', argument => {
  const first = redactLogText(`Before: retained\n${argument}\ncredential-tail next line`);
  const second = redactLogText(first);
  for (const sanitized of [first, second]) {
    expect(sanitized).not.toMatch(/fixture-private|credential-tail|next line/);
    expect(sanitized).toContain('Before: retained');
  }
});
