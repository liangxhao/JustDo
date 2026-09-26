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
import type { InstalledOpenClawExtension } from '../../../shared/openclaw/extensions';
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

test('automatically merges enabled Extension contributions with the manual policy', () => {
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
  expect(service.getSnapshot().groups).toHaveLength(3);
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
      baseUrlWhitelist: [],
      headerNames: ['X-User-Account', 'X-Cookie'],
    },
    {
      baseUrlWhitelist: ['https://manual.example/v1/'],
      headerNames: ['X-Manual-Token'],
    },
  ]);
});
