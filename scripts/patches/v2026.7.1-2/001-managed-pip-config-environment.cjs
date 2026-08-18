'use strict';

// Capability: allow only the exact PIP_CONFIG_FILE installed by JustDo to reach child tools.
// Target: pristine openclaw@2026.7.1-2, whose host environment sanitizer blocks the variable.
// Scope: keeps the native deny-list and restores PIP_CONFIG_FILE only when the app-owned
// JUSTDO_MANAGED_PIP_CONFIG_FILE provenance value exactly matches the requested file.
// Safety: untrusted overrides remain blocked and the provenance token is removed from child env.
// Remove when: OpenClaw provides a trusted, path-bound allow-list for managed pip configuration.

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

const PROVENANCE_ENV = 'JUSTDO_MANAGED_PIP_CONFIG_FILE';
const CAPTURE_MARKER = 'JUSTDO_V2026_7_1_2_MANAGED_PIP_CONFIG_CAPTURE';
const RESTORE_MARKER = 'JUSTDO_V2026_7_1_2_MANAGED_PIP_CONFIG_RESTORE';
const BLOCKED_ENTRY = /^([ \t]*)"PIP_CONFIG_FILE",\r?$/m;

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

function applyPatch(runtimeDir) {
  const runtimeFiles = runtimeJavaScriptFiles(runtimeDir, { includeBundle: false });
  const hasPatchState = runtimeFiles.some(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    return (
      content.includes(CAPTURE_MARKER) ||
      content.includes(RESTORE_MARKER) ||
      content.includes('function resolveJustDoManagedPipConfigFile(')
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
  ).filter(filePath => BLOCKED_ENTRY.test(fs.readFileSync(filePath, 'utf8')));
  const filePath = assertSingleFile(candidates, 'managed pip host environment sanitizer');
  const original = fs.readFileSync(filePath, 'utf8');
  let updated = replaceUnique(
    original,
    'function sanitizeHostExecEnvWithDiagnostics(params) {',
    `${resolveJustDoManagedPipConfigFile.toString()}\nfunction sanitizeHostExecEnvWithDiagnostics(params) {`,
    'managed pip resolver insertion',
  );
  updated = replaceUniquePattern(
    updated,
    /(\tconst baseEnv = params\?\.baseEnv \?\? process\.env;\r?\n)/,
    `$1\t// ${CAPTURE_MARKER}: capture only the app-proven exact value before native filtering.\n\tconst justDoManagedPipConfigFile = resolveJustDoManagedPipConfigFile(baseEnv);\n`,
    'managed pip provenance capture',
  );
  updated = replaceUniquePattern(
    updated,
    /(\treturn \{\r?\n\t\tenv: markOpenClawExecEnv\(merged\),)/,
    `\tif (justDoManagedPipConfigFile !== void 0) merged.PIP_CONFIG_FILE = justDoManagedPipConfigFile;\n\tfor (const key of Object.keys(merged)) {\n\t\tif (key.toUpperCase() === "${PROVENANCE_ENV}") delete merged[key];\n\t}\n\t// ${RESTORE_MARKER}: overrides remain blocked; do not propagate the provenance token.\n$1`,
    'managed pip trusted restore',
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
      CAPTURE_MARKER,
      RESTORE_MARKER,
    ],
    { includeBundle: false },
  );
  const filePath = assertSingleFile(
    sourceCandidates,
    'patched managed pip host environment sanitizer',
  );
  const content = fs.readFileSync(filePath, 'utf8');
  for (const marker of [CAPTURE_MARKER, RESTORE_MARKER]) {
    if (countOccurrences(content, marker) !== 1) {
      throw new Error(`Managed pip marker ${marker} must occur exactly once`);
    }
  }
  if (!BLOCKED_ENTRY.test(content)) {
    throw new Error('Native PIP_CONFIG_FILE deny-list entry must remain intact');
  }
  for (const contract of [
    'pipConfigFile === managedPipConfigFile',
    'merged.PIP_CONFIG_FILE = justDoManagedPipConfigFile',
    `key.toUpperCase() === "${PROVENANCE_ENV}"`,
    'env: markOpenClawExecEnv(merged)',
  ]) {
    if (!content.includes(contract))
      throw new Error(`Managed pip contract is missing: ${contract}`);
  }
  if (fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'))) {
    const bundleCandidates = findFilesContaining(runtimeDir, [
      'function resolveJustDoManagedPipConfigFile(',
      'pipConfigFile === managedPipConfigFile',
      'merged.PIP_CONFIG_FILE = justDoManagedPipConfigFile',
      `key.toUpperCase() === "${PROVENANCE_ENV}"`,
    ]).filter(candidate => candidate.endsWith('gateway-bundle.mjs'));
    assertSingleFile(bundleCandidates, 'bundled managed pip host environment sanitizer');
  }
  return true;
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { resolveJustDoManagedPipConfigFile },
};
