'use strict';

// Capability: make JustDo stop a terminal denial without synthetic completion messages.
// Target: pristine openclaw@2026.7.1-2 approval validation, exec follow-ups, and plugin waits.
// Scope: the explicit deny-justdo-stop decision and failed JustDo exec/node approval transport.
// Safety: stop can never fall through to execution; ordinary deny/failure behavior is unchanged.
// Remove when: upstream has a typed silent-stop decision and never fabricates approval completion.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils');

const CAPABILITY = 'justdo-approval-stop-and-failure';
const STOP_DECISION = 'deny-justdo-stop';

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

function transformShared(content, filePath) {
  if (content.includes(`value === "${STOP_DECISION}"`)) return content;
  return replaceUnique(
    content,
    `function isApprovalDecision(value) {
\treturn value === "allow-once" || value === "allow-always" || value === "deny";
}`,
    `function isApprovalDecision(value) {
\t// ${CAPABILITY}: typed stop decision
\treturn value === "allow-once" || value === "allow-always" || value === "deny" || value === "${STOP_DECISION}";
}`,
    `${filePath}: stop decision validation`,
  );
}

function transformExec(content, filePath) {
  if (
    content.includes('deniedReason: params.decision === "deny-justdo-stop" ? "justdo-stop"') &&
    content.includes('approvalDecision.deniedReason === "justdo-stop"') &&
    content.includes('deniedReason === "justdo-stop"') &&
    /if \(!isJustDoManagedApprovalSessionKey\d*\(params\.sessionKey\)\) void sendExecApprovalFollowupResult/.test(
      content,
    )
  ) {
    return content;
  }
  if (!content.includes('function isJustDoManagedApprovalSessionKey(sessionKey)')) {
    throw new Error(`${filePath}: patch 023 trusted ancestry helper is missing`);
  }
  let updated = replaceUnique(
    content,
    `function resolveBaseExecApprovalDecision(params) {
\tif (params.decision === "deny") return {
\t\tapprovedByAsk: false,
\t\tdeniedReason: "user-denied",
\t\ttimedOut: false
\t};`,
    `function resolveBaseExecApprovalDecision(params) {
\t// ${CAPABILITY}: terminal stop denial
\tif (params.decision === "deny" || params.decision === "${STOP_DECISION}") return {
\t\tapprovedByAsk: false,
\t\tdeniedReason: params.decision === "${STOP_DECISION}" ? "justdo-stop" : "user-denied",
\t\ttimedOut: false
\t};`,
    `${filePath}: terminal stop denial`,
  );
  updated = replaceUnique(
    updated,
    `const approvalDecision = await resolveApprovalForExecution(() => void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (gateway id=\${approvalId}, approval-request-failed): \${params.command}\`));`,
    `const approvalDecision = await resolveApprovalForExecution(() => {
\t\t\t\t// ${CAPABILITY}: no fabricated gateway failure completion
\t\t\t\tif (!isJustDoManagedApprovalSessionKey(params.sessionKey)) void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (gateway id=\${approvalId}, approval-request-failed): \${params.command}\`);
\t\t\t});`,
    `${filePath}: gateway transport failure suppression`,
  );
  updated = replaceUnique(
    updated,
    `if (approvalDecision.deniedReason) {
\t\t\t\tawait sendExecApprovalFollowupResult(followupTarget, \`Exec denied (gateway id=\${approvalId}, \${approvalDecision.deniedReason}): \${params.command}\`);
\t\t\t\treturn;
\t\t\t}`,
    `if (approvalDecision.deniedReason) {
\t\t\t\tif (approvalDecision.deniedReason === "justdo-stop") return;
\t\t\t\tawait sendExecApprovalFollowupResult(followupTarget, \`Exec denied (gateway id=\${approvalId}, \${approvalDecision.deniedReason}): \${params.command}\`);
\t\t\t\treturn;
\t\t\t}`,
    `${filePath}: silent gateway stop`,
  );
  updated = replaceUnique(
    updated,
    `onFailure: () => void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (node=\${target.nodeId} id=\${approvalId}, approval-request-failed): \${params.command}\`)
\t\t\t\t\t});`,
    `onFailure: () => {
\t\t\t\t\t\t\t// ${CAPABILITY}: no fabricated node failure completion
\t\t\t\t\t\t\tif (!isJustDoManagedApprovalSessionKey(params.sessionKey)) void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (node=\${target.nodeId} id=\${approvalId}, approval-request-failed): \${params.command}\`);
\t\t\t\t\t\t}
\t\t\t\t\t});`,
    `${filePath}: node transport failure suppression`,
  );
  updated = replaceUnique(
    updated,
    `if (deniedReason) {
\t\t\t\t\t\tawait sendExecApprovalFollowupResult(followupTarget, \`Exec denied (node=\${target.nodeId} id=\${approvalId}, \${deniedReason}): \${params.command}\`);
\t\t\t\t\t\treturn;
\t\t\t\t\t}`,
    `if (deniedReason) {
\t\t\t\t\t\tif (deniedReason === "justdo-stop") return;
\t\t\t\t\t\tawait sendExecApprovalFollowupResult(followupTarget, \`Exec denied (node=\${target.nodeId} id=\${approvalId}, \${deniedReason}): \${params.command}\`);
\t\t\t\t\t\treturn;
\t\t\t\t\t}`,
    `${filePath}: silent node stop`,
  );
  return updated;
}

function transformPlugin(content, filePath) {
  if (
    content.match(/const justDoStopDenied\d* = decision\d* === "deny-justdo-stop";/g)?.length ===
      2 &&
    content.match(/decision\d* === PluginApprovalResolutions\.DENY \|\| justDoStopDenied\d*/g)
      ?.length === 2
  ) {
    return content;
  }
  let updated = replaceUnique(
    content,
    `\t\t\tconst resolution = decision === PluginApprovalResolutions.ALLOW_ONCE || decision === PluginApprovalResolutions.ALLOW_ALWAYS || decision === PluginApprovalResolutions.DENY ? decision : PluginApprovalResolutions.TIMEOUT;`,
    `\t\t\tconst justDoStopDenied = decision === "${STOP_DECISION}";
\t\t\t// ${CAPABILITY}: plugin stop denial (embedded)
\t\t\tconst resolution = decision === PluginApprovalResolutions.ALLOW_ONCE || decision === PluginApprovalResolutions.ALLOW_ALWAYS || decision === PluginApprovalResolutions.DENY ? decision : justDoStopDenied ? PluginApprovalResolutions.DENY : PluginApprovalResolutions.TIMEOUT;`,
    `${filePath}: embedded plugin stop resolution`,
  );
  updated = replaceUnique(
    updated,
    `\t\t\tif (decision === PluginApprovalResolutions.DENY) return {
\t\t\t\tblocked: true,`,
    `\t\t\tif (decision === PluginApprovalResolutions.DENY || justDoStopDenied) return {
\t\t\t\tblocked: true,`,
    `${filePath}: embedded plugin stop blocks execution`,
  );
  updated = replaceUnique(
    updated,
    `\t\tconst resolution = decision === PluginApprovalResolutions.ALLOW_ONCE || decision === PluginApprovalResolutions.ALLOW_ALWAYS || decision === PluginApprovalResolutions.DENY ? decision : PluginApprovalResolutions.TIMEOUT;`,
    `\t\tconst justDoStopDenied = decision === "${STOP_DECISION}";
\t\t// ${CAPABILITY}: plugin stop denial (gateway)
\t\tconst resolution = decision === PluginApprovalResolutions.ALLOW_ONCE || decision === PluginApprovalResolutions.ALLOW_ALWAYS || decision === PluginApprovalResolutions.DENY ? decision : justDoStopDenied ? PluginApprovalResolutions.DENY : PluginApprovalResolutions.TIMEOUT;`,
    `${filePath}: gateway plugin stop resolution`,
  );
  updated = replaceUnique(
    updated,
    `\t\tif (decision === PluginApprovalResolutions.DENY) return {
\t\t\tblocked: true,`,
    `\t\tif (decision === PluginApprovalResolutions.DENY || justDoStopDenied) return {
\t\t\tblocked: true,`,
    `${filePath}: gateway plugin stop blocks execution`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const groups = [
    [
      findExactTargets(
        runtimeDir,
        ['function isApprovalDecision(value)', 'APPROVAL_ALREADY_RESOLVED_DETAILS'],
        'approval decision validator',
      ),
      transformShared,
    ],
    [
      findExactTargets(
        runtimeDir,
        ['function resolveBaseExecApprovalDecision(params)', 'approval-request-failed'],
        'exec approval lifecycle',
      ),
      transformExec,
    ],
    [
      findExactTargets(
        runtimeDir,
        ['plugin.approval.waitDecision', 'PluginApprovalResolutions.TIMEOUT'],
        'plugin approval lifecycle',
      ),
      transformPlugin,
    ],
  ];
  const staged = [];
  for (const [files, transform] of groups) {
    for (const filePath of files) {
      const original = fs.readFileSync(filePath, 'utf8');
      staged.push({ filePath, original, updated: transform(original, filePath) });
    }
  }
  const changed = [];
  for (const { filePath, original, updated } of staged) {
    if (writeIfChanged(filePath, original, updated)) changed.push(filePath);
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const contracts = [
    [
      findExactTargets(
        runtimeDir,
        ['function isApprovalDecision(value)', 'APPROVAL_ALREADY_RESOLVED_DETAILS'],
        'approval decision validator',
      ),
      [`value === "${STOP_DECISION}"`],
    ],
    [
      findExactTargets(
        runtimeDir,
        ['function resolveBaseExecApprovalDecision(params)', 'approval-request-failed'],
        'exec approval lifecycle',
      ),
      [
        'deniedReason: params.decision === "deny-justdo-stop" ? "justdo-stop"',
        /if \(!isJustDoManagedApprovalSessionKey\d*\(params\.sessionKey\)\) void sendExecApprovalFollowupResult/,
        'approvalDecision.deniedReason === "justdo-stop"',
        'deniedReason === "justdo-stop"',
      ],
    ],
    [
      findExactTargets(
        runtimeDir,
        ['plugin.approval.waitDecision', 'PluginApprovalResolutions.TIMEOUT'],
        'plugin approval lifecycle',
      ),
      [
        'decision === "deny-justdo-stop"',
        /decision\d* === PluginApprovalResolutions\.DENY \|\| justDoStopDenied\d*/,
      ],
    ],
  ];
  for (const [files, needles] of contracts) {
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const needle of needles) {
        const present = needle instanceof RegExp ? needle.test(content) : content.includes(needle);
        if (!present) throw new Error(`${filePath}: missing ${needle}`);
      }
      if (content.includes('plugin.approval.waitDecision')) {
        const stopGuards =
          content.match(
            /decision\d* === PluginApprovalResolutions\.DENY \|\| justDoStopDenied\d*/g,
          ) ?? [];
        if (stopGuards.length !== 2)
          throw new Error(
            `${filePath}: expected two plugin stop guards, found ${stopGuards.length}`,
          );
      }
    }
  }
}

module.exports = { applyPatch, transformExec, transformPlugin, transformShared, verifyPatch };
