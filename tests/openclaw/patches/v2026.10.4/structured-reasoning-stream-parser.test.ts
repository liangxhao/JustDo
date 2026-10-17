import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';

import { PRISTINE_REASONING_PARSER } from './reasoning-stream-parser-fixture';

const { transformReasoningTagPartitioner: transform, PARSER_CONTRACT } = require(
  '../../../../scripts/patches/v2026.10.4/structured-reasoning-stream.js',
);
const runtime = process.env.JUSTDO_EXECUTION_PRISTINE_DIR ?? path.resolve('vendor/openclaw-runtime/current');
const file = path.join(runtime, 'node_modules/@openclaw/ai/dist/reasoning-tag-text-partitioner-Ju9VpUGl.mjs');
const source = fs.readFileSync(file, 'utf8');
type Delta = { kind: string; text: string };
type Parser = {
  markStructured(): void;
  markStrict(): void;
  pushVisible(text: string): Delta[];
  push(text: string): Delta[];
  flush(): Delta[];
  hasPendingSyntax(): boolean;
};
let factory: () => Parser;
let nativeFactory: () => Parser;

async function loadParser(contents: string, bundle = false) {
  const result = await build({
    stdin: { contents, sourcefile: 'reasoning-parser.mjs', resolveDir: path.dirname(file) },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(file).href) },
  });
  if (bundle) return result.outputFiles[0].text;
  const loaded = { exports: {} as { t: () => Parser } };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(file), loaded, loaded.exports);
  return loaded.exports.t;
}

function parseChunks(value: string, chunks: string[] = [value], strict = false) {
  const parser = factory();
  parser.markStructured();
  if (strict) parser.markStrict();
  const updates = chunks.flatMap(chunk => parser.pushVisible(chunk));
  return { early: updates, all: [...updates, ...parser.flush()] };
}
const visible = (deltas: Delta[]) => deltas.filter(delta => delta.kind === 'text').map(delta => delta.text).join('');
const thinking = (deltas: Delta[]) => deltas.filter(delta => delta.kind === 'thinking').map(delta => delta.text).join('');

beforeAll(async () => {
  factory = await loadParser(transform(source, file)) as () => Parser;
  nativeFactory = await loadParser(source) as () => Parser;
});

describe('structured incremental reasoning parser', () => {
  it('streams ordinary content immediately and never reclassifies it because of a later orphan close', () => {
    const parser = factory();
    parser.markStructured();
    expect(visible(parser.pushVisible('Public prefix'))).toBe('Public prefix');
    expect(visible(parser.pushVisible('</think>Public suffix'))).toBe('</think>Public suffix');
    expect(parser.flush()).toEqual([]);
  });

  it.each([
    { value: 'Before <think>SECRET</think> after', expected: 'Before  after', hidden: 'SECRET' },
    { value: '<mm:think>SECRET</mm:think>SAFE', expected: 'SAFE', hidden: 'SECRET' },
    { value: '<think>SECRET', expected: '', hidden: 'SECRET' },
    { value: 'Prefix <think>SECRET', expected: 'Prefix ', hidden: 'SECRET' },
    { value: '<mm:think>SECRET', expected: '', hidden: 'SECRET' },
    { value: '<internal>SECRET</internal>SAFE', expected: 'SAFE', hidden: 'SECRET' },
    { value: '<internal>SECRET', expected: '', hidden: 'SECRET' },
    { value: '<think attr="SECRET', expected: '', hidden: 'SECRET' },
    { value: 'Before <think attr="SECRET', expected: 'Before ', hidden: 'SECRET' },
    { value: '<internal data=\'SECRET', expected: '', hidden: 'SECRET' },
    { value: '<mm:think attr="SECRET', expected: '', hidden: 'SECRET' },
    { value: '<antml:reasoning attr="SECRET', expected: '', hidden: 'SECRET' },
    { value: '<think attr="SECRET <b>', expected: '', hidden: 'SECRET' },
    { value: '<think attr="SECRET"', expected: '', hidden: 'SECRET' },
    { value: 'Before </think attr="SECRET', expected: 'Before ', hidden: 'SECRET' },
    { value: 'Before <thi', expected: 'Before ', hidden: undefined },
    { value: '<mm:thi', expected: '', hidden: undefined },
    { value: '<think data-x="a>b">SECRET</think>SAFE', expected: 'SAFE', hidden: 'SECRET' },
    { value: 'Before <think/> after', expected: 'Before  after', hidden: undefined },
    { value: 'Public <b>HTML</b>', expected: 'Public <b>HTML</b>', hidden: undefined },
    { value: 'Public <div attr="PUBLIC', expected: 'Public <div attr="PUBLIC', hidden: undefined },
    { value: '<thinkingx attr="PUBLIC', expected: '<thinkingx attr="PUBLIC', hidden: undefined },
    { value: 'Prefix </think> suffix', expected: 'Prefix </think> suffix', hidden: undefined },
    { value: 'Use `<think>literal</think>` as code.', expected: 'Use `<think>literal</think>` as code.', hidden: undefined },
    { value: '~~~xml\n<think>literal</think>\n~~~\n', expected: '~~~xml\n<think>literal</think>\n~~~\n', hidden: undefined },
    { value: '    <think>literal</think>\n', expected: '    <think>literal</think>\n', hidden: undefined },
    { value: '`<think attr="PUBLIC`', expected: '`<think attr="PUBLIC`', hidden: undefined },
    { value: '`<thi` after <think attr="SECRET', expected: '`<thi` after ', hidden: 'SECRET' },
    { value: '~~~xml\n<think attr="PUBLIC\n~~~\n', expected: '~~~xml\n<think attr="PUBLIC\n~~~\n', hidden: undefined },
    { value: 'Before <think>outer <think>inner</think> end</think> after', expected: 'Before  after', hidden: 'outer' },
  ])('preserves ownership and packetization invariance: $value', ({ value, expected, hidden }) => {
    const partitionings = [[value], [...value]];
    for (let index = 1; index < value.length; index++)
      partitionings.push([value.slice(0, index), value.slice(index)]);
    for (const chunks of partitionings) {
      const { early, all } = parseChunks(value, chunks);
      expect(visible(all), JSON.stringify(chunks)).toBe(expected);
      if (hidden) expect(visible(early)).not.toContain(hidden);
    }
  });

  it('hides an unfinished tag when the final answer and terminal share one input batch', () => {
    const parser = factory();
    parser.markStructured();
    const events = [...parser.pushVisible('<think>SECRET'), ...parser.flush()];
    expect(visible(events)).toBe('');
    expect(thinking(events)).toBe('SECRET');
  });

  it('keeps internal reasoning out of both public text and surfaced thinking', () => {
    const { all } = parseChunks('<think>outer <internal>SECRET</internal> end</think>SAFE');
    expect(visible(all)).toBe('SAFE');
    expect(thinking(all)).toBe('');
  });

  it('does not turn explicit strict admission into incremental delivery', () => {
    for (const structuredFirst of [false, true]) {
      const parser = factory();
      if (structuredFirst) parser.markStructured();
      parser.markStrict();
      if (!structuredFirst) parser.markStructured();
      expect(parser.pushVisible('PRIVATE PREFIX')).toEqual([]);
      expect(parser.pushVisible('</think>PUBLIC')).toEqual([]);
      expect(visible(parser.flush())).toBe('PUBLIC');
    }
  });

  it('keeps the original parser mode byte-for-byte compatible without structured admission', () => {
    for (const strict of [false, true]) {
      for (const value of ['Plain answer.', '<think>Fallback answer', 'Before </think> after']) {
        const native = nativeFactory();
        const current = factory();
        if (strict) { native.markStrict(); current.markStrict(); }
        const chunks = [...value];
        expect([...chunks.flatMap(chunk => current.pushVisible(chunk)), ...current.flush()])
          .toEqual([...chunks.flatMap(chunk => native.pushVisible(chunk)), ...native.flush()]);
      }
    }
  });
});

describe('structured parser patch shape', () => {
  it('applies the whole current shape atomically and remains byte-idempotent', () => {
    const current = transform(PRISTINE_REASONING_PARSER, '<parser>');
    expect(current).toContain(PARSER_CONTRACT);
    expect(transform(current, '<parser>')).toBe(current);
  });

  it.each([
    (value: string) => value.replace('structuredRecoveryMode = false', 'structuredRecoveryMode = true'),
    (value: string) => value.replace('markStructured() {structuredRecoveryMode = true;}', 'markStructured() {}'),
    (value: string) => value.replace(' || options.mode === "structured"', ''),
    (value: string) => value.replace('structuredRecoveryMode ? "structured" : "visible"', '"visible"'),
    (value: string) => value.replace('strictMode = true', 'strictMode = false'),
    (value: string) => value.replace('while (structuredScanOffset < text.length)', 'while (structuredScanOffset > text.length)'),
    (value: string) => value.replace('if (codeRegion) structuredScanOffset = codeRegion[1];', 'if (codeRegion) break;'),
  ])('rejects partial or changed structured parser shapes', mutate => {
    const current = transform(PRISTINE_REASONING_PARSER, '<parser>');
    const partial = mutate(current);
    expect(partial).not.toBe(current);
    expect(() => transform(partial, '<parser>')).toThrow();
  });

  it('verifies the actual parser after a small real esbuild bundle', async () => {
    const current = transform(source, file);
    const bundled = await loadParser(current, true) as string;
    expect(transform(bundled, 'gateway-bundle.mjs')).toBe(bundled);
  });

  it('follows the actual AI owner after esbuild renames its factory and reducer', () => {
    const aiCopy = PRISTINE_REASONING_PARSER
      .replaceAll('createReasoningTagTextPartitioner', 'createReasoningTagTextPartitioner2')
      .replaceAll('reduceReasoningText', 'reduceReasoningText2')
      .replaceAll('strictMode', 'strictMode2');
    const both = PRISTINE_REASONING_PARSER + aiCopy + `
      async function processCompletionsStream(){
        const reasoningTagTextPartitioner2 = createReasoningTagTextPartitioner2();
      }`;
    const current = transform(both, 'gateway-bundle.mjs');
    expect(current).toContain(PRISTINE_REASONING_PARSER.trim());
    expect(current.match(/markStructured\(\)/g)).toHaveLength(1);
    expect(current).toContain('strictMode2 ? "hide" : structuredRecoveryMode ? "structured" : "visible"');
    expect(transform(current, 'gateway-bundle.mjs')).toBe(current);
  });

  it('rejects a changed unclosed-recovery contract or an unexpected owner', () => {
    expect(() => transform(PRISTINE_REASONING_PARSER.replace(
      "options.mode === 'visible' && !pending.protectedClose",
      "options.mode === 'structured' || options.mode === 'visible' && !pending.protectedClose",
    ), '<parser>')).toThrow(/unclosed reasoning recovery changed/);
    expect(() => transform(PRISTINE_REASONING_PARSER + `
      async function processCompletionsStream(){
        const reasoningTagTextPartitioner = unrelatedFactory();
      }`, 'gateway-bundle.mjs')).toThrow(/owner changed/);
  });
});
