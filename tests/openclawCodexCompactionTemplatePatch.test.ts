import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch, CODEX_COMPACTION_MARKER, __testing } =
  require('../scripts/patches/v2026.6.11/012-codex-compaction-template.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    CODEX_COMPACTION_MARKER: string;
    __testing: Record<string, string>;
  };

test('replaces OpenClaw section templates with Codex handoff compaction', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-codex-compaction-template-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, Object.values(__testing).join('\n'), 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(patched).toContain(CODEX_COMPACTION_MARKER);
    expect(patched).not.toContain('## Goal');
    expect(patched).not.toContain('## Progress');
    expect(patched).not.toContain('## Decisions');
    expect(patched).not.toContain('## Open TODOs');
    expect(patched).not.toContain('following the exact format specified');
    expect(patched).not.toContain('<summary>');
    expect(patched).toContain(
      'Another language model started to solve this problem and produced a summary of its thinking process.',
    );
    expect(patched).toContain('COMPACTION_SUMMARY_SUFFIX = ``;');
    expect(patched).toContain('No prior conversation content was available to summarize.');
    expect(patched).toContain(
      'codexStyleCompaction ? providerId ? customInstructions : void 0 : buildCompactionStructureInstructions',
    );
    expect(patched).toContain('if (parts2?.codexStyle === true) return "";');
    expect(patched.match(/codexStyle: codexStyleCompaction/g)).toHaveLength(2);
    expect(patched).toContain(
      'sanitizeCompactionSummaryMessages([...baseMessagesToSummarize, ...turnPrefixMessages])',
    );
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
