#!/usr/bin/env node
/**
 * Prepare MinGit under resources/mingit for Windows packaging/runtime.
 *
 * Features:
 * - Cross-platform execution (macOS/Linux can prepare assets for Windows packaging)
 * - Optional strict mode: --required (fail build if not prepared)
 * - Offline archive support via JUSTDO_PORTABLE_GIT_ARCHIVE
 * - Mirror URL override via JUSTDO_PORTABLE_GIT_URL
 * - Unified extraction via 7zip-bin (path7za)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const GIT_VERSION = '2.55.0';
const GIT_FOR_WINDOWS_PATCH = '3';
const MINGIT_VERSION = `${GIT_VERSION}.${GIT_FOR_WINDOWS_PATCH}`;
const MINGIT_FILE = `MinGit-${MINGIT_VERSION}-64-bit.zip`;
const DEFAULT_MINGIT_URL = `https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.${GIT_FOR_WINDOWS_PATCH}/${MINGIT_FILE}`;
const EXPECTED_MINGIT_SHA256 = 'f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05';
const EXPECTED_GIT_VERSION_OUTPUT = `git version ${GIT_VERSION}.windows.${GIT_FOR_WINDOWS_PATCH}`;

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(PROJECT_ROOT, 'resources', 'mingit');
const DEFAULT_ARCHIVE_PATH = path.join(PROJECT_ROOT, 'resources', MINGIT_FILE);
const VERSION_MARKER_PATH = path.join(OUTPUT_DIR, '.justdo-mingit-version');

function parseArgs(argv) {
  return {
    required: argv.includes('--required'),
  };
}

function resolveInputPath(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

function isNonEmptyFile(filePath) {
  try {
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function getDirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += getDirSize(full);
    } else {
      size += fs.statSync(full).size;
    }
  }
  return size;
}

function resolve7zaPath() {
  let path7za;
  try {
    ({ path7za } = require('7zip-bin'));
  } catch (error) {
    throw new Error(
      'Missing dependency "7zip-bin". Run npm install and retry. ' +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!path7za || !fs.existsSync(path7za)) {
    throw new Error(`7zip-bin executable not found: ${path7za || '(empty path)'}`);
  }

  return path7za;
}

function findMinGitExecutable(baseDir = OUTPUT_DIR) {
  const candidates = [path.join(baseDir, 'cmd', 'git.exe'), path.join(baseDir, 'bin', 'git.exe')];

  for (const candidate of candidates) {
    if (isNonEmptyFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

function validatePreparedMinGit(baseDir = OUTPUT_DIR, options = {}) {
  const gitPath = findMinGitExecutable(baseDir);
  if (!gitPath) {
    return { ok: false, gitPath: null, reason: 'git.exe is missing or empty' };
  }

  const packageVersionsPath = path.join(baseDir, 'etc', 'package-versions.txt');
  let packageVersions;
  try {
    packageVersions = fs.readFileSync(packageVersionsPath, 'utf8');
  } catch {
    return { ok: false, gitPath, reason: `version manifest is missing: ${packageVersionsPath}` };
  }
  const packageVersionPattern = new RegExp(
    `^mingw-w64-x86_64-git\\s+${MINGIT_VERSION.replace(/\./g, '\\.')}-\\d+\\s*$`,
    'm',
  );
  if (!packageVersionPattern.test(packageVersions)) {
    return {
      ok: false,
      gitPath,
      reason: `version manifest does not identify MinGit ${MINGIT_VERSION}`,
    };
  }

  if ((options.platform ?? process.platform) === 'win32') {
    const result = spawnSync(gitPath, ['--version'], { encoding: 'utf8', windowsHide: true });
    const actualVersion = String(result.stdout || '').trim();
    if (result.status !== 0 || actualVersion !== EXPECTED_GIT_VERSION_OUTPUT) {
      return {
        ok: false,
        gitPath,
        reason: `git.exe reported ${actualVersion || '(no version)'} instead of ${EXPECTED_GIT_VERSION_OUTPUT}`,
      };
    }
  }

  return { ok: true, gitPath, reason: null };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function assertExpectedArchiveChecksum(archivePath) {
  const actualHash = await sha256File(archivePath);
  if (actualHash !== EXPECTED_MINGIT_SHA256) {
    throw new Error(
      `MinGit archive SHA-256 mismatch for ${archivePath}. ` +
        `Expected ${EXPECTED_MINGIT_SHA256}, received ${actualHash}.`,
    );
  }
}

async function downloadArchive(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const tmpFile = `${destination}.download`;
  try {
    const stream = fs.createWriteStream(tmpFile);
    await pipeline(Readable.fromWeb(response.body), stream);

    if (!isNonEmptyFile(tmpFile)) {
      throw new Error('Downloaded archive is empty.');
    }

    fs.renameSync(tmpFile, destination);
  } catch (error) {
    try {
      fs.rmSync(tmpFile, { force: true });
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

function extractArchive(archivePath) {
  const sevenZip = resolve7zaPath();
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`[setup-mingit] Extracting MinGit archive with 7zip-bin: ${archivePath}`);
  const result = spawnSync(sevenZip, ['x', archivePath, `-o${OUTPUT_DIR}`, '-y'], {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`7zip extraction failed with exit code ${result.status}`);
  }
}

function isExpectedMinGitPrepared() {
  try {
    return (
      fs.readFileSync(VERSION_MARKER_PATH, 'utf8').trim() === MINGIT_VERSION &&
      validatePreparedMinGit().ok
    );
  } catch {
    return false;
  }
}

async function resolveArchive(required) {
  const envArchive = resolveInputPath(process.env.JUSTDO_PORTABLE_GIT_ARCHIVE);
  if (envArchive) {
    if (!isNonEmptyFile(envArchive)) {
      throw new Error(`JUSTDO_PORTABLE_GIT_ARCHIVE points to an invalid file: ${envArchive}`);
    }
    await assertExpectedArchiveChecksum(envArchive);
    console.log(
      `[setup-mingit] Using local archive from JUSTDO_PORTABLE_GIT_ARCHIVE: ${envArchive}`,
    );
    return { archivePath: envArchive, source: 'env-archive' };
  }

  if (isNonEmptyFile(DEFAULT_ARCHIVE_PATH)) {
    try {
      await assertExpectedArchiveChecksum(DEFAULT_ARCHIVE_PATH);
      console.log(`[setup-mingit] Using verified cached archive: ${DEFAULT_ARCHIVE_PATH}`);
      return { archivePath: DEFAULT_ARCHIVE_PATH, source: 'cache' };
    } catch (error) {
      console.warn(
        `[setup-mingit] Discarding invalid cached archive: ${error instanceof Error ? error.message : String(error)}`,
      );
      fs.rmSync(DEFAULT_ARCHIVE_PATH, { force: true });
    }
  }

  const urlFromEnv =
    typeof process.env.JUSTDO_PORTABLE_GIT_URL === 'string'
      ? process.env.JUSTDO_PORTABLE_GIT_URL.trim()
      : '';
  const downloadUrl = urlFromEnv || DEFAULT_MINGIT_URL;

  try {
    console.log(`[setup-mingit] Downloading MinGit from: ${downloadUrl}`);
    await downloadArchive(downloadUrl, DEFAULT_ARCHIVE_PATH);
    try {
      await assertExpectedArchiveChecksum(DEFAULT_ARCHIVE_PATH);
    } catch (error) {
      fs.rmSync(DEFAULT_ARCHIVE_PATH, { force: true });
      throw error;
    }
    const fileSizeMB = (fs.statSync(DEFAULT_ARCHIVE_PATH).size / 1024 / 1024).toFixed(1);
    console.log(`[setup-mingit] Downloaded archive (${fileSizeMB} MB): ${DEFAULT_ARCHIVE_PATH}`);
    return { archivePath: DEFAULT_ARCHIVE_PATH, source: 'download' };
  } catch (error) {
    if (required) {
      throw new Error(
        'Unable to obtain MinGit archive. ' +
          'Set JUSTDO_PORTABLE_GIT_ARCHIVE to a local offline package or ' +
          'set JUSTDO_PORTABLE_GIT_URL to a reachable mirror. ' +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    console.warn(
      '[setup-mingit] MinGit archive is not available; skip because --required is not set. ' +
        `Reason: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function ensurePortableGit(options = {}) {
  const required = Boolean(options.required);
  const shouldRun =
    process.platform === 'win32' || required || process.env.JUSTDO_SETUP_MINGIT_FORCE === '1';

  if (!shouldRun) {
    console.log(
      '[setup-mingit] Skip on non-Windows host (pass --required to force cross-platform preparation).',
    );
    return { ok: true, skipped: true, gitPath: null };
  }

  const existingGit = findMinGitExecutable();
  if (isExpectedMinGitPrepared() && existingGit) {
    console.log(`[setup-mingit] MinGit ${MINGIT_VERSION} already prepared: ${existingGit}`);
    return { ok: true, skipped: false, gitPath: existingGit };
  }

  const archive = await resolveArchive(required);
  if (!archive) {
    return { ok: true, skipped: true, gitPath: null };
  }

  extractArchive(archive.archivePath);
  const validation = validatePreparedMinGit();
  if (!validation.ok || !validation.gitPath) {
    fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    throw new Error(`MinGit extraction validation failed: ${validation.reason}`);
  }
  const resolvedGit = validation.gitPath;

  fs.writeFileSync(VERSION_MARKER_PATH, `${MINGIT_VERSION}\n`, 'utf8');

  const finalSize = getDirSize(OUTPUT_DIR);
  console.log(`[setup-mingit] MinGit ${MINGIT_VERSION} ready: ${resolvedGit}`);
  console.log(`[setup-mingit] Total size: ~${(finalSize / 1024 / 1024).toFixed(1)} MB`);

  return { ok: true, skipped: false, gitPath: resolvedGit };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensurePortableGit({ required: args.required });
}

if (require.main === module) {
  main().catch(error => {
    console.error('[setup-mingit] ERROR:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  ensurePortableGit,
  findMinGitExecutable,
  validatePreparedMinGit,
};
