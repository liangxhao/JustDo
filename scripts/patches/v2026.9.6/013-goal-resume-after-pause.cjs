'use strict';

// Capability: resume a paused Goal whose preceding run was intentionally aborted.
// Target: openclaw@2026.9.6 restart-safe chat admission for native Goal resume.
// Scope: Goal resume only; new Goals and ordinary chat retain the native abort guard.
// Safety: all native idle, freshness, routing, hierarchy, and active-work checks remain required.
// Remove when: upstream Goal resume admits an idle paused session after its run is aborted.


const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged, assertCurrentPatchContract } = require('./_patch-utils.js');
const MARKER = 'JUSTDO_GOAL_RESUME_ABORTED_GUARD_V2026_9_6';
function transform(content, filePath) {
  assertCurrentPatchContract(content, MARKER, filePath, false);
  const source = /entry\.abortedLastRun\s*!==\s*true\s*&&\s*entry\.archivedAt/;
  const worker = /([\w$]+)\.abortedLastRun===!0\|\|\1\.archivedAt/;
  if (/allowAbortedLastRun:\s*[\w$]+\.goalOperation\?\.action\s*===\s*"resume"/.test(content) && /[\w$]+\.allowAbortedLastRun\s*(?:===|!==)\s*true/.test(content)) {

    return content;
  }
  const fn = content.slice(content.indexOf('async function admitChatSend('));
  const binding = /\{\s*request(?:\s*:\s*([\w$]+))?\s*,\s*session/.exec(fn);
  if (!binding) throw new Error('Goal request binding missing');
  content = replaceUniquePattern(content, /resolveRestartSafeChatAdmission\(\{/, match => match + 'allowAbortedLastRun: ' + (binding[1] || 'request') + '.goalOperation?.action === "resume",', filePath);
  if (source.test(content)) return replaceUniquePattern(content, source, '(entry.abortedLastRun !== true || params.allowAbortedLastRun === true)/*' + MARKER + '*/ && entry.archivedAt', filePath);
  return replaceUniquePattern(content, worker, '($1.abortedLastRun===!0 && Ot.allowAbortedLastRun !== true)/*' + MARKER + '*/||$1.archivedAt', filePath);
}
function processTargets(root, verify) {
  // The admission passes the full request separately below; retain an exact caller check.
  const targets = findFilesContaining(root, ['function isRestartSafeChatSession(', 'resolveRestartSafeChatAdmission']);
  if (targets.length !== (fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 4 : 3)) throw new Error('Goal resume target count changed');
  return targets.flatMap(file => { const before = fs.readFileSync(file, 'utf8'); const after = transform(before, file); if (verify && before !== after) throw new Error('Goal resume missing'); return !verify && writeIfChanged(file, before, after) ? [path.relative(root, file)] : []; });
}
module.exports = { applyPatch: root => processTargets(root, false), verifyPatch: root => processTargets(root, true), __testing: { transform } };
