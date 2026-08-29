'use strict';

// Capability: route generic OpenAI-compatible embedding requests through an eligible env proxy.
// Target: openclaw@2026.7.1-2 embedding-provider source and the post-install gateway bundle.
// Scope: the openai-compatible /embeddings POST guarded-fetch call only.
// Safety: proxy selection still requires HTTP(S)_PROXY eligibility, honors NO_PROXY, and keeps SSRF policy.
// Remove when: upstream generic embedding requests auto-upgrade to the trusted environment proxy path.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_OPENAI_COMPATIBLE_EMBEDDING_ENV_PROXY_V2026_7_1_2';
const FUNCTION_SIGNATURE = 'async function postEmbeddingRequest(params) {';
const AUDIT_CONTEXT = 'auditContext: "embedding-provider:openai-compatible"';
const PROXY_CONTRACT = 'useEnvProxyForEligibleUrls: true';
const PATCHED_REQUEST_PATTERN =
  /auditContext: "embedding-provider:openai-compatible",\s*useEnvProxyForEligibleUrls: true/;

function transformEmbeddingProvider(content, filePath) {
  const auditCount = countOccurrences(content, AUDIT_CONTEXT);
  if (auditCount !== 1) {
    throw new Error(
      `${filePath}: OpenAI-compatible embedding audit context count is ${auditCount}, expected 1`,
    );
  }

  const patchedCount = [...content.matchAll(new RegExp(PATCHED_REQUEST_PATTERN.source, 'g'))]
    .length;
  if (patchedCount === 1) return content;
  if (patchedCount > 1 || content.includes(MARKER)) {
    throw new Error(`${filePath}: partial OpenAI-compatible embedding env-proxy patch detected`);
  }

  return replaceUniquePattern(
    content,
    /^([ \t]*)auditContext: "embedding-provider:openai-compatible"[ \t]*$/m,
    `$1${AUDIT_CONTEXT},\n$1${PROXY_CONTRACT} // ${MARKER}`,
    `${filePath}: OpenAI-compatible embedding env-proxy option`,
  );
}

function locateTargets(runtimeDir) {
  const targets = new Set(findFilesContaining(runtimeDir, [FUNCTION_SIGNATURE, AUDIT_CONTEXT]));
  for (const filePath of findFilesContaining(runtimeDir, [FUNCTION_SIGNATURE, MARKER])) {
    targets.add(filePath);
  }
  for (const filePath of findFilesContaining(runtimeDir, [
    FUNCTION_SIGNATURE,
    AUDIT_CONTEXT,
    PROXY_CONTRACT,
  ])) {
    targets.add(filePath);
  }

  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (targets.size !== expected) {
    throw new Error(
      `OpenAI-compatible embedding env-proxy target count is ${targets.size}, expected ${expected}`,
    );
  }
  return [...targets];
}

function applyPatch(runtimeDir) {
  const staged = locateTargets(runtimeDir).map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transformEmbeddingProvider(original, filePath);
    return { filePath, original, updated };
  });
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  for (const filePath of locateTargets(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const auditCount = countOccurrences(content, AUDIT_CONTEXT);
    const contractCount = [...content.matchAll(new RegExp(PATCHED_REQUEST_PATTERN.source, 'g'))]
      .length;
    if (auditCount !== 1 || contractCount !== 1) {
      throw new Error(
        `${filePath}: OpenAI-compatible embedding env-proxy contract is incomplete ` +
          `(audit=${auditCount}, proxy=${contractCount})`,
      );
    }
    if (path.basename(filePath) !== 'gateway-bundle.mjs' && !content.includes(`// ${MARKER}`)) {
      throw new Error(`${filePath}: OpenAI-compatible embedding source marker is missing`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    AUDIT_CONTEXT,
    MARKER,
    PATCHED_REQUEST_PATTERN,
    PROXY_CONTRACT,
    transformEmbeddingProvider,
  },
};
