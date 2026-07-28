'use strict';

// Purpose: Make agent-turn cron jobs created through the bundled Gateway's
// native cron tool stay in JustDo by default when the model omits delivery.
// Affected OpenClaw version: v2026.6.11.
// Risk: This changes the native cron tool default for every agent conversation
// served by JustDo's bundled Gateway. External delivery still depends on the
// model explicitly setting delivery.mode to announce or webhook.
// Remove when: OpenClaw exposes a configurable default cron delivery mode.
// Upstream tracking: TODO(openclaw): request a configurable cron delivery default.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const ORIGINAL_DELIVERY_HELP = '  - isolated agentTurn default when omitted: "announce"';
const PATCHED_DELIVERY_HELP =
  '  - JustDo default when omitted for agentTurn jobs: "none" (results remain available in the in-app inbox)';

const ORIGINAL_CANONICAL_JOB = `          const canonicalJob = canonicalizeCronToolObject(params.job);
          assertNoCronCommandPayload(canonicalJob);`;
const PATCHED_CANONICAL_JOB = `          const canonicalJob = canonicalizeCronToolObject(params.job);
          if (canonicalJob && typeof canonicalJob === "object" && canonicalJob.delivery == null && canonicalJob.payload?.kind === "agentTurn") {
            canonicalJob.delivery = { mode: "none" };
          }
          assertNoCronCommandPayload(canonicalJob);`;

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
  const targets = [
    [ORIGINAL_DELIVERY_HELP, PATCHED_DELIVERY_HELP, 'cron delivery help'],
    [ORIGINAL_CANONICAL_JOB, PATCHED_CANONICAL_JOB, 'cron add default delivery'],
  ];

  const alreadyPatched = targets.every(([, replacement]) => content.includes(replacement));
  if (alreadyPatched) return false;

  for (const [original, replacement, description] of targets) {
    if (content.includes(replacement)) continue;
    content = replaceExactlyOnce(content, original, replacement, description, filePath);
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-default-cron-delivery-none';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring cron delivery patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Defaulted conversation-created cron jobs to in-app delivery.`);
  } else if (options.verbose) {
    console.log(`[${label}] In-app cron delivery default already applied.`);
  }
  return patched;
}

module.exports = {
  applyPatch,
  __testing: {
    ORIGINAL_DELIVERY_HELP,
    PATCHED_DELIVERY_HELP,
    ORIGINAL_CANONICAL_JOB,
    PATCHED_CANONICAL_JOB,
  },
};
