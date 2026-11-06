import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_CLI_BRIDGE_SWITCH,
  AGENT_CLI_PROFILE_SWITCH,
} from '../../../shared/integrations/agentCli';
import {
  AGENT_CLI_COMMAND_NAME,
  buildAgentCliBridgeArguments,
  ensureAgentCliCommandLauncher,
  resolveAgentCliProfileLauncherPath,
  resolvePackagedAgentCliTargetPath,
} from './agentCliLauncher';
import { parseAgentBridgeArgv, resolveAgentBridgeProfile } from './transport/agentBridgeProtocol';

const directories: string[] = [];

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-launcher-'));
  directories.push(home);
  return home;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('general agent CLI launcher', () => {
  it('carries the owning profile in bridge bootstrap arguments without forwarding task env', () => {
    const home = temporaryHome();
    const profile = path.join(home, '独立 profile $&');
    const applicationPath = path.join(home, 'desktop app');
    const targetArgs = buildAgentCliBridgeArguments(profile, applicationPath);
    const processArgv = ['electron', ...targetArgs, 'exec', '--json', 'task'];
    const launcher = ensureAgentCliCommandLauncher({
      targetPath: '/opt/Electron',
      targetArgs,
      profileDirectory: profile,
      platform: 'linux',
      homeDirectory: home,
      pathValue: '',
    });
    const content = fs.readFileSync(launcher.path, 'utf8');

    expect(targetArgs).toEqual([
      applicationPath,
      AGENT_CLI_PROFILE_SWITCH,
      profile,
      AGENT_CLI_BRIDGE_SWITCH,
    ]);
    expect(buildAgentCliBridgeArguments(profile)).toEqual(targetArgs.slice(1));
    expect(resolveAgentBridgeProfile(processArgv)).toBe(profile);
    expect(parseAgentBridgeArgv(processArgv)).toEqual(['exec', '--json', 'task']);
    expect(content).toContain(`'${AGENT_CLI_PROFILE_SWITCH}' '${profile}'`);
    expect(launcher.path).toBe(path.join(profile, 'external-agent', 'bin', AGENT_CLI_COMMAND_NAME));
    expect(launcher.path).toBe(resolveAgentCliProfileLauncherPath(profile));
    expect(content).toContain('JUSTDO_*|ELECTRON_*|OPENCLAW_BUNDLED_*');
    expect(content).not.toContain('JUSTDO_DEV_USER_DATA_DIR=');
    expect(() => buildAgentCliBridgeArguments('relative-profile')).toThrow('must be absolute');
  });

  it('uses a quoted profile command and stable managed PATH alias', () => {
    const home = temporaryHome();
    const options = {
      targetPath: "/Applications/Assistant's app/Assistant",
      profileDirectory: path.join(home, 'profile'),
      platform: 'darwin' as const,
      homeDirectory: home,
      pathValue: '',
    };
    const launcher = ensureAgentCliCommandLauncher(options);
    const content = fs.readFileSync(launcher.path, 'utf8');
    const aliasPath = path.join(home, '.local', 'bin', AGENT_CLI_COMMAND_NAME);
    const alias = fs.readFileSync(aliasPath, 'utf8');
    expect(content).toContain('--external-agent-bridge');
    expect(content).toContain("'/Applications/Assistant'\"'\"'s app/Assistant'");
    expect(content).toContain('unset ELECTRON_RUN_AS_NODE NODE_ENV NODE_OPTIONS NODE_PATH');
    expect(alias).toContain(launcher.path);
    ensureAgentCliCommandLauncher(options);
    expect(fs.readFileSync(aliasPath, 'utf8')).toBe(alias);
    expect(fs.readFileSync(launcher.path, 'utf8')).toBe(content);
  });

  it('resolves installed AppImages instead of temporary mount executables', () => {
    expect(
      resolvePackagedAgentCliTargetPath(
        '/tmp/.mount_Assistant/usr/bin/assistant',
        'linux',
        '/home/user/Applications/Assistant.AppImage',
      ),
    ).toBe(path.resolve('/home/user/Applications/Assistant.AppImage'));
    expect(
      resolvePackagedAgentCliTargetPath('/Applications/Assistant.app/Assistant', 'darwin'),
    ).toBe(path.resolve('/Applications/Assistant.app/Assistant'));
  });

  it('keeps each profile command stable when another profile prepares the shared PATH alias', () => {
    const home = temporaryHome();
    const options = {
      targetPath: '/opt/Electron',
      platform: 'linux' as const,
      homeDirectory: home,
      pathValue: '',
    };
    const firstProfile = path.join(home, 'first-profile');
    const secondProfile = path.join(home, 'second-profile');
    const first = ensureAgentCliCommandLauncher({ ...options, profileDirectory: firstProfile });
    const firstContent = fs.readFileSync(first.path, 'utf8');
    const aliasPath = path.join(home, '.local', 'bin', AGENT_CLI_COMMAND_NAME);
    const aliasContent = fs.readFileSync(aliasPath, 'utf8');

    const second = ensureAgentCliCommandLauncher({ ...options, profileDirectory: secondProfile });

    expect(first.path).not.toBe(second.path);
    expect(fs.readFileSync(first.path, 'utf8')).toBe(firstContent);
    expect(fs.readFileSync(second.path, 'utf8')).toContain(secondProfile);
    expect(fs.readFileSync(aliasPath, 'utf8')).toBe(aliasContent);
    expect(aliasContent).toContain(first.path);
    expect(aliasContent).not.toContain(second.path);

    ensureAgentCliCommandLauncher({
      ...options,
      profileDirectory: firstProfile,
      targetPath: '/opt/Updated Electron',
    });
    expect(fs.readFileSync(first.path, 'utf8')).toContain('/opt/Updated Electron');
    expect(fs.readFileSync(aliasPath, 'utf8')).toBe(aliasContent);
  });

  it('keeps the profile command available when PATH contains an unrelated user command', () => {
    const home = temporaryHome();
    const directory = path.join(home, '.local', 'bin');
    fs.mkdirSync(directory, { recursive: true });
    const command = path.join(directory, AGENT_CLI_COMMAND_NAME);
    fs.writeFileSync(command, '#!/bin/sh\n# personal command\n');

    const launcher = ensureAgentCliCommandLauncher({
      targetPath: '/opt/Assistant',
      profileDirectory: path.join(home, 'profile'),
      platform: 'linux',
      homeDirectory: home,
      pathValue: '',
    });
    expect(launcher.path).not.toBe(command);
    expect(fs.readFileSync(launcher.path, 'utf8')).toContain('/opt/Assistant');
    expect(fs.readFileSync(command, 'utf8')).toContain('# personal command');
  });

  it('requires an absolute explicit profile for a POSIX command', () => {
    const options = {
      targetPath: '/opt/Electron',
      platform: 'linux' as const,
      homeDirectory: temporaryHome(),
      pathValue: '',
    };
    expect(() => ensureAgentCliCommandLauncher(options)).toThrow('profile directory');
    expect(() => resolveAgentCliProfileLauncherPath('relative')).toThrow('profile directory');
    expect(() =>
      ensureAgentCliCommandLauncher({ ...options, profileDirectory: 'relative' }),
    ).toThrow('profile directory');
  });

  it('keeps the native Windows command at its installed absolute path', () => {
    const home = temporaryHome();
    const target = path.join(home, '安装 目录', 'assistant-cli.exe');
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, 'native launcher');

    expect(ensureAgentCliCommandLauncher({ targetPath: target, platform: 'win32' })).toEqual({
      command: target.replaceAll('\\', '/'),
      path: target,
    });
    expect(() =>
      ensureAgentCliCommandLauncher({ targetPath: `${target}.cmd`, platform: 'win32' }),
    ).toThrow('native executable');
  });
});
