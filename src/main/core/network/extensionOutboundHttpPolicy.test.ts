import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG } from '../../../config/outboundHeaders';
import type { InstalledOpenClawExtension } from '../../../shared/plugins/extensions';
import { OutboundHeaderPolicyService } from './outboundHeaderPolicyService';
import {
  resolveOutboundHeaderNamesForRequest,
  resolveOutboundHeaderProxyConfig,
} from './outboundHeaderProxy';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../../config/outboundHeaders', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../config/outboundHeaders')>()),
  PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG: {
    enabled: true,
    groups: [
      {
        baseUrlWhitelist: ['https://builtin-model.example.test/v1/'],
        headerNames: ['X-User-Account', 'X-Cookie'],
      },
    ],
  },
}));

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-http-policy-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function fixture() {
  const extensionRoot = path.join(fixtureRoot, 'extension');
  fs.mkdirSync(extensionRoot);
  fs.writeFileSync(
    path.join(extensionRoot, 'outbound-header-policy.json'),
    JSON.stringify({
      schemaVersion: 1,
      groups: [
        {
          baseUrlWhitelist: [
            'http://10.42.0.8:8080/v1',
            'http://SERVICE.Internal.Example:80/api',
            'https://secure.internal.example/v1',
            'http://port.internal.example:443/v1',
            'https://port.internal.example:80/v1',
          ],
          headerNames: ['X-User-Account', 'X-Cookie'],
        },
      ],
    }),
  );
  const extension: InstalledOpenClawExtension = {
    id: 'network-extension',
    name: 'Network extension',
    description: '',
    enabled: true,
    installPath: extensionRoot,
    missingRequirements: [],
    configurationFields: [],
  };
  let installed = true;
  let enabled = true;
  const service = new OutboundHeaderPolicyService({
    listInstalledExtensions: () => (installed ? [{ ...extension, enabled }] : []),
    configPath: path.join(fixtureRoot, 'policy.json'),
    userInfoPath: path.join(fixtureRoot, 'missing-user-info.json'),
  });
  return {
    service,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    remove: () => {
      installed = false;
    },
  };
}

test('accepts an explicit intranet HTTP policy and preserves exact runtime request boundaries', () => {
  const { service } = fixture();

  const snapshot = service.reconcile();
  const policy = resolveOutboundHeaderProxyConfig(snapshot);

  expect(snapshot.groups[1].baseUrlWhitelist).toEqual([
    'http://10.42.0.8:8080/v1/',
    'http://port.internal.example:443/v1/',
    'http://service.internal.example/api/',
    'https://port.internal.example:80/v1/',
    'https://secure.internal.example/v1/',
  ]);
  for (const target of [
    'http://10.42.0.8:8080/v1/models',
    'http://service.internal.example/api/models',
    'https://secure.internal.example/v1/models',
    'http://port.internal.example:443/v1/models',
    'https://port.internal.example:80/v1/models',
  ]) {
    expect(resolveOutboundHeaderNamesForRequest(policy, target)).toEqual([
      'X-Cookie',
      'X-User-Account',
    ]);
  }
  for (const target of [
    'https://10.42.0.8:8080/v1/models',
    'http://10.42.0.8:8081/v1/models',
    'http://10.42.0.9:8080/v1/models',
    'http://10.42.0.8:8080/v10/models',
    'http://port.internal.example/v1/models',
    'https://port.internal.example/v1/models',
  ]) {
    expect(resolveOutboundHeaderNamesForRequest(policy, target)).toEqual([]);
  }
});

test('removes HTTP contributions when disabled or uninstalled while preserving the built-in model policy', () => {
  const f = fixture();
  const target = 'http://10.42.0.8:8080/v1/models';
  const initial = f.service.reconcile();

  f.setEnabled(false);
  const disabled = f.service.reconcile();

  expect(disabled.groups).toEqual(PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG.groups);
  expect(
    resolveOutboundHeaderNamesForRequest(resolveOutboundHeaderProxyConfig(disabled), target),
  ).toEqual([]);
  f.setEnabled(true);
  expect(f.service.reconcile().digest).toBe(initial.digest);
  f.remove();
  const removed = f.service.reconcile();
  expect(removed.groups).toEqual(PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG.groups);
  expect(removed.enabled).toBe(true);
  const policy = resolveOutboundHeaderProxyConfig(removed);
  expect(resolveOutboundHeaderNamesForRequest(policy, target)).toEqual([]);
  expect(
    resolveOutboundHeaderNamesForRequest(policy, 'https://builtin-model.example.test/v1/models'),
  ).toEqual(['X-User-Account', 'X-Cookie']);
});
