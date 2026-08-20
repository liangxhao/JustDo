'use strict';

// Capability: keep JustDo managed sessions on their persisted Gateway session id across implicit recovery.
// Target: pristine openclaw@2026.7.1-2 command, chat reply and Gateway agent session resolvers.
// Scope: exact agent:*:justdo:* keys with an existing persisted session id; explicit reset/delete paths stay native.
// Safety: non-managed keys are unchanged, stale requested ids cannot replace managed identity, and all targets stage atomically.
// Remove when: upstream supports an immutable externally-managed session identity across every implicit recovery path.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const COMMAND_MARKER = 'JUSTDO_MANAGED_COMMAND_SESSION_IDENTITY_PIN_V2026_7_1_2';
const AGENT_MARKER = 'JUSTDO_MANAGED_AGENT_SESSION_IDENTITY_PIN_V2026_7_1_2';
const REPLY_MARKER = 'JUSTDO_MANAGED_REPLY_SESSION_IDENTITY_PIN_V2026_7_1_2';

function verifyCommandContent(content, filePath) {
  for (const expected of [
    'const preserveJustDoManagedSession =',
    '(preserveJustDoManagedSession ? sessionEntry?.sessionId : void 0) || requestedSessionId',
    'const isNewSession = preserveJustDoManagedSession ? false : !fresh && !requestedSessionId;',
  ]) {
    if (!content.includes(expected)) {
      throw new Error(
        `managed command-session identity contract is missing from ${filePath}: ${expected}`,
      );
    }
  }
}

function verifyAgentContent(content, filePath) {
  for (const expected of [
    'const justDoManagedSession = /^agent:[^:]+:justdo:[^:]+$/i.test(canonicalKey);',
    'justDoManagedSession || (freshness?.fresh ?? false)',
    'justDoManagedSession || (freshFreshness?.fresh ?? false)',
    'justDoManagedSession && entry?.sessionId ? entry.sessionId',
    'justDoManagedSession && freshEntry?.sessionId ? freshEntry.sessionId',
  ]) {
    if (!content.includes(expected)) {
      throw new Error(
        `managed Gateway-session identity contract is missing from ${filePath}: ${expected}`,
      );
    }
  }
}

function verifyReplyContent(content, filePath) {
  for (const expected of [
    'const justDoManagedReplySession = /^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey);',
    'const preserveJustDoManagedReplySession =',
    'justDoManagedReplySession || typeof entry?.updatedAt === "number"',
    'const effectiveFreshEntry = preserveJustDoManagedReplySession || (',
  ]) {
    if (!content.includes(expected)) {
      throw new Error(
        `managed chat-reply identity contract is missing from ${filePath}: ${expected}`,
      );
    }
  }
}

function transformCommand(content, filePath) {
  if (
    content.includes(COMMAND_MARKER) ||
    content.includes('const preserveJustDoManagedSession =')
  ) {
    verifyCommandContent(content, filePath);
    return content;
  }
  let updated = replaceUniquePattern(
    content,
    /([ \t]*)const requestedSessionId = opts\.sessionId\?\.trim\(\) \|\| void 0;\r?\n[ \t]*const terminalMainTranscriptNewerThanRegistry =/,
    (_match, indent) =>
      `${indent}const requestedSessionId = opts.sessionId?.trim() || void 0;\n` +
      `${indent}const preserveJustDoManagedSession = /^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey ?? "") && Boolean(sessionEntry?.sessionId); // ${COMMAND_MARKER}\n` +
      `${indent}const terminalMainTranscriptNewerThanRegistry =`,
    `${filePath}: managed command-session classification`,
  );
  updated = replaceUniquePattern(
    updated,
    /const sessionId = requestedSessionId \|\| \(fresh \? sessionEntry\?\.sessionId : void 0\) \|\| ([A-Za-z_$][\w$]*\.randomUUID\(\));\r?\n([ \t]*)const isNewSession = !fresh && !requestedSessionId;/,
    (_match, randomUuidCall, indent) =>
      `const sessionId = (preserveJustDoManagedSession ? sessionEntry?.sessionId : void 0) || requestedSessionId || (fresh ? sessionEntry?.sessionId : void 0) || ${randomUuidCall};\n${indent}const isNewSession = preserveJustDoManagedSession ? false : !fresh && !requestedSessionId;`,
    `${filePath}: managed command-session identity selection`,
  );
  verifyCommandContent(updated, filePath);
  return updated;
}

function transformAgent(content, filePath) {
  if (
    content.includes(AGENT_MARKER) ||
    content.includes(
      'const justDoManagedSession = /^agent:[^:]+:justdo:[^:]+$/i.test(canonicalKey);',
    )
  ) {
    verifyAgentContent(content, filePath);
    return content;
  }
  let updated = replaceUniquePattern(
    content,
    /([ \t]*)const canReuseSession = Boolean\(entry\?\.sessionId\) && \(freshness\?\.fresh \?\? false\) && !failedSessionTranscriptMissing && !terminalMainTranscriptNewerThanRegistry;/,
    (_match, indent) =>
      `${indent}const justDoManagedSession = /^agent:[^:]+:justdo:[^:]+$/i.test(canonicalKey); // ${AGENT_MARKER}\n` +
      `${indent}const canReuseSession = Boolean(entry?.sessionId) && (justDoManagedSession || (freshness?.fresh ?? false) && !failedSessionTranscriptMissing && !terminalMainTranscriptNewerThanRegistry);`,
    `${filePath}: managed Gateway-session classification`,
  );
  updated = replaceUniquePattern(
    updated,
    /([ \t]*)let usableRequestedSessionId = requestedSessionId && \(!entry\?\.sessionId \|\| canReuseSession\) \? requestedSessionId : void 0;\r?\n[ \t]*const sessionId = usableRequestedSessionId \? usableRequestedSessionId : \(canReuseSession \? entry\?\.sessionId : void 0\) \?\? ([A-Za-z_$][\w$]*\(\));/,
    (_match, indent, randomUuidCall) =>
      `${indent}let usableRequestedSessionId = justDoManagedSession\n` +
      `${indent}\t? requestedSessionId && (!entry?.sessionId || entry.sessionId.trim() === requestedSessionId) ? requestedSessionId : void 0\n` +
      `${indent}\t: requestedSessionId && (!entry?.sessionId || canReuseSession) ? requestedSessionId : void 0;\n` +
      `${indent}const sessionId = justDoManagedSession && entry?.sessionId ? entry.sessionId : usableRequestedSessionId ? usableRequestedSessionId : (canReuseSession ? entry?.sessionId : void 0) ?? ${randomUuidCall};`,
    `${filePath}: managed Gateway-session initial identity`,
  );
  updated = replaceUniquePattern(
    updated,
    /([ \t]*)const freshCanReuseSession = Boolean\(freshEntry\?\.sessionId\) && \(freshFreshness\?\.fresh \?\? false\) && !freshFailedSessionTranscriptMissing && !freshTerminalMainTranscriptNewerThanRegistry;\r?\n[ \t]*const freshUsableRequestedSessionId = requestedSessionId && \(!freshEntry\?\.sessionId \|\| freshCanReuseSession\) \? requestedSessionId : void 0;\r?\n[ \t]*const freshSessionId = freshUsableRequestedSessionId \? freshUsableRequestedSessionId : \(freshCanReuseSession \? freshEntry\?\.sessionId : void 0\) \?\? sessionId;/,
    (_match, indent) =>
      `${indent}const freshCanReuseSession = Boolean(freshEntry?.sessionId) && (justDoManagedSession || (freshFreshness?.fresh ?? false) && !freshFailedSessionTranscriptMissing && !freshTerminalMainTranscriptNewerThanRegistry);\n` +
      `${indent}const freshUsableRequestedSessionId = justDoManagedSession\n` +
      `${indent}\t? requestedSessionId && (!freshEntry?.sessionId || freshEntry.sessionId.trim() === requestedSessionId) ? requestedSessionId : void 0\n` +
      `${indent}\t: requestedSessionId && (!freshEntry?.sessionId || freshCanReuseSession) ? requestedSessionId : void 0;\n` +
      `${indent}const freshSessionId = justDoManagedSession && freshEntry?.sessionId ? freshEntry.sessionId : freshUsableRequestedSessionId ? freshUsableRequestedSessionId : (freshCanReuseSession ? freshEntry?.sessionId : void 0) ?? sessionId;`,
    `${filePath}: managed Gateway-session persisted identity`,
  );
  verifyAgentContent(updated, filePath);
  return updated;
}

function transformReply(content, filePath) {
  if (
    content.includes(REPLY_MARKER) ||
    content.includes(
      'const justDoManagedReplySession = /^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey);',
    )
  ) {
    verifyReplyContent(content, filePath);
    return content;
  }
  let updated = replaceUniquePattern(
    content,
    /([ \t]*)const canReuseExistingEntry = Boolean\(entry\?\.sessionId\) && typeof entry\?\.updatedAt === "number" && Number\.isFinite\(entry\.updatedAt\);/,
    (_match, indent) =>
      `${indent}const justDoManagedReplySession = /^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey); // ${REPLY_MARKER}\n` +
      `${indent}const preserveJustDoManagedReplySession = justDoManagedReplySession && Boolean(entry?.sessionId) && !resetTriggered;\n` +
      `${indent}const canReuseExistingEntry = Boolean(entry?.sessionId) && (justDoManagedReplySession || typeof entry?.updatedAt === "number" && Number.isFinite(entry.updatedAt));`,
    `${filePath}: managed chat-reply classification`,
  );
  updated = replaceUniquePattern(
    updated,
    /([ \t]*)const effectiveFreshEntry = ([^\r\n;]+);/,
    (_match, indent, nativeExpression) =>
      `${indent}const effectiveFreshEntry = preserveJustDoManagedReplySession || (${nativeExpression});`,
    `${filePath}: managed chat-reply identity reuse`,
  );
  verifyReplyContent(updated, filePath);
  return updated;
}

function locateTargets(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const commandFiles = findFilesContaining(runtimeDir, [
    'function resolveSession(opts)',
    'clearRotatedSessionMetadata(sessionEntry)',
  ]);
  const agentFiles = findFilesContaining(runtimeDir, [
    'const buildSessionPatch = (freshEntry) =>',
    'resolveFailedSessionTranscriptMissingForEntry',
  ]);
  const replyFiles = findFilesContaining(runtimeDir, [
    'const canReuseExistingEntry = Boolean(entry?.sessionId)',
    'const effectiveFreshEntry =',
    'const previousSessionEntry = (resetTriggered || !effectiveFreshEntry)',
  ]);
  if (commandFiles.length !== expected) {
    throw new Error(
      `managed command-session target count is ${commandFiles.length}, expected ${expected}`,
    );
  }
  if (agentFiles.length !== expected) {
    throw new Error(
      `managed Gateway-session target count is ${agentFiles.length}, expected ${expected}`,
    );
  }
  if (replyFiles.length !== expected) {
    throw new Error(
      `managed chat-reply target count is ${replyFiles.length}, expected ${expected}`,
    );
  }
  return { commandFiles, agentFiles, replyFiles };
}

function applyPatch(runtimeDir) {
  const { commandFiles, agentFiles, replyFiles } = locateTargets(runtimeDir);
  const commandSet = new Set(commandFiles);
  const agentSet = new Set(agentFiles);
  const replySet = new Set(replyFiles);
  const staged = [...new Set([...commandFiles, ...agentFiles, ...replyFiles])].map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;
    if (commandSet.has(filePath)) updated = transformCommand(updated, filePath);
    if (agentSet.has(filePath)) updated = transformAgent(updated, filePath);
    if (replySet.has(filePath)) updated = transformReply(updated, filePath);
    return { filePath, original, updated };
  });
  const changed = [];
  for (const { filePath, original, updated } of staged) {
    if (writeIfChanged(filePath, original, updated)) {
      changed.push(path.relative(runtimeDir, filePath));
    }
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const { commandFiles, agentFiles, replyFiles } = locateTargets(runtimeDir);
  for (const filePath of commandFiles) {
    verifyCommandContent(fs.readFileSync(filePath, 'utf8'), filePath);
  }
  for (const filePath of agentFiles) {
    verifyAgentContent(fs.readFileSync(filePath, 'utf8'), filePath);
  }
  for (const filePath of replyFiles) {
    verifyReplyContent(fs.readFileSync(filePath, 'utf8'), filePath);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { transformCommand, transformAgent, transformReply },
};
