import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch, isVisibleCompletionTextMatch } =
  require('../scripts/patches/v2026.6.11/008-dedupe-visible-subagent-announces.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    isVisibleCompletionTextMatch: (expected: unknown, candidate: unknown) => boolean;
  };

const BUNDLE_FIXTURE = `function createManager(params) {
  const hasPriorRequesterDeliveryMirror = async (entry) => {
    return false;
  };
  const start = (entry, pendingPayload, requesterOrigin, latestDeliveryError) => {
    const finalizeAnnounceCleanup = (didAnnounce) => didAnnounce;
    params.runSubagentAnnounceFlow({
      childSessionKey: pendingPayload.childSessionKey,
      onDeliveryResult: (delivery) => {
        latestDeliveryError = delivery.error;
      }
    }).then((didAnnounce) => {
      finalizeAnnounceCleanup(didAnnounce);
    });
  };
  return { start, hasPriorRequesterDeliveryMirror };
}`;

test('patches the announce manager with a visible sibling completion preflight', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-subagent-dedupe-patch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).toContain('const hasPriorRequesterVisibleCompletion = async (entry)');
    expect(patched).toContain('candidate.delivery?.status === "delivered"');
    expect(patched).toContain('candidateText.includes(expectedText)');
    expect(patched).toContain('if (await hasPriorRequesterVisibleCompletion(entry)) return true');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('leaves an unsupported partial bundle unchanged', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-subagent-dedupe-partial-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    const partialFixture =
      'const hasPriorRequesterDeliveryMirror = async (entry) => { return false; };';
    fs.writeFileSync(bundlePath, partialFixture, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual([]);
    expect(fs.readFileSync(bundlePath, 'utf8')).toBe(partialFixture);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('matches only sufficiently specific completion text', () => {
  expect(
    isVisibleCompletionTextMatch(
      '生日快乐，愿你的每一天都闪闪发光，被爱包围。',
      '两个任务完成。\n\n生日快乐，愿你的每一天都闪闪发光，被爱包围。',
    ),
  ).toBe(true);
  expect(isVisibleCompletionTextMatch('done', 'The previous task is done.')).toBe(false);
  expect(
    isVisibleCompletionTextMatch(
      '生日快乐，愿你的每一天都闪闪发光，被爱包围。',
      '另一个子任务已完成，但结果不同。',
    ),
  ).toBe(false);
});
