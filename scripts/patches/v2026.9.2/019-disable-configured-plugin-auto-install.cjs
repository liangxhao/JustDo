'use strict';

// Capability: prevent provider/channel configuration from downloading or repairing plugins.
// Target: openclaw@2026.9.2 configured-plugin repair lifecycle.
// Scope: automatic startup/Doctor/update repair only; explicit plugin install/update remains available.
// Safety: preserve the discovered install records while returning no package-manager changes.
// Remove when: upstream exposes a host policy that disables configured-plugin package repair.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  normalizeJustDoGatewayBundle,
  replaceNamedFunction,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_DISABLE_CONFIGURED_PLUGIN_AUTO_INSTALL_V2026_9_2';
const PATCH_MARKER_PATTERN = /JUSTDO_DISABLE_CONFIGURED_PLUGIN_AUTO_INSTALL_V\d+_\d+_\d+/gu;
const FUNCTION_NAME = 'repairMissingPluginInstallsWithLease';
const CURRENT_RETURN_PATTERN =
  /return\s*\{\s*changes\s*:\s*\[\s*\]\s*,\s*warnings\s*:\s*\[\s*\]\s*,\s*records\s*:\s*persistedRecords\d*\s*\}\s*;/gu;
const LEGACY_RETURN_PATTERN =
  /return\s*\{\s*changes\s*:\s*\[\s*\]\s*,\s*warnings\s*:\s*\[\s*\]\s*,\s*records\s*\}\s*;/gu;

function replacementSource(
  includeMarker,
  persistenceFunctionName = 'writePersistedInstalledPluginIndexInstallRecords',
) {
  return [
    `async function ${FUNCTION_NAME}(params) {`,
    '  const env = params.env ?? process.env;',
    '  const { persistedRecords } = await resolveConfiguredPluginInstallContext({',
    '    cfg: params.cfg,',
    '    env,',
    '    configuredPluginIds: params.pluginIds,',
    '    configuredChannelIds: params.channelIds,',
    '    blockedPluginIds: params.blockedPluginIds,',
    '    baselineRecords: params.baselineRecords',
    '  });',
    '  if (params.baselineRecords) {',
    '    await params.beforePersistentEffect?.();',
    `    await ${persistenceFunctionName}(persistedRecords, {`,
    '      config: params.cfg,',
    '      env',
    '    });',
    '  }',
    `  return { changes: [], warnings: [], records: persistedRecords };${includeMarker ? `/*${MARKER}*/` : ''}`,
    '}',
  ].join('\n');
}

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    `async function ${FUNCTION_NAME}(`,
    'resolveConfiguredPluginInstallContext',
  ]);
}

function assertTargetShape(runtimeDir, files) {
  const bundleTargets = files.filter(isGatewayBundlePath);
  const sourceTargets = files.filter(filePath => !isGatewayBundlePath(filePath));
  const bundleExists = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'));
  if (bundleTargets.length !== (bundleExists ? 1 : 0)) {
    throw new Error(
      `configured plugin auto-install bundle target count is ${bundleTargets.length}, expected ${bundleExists ? 1 : 0}`,
    );
  }
  // The pristine package carries this lifecycle in both the shared command
  // chunk and the worker bundle. The final pruned runtime keeps only the
  // root Gateway bundle.
  const expectedSourceCount = bundleExists && sourceTargets.length === 0 ? 0 : 2;
  if (sourceTargets.length !== expectedSourceCount) {
    throw new Error(
      `configured plugin auto-install source target count is ${sourceTargets.length}, expected ${expectedSourceCount}`,
    );
  }
}

function findTargetFunctionSource(content, filePath) {
  const signature = `async function ${FUNCTION_NAME}(`;
  const signatureCount = countOccurrences(content, signature);
  if (signatureCount !== 1) {
    throw new Error(
      `${filePath}: configured plugin repair function count is ${signatureCount}, expected 1`,
    );
  }
  const functionStart = content.indexOf(signature);
  const parametersStart = functionStart + signature.length - 1;
  const parametersEnd = findMatchingDelimiter(
    content,
    parametersStart,
    '(',
    ')',
    `${filePath}: configured plugin repair parameters`,
  );
  let bodyStart = parametersEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: configured plugin repair body`,
  );
  return content.slice(functionStart, bodyEnd + 1);
}

function replaceIdentifier(content, source, replacement) {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'gu'), replacement);
}

function normalizeExpandedObjectShorthand(content, identifier) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(
    new RegExp(`(?<![\\w$])${escaped}\\s*:\\s*${escaped}(?![\\w$])`, 'gu'),
    identifier,
  );
}

function isCanonicalGatewayFunction(functionSource, persistenceFunctionName) {
  const envMatch = functionSource.match(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*params\.env\s*\?\?\s*process\.env/u,
  );
  const recordsMatch = functionSource.match(
    /const\s*\{\s*persistedRecords(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*\}\s*=/u,
  );
  if (!envMatch || !recordsMatch) return false;
  let canonical = functionSource;
  canonical = replaceIdentifier(canonical, envMatch[1], 'env');
  canonical = replaceIdentifier(
    canonical,
    recordsMatch[1] ?? 'persistedRecords',
    'persistedRecords',
  );
  canonical = replaceIdentifier(
    canonical,
    persistenceFunctionName,
    'writePersistedInstalledPluginIndexInstallRecords',
  );
  // esbuild expands object shorthand when it renames a colliding local, for
  // example `env` becomes `env: env4`. Treat that output as the same contract.
  canonical = normalizeExpandedObjectShorthand(canonical, 'env');
  canonical = normalizeExpandedObjectShorthand(canonical, 'persistedRecords');
  return (
    normalizeJustDoGatewayBundle(canonical) ===
    normalizeJustDoGatewayBundle(replacementSource(false))
  );
}

function transform(content, filePath) {
  const functionSource = findTargetFunctionSource(content, filePath);
  const persistenceFunctionMatches = [
    ...functionSource.matchAll(/\b(writePersistedInstalledPluginIndexInstallRecords\d*)\s*\(/gu),
  ];
  const persistenceFunctionName = persistenceFunctionMatches[0]?.[1];
  const markerCount = countOccurrences(functionSource, MARKER);
  const totalMarkerCount = countOccurrences(content, MARKER);
  const historicalMarkerCount = [...content.matchAll(PATCH_MARKER_PATTERN)].filter(
    match => match[0] !== MARKER,
  ).length;
  const currentReturnCount = [...functionSource.matchAll(CURRENT_RETURN_PATTERN)].length;
  const legacyReturnCount = [...functionSource.matchAll(LEGACY_RETURN_PATTERN)].length;
  const gatewayBundle = isGatewayBundlePath(filePath);

  if (gatewayBundle && markerCount === 1 && totalMarkerCount === 1 && historicalMarkerCount === 0) {
    const normalized = content.replace(`/*${MARKER}*/`, '');
    const normalizedFunction = findTargetFunctionSource(normalized, filePath);
    if (
      persistenceFunctionName &&
      isCanonicalGatewayFunction(normalizedFunction, persistenceFunctionName)
    ) {
      return normalized;
    }
  }
  if (
    !gatewayBundle &&
    persistenceFunctionName &&
    functionSource === replacementSource(true, persistenceFunctionName) &&
    totalMarkerCount === 1 &&
    historicalMarkerCount === 0
  ) {
    return content;
  }
  if (
    gatewayBundle &&
    persistenceFunctionName &&
    markerCount === 0 &&
    totalMarkerCount === 0 &&
    historicalMarkerCount === 0 &&
    isCanonicalGatewayFunction(functionSource, persistenceFunctionName)
  ) {
    return content;
  }
  if (
    currentReturnCount > 0 ||
    legacyReturnCount > 0 ||
    markerCount > 0 ||
    totalMarkerCount > 0 ||
    historicalMarkerCount > 0
  ) {
    throw new Error(
      `${filePath}: historical or partial configured plugin auto-install patch detected`,
    );
  }
  if (persistenceFunctionMatches.length !== 1) {
    throw new Error(
      `${filePath}: configured plugin install-record writer count is ${persistenceFunctionMatches.length}, expected 1`,
    );
  }

  return replaceNamedFunction(
    content,
    FUNCTION_NAME,
    replacementSource(!gatewayBundle, persistenceFunctionName),
    'configured plugin auto-install repair',
  );
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  assertTargetShape(runtimeDir, files);
  const changed = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transform(original, filePath);
    if (writeIfChanged(filePath, original, updated)) {
      changed.push(path.relative(runtimeDir, filePath));
    }
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  assertTargetShape(runtimeDir, files);
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (transform(content, filePath) !== content) {
      throw new Error(`${filePath}: configured plugin auto-install guard is missing`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { MARKER, replacementSource, transform },
};
