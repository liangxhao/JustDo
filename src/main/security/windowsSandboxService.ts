import { execFile } from 'child_process';
import crypto from 'crypto';
import { app, shell } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import mxcNativeBinaries from '../../shared/security/mxcNativeBinaries.json';
import {
  type WindowsSandboxOperationResult,
  type WindowsSandboxStatus,
  WindowsSandboxStatusCode,
} from '../../shared/security/windowsSandbox';
import { t } from '../core/i18n';

const execFileAsync = promisify(execFile);
const MXC_PLUGIN_DIRECTORY = 'mxc';
const MXC_SDK_DIRECTORY = path.join('node_modules', '@microsoft', 'mxc-sdk');
const MXC_EXECUTABLE = 'wxc-exec.exe';
const MXC_HOST_PREP_EXECUTABLE = 'wxc-host-prep.exe';
const MXC_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MXC_PROBE_TIMEOUT_MS = 20_000;
const MXC_PROBE_ERROR_MAX_LENGTH = 1_024;

type SupportedMxcArch = keyof typeof mxcNativeBinaries.sha256;
type MxcIsolationTier = 'base-container' | 'appcontainer-bfs' | 'appcontainer-dacl';
type VerifiedMxcBinaries = {
  sdkBinDirectory: string;
  executablePath: string;
  hostPrepPath: string;
  executableHash: string;
  hostPrepHash: string;
};

type ExecFileResult = { stdout: string; stderr: string };
type ExecFileRunner = (
  executable: string,
  args: readonly string[],
  options?: {
    encoding?: BufferEncoding;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    windowsHide?: boolean;
  },
) => Promise<ExecFileResult>;

type WindowsSandboxServiceEnvironment = {
  platform: NodeJS.Platform;
  arch: string;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  systemRoot: string;
  systemDrive: string;
  localAppData: string;
  execFile: ExecFileRunner;
  nativeBinaryVerifier: (pluginDirectory: string, arch: string) => VerifiedMxcBinaries;
  nativeHostProbe: (binaries: VerifiedMxcBinaries) => Promise<MxcIsolationTier>;
  processContainerProbe: (binaries: VerifiedMxcBinaries) => Promise<void>;
  systemDrivePreparationProbe: (binaries: VerifiedMxcBinaries) => Promise<void>;
  systemDrivePreparationNeededProbe: () => Promise<boolean>;
  authenticodeVerifier: (filePath: string) => Promise<void>;
};

const isDirectory = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (candidate: string): boolean => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
};

const resolveRuntimeRoots = (environment: WindowsSandboxServiceEnvironment): string[] =>
  environment.isPackaged
    ? [path.join(environment.resourcesPath, 'cfmind')]
    : [
        path.join(environment.appPath, 'vendor', 'openclaw-runtime', 'current'),
        path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current'),
      ];

export const resolveWindowsSandboxPluginDirectory = (
  environment: WindowsSandboxServiceEnvironment,
): string | null => {
  for (const runtimeRoot of resolveRuntimeRoots(environment)) {
    const pluginDirectory = path.join(runtimeRoot, 'dist', 'extensions', MXC_PLUGIN_DIRECTORY);
    if (
      isDirectory(pluginDirectory) &&
      isFile(path.join(pluginDirectory, 'openclaw.plugin.json')) &&
      isFile(path.join(pluginDirectory, 'package.json'))
    ) {
      return pluginDirectory;
    }
  }
  return null;
};

export const resolveMxcSdkBinDirectory = (pluginDirectory: string, arch: string): string | null => {
  const sdkDirectory = path.join(pluginDirectory, MXC_SDK_DIRECTORY, 'bin');
  const candidates = [path.join(sdkDirectory, arch), sdkDirectory];
  return (
    candidates.find(
      candidate =>
        isFile(path.join(candidate, MXC_EXECUTABLE)) &&
        isFile(path.join(candidate, MXC_HOST_PREP_EXECUTABLE)),
    ) ?? null
  );
};

const buildEncodedPowerShellCommand = (source: string): string =>
  Buffer.from(
    [
      "$ErrorActionPreference = 'Stop'",
      'Set-StrictMode -Version 3.0',
      "$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')",
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
      source,
    ].join('\n'),
    'utf16le',
  ).toString('base64');

const AUTHENTICODE_POWERSHELL = buildEncodedPowerShellCommand(
  [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:JUSTDO_MXC_VERIFY_PATH',
    "if ($signature.Status.ToString() -ne 'Valid') { throw 'MXC binary Authenticode signature is not valid.' }",
    "if ($signature.SignerCertificate.Thumbprint -ne $env:JUSTDO_MXC_SIGNER_THUMBPRINT) { throw 'MXC binary signer certificate does not match.' }",
  ].join('; '),
);

const HOST_PREP_FAILURE = {
  HashRead: 1001,
  HashMismatch: 1002,
  SignatureRead: 1003,
  SignatureInvalid: 1004,
  SignerMismatch: 1005,
  HelperLaunch: 1006,
} as const;

const buildElevatedHostPrepPowerShell = (
  binaries: VerifiedMxcBinaries,
  systemDrive: string,
): string => {
  if (!/^[a-z]:$/i.test(systemDrive)) throw new Error(t('windowsSandboxSystemDriveInvalid'));
  // UAC can rebuild the elevated environment. Carry only verified, non-secret data in argv.
  const request = Buffer.from(
    JSON.stringify({
      helper: binaries.hostPrepPath,
      hash: binaries.hostPrepHash,
      signer: mxcNativeBinaries.signerThumbprint,
      target: `${systemDrive}\\`,
    }),
    'utf8',
  ).toString('base64');
  return buildEncodedPowerShellCommand(
    [
      `$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}')) | ConvertFrom-Json`,
      'try { $actualHash = (Get-FileHash -LiteralPath $request.helper -Algorithm SHA256 -ErrorAction Stop).Hash }',
      `catch { exit ${HOST_PREP_FAILURE.HashRead} }`,
      `if ($actualHash -ne $request.hash) { exit ${HOST_PREP_FAILURE.HashMismatch} }`,
      'try { $signature = Get-AuthenticodeSignature -LiteralPath $request.helper -ErrorAction Stop }',
      `catch { exit ${HOST_PREP_FAILURE.SignatureRead} }`,
      `if ($signature.Status.ToString() -ne 'Valid') { exit ${HOST_PREP_FAILURE.SignatureInvalid} }`,
      `if ($signature.SignerCertificate.Thumbprint -ne $request.signer) { exit ${HOST_PREP_FAILURE.SignerMismatch} }`,
      'try {',
      '$global:LASTEXITCODE = $null',
      "& $request.helper 'prepare-system-drive' '--target' $request.target",
      `if ($null -eq $LASTEXITCODE) { exit ${HOST_PREP_FAILURE.HelperLaunch} }`,
      'exit $LASTEXITCODE',
      `} catch { exit ${HOST_PREP_FAILURE.HelperLaunch} }`,
    ].join('\n'),
  );
};

const HOST_PREP_POWERSHELL = buildEncodedPowerShellCommand(
  [
    'try {',
    "$arguments = @('-NoProfile', '-NonInteractive', '-EncodedCommand', $env:JUSTDO_MXC_ELEVATED_SCRIPT)",
    '$process = Start-Process -FilePath $env:JUSTDO_MXC_POWERSHELL_EXE -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop',
    'if ($null -eq $process -or $null -eq $process.ExitCode) {',
    '@{ exitCode = $null } | ConvertTo-Json -Compress',
    '} else { @{ exitCode = $process.ExitCode } | ConvertTo-Json -Compress }',
    '} catch {',
    '$exception = $_.Exception',
    'while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }',
    'if ($exception -is [ComponentModel.Win32Exception] -and $exception.NativeErrorCode -eq 1223) {',
    '@{ uacCancelled = $true } | ConvertTo-Json -Compress',
    '} else { @{ error = $exception.Message } | ConvertTo-Json -Compress }',
    '}',
  ].join('\n'),
);

const verifyHostPrepResult = (stdout: string): void => {
  let result: { exitCode?: unknown; error?: unknown; uacCancelled?: unknown } | null;
  try {
    result = JSON.parse(stdout) as typeof result;
  } catch {
    throw new Error(t('windowsSandboxPrepResultInvalid'));
  }
  if (result?.uacCancelled === true) {
    throw new Error(t('windowsSandboxPrepUacCancelled'));
  }
  if (typeof result?.error === 'string' && result.error.trim()) {
    throw new Error(result.error.trim().slice(0, MXC_PROBE_ERROR_MAX_LENGTH));
  }
  if (typeof result?.exitCode !== 'number' || !Number.isInteger(result.exitCode)) {
    throw new Error(t('windowsSandboxPrepExitCodeMissing'));
  }
  const failures: Record<number, string> = {
    [HOST_PREP_FAILURE.HashRead]: 'windowsSandboxPrepHashReadFailed',
    [HOST_PREP_FAILURE.HashMismatch]: 'windowsSandboxPrepHashMismatch',
    [HOST_PREP_FAILURE.SignatureRead]: 'windowsSandboxPrepSignatureReadFailed',
    [HOST_PREP_FAILURE.SignatureInvalid]: 'windowsSandboxPrepSignatureInvalid',
    [HOST_PREP_FAILURE.SignerMismatch]: 'windowsSandboxPrepSignerMismatch',
    [HOST_PREP_FAILURE.HelperLaunch]: 'windowsSandboxPrepHelperLaunchFailed',
  };
  if (result.exitCode !== 0) {
    throw new Error(
      failures[result.exitCode]
        ? t(failures[result.exitCode])
        : t('windowsSandboxPrepHelperFailed', { code: result.exitCode }),
    );
  }
};

const SYSTEM_DRIVE_PREPARATION_NEEDED_POWERSHELL = buildEncodedPowerShellCommand(
  [
    '$acl = Get-Acl -LiteralPath $env:JUSTDO_MXC_SYSTEM_DRIVE_ROOT -ErrorAction Stop',
    "$targetSids = @('S-1-15-2-1', 'S-1-15-2-2')",
    '$metadataMask = 0x00120088',
    '$presentSids = @()',
    'foreach ($rule in $acl.Access) {',
    "if ($rule.AccessControlType.ToString() -eq 'Deny' -and (([int64]$rule.FileSystemRights -band $metadataMask) -ne 0)) { 'false'; exit 0 }",
    '$sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value',
    'if ($targetSids -contains $sid) {',
    "if ($rule.IsInherited -or $rule.AccessControlType.ToString() -ne 'Allow' -or [int64]$rule.FileSystemRights -ne $metadataMask -or $rule.InheritanceFlags.ToString() -ne 'None' -or $rule.PropagationFlags.ToString() -ne 'None') { 'false'; exit 0 }",
    '$presentSids += $sid',
    '}',
    '}',
    '@($targetSids | Where-Object { $presentSids -notcontains $_ }).Count -gt 0 | ConvertTo-Json -Compress',
  ].join('\n'),
);

const sha256File = (filePath: string): string =>
  crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();

const resolveSupportedMxcArch = (arch: string): SupportedMxcArch => {
  if (arch === 'x64' || arch === 'arm64') return arch;
  throw new Error(`Unsupported MXC architecture: ${arch}.`);
};

export const verifyMxcNativeBinaryIntegrity = (
  pluginDirectory: string,
  arch: string,
  manifest: typeof mxcNativeBinaries = mxcNativeBinaries,
): VerifiedMxcBinaries => {
  const supportedArch = resolveSupportedMxcArch(arch);
  const pluginPackage = JSON.parse(
    fs.readFileSync(path.join(pluginDirectory, 'package.json'), 'utf8'),
  ) as { version?: string };
  if (pluginPackage.version !== manifest.pluginVersion) {
    throw new Error(
      `MXC plugin version mismatch: expected ${manifest.pluginVersion}, found ${String(pluginPackage.version)}.`,
    );
  }
  const sdkDirectory = path.join(pluginDirectory, MXC_SDK_DIRECTORY);
  const sdkPackage = JSON.parse(
    fs.readFileSync(path.join(sdkDirectory, 'package.json'), 'utf8'),
  ) as {
    version?: string;
  };
  if (sdkPackage.version !== manifest.sdkVersion) {
    throw new Error(
      `MXC SDK version mismatch: expected ${manifest.sdkVersion}, found ${String(sdkPackage.version)}.`,
    );
  }
  const sdkBinDirectory = resolveMxcSdkBinDirectory(pluginDirectory, supportedArch);
  if (!sdkBinDirectory) throw new Error(`MXC SDK binaries are missing for ${supportedArch}.`);
  const executablePath = path.join(sdkBinDirectory, MXC_EXECUTABLE);
  const hostPrepPath = path.join(sdkBinDirectory, MXC_HOST_PREP_EXECUTABLE);
  const executableHash = sha256File(executablePath);
  const hostPrepHash = sha256File(hostPrepPath);
  const expected = manifest.sha256[supportedArch];
  if (executableHash !== expected[MXC_EXECUTABLE]) {
    throw new Error(`MXC executor integrity check failed for ${supportedArch}.`);
  }
  if (hostPrepHash !== expected[MXC_HOST_PREP_EXECUTABLE]) {
    throw new Error(`MXC host preparation integrity check failed for ${supportedArch}.`);
  }
  return { sdkBinDirectory, executablePath, hostPrepPath, executableHash, hostPrepHash };
};

const probeMxcProcessContainer = async (
  binaries: VerifiedMxcBinaries,
  environment: Pick<
    WindowsSandboxServiceEnvironment,
    'execFile' | 'systemDrive' | 'systemRoot' | 'localAppData'
  >,
  command: 'launch' | 'stat-system-drive' = 'launch',
): Promise<void> => {
  const cmdPath = path.win32.join(environment.systemRoot, 'System32', 'cmd.exe');
  if (!isFile(cmdPath)) throw new Error(`Windows command processor is missing: ${cmdPath}`);
  const commandLine =
    command === 'stat-system-drive'
      ? `"${cmdPath}" /d /e:on /c for %I in ("${environment.systemDrive}\\") do @if "%~aI"=="" (exit /b 1) else (exit /b 0)`
      : `"${cmdPath}" /d /c exit 0`;
  const probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-mxc-probe-'));
  const config = {
    version: '0.7.0-alpha',
    containerId: `justdo-mxc-probe-${crypto.randomUUID().replaceAll('-', '')}`,
    containment: 'processcontainer',
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    process: {
      commandLine,
      cwd: probeDirectory,
      env: [
        `SystemRoot=${environment.systemRoot}`,
        `WINDIR=${environment.systemRoot}`,
        `SystemDrive=${environment.systemDrive}`,
        `ComSpec=${cmdPath}`,
        `LOCALAPPDATA=${environment.localAppData}`,
        `TEMP=${probeDirectory}`,
        `TMP=${probeDirectory}`,
      ],
      timeout: 10_000,
    },
    filesystem: {
      readonlyPaths: [path.win32.dirname(cmdPath)],
      readwritePaths: [probeDirectory],
      deniedPaths: [] as string[],
    },
    ui: { disable: true, clipboard: 'none', injection: false },
    network: { defaultPolicy: 'block', enforcementMode: 'capabilities' },
    processContainer: {
      leastPrivilege: true,
      capabilities: [] as string[],
      ui: {
        isolation: 'container',
        desktopSystemControl: false,
        systemSettings: 'none',
        ime: false,
      },
    },
  };
  try {
    await environment.execFile(
      binaries.executablePath,
      ['--config-base64', Buffer.from(JSON.stringify(config), 'utf8').toString('base64')],
      { encoding: 'utf8', timeout: MXC_PROBE_TIMEOUT_MS, windowsHide: true },
    );
  } finally {
    await fs.promises.rm(probeDirectory, { recursive: true, force: true });
  }
};

const probeMxcHost = async (
  binaries: VerifiedMxcBinaries,
  execRunner: ExecFileRunner,
): Promise<MxcIsolationTier> => {
  const { stdout } = await execRunner(binaries.executablePath, ['--probe'], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  const probe = JSON.parse(stdout) as { tier?: unknown } | null;
  if (
    probe?.tier !== 'base-container' &&
    probe?.tier !== 'appcontainer-bfs' &&
    probe?.tier !== 'appcontainer-dacl'
  ) {
    throw new Error('MXC host probe did not select a supported ProcessContainer isolation tier.');
  }
  return probe.tier;
};

const describeMxcProbeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error
      ? String(error.stderr ?? '')
      : '';
  const nativeError = /^\s*error:\s*(.+)$/im.exec(stderr || message)?.[1];
  const detail =
    nativeError ??
    (stderr || message)
      .replace(/^Command failed:[^\r\n]*(?:\r?\n)?/i, '')
      .split(/SECTION:/)[0]
      .trim();
  return (
    detail.split(/\{\s*"error"\s*:/)[0].trim() || 'MXC executor exited unsuccessfully.'
  ).slice(0, MXC_PROBE_ERROR_MAX_LENGTH);
};

export class WindowsSandboxService {
  private readonly environment: WindowsSandboxServiceEnvironment;
  private successfulProbe: { executableHash: string; tier: MxcIsolationTier } | null = null;

  constructor(environment?: Partial<WindowsSandboxServiceEnvironment>) {
    const systemRoot =
      environment?.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const systemDrive = environment?.systemDrive ?? process.env.SystemDrive ?? 'C:';
    const localAppData =
      environment?.localAppData ??
      process.env.LOCALAPPDATA ??
      path.win32.join(os.homedir(), 'AppData', 'Local');
    const execRunner: ExecFileRunner =
      environment?.execFile ??
      (async (executable, args, options) => {
        const result = await execFileAsync(executable, [...args], {
          encoding: options?.encoding ?? 'utf8',
          env: options?.env,
          timeout: options?.timeout,
          windowsHide: options?.windowsHide,
        });
        return { stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
      });
    this.environment = {
      platform: environment?.platform ?? process.platform,
      arch: environment?.arch ?? process.arch,
      isPackaged: environment?.isPackaged ?? app.isPackaged,
      resourcesPath: environment?.resourcesPath ?? process.resourcesPath,
      appPath: environment?.appPath ?? app.getAppPath(),
      systemRoot,
      systemDrive,
      localAppData,
      execFile: execRunner,
      nativeBinaryVerifier: environment?.nativeBinaryVerifier ?? verifyMxcNativeBinaryIntegrity,
      nativeHostProbe:
        environment?.nativeHostProbe ?? (binaries => probeMxcHost(binaries, execRunner)),
      processContainerProbe:
        environment?.processContainerProbe ??
        (binaries =>
          probeMxcProcessContainer(binaries, {
            execFile: execRunner,
            systemDrive,
            systemRoot,
            localAppData,
          })),
      systemDrivePreparationProbe:
        environment?.systemDrivePreparationProbe ??
        (binaries =>
          probeMxcProcessContainer(
            binaries,
            { execFile: execRunner, systemDrive, systemRoot, localAppData },
            'stat-system-drive',
          )),
      systemDrivePreparationNeededProbe:
        environment?.systemDrivePreparationNeededProbe ??
        (async () => {
          const { stdout } = await execRunner(
            path.win32.join(systemRoot, 'System32', 'WindowsPowerShell\\v1.0\\powershell.exe'),
            [
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              SYSTEM_DRIVE_PREPARATION_NEEDED_POWERSHELL,
            ],
            {
              encoding: 'utf8',
              env: { ...process.env, JUSTDO_MXC_SYSTEM_DRIVE_ROOT: `${systemDrive}\\` },
              timeout: 10_000,
              windowsHide: true,
            },
          );
          return JSON.parse(stdout) === true;
        }),
      authenticodeVerifier:
        environment?.authenticodeVerifier ??
        (async filePath => {
          await execRunner(
            path.win32.join(systemRoot, 'System32', 'WindowsPowerShell\\v1.0\\powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', AUTHENTICODE_POWERSHELL],
            {
              encoding: 'utf8',
              env: {
                ...process.env,
                JUSTDO_MXC_VERIFY_PATH: filePath,
                JUSTDO_MXC_SIGNER_THUMBPRINT: mxcNativeBinaries.signerThumbprint,
              },
              timeout: 10_000,
              windowsHide: true,
            },
          );
        }),
    };
  }

  getPluginDirectory(): string | null {
    return resolveWindowsSandboxPluginDirectory(this.environment);
  }

  getSdkBinDirectory(): string | null {
    const pluginDirectory = this.getPluginDirectory();
    return pluginDirectory
      ? resolveMxcSdkBinDirectory(pluginDirectory, this.environment.arch)
      : null;
  }

  isHelperAvailable(): boolean {
    return this.getSdkBinDirectory() !== null;
  }

  getGatewayEnvironment(): Record<string, string> {
    return {};
  }

  private resolveSystemExecutable(fileName: string): string {
    return path.win32.join(this.environment.systemRoot, 'System32', fileName);
  }

  private async isSystemDrivePrepared(binaries: VerifiedMxcBinaries): Promise<boolean> {
    try {
      await this.environment.systemDrivePreparationProbe(binaries);
      return true;
    } catch {
      return false;
    }
  }

  private async isSystemDrivePreparationNeeded(): Promise<boolean> {
    try {
      return await this.environment.systemDrivePreparationNeededProbe();
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<WindowsSandboxStatus> {
    if (this.environment.platform !== 'win32') {
      return {
        code: WindowsSandboxStatusCode.UnsupportedPlatform,
        supported: false,
        helperAvailable: false,
        initialized: false,
        ready: false,
      };
    }

    const pluginDirectory = this.getPluginDirectory();
    const sdkBinDirectory = this.getSdkBinDirectory();
    if (!pluginDirectory || !sdkBinDirectory) {
      return {
        code: WindowsSandboxStatusCode.PluginMissing,
        supported: true,
        helperAvailable: false,
        initialized: false,
        ready: false,
        diagnosticsPath: pluginDirectory ?? undefined,
      };
    }

    let verifiedBinaries: VerifiedMxcBinaries;
    try {
      verifiedBinaries = this.environment.nativeBinaryVerifier(
        pluginDirectory,
        this.environment.arch,
      );
    } catch (error) {
      return {
        code: WindowsSandboxStatusCode.CheckFailed,
        supported: true,
        helperAvailable: true,
        initialized: false,
        ready: false,
        diagnosticsPath: pluginDirectory,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    let hostPreparationRecommended = false;
    try {
      const cachedProbe =
        this.successfulProbe?.executableHash === verifiedBinaries.executableHash
          ? this.successfulProbe
          : null;
      const tier = cachedProbe?.tier ?? (await this.environment.nativeHostProbe(verifiedBinaries));
      hostPreparationRecommended =
        tier === 'appcontainer-dacl' &&
        !(await this.isSystemDrivePrepared(verifiedBinaries)) &&
        (await this.isSystemDrivePreparationNeeded());
      if (!cachedProbe) {
        await this.environment.processContainerProbe(verifiedBinaries);
        this.successfulProbe = { executableHash: verifiedBinaries.executableHash, tier };
      }
    } catch (error) {
      this.successfulProbe = null;
      return {
        code: WindowsSandboxStatusCode.CheckFailed,
        supported: true,
        helperAvailable: true,
        initialized: false,
        ready: false,
        hostPreparationRecommended,
        diagnosticsPath: pluginDirectory,
        error: `MXC ProcessContainer self-check failed: ${describeMxcProbeError(error)}`,
      };
    }

    const prepared = !hostPreparationRecommended;
    return {
      code: prepared
        ? WindowsSandboxStatusCode.Ready
        : WindowsSandboxStatusCode.HostPreparationRecommended,
      supported: true,
      helperAvailable: true,
      initialized: prepared,
      ready: true,
      hostPreparationRecommended: !prepared,
      diagnosticsPath: pluginDirectory,
    };
  }

  async initialize(_workspaceDirectory: string): Promise<WindowsSandboxOperationResult> {
    const before = await this.getStatus();
    if (
      !before.supported ||
      !before.helperAvailable ||
      (!before.ready && !before.hostPreparationRecommended)
    ) {
      return {
        success: false,
        status: before,
        error: before.error || 'The MXC Windows sandbox backend is unavailable.',
      };
    }
    if (!before.hostPreparationRecommended) {
      return { success: true, status: before };
    }

    const pluginDirectory = this.getPluginDirectory();
    if (!pluginDirectory) {
      return {
        success: false,
        status: before,
        error: 'The MXC host preparation utility is unavailable.',
      };
    }

    try {
      const binaries = this.environment.nativeBinaryVerifier(
        pluginDirectory,
        this.environment.arch,
      );
      await this.environment.authenticodeVerifier(binaries.hostPrepPath);
      const powershellPath = this.resolveSystemExecutable(
        'WindowsPowerShell\\v1.0\\powershell.exe',
      );
      const { stdout } = await this.environment.execFile(
        powershellPath,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', HOST_PREP_POWERSHELL],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            JUSTDO_MXC_ELEVATED_SCRIPT: buildElevatedHostPrepPowerShell(
              binaries,
              this.environment.systemDrive,
            ),
            JUSTDO_MXC_POWERSHELL_EXE: powershellPath,
          },
          timeout: MXC_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      verifyHostPrepResult(stdout);
      this.successfulProbe = null;
      const status = await this.getStatus();
      return status.ready && !status.hostPreparationRecommended
        ? { success: true, status }
        : {
            success: false,
            status,
            error: status.error || t('windowsSandboxPrepMetadataUnavailable'),
          };
    } catch (error) {
      this.successfulProbe = null;
      const status = await this.getStatus();
      return {
        success: false,
        status,
        error: t('windowsSandboxPrepFailed', { detail: describeMxcProbeError(error) }),
      };
    }
  }

  repair(workspaceDirectory: string): Promise<WindowsSandboxOperationResult> {
    return this.initialize(workspaceDirectory);
  }

  async openDiagnostics(): Promise<{ success: boolean; error?: string }> {
    const pluginDirectory = this.getPluginDirectory();
    if (!pluginDirectory) {
      return { success: false, error: 'The MXC plugin directory is unavailable.' };
    }
    try {
      const error = await shell.openPath(pluginDirectory);
      return error ? { success: false, error } : { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
