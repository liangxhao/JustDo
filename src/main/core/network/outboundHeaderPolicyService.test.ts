import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

import {
  DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG,
  PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG,
} from '../../../config/outboundHeaders';
import type { InstalledOpenClawExtension } from '../../../shared/plugins/extensions';
import {
  applyMainProcessOutboundHeaderPolicy,
  MainProcessOutboundHeaderSource,
} from './mainProcessFetch';
import {
  getOutboundHeaderUserInfo,
  updateOutboundHeaderUserInfoCache,
} from './outboundHeaderPolicyConfig';
import { OutboundHeaderPolicyService } from './outboundHeaderPolicyService';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('creates an empty config.json while using the built-in policy', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-effective-policy-'));
  tempDirectories.push(directory);
  const configPath = path.join(directory, 'config.json');
  const service = new OutboundHeaderPolicyService({
    listInstalledExtensions: () => [],
    configPath,
    userInfoPath: path.join(directory, 'user_info.json'),
  });

  expect(service.reconcile().groups).toEqual(PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG.groups);
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG);
});

test('injects login headers only within an explicitly configured LiteLLM URL boundary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-litellm-policy-'));
  tempDirectories.push(directory);
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, JSON.stringify({
    'X-User-Account': 'user-fixture', 'X-Cookie': 'cookie-fixture', mtoken: 'mtoken-fixture',
  }));
  const baseUrl = 'https://model.example.test/litellm/v1';
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    groups: [{ baseUrlWhitelist: [baseUrl], headerNames: ['X-User-Account', 'X-Cookie'] }],
  }));
  const service = new OutboundHeaderPolicyService({
    listInstalledExtensions: () => [], configPath, userInfoPath,
  });
  service.reconcile();
  const source = MainProcessOutboundHeaderSource.SessionTitle;
  expect(applyMainProcessOutboundHeaderPolicy(`${baseUrl}/chat/completions`, {}, source)).toEqual({
    'X-User-Account': 'user-fixture', 'X-Cookie': 'cookie-fixture',
  });
  expect(applyMainProcessOutboundHeaderPolicy(`${baseUrl}-other/chat/completions`, {}, source)).toEqual({});
  expect(applyMainProcessOutboundHeaderPolicy('https://untrusted.example/v1/chat/completions', {}, source)).toEqual({});
});

test('does not duplicate a default group written by an older version', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-effective-policy-'));
  tempDirectories.push(directory);
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG));
  const service = new OutboundHeaderPolicyService({
    listInstalledExtensions: () => [],
    configPath,
    userInfoPath: path.join(directory, 'user_info.json'),
  });

  expect(service.reconcile().groups).toEqual(PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG.groups);
});

test('merges enabled native-retained Extension contributions with the manual policy', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-effective-policy-'));
  tempDirectories.push(directory);
  const extensionDirectory = path.join(directory, 'extension');
  fs.mkdirSync(extensionDirectory);
  fs.writeFileSync(
    path.join(extensionDirectory, 'outbound-header-policy.json'),
    JSON.stringify({
      schemaVersion: 1,
      groups: [
        {
          baseUrlWhitelist: ['https://extension.example/v1/'],
          headerNames: ['X-Extension-Token'],
        },
      ],
    }),
  );
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      groups: [
        {
          baseUrlWhitelist: ['https://manual.example/v1/'],
          headerNames: ['X-Manual-Token'],
        },
      ],
    }),
  );
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(
    userInfoPath,
    JSON.stringify({ 'X-Manual-Token': 'manual', 'X-Extension-Token': 'extension' }),
  );

  let extensionEnabled = true;
  const installed = (): InstalledOpenClawExtension[] => [
    {
      id: 'example',
      name: 'Example',
      description: '',
      installPath: extensionDirectory,
      enabled: extensionEnabled,
      missingRequirements: [],
      configurationFields: [],
    },
  ];
  const service = new OutboundHeaderPolicyService({
    listInstalledExtensions: installed,
    configPath,
    userInfoPath,
  });
  const policyPath = path.join(extensionDirectory, 'outbound-header-policy.json');
  fs.linkSync(policyPath, path.join(directory, 'retained-policy.json'));
  expect(fs.statSync(policyPath).nlink).toBe(2);
  expect(service.inspectExtension(extensionDirectory)).not.toBeNull();

  const enabled = service.reconcile();
  expect(enabled.groups).toHaveLength(3);
  expect(getOutboundHeaderUserInfo()).toEqual({
    'X-User-Account': '',
    'X-Cookie': '',
    'X-Manual-Token': 'manual',
    'X-Extension-Token': 'extension',
  });
  expect(
    applyMainProcessOutboundHeaderPolicy(
      'https://extension.example/v1/models',
      undefined,
      MainProcessOutboundHeaderSource.ModelProbe,
    ),
  ).toEqual({ 'X-Extension-Token': 'extension' });

  fs.writeFileSync(
    userInfoPath,
    JSON.stringify({ 'X-Manual-Token': 'manual', 'X-Extension-Token': 'renewed' }),
  );
  expect(updateOutboundHeaderUserInfoCache(userInfoPath)).toEqual({
    'X-User-Account': '',
    'X-Cookie': '',
    'X-Manual-Token': 'manual',
    'X-Extension-Token': 'renewed',
  });
  expect(
    applyMainProcessOutboundHeaderPolicy(
      'https://extension.example/v1/models',
      undefined,
      MainProcessOutboundHeaderSource.ModelProbe,
    ),
  ).toEqual({ 'X-Extension-Token': 'renewed' });

  extensionEnabled = false;
  expect(service.reconcile().groups).toHaveLength(2);

  fs.writeFileSync(configPath, '{"enabled":false,');
  expect(service.reconcile().groups).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG);

  extensionEnabled = true;
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      enabled: false,
      groups: [
        {
          baseUrlWhitelist: ['https://manual.example/v1/'],
          headerNames: ['X-Manual-Token'],
        },
      ],
    }),
  );
  expect(service.reconcile().groups).toHaveLength(0);
});

test('keeps the manual policy when Extension inventory cannot be read', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-effective-policy-'));
  tempDirectories.push(directory);
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      enabled: true,
      groups: [
        {
          baseUrlWhitelist: ['https://manual.example/v1/'],
          headerNames: ['X-Manual-Token'],
        },
      ],
    }),
  );
  const service = new OutboundHeaderPolicyService({
    listInstalledExtensions: () => {
      throw new Error('inventory unavailable');
    },
    configPath,
    userInfoPath: path.join(directory, 'user_info.json'),
  });

  expect(service.reconcile().groups).toEqual([
    {
      baseUrlWhitelist: [...PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG.groups[0].baseUrlWhitelist],
      headerNames: ['X-User-Account', 'X-Cookie'],
    },
    {
      baseUrlWhitelist: ['https://manual.example/v1/'],
      headerNames: ['X-Manual-Token'],
    },
  ]);
});

test('keeps the policy digest stable when a duplicate multi-URL Extension contribution is added or removed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-policy-duplicate-'));
  tempDirectories.push(directory);
  const configPath = path.join(directory, 'config.json');
  const existingModelUrl = 'https://built-in-model.example.test/v1/';
  const manual = {
    enabled: true,
    groups: [{ baseUrlWhitelist: [existingModelUrl], headerNames: ['X-User-Account', 'X-Cookie'] }],
  };
  fs.writeFileSync(configPath, JSON.stringify(manual));
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, JSON.stringify({
    'X-User-Account': 'account-fixture', 'X-Cookie': 'cookie-fixture',
  }));
  const urls = ['https://api-one.example.test/v1/', 'https://api-two.example.test/service/'];
  const entries = ['first', 'second'].map(id => {
    const installPath = path.join(directory, id);
    fs.mkdirSync(installPath);
    fs.writeFileSync(path.join(installPath, 'outbound-header-policy.json'), JSON.stringify({
      schemaVersion: 1,
      groups: [{ baseUrlWhitelist: urls, headerNames: ['X-User-Account', 'X-Cookie'] }],
    }));
    return {
      id, name: id, description: '', enabled: true, installPath,
      missingRequirements: [], configurationFields: [],
    };
  });
  let installed = [entries[0]];
  const service = new OutboundHeaderPolicyService({
    listInstalledExtensions: () => installed, configPath, userInfoPath,
  });
  const first = service.reconcile();
  installed = entries;
  const both = service.reconcile();
  expect(both.digest).toBe(first.digest);
  expect(both.groups).toEqual(first.groups);
  for (const url of urls) {
    expect(applyMainProcessOutboundHeaderPolicy(`${url}models`, {}, MainProcessOutboundHeaderSource.ModelProbe)).toEqual({
      'X-User-Account': 'account-fixture', 'X-Cookie': 'cookie-fixture',
    });
  }
  installed = [entries[0]];
  expect(service.reconcile().digest).toBe(first.digest);
  installed = [];
  const removed = service.reconcile();
  expect(removed.digest).not.toBe(first.digest);
  expect(removed.enabled).toBe(true);
  expect(applyMainProcessOutboundHeaderPolicy(`${existingModelUrl}models`, {}, MainProcessOutboundHeaderSource.ModelProbe)).toEqual({
    'X-User-Account': 'account-fixture', 'X-Cookie': 'cookie-fixture',
  });
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(manual);
});

test('preserves the precedence of overlapping groups with distinct Header casing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-policy-precedence-'));
  tempDirectories.push(directory);
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ enabled: true, groups: [] }));
  const userInfoPath = path.join(directory, 'user_info.json');
  fs.writeFileSync(userInfoPath, JSON.stringify({
    'X-Cookie': 'upper-fixture', 'x-cookie': 'lower-fixture',
  }));
  const url = 'https://api-one.example.test/v1/';
  const entries = ['X-Cookie', 'x-cookie', 'X-Cookie'].map((header, index) => {
    const id = `extension-${index}`;
    const installPath = path.join(directory, id);
    fs.mkdirSync(installPath);
    fs.writeFileSync(path.join(installPath, 'outbound-header-policy.json'), JSON.stringify({
      schemaVersion: 1, groups: [{ baseUrlWhitelist: [url], headerNames: [header] }],
    }));
    return {
      id, name: id, description: '', enabled: true, installPath,
      missingRequirements: [], configurationFields: [],
    };
  });
  let installed = entries;
  const service = new OutboundHeaderPolicyService({
    listInstalledExtensions: () => installed, configPath, userInfoPath,
  });
  const before = service.reconcile();
  expect(before.groups.slice(PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG.groups.length)).toHaveLength(2);
  expect(applyMainProcessOutboundHeaderPolicy(`${url}models`, {}, MainProcessOutboundHeaderSource.ModelProbe)).toEqual({
    'X-Cookie': 'upper-fixture',
  });
  installed = entries.slice(1);
  const after = service.reconcile();
  expect(after.digest).not.toBe(before.digest);
  expect(applyMainProcessOutboundHeaderPolicy(`${url}models`, {}, MainProcessOutboundHeaderSource.ModelProbe)).toEqual({
    'x-cookie': 'lower-fixture',
  });
});
