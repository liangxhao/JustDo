/**
 * Rebuild native modules for Electron's Node ABI
 * This script downloads prebuilt binaries for native modules like better-sqlite3
 * that need to be compiled for Electron's specific Node ABI version.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const betterSqlite3Path = path.join(projectRoot, 'node_modules', 'better-sqlite3');

function readOption(name, fallback) {
  const optionIndex = process.argv.indexOf(name);
  return optionIndex === -1 ? fallback : process.argv[optionIndex + 1];
}

const targetPlatform = readOption('--platform', process.platform);
const targetArch = readOption('--arch', process.arch);
const forceRebuild = process.argv.includes('--force');

// Get Electron version from its package.json
let electronVersion;
try {
  const electronPackageJson = require(
    path.join(projectRoot, 'node_modules', 'electron', 'package.json'),
  );
  electronVersion = readOption('--electron-version', electronPackageJson.version);
} catch (error) {
  console.error('Error: Could not find Electron package. Make sure electron is installed.');
  process.exit(1);
}

// Check if better-sqlite3 exists
if (!fs.existsSync(betterSqlite3Path)) {
  console.log('better-sqlite3 not found, skipping rebuild.');
  process.exit(0);
}

const isHostTarget = targetPlatform === process.platform && targetArch === process.arch;
const electronExecutable = isHostTarget ? require('electron') : null;
const verificationMarker = 'JUSTDO_ELECTRON_ABI:';
const verificationScript = [
  `const Database=require(${JSON.stringify(betterSqlite3Path)});`,
  "const database=new Database(':memory:');",
  'database.close();',
  `process.stdout.write(${JSON.stringify(verificationMarker)}+(process.versions.modules||'unknown'));`,
].join('');

const verifyHostBinary = () => {
  if (!electronExecutable) return null;
  try {
    const output = execFileSync(electronExecutable, ['-e', verificationScript], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const markerIndex = output.lastIndexOf(verificationMarker);
    if (markerIndex === -1) return null;
    const electronAbi = output.slice(markerIndex + verificationMarker.length).trim();
    return /^\d+$/.test(electronAbi) ? electronAbi : null;
  } catch {
    return null;
  }
};

if (!forceRebuild && isHostTarget) {
  const existingElectronAbi = verifyHostBinary();
  if (existingElectronAbi) {
    console.log(
      `better-sqlite3 is already compatible with Electron ABI ${existingElectronAbi}; skipping rebuild.`,
    );
    process.exit(0);
  }
}

console.log(
  `Rebuilding native modules for Electron v${electronVersion} (${targetPlatform}-${targetArch})...`,
);

// Rebuild better-sqlite3 using prebuild-install
console.log('Downloading prebuilt binary for better-sqlite3...');
try {
  const prebuildInstallBin = require.resolve('prebuild-install/bin.js');
  execFileSync(
    process.execPath,
    [
      prebuildInstallBin,
      '--runtime',
      'electron',
      '--target',
      electronVersion,
      '--platform',
      targetPlatform,
      '--arch',
      targetArch,
    ],
    { cwd: betterSqlite3Path, stdio: 'inherit', env: { ...process.env } },
  );
  console.log('Successfully rebuilt better-sqlite3 for Electron.');
} catch (error) {
  console.error('Failed to rebuild better-sqlite3 for Electron.');
  throw error;
}

if (isHostTarget) {
  // better-sqlite3 loads its native binding lazily, so creating a database is
  // required to verify the downloaded binary rather than only its JS entry.
  const electronAbi = verifyHostBinary();
  if (!electronAbi) {
    throw new Error('Downloaded better-sqlite3 failed Electron runtime verification.');
  }
  console.log(`Verified better-sqlite3 with Electron ABI ${electronAbi}.`);
} else {
  console.log(
    `Skipping runtime verification for cross-target ${targetPlatform}-${targetArch}; ` +
      `the host is ${process.platform}-${process.arch}.`,
  );
}

console.log('Native module rebuild complete.');
