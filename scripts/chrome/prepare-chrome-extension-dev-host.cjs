'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readProductName(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const productName = packageJson.productName;
  if (typeof productName !== 'string' || !/^[A-Za-z]{1,64}$/.test(productName)) {
    throw new Error('Chrome extension productName must contain 1-64 ASCII letters.');
  }
  return productName;
}

function resolveDevelopmentNativeHostExecutable(repoRoot) {
  const productName = readProductName(repoRoot);
  const sourcePath = path.join(repoRoot, 'scripts', 'chrome', 'chrome-extension-native-host.cs');
  const sourceDigest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(sourcePath))
    .digest('hex')
    .slice(0, 16);
  return path.join(
    repoRoot,
    'build',
    'chrome-extension',
    'native-host',
    sourceDigest,
    `${productName}-chrome-extension-native-host.exe`,
  );
}

function resolveCompilerPath(windowsDirectory = process.env.WINDIR) {
  if (!windowsDirectory) return null;
  for (const framework of ['Framework64', 'Framework']) {
    const candidate = path.join(
      windowsDirectory,
      'Microsoft.NET',
      framework,
      'v4.0.30319',
      'csc.exe',
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isReusableWindowsExecutable(executablePath) {
  if (!fs.existsSync(executablePath)) return false;
  const file = fs.openSync(executablePath, 'r');
  try {
    const signature = Buffer.alloc(2);
    return (
      fs.readSync(file, signature, 0, signature.length, 0) === 2 &&
      signature.equals(Buffer.from('MZ'))
    );
  } finally {
    fs.closeSync(file);
  }
}

function compileChromeExtensionNativeHost(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return null;
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../..'));
  const executablePath =
    options.executablePath ||
    path.join(
      repoRoot,
      'build',
      'chrome-extension',
      'native-host',
      `${readProductName(repoRoot)}-chrome-extension-native-host.exe`,
    );
  const outputDirectory = path.dirname(executablePath);
  const sourcePath = path.join(repoRoot, 'scripts', 'chrome', 'chrome-extension-native-host.cs');
  fs.mkdirSync(outputDirectory, { recursive: true });
  // Development outputs are content-addressed by the C# source digest. The
  // fixed packaged filename must always be rebuilt so an older build artifact
  // cannot silently survive a source update.
  if (options.executablePath && isReusableWindowsExecutable(executablePath)) {
    return { executablePath, outputDirectory, reused: true, sourcePath };
  }
  const compilerPath = options.compilerPath || resolveCompilerPath(options.windowsDirectory);
  if (!compilerPath) {
    throw new Error('The Windows .NET Framework C# compiler was not found.');
  }
  if (!options.executablePath) {
    // Recreating the fixed output also refreshes its actual NTFS name casing;
    // overwriting an old lowercase name would fail Builder's exact-case filter.
    fs.rmSync(executablePath, { force: true });
  }
  execFileSync(
    compilerPath,
    [
      '/nologo',
      '/target:exe',
      '/reference:System.Web.Extensions.dll',
      `/out:${executablePath}`,
      sourcePath,
    ],
    { stdio: 'pipe', windowsHide: true },
  );
  return { executablePath, outputDirectory, reused: false, sourcePath };
}

function prepareChromeExtensionDevHost(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return null;
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../..'));
  return compileChromeExtensionNativeHost({
    ...options,
    repoRoot,
    executablePath: resolveDevelopmentNativeHostExecutable(repoRoot),
  });
}

if (require.main === module) {
  try {
    const result = prepareChromeExtensionDevHost();
    if (result) {
      console.log(`[prepare-chrome-extension-dev-host] Prepared ${result.executablePath}`);
    }
  } catch (error) {
    console.error(
      `[prepare-chrome-extension-dev-host] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  compileChromeExtensionNativeHost,
  isReusableWindowsExecutable,
  prepareChromeExtensionDevHost,
  resolveCompilerPath,
  resolveDevelopmentNativeHostExecutable,
};
