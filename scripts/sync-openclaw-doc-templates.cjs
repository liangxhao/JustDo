'use strict';

const fs = require('fs');
const path = require('path');

function resolveRepoRoot() {
  return path.resolve(__dirname, '..');
}

function syncOpenClawDocTemplates(runtimeDir, options = {}) {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const label = options.label || 'sync-openclaw-doc-templates';
  const sourceDir = path.join(repoRoot, 'resources', 'docs', 'reference', 'templates');
  const targetDir = path.join(runtimeDir, 'docs', 'reference', 'templates');

  if (!fs.existsSync(runtimeDir)) {
    throw new Error(`Runtime not found: ${runtimeDir}`);
  }
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Template source not found: ${sourceDir}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });

  const copiedFiles = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .length;

  console.log(
    `[${label}] Synced OpenClaw doc templates: `
    + `${path.relative(repoRoot, sourceDir)} -> ${path.relative(repoRoot, targetDir)} `
    + `(${copiedFiles} files)`,
  );

  return { sourceDir, targetDir, copiedFiles };
}

if (require.main === module) {
  const repoRoot = resolveRepoRoot();
  const runtimeDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repoRoot, 'vendor', 'openclaw-runtime', 'current');

  try {
    syncOpenClawDocTemplates(runtimeDir, { repoRoot });
  } catch (error) {
    console.error(
      `[sync-openclaw-doc-templates] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = { syncOpenClawDocTemplates };
