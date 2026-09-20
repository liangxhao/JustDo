'use strict';

const { execFileSync } = require('child_process');
const { mkdirSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const outputPath = path.join(repoRoot, 'resources', 'build-info.json');

function git(...args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function createBuildInfo(now = new Date()) {
  const packageMetadata = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const commit = git('rev-parse', 'HEAD');
  const shortCommit = git('rev-parse', '--short=8', 'HEAD');
  const branch = git('branch', '--show-current') || 'detached';
  const dirty = Boolean(git('status', '--porcelain', '--untracked-files=normal'));
  return {
    schemaVersion: 1,
    productVersion: packageMetadata.version,
    commit,
    shortCommit,
    branch,
    dirty,
    buildId: `${shortCommit}${dirty ? '-dirty' : ''}`,
    builtAt: now.toISOString(),
  };
}

function writeBuildInfo() {
  const buildInfo = createBuildInfo();
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
  console.log(
    `[generate-build-info] ${buildInfo.productVersion} ${buildInfo.buildId} (${buildInfo.branch})`,
  );
  return buildInfo;
}

if (require.main === module) {
  writeBuildInfo();
}

module.exports = { createBuildInfo, outputPath, writeBuildInfo };
