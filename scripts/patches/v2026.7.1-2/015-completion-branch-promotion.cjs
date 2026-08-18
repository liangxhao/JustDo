'use strict';

// Capability: promote a completion side branch only after its outer delivery has committed.
// Target: pristine openclaw@2026.7.1-2 SessionManager and subagent announce delivery boundary.
// Scope: required subagent_announce completions; ordinary announces and pre-commit failures do not promote.
// Safety: promotion reopens the requester transcript under its native write lock and persists a leaf control.
// Remove when: upstream exposes and invokes a post-delivery side-branch commit primitive.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils');

function expectedCopies(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
}
function findTargets(runtimeDir, needles, label) {
  const files = findFilesContaining(runtimeDir, needles);
  const expected = expectedCopies(runtimeDir);
  if (files.length !== expected)
    throw new Error(`${label} target count is ${files.length}, expected ${expected}`);
  return files;
}

function transformSessionManager(content, filePath) {
  if (content.includes('promotePromptReleasedSideBranch()')) return content;
  return replaceUnique(
    content,
    '\tgetLeafId() {\n\t\treturn this.leafId;\n\t}\n\tgetLeafEntry() {',
    `\tgetLeafId() {
\t\treturn this.leafId;
\t}
\tpromotePromptReleasedSideBranch() {
\t\tconst branchTargetId = this.promptReleasedSideBranchParentId;
\t\tif (!branchTargetId || branchTargetId === this.leafId) return false;
\t\tthis.branch(branchTargetId);
\t\tconst leafEntry = this.createLeafControl(branchTargetId);
\t\tthis.persistRecord(leafEntry);
\t\tthis.rememberLeafControl(leafEntry);
\t\treturn true;
\t}
\tgetLeafEntry() {`,
    `${filePath}: SessionManager side-branch promotion`,
  );
}

function resolveRuntimeImport(distDir, pattern, evidence, label) {
  const matches = fs
    .readdirSync(distDir)
    .filter(
      name =>
        pattern.test(name) && fs.readFileSync(path.join(distDir, name), 'utf8').includes(evidence),
    );
  if (matches.length !== 1)
    throw new Error(`${label} dependency count is ${matches.length}, expected 1`);
  return matches[0];
}

function shouldPromoteCommittedCompletion(strictCompletion, delivery) {
  return strictCompletion === true && delivery?.delivered === true;
}

const PROMOTION_FENCE_SOURCE = shouldPromoteCommittedCompletion.toString();

function transformDelivery(content, filePath) {
  if (
    /await promoteDeliveredSubagentCompletionBranch\d*\(params\.targetRequesterSessionKey\)/.test(
      content,
    )
  )
    return content;
  let updated = content;
  if (path.basename(filePath) !== 'gateway-bundle.mjs') {
    const distDir = path.dirname(filePath);
    const sessionManager = resolveRuntimeImport(
      distDir,
      /^session-manager-[^.]+\.js$/,
      'SessionManager as t',
      `${filePath}: SessionManager`,
    );
    const writeLock = resolveRuntimeImport(
      distDir,
      /^session-write-lock-[^.]+\.js$/,
      'acquireSessionWriteLock as t',
      `${filePath}: session write lock`,
    );
    updated = `import { t as SessionManager } from "./${sessionManager}";\nimport { s as resolveSessionWriteLockOptions, t as acquireSessionWriteLock } from "./${writeLock}";\n${updated}`;
  }
  const helper = `${PROMOTION_FENCE_SOURCE}
async function promoteDeliveredSubagentCompletionBranch(canonicalRequesterSessionKey) {
\tconst { cfg, entry } = loadRequesterSessionEntry(canonicalRequesterSessionKey);
\tconst sessionFile = normalizeOptionalString(entry?.sessionFile);
\tif (!sessionFile) throw new Error("subagent completion canonical promotion requires a requester transcript");
\tconst lock = await acquireSessionWriteLock({ sessionFile, ...resolveSessionWriteLockOptions(cfg), allowReentrant: true });
\ttry {
\t\tSessionManager.open(sessionFile).promotePromptReleasedSideBranch();
\t} finally {
\t\tawait lock.release();
\t}
}`;
  updated = replaceUnique(
    updated,
    'async function deliverSubagentAnnouncement(params) {',
    `${helper}\nasync function deliverSubagentAnnouncement(params) {`,
    `${filePath}: promotion helper`,
  );
  const start = updated.indexOf('async function deliverSubagentAnnouncement(params) {');
  const end = updated.indexOf('\n}\n//#endregion', start);
  if (start < 0 || end < 0)
    throw new Error(`${filePath}: unique delivery function boundary is missing`);
  const originalFunction = updated.slice(start, end + 2);
  let replacement = replaceUnique(
    originalFunction,
    'async function deliverSubagentAnnouncement(params) {\n\treturn await runSubagentAnnounceDispatch({',
    'async function deliverSubagentAnnouncement(params) {\n\tconst strictCompletion = params.expectsCompletionMessage === true && (normalizeOptionalLowercaseString(params.sourceTool) ?? "subagent_announce") === "subagent_announce";\n\tconst delivery = await runSubagentAnnounceDispatch({',
    `${filePath}: post-commit delivery capture`,
  );
  replacement = replaceUnique(
    replacement,
    '\t});\n}',
    '\t});\n\tif (shouldPromoteCommittedCompletion(strictCompletion, delivery)) await promoteDeliveredSubagentCompletionBranch(params.targetRequesterSessionKey);\n\treturn delivery;\n}',
    `${filePath}: post-commit promotion`,
  );
  return `${updated.slice(0, start)}${replacement}${updated.slice(end + 2)}`;
}

function applyPatch(runtimeDir) {
  const groups = [
    [
      findTargets(
        runtimeDir,
        ['promptReleasedSideBranchParentId', 'getLeafId() {'],
        'SessionManager',
      ),
      transformSessionManager,
    ],
    [
      findTargets(
        runtimeDir,
        ['async function deliverSubagentAnnouncement(params)', 'runSubagentAnnounceDispatch'],
        'completion delivery',
      ),
      transformDelivery,
    ],
  ];
  const staged = [];
  for (const [files, transform] of groups)
    for (const filePath of files) {
      const original = fs.readFileSync(filePath, 'utf8');
      staged.push({ filePath, original, updated: transform(original, filePath) });
    }
  const changed = [];
  for (const item of staged)
    if (writeIfChanged(item.filePath, item.original, item.updated)) changed.push(item.filePath);
  return changed;
}

function verifyPatch(runtimeDir) {
  for (const filePath of findTargets(
    runtimeDir,
    ['promptReleasedSideBranchParentId', 'getLeafId() {'],
    'SessionManager',
  )) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('promotePromptReleasedSideBranch()'))
      throw new Error(`${filePath}: promotion primitive is missing`);
    if (!content.includes('this.persistRecord(leafEntry)'))
      throw new Error(`${filePath}: promotion leaf commit is missing`);
  }
  for (const filePath of findTargets(
    runtimeDir,
    ['async function deliverSubagentAnnouncement(params)', 'runSubagentAnnounceDispatch'],
    'completion delivery',
  )) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('shouldPromoteCommittedCompletion(strictCompletion, delivery)'))
      throw new Error(`${filePath}: committed-delivery fence is missing`);
    if (
      !/await promoteDeliveredSubagentCompletionBranch\d*\(params\.targetRequesterSessionKey\)/.test(
        content,
      )
    )
      throw new Error(`${filePath}: post-commit promotion call is missing`);
  }
}

module.exports = {
  applyPatch,
  shouldPromoteCommittedCompletion,
  transformDelivery,
  transformSessionManager,
  verifyPatch,
};
