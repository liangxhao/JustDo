import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { mcpAppRecord } from '../../../shared/plugins/mcpApps';
import { isWorkspaceFileName } from '../../../shared/preview/workspaceFiles';
import { resolveActiveNativeMcpData } from '../data/nativeMcpData';

export interface ManagedMcpFile {
  filePath: string;
  name: string;
  cwd: string;
  assertCurrent(): void;
}

export function managedMcpFileProvider(
  stateDirectory: string,
  configPath: string,
  raw: unknown,
  gateway: { port: number; isCurrent(): boolean },
) {
  const input = mcpAppRecord(raw);
  const serverName = input?.serverName;
  if (!input || typeof serverName !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(serverName) ||
      typeof input.gatewayUrl !== 'string' || input.gatewayUrl.length > 512)
    throw new Error('Invalid managed App file');
  const url = URL.parse(input.gatewayUrl);
  if (!url || url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      Number(url.port || '80') !== gateway.port || url.pathname !== '/' ||
      url.search || url.hash || url.username || url.password)
    throw new Error('Managed App file requires the local Gateway');
  return () => {
    if (!gateway.isCurrent()) throw new Error('Managed App file Gateway changed');
    return resolveActiveNativeMcpData(configPath, stateDirectory, serverName);
  };
}

export function resolveManagedMcpFile(
  stateDirectory: string,
  configPath: string,
  raw: unknown,
  gateway: { port: number; isCurrent(): boolean },
): ManagedMcpFile {
  const input = mcpAppRecord(raw);
  if (typeof input?.relativePath !== 'string' || Object.keys(input).length !== 3)
    throw new Error('Invalid managed App file');
  const owner = managedMcpFileProvider(stateDirectory, configPath, input, gateway);
  const relativePath = input.relativePath;
  const [folder, id, name, ...extra] = relativePath.split('/');
  if (folder !== 'files' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id) ||
      !isWorkspaceFileName(name) || extra.length)
    throw new Error('Invalid managed App file');

  const resolve = () => {
    const { directory, identity } = owner();
    const files = path.join(directory, folder);
    const cwd = path.join(files, id);
    const filePath = path.join(cwd, name);
    const directoryIds = [directory, files, cwd].map(entry => {
      const stat = lstatSync(entry, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Managed App file is unavailable');
      return `${stat.dev}:${stat.ino}`;
    });
    const file = lstatSync(filePath, { bigint: true });
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n ||
        realpathSync.native(filePath) !== filePath)
      throw new Error('Managed App file is unavailable');
    return { filePath, cwd, stamp: JSON.stringify([identity, filePath, directoryIds]) };
  };
  const { filePath, cwd, stamp } = resolve();
  return {
    filePath,
    name,
    cwd,
    assertCurrent() {
      // A normal atomic save can replace the file inode. Keep the exact owned
      // directory and filename bound while allowing that editor operation.
      if (resolve().stamp !== stamp) throw new Error('Managed App file changed');
    },
  };
}
