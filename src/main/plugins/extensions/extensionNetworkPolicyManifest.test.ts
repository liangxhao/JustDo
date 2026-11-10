import fs from 'fs';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';

import { extractZipSafely } from '../../core/filesystem/safeZipExtractor';
import { getLanguage, setLanguage, t } from '../../core/i18n';
import { sanitizeInstallationFailureReason } from '../installation/installationFailureReason';
import { inspectExtensionNetworkPolicyManifest } from './extensionNetworkPolicyManifest';

const tempDirectories: string[] = [];
const validManifest = {
  schemaVersion: 1,
  groups: [{ baseUrlWhitelist: ['https://api.example.test/v1/'], headerNames: ['X-User-Account'] }],
};
let previousLanguage: ReturnType<typeof getLanguage>;

beforeEach(() => {
  previousLanguage = getLanguage();
  setLanguage('en');
});

const createExtension = (manifest: unknown = validManifest): string => {
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
  vi.restoreAllMocks();
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
  it('accepts the same policy in ZIP packages with different configuration and Chinese or spaced names', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-policy-archive-'));
    tempDirectories.push(root);
    const policyText = JSON.stringify(validManifest, null, 2);
    const manifests = [];
    for (const name of ['ExampleGenerator', '配置修改 B']) {
      const archivePath = path.join(root, `${name}.zip`);
      const extracted = path.join(root, `${name} extracted`);
      const zip = new ZipFile();
      zip.addBuffer(Buffer.from(JSON.stringify({
        id: 'example-generator',
        configSchema: { type: 'object', properties: { label: { type: 'string', default: name } } },
      })), `${name}/openclaw.plugin.json`);
      zip.addBuffer(Buffer.from(policyText), `${name}/outbound-header-policy.json`);
      const writing = pipeline(zip.outputStream, fs.createWriteStream(archivePath));
      zip.end();
      await writing;

      await extractZipSafely(archivePath, extracted);
      const extensionRoot = path.join(extracted, name);
      manifests.push(inspectExtensionNetworkPolicyManifest(extensionRoot)?.manifest);

      expect(fs.readFileSync(path.join(extensionRoot, 'outbound-header-policy.json'), 'utf8')).toBe(policyText);
    }
    expect(manifests).toEqual([validManifest, validManifest]);
  });

  it.each(['zh', 'en'] as const)('identifies a directory instead of a policy file in %s without exposing paths', language => {
    setLanguage(language);
    const extensionRoot = createExtension();
    const manifestPath = path.join(extensionRoot, 'outbound-header-policy.json');
    fs.unlinkSync(manifestPath);
    fs.mkdirSync(manifestPath);

    let reason = '';
    try { inspectExtensionNetworkPolicyManifest(extensionRoot); }
    catch (error) { reason = (error as Error).message; }

    expect(reason).toContain('outbound-header-policy.json');
    expect(reason).toContain(t('networkPolicyFileBeforeOpen'));
    expect(reason).toContain(t('networkPolicyFileNotRegular'));
    expect(reason).not.toContain(extensionRoot);
    expect(sanitizeInstallationFailureReason(reason)).toBe(reason);
  });

  it('accepts the 64 KiB boundary and reports the actual size when it is exceeded', () => {
    const extensionRoot = createExtension();
    const manifestPath = path.join(extensionRoot, 'outbound-header-policy.json');
    fs.writeFileSync(manifestPath, JSON.stringify(validManifest).padEnd(65536, ' '));
    expect(inspectExtensionNetworkPolicyManifest(extensionRoot)?.manifest).toEqual(validManifest);
    fs.appendFileSync(manifestPath, ' ');

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow('65537 bytes');
  });

  it('reports an unexpected open-file link count without calling it a hard link and closes the file', () => {
    const extensionRoot = createExtension();
    const stat = fs.lstatSync(path.join(extensionRoot, 'outbound-header-policy.json'));
    vi.spyOn(fs, 'fstatSync').mockReturnValueOnce(Object.assign(stat, { nlink: 0 }));
    const close = vi.spyOn(fs, 'closeSync');

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow('reported file link count is 0');
    expect(close).toHaveBeenCalledOnce();
  });

  it('distinguishes file identifier mismatches from size or link errors and closes the file', () => {
    const extensionRoot = createExtension();
    const stat = fs.lstatSync(path.join(extensionRoot, 'outbound-header-policy.json'));
    vi.spyOn(fs, 'fstatSync').mockReturnValueOnce(Object.assign(stat, { dev: stat.dev + 1 }));
    const close = vi.spyOn(fs, 'closeSync');

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow('file identifiers differ');
    expect(close).toHaveBeenCalledOnce();
  });

  it('reports an identity mismatch at path recheck and closes the file', () => {
    const extensionRoot = createExtension();
    const stat = fs.lstatSync(path.join(extensionRoot, 'outbound-header-policy.json'));
    const changed = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 });
    vi.spyOn(fs, 'lstatSync').mockReturnValueOnce(stat).mockReturnValueOnce(changed);
    const close = vi.spyOn(fs, 'closeSync');

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow(
      'outbound-header-policy.json (rechecking the file path): The file identifiers differ',
    );
    expect(close).toHaveBeenCalledOnce();
  });

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

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow('reported file link count is 2');
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

    expect(() => inspectExtensionNetworkPolicyManifest(extensionRoot)).toThrow('symbolic link');
  });
});
