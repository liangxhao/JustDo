import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch } = require('../scripts/patches/v2026.6.9/004-openai-content-reasoning-tags.cjs') as {
  applyPatch: (runtimeDir: string) => string[];
};

const LEGACY_STREAM = `
const appendPartitionedContent = (text, hasMirroredReasoning) => {
  const routedDeltas = hasMirroredReasoning ? reasoningTagTextPartitioner.push(text) : reasoningTagTextPartitioner.pushVisible(text);
  for (const delta of routedDeltas) if (delta.kind === "text") appendTextDelta(delta.text);
};
const flushPartitionedContent = () => {
  for (const delta of reasoningTagTextPartitioner.flush()) if (delta.kind === "text") appendTextDelta(delta.text);
};
`;

const PROVIDER_TRANSPORT_STREAM = `
const appendRoutedContentDelta = (delta) => {
  if (delta.kind === "text") appendFilteredVisibleTextDelta(delta.text);
  else appendThinkingDelta(delta);
};
const appendPartitionedVisibleDelta = (delta) => {
  if (delta.kind === "text") appendFilteredVisibleTextDelta(delta.text);
};
const routedDeltas = hasMirroredReasoning ? reasoningTagTextPartitioner.push(contentDelta.text) : reasoningTagTextPartitioner.pushVisible(contentDelta.text);
`;

test('patches both OpenAI stream paths and is idempotent', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-reasoning-patch-'));
  try {
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      `${LEGACY_STREAM}\n${PROVIDER_TRANSPORT_STREAM}`,
    );

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');

    expect(patched).toContain('appendThinkingDelta("reasoning_content", delta.text)');
    expect(patched).toContain('appendRoutedContentDelta(delta)');
    expect(patched).toContain('reasoningTagTextPartitioner.push(contentDelta.text)');
    expect(patched).not.toContain('reasoningTagTextPartitioner.pushVisible');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
