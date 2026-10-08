import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveMxcSdkBinDirectory,
  resolveWindowsSandboxPluginDirectory,
  verifyMxcNativeBinaryIntegrity,
  WindowsSandboxService,
} from './windowsSandboxService';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

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
  nativeHostProbe: vi.fn(async () => 'appcontainer-dacl' as const),
  processContainerProbe: vi.fn(async () => undefined),
  systemDrivePreparationProbe: vi.fn(async () => undefined),
  systemDrivePreparationNeededProbe: vi.fn(async () => false),
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
  it('runs DACL probes without requesting system-drive or shared temporary-directory access', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const statSync = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
      if (args[0] === 'C:\\Windows\\System32\\cmd.exe') {
        return { isFile: () => true } as fs.Stats;
      }
      return statSync(...args);
    });
    const runFile = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === '--config-base64') {
        const config = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
        if (config.filesystem.readonlyPaths.includes('C:\\')) {
          throw new Error("DACL fallback requires write-DAC permission on 'C:\\'");
        }
        expect(fs.existsSync(config.process.cwd)).toBe(true);
      }
      return {
        stdout: args[0] === '--probe' ? JSON.stringify({ tier: 'appcontainer-dacl' }) : '',
        stderr: '',
      };
    });
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      systemRoot: 'C:\\Windows',
      systemDrive: 'C:',
      localAppData: 'C:\\Users\\probe\\AppData\\Local',
      nativeBinaryVerifier: sandboxRuntimeChecks().nativeBinaryVerifier,
      execFile: runFile,
    });

    await expect(service.getStatus()).resolves.toMatchObject({ code: 'ready', ready: true });
    const probeCalls = runFile.mock.calls.filter(
      ([executable, args]) => executable.endsWith('wxc-exec.exe') && args[0] === '--config-base64',
    );
    expect(runFile).toHaveBeenCalledWith(
      expect.stringMatching(/wxc-exec\.exe$/),
      ['--probe'],
      expect.objectContaining({ timeout: 5_000, windowsHide: true }),
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
      expect(config.filesystem.readonlyPaths).toEqual(['C:\\Windows\\System32']);
      expect(config.filesystem.readwritePaths).toEqual([config.process.cwd]);
      expect(path.dirname(config.process.cwd)).toBe(os.tmpdir());
      expect(config.process.cwd).not.toBe(os.tmpdir());
      expect(config.process.env).toEqual([
        'SystemRoot=C:\\Windows',
        'WINDIR=C:\\Windows',
        'SystemDrive=C:',
        'ComSpec=C:\\Windows\\System32\\cmd.exe',
        'LOCALAPPDATA=C:\\Users\\probe\\AppData\\Local',
        `TEMP=${config.process.cwd}`,
        `TMP=${config.process.cwd}`,
      ]);
      expect(fs.existsSync(config.process.cwd)).toBe(false);
    }
    expect(configs[0].containerId).not.toBe(configs[1].containerId);
    expect(configs[0].process.commandLine).toContain('/d /e:on /c for %I in ("C:\\")');
    expect(configs[0].process.commandLine).toContain('if "%~aI"=="" (exit /b 1) else (exit /b 0)');
    expect(configs[0].process.commandLine).not.toMatch(/\bdir\b|>nul|[\*\?]/);
    expect(configs[1].process.commandLine).toContain('/d /c exit 0');
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

  it('reports ready after native host and sandboxed system-drive metadata checks pass', async () => {
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
    runtimeChecks.systemDrivePreparationNeededProbe.mockResolvedValue(true);
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

  it.each(['base-container', 'appcontainer-bfs'] as const)(
    'does not recommend system-drive ACL preparation for %s',
    async tier => {
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
        nativeHostProbe: vi.fn(async () => tier),
      });

      await expect(service.getStatus()).resolves.toMatchObject({
        code: 'ready',
        ready: true,
        hostPreparationRecommended: false,
      });
      await expect(service.initialize('C:\\workspace')).resolves.toMatchObject({ success: true });
      expect(runtimeChecks.systemDrivePreparationProbe).not.toHaveBeenCalled();
      expect(runtimeChecks.authenticodeVerifier).not.toHaveBeenCalled();
      expect(runtimeChecks.processContainerProbe).toHaveBeenCalledOnce();
    },
  );

  it('cleans the private probe directory and reports only the native failure when launch fails', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const statSync = fs.statSync;
    const systemRoot = 'C:\\Windows 测试';
    vi.spyOn(fs, 'statSync').mockImplementation((...args) => {
      if (args[0] === path.win32.join(systemRoot, 'System32', 'cmd.exe')) {
        return { isFile: () => true } as fs.Stats;
      }
      return statSync(...args);
    });
    let probeDirectory = '';
    const nativeReason =
      "BaseContainer is unavailable; DACL fallback requires write-DAC permission on 'C:\\protected'.";
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...sandboxRuntimeChecks(),
      systemRoot,
      processContainerProbe: undefined,
      execFile: vi.fn(async (_executable, args) => {
        const config = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
        probeDirectory = config.process.cwd;
        expect(config.process.commandLine).toBe(
          '"C:\\Windows 测试\\System32\\cmd.exe" /d /c exit 0',
        );
        expect(fs.existsSync(probeDirectory)).toBe(true);
        throw Object.assign(new Error(`Command failed: wxc-exec.exe --config-base64 ${args[1]}`), {
          stderr: `error: ${nativeReason}{"error":{"code":"backend_error"}}\nSECTION: Full ExecutionRequest configuration\n${JSON.stringify(config)}`,
        });
      }),
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      code: 'check_failed',
      ready: false,
      error: `MXC ProcessContainer self-check failed: ${nativeReason}`,
    });
    expect(probeDirectory).not.toBe('');
    expect(fs.existsSync(probeDirectory)).toBe(false);
  });

  it('bounds the native error detail shown by the settings page', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runtimeChecks = sandboxRuntimeChecks();
    runtimeChecks.processContainerProbe.mockRejectedValue(
      Object.assign(new Error('Command failed: wxc-exec.exe --config-base64 encoded-request'), {
        stderr: `error: ${'a'.repeat(2_000)}\nSECTION: request`,
      }),
    );
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...runtimeChecks,
    });

    const status = await service.getStatus();

    expect(status.ready).toBe(false);
    expect(status.error).toBe(`MXC ProcessContainer self-check failed: ${'a'.repeat(1_024)}`);
  });

  it('allows ProcessContainer when native checks pass without the unrelated IsoEnvBroker service', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runtimeChecks = sandboxRuntimeChecks();
    const runFile = vi.fn(async (executable: string) => {
      if (executable.toLowerCase().endsWith('sc.exe')) throw new Error('service missing');
      return { stdout: '', stderr: '' };
    });
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...runtimeChecks,
      execFile: runFile,
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      code: 'ready',
      ready: true,
    });
    expect(runtimeChecks.nativeHostProbe).toHaveBeenCalledOnce();
    expect(runtimeChecks.processContainerProbe).toHaveBeenCalledOnce();
    expect(runFile).not.toHaveBeenCalled();
  });

  it.each(['base-container', 'appcontainer-bfs', 'appcontainer-dacl'])(
    'accepts the executor host probe tier %s before testing a real container',
    async tier => {
      const appPath = makeTemporaryDirectory();
      makePlugin(appPath);
      const runtimeChecks = sandboxRuntimeChecks();
      const service = new WindowsSandboxService({
        platform: 'win32',
        arch: 'x64',
        isPackaged: false,
        appPath,
        resourcesPath: makeTemporaryDirectory(),
        ...runtimeChecks,
        nativeHostProbe: undefined,
        execFile: vi.fn(async () => ({ stdout: JSON.stringify({ tier }), stderr: '' })),
      });

      await expect(service.getStatus()).resolves.toMatchObject({ code: 'ready', ready: true });
      expect(runtimeChecks.processContainerProbe).toHaveBeenCalledOnce();
    },
  );

  it.each(['invalid JSON', 'null', '{}', '{"tier":"unsupported"}'])(
    'rejects an invalid executor host probe without launching: %s',
    async stdout => {
      const appPath = makeTemporaryDirectory();
      makePlugin(appPath);
      const runtimeChecks = sandboxRuntimeChecks();
      const service = new WindowsSandboxService({
        platform: 'win32',
        arch: 'x64',
        isPackaged: false,
        appPath,
        resourcesPath: makeTemporaryDirectory(),
        ...runtimeChecks,
        nativeHostProbe: undefined,
        execFile: vi.fn(async () => ({ stdout, stderr: '' })),
      });

      await expect(service.getStatus()).resolves.toMatchObject({
        code: 'check_failed',
        ready: false,
      });
      expect(runtimeChecks.processContainerProbe).not.toHaveBeenCalled();
      expect(runtimeChecks.systemDrivePreparationProbe).not.toHaveBeenCalled();
    },
  );

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

  it('offers explicit preparation when missing root metadata also prevents a DACL process launch', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runtimeChecks = sandboxRuntimeChecks();
    let prepared = false;
    runtimeChecks.systemDrivePreparationNeededProbe.mockResolvedValue(true);
    runtimeChecks.systemDrivePreparationProbe.mockImplementation(async () => {
      if (!prepared) throw new Error('System-drive attributes are unavailable');
    });
    runtimeChecks.processContainerProbe.mockImplementation(async () => {
      if (!prepared) throw new Error('Process startup failed');
    });
    const runFile = vi.fn(async () => {
      prepared = true;
      return { stdout: '', stderr: '' };
    });
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...runtimeChecks,
      execFile: runFile,
    });

    await expect(service.getStatus()).resolves.toMatchObject({
      code: 'check_failed',
      ready: false,
      hostPreparationRecommended: true,
      error: expect.stringContaining('Process startup failed'),
    });
    expect(runFile).not.toHaveBeenCalled();
    await expect(service.initialize('C:\\workspace')).resolves.toMatchObject({
      success: true,
      status: { code: 'ready', ready: true, hostPreparationRecommended: false },
    });
    expect(runtimeChecks.authenticodeVerifier).toHaveBeenCalledOnce();
    expect(runFile).toHaveBeenCalledOnce();
  });

  it.each(['false', 'invalid JSON'])(
    'keeps a failed DACL launch blocked when the read-only preparation check returns %s',
    async stdout => {
      const appPath = makeTemporaryDirectory();
      makePlugin(appPath);
      const runtimeChecks = sandboxRuntimeChecks();
      runtimeChecks.systemDrivePreparationProbe.mockRejectedValue(
        new Error('Attributes unavailable'),
      );
      runtimeChecks.processContainerProbe.mockRejectedValue(new Error('Launch failed'));
      const runFile = vi.fn(async () => ({ stdout, stderr: '' }));
      const service = new WindowsSandboxService({
        platform: 'win32',
        arch: 'x64',
        isPackaged: false,
        appPath,
        resourcesPath: makeTemporaryDirectory(),
        ...runtimeChecks,
        systemDrivePreparationNeededProbe: undefined,
        execFile: runFile,
      });

      await expect(service.getStatus()).resolves.toMatchObject({
        code: 'check_failed',
        ready: false,
        hostPreparationRecommended: false,
        error: expect.stringContaining('Launch failed'),
      });
      expect(runtimeChecks.authenticodeVerifier).not.toHaveBeenCalled();
      expect(runFile).toHaveBeenCalledWith(
        expect.stringMatching(/powershell\.exe$/i),
        expect.arrayContaining(['-EncodedCommand']),
        expect.objectContaining({
          windowsHide: true,
          env: expect.objectContaining({ JUSTDO_MXC_SYSTEM_DRIVE_ROOT: expect.any(String) }),
        }),
      );
    },
  );

  it.runIf(process.platform === 'win32').each([
    {
      description: 'missing metadata rules',
      mockAcl: 'function Get-Acl { [pscustomobject]@{ Access = @() } }',
      recommended: true,
    },
    {
      description: 'an identity that cannot be translated',
      mockAcl: [
        '$identity = [pscustomobject]@{}',
        "$identity | Add-Member -MemberType ScriptMethod -Name Translate -Value { throw 'Unknown identity' }",
        "$rule = [pscustomobject]@{ IdentityReference = $identity; AccessControlType = 'Allow'; FileSystemRights = 0x00120088; IsInherited = $false; InheritanceFlags = 'None'; PropagationFlags = 'None' }",
        'function Get-Acl { [pscustomobject]@{ Access = @($rule) } }',
      ].join('\n'),
      recommended: false,
    },
    {
      description: 'a conflicting rule for an AppContainer identity',
      mockAcl: [
        "$identity = [System.Security.Principal.SecurityIdentifier]::new('S-1-15-2-1')",
        "$rule = [pscustomobject]@{ IdentityReference = $identity; AccessControlType = 'Allow'; FileSystemRights = 1; IsInherited = $false; InheritanceFlags = 'None'; PropagationFlags = 'None' }",
        'function Get-Acl { [pscustomobject]@{ Access = @($rule) } }',
      ].join('\n'),
      recommended: false,
    },
  ])(
    'checks native PowerShell error semantics for $description without changing ACLs',
    async fixture => {
      const appPath = makeTemporaryDirectory();
      makePlugin(appPath);
      const runtimeChecks = sandboxRuntimeChecks();
      runtimeChecks.systemDrivePreparationProbe.mockRejectedValue(
        new Error('Attributes unavailable'),
      );
      runtimeChecks.processContainerProbe.mockRejectedValue(new Error('Launch failed'));
      const service = new WindowsSandboxService({
        platform: 'win32',
        arch: 'x64',
        isPackaged: false,
        appPath,
        resourcesPath: makeTemporaryDirectory(),
        ...runtimeChecks,
        systemDrivePreparationNeededProbe: undefined,
        execFile: async (executable, args, options) => {
          const script = Buffer.from(args[3], 'base64').toString('utf16le');
          const encodedMock = Buffer.from(`${fixture.mockAcl}\n${script}`, 'utf16le').toString(
            'base64',
          );
          return execFileAsync(executable, [...args.slice(0, 3), encodedMock], {
            ...options,
            encoding: 'utf8',
          });
        },
      });

      await expect(service.getStatus()).resolves.toMatchObject({
        code: 'check_failed',
        ready: false,
        hostPreparationRecommended: fixture.recommended,
        error: expect.stringContaining('Launch failed'),
      });
      expect(runtimeChecks.authenticodeVerifier).not.toHaveBeenCalled();
    },
  );

  it('does not admit a failed launch after host preparation reports success', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runtimeChecks = sandboxRuntimeChecks();
    let prepared = false;
    runtimeChecks.systemDrivePreparationProbe.mockImplementation(async () => {
      if (!prepared) throw new Error('System-drive attributes are unavailable');
    });
    runtimeChecks.systemDrivePreparationNeededProbe.mockResolvedValue(true);
    runtimeChecks.processContainerProbe.mockRejectedValue(new Error('Independent launch failure'));
    const runFile = vi.fn(async () => {
      prepared = true;
      return { stdout: '', stderr: '' };
    });
    const service = new WindowsSandboxService({
      platform: 'win32',
      arch: 'x64',
      isPackaged: false,
      appPath,
      resourcesPath: makeTemporaryDirectory(),
      ...runtimeChecks,
      execFile: runFile,
    });

    await expect(service.initialize('C:\\workspace')).resolves.toMatchObject({
      success: false,
      status: { code: 'check_failed', ready: false, hostPreparationRecommended: false },
      error: expect.stringContaining('Independent launch failure'),
    });
    expect(runFile).toHaveBeenCalledOnce();
    expect(runtimeChecks.processContainerProbe).toHaveBeenCalledTimes(2);
  });

  it('revalidates the signed helper inside the elevated host preparation flow', async () => {
    const appPath = makeTemporaryDirectory();
    makePlugin(appPath);
    const runtimeChecks = sandboxRuntimeChecks();
    let prepared = false;
    runtimeChecks.systemDrivePreparationProbe.mockImplementation(async () => {
      if (!prepared) throw new Error('Access is denied');
    });
    runtimeChecks.systemDrivePreparationNeededProbe.mockResolvedValue(true);
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
    expect(runtimeChecks.nativeHostProbe).toHaveBeenCalledTimes(2);
    expect(runtimeChecks.processContainerProbe).toHaveBeenCalledTimes(2);
    expect(runFile).toHaveBeenCalledWith(
      expect.stringMatching(/powershell\.exe$/i),
      expect.arrayContaining(['-EncodedCommand']),
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });
});
