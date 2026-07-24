import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, test } from 'vitest';

const { applyPatch: applyFinalSystemPromptPatch } =
  require('../scripts/patches/v2026.6.11/015-final-system-prompt-replacements.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
  };
const { applyPatch: applyLiveContextPatch, __testing: LIVE_CONTEXT_TESTING } =
  require('../scripts/patches/v2026.6.11/014-live-context-budget-status.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    __testing: Record<string, string>;
  };
const LIVE_CONTEXT_PATCHED_ATTEMPT_START = LIVE_CONTEXT_TESTING.PATCHED_ATTEMPT_START;

const originalRulesPath = process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH;

afterEach(() => {
  if (originalRulesPath === undefined) {
    delete process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH;
  } else {
    process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH = originalRulesPath;
  }
});

const BUNDLE_FIXTURE = `async function persistJustDoLiveContextBudgetStatus(params) {
  return params;
}
async function runEmbeddedAttempt(params) {
  let systemPromptText = params.systemPrompt;
  const setActiveSessionSystemPrompt = (nextSystemPrompt) => {
    systemPromptText = nextSystemPrompt;
  };
          const systemPromptForHook = systemPromptText;
  return systemPromptForHook;
}
export { runEmbeddedAttempt };
`;

test('applies ordered regex rules to the final system prompt only', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-final-prompt-patch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    const rulesPath = path.join(runtimeDir, 'system-prompt-replacements.json');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    fs.writeFileSync(
      rulesPath,
      JSON.stringify([
        {
          id: 'remove-unused',
          pattern: '\\n## Unused[\\s\\S]*?(?=\\n## Keep|$)',
          flags: 'g',
          replacement: '',
          enabled: true,
        },
        {
          id: 'rename',
          pattern: 'Original',
          flags: 'g',
          replacement: 'Replacement',
          enabled: true,
        },
      ]),
      'utf8',
    );
    process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH = rulesPath;

    expect(applyFinalSystemPromptPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(applyFinalSystemPromptPatch(runtimeDir)).toEqual([]);

    const moduleUrl = `${pathToFileURL(bundlePath).href}?test=${Date.now()}`;
    const runtime = (await import(moduleUrl)) as {
      runEmbeddedAttempt: (params: { systemPrompt: string }) => Promise<string>;
    };
    await expect(
      runtime.runEmbeddedAttempt({
        systemPrompt: 'Original\n## Unused\nremove me\n## Keep\nkeep me',
      }),
    ).resolves.toBe('Replacement\n## Keep\nkeep me');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('fails loudly when the upstream finalization anchor changes', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-final-prompt-mismatch-'));
  try {
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      'async function persistJustDoLiveContextBudgetStatus(params) {}\nasync function runEmbeddedAttempt(params) {}',
      'utf8',
    );
    expect(() => applyFinalSystemPromptPatch(runtimeDir)).toThrow(
      /final system prompt replacement.*not found/i,
    );
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('preserves the adjacent live-context patch anchor', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-final-prompt-order-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      `${LIVE_CONTEXT_PATCHED_ATTEMPT_START}
  let systemPromptText = params.systemPrompt;
  const setActiveSessionSystemPrompt = (nextSystemPrompt) => {
    systemPromptText = nextSystemPrompt;
  };
          const systemPromptForHook = systemPromptText;
}
`,
      'utf8',
    );

    expect(applyFinalSystemPromptPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(fs.readFileSync(bundlePath, 'utf8')).toContain(LIVE_CONTEXT_PATCHED_ATTEMPT_START);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('keeps the live-context publisher idempotent after helper insertion', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-patch-order-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      `${LIVE_CONTEXT_PATCHED_ATTEMPT_START}
  let systemPromptText = params.systemPrompt;
  const setActiveSessionSystemPrompt = (nextSystemPrompt) => {
    systemPromptText = nextSystemPrompt;
  };
          const systemPromptForHook = systemPromptText;
}
${LIVE_CONTEXT_TESTING.PATCHED_MIDTURN_PUBLISH}
${LIVE_CONTEXT_TESTING.PATCHED_MIDTURN_OPTIONS}
${LIVE_CONTEXT_TESTING.PATCHED_INITIAL_PUBLISH}
`,
      'utf8',
    );

    expect(applyFinalSystemPromptPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(applyLiveContextPatch(runtimeDir)).toEqual([]);

    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched.match(/async function persistJustDoLiveContextBudgetStatus/g)).toHaveLength(1);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
