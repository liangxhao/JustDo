'use strict';

// Purpose: Keep selected heavyweight native tool schemas behind OpenClaw's
// directory-mode Tool Search catalog while leaving all other tools direct.
// Affected OpenClaw version: v2026.6.11.
// Risk: A renamed selected tool would remain direct until this patch is updated.
// Remove when: OpenClaw exposes a supported per-tool Tool Search defer list.
// Upstream tracking: TODO(openclaw): request configurable selective cataloging.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const DEFERRED_TOOL_NAMES = [
  'browser',
  'create_goal',
  'cron',
  'get_goal',
  'memory_get',
  'memory_search',
  'update_goal',
];

const ORIGINAL_CATALOG_PREDICATE = `    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name)`;

const PATCHED_CATALOG_PREDICATE = `    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    shouldCatalogTool: (tool) => ${JSON.stringify(DEFERRED_TOOL_NAMES)}.includes(tool.name),
    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name)`;

const LEGACY_PATCHED_CATALOG_PREDICATE = `    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    shouldCatalogTool: (tool) => tool.name === "cron",
    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name)`;

const PREVIOUS_PATCHED_CATALOG_PREDICATE = `    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    shouldCatalogTool: (tool) => ["cron"].includes(tool.name),
    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name)`;

const PRIOR_SELECTED_PATCHED_CATALOG_PREDICATE = `    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    shouldCatalogTool: (tool) => ["browser","cron"].includes(tool.name),
    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name)`;

const PRIOR_GOAL_PATCHED_CATALOG_PREDICATE = `    isVisibleControlTool: (tool) => TOOL_SCHEMA_DIRECTORY_CONTROL_TOOL_NAMES.has(tool.name),
    shouldCatalogTool: (tool) => ["browser","create_goal","cron","get_goal","update_goal"].includes(tool.name),
    isVisibleCatalogTool: (tool) => hydrateToolNames.has(tool.name) && uniqueCatalogToolNames.has(tool.name)`;

function patchFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(PATCHED_CATALOG_PREDICATE)) return false;
  const patchTarget = content.includes(PRIOR_GOAL_PATCHED_CATALOG_PREDICATE)
    ? PRIOR_GOAL_PATCHED_CATALOG_PREDICATE
    : content.includes(PRIOR_SELECTED_PATCHED_CATALOG_PREDICATE)
      ? PRIOR_SELECTED_PATCHED_CATALOG_PREDICATE
      : content.includes(PREVIOUS_PATCHED_CATALOG_PREDICATE)
        ? PREVIOUS_PATCHED_CATALOG_PREDICATE
        : content.includes(LEGACY_PATCHED_CATALOG_PREDICATE)
          ? LEGACY_PATCHED_CATALOG_PREDICATE
          : ORIGINAL_CATALOG_PREDICATE;
  if (!content.includes(patchTarget)) {
    throw new Error(`OpenClaw selective Tool Search patch target not found: ${filePath}`);
  }
  fs.writeFileSync(filePath, content.replace(patchTarget, PATCHED_CATALOG_PREDICATE), 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-defer-selected-tool-schemas';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring tool schema patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Patched Tool Search with the selected deferred tool schemas.`);
  } else if (options.verbose) {
    console.log(`[${label}] Selective Tool Search patch already applied.`);
  }
  return patched;
}

module.exports = { applyPatch, DEFERRED_TOOL_NAMES };
