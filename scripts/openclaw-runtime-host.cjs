'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

function resolveHostTargetId() {
  const platformMap = {
    darwin: 'mac',
    win32: 'win',
    linux: 'linux',
  };
  const archMap = {
    x64: 'x64',
    arm64: 'arm64',
    ia32: 'ia32',
  };

  const platform = platformMap[process.platform];
  const arch = archMap[process.arch];
  if (!platform || !arch) {
    throw new Error(`Unsupported host platform/arch: ${process.platform}/${process.arch}`);
  }

  return `${platform}-${arch}`;
}

const targetId = resolveHostTargetId();
const rootDir = path.resolve(__dirname, '..');
const npmScript = `openclaw:runtime:${targetId}`;
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error('openclaw-runtime-host must be launched through npm');
}

const result = spawnSync(process.execPath, [npmCliPath, 'run', npmScript], {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
