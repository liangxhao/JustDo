'use strict';

// Purpose: Expose sanitized run progress stages and an exact active-run flag so
// JustDo can distinguish queueing, preparation, model waiting, and fallback retry.
// Affected OpenClaw version: v2026.6.11.
// Risk: Adds lifecycle progress events and a sessions.describe response field
// without changing execution, retry, or fallback decisions; older clients ignore them.
// Remove when: OpenClaw exposes an equivalent versioned, sanitized run-progress
// lifecycle contract upstream.
// Upstream tracking: TODO(openclaw): propose the lifecycle progress contract.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'JUSTDO_RUN_PROGRESS_EVENTS_V1';

const ORIGINAL_RUN_ATTEMPT = `function runAgentAttempt(params) {
  const isRawModelRun = params.opts.modelRun === true || params.opts.promptMode === "none";`;

const PATCHED_RUN_ATTEMPT = `function runAgentAttempt(params) {
  // ${PATCH_MARKER}
  const emitJustDoRunProgress = (stage, details = {}) => {
    const provider = typeof details.provider === "string" && details.provider ? details.provider : void 0;
    const model = typeof details.model === "string" && details.model ? details.model : void 0;
    const reason = details.reason === "rate_limit" || details.reason === "timeout" || details.reason === "overloaded" || details.reason === "auth" ? details.reason : void 0;
    emitAgentEvent({
      runId: params.runId,
      ...params.sessionKey ? { sessionKey: params.sessionKey } : {},
      ...params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {},
      stream: "lifecycle",
      data: {
        phase: "progress",
        stage,
        at: Date.now(),
        ...provider ? { provider } : {},
        ...model ? { model } : {},
        ...reason ? { reason } : {}
      }
    });
  };
  if (params.isFallbackRetry) emitJustDoRunProgress("retrying", {
    provider: params.providerOverride,
    model: params.modelOverride
  });
  const handleJustDoExecutionPhase = (info) => {
    if (info.phase === "attempt_dispatch" || info.phase === "process_spawned") {
      emitJustDoRunProgress("waiting_model", info);
      return;
    }
    if (["runner_entered", "workspace", "runtime_plugins", "before_agent_reply", "model_resolution", "auth", "context_engine"].includes(info.phase)) {
      emitJustDoRunProgress("preparing", info);
    }
  };
  const isRawModelRun = params.opts.modelRun === true || params.opts.promptMode === "none";`;

const ORIGINAL_CLI_OPTIONS = `      toolsAllow: params.opts.toolsAllow,
      cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,`;

const PATCHED_CLI_OPTIONS = `      toolsAllow: params.opts.toolsAllow,
      onExecutionPhase: handleJustDoExecutionPhase,
      cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd,`;

const ORIGINAL_EMBEDDED_OPTIONS = `    disableTools: params.opts.modelRun === true,
    onAgentEvent: params.onAgentEvent,`;

const PATCHED_EMBEDDED_OPTIONS = `    disableTools: params.opts.modelRun === true,
    onExecutionPhase: handleJustDoExecutionPhase,
    onLaneWait: (info5) => {
      if (info5.waiting) emitJustDoRunProgress("queued", {
        provider: embeddedAgentProvider,
        model: params.modelOverride
      });
    },
    onAgentEvent: params.onAgentEvent,`;

const ORIGINAL_SESSION_DESCRIBE_RESPONSE = `        respond(true, { session: buildGatewaySessionRow({
          cfg,
          storePath,
          store: store2,
          key: target.canonicalKey,
          entry,
          includeDerivedTitles: p4.includeDerivedTitles,
          includeLastMessage: p4.includeLastMessage,
          transcriptUsageMaxBytes: 64 * 1024
        }) }, void 0);`;

const PATCHED_SESSION_DESCRIBE_RESPONSE = `        const session = buildGatewaySessionRow({
          cfg,
          storePath,
          store: store2,
          key: target.canonicalKey,
          entry,
          includeDerivedTitles: p4.includeDerivedTitles,
          includeLastMessage: p4.includeLastMessage,
          transcriptUsageMaxBytes: 64 * 1024
        });
        session.hasActiveRun = hasTrackedActiveSessionRun({
          context,
          requestedKey: key,
          canonicalKey: target.canonicalKey,
          defaultAgentId: resolveDefaultAgentId(cfg)
        });
        respond(true, { session }, void 0);`;

function replaceRequired(content, from, to, label, filePath) {
  if (content.includes(to)) return content;
  if (!content.includes(from)) {
    throw new Error(`Run progress patch target not found (${label}): ${filePath}`);
  }
  return content.replace(from, to);
}

function applyPatch(runtimeDir, options = {}) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  // The install pass patches dist/ before gateway-bundle.mjs exists. Defer this
  // bundle-only patch until bundle-openclaw-gateway runs the complete patch pass.
  if (!fs.existsSync(filePath)) return [];
  const original = fs.readFileSync(filePath, 'utf8');
  let content = original;
  content = replaceRequired(content, ORIGINAL_RUN_ATTEMPT, PATCHED_RUN_ATTEMPT, 'helper', filePath);
  content = replaceRequired(content, ORIGINAL_CLI_OPTIONS, PATCHED_CLI_OPTIONS, 'CLI phases', filePath);
  content = replaceRequired(
    content,
    ORIGINAL_EMBEDDED_OPTIONS,
    PATCHED_EMBEDDED_OPTIONS,
    'embedded phases',
    filePath,
  );
  content = replaceRequired(
    content,
    ORIGINAL_SESSION_DESCRIBE_RESPONSE,
    PATCHED_SESSION_DESCRIBE_RESPONSE,
    'sessions.describe active run',
    filePath,
  );
  if (content === original) return [];
  fs.writeFileSync(filePath, content, 'utf8');
  const label = options.label || 'patch-openclaw-run-progress';
  console.log(`[${label}] Patched sanitized run progress events: gateway-bundle.mjs`);
  return ['gateway-bundle.mjs'];
}

function verifyPatch(runtimeDir) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const content = fs.readFileSync(filePath, 'utf8');
  const required = [
    PATCH_MARKER,
    'emitAgentEvent({',
    'phase: "progress"',
    'emitJustDoRunProgress("retrying"',
    'emitJustDoRunProgress("waiting_model", info)',
    'emitJustDoRunProgress("preparing", info)',
    'emitJustDoRunProgress("queued"',
    'onExecutionPhase: handleJustDoExecutionPhase',
    'session.hasActiveRun = hasTrackedActiveSessionRun({',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) {
    throw new Error(`Run progress patch is incomplete: ${missing.join(', ')}`);
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
