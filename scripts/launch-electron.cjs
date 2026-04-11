/**
 * Electron launcher script
 *
 * This script ensures ELECTRON_RUN_AS_NODE is cleared before launching Electron.
 * The ELECTRON_RUN_AS_NODE=1 environment variable causes Electron to run as Node.js,
 * which breaks the electron module API (require('electron') returns path string instead of API object).
 */

const { spawn } = require('child_process');
const path = require('path');

// Get electron executable path
const electronPath = require('electron');

// Clear ELECTRON_RUN_AS_NODE from environment
// This is critical - when set, Electron runs as Node.js instead of proper Electron mode
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Set development environment
env.NODE_ENV = process.env.NODE_ENV || 'development';
env.ELECTRON_START_URL = process.env.ELECTRON_START_URL || 'http://localhost:5175';

console.log('[Electron Launcher] Starting Electron...');
console.log('[Electron Launcher] Electron path:', electronPath);
console.log('[Electron Launcher] ELECTRON_RUN_AS_NODE:', env.ELECTRON_RUN_AS_NODE ?? '(not set)');

// Spawn Electron with clean environment
// Pass "." to make Electron use the current directory and package.json's main field
const args = ['.'];
if (process.argv.length > 2) {
  args.push(...process.argv.slice(2));
}

const child = spawn(electronPath, args, {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: env,
  windowsHide: false
});

child.on('close', (code, signal) => {
  if (code === null) {
    console.error(`Electron exited with signal ${signal}`);
    process.exit(1);
  }
  process.exit(code);
});

// Handle termination signals
['SIGINT', 'SIGTERM', 'SIGUSR2'].forEach(signal => {
  process.on(signal, () => {
    child.kill(signal);
  });
});