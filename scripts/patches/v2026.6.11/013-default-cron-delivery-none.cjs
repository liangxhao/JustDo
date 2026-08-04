'use strict';

// Purpose: Make agent-turn cron jobs created through the bundled Gateway's
// native cron tool add/update operations stay in JustDo by default when the
// model omits delivery or emits a targetless announce that cannot resolve an
// external destination.
// Affected OpenClaw version: v2026.6.11.
// Risk: This changes the native cron tool default for every agent conversation
// served by JustDo's bundled Gateway. A targetless announce without an
// inferable external conversation destination is treated as in-app-only.
// Remove when: OpenClaw exposes a configurable default cron delivery mode.
// Upstream tracking: TODO(openclaw): request a configurable cron delivery default.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const ORIGINAL_DELIVERY_HELP = '  - isolated agentTurn default when omitted: "announce"';
const LEGACY_PATCHED_DELIVERY_HELP =
  '  - JustDo default when omitted for agentTurn jobs: "none" (results remain available in the in-app inbox)';
const PATCHED_DELIVERY_HELP =
  `${LEGACY_PATCHED_DELIVERY_HELP}\n` +
  '  - JustDo targetless announce add/update requests fall back to "none" when no external destination can be inferred';

const ORIGINAL_CANONICAL_JOB = `          const canonicalJob = canonicalizeCronToolObject(params.job);
          assertNoCronCommandPayload(canonicalJob);`;
const PATCHED_CANONICAL_JOB = `          const canonicalJob = canonicalizeCronToolObject(params.job);
          if (canonicalJob && typeof canonicalJob === "object" && canonicalJob.delivery == null && canonicalJob.payload?.kind === "agentTurn") {
            canonicalJob.delivery = { mode: "none" };
          }
          assertNoCronCommandPayload(canonicalJob);`;

const ORIGINAL_CONTEXT_DELIVERY = `              if (inferred) job.delivery = {
                ...inferred,
                ...delivery
              };
            }
          }
          const contextMessages = readNonNegativeIntegerParam(params, "contextMessages") ?? 0;`;
const PATCHED_CONTEXT_DELIVERY = `              if (inferred) job.delivery = {
                ...inferred,
                ...delivery
              };
            }
            const resolvedDelivery = isRecord2(job.delivery) ? job.delivery : void 0;
            const resolvedMode = normalizeLowercaseStringOrEmpty(typeof resolvedDelivery?.mode === "string" ? resolvedDelivery.mode : "");
            const resolvedHasTarget = typeof resolvedDelivery?.channel === "string" && resolvedDelivery.channel.trim() || typeof resolvedDelivery?.to === "string" && resolvedDelivery.to.trim();
            if (resolvedMode === "announce" && !resolvedHasTarget) {
              job.delivery = { mode: "none" };
            }
          }
          const contextMessages = readNonNegativeIntegerParam(params, "contextMessages") ?? 0;`;

const ORIGINAL_UPDATE_PATCH = `          const patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;
          if (recoveredFlatPatch && isEmptyRecoveredCronPatch(patch)) throw new Error("patch required");`;
const PATCHED_UPDATE_PATCH = `          const patch = normalizeCronJobPatch(canonicalPatch) ?? canonicalPatch;
          if (patch && typeof patch === "object" && isRecord2(patch.delivery)) {
            const deliveryMode = normalizeLowercaseStringOrEmpty(typeof patch.delivery.mode === "string" ? patch.delivery.mode : "");
            const deliveryHasTarget = typeof patch.delivery.channel === "string" && patch.delivery.channel.trim() || typeof patch.delivery.to === "string" && patch.delivery.to.trim();
            if (deliveryMode === "announce" && !deliveryHasTarget) {
              const inferred = resolveCronCreationDelivery({
                cfg: getRuntimeConfig(),
                currentDeliveryContext: opts?.currentDeliveryContext,
                agentSessionKey: opts?.agentSessionKey
              });
              patch.delivery = inferred ? { ...inferred, ...patch.delivery } : { ...patch.delivery, mode: "none" };
            }
          }
          if (recoveredFlatPatch && isEmptyRecoveredCronPatch(patch)) throw new Error("patch required");`;

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
  if (
    !content.includes(PATCHED_DELIVERY_HELP) &&
    content.includes(LEGACY_PATCHED_DELIVERY_HELP)
  ) {
    content = replaceExactlyOnce(
      content,
      LEGACY_PATCHED_DELIVERY_HELP,
      PATCHED_DELIVERY_HELP,
      'legacy cron delivery help',
      filePath,
    );
  }
  const targets = [
    [ORIGINAL_DELIVERY_HELP, PATCHED_DELIVERY_HELP, 'cron delivery help'],
    [ORIGINAL_CANONICAL_JOB, PATCHED_CANONICAL_JOB, 'cron add default delivery'],
    [
      ORIGINAL_CONTEXT_DELIVERY,
      PATCHED_CONTEXT_DELIVERY,
      'cron targetless announce fallback',
    ],
    [ORIGINAL_UPDATE_PATCH, PATCHED_UPDATE_PATCH, 'cron update targetless announce fallback'],
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

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [
    PATCHED_DELIVERY_HELP,
    PATCHED_CANONICAL_JOB,
    PATCHED_CONTEXT_DELIVERY,
    PATCHED_UPDATE_PATCH,
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) throw new Error(`Default cron delivery patch is incomplete: ${missing.length} replacement(s) missing`);
  return true;
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    ORIGINAL_DELIVERY_HELP,
    LEGACY_PATCHED_DELIVERY_HELP,
    PATCHED_DELIVERY_HELP,
    ORIGINAL_CANONICAL_JOB,
    PATCHED_CANONICAL_JOB,
    ORIGINAL_CONTEXT_DELIVERY,
    PATCHED_CONTEXT_DELIVERY,
    ORIGINAL_UPDATE_PATCH,
    PATCHED_UPDATE_PATCH,
  },
};
