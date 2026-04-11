/**
 * Rebuild native modules for Electron's Node ABI
 * This script downloads prebuilt binaries for native modules like better-sqlite3
 * that need to be compiled for Electron's specific Node ABI version.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.resolve(__dirname, '..');
const betterSqlite3Path = path.join(projectRoot, 'node_modules', 'better-sqlite3');

// Get Electron version from its package.json
let electronVersion;
try {
  const electronPackageJson = require(path.join(projectRoot, 'node_modules', 'electron', 'package.json'));
  electronVersion = electronPackageJson.version;
} catch (error) {
  console.error('Error: Could not find Electron package. Make sure electron is installed.');
  process.exit(1);
}

console.log(`Rebuilding native modules for Electron v${electronVersion}...`);

// Check if better-sqlite3 exists
if (!fs.existsSync(betterSqlite3Path)) {
  console.log('better-sqlite3 not found, skipping rebuild.');
  process.exit(0);
}

// Rebuild better-sqlite3 using prebuild-install
console.log('Downloading prebuilt binary for better-sqlite3...');
try {
  execSync(
    `npx prebuild-install --runtime electron --target ${electronVersion}`,
    {
      cwd: betterSqlite3Path,
      stdio: 'inherit',
      env: { ...process.env }
    }
  );
  console.log('Successfully rebuilt better-sqlite3 for Electron.');
} catch (error) {
  console.error('Warning: Failed to download prebuilt binary for better-sqlite3.');
  console.error('The module may still work if a compatible binary was already installed.');
  // Don't exit with error - the existing binary might still work
}

console.log('Native module rebuild complete.');