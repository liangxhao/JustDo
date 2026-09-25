'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BROWSER_EXTENSION_ID = 'jboajogplelmaahjbomgflnfngpolgcb';
const NATIVE_HOST_NAME = 'com.justdo.browserextension';

function buildDevNativeHostPlan(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../..'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const productName = packageJson.productName;
  if (typeof productName !== 'string' || !/^[A-Za-z]{1,64}$/.test(productName)) {
    throw new Error('Browser extension productName must contain 1-64 ASCII letters.');
  }
  const appDataPath = options.appDataPath || process.env.APPDATA;
  if (!appDataPath) throw new Error('APPDATA is unavailable.');
  const outputDirectory = path.join(repoRoot, 'build', 'browser-extension', 'native-host');
  const sourcePath = path.join(repoRoot, 'scripts', 'browser', 'browser-extension-native-host.cs');
  const sourceDigest = crypto
    .createHash('sha256')
    .update(fs.readFileSync(sourcePath))
    .digest('hex')
    .slice(0, 16);
  const executablePath = path.join(
    outputDirectory,
    `justdo-browser-extension-dev-host-${sourceDigest}.exe`,
  );
  const manifestPath = path.join(
    appDataPath,
    productName,
    'browser-extension',
    `${NATIVE_HOST_NAME}.json`,
  );
  return {
    configPath: path.join(path.dirname(manifestPath), 'native-host.config.json'),
    executablePath,
    manifest: {
      allowed_origins: [`chrome-extension://${BROWSER_EXTENSION_ID}/`],
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

function buildDevNativeHostConfig(plan, electronPath, devServerUrl) {
  return {
    environment: { ELECTRON_START_URL: devServerUrl, NODE_ENV: 'development' },
    executableArguments: [plan.repoRoot],
    executablePath: electronPath,
    rendezvousPath: path.join(path.dirname(plan.manifestPath), 'app-server.json'),
    requiredPath: path.join(plan.repoRoot, 'dist-electron', 'main.js'),
    requiredUrl: devServerUrl,
    workingDirectory: plan.repoRoot,
  };
}

function compileBrowserExtensionNativeHost(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return null;
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../..'));
  const outputDirectory = path.join(repoRoot, 'build', 'browser-extension', 'native-host');
  const executablePath =
    options.executablePath ||
    path.join(outputDirectory, 'justdo-browser-extension-native-host-v2.exe');
  const sourcePath = path.join(repoRoot, 'scripts', 'browser', 'browser-extension-native-host.cs');
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

function prepareBrowserExtensionDevHost(options = {}) {
  if ((options.platform || process.platform) !== 'win32') return null;
  const plan = buildDevNativeHostPlan(options);
  const electronPath = options.electronPath || require('electron');
  const devServerUrl = options.devServerUrl;
  if (typeof devServerUrl !== 'string' || !/^http:\/\/localhost:\d+$/u.test(devServerUrl)) {
    throw new Error('A loopback Electron development server URL is required.');
  }

  compileBrowserExtensionNativeHost({ ...options, executablePath: plan.executablePath });
  fs.mkdirSync(path.dirname(plan.manifestPath), { recursive: true });
  fs.writeFileSync(
    plan.configPath,
    `${JSON.stringify(buildDevNativeHostConfig(plan, electronPath, devServerUrl), null, 2)}\n`,
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
    const packageJson = require('../../package.json');
    const port = process.env.JUSTDO_DEV_SERVER_PORT || packageJson.devServer.port;
    const result = prepareBrowserExtensionDevHost({
      devServerUrl: `http://localhost:${port}`,
    });
    if (result) {
      console.log(`[prepare-browser-extension-dev-host] Registered ${result.manifestPath}`);
    }
  } catch (error) {
    console.error(
      `[prepare-browser-extension-dev-host] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = {
  buildDevNativeHostConfig,
  buildDevNativeHostPlan,
  compileBrowserExtensionNativeHost,
  isReusableWindowsExecutable,
  prepareBrowserExtensionDevHost,
  resolveCompilerPath,
};
