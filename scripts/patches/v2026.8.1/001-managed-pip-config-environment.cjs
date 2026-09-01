'use strict';

// Capability: pass only JustDo-proven pip config and Python user-base values to child tools.
// Target: pristine openclaw@2026.8.1, whose host sanitizer blocks both environment variables.
// Scope: keeps the native deny-list and restores PIP_CONFIG_FILE/PYTHONUSERBASE only when each
// app-owned provenance value exactly matches the corresponding requested value.
// Safety: untrusted overrides remain blocked and both provenance tokens are removed from child env.
// Remove when: OpenClaw provides a trusted, value-bound allow-list for managed Python settings.

const fs = require('fs');
const path = require('path');
const {
  assertSingleFile,
  countOccurrences,
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  runtimeJavaScriptFiles,
  writeIfChanged,
} = require('./_patch-utils.js');

const PIP_PROVENANCE_ENV = 'JUSTDO_MANAGED_PIP_CONFIG_FILE';
const PYTHON_USER_BASE_PROVENANCE_ENV = 'JUSTDO_MANAGED_PYTHON_USER_BASE';
const CAPTURE_MARKER = 'JUSTDO_V2026_8_1_MANAGED_PIP_CONFIG_CAPTURE';
const RESTORE_MARKER = 'JUSTDO_V2026_8_1_MANAGED_PIP_CONFIG_RESTORE';
const PIP_BLOCKED_ENTRY = /^([ \t]*)"PIP_CONFIG_FILE",\r?$/m;
const PYTHON_USER_BASE_BLOCKED_ENTRY = /^([ \t]*)"PYTHONUSERBASE",\r?$/m;

function resolveJustDoManagedPipConfigFile(baseEnv) {
  if (!baseEnv || !Object.prototype.hasOwnProperty.call(baseEnv, 'PIP_CONFIG_FILE')) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(baseEnv, 'JUSTDO_MANAGED_PIP_CONFIG_FILE')) {
    return undefined;
  }
  const pipConfigFile = baseEnv?.PIP_CONFIG_FILE;
  const managedPipConfigFile = baseEnv?.JUSTDO_MANAGED_PIP_CONFIG_FILE;
  if (typeof pipConfigFile !== 'string' || pipConfigFile.length === 0) return undefined;
  return pipConfigFile === managedPipConfigFile ? pipConfigFile : undefined;
}

function resolveJustDoManagedPythonUserBase(baseEnv) {
  if (!baseEnv || !Object.prototype.hasOwnProperty.call(baseEnv, 'PYTHONUSERBASE')) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(baseEnv, 'JUSTDO_MANAGED_PYTHON_USER_BASE')) {
    return undefined;
  }
  const pythonUserBase = baseEnv?.PYTHONUSERBASE;
  const managedPythonUserBase = baseEnv?.JUSTDO_MANAGED_PYTHON_USER_BASE;
  if (typeof pythonUserBase !== 'string' || pythonUserBase.length === 0) return undefined;
  return pythonUserBase === managedPythonUserBase ? pythonUserBase : undefined;
}

function applyPatch(runtimeDir) {
  const runtimeFiles = runtimeJavaScriptFiles(runtimeDir, { includeBundle: false });
  const hasPatchState = runtimeFiles.some(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    return (
      content.includes(CAPTURE_MARKER) ||
      content.includes(RESTORE_MARKER) ||
      content.includes('function resolveJustDoManagedPipConfigFile(') ||
      content.includes('function resolveJustDoManagedPythonUserBase(')
    );
  });
  if (hasPatchState) {
    verifyPatch(runtimeDir);
    return [];
  }

  const candidates = findFilesContaining(
    runtimeDir,
    [
      'function sanitizeHostExecEnvWithDiagnostics(params) {',
      'const baseEnv = params?.baseEnv ?? process.env;',
      'env: markOpenClawExecEnv(merged)',
    ],
    { includeBundle: false },
  ).filter(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    return PIP_BLOCKED_ENTRY.test(content) && PYTHON_USER_BASE_BLOCKED_ENTRY.test(content);
  });
  const filePath = assertSingleFile(candidates, 'managed Python host environment sanitizer');
  const original = fs.readFileSync(filePath, 'utf8');
  let updated = replaceUnique(
    original,
    'function sanitizeHostExecEnvWithDiagnostics(params) {',
    `${resolveJustDoManagedPipConfigFile.toString()}\n${resolveJustDoManagedPythonUserBase.toString()}\nfunction sanitizeHostExecEnvWithDiagnostics(params) {`,
    'managed Python resolver insertion',
  );
  updated = replaceUniquePattern(
    updated,
    /(\tconst baseEnv = params\?\.baseEnv \?\? process\.env;\r?\n)/,
    `$1\t// ${CAPTURE_MARKER}: capture only app-proven exact values before native filtering.\n\tconst justDoManagedPipConfigFile = resolveJustDoManagedPipConfigFile(baseEnv);\n\tconst justDoManagedPythonUserBase = resolveJustDoManagedPythonUserBase(baseEnv);\n`,
    'managed Python provenance capture',
  );
  updated = replaceUniquePattern(
    updated,
    /(\treturn \{\r?\n\t\tenv: markOpenClawExecEnv\(merged\),)/,
    `\tif (justDoManagedPipConfigFile !== void 0) merged.PIP_CONFIG_FILE = justDoManagedPipConfigFile;\n\tif (justDoManagedPythonUserBase !== void 0) merged.PYTHONUSERBASE = justDoManagedPythonUserBase;\n\tfor (const key of Object.keys(merged)) {\n\t\tconst upperKey = key.toUpperCase();\n\t\tif (upperKey === "${PIP_PROVENANCE_ENV}" || upperKey === "${PYTHON_USER_BASE_PROVENANCE_ENV}") delete merged[key];\n\t}\n\t// ${RESTORE_MARKER}: overrides remain blocked; do not propagate provenance tokens.\n$1`,
    'managed Python trusted restore',
  );
  writeIfChanged(filePath, original, updated);
  verifyPatch(runtimeDir);
  return [path.relative(runtimeDir, filePath)];
}

function verifyPatch(runtimeDir) {
  const sourceCandidates = findFilesContaining(
    runtimeDir,
    [
      'function sanitizeHostExecEnvWithDiagnostics(params) {',
      'function resolveJustDoManagedPipConfigFile(',
      'function resolveJustDoManagedPythonUserBase(',
      CAPTURE_MARKER,
      RESTORE_MARKER,
    ],
    { includeBundle: false },
  );
  const filePath = assertSingleFile(
    sourceCandidates,
    'patched managed Python host environment sanitizer',
  );
  const content = fs.readFileSync(filePath, 'utf8');
  for (const marker of [CAPTURE_MARKER, RESTORE_MARKER]) {
    if (countOccurrences(content, marker) !== 1) {
      throw new Error(`Managed Python marker ${marker} must occur exactly once`);
    }
  }
  if (!PIP_BLOCKED_ENTRY.test(content) || !PYTHON_USER_BASE_BLOCKED_ENTRY.test(content)) {
    throw new Error('Native PIP_CONFIG_FILE/PYTHONUSERBASE deny-list entries must remain intact');
  }
  for (const contract of [
    'pipConfigFile === managedPipConfigFile',
    'pythonUserBase === managedPythonUserBase',
    'merged.PIP_CONFIG_FILE = justDoManagedPipConfigFile',
    'merged.PYTHONUSERBASE = justDoManagedPythonUserBase',
    `upperKey === "${PIP_PROVENANCE_ENV}"`,
    `upperKey === "${PYTHON_USER_BASE_PROVENANCE_ENV}"`,
    'env: markOpenClawExecEnv(merged)',
  ]) {
    if (!content.includes(contract))
      throw new Error(`Managed pip contract is missing: ${contract}`);
  }
  if (fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'))) {
    const bundleContent = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    if (
      !PIP_BLOCKED_ENTRY.test(bundleContent) ||
      !PYTHON_USER_BASE_BLOCKED_ENTRY.test(bundleContent)
    ) {
      throw new Error(
        'Bundled native PIP_CONFIG_FILE/PYTHONUSERBASE deny-list entries must remain intact',
      );
    }
    const bundleCandidates = findFilesContaining(runtimeDir, [
      'function resolveJustDoManagedPipConfigFile(',
      'function resolveJustDoManagedPythonUserBase(',
      'pipConfigFile === managedPipConfigFile',
      'pythonUserBase === managedPythonUserBase',
      'merged.PIP_CONFIG_FILE = justDoManagedPipConfigFile',
      'merged.PYTHONUSERBASE = justDoManagedPythonUserBase',
      `upperKey === "${PIP_PROVENANCE_ENV}"`,
      `upperKey === "${PYTHON_USER_BASE_PROVENANCE_ENV}"`,
    ]).filter(candidate => candidate.endsWith('gateway-bundle.mjs'));
    assertSingleFile(bundleCandidates, 'bundled managed Python host environment sanitizer');
  }
  return true;
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { resolveJustDoManagedPipConfigFile, resolveJustDoManagedPythonUserBase },
};
