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

const execFileAsync = promisify(execFile);
const MXC_PLUGIN_DIRECTORY = 'mxc';
const MXC_SDK_DIRECTORY = path.join('node_modules', '@microsoft', 'mxc-sdk');
const MXC_EXECUTABLE = 'wxc-exec.exe';
const MXC_HOST_PREP_EXECUTABLE = 'wxc-host-prep.exe';
const MXC_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MXC_PROBE_TIMEOUT_MS = 20_000;

type SupportedMxcArch = keyof typeof mxcNativeBinaries.sha256;
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
  execFile: ExecFileRunner;
  nativeBinaryVerifier: (pluginDirectory: string, arch: string) => VerifiedMxcBinaries;
  processContainerProbe: (binaries: VerifiedMxcBinaries) => Promise<void>;
  systemDrivePreparationProbe: (binaries: VerifiedMxcBinaries) => Promise<void>;
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
  Buffer.from(source, 'utf16le').toString('base64');

const AUTHENTICODE_POWERSHELL = buildEncodedPowerShellCommand(
  [
    '$signature = Get-AuthenticodeSignature -LiteralPath $env:JUSTDO_MXC_VERIFY_PATH',
    "if ($signature.Status.ToString() -ne 'Valid') { throw 'MXC binary Authenticode signature is not valid.' }",
    "if ($signature.SignerCertificate.Thumbprint -ne $env:JUSTDO_MXC_SIGNER_THUMBPRINT) { throw 'MXC binary signer certificate does not match.' }",
  ].join('; '),
);

const ELEVATED_HOST_PREP_POWERSHELL = buildEncodedPowerShellCommand(
  [
    '$helper = $env:JUSTDO_MXC_HOST_PREP_EXE',
    '$actualHash = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash',
    "if ($actualHash -ne $env:JUSTDO_MXC_HOST_PREP_SHA256) { throw 'MXC host preparation binary hash does not match.' }",
    '$signature = Get-AuthenticodeSignature -LiteralPath $helper',
    "if ($signature.Status.ToString() -ne 'Valid') { throw 'MXC host preparation signature is not valid.' }",
    "if ($signature.SignerCertificate.Thumbprint -ne $env:JUSTDO_MXC_SIGNER_THUMBPRINT) { throw 'MXC host preparation signer certificate does not match.' }",
    "& $helper 'prepare-system-drive'",
    'exit $LASTEXITCODE',
  ].join('; '),
);

const HOST_PREP_POWERSHELL = buildEncodedPowerShellCommand(
  [
    "$arguments = @('-NoProfile', '-NonInteractive', '-EncodedCommand', $env:JUSTDO_MXC_ELEVATED_SCRIPT)",
    '$process = Start-Process -FilePath $env:JUSTDO_MXC_POWERSHELL_EXE -ArgumentList $arguments -Verb RunAs -Wait -PassThru',
    'exit $process.ExitCode',
  ].join('; '),
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
  environment: Pick<WindowsSandboxServiceEnvironment, 'execFile' | 'systemDrive' | 'systemRoot'>,
  command: 'launch' | 'list-system-drive' = 'launch',
): Promise<void> => {
  const cmdPath = path.win32.join(environment.systemRoot, 'System32', 'cmd.exe');
  if (!isFile(cmdPath)) throw new Error(`Windows command processor is missing: ${cmdPath}`);
  const commandLine =
    command === 'list-system-drive'
      ? `${cmdPath} /d /c dir ${environment.systemDrive}\\ >nul`
      : `${cmdPath} /d /c exit 0`;
  const config = {
    version: '0.7.0-alpha',
    containerId: `justdo-mxc-probe-${crypto.randomUUID().replaceAll('-', '')}`,
    containment: 'processcontainer',
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    process: {
      commandLine,
      timeout: 10_000,
    },
    filesystem: {
      readonlyPaths: [`${environment.systemDrive}\\`],
      readwritePaths: [os.tmpdir()],
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
  await environment.execFile(
    binaries.executablePath,
    ['--config-base64', Buffer.from(JSON.stringify(config), 'utf8').toString('base64')],
    { encoding: 'utf8', timeout: MXC_PROBE_TIMEOUT_MS, windowsHide: true },
  );
};

export class WindowsSandboxService {
  private readonly environment: WindowsSandboxServiceEnvironment;
  private successfulProbeHash: string | null = null;

  constructor(environment?: Partial<WindowsSandboxServiceEnvironment>) {
    const systemRoot =
      environment?.systemRoot ?? process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
    const systemDrive = environment?.systemDrive ?? process.env.SystemDrive ?? 'C:';
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
      execFile: execRunner,
      nativeBinaryVerifier: environment?.nativeBinaryVerifier ?? verifyMxcNativeBinaryIntegrity,
      processContainerProbe:
        environment?.processContainerProbe ??
        (binaries =>
          probeMxcProcessContainer(binaries, { execFile: execRunner, systemDrive, systemRoot })),
      systemDrivePreparationProbe:
        environment?.systemDrivePreparationProbe ??
        (binaries =>
          probeMxcProcessContainer(
            binaries,
            { execFile: execRunner, systemDrive, systemRoot },
            'list-system-drive',
          )),
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

  private async hasIsoEnvBroker(): Promise<boolean> {
    try {
      await this.environment.execFile(
        this.resolveSystemExecutable('sc.exe'),
        ['query', 'IsoEnvBroker'],
        { encoding: 'utf8', timeout: 5_000, windowsHide: true },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async isSystemDrivePrepared(binaries: VerifiedMxcBinaries): Promise<boolean> {
    try {
      await this.environment.systemDrivePreparationProbe(binaries);
      return true;
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

    if (!(await this.hasIsoEnvBroker())) {
      return {
        code: WindowsSandboxStatusCode.BrokerUnavailable,
        supported: true,
        helperAvailable: true,
        initialized: false,
        ready: false,
        diagnosticsPath: pluginDirectory,
        error: 'Windows IsoEnvBroker is not installed; MXC ProcessContainer is unavailable.',
      };
    }

    try {
      if (this.successfulProbeHash !== verifiedBinaries.executableHash) {
        await this.environment.processContainerProbe(verifiedBinaries);
        this.successfulProbeHash = verifiedBinaries.executableHash;
      }
    } catch (error) {
      this.successfulProbeHash = null;
      return {
        code: WindowsSandboxStatusCode.CheckFailed,
        supported: true,
        helperAvailable: true,
        initialized: false,
        ready: false,
        diagnosticsPath: pluginDirectory,
        error: `MXC ProcessContainer self-check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const prepared = await this.isSystemDrivePrepared(verifiedBinaries);
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
    if (!before.supported || !before.helperAvailable || !before.ready) {
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
      await this.environment.execFile(
        powershellPath,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', HOST_PREP_POWERSHELL],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            JUSTDO_MXC_ELEVATED_SCRIPT: ELEVATED_HOST_PREP_POWERSHELL,
            JUSTDO_MXC_HOST_PREP_EXE: binaries.hostPrepPath,
            JUSTDO_MXC_HOST_PREP_SHA256: binaries.hostPrepHash,
            JUSTDO_MXC_POWERSHELL_EXE: powershellPath,
            JUSTDO_MXC_SIGNER_THUMBPRINT: mxcNativeBinaries.signerThumbprint,
          },
          timeout: MXC_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      const status = await this.getStatus();
      return status.ready && !status.hostPreparationRecommended
        ? { success: true, status }
        : {
            success: false,
            status,
            error: status.error || 'MXC host preparation did not complete.',
          };
    } catch (error) {
      const status = await this.getStatus();
      return {
        success: false,
        status,
        error: error instanceof Error ? error.message : String(error),
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
