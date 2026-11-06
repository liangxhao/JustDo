import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_CLI_BRIDGE_DIRECTORY,
  AGENT_CLI_BRIDGE_SWITCH,
  AGENT_CLI_PROFILE_SWITCH,
  getAgentCliCommandName,
} from '../../../shared/integrations/agentCli';
import { PRODUCT_NAME } from '../../../shared/productMetadata';

export const AGENT_CLI_COMMAND_NAME = getAgentCliCommandName(PRODUCT_NAME);
export const AGENT_CLI_LAUNCHER_MARKER = 'external-agent-managed-launcher-v1';

export interface AgentCliLauncher {
  command: string;
  path: string;
}

export interface AgentCliLauncherOptions {
  targetPath: string;
  targetArgs?: readonly string[];
  platform?: NodeJS.Platform;
  pathValue?: string;
  homeDirectory?: string;
  profileDirectory?: string;
}

/** Bind discovery to the owning desktop profile without forwarding bootstrap environment. */
export function buildAgentCliBridgeArguments(
  userDataPath: string,
  applicationPath?: string,
): string[] {
  if (!userDataPath.trim() || userDataPath.includes('\0') || !path.isAbsolute(userDataPath)) {
    throw new Error('The agent CLI profile directory must be absolute.');
  }
  return [
    ...(applicationPath ? [applicationPath] : []),
    AGENT_CLI_PROFILE_SWITCH,
    path.resolve(userDataPath),
    AGENT_CLI_BRIDGE_SWITCH,
  ];
}

interface ManagedLauncherOptions extends AgentCliLauncherOptions {
  ownershipMarker: string;
  preserveOwnedMarkers?: readonly string[];
}

/** AppImage mounts are temporary; the wrapper must point at the installed image. */
export function resolvePackagedAgentCliTargetPath(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
  appImagePath: string | undefined = process.env.APPIMAGE,
): string {
  const stableAppImage = platform === 'linux' ? appImagePath?.trim() : undefined;
  return path.resolve(stableAppImage || execPath);
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const launcherContent = (options: ManagedLauncherOptions): string =>
  [
    '#!/bin/sh',
    `# ${options.ownershipMarker}`,
    'unset ELECTRON_RUN_AS_NODE NODE_ENV NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH OPENCLAW_STATE_DIR OPENCLAW_HOME OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN OPENCLAW_GATEWAY_PASSWORD OPENCLAW_GATEWAY_PORT',
    "for _agent_cli_env_name in $(env | sed -n 's/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p'); do",
    '  case "$_agent_cli_env_name" in JUSTDO_*|ELECTRON_*|OPENCLAW_BUNDLED_*) unset "$_agent_cli_env_name" ;; esac',
    'done',
    `exec ${[options.targetPath, ...(options.targetArgs ?? [])].map(shellQuote).join(' ')} "$@"`,
    '',
  ].join('\n');

const isWithinDirectory = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
};

/** The explicit command advertised by settings belongs to one application profile. */
export function resolveAgentCliProfileLauncherPath(profile: string): string {
  if (!profile?.trim() || profile.includes('\0') || !path.isAbsolute(profile)) {
    throw new Error('The agent CLI profile directory must be absolute.');
  }
  return path.join(
    path.resolve(profile),
    AGENT_CLI_BRIDGE_DIRECTORY,
    'bin',
    AGENT_CLI_COMMAND_NAME,
  );
}

const writeManagedLauncher = (launcherPath: string, options: ManagedLauncherOptions): boolean => {
  const content = launcherContent(options);
  const existing = fs.lstatSync(launcherPath, { throwIfNoEntry: false });
  if (existing) {
    // Never follow a launcher symlink or replace an unrelated user command.
    if (existing.isSymbolicLink() || !existing.isFile()) return false;
    const current = fs.readFileSync(launcherPath, 'utf8');
    if (options.preserveOwnedMarkers?.some(marker => current.includes(marker))) return true;
    const owned = current.includes(options.ownershipMarker);
    if (current !== content && !owned) return false;
  }
  const temporaryPath = `${launcherPath}.${process.pid}.tmp`;
  fs.rmSync(temporaryPath, { force: true });
  fs.writeFileSync(temporaryPath, content, { mode: 0o700, flag: 'wx' });
  fs.rmSync(launcherPath, { force: true });
  fs.renameSync(temporaryPath, launcherPath);
  fs.chmodSync(launcherPath, 0o700);
  return true;
};

/** Shared transport launcher mechanics; callers supply their ownership policy. */
export function ensureManagedAgentCommandLauncher(
  options: ManagedLauncherOptions,
): AgentCliLauncher {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const target = path.resolve(options.targetPath);
    if (path.extname(target).toLocaleLowerCase('en-US') !== '.exe') {
      throw new Error('The agent CLI requires a native executable on Windows.');
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      throw new Error('The agent CLI launcher was not found.');
    }
    return { command: target.replaceAll('\\', '/'), path: target };
  }

  const home = options.homeDirectory ?? os.homedir();
  const realHome = fs.realpathSync(home);
  const preferredDirectory = path.join(home, '.local', 'bin');
  const pathDirectories = (options.pathValue ?? process.env.PATH ?? '')
    .split(path.delimiter)
    .map(value => value.trim())
    .filter(Boolean);
  const candidates = [preferredDirectory, ...pathDirectories].filter(
    (value, index, all) => all.indexOf(value) === index && isWithinDirectory(home, value),
  );
  for (const directory of candidates) {
    try {
      fs.mkdirSync(directory, { recursive: directory === preferredDirectory });
      if (!isWithinDirectory(realHome, fs.realpathSync(directory))) continue;
      fs.accessSync(directory, fs.constants.W_OK);
      const launcherPath = path.join(directory, AGENT_CLI_COMMAND_NAME);
      if (!writeManagedLauncher(launcherPath, options)) continue;
      return { command: launcherPath, path: launcherPath };
    } catch {
      // Try the next user-owned PATH entry.
    }
  }
  throw new Error('No writable user-owned PATH directory is available for the agent CLI launcher.');
}

export function ensureAgentCliCommandLauncher(options: AgentCliLauncherOptions): AgentCliLauncher {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32')
    return ensureManagedAgentCommandLauncher({
      ...options,
      ownershipMarker: AGENT_CLI_LAUNCHER_MARKER,
    });
  const profile = options.profileDirectory ?? '';
  const launcherPath = resolveAgentCliProfileLauncherPath(profile);
  const directory = path.dirname(launcherPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!isWithinDirectory(fs.realpathSync(profile), fs.realpathSync(directory))) {
    throw new Error('The agent CLI launcher must remain inside its application profile.');
  }
  if (
    !writeManagedLauncher(launcherPath, {
      ...options,
      targetArgs: options.targetArgs ?? buildAgentCliBridgeArguments(profile),
      ownershipMarker: AGENT_CLI_LAUNCHER_MARKER,
    })
  ) {
    throw new Error('The profile agent CLI launcher is owned by another command.');
  }
  try {
    // Settings and ACP configs use the stable profile path above. A public PATH
    // alias is only a convenience, so another profile must not replace its owner.
    ensureManagedAgentCommandLauncher({
      ...options,
      targetPath: launcherPath,
      targetArgs: [],
      ownershipMarker: AGENT_CLI_LAUNCHER_MARKER,
      preserveOwnedMarkers: [AGENT_CLI_LAUNCHER_MARKER],
    });
  } catch {
    // A conflicting or unavailable PATH entry does not affect the profile command.
  }
  return { command: launcherPath, path: launcherPath };
}
