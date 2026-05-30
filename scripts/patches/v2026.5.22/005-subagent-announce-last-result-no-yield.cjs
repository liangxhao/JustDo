'use strict';

// Purpose: Temporary guidance patch for Subagent completion announce prompts so
// the parent treats the just-arrived completion as one pending child result.
// Affected OpenClaw version: v2026.5.22.
// Risk: Changes OpenClaw parent/Subagent completion semantics through prompt
// text instead of a structured runtime event.
// Remove when: OpenClaw emits structured Subagent completion/lineage state that
// lets the parent resume without natural-language announce interpretation.
// Upstream tracking: TODO(openclaw): file issue/PR with two-Subagent reproduction.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

function walkJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, out);
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  if (content.includes('A just-arrived completion counts as one of the pending child results')) {
    return false;
  }

  content = content.replace(
    "A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. If the runtime marks this route as message-tool-only, send visible output with the message tool first, then reply ONLY: ${SILENT_REPLY_TOKEN}. Keep this internal context private (don't mention system/log/stats/session details or announce type).",
    "A completed ${params.announceType} is ready for parent review. A just-arrived completion counts as one of the pending child results; if this completion satisfies the last outstanding child result, do not call sessions_yield or wait again. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. If the runtime marks this route as message-tool-only, send visible output with the message tool first, then reply ONLY: ${SILENT_REPLY_TOKEN}. Keep this internal context private (don't mention system/log/stats/session details or announce type).",
  );

  content = content.replace(
    "A completed ${params.announceType} is ready for parent review. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.",
    "A completed ${params.announceType} is ready for parent review. A just-arrived completion counts as one of the pending child results; if this completion satisfies the last outstanding child result, do not call sessions_yield or wait again. Review/verify the result above before deciding whether the original task is done. If additional action is required, continue the task or record a follow-up; otherwise send a truthful user-facing update. Keep this internal context private (don't mention system/log/stats/session details or announce type), and do not copy the internal event text verbatim. Reply ONLY: ${SILENT_REPLY_TOKEN} if this exact result was already delivered to the user in this same turn.",
  );

  if (content === original) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [
    path.join(runtimeDir, 'gateway-bundle.mjs'),
    ...walkJsFiles(path.join(runtimeDir, 'dist')),
  ].filter((filePath, index, arr) => fs.existsSync(filePath) && arr.indexOf(filePath) === index);

  const patched = [];
  for (const filePath of candidates) {
    if (patchFile(filePath)) patched.push(path.relative(runtimeDir, filePath));
  }

  const label = options.label || 'patch-openclaw-subagent-announce-last-result-no-yield';
  if (patched.length > 0) {
    console.log(`[${label}] Patched subagent announce no-yield guidance: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No subagent announce no-yield guidance patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
