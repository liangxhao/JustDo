import fs from 'node:fs';
import path from 'node:path';

import type { Expression, SourceFile } from 'typescript';
import { describe, expect, it } from 'vitest';

const { TARGET, locate, transform } = require('../../../../scripts/patches/v2026.10.7/044-midturn-hard-context-limit.cjs').__testing as {
  TARGET: string;
  locate: (source: string) => { tree: SourceFile; condition: Expression };
  transform: (source: string) => string;
};

const target = path.join(process.env.OPENCLAW_PRISTINE_DIR ?? 'vendor/openclaw-runtime/current', TARGET);
const required = process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1';

describe.skipIf(!required && !fs.existsSync(target))('native mid-turn context limit', () => {
  it('admits requests under the model window and retains hard overflow and invalid-estimate blocking', () => {
    const source = fs.readFileSync(target, 'utf8');
    const patched = transform(source);
    const { tree, condition } = locate(patched);
    const blocks = new Function('precheck', 'params', `return ${condition.getText(tree)};`);
    const params = { midTurnPrecheck: { contextTokenBudget: 24_000 } };

    expect(blocks({ route: 'compact_only', estimatedPromptTokens: 19_312 }, params)).toBe(false);
    expect(blocks({ route: 'compact_then_truncate', estimatedPromptTokens: 24_000 }, params)).toBe(false);
    expect(blocks({ route: 'truncate_tool_results_only', estimatedPromptTokens: 24_112 }, params)).toBe(true);
    expect(blocks({ route: 'compact_only', estimatedPromptTokens: NaN }, params)).toBe(true);
    expect(transform(patched)).toBe(patched);
    expect(() => transform(patched.replace(' || precheck.estimatedPromptTokens > ', ' && precheck.estimatedPromptTokens > ')))
      .toThrow('mid-turn overflow decision changed');
  });
});
