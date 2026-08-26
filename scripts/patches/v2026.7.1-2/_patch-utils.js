'use strict';

const fs = require('fs');
const path = require('path');

let activeRuntimePhase = null;
const atomicRenameWaitArray = new Int32Array(new SharedArrayBuffer(4));

function normalizeFilePath(filePath) {
  return path.resolve(filePath);
}

function isRuntimeJavaScriptFile(runtimeDir, filePath) {
  const normalizedRuntimeDir = normalizeFilePath(runtimeDir);
  const normalizedFilePath = normalizeFilePath(filePath);
  const relativePath = path.relative(normalizedRuntimeDir, normalizedFilePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return false;
  if (relativePath === 'gateway-bundle.mjs') return true;
  return relativePath.startsWith(`dist${path.sep}`) && /\.[cm]?js$/.test(normalizedFilePath);
}

function beginRuntimePatchPhase(runtimeDir, snapshot) {
  if (activeRuntimePhase) {
    throw new Error(`A runtime patch phase is already active for ${activeRuntimePhase.runtimeDir}`);
  }

  const normalizedRuntimeDir = normalizeFilePath(runtimeDir);
  const files = [];
  const bytesByFile = new Map();
  for (const [filePath, bytes] of snapshot || []) {
    const normalizedFilePath = normalizeFilePath(filePath);
    if (!isRuntimeJavaScriptFile(normalizedRuntimeDir, normalizedFilePath)) continue;
    files.push(normalizedFilePath);
    bytesByFile.set(normalizedFilePath, bytes);
  }

  activeRuntimePhase = {
    runtimeDir: normalizedRuntimeDir,
    files: files.sort(),
    fileSet: new Set(files),
    bytesByFile,
    contentByFile: new Map(),
    queryCache: new Map(),
    revision: 0,
    changeLog: [],
  };
}

function endRuntimePatchPhase(runtimeDir) {
  if (!activeRuntimePhase) return;
  const normalizedRuntimeDir = normalizeFilePath(runtimeDir);
  if (activeRuntimePhase.runtimeDir !== normalizedRuntimeDir) {
    throw new Error(
      `Cannot end runtime patch phase for ${normalizedRuntimeDir}; active phase is ${activeRuntimePhase.runtimeDir}`,
    );
  }
  activeRuntimePhase = null;
}

function getActiveRuntimePhase(runtimeDir) {
  if (!activeRuntimePhase) return null;
  return activeRuntimePhase.runtimeDir === normalizeFilePath(runtimeDir)
    ? activeRuntimePhase
    : null;
}

function readIndexedFile(filePath, phase) {
  const normalizedFilePath = normalizeFilePath(filePath);
  const cached = phase.contentByFile.get(normalizedFilePath);
  if (cached !== undefined) return cached;
  const bytes = phase.bytesByFile.get(normalizedFilePath);
  const content = bytes ? bytes.toString('utf8') : fs.readFileSync(normalizedFilePath, 'utf8');
  phase.contentByFile.set(normalizedFilePath, content);
  return content;
}

function readRuntimeTextFile(filePath) {
  const normalizedFilePath = normalizeFilePath(filePath);
  if (activeRuntimePhase?.fileSet.has(normalizedFilePath)) {
    return readIndexedFile(normalizedFilePath, activeRuntimePhase);
  }
  return fs.readFileSync(normalizedFilePath, 'utf8');
}

function updateActiveRuntimeFile(filePath, content) {
  if (!activeRuntimePhase) return;
  const normalizedFilePath = normalizeFilePath(filePath);
  if (!isRuntimeJavaScriptFile(activeRuntimePhase.runtimeDir, normalizedFilePath)) return;
  if (!activeRuntimePhase.fileSet.has(normalizedFilePath)) {
    activeRuntimePhase.fileSet.add(normalizedFilePath);
    activeRuntimePhase.files.push(normalizedFilePath);
    activeRuntimePhase.files.sort();
  }
  activeRuntimePhase.bytesByFile.delete(normalizedFilePath);
  activeRuntimePhase.contentByFile.set(normalizedFilePath, content);
  activeRuntimePhase.revision += 1;
  activeRuntimePhase.changeLog.push(normalizedFilePath);
}

function renameFileWithRetry(sourcePath, destinationPath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      const retryable =
        error &&
        typeof error === 'object' &&
        ['EACCES', 'EBUSY', 'EPERM'].includes(error.code) &&
        attempt < 5;
      if (!retryable) throw error;
      Atomics.wait(atomicRenameWaitArray, 0, 0, 10 * 2 ** attempt);
    }
  }
}

function listJavaScriptFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) files.push(candidate);
    }
  }
  return files.sort();
}

function runtimeJavaScriptFiles(runtimeDir, options = {}) {
  const phase = getActiveRuntimePhase(runtimeDir);
  if (phase) {
    return phase.files.filter(
      filePath =>
        options.includeBundle !== false || path.basename(filePath) !== 'gateway-bundle.mjs',
    );
  }
  const files = listJavaScriptFiles(path.join(runtimeDir, 'dist'));
  if (options.includeBundle !== false) {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    if (fs.existsSync(bundlePath)) files.push(bundlePath);
  }
  return files;
}

function findFilesContaining(runtimeDir, needles, options = {}) {
  const required = Array.isArray(needles) ? needles : [needles];
  const phase = getActiveRuntimePhase(runtimeDir);
  const files = runtimeJavaScriptFiles(runtimeDir, options);
  if (!phase) {
    return files.filter(filePath => {
      const content = fs.readFileSync(filePath, 'utf8');
      return required.every(needle => content.includes(needle));
    });
  }

  const queryKey = JSON.stringify([options.includeBundle !== false, required]);
  const cachedQuery = phase.queryCache.get(queryKey);
  if (cachedQuery) {
    const changedFiles = new Set(phase.changeLog.slice(cachedQuery.revision));
    for (const filePath of changedFiles) {
      if (!phase.fileSet.has(filePath)) {
        cachedQuery.matches.delete(filePath);
        continue;
      }
      if (options.includeBundle === false && path.basename(filePath) === 'gateway-bundle.mjs') {
        cachedQuery.matches.delete(filePath);
        continue;
      }
      const content = readIndexedFile(filePath, phase);
      if (required.every(needle => content.includes(needle))) cachedQuery.matches.add(filePath);
      else cachedQuery.matches.delete(filePath);
    }
    cachedQuery.revision = phase.revision;
    return files.filter(filePath => cachedQuery.matches.has(filePath));
  }

  const matches = new Set();
  for (const filePath of files) {
    const content = readIndexedFile(filePath, phase);
    if (required.every(needle => content.includes(needle))) matches.add(filePath);
  }
  phase.queryCache.set(queryKey, { matches, revision: phase.revision });
  return files.filter(filePath => matches.has(filePath));
}

function countOccurrences(content, value) {
  if (!value) throw new Error('Cannot count an empty patch anchor');
  return content.split(value).length - 1;
}

function stableFunctionSource(value) {
  if (typeof value !== 'function') throw new TypeError('Expected a function to serialize');
  return Function.prototype.toString.call(value).replace(/\r\n?/g, '\n');
}

function replaceUnique(content, anchor, replacement, description) {
  const count = countOccurrences(content, anchor);
  if (count !== 1) {
    throw new Error(`${description} anchor count is ${count}, expected 1`);
  }
  return content.replace(anchor, replacement);
}

function replaceUniquePattern(content, pattern, replacement, description) {
  const matches = [
    ...content.matchAll(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g')),
  ];
  if (matches.length !== 1) {
    throw new Error(`${description} anchor count is ${matches.length}, expected 1`);
  }
  return content.replace(pattern, replacement);
}

function writeIfChanged(filePath, original, updated) {
  if (updated === original) return false;
  const temporaryPath = `${filePath}.justdo-patch-${process.pid}`;
  fs.writeFileSync(temporaryPath, updated, 'utf8');
  renameFileWithRetry(temporaryPath, filePath);
  updateActiveRuntimeFile(filePath, updated);
  return true;
}

function replaceNamedFunction(content, functionName, replacement, description = functionName) {
  const signature = `function ${functionName}(`;
  const signatureIndex = content.indexOf(signature);
  if (signatureIndex < 0 || content.indexOf(signature, signatureIndex + signature.length) >= 0) {
    const count = countOccurrences(content, signature);
    throw new Error(`${description} function count is ${count}, expected 1`);
  }

  let replacementStart = signatureIndex;
  let prefixIndex = signatureIndex - 1;
  while (prefixIndex >= 0 && /\s/.test(content[prefixIndex])) prefixIndex -= 1;
  const asyncStart = prefixIndex - 'async'.length + 1;
  if (
    asyncStart >= 0 &&
    content.slice(asyncStart, prefixIndex + 1) === 'async' &&
    (asyncStart === 0 || !/[\w$]/.test(content[asyncStart - 1]))
  ) {
    replacementStart = asyncStart;
  }

  const parametersStart = signatureIndex + signature.length - 1;
  const parametersEnd = findMatchingDelimiter(
    content,
    parametersStart,
    '(',
    ')',
    `${description} function parameters`,
  );
  let bodyStart = parametersEnd + 1;
  while (bodyStart < content.length && /\s/.test(content[bodyStart])) bodyStart += 1;
  if (content[bodyStart] !== '{') throw new Error(`${description} function body was not found`);
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${description} function body`,
  );
  return content.slice(0, replacementStart) + replacement + content.slice(bodyEnd + 1);
}

function findMatchingDelimiter(content, start, opening, closing, description) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === '\n' || character === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    else if (character === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`${description} closing delimiter was not found`);
}

function assertSingleFile(files, description) {
  if (files.length !== 1) {
    throw new Error(`${description} target count is ${files.length}, expected 1`);
  }
  return files[0];
}

module.exports = {
  assertSingleFile,
  beginRuntimePatchPhase,
  countOccurrences,
  endRuntimePatchPhase,
  findFilesContaining,
  listJavaScriptFiles,
  replaceUnique,
  replaceUniquePattern,
  replaceNamedFunction,
  readRuntimeTextFile,
  runtimeJavaScriptFiles,
  stableFunctionSource,
  writeIfChanged,
};
