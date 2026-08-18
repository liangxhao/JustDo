'use strict';

// Capability: suspend only the JustDo run waiting for approval without expiring or cancelling it.
// Target: pristine openclaw@2026.7.1-2 exec/plugin waiters and transcript persistence guard.
// Scope: trusted persisted ancestry rooted at agent:*:justdo:*; native and cron sessions are unchanged.
// Safety: only the exact automatic "chat run timed out" abort is ignored; explicit aborts still win.
// Remove when: upstream supports durable, run-scoped approval suspension across provider timeouts.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils');

const CAPABILITY = 'justdo-approval-run-suspension';

function expectedCopies(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
}

function findExactTargets(runtimeDir, needles, label) {
  const files = findFilesContaining(runtimeDir, needles);
  const expected = expectedCopies(runtimeDir);
  if (files.length !== expected) {
    throw new Error(`${label} target count is ${files.length}, expected ${expected}`);
  }
  return files;
}

function transformGateway(content, filePath) {
  if (content.includes('opts?.timeoutMs === null ? null')) return content;
  return replaceUnique(
    content,
    'const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;',
    `// ${CAPABILITY}: nullable gateway timeout
\tconst timeoutMs = opts?.timeoutMs === null ? null : typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;`,
    `${filePath}: nullable gateway timeout`,
  );
}

const ANCESTRY_HELPER = `function isJustDoManagedApprovalSessionKey(sessionKey) {
\tlet current = normalizeOptionalString(sessionKey);
\tconst visited = new Set();
\tfor (let depth = 0; current && depth < 32; depth += 1) {
\t\tif (visited.has(current)) return false;
\t\tvisited.add(current);
\t\tif (/^agent:[^:]+:justdo:/.test(current)) return true;
\t\ttry {
\t\t\tconst agentId = resolveAgentIdFromSessionKey(current);
\t\t\tcurrent = normalizeOptionalString(loadSessionStore(resolveStorePath(void 0, { agentId }), { clone: false })?.[current]?.spawnedBy);
\t\t} catch {
\t\t\treturn false;
\t\t}
\t}
\treturn false;
}`;

function transformExecWaiter(content, filePath) {
  if (
    /timeoutMs: isJustDoManagedApprovalSessionKey\d*\(params\.sessionKey\) \? null/.test(content) &&
    content.includes('sessionKey: prepared.sessionKey')
  ) {
    return content;
  }
  let updated = replaceUnique(
    content,
    `function parseExpiresAtMs(value) {
\treturn asDateTimestampMs(value);
}`,
    `function parseExpiresAtMs(value) {
\treturn asDateTimestampMs(value);
}
${ANCESTRY_HELPER}`,
    `${filePath}: trusted approval ancestry helper`,
  );
  updated = replaceUnique(
    updated,
    'return parseDecision(await callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id: params.approvalId })).value;',
    `// ${CAPABILITY}: persistent exec decision wait
\t\treturn parseDecision(await callGatewayTool("exec.approval.waitDecision", { timeoutMs: isJustDoManagedApprovalSessionKey(params.sessionKey) ? null : DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id: params.approvalId })).value;`,
    `${filePath}: persistent exec wait`,
  );
  updated = replaceUnique(
    updated,
    `approvalId: params.approvalId,
\t\t\tpreResolvedDecision: params.preResolvedDecision`,
    `approvalId: params.approvalId,
\t\t\tpreResolvedDecision: params.preResolvedDecision,
\t\t\tsessionKey: params.sessionKey`,
    `${filePath}: exec wait session propagation`,
  );
  updated = replaceUnique(
    updated,
    `approvalId,
\t\t\t\tpreResolvedDecision,
\t\t\t\tonFailure`,
    `approvalId,
\t\t\t\tpreResolvedDecision,
\t\t\t\tsessionKey: params.sessionKey,
\t\t\t\tonFailure`,
    `${filePath}: gateway exec session propagation`,
  );
  updated = replaceUnique(
    updated,
    `approvalId,
\t\t\t\t\t\tpreResolvedDecision,
\t\t\t\t\t\tonFailure:`,
    `approvalId,
\t\t\t\t\t\tpreResolvedDecision,
\t\t\t\t\t\tsessionKey: prepared.sessionKey,
\t\t\t\t\t\tonFailure:`,
    `${filePath}: node exec session propagation`,
  );
  return updated;
}

function transformPluginWaiter(content, filePath) {
  if (
    content.includes('justDoPersistentWait ? null : gatewayTimeoutMs') &&
    content.includes('isJustDoAutomaticRunTimeout(params.signal.reason)')
  ) {
    return content;
  }
  let updated = replaceUnique(
    content,
    'import { h as getPluginSessionExtensionStateSync } from "./registry-B8eQDFB4.js";',
    `import { h as getPluginSessionExtensionStateSync } from "./registry-B8eQDFB4.js";
import { S as loadSessionStore } from "./store-BJJhlPrk.js";
import { p as resolveAgentIdFromSessionKey } from "./session-key-VWT_xzM9.js";
import { d as resolveStorePath } from "./paths-C2C4lJH6.js";
import { c as normalizeOptionalString } from "./string-coerce-DW4mBlAt.js";`,
    `${filePath}: plugin ancestry imports`,
  );
  updated = replaceUnique(
    updated,
    `let embeddedModeValue = false;`,
    `${ANCESTRY_HELPER}
function isJustDoAutomaticRunTimeout(reason) {
\treturn reason instanceof Error && reason.name === "TimeoutError" && reason.message === "chat run timed out";
}
let embeddedModeValue = false;`,
    `${filePath}: plugin suspension helpers`,
  );
  updated = replaceUnique(
    updated,
    `gatewayApprovalPhase = "wait";
\t\t\tconst waitPromise = callGatewayTool("plugin.approval.waitDecision", { timeoutMs: gatewayTimeoutMs }, { id });`,
    `gatewayApprovalPhase = "wait";
\t\t\tconst justDoPersistentWait = isJustDoManagedApprovalSessionKey(params.ctx?.sessionKey);
\t\t\t// ${CAPABILITY}: persistent plugin decision wait
\t\t\tconst waitPromise = callGatewayTool("plugin.approval.waitDecision", { timeoutMs: justDoPersistentWait ? null : gatewayTimeoutMs }, { id });`,
    `${filePath}: persistent plugin wait`,
  );
  updated = replaceUnique(
    updated,
    `if (params.signal.aborted) {
\t\t\t\t\t\treject(toLintErrorObject(params.signal.reason, "Non-Error rejection"));
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tonAbort = () => reject(toLintErrorObject(params.signal.reason, "Non-Error rejection"));`,
    `if (params.signal.aborted) {
\t\t\t\t\t\tif (!justDoPersistentWait || !isJustDoAutomaticRunTimeout(params.signal.reason)) reject(toLintErrorObject(params.signal.reason, "Non-Error rejection"));
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tonAbort = () => {
\t\t\t\t\t\tif (justDoPersistentWait && isJustDoAutomaticRunTimeout(params.signal.reason)) return;
\t\t\t\t\t\treject(toLintErrorObject(params.signal.reason, "Non-Error rejection"));
\t\t\t\t\t};`,
    `${filePath}: automatic timeout abort filter`,
  );
  return updated;
}

function transformTranscriptGuard(content, filePath) {
  if (
    content.includes('suppressJustDoApprovalAssistantPersistence = true') &&
    content.includes('toolCalls.length === 0 && suppressJustDoApprovalAssistantPersistence')
  ) {
    return content;
  }
  let updated = replaceUnique(
    content,
    'import { it as resolveCacheTtlMs, nt as createExpiringMapCache, rt as isCacheEnabled } from "./store-BJJhlPrk.js";',
    `import { S as loadSessionStore, it as resolveCacheTtlMs, nt as createExpiringMapCache, rt as isCacheEnabled } from "./store-BJJhlPrk.js";
import { p as resolveAgentIdFromSessionKey } from "./session-key-VWT_xzM9.js";
import { d as resolveStorePath } from "./paths-C2C4lJH6.js";`,
    `${filePath}: transcript ancestry imports`,
  );
  updated = replaceUnique(
    updated,
    `function isTranscriptOnlyOpenClawAssistantMessage(message) {
\tif (!message || message.role !== "assistant") return false;
\treturn isTranscriptOnlyOpenClawAssistantModel(normalizeOptionalString(message.provider) ?? "", normalizeOptionalString(message.model) ?? "");
}`,
    `function isTranscriptOnlyOpenClawAssistantMessage(message) {
\tif (!message || message.role !== "assistant") return false;
\treturn isTranscriptOnlyOpenClawAssistantModel(normalizeOptionalString(message.provider) ?? "", normalizeOptionalString(message.model) ?? "");
}
${ANCESTRY_HELPER}`,
    `${filePath}: transcript ancestry helper`,
  );
  updated = replaceUnique(
    updated,
    `let suppressNextUserMessagePersistence = opts?.suppressNextUserMessagePersistence === true;`,
    `let suppressNextUserMessagePersistence = opts?.suppressNextUserMessagePersistence === true;
\t// ${CAPABILITY}: transcript suspension latch
\tlet suppressJustDoApprovalAssistantPersistence = false;`,
    `${filePath}: transcript suspension state`,
  );
  updated = replaceUnique(
    updated,
    `const toolName = id ? pendingState.getToolName(id) : void 0;
\t\t\tif (id) pendingState.delete(id);`,
    `const toolName = id ? pendingState.getToolName(id) : void 0;
\t\t\tif (nextMessage.details?.status === "approval-pending" && isJustDoManagedApprovalSessionKey(opts?.sessionKey)) suppressJustDoApprovalAssistantPersistence = true;
\t\t\tif (id) pendingState.delete(id);`,
    `${filePath}: approval-pending transcript latch`,
  );
  updated = replaceUnique(
    updated,
    `if (finalRole === "assistant" && toolCalls.length === 0 && opts?.suppressTranscriptOnlyAssistantPersistence === true) return;`,
    `if (finalRole === "assistant" && toolCalls.length === 0 && suppressJustDoApprovalAssistantPersistence) return;
\t\tif (finalRole === "assistant" && toolCalls.length === 0 && opts?.suppressTranscriptOnlyAssistantPersistence === true) return;`,
    `${filePath}: suspended assistant persistence guard`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const groups = [
    [
      findExactTargets(
        runtimeDir,
        ['function resolveGatewayOptions', 'APPROVAL_RUNTIME_METHODS'],
        'gateway timeout',
      ),
      transformGateway,
    ],
    [
      findExactTargets(
        runtimeDir,
        [
          'function resolveRegisteredExecApprovalDecision(params)',
          'function shouldAwaitGatewayApprovalInline(params)',
        ],
        'exec approval waiter',
      ),
      transformExecWaiter,
    ],
    [
      findExactTargets(
        runtimeDir,
        ['plugin.approval.waitDecision', 'gatewayApprovalPhase = "wait"'],
        'plugin approval waiter',
      ),
      transformPluginWaiter,
    ],
    [
      findExactTargets(
        runtimeDir,
        [
          'function installSessionToolResultGuard(sessionManager, opts)',
          'suppressTranscriptOnlyAssistantPersistence',
        ],
        'transcript guard',
      ),
      transformTranscriptGuard,
    ],
  ];
  const staged = new Map();
  for (const [files, transform] of groups) {
    for (const filePath of files) {
      const original = staged.get(filePath)?.original ?? fs.readFileSync(filePath, 'utf8');
      const base = staged.get(filePath)?.updated ?? original;
      staged.set(filePath, { original, updated: transform(base, filePath) });
    }
  }
  const changed = [];
  for (const [filePath, { original, updated }] of staged) {
    if (writeIfChanged(filePath, original, updated)) changed.push(filePath);
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const contracts = [
    [
      findExactTargets(
        runtimeDir,
        ['function resolveGatewayOptions', 'APPROVAL_RUNTIME_METHODS'],
        'gateway timeout',
      ),
      ['opts?.timeoutMs === null ? null'],
      false,
    ],
    [
      findExactTargets(
        runtimeDir,
        ['function resolveRegisteredExecApprovalDecision(params)'],
        'exec approval waiter',
      ),
      [
        /timeoutMs: isJustDoManagedApprovalSessionKey\d*\(params\.sessionKey\) \? null/,
        'sessionKey: prepared.sessionKey',
      ],
      true,
    ],
    [
      findExactTargets(
        runtimeDir,
        ['plugin.approval.waitDecision', 'gatewayApprovalPhase = "wait"'],
        'plugin approval waiter',
      ),
      [
        'justDoPersistentWait ? null : gatewayTimeoutMs',
        'isJustDoAutomaticRunTimeout(params.signal.reason)',
      ],
      true,
    ],
    [
      findExactTargets(
        runtimeDir,
        ['function installSessionToolResultGuard(sessionManager, opts)'],
        'transcript guard',
      ),
      [
        'suppressJustDoApprovalAssistantPersistence = true',
        'toolCalls.length === 0 && suppressJustDoApprovalAssistantPersistence',
      ],
      true,
    ],
  ];
  for (const [files, needles, needsAncestry] of contracts) {
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const needle of needles) {
        const present = needle instanceof RegExp ? needle.test(content) : content.includes(needle);
        if (!present) throw new Error(`${filePath}: missing ${needle}`);
      }
      if (needsAncestry && !content.includes('/^agent:[^:]+:justdo:/.test(current)'))
        throw new Error(`${filePath}: trusted ancestry root is missing`);
      if (needsAncestry && !content.includes('?.spawnedBy'))
        throw new Error(`${filePath}: persisted ancestry traversal is missing`);
    }
  }
}

module.exports = {
  applyPatch,
  transformExecWaiter,
  transformGateway,
  transformPluginWaiter,
  transformTranscriptGuard,
  verifyPatch,
};
