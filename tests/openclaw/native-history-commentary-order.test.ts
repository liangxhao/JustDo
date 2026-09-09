import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { transformSync } from 'esbuild';

const patch = require('../../scripts/patches/v2026.9.2/018-mixed-tool-commentary-order.cjs');
const distRoot = path.resolve(
  process.env.JUSTDO_TEST_HISTORY_RUNTIME ?? 'vendor/openclaw-runtime/current',
  'dist',
);
const runtimeFile = fs.existsSync(distRoot)
  ? fs
      .readdirSync(distRoot)
      .filter(name => /^session-transcript-readers-.*\.js$/u.test(name))
      .map(name => path.join(distRoot, name))
      .find(filename =>
        fs.readFileSync(filename, 'utf8').includes('function sanitizeChatHistoryMessages('),
      )
  : undefined;
const commentary = (text: string, id = 'commentary-order') => ({
  type: 'text',
  text,
  textSignature: JSON.stringify({ v: 1, id, phase: 'commentary' }),
});
const thinking = { type: 'thinking', thinking: 'The workers are ready; collect their results.' };
const tool = {
  type: 'toolCall',
  id: 'outer-wait',
  name: 'tool_call',
  arguments: { name: 'agents_wait' },
};
const mixed = (content: unknown[], extra = {}) => ({
  role: 'assistant',
  timestamp: 1000,
  stopReason: 'toolUse',
  __openclaw: { id: 'message-order', runId: 'run-order', reason: 'existing-reason' },
  content,
  ...extra,
});
const fixtures = {
  ordered: mixed([thinking, commentary('Collecting the workers now.'), tool]),
  interleaved: mixed([
    thinking,
    commentary('First'),
    tool,
    thinking,
    commentary('Second'),
    { ...tool, id: 'second' },
  ]),
  repeated: mixed([
    thinking,
    commentary('First', 'same'),
    tool,
    thinking,
    commentary('Second', 'same'),
    { ...tool, id: 'second' },
  ]),
  silent: mixed([thinking, commentary('NO_REPLY'), tool]),
  cap: mixed([thinking, commentary('x'.repeat(200)), tool]),
  error: mixed([thinking, commentary('Do not recover this'), tool], {
    stopReason: 'error',
    errorMessage: 'Failed',
  }),
  hidden: mixed([thinking, commentary('Do not display this'), tool], { display: false }),
  pure: mixed([commentary('Ordinary commentary')], { stopReason: 'stop' }),
};
type Row = {
  content: Array<{ type: string; text?: string }>;
  __openclaw?: Record<string, unknown>;
};
type Result = {
  once: Row[];
  twice: Row[];
  full: Row[];
  native: Row[];
  disabled: Row[];
  nativeDisabled: Row[];
};

describe.skipIf(!runtimeFile)('native mixed Tool commentary history patch', () => {
  let results: Record<keyof typeof fixtures, Result>;
  let patched: string;
  beforeAll(() => {
    patched = patch.__testing.transform(fs.readFileSync(runtimeFile!, 'utf8'), runtimeFile!);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-commentary-order-test-'));
    try {
      const tempFile = path.join(tempDir, 'native-patched.mjs');
      const nativeRequire = createRequire(runtimeFile!);
      const relocated = patched.replace(
        /(from\s+|import\s*)(["'])([^"']+)\2/gu,
        (_match: string, lead: string, _quote: string, specifier: string) => {
          const resolved = specifier.startsWith('node:')
            ? specifier
            : pathToFileURL(
                specifier.startsWith('.')
                  ? path.resolve(distRoot, specifier)
                  : nativeRequire.resolve(specifier),
              ).href;
          return `${lead}${JSON.stringify(resolved)}`;
        },
      );
      fs.writeFileSync(tempFile, relocated);
      const script = `
        const current = await import(${JSON.stringify(pathToFileURL(runtimeFile!).href)});
        const patched = await import(${JSON.stringify(pathToFileURL(tempFile).href)});
        const results = {};
        for (const [name, message] of Object.entries(${JSON.stringify(fixtures)})) {
          const maxChars = name === 'cap' ? 40 : 8000;
          const opts = { includeCommentaryFallbacks: true, maxChars };
          const once = patched.D([message], maxChars, opts);
          results[name] = { once, twice: patched.D(once, maxChars),
            full: patched.T([message], opts), native: current.D([message], maxChars, opts),
            disabled: patched.D([message], maxChars), nativeDisabled: current.D([message], maxChars) };
        }
        process.stdout.write(JSON.stringify(results));
      `;
      results = JSON.parse(
        execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
          encoding: 'utf8',
          timeout: 40_000,
          maxBuffer: 1024 * 1024,
        }),
      );
    } finally {
      const resolved = path.resolve(tempDir);
      if (
        path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
        !path.basename(resolved).startsWith('justdo-commentary-order-test-')
      )
        throw new Error('Unexpected test cleanup path');
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }, 45_000);
  const blocks = (rows: Row[]) =>
    rows.flatMap(row => row.content.filter(block => block.type !== 'text' || block.text?.trim()));
  test('preserves Thinking then commentary then Tool through both sanitization passes and full projection', () => {
    for (const rows of [results.ordered.once, results.ordered.twice, results.ordered.full]) {
      expect(blocks(rows).map(block => block.type)).toEqual(['thinking', 'text', 'toolCall']);
      expect(rows).toHaveLength(1);
      expect(rows[0].__openclaw).toMatchObject({ id: 'message-order', runId: 'run-order' });
    }
  });
  test.each(['interleaved', 'repeated'] as const)(
    'preserves %s commentary by occurrence across Tools',
    name => {
      expect(blocks(results[name].full).map(block => block.type)).toEqual([
        'thinking',
        'text',
        'toolCall',
        'thinking',
        'text',
        'toolCall',
      ]);
      expect(
        blocks(results[name].full)
          .filter(block => block.type === 'text')
          .map(block => block.text),
      ).toEqual(['First', 'Second']);
    },
  );
  test('retains native silent output suppression and truncation provenance', () => {
    expect(JSON.stringify(results.silent.full)).not.toContain('NO_REPLY');
    expect(blocks(results.silent.full).map(block => block.type)).toEqual(['thinking', 'toolCall']);
    expect(results.cap.full[0].__openclaw).toMatchObject({
      truncated: true,
      reason: 'existing-reason',
    });
    expect(
      blocks(results.cap.full).find(block => block.type === 'text')?.text?.length,
    ).toBeLessThan(200);
  });
  test.each(['error', 'pure'] as const)('keeps the native %s sanitizer path unchanged', name => {
    expect(results[name].once).toEqual(results[name].native);
  });
  test('does not let a fallback lose the explicit hidden display flag', () => {
    expect(results.hidden.full).toEqual([]);
    expect(results.hidden.once).toEqual(results.hidden.nativeDisabled);
  });
  test('does not change callers that did not opt into commentary fallbacks', () => {
    for (const value of Object.values(results))
      expect(value.disabled).toEqual(value.nativeDisabled);
  });
  test('accepts only the exact current transform and its freshly generated bundle', () => {
    expect(patch.__testing.transform(patched, runtimeFile!)).toBe(patched);
    const compiled = transformSync(patched, {
      loader: 'js',
      minifyWhitespace: true,
      minifySyntax: true,
    }).code;
    expect(patch.__testing.transform(compiled, 'gateway-bundle.mjs')).toBe(compiled);
    expect(() =>
      patch.__testing.transform(
        patched.replace('message.display !== false', 'message.display !== true'),
        runtimeFile!,
      ),
    ).toThrow(/historical or partial/);
    expect(() =>
      patch.__testing.transform(
        patched.replaceAll(patch.__testing.MARKER, 'JUSTDO_ORDERED_COMMENTARY_HISTORY_OLD'),
        runtimeFile!,
      ),
    ).toThrow();
  });
  test('supports the exact locked npm worker artifact without touching the running runtime', () => {
    const worker = path.join(distRoot, 'worker', 'worker.mjs');
    if (!fs.existsSync(worker)) return;
    const transformed = patch.__testing.transform(fs.readFileSync(worker, 'utf8'), worker);
    expect(patch.__testing.transform(transformed, worker)).toBe(transformed);
  });
});
