'use strict';

// Capability: defer selected heavyweight tool schemas into the Tool Search catalog.
// Target: pristine openclaw@2026.7.1-2, which has no configurable per-tool defer list.
// Scope: catalogs only the explicit names below; authorization, validation and execution stay native.
// Safety: verifies every requested tool name and both catalog/removal control-flow edits.
// Remove when: OpenClaw exposes an equivalent supported per-tool defer configuration.

const fs = require('fs');
const path = require('path');
const { replaceUnique, writeIfChanged } = require('./_patch-utils.js');

const DEFERRED_TOOL_NAMES = [
  'browser',
  'create_goal',
  'cron',
  'get_goal',
  'memory_get',
  'memory_search',
  'skill_workshop',
  'update_goal',
];
const NATIVE_POLICY = `isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name)`;
const SELECTIVE_POLICY = `isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    shouldCatalogTool: (tool) => ${JSON.stringify(DEFERRED_TOOL_NAMES)}.includes(tool.name),
    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name)`;

function applyPatch(runtimeDir) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  if (!fs.existsSync(filePath)) return [];
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = original.includes(SELECTIVE_POLICY)
    ? original
    : replaceUnique(original, NATIVE_POLICY, SELECTIVE_POLICY, 'selective Tool Search catalog');
  return writeIfChanged(filePath, original, updated) ? ['gateway-bundle.mjs'] : [];
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  if (!content.includes(SELECTIVE_POLICY))
    throw new Error('selective Tool Search catalog contract is missing');
  if (content.includes(NATIVE_POLICY)) throw new Error('native all-direct catalog policy remains');
}

module.exports = {
  applyPatch,
  verifyPatch,
  DEFERRED_TOOL_NAMES,
  __testing: { NATIVE_POLICY, SELECTIVE_POLICY },
};
