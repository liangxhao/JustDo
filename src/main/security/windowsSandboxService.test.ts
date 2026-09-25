import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveMxcSdkBinDirectory,
  resolveWindowsSandboxPluginDirectory,
  verifyMxcNativeBinaryIntegrity,
  WindowsSandboxService,
} from './windowsSandboxService';

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-mxc-sandbox-'));
  temporaryDirectories.push(directory);
  return directory;
};

const makePlugin = (appPath: string): string => {
  const pluginDirectory = path.join(
    appPath,
    'vendor',
    'openclaw-runtime',
    'current',
    'dist',
    'extensions',
    'mxc',
  );
  const binDirectory = path.join(
    pluginDirectory,
    'node_modules',
    '@microsoft',
    'mxc-sdk',
    'bin',
    'x64',
  );
  fs.mkdirSync(binDirectory, { recursive: true });
  fs.writeFileSync(path.join(pluginDirectory, 'openclaw.plugin.json'), '{}');
  fs.writeFileSync(path.join(pluginDirectory, 'package.json'), '{"version":"2026.9.2"}');
  fs.writeFileSync(
    path.join(pluginDirectory, 'node_modules', '@microsoft', 'mxc-sdk', 'package.json'),
    '{"version":"0.7.0"}',
  );
  fs.writeFileSync(path.join(binDirectory, 'wxc-exec.exe'), 'fixture');
  fs.writeFileSync(path.join(binDirectory, 'wxc-host-prep.exe'), 'fixture');
  return pluginDirectory;
};

const sandboxRuntimeChecks = () => ({
  nativeBinaryVerifier: vi.fn((pluginDirectory: string) => {
    const sdkBinDirectory = path.join(
      pluginDirectory,
      'node_modules',
      '@microsoft',
      'mxc-sdk',
      'bin',
      'x64',
    );
    return {
      sdkBinDirectory,
      executablePath: path.join(sdkBinDirectory, 'wxc-exec.exe'),
      hostPrepPath: path.join(sdkBinDirectory, 'wxc-host-prep.exe'),
      executableHash: 'EXEC-HASH',
      hostPrepHash: 'PREP-HASH',
    };
  }),
  processContainerProbe: vi.fn(async () => undefined),
  systemDrivePreparationProbe: vi.fn(async () => undefined),
  authenticodeVerifier: vi.fn(async () => undefined),
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Windows MXC sandbox resource discovery', () => {
  it('discovers the preinstalled MXC plugin and SDK executables', () => {
    const appPath = makeTemporaryDirectory();
    const pluginDirectory = makePlugin(appPath);

    expect(
      resolveWindowsSandboxPluginDirectory({
        platform: 'win32',
        arch: 'x64',
        isPackaged: false,
        resourcesPath: makeTemporaryDirectory(),
        appPath,
        systemRoot: 'C:\\Windows',
        systemDrive: 'C:',
        execFile: vi.fn(),
      }),
    ).toBe(pluginDirectory);
    expect(resolveMxcSdkBinDirectory(pluginDirectory, 'x64')).toContain(path.join('bin', 'x64'));
  });

  it('uses only the packaged cfmind runtime for installed builds', () => {
    const resourcesPath = makeTemporaryDirectory();
    const pluginDirectory = path.join(resourcesPath, 'cfmind', 'dist', 'extensions', 'mxc');
    const binDirectory = path.join(
      pluginDirectory,
      'node_modules',
      '@microsoft',
      'mxc-sdk',
      'bin',
      'x64',
    );
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(path.join(pluginDirectory, 'openclaw.plugin.json'), '{}');
    fs.writeFileSync(path.join(pluginDirectory, 'package.json'), '{}');
    fs.writeFileSync(path.join(binDirectory, 'wxc-exec.exe'), 'fixture');
    fs.writeFileSync(path.join(binDirectory, 'wxc-host-prep.exe'), 'fixture');

    expect(
      resolveWindowsSandboxPluginDirectory({
        platform: 'win32',
        arch: 'x64',
        isPackaged: true,
        resourcesPath,
        appPath: makeTemporaryDirectory(),
        systemRoot: 'C:\\Windows',
        systemDrive: 'C:',
        execFile: vi.fn(),
      }),
    ).toBe(pluginDirectory);
  });
});

describe('Windows MXC sandbox readiness', () => {
  it('uses containerId for both native probes without the unsupported ProcessContainer name', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const statSync = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
      if (args[0] === 'C:\\Windows\\System32\\cmd.exe') {
        return { isFile: () => true } as fs.Stats;
      }
      return statSync(...args);
    });
    const runFile = vi.fn(async (_executable: string, _args: readonly string[]) => ({
      stdout: '',
      stderr: '',
    }));
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      systemRoot: 'C:\\Windows',
      systemDrive: 'C:',
      nativeBinaryVerifier: sandboxRuntimeChecks().nativeBinaryVerifier,
      execFile: runFile,
    });

    await expect(service.getStatus()).resolves.toMatchObject({ code: 'ready', ready: true });
    const probeCalls = runFile.mock.calls.filter(([executable]) =>
      executable.endsWith('wxc-exec.exe'),
    );
    expect(probeCalls).toHaveLength(2);
    const configs = probeCalls.map(([, args]) => {
      expect(args[0]).toBe('--config-base64');
      return JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
    });
    for (const config of configs) {
      expect(config.containerId).toMatch(/^justdo-mxc-probe-[a-f0-9]+$/);
      expect(config.containment).toBe('processcontainer');
      expect(config.processContainer).not.toHaveProperty('name');
      expect(config.processContainer.leastPrivilege).toBe(true);
      expect(config.network.defaultPolicy).toBe('block');
    }
    expect(configs[0].containerId).not.toBe(configs[1].containerId);
    expect(configs[0].process.commandLine).toContain('/d /c exit 0');
    expect(configs[1].process.commandLine).toContain('/d /c dir C:\\ >nul');
  });

  it('rejects a tampered version-pinned native helper', () => {
    const appPath = makeTemporaryDirectory();
    const pluginDirectory = makePlugin(appPath);
    const fixtureHash = crypto.createHash('sha256').update('fixture').digest('hex').toUpperCase();
    const manifest = {
      pluginVersion: '2026.9.2',
      sdkVersion: '0.7.0',
      signerThumbprint: 'TEST',
      sha256: {
        x64: {
          'wxc-exec.exe': fixtureHash,
          'wxc-host-prep.exe': fixtureHash,
        },
        arm64: {
          'wxc-exec.exe': fixtureHash,
          'wxc-host-prep.exe': fixtureHash,
        },
      },
    };
    expect(() => verifyMxcNativeBinaryIntegrity(pluginDirectory, 'x64', manifest)).not.toThrow();

    fs.writeFileSync(
      path.join(
        pluginDirectory,
        'node_modules',
        '@microsoft',
        'mxc-sdk',
        'bin',
        'x64',
        'wxc-host-prep.exe',
      ),
      'tampered',
    );

    expect(() => verifyMxcNativeBinaryIntegrity(pluginDirectory, 'x64', manifest)).toThrow(
      /host preparation integrity check failed/,
    );
  });

  it('reports ready when IsoEnvBroker and a sandboxed system-drive listing are available', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runFile = vi.fn(async () => ({ stdout: 'SERVICE_NAME', stderr: '' }));
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      execFile: runFile,
      ...sandboxRuntimeChecks(),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      code: 'ready',
      helperAvailable: true,
      initialized: true,
      ready: true,
    });
  });

  it('keeps the sandbox usable while recommending optional host preparation', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runtimeChecks = sandboxRuntimeChecks();
    runtimeChecks.systemDrivePreparationProbe.mockRejectedValue(new Error('Access is denied'));
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...runtimeChecks,
      execFile: vi.fn(async () => ({ stdout: '', stderr: '' })),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      code: 'host_preparation_recommended',
      hostPreparationRecommended: true,
      ready: true,
    });
  });

  it('fails closed when IsoEnvBroker is unavailable', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...sandboxRuntimeChecks(),
      execFile: vi.fn(async executable => {
        if (executable.toLowerCase().endsWith('sc.exe')) throw new Error('service missing');
        return { stdout: '', stderr: '' };
      }),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      code: 'broker_unavailable',
      ready: false,
    });
  });

  it('fails closed when the real ProcessContainer probe cannot launch', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runtimeChecks = sandboxRuntimeChecks();
    runtimeChecks.processContainerProbe.mockRejectedValue(new Error('unsupported Windows build'));
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...runtimeChecks,
      execFile: vi.fn(async executable => ({
        stdout: executable.toLowerCase().endsWith('icacls.exe') ? 'S-1-15-2-1:(RX)' : '',
        stderr: '',
      })),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      code: 'check_failed',
      ready: false,
      error: expect.stringContaining('unsupported Windows build'),
    });
  });

  it('fails closed when a packaged native binary fails integrity verification', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runtimeChecks = sandboxRuntimeChecks();
    runtimeChecks.nativeBinaryVerifier.mockImplementation(() => {
      throw new Error('MXC executor integrity check failed');
    });
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...runtimeChecks,
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      code: 'check_failed',
      ready: false,
      error: expect.stringContaining('integrity check failed'),
    });
  });

  it('revalidates the signed helper inside the elevated host preparation flow', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runtimeChecks = sandboxRuntimeChecks();
    let prepared = false;
    runtimeChecks.systemDrivePreparationProbe.mockImplementation(async () => {
      if (!prepared) throw new Error('Access is denied');
    });
    const runFile = vi.fn(
      async (
        executable: string,
        _args: readonly string[],
        options?: { env?: NodeJS.ProcessEnv },
      ) => {
        if (executable.toLowerCase().endsWith('sc.exe')) return { stdout: '', stderr: '' };
        if (executable.toLowerCase().endsWith('powershell.exe')) prepared = true;
        expect(options?.env).toMatchObject({
          JUSTDO_MXC_HOST_PREP_SHA256: 'PREP-HASH',
          JUSTDO_MXC_SIGNER_THUMBPRINT: expect.any(String),
          JUSTDO_MXC_ELEVATED_SCRIPT: expect.any(String),
        });
        return { stdout: '', stderr: '' };
      },
    );
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...runtimeChecks,
      execFile: runFile,
    });

    await expect(service.initialize('C:\\workspace')).resolves.toMatchObject({ success: true });
    expect(runtimeChecks.authenticodeVerifier).toHaveBeenCalledOnce();
    expect(runFile).toHaveBeenCalledWith(
      expect.stringMatching(/powershell\.exe$/i),
      expect.arrayContaining(['-EncodedCommand']),
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });
});
