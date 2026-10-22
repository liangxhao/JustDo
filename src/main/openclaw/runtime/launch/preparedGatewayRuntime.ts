import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireRuntimeModule = createRequire(__filename);
const GATEWAY_BUNDLE_FILENAME = 'gateway-bundle.mjs';
const GATEWAY_LAUNCHER_FILENAME = 'gateway-launcher.cjs';
const WINDOWS_RUNTIME_PRELOAD_FILENAME = 'windows-runtime-preload.cjs';

function requirePreparedRuntimeFile(runtimeRoot: string, filename: string): string {
  const filePath = path.join(runtimeRoot, filename);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (cause) {
    throw new Error(`Packaged OpenClaw runtime file is missing: ${filePath}`, { cause });
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Packaged OpenClaw runtime requires a non-empty regular file: ${filePath}`);
  }
  return filePath;
}

export function resolvePreparedWindowsGatewayLauncher(runtimeRoot: string): string {
  requirePreparedRuntimeFile(runtimeRoot, GATEWAY_BUNDLE_FILENAME);
  requirePreparedRuntimeFile(runtimeRoot, WINDOWS_RUNTIME_PRELOAD_FILENAME);
  return requirePreparedRuntimeFile(runtimeRoot, GATEWAY_LAUNCHER_FILENAME);
}

export function loadPreparedWindowsRuntimePreload(runtimeRoot: string): string {
  const preloadPath = requirePreparedRuntimeFile(runtimeRoot, WINDOWS_RUNTIME_PRELOAD_FILENAME);
  // Load the build's actual bytes. Serializing a bundled/minified installer
  // function here would rewrite the immutable installation with different code.
  requireRuntimeModule(preloadPath);
  return preloadPath;
}
