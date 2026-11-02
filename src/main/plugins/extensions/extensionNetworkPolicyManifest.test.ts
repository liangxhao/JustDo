import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getLanguage, setLanguage, t } from '../../core/i18n';
import { sanitizeInstallationFailureReason } from '../installation/installationFailureReason';
import { inspectExtensionNetworkPolicyManifest } from './extensionNetworkPolicyManifest';

const tempDirectories: string[] = [];
let previousLanguage: ReturnType<typeof getLanguage>;

beforeEach(() => {
  previousLanguage = getLanguage();
});

const createExtension = (manifest: unknown): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-network-policy-'));
  tempDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, 'outbound-header-policy.json'),
    JSON.stringify(manifest),
    'utf8',
  );
  return directory;
};

afterEach(() => {
  setLanguage(previousLanguage);
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const invalidUrlReason = (value: unknown): string => {
  const extensionRoot = createExtension({
    schemaVersion: 1,
    groups: [
      { baseUrlWhitelist: ['https://first.example.test/'], headerNames: ['X-User-Account'] },
      {
        baseUrlWhitelist: ['https://second.example.test/', value],
        headerNames: ['X-Cookie'],
      },
    ],
  });
  try {
    inspectExtensionNetworkPolicyManifest(extensionRoot);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected an invalid URL declaration');
};

describe('inspectExtensionNetworkPolicyManifest', () => {
  it('normalizes a declarative outbound-header policy', () => {
    const extensionRoot = createExtension({
      schemaVersion: 1,
      groups: [
        {
          baseUrlWhitelist: ['https://API.Example.com:443/v1'],
          headerNames: ['X-User-Account'],
        },
      ],
    });

    const first = inspectExtensionNetworkPolicyManifest(extensionRoot);
    const second = inspectExtensionNetworkPolicyManifest(extensionRoot);

    expect(first?.manifest.groups[0].baseUrlWhitelist).toEqual(['https://api.example.com/v1/']);
    expect(first?.manifest).toEqual(second?.manifest);
  });

  it.each([
    ['loopback target', 'https://127.0.0.1/v1/', 'X-User-Account'],
    ['IPv4 link-local target', 'https://169.254.169.254/v1/', 'X-User-Account'],
    ['IPv6 link-local target', 'https://[fe80::1]/v1/', 'X-User-Account'],
    ['IPv6 unspecified target', 'https://[::]/v1/', 'X-User-Account'],
    ['transport header', 'https://api.example.com/v1/', 'Host'],
  ])('rejects an unsafe %s', (_label, baseUrl, headerName) => {
    const extensionRoot = createExtension({
      schemaVersion: 1,
      groups: [
        {
          baseUrlWhitelist: [baseUrl],
          headerNames: [headerName],
        },
      ],
    });

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow();
  });

  it('accepts explicit intranet HTTP addresses while preserving a non-default port and encoded path delimiters', () => {
    const extensionRoot = createExtension({
      schemaVersion: 1,
      groups: [{
        baseUrlWhitelist: [
          'http://10.1.2.3:443/v1%3Fpart%23fragment',
          'http://API.intranet.test:80/v1',
        ],
        headerNames: ['X-User-Account', 'X-Cookie'],
      }],
    });

    expect(inspectExtensionNetworkPolicyManifest(extensionRoot)?.manifest.groups[0].baseUrlWhitelist)
      .toEqual([
        'http://10.1.2.3:443/v1%3Fpart%23fragment/',
        'http://api.intranet.test/v1/',
      ]);
  });

  it.each([
    { name: 'non-string', value: 42, key: 'networkPolicyUrlType' },
    { name: 'empty', value: '', key: 'networkPolicyUrlLength' },
    { name: 'too long', value: 'x'.repeat(2049), key: 'networkPolicyUrlLength' },
    { name: 'relative address', value: './private-source', key: 'networkPolicyUrlAbsolute' },
    { name: 'unsupported protocol', value: 'ftp://private.example.test/v1/', key: 'networkPolicyUrlProtocol' },
    { name: 'credentials', value: 'https://private-user:private-password@api.example.test/', key: 'networkPolicyUrlCredentials' },
    { name: 'query', value: 'http://api.example.test/?token=private-query', key: 'networkPolicyUrlQuery' },
    { name: 'empty query', value: 'https://api.example.test/?', key: 'networkPolicyUrlQuery' },
    { name: 'fragment', value: 'https://api.example.test/#private-fragment', key: 'networkPolicyUrlFragment' },
    { name: 'question mark inside a fragment', value: 'https://api.example.test/#section?label=private-fragment', key: 'networkPolicyUrlFragment' },
    { name: 'empty fragment', value: 'http://api.example.test/#', key: 'networkPolicyUrlFragment' },
    { name: 'local target', value: 'http://service.localhost/', key: 'networkPolicyUrlLocal' },
    { name: 'mapped unspecified target', value: 'https://[::ffff:0.0.0.0]/', key: 'networkPolicyUrlLocal' },
  ])('locates the original group and URL and explains the $name constraint without echoing the input', ({ value, key }) => {
    setLanguage('en');

    const reason = invalidUrlReason(value);

    expect(reason).toContain('outbound-header-policy.json, group 2, URL 2:');
    expect(reason).toContain(t(key));
    expect(reason).toContain('plugin provider');
    if (typeof value === 'string' && value) expect(reason).not.toContain(value);
    expect(sanitizeInstallationFailureReason(reason)).toBe(reason);
  });

  it.each(['zh', 'en'] as const)('reports the declaration position in %s while keeping secret URL parts out of local and marketplace errors', language => {
    setLanguage(language);
    const raw = 'http://private-user:private-password@private.example.test/private-path?token=private-query#private-fragment';

    const reason = invalidUrlReason(raw);

    expect(reason).toContain(language === 'zh'
      ? 'outbound-header-policy.json 第 2 组第 2 个 URL'
      : 'outbound-header-policy.json, group 2, URL 2');
    expect(reason).toContain(t('networkPolicyUrlCredentials'));
    expect(reason).not.toContain('private');
    expect(reason).not.toMatch(/重新安装|reinstall/i);
    expect(sanitizeInstallationFailureReason(reason)).toBe(reason);
  });

  it('rejects the unpublished policies shape', () => {
    const extensionRoot = createExtension({
      schemaVersion: 1,
      policies: [],
    });

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow(
      'unsupported top-level fields',
    );
  });

  it('does not confuse a hexadecimal-looking DNS name with an IPv6 link-local address', () => {
    const extensionRoot = createExtension({
      schemaVersion: 1,
      groups: [
        {
          baseUrlWhitelist: ['https://fe80.example.com/v1/'],
          headerNames: ['X-User-Account'],
        },
      ],
    });

    expect(inspectExtensionNetworkPolicyManifest(extensionRoot)?.manifest.groups).toHaveLength(1);
  });

  it('rejects a hard-linked policy manifest', () => {
    const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-network-policy-'));
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-network-policy-source-'));
    tempDirectories.push(extensionRoot, sourceRoot);
    const sourcePath = path.join(sourceRoot, 'policy.json');
    fs.writeFileSync(sourcePath, JSON.stringify({ schemaVersion: 1, groups: [] }), 'utf8');
    fs.linkSync(sourcePath, path.join(extensionRoot, 'outbound-header-policy.json'));

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow('unlinked file');
  });

  it('rejects a symbolic-link policy manifest when the platform permits creating one', () => {
    const extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-network-policy-'));
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-network-policy-source-'));
    tempDirectories.push(extensionRoot, sourceRoot);
    const sourcePath = path.join(sourceRoot, 'policy.json');
    fs.writeFileSync(sourcePath, JSON.stringify({ schemaVersion: 1, groups: [] }), 'utf8');
    try {
      fs.symlinkSync(sourcePath, path.join(extensionRoot, 'outbound-header-policy.json'), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow('unlinked file');
  });
});
