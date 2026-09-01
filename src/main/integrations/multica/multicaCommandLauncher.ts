import fs from 'fs';
import os from 'os';
import path from 'path';

import { PRODUCT_NAME } from '../../../shared/productMetadata';

export const MULTICA_COMMAND_NAME = `${PRODUCT_NAME}-agent`;
const OWNERSHIP_MARKER = `${PRODUCT_NAME}-managed-multica-launcher-v1`;

export interface MulticaCommandLauncher {
  commandName: string;
  commandLine: string;
  fixedArgs: string[];
  path: string;
}

export interface MulticaCommandLauncherOptions {
  targetPath: string;
  targetArgs?: readonly string[];
  platform?: NodeJS.Platform;
  pathValue?: string;
  homeDirectory?: string;
  localAppData?: string;
  appData?: string;
}

const normalizeForComparison = (value: string, platform: NodeJS.Platform): string => {
  const normalized = path.resolve(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const isWithin = (candidate: string, root: string, platform: NodeJS.Platform): boolean => {
  const normalizedCandidate = normalizeForComparison(candidate, platform);
  const normalizedRoot = normalizeForComparison(root, platform);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
};

const quoteShellArgument = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

const windowsLauncherResult = (targetPath: string): MulticaCommandLauncher => {
  if (path.extname(targetPath).toLowerCase() !== '.exe') {
    throw new Error('Multica requires a native executable on Windows.');
  }
  const multicaCommand = targetPath.replaceAll('\\', '/');
  return {
    commandName: targetPath,
    commandLine: multicaCommand,
    fixedArgs: [],
    path: targetPath,
  };
};

const posixLauncherContent = (targetPath: string, targetArgs: readonly string[]): string =>
  [
    '#!/bin/sh',
    `# ${OWNERSHIP_MARKER}`,
    `exec ${[targetPath, ...targetArgs].map(quoteShellArgument).join(' ')} "$@"`,
    '',
  ].join('\n');

const pathEntries = (value: string, platform: NodeJS.Platform): string[] => {
  const delimiter = platform === 'win32' ? ';' : ':';
  return value
    .split(delimiter)
    .map(entry => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
};

export function ensureMulticaCommandLauncher(
  options: MulticaCommandLauncherOptions,
): MulticaCommandLauncher {
  const platform = options.platform ?? process.platform;
  const targetArgs = [...(options.targetArgs ?? [])];
  if (platform === 'win32') {
    if (targetArgs.length > 0) {
      throw new Error('Multica cannot apply launcher arguments during Windows environment setup.');
    }
    if (/\s/.test(options.targetPath)) {
      throw new Error('Multica requires the Windows Agent executable path to contain no spaces.');
    }
    if (!fs.existsSync(options.targetPath) || !fs.statSync(options.targetPath).isFile()) {
      throw new Error('The Multica native Agent executable was not found.');
    }
    return windowsLauncherResult(path.resolve(options.targetPath));
  }
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const ownedRoots = [homeDirectory, options.localAppData, options.appData].filter(
    (value): value is string => Boolean(value),
  );
  const preferredDirectory = path.join(homeDirectory, '.local', 'bin');
  const entries = pathEntries(options.pathValue ?? process.env.PATH ?? '', platform);
  const candidates = [
    ...entries.filter(
      entry =>
        normalizeForComparison(entry, platform) ===
        normalizeForComparison(preferredDirectory, platform),
    ),
    ...entries.filter(
      entry =>
        normalizeForComparison(entry, platform) !==
        normalizeForComparison(preferredDirectory, platform),
    ),
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        candidate =>
          normalizeForComparison(candidate, platform) === normalizeForComparison(entry, platform),
      ) === index,
  );
  const fileName = MULTICA_COMMAND_NAME;
  const content = posixLauncherContent(options.targetPath, targetArgs);

  for (const directory of candidates) {
    if (!ownedRoots.some(root => isWithin(directory, root, platform))) continue;
    try {
      if (!fs.statSync(directory).isDirectory()) continue;
      fs.accessSync(directory, fs.constants.W_OK);
    } catch {
      continue;
    }
    const launcherPath = path.join(directory, fileName);
    if (fs.existsSync(launcherPath)) {
      const existing = fs.readFileSync(launcherPath, 'utf8');
      if (existing !== content && !existing.includes(OWNERSHIP_MARKER)) continue;
      if (existing === content) {
        return {
          commandName: MULTICA_COMMAND_NAME,
          commandLine: MULTICA_COMMAND_NAME,
          fixedArgs: [],
          path: launcherPath,
        };
      }
    }
    const temporaryPath = `${launcherPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, content, { mode: 0o700 });
    fs.rmSync(launcherPath, { force: true });
    fs.renameSync(temporaryPath, launcherPath);
    fs.chmodSync(launcherPath, 0o700);
    return {
      commandName: MULTICA_COMMAND_NAME,
      commandLine: MULTICA_COMMAND_NAME,
      fixedArgs: [],
      path: launcherPath,
    };
  }

  throw new Error('No writable user-owned directory is available for the Multica launcher.');
}

export function removeMulticaCommandLauncher(
  launcherPath: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
  targetArgs: readonly string[] = [],
): void {
  if (
    normalizeForComparison(launcherPath, platform) === normalizeForComparison(targetPath, platform)
  )
    return;
  if (platform === 'win32') {
    if (!fs.existsSync(launcherPath) || !/\.(?:cmd|bat|ps1)$/i.test(launcherPath)) return;
    if (!fs.readFileSync(launcherPath, 'utf8').includes(OWNERSHIP_MARKER)) return;
    fs.rmSync(launcherPath);
    return;
  }
  if (!fs.existsSync(launcherPath)) return;
  const expected = posixLauncherContent(targetPath, targetArgs);
  const existing = fs.readFileSync(launcherPath, 'utf8');
  if (existing !== expected) return;
  fs.rmSync(launcherPath);
}
