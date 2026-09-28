import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { parseInput, parseResult } from '../../openclaw-extensions/typesafe/src/schema';

const script = path.resolve('resources/skills/jev-batch-evaluate/scripts/batch_evaluate.py');
const python = ['python', 'python3'].find(command => {
  const probe = spawnSync(command, [
    '-c',
    'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)',
  ]);
  return !probe.error && probe.status === 0;
});
if (!python) throw new Error('The Jev batch tests require Python 3.10+ (python or python3).');
let root: string;
const rubric = {
  questions: {
    category: { type: 'choice', criteria: { bug: 'Broken', request: 'New capability' } },
    urgency: { type: 'score', criteria: ['Low', 'High'] },
    actionable: { type: 'noul', instructions: 'Can this be acted on?' },
  },
};
const write = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(root, name), JSON.stringify(value));
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
function run(...args: string[]) {
  const result = spawnSync(python, ['-X', 'utf8', script, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  return { code: result.status, value: JSON.parse(result.stdout) };
}
function prepare(...args: string[]) {
  return run(
    'prepare',
    '--input',
    'input.json',
    '--field',
    'text',
    '--id-column',
    'id',
    '--rubric',
    'rubric.json',
    '--output-dir',
    'plan',
    ...args,
  );
}
function respond(batch = 1, mutate?: (value: any) => void) {
  const id = `batch-${String(batch).padStart(4, '0')}`;
  const request = read(`plan/${id}.request.json`);
  // Parse every generated request with the unmodified native TypeSafe schema.
  expect(() => parseInput(request)).not.toThrow();
  const answers = Object.fromEntries(
    Object.entries(request.questions).map(([key, raw]) => {
      const question = raw as any;
      const answer =
        question.type === 'choice'
          ? {
              type: 'choice',
              choice: 'bug',
              confidence: 0.7,
              probabilities: { bug: 0.8, request: 0.2 },
            }
          : question.type === 'score'
            ? {
                type: 'score',
                score: 0.6,
                confidence: 0.6,
                probabilities: { 0: 0.4, 1: 0.6 },
                legend: { 0: 'Low', 1: 'High' },
              }
            : { type: 'noul', noul: 0.5 };
      return [key, answer];
    }),
  );
  const value = {
    evaluation: { model: 'jev-latest', answers, usage: { input_tokens: 20, output_tokens: 10 } },
  };
  expect(() => parseResult(value.evaluation, parseInput(request))).not.toThrow();
  mutate?.(value);
  write(`plan/${id}.response.json`, value);
}
const merge = () => run('merge', '--plan-dir', 'plan', '--output-dir', 'results');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev 中文 '));
  write('input.json', [
    { id: '=source', text: '登录失败', private: 'do not send' },
    { id: 2, text: '增加导出' },
  ]);
  write('rubric.json', rubric);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('preserves IDs, native values and privacy while counting usage once per batch', () => {
  expect(prepare().code).toBe(0);
  const request = read('plan/batch-0001.request.json');
  expect(JSON.stringify(request)).not.toContain('do not send');
  expect(JSON.stringify(request)).not.toContain('=source');
  respond();
  expect(merge()).toMatchObject({
    code: 0,
    value: { complete: true, usage: { input_tokens: 20, output_tokens: 10 } },
  });
  const results = read('results/results.json');
  expect(results.records.map((r: any) => r.id)).toEqual(['=source', 2]);
  expect(results.records[0].answers.urgency.score).toBe(0.6);
  expect(results.records[0].review.status).toBe('not_assessed');
  expect(fs.readFileSync(path.join(root, 'results/results.csv'), 'utf8')).toContain("'=source");
  expect(merge().code).toBe(1);
  expect(read('results/results.json')).toEqual(results);
});

test('supports BOM CSV with quoted newlines and selected fields', () => {
  fs.writeFileSync(
    path.join(root, 'input.csv'),
    '\ufeffid,text,private\r\na,"第一行\n第二行",secret\r\n',
  );
  expect(prepare('--input', 'input.csv').code).toBe(0);
  expect(read('plan/batch-0001.request.json').state.records.r000001).toEqual({
    text: '第一行\n第二行',
  });
  respond();
  expect(merge().code).toBe(0);
});

test('flags selected-label disagreement and explicit review rules without rewriting answers', () => {
  write('rubric.json', {
    ...rubric,
    review: {
      category: { min_probability: 0.7 },
      urgency: { min_score: 1 },
      actionable: { uncertain_interval: [0.4, 0.6] },
    },
  });
  expect(prepare().code).toBe(0);
  respond(1, value => {
    for (const answer of Object.values(value.evaluation.answers) as any[]) {
      if (answer.type === 'choice') answer.probabilities = { bug: 0.2, request: 0.8 };
    }
  });
  expect(merge().code).toBe(0);
  const row = read('results/results.json').records[0];
  expect(row.answers.category.choice).toBe('bug');
  expect(row.review.reasons.map((r: any) => r.code)).toEqual([
    'label-not-highest-probability',
    'below-selected-label-threshold',
    'below-score-threshold',
    'inside-uncertainty-interval',
  ]);
});

test.each(['missing', 'error', 'invalid_response'])(
  'reports %s batches without invented answers',
  status => {
    expect(prepare('--batch-size', '1').value.batch_count).toBe(2);
    respond(1);
    if (status === 'error') write('plan/batch-0002.error.json', { reason: 'authentication' });
    if (status === 'invalid_response')
      respond(2, v => {
        v.evaluation.answers = {};
      });
    expect(merge()).toMatchObject({
      code: 2,
      value: { complete: false, counts: { ok: 1, [status]: 1 } },
    });
    expect(read('results/results.json').records[1].answers).toEqual({});
  },
);

test('rejects stale responses from a different dataset', () => {
  prepare();
  respond();
  const stale = read('plan/batch-0001.response.json');
  write('input.json', [{ id: 'different', text: 'different' }]);
  expect(prepare('--output-dir', 'next').code).toBe(0);
  write('next/batch-0001.response.json', stale);
  expect(run('merge', '--plan-dir', 'next', '--output-dir', 'results')).toMatchObject({
    code: 2,
    value: { counts: { invalid_response: 1 } },
  });
});

test.each(['request', 'rubric', 'path'])('rejects changed %s before writing output', target => {
  prepare();
  if (target === 'request') write('plan/batch-0001.request.json', {});
  else {
    const plan = read('plan/manifest.json');
    if (target === 'rubric') plan.rubric.questions.category.instructions = 'changed';
    else plan.batches[0].response = '../outside.json';
    write('plan/manifest.json', plan);
  }
  expect(merge().code).toBe(1);
  expect(fs.existsSync(path.join(root, 'results'))).toBe(false);
});

test.each([
  [
    { id: 1, text: 'a' },
    { id: '1', text: 'b' },
  ],
  [{ id: 'missing' }],
  [{ id: '', text: 'empty' }],
])('rejects ambiguous or incomplete source records', records => {
  write('input.json', records);
  expect(prepare().code).toBe(1);
  expect(fs.existsSync(path.join(root, 'plan'))).toBe(false);
});

test('splits bounded requests without truncation and rejects one oversized record', () => {
  write('rubric.json', { questions: { category: rubric.questions.category } });
  write(
    'input.json',
    [1, 2].map(id => ({ id, text: 'a'.repeat(400) })),
  );
  expect(prepare('--max-request-bytes', '1024').value.batch_count).toBe(2);
  expect(read('plan/batch-0002.request.json').state.records.r000002.text).toHaveLength(400);
  write('input.json', [{ id: 1, text: 'a'.repeat(2000) }]);
  expect(prepare('--max-request-bytes', '1024', '--output-dir', 'oversized').value.reason).toBe(
    'record-exceeds-request-limit',
  );
  expect(fs.existsSync(path.join(root, 'oversized'))).toBe(false);
});

test('rejects duplicate JSON keys and conflicting batch outcomes', () => {
  fs.writeFileSync(path.join(root, 'input.json'), '[{"id":1,"text":"a","text":"b"}]');
  expect(prepare().value.reason).toBe('duplicate-json-key');
  write('input.json', [{ id: 1, text: 'a' }]);
  prepare();
  respond();
  write('plan/batch-0001.error.json', { reason: 'timeout' });
  expect(merge().code).toBe(2);
  expect(read('results/results.json').records[0].failure_reason).toBe('multiple-outcomes');
});

test.each([false, true])(
  'matches native numeric legend equality without accepting booleans (%s)',
  booleanLegend => {
    // Retain the decimal spelling in the Python request; JavaScript normalizes it to 1.
    fs.writeFileSync(
      path.join(root, 'rubric.json'),
      '{"questions":{"quality":{"type":"score","criteria":[{"threshold":1.0},{"threshold":2}]}}}',
    );
    expect(prepare().code).toBe(0);
    const request = read('plan/batch-0001.request.json');
    const evaluation = {
      model: 'jev-latest',
      answers: Object.fromEntries(
        Object.keys(request.questions).map(key => [
          key,
          {
            type: 'score',
            score: 0.5,
            confidence: 0.7,
            probabilities: { 0: 0.5, 1: 0.5 },
            legend: { 0: { threshold: booleanLegend ? true : 1 }, 1: { threshold: 2 } },
          },
        ]),
      ),
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    if (booleanLegend) expect(() => parseResult(evaluation, parseInput(request))).toThrow();
    else expect(() => parseResult(evaluation, parseInput(request))).not.toThrow();
    write('plan/batch-0001.response.json', { evaluation });
    expect(merge().code).toBe(booleanLegend ? 2 : 0);
  },
);

test('rejects unsafe evidence integers while retaining large local record IDs', () => {
  fs.writeFileSync(path.join(root, 'input.json'), '[{"id":9007199254740993,"text":"a"}]');
  expect(prepare().code).toBe(0);
  respond();
  expect(merge().code).toBe(0);
  expect(fs.readFileSync(path.join(root, 'results/results.json'), 'utf8')).toContain(
    '9007199254740993',
  );
  expect(prepare('--field', 'id', '--output-dir', 'unsafe').value.reason).toBe(
    'unsafe-request-integer',
  );
  expect(fs.existsSync(path.join(root, 'unsafe'))).toBe(false);
  fs.writeFileSync(
    path.join(root, 'rubric.json'),
    '{"questions":{"quality":{"type":"score","criteria":[{"threshold":9007199254740993},"High"]}}}',
  );
  expect(prepare('--output-dir', 'unsafe-rubric').value.reason).toBe('unsafe-request-integer');
});

test('rejects an explicit empty model rather than preparing an unmergeable plan', () => {
  expect(prepare('--model', '').value.reason).toBe('invalid-model');
  expect(fs.existsSync(path.join(root, 'plan'))).toBe(false);
});

test('rejects oversized manifests before publishing a plan', () => {
  write(
    'input.json',
    Array.from({ length: 10000 }, (_, index) => ({
      id: `${index}-${'a'.repeat(1600)}`,
      text: 'a',
    })),
  );
  expect(fs.statSync(path.join(root, 'input.json')).size).toBeLessThan(16 * 1024 * 1024);
  write('rubric.json', { questions: { actionable: { type: 'noul' } } });
  expect(prepare().value.reason).toBe('manifest-too-large');
  expect(fs.existsSync(path.join(root, 'plan'))).toBe(false);
});
