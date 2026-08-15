'use strict';

// Purpose: Expose a narrow Gateway RPC that clears session Goal metadata
// without adding an application lifecycle command to the model-visible chat history.
// Affected OpenClaw version: v2026.6.11.
// Risk: Adds one operator-admin Gateway method that mutates only the existing
// canonical session Goal field and emits the normal sessions-changed event.
// Remove when: OpenClaw exposes a native non-chat Goal clear RPC upstream.
// Upstream tracking: TODO(openclaw): propose a versioned Goal mutation API.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'JUSTDO_SILENT_GOAL_CLEAR_RPC_V1';

const ORIGINAL_METHOD_CATALOG = `      {
        name: "sessions.describe",
        scope: "operator.read"
      },
      {
        name: "sessions.compaction.list",`;

const PATCHED_METHOD_CATALOG = `      {
        name: "sessions.describe",
        scope: "operator.read"
      },
      {
        name: "sessions.goal.clear",
        scope: "operator.admin"
      },
      {
        name: "sessions.compaction.list",`;

const ORIGINAL_LAZY_METHODS = `          "sessions.describe",
          "sessions.resolve",`;

const PATCHED_LAZY_METHODS = `          "sessions.describe",
          "sessions.goal.clear",
          "sessions.resolve",`;

const ORIGINAL_HANDLER_ANCHOR = `      "sessions.patch": async ({ params, respond, context, client, isWebchatConnect }) => {`;

const PATCHED_HANDLER = `      // ${PATCH_MARKER}
      "sessions.goal.clear": async ({ params, respond, context, client, isWebchatConnect }) => {
        if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.goal.clear", respond)) return;
        const p4 = params;
        const key = requireSessionKey2(p4.key, respond);
        if (!key) return;
        if (rejectWebchatSessionMutation({
          action: "clear goal",
          client,
          isWebchatConnect,
          respond
        })) return;
        const cfg = context.getRuntimeConfig();
        const requestedAgent = resolveRequestedGlobalAgentId(cfg, key, p4.agentId);
        if (!requestedAgent.ok) {
          respond(false, void 0, requestedAgent.error);
          return;
        }
        const requestedAgentId = requestedAgent.agentId;
        const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, { agentId: requestedAgentId });
        const sessionKey = target.canonicalKey ?? key;
        const cleared = await clearSessionGoal({ sessionKey, storePath });
        if (cleared) emitSessionsChanged(context, {
          sessionKey,
          ...sessionKey === "global" && requestedAgentId ? { agentId: requestedAgentId } : {},
          reason: "goal-clear"
        });
        respond(true, { ok: true, cleared, key: sessionKey }, void 0);
      },
${ORIGINAL_HANDLER_ANCHOR}`;

function replaceRequired(content, from, to, label, filePath) {
  if (content.includes(to)) return content;
  if (!content.includes(from)) {
    throw new Error(`Silent Goal clear patch target not found (${label}): ${filePath}`);
  }
  return content.replace(from, to);
}

function applyPatch(runtimeDir, options = {}) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  if (!fs.existsSync(filePath)) return [];
  const original = fs.readFileSync(filePath, 'utf8');
  let content = original;
  content = replaceRequired(
    content,
    ORIGINAL_METHOD_CATALOG,
    PATCHED_METHOD_CATALOG,
    'method catalog',
    filePath,
  );
  content = replaceRequired(
    content,
    ORIGINAL_LAZY_METHODS,
    PATCHED_LAZY_METHODS,
    'lazy method registry',
    filePath,
  );
  content = replaceRequired(
    content,
    ORIGINAL_HANDLER_ANCHOR,
    PATCHED_HANDLER,
    'Gateway handler',
    filePath,
  );
  if (content === original) return [];
  fs.writeFileSync(filePath, content, 'utf8');
  const label = options.label || 'patch-openclaw-silent-goal-clear';
  console.log(`[${label}] Patched silent Goal clear RPC: gateway-bundle.mjs`);
  return ['gateway-bundle.mjs'];
}

function verifyPatch(runtimeDir) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const content = fs.readFileSync(filePath, 'utf8');
  const required = [
    PATCH_MARKER,
    'name: "sessions.goal.clear"',
    PATCHED_LAZY_METHODS,
    '"sessions.goal.clear": async',
    'const cleared = await clearSessionGoal({ sessionKey, storePath });',
    'reason: "goal-clear"',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) {
    throw new Error(`Silent Goal clear patch is incomplete: ${missing.join(', ')}`);
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
