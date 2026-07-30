'use strict';

// Purpose: Attach the active OpenClaw session id as LiteLLM-compatible
// metadata on OpenAI-compatible model requests.
// Affected OpenClaw version: v2026.6.11.
// Risk: OpenAI-compatible endpoints receive one additional metadata key.
// Remove when: OpenClaw forwards sessionId as metadata.session_id for OpenAI
// Chat Completions and Responses transports.
// Upstream tracking: TODO(openclaw): request session metadata forwarding.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const HELPER_MARKER = 'JUSTDO_LITELLM_SESSION_ID';
const ORIGINAL_RESOLVER = 'function resolveEmbeddedAgentStreamFn(params) {';
const RENAMED_RESOLVER = 'function resolveEmbeddedAgentStreamFnWithoutLiteLLMSessionId(params) {';
const WRAPPER_ANCHOR = 'function wrapEmbeddedAgentStreamFn(inner, params) {';

const HELPER_SOURCE = `// ${HELPER_MARKER}
const JUSTDO_LITELLM_SESSION_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses"
]);
function wrapStreamFnWithLiteLLMSessionId(streamFn, sessionId, modelApi) {
  const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!normalizedSessionId || !JUSTDO_LITELLM_SESSION_APIS.has(modelApi)) return streamFn;
  return (model, context, options) => streamWithPayloadPatch(
    streamFn,
    model,
    context,
    options,
    (payload) => {
      const metadata = payload.metadata;
      payload.metadata = {
        ...metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
        session_id: normalizedSessionId
      };
    }
  );
}
`;

const RESOLVER_WRAPPER = `function resolveEmbeddedAgentStreamFn(params) {
  return wrapStreamFnWithLiteLLMSessionId(
    resolveEmbeddedAgentStreamFnWithoutLiteLLMSessionId(params),
    params.sessionId,
    params.model.api
  );
}
`;

function replaceExactlyOnce(content, original, replacement, description, filePath) {
  const firstIndex = content.indexOf(original);
  if (firstIndex === -1) {
    throw new Error(`OpenClaw ${description} patch target not found: ${filePath}`);
  }
  if (content.indexOf(original, firstIndex + original.length) !== -1) {
    throw new Error(`OpenClaw ${description} patch target is ambiguous: ${filePath}`);
  }
  return content.replace(original, replacement);
}

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const alreadyPatched =
    content.includes(HELPER_MARKER) &&
    content.includes(RENAMED_RESOLVER) &&
    content.includes(RESOLVER_WRAPPER);
  if (alreadyPatched) return false;

  content = replaceExactlyOnce(
    content,
    ORIGINAL_RESOLVER,
    `${HELPER_SOURCE}\n${RENAMED_RESOLVER}`,
    'LiteLLM session resolver',
    filePath,
  );
  content = replaceExactlyOnce(
    content,
    WRAPPER_ANCHOR,
    `${RESOLVER_WRAPPER}\n${WRAPPER_ANCHOR}`,
    'LiteLLM session wrapper',
    filePath,
  );
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-litellm-session-id';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring session metadata patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Added LiteLLM-compatible session metadata forwarding.`);
  } else if (options.verbose) {
    console.log(`[${label}] LiteLLM session metadata forwarding already applied.`);
  }
  return patched;
}

module.exports = {
  applyPatch,
  __testing: {
    HELPER_SOURCE,
    RENAMED_RESOLVER,
    RESOLVER_WRAPPER,
  },
};
