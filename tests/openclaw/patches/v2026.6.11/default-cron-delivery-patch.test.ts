import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

const { applyPatch, __testing } =
  require('../../../../scripts/patches/v2026.6.11/013-default-cron-delivery-none.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    __testing: Record<string, string>;
  };

test('defaults omitted and unresolved targetless agent-turn delivery to none', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-cron-delivery-default-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      `const HELP = \`${__testing.ORIGINAL_DELIVERY_HELP}\`;
function canonicalizeCronToolObject(job) {
  return structuredClone(job);
}
function assertNoCronCommandPayload() {}
function isRecord2(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function normalizeLowercaseStringOrEmpty(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
let inferredDelivery;
function resolveCronCreationDelivery() {
  return inferredDelivery;
}
function getRuntimeConfig() {
  return {};
}
function readNonNegativeIntegerParam() {
  return 0;
}
function normalizeCronJobPatch(patch) {
  return structuredClone(patch);
}
function isEmptyRecoveredCronPatch() {
  return false;
}
export function normalizeForAdd(params) {
${__testing.ORIGINAL_CANONICAL_JOB}
  return canonicalJob;
}
export function resolveForAdd(job, inferredResult) {
  inferredDelivery = inferredResult;
  const opts = { agentSessionKey: "agent:main:test" };
  const cfg = {};
  const params = {};
  if ((opts?.agentSessionKey || opts?.currentDeliveryContext) && job && typeof job === "object" && "payload" in job && job.payload?.kind === "agentTurn") {
    const deliveryValue = job.delivery;
    const delivery = isRecord2(deliveryValue) ? deliveryValue : void 0;
    const mode = normalizeLowercaseStringOrEmpty(typeof delivery?.mode === "string" ? delivery.mode : "");
    const hasTarget = typeof delivery?.channel === "string" && delivery.channel.trim() || typeof delivery?.to === "string" && delivery.to.trim();
    if ((deliveryValue == null || delivery) && (mode === "" || mode === "announce") && !hasTarget) {
      const inferred = resolveCronCreationDelivery({
        cfg,
        currentDeliveryContext: opts.currentDeliveryContext,
        agentSessionKey: opts.agentSessionKey
      });
${__testing.ORIGINAL_CONTEXT_DELIVERY}
  void contextMessages;
  return job;
}
export function normalizeForUpdate(params, inferredResult) {
  inferredDelivery = inferredResult;
  const opts = { agentSessionKey: "agent:main:test" };
  const recoveredFlatPatch = false;
  const canonicalPatch = canonicalizeCronToolObject(params.patch);
${__testing.ORIGINAL_UPDATE_PATCH}
  return patch;
}
void HELP;
`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(patched).toContain(__testing.PATCHED_DELIVERY_HELP);
    expect(patched).toContain('canonicalJob.delivery = { mode: "none" }');
    expect(patched).toContain('canonicalJob.delivery == null');
    expect(patched).toContain('canonicalJob.payload?.kind === "agentTurn"');
    expect(patched).toContain('resolvedMode === "announce" && !resolvedHasTarget');
    expect(patched).toContain('job.delivery = { mode: "none" }');
    expect(applyPatch(runtimeDir)).toEqual([]);

    const harness = (await import(
      `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
    )) as {
      normalizeForAdd: (params: { job: Record<string, unknown> }) => {
        delivery?: { mode: string };
      };
      resolveForAdd: (
        job: Record<string, unknown>,
        inferred: Record<string, unknown> | null,
      ) => { delivery?: Record<string, unknown> };
      normalizeForUpdate: (
        params: { patch: Record<string, unknown> },
        inferred: Record<string, unknown> | null,
      ) => { delivery?: Record<string, unknown> };
    };

    expect(
      harness.normalizeForAdd({
        job: { payload: { kind: 'agentTurn', message: 'remind me' } },
      }).delivery,
    ).toEqual({ mode: 'none' });

    expect(
      harness.resolveForAdd(
        {
          payload: { kind: 'agentTurn', message: 'remind me' },
          delivery: { mode: 'announce' },
        },
        null,
      ).delivery,
    ).toEqual({ mode: 'none' });

    expect(
      harness.resolveForAdd(
        {
          payload: { kind: 'agentTurn', message: 'remind me' },
          delivery: { mode: 'announce' },
        },
        { mode: 'announce', channel: 'slack', to: 'chat-1' },
      ).delivery,
    ).toEqual({ mode: 'announce', channel: 'slack', to: 'chat-1' });

    expect(
      harness.resolveForAdd(
        {
          payload: { kind: 'agentTurn', message: 'remind me' },
          delivery: { mode: 'announce', channel: 'teams', to: 'chat-2' },
        },
        null,
      ).delivery,
    ).toEqual({ mode: 'announce', channel: 'teams', to: 'chat-2' });

    expect(
      harness.resolveForAdd(
        {
          payload: { kind: 'agentTurn', message: 'post result' },
          delivery: { mode: 'webhook', to: 'https://example.com/hook' },
        },
        null,
      ).delivery,
    ).toEqual({ mode: 'webhook', to: 'https://example.com/hook' });

    expect(
      harness.normalizeForUpdate(
        { patch: { delivery: { mode: 'announce' } } },
        null,
      ).delivery,
    ).toEqual({ mode: 'none' });

    expect(
      harness.normalizeForUpdate(
        { patch: { delivery: { mode: 'announce' } } },
        { mode: 'announce', channel: 'slack', to: 'chat-3' },
      ).delivery,
    ).toEqual({ mode: 'announce', channel: 'slack', to: 'chat-3' });

    expect(
      harness.normalizeForUpdate(
        {
          patch: {
            delivery: { mode: 'announce', channel: 'teams', to: 'chat-4' },
          },
        },
        null,
      ).delivery,
    ).toEqual({ mode: 'announce', channel: 'teams', to: 'chat-4' });

    expect(
      harness.normalizeForUpdate(
        {
          patch: {
            delivery: { mode: 'webhook', to: 'https://example.com/update-hook' },
          },
        },
        null,
      ).delivery,
    ).toEqual({ mode: 'webhook', to: 'https://example.com/update-hook' });
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('upgrades the prior omitted-only patch idempotently', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-cron-delivery-upgrade-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      [
        __testing.LEGACY_PATCHED_DELIVERY_HELP,
        __testing.PATCHED_CANONICAL_JOB,
        __testing.ORIGINAL_CONTEXT_DELIVERY,
        __testing.ORIGINAL_UPDATE_PATCH,
      ].join('\n'),
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(patched.split(__testing.PATCHED_DELIVERY_HELP)).toHaveLength(2);
    expect(patched).toContain(__testing.PATCHED_CANONICAL_JOB);
    expect(patched).toContain(__testing.PATCHED_CONTEXT_DELIVERY);
    expect(patched).toContain(__testing.PATCHED_UPDATE_PATCH);
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
