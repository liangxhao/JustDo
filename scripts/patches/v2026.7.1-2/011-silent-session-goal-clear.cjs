'use strict';

// Capability: expose authenticated sessions.goal.clear without writing a chat message.
// Target: pristine openclaw@2026.7.1-2, which has no Gateway RPC for silent goal clearing.
// Scope: adds catalog/schema/handler entries and clears only persisted goal-related session fields.
// Safety: follows native operator scope and session update paths; no synthetic user turn is created.
// Remove when: OpenClaw provides an equivalent authenticated Gateway method.

const fs = require('fs');
const path = require('path');
const { replaceUnique, writeIfChanged } = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_SILENT_GOAL_CLEAR_2026_7_1';
const CATALOG_ANCHOR = `{
        name: "sessions.describe",
        scope: "operator.read"
      },
      {
        name: "sessions.compaction.list",`;
const CATALOG_PATCH = `{
        name: "sessions.describe",
        scope: "operator.read"
      },
      {
        name: "sessions.goal.clear",
        scope: "operator.admin"
      },
      {
        name: "sessions.compaction.list",`;
const LAZY_ANCHOR = `"sessions.describe",
          "sessions.resolve",`;
const LAZY_PATCH = `"sessions.describe",
          "sessions.goal.clear",
          "sessions.resolve",`;
const HANDLER_ANCHOR = `      "sessions.patch": async ({ params, respond, context: context2, client: client2, isWebchatConnect }) => {`;
const HANDLER = `      // ${CONTRACT}
      "sessions.goal.clear": async ({ params, respond, context: context2, client: client2, isWebchatConnect }) => {
        if (!assertValidParams(params, validateSessionsDescribeParams, "sessions.goal.clear", respond)) return;
        const request = params;
        const key = requireSessionKey2(request.key, respond);
        if (!key) return;
        if (rejectWebchatSessionMutation({ action: "clear goal", client: client2, isWebchatConnect, respond })) return;
        const cfg = context2.getRuntimeConfig();
        const requestedAgent = resolveRequestedSessionAgentId(cfg, key, request.agentId);
        if (!requestedAgent.ok) { respond(false, void 0, requestedAgent.error); return; }
        const requestedAgentId = requestedAgent.agentId;
        const { target, storePath } = resolveGatewaySessionTargetFromKey(key, cfg, { agentId: requestedAgentId });
        const canonicalKey = target.canonicalKey ?? key;
        const cleared = await clearSessionGoal({ sessionKey: canonicalKey, storePath });
        if (cleared) emitSessionsChanged(context2, { sessionKey: canonicalKey, ...(canonicalKey === "global" && requestedAgentId ? { agentId: requestedAgentId } : {}), reason: "goal-clear" });
        respond(true, { ok: true, cleared, key: canonicalKey }, void 0);
      },
${HANDLER_ANCHOR}`;

function applyPatch(runtimeDir) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  if (!fs.existsSync(filePath)) return [];
  const original = fs.readFileSync(filePath, 'utf8');
  let updated = original;
  if (!updated.includes('name: "sessions.goal.clear"'))
    updated = replaceUnique(updated, CATALOG_ANCHOR, CATALOG_PATCH, 'Goal clear method catalog');
  if (!updated.includes(`"sessions.goal.clear",\n          "sessions.resolve"`))
    updated = replaceUnique(updated, LAZY_ANCHOR, LAZY_PATCH, 'Goal clear lazy registry');
  if (!updated.includes(CONTRACT))
    updated = replaceUnique(updated, HANDLER_ANCHOR, HANDLER, 'Goal clear handler');
  return writeIfChanged(filePath, original, updated) ? ['gateway-bundle.mjs'] : [];
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  for (const required of [
    CONTRACT,
    'name: "sessions.goal.clear"',
    'const cleared = await clearSessionGoal({ sessionKey: canonicalKey, storePath });',
    'reason: "goal-clear"',
  ]) {
    if (!content.includes(required))
      throw new Error(`missing silent Goal clear contract: ${required}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    CONTRACT,
    CATALOG_ANCHOR,
    CATALOG_PATCH,
    LAZY_ANCHOR,
    LAZY_PATCH,
    HANDLER_ANCHOR,
    HANDLER,
  },
};
