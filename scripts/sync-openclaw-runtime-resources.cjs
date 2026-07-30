'use strict';

const fs = require('fs');
const path = require('path');
const { pruneRuntimeExtensions } = require('./prune-openclaw-runtime.cjs');

function resolveRepoRoot() {
  return path.resolve(__dirname, '..');
}

function syncDocTemplates(repoRoot, runtimeRoot, label) {
  const sourceDir = path.join(repoRoot, 'resources', 'docs', 'reference', 'templates');
  const targetDir = path.join(runtimeRoot, 'docs', 'reference', 'templates');

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Template source not found: ${sourceDir}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });

  const copiedFiles = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .length;

  console.log(
    `[${label}] Synced OpenClaw doc templates: `
      + `${path.relative(repoRoot, sourceDir)} -> ${path.relative(repoRoot, targetDir)} `
      + `(${copiedFiles} files)`,
  );

  return { sourceDir, targetDir, copiedFiles };
}

function syncDocChannels(repoRoot, runtimeRoot, label) {
  const sourceDir = path.join(repoRoot, 'resources', 'docs', 'channels');
  const targetDir = path.join(runtimeRoot, 'docs', 'channels');

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Channel source not found: ${sourceDir}`);
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });

  const copiedFiles = fs
    .readdirSync(targetDir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .length;

  console.log(
    `[${label}] Replaced OpenClaw doc channels: `
      + `${path.relative(repoRoot, sourceDir)} -> ${path.relative(repoRoot, targetDir)} `
      + `(${copiedFiles} files)`,
  );

  return { sourceDir, targetDir, copiedFiles };
}

function syncGatewayConfigChannels(repoRoot, runtimeRoot, label) {
  const sourceFile = path.join(repoRoot, 'resources', 'docs', 'gateway', 'config-channels.md');
  const targetFile = path.join(runtimeRoot, 'docs', 'gateway', 'config-channels.md');

  if (!fs.existsSync(sourceFile)) {
    throw new Error(`Gateway channel config source not found: ${sourceFile}`);
  }

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.copyFileSync(sourceFile, targetFile);

  console.log(
    `[${label}] Replaced OpenClaw gateway channel config: `
      + `${path.relative(repoRoot, sourceFile)} -> ${path.relative(repoRoot, targetFile)}`,
  );

  return { sourceFile, targetFile };
}

function syncLocalExtensions(repoRoot, runtimeRoot, label) {
  const sourceDir = path.join(repoRoot, 'openclaw-extensions');
  const targetDir = path.join(runtimeRoot, 'dist', 'extensions');
  const copied = [];

  if (!fs.existsSync(sourceDir)) {
    return { sourceDir, targetDir, copied };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    fs.cpSync(
      path.join(sourceDir, entry.name),
      path.join(targetDir, entry.name),
      { recursive: true, force: true },
    );
    copied.push(entry.name);
  }

  console.log(
    `[${label}] Synced local extensions: ${copied.length > 0 ? copied.join(', ') : 'none'}`,
  );

  return { sourceDir, targetDir, copied };
}

function syncOpenClawRuntimeResources(runtimeRoot, options = {}) {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const label = options.label || 'sync-openclaw-runtime-resources';
  const resolvedRuntimeRoot = runtimeRoot
    ? path.resolve(runtimeRoot)
    : path.join(repoRoot, 'vendor', 'openclaw-runtime', 'current');

  if (!fs.existsSync(resolvedRuntimeRoot)) {
    throw new Error(`Runtime not found: ${resolvedRuntimeRoot}`);
  }

  const docs = syncDocTemplates(repoRoot, resolvedRuntimeRoot, label);
  const channels = syncDocChannels(repoRoot, resolvedRuntimeRoot, label);
  const gatewayConfigChannels = syncGatewayConfigChannels(repoRoot, resolvedRuntimeRoot, label);
  const extensions = syncLocalExtensions(repoRoot, resolvedRuntimeRoot, label);
  const pruneStats = {
    extensionDirsRemoved: 0,
    bytesFreed: 0,
  };
  const pruning = pruneRuntimeExtensions(resolvedRuntimeRoot, pruneStats, {
    repoRoot,
    label,
  });

  console.log(
    `[${label}] Runtime resources ready: ${docs.copiedFiles} doc templates, `
      + `${channels.copiedFiles} doc channels, `
      + `${extensions.copied.length} local extensions, `
      + `${pruneStats.extensionDirsRemoved} bundled extensions removed.`,
  );

  return {
    runtimeRoot: resolvedRuntimeRoot,
    docs,
    channels,
    gatewayConfigChannels,
    extensions,
    pruning,
  };
}

function main() {
  try {
    syncOpenClawRuntimeResources(process.argv[2]);
  } catch (error) {
    console.error(
      `[sync-openclaw-runtime-resources] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  syncDocChannels,
  syncGatewayConfigChannels,
  syncOpenClawRuntimeResources,
};
