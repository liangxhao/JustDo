'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHROME_EXTENSION_ID = 'jboajogplelmaahjbomgflnfngpolgcb';
const NATIVE_HOST_NAME = 'app.chrome_extension';

function readProductName(repoRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const productName = packageJson.productName;
  if (typeof productName !== 'string' || !/^[A-Za-z]{1,64}$/.test(productName)) {
    throw new Error('Chrome extension productName must contain 1-64 ASCII letters.');
  }
  return productName;
}

function buildDevNativeHostPlan(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../..'));
  const productName = readProductName(repoRoot);
  const appDataPath = options.appDataPath || process.env.APPDATA;
  if (!appDataPath) throw new Error('APPDATA is unavailable.');
  const sourcePath = path.join(repoRoot, 'scripts', 'chrome', 'chrome-extension-native-host.cs');
  const sourceDigest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(sourcePath))
    .digest('hex')
    .slice(0, 16);
  const outputDirectory = path.join(
    repoRoot,
    'build',
    'chrome-extension',
    'native-host',
    sourceDigest,
  );
  const executablePath = path.join(
    outputDirectory,
    `${productName}-chrome-extension-native-host.exe`,
  );
  const manifestPath = path.join(
    appDataPath,
    productName,
    'chrome-extension',
    `${NATIVE_HOST_NAME}.json`,
  );
  return {
    configPath: path.join(path.dirname(manifestPath), 'native-host.config.json'),
    executablePath,
    manifest: {
      allowed_origins: [`chrome-extension://${CHROME_EXTENSION_ID}/`],
      description: `${productName} browser native messaging host (development)`,
      name: NATIVE_HOST_NAME,
      path: executablePath,
      type: 'stdio',
    },
    manifestPath,
    outputDirectory,
    productName,
    registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
    repoRoot,
    sourcePath,
  };
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

function buildDevNativeHostConfig(plan) {
  return {
    allowAppLaunch: false,
    rendezvousPath: path.join(path.dirname(plan.manifestPath), 'app-server.json'),
  };
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
  const plan = buildDevNativeHostPlan(options);

  compileChromeExtensionNativeHost({ ...options, executablePath: plan.executablePath });
  fs.mkdirSync(path.dirname(plan.manifestPath), { recursive: true });
  fs.writeFileSync(
    plan.configPath,
    `${JSON.stringify(buildDevNativeHostConfig(plan), null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(plan.manifestPath, `${JSON.stringify(plan.manifest, null, 2)}\n`, 'utf8');
  execFileSync(
    'reg.exe',
    ['ADD', plan.registryKey, '/ve', '/t', 'REG_SZ', '/d', plan.manifestPath, '/f'],
    { stdio: 'pipe', windowsHide: true },
  );
  return plan;
}

if (require.main === module) {
  try {
    const result = prepareChromeExtensionDevHost();
    if (result) {
      console.log(`[prepare-chrome-extension-dev-host] Registered ${result.manifestPath}`);
    }
  } catch (error) {
    console.error(
      `[prepare-chrome-extension-dev-host] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  buildDevNativeHostConfig,
  buildDevNativeHostPlan,
  compileChromeExtensionNativeHost,
  isReusableWindowsExecutable,
  prepareChromeExtensionDevHost,
  resolveCompilerPath,
};
