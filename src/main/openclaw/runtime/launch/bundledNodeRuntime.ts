import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';

import nodeRuntime from '../../../../shared/openclaw/nodeRuntime.json';

export const resolveBundledNodeRuntimePaths = (options: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: NodeJS.Platform;
  arch: string;
}): { executable: string; npmBin: string } => {
  const platform = { win32: 'win', darwin: 'mac', linux: 'linux' }[
    options.platform as 'win32' | 'darwin' | 'linux'
  ];
  const target = `${platform}-${options.arch}`;
  const contract = nodeRuntime.targets[target as keyof typeof nodeRuntime.targets];
  if (!contract) throw new Error(`Unsupported bundled Node target: ${target}`);
  const root = options.packaged
    ? join(options.resourcesPath, 'cfmind', 'node-runtime')
    : join(options.appPath, 'vendor', 'openclaw-runtime', 'current', 'node-runtime');
  const executable = join(root, contract.executable);
  const npmBin = join(root, contract.npmBin);
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'node-runtime-manifest.json'), 'utf8'));
    if (manifest.version !== nodeRuntime.version || manifest.target !== target ||
        manifest.archive !== contract.archive || manifest.archiveSha256 !== contract.sha256 ||
        manifest.executable !== contract.executable ||
        !statSync(executable).isFile() ||
        createHash('sha256').update(readFileSync(executable)).digest('hex') !==
          manifest.files?.[contract.executable]?.sha256 ||
        !statSync(join(npmBin, 'npm-cli.js')).isFile() ||
        !statSync(join(npmBin, 'npx-cli.js')).isFile()) {
      throw new Error('Bundled Node identity or executable checksum mismatch.');
    }
  } catch (error) {
    throw new Error(`Bundled Node ${nodeRuntime.version} is missing or damaged: ${root}`, {
      cause: error,
    });
  }
  return { executable, npmBin };
};
