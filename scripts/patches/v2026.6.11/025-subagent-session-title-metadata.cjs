'use strict';

// Purpose: Project durable subagent task naming metadata through sessions.list
// so retained history uses the same title authority as the live subagent registry.
// Affected OpenClaw version: v2026.6.11.
// Risk: Adds optional taskName/task fields and a registry-backed label fallback
// to subagent rows returned by the Gateway sessions.list RPC.
// Remove when: OpenClaw natively projects durable subagent task naming metadata
// on sessions.list rows.
// Upstream tracking: TODO(openclaw): propose subagent naming metadata on sessions.list.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'JUSTDO_SUBAGENT_SESSION_TITLE_METADATA_V1';
const REQUIRED_TASK_VALIDATION =
  'const task = readStringParam(params, "task", { required: true });';

const ORIGINAL_ROW_FIELDS = `    kind: classifySessionKey(key, entry),
    label: entry?.label,
    displayName,`;

const PATCHED_ROW_FIELDS = `    kind: classifySessionKey(key, entry),
    // ${PATCH_MARKER}
    ...subagentRun?.taskName ? { taskName: subagentRun.taskName } : {},
    ...subagentRun?.task ? { task: subagentRun.task } : {},
    label: entry?.label ?? subagentRun?.label,
    displayName,`;

function applyPatch(runtimeDir, options = {}) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  if (!fs.existsSync(filePath)) return [];
  const original = fs.readFileSync(filePath, 'utf8');
  if (original.includes(PATCH_MARKER)) return [];
  if (!original.includes(ORIGINAL_ROW_FIELDS)) {
    throw new Error(`Subagent session title metadata patch target not found: ${filePath}`);
  }
  const content = original.replace(ORIGINAL_ROW_FIELDS, PATCHED_ROW_FIELDS);
  fs.writeFileSync(filePath, content, 'utf8');
  const label = options.label || 'patch-openclaw-subagent-session-title-metadata';
  console.log(`[${label}] Patched subagent sessions.list title metadata: gateway-bundle.mjs`);
  return ['gateway-bundle.mjs'];
}

function verifyPatch(runtimeDir) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const content = fs.readFileSync(filePath, 'utf8');
  const required = [
    PATCH_MARKER,
    '...subagentRun?.taskName ? { taskName: subagentRun.taskName } : {},',
    '...subagentRun?.task ? { task: subagentRun.task } : {},',
    'label: entry?.label ?? subagentRun?.label,',
    REQUIRED_TASK_VALIDATION,
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) {
    throw new Error(`Subagent session title metadata patch is incomplete: ${missing.join(', ')}`);
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
