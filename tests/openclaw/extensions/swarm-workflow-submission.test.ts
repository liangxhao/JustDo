import { expect, it } from 'vitest';

import {
  SUBMISSION_LIMITS,
  lastSubmissionError,
  validateSubmission,
} from '../../../openclaw-extensions/swarm-workflow/submission';

it.each(['complete', 'blocked', 'verified'] as const)(
  'normalizes evidence text and derives an omitted %s summary only from submitted evidence',
  outcome => {
    const fields = {
      evidence: '  Source inspected; test not run.  ',
      ...(outcome === 'verified' ? { passed: false } : {}),
    };
    const result = validateSubmission(outcome, fields);
    expect(result).toEqual({
      outcome,
      summary: 'Source inspected; test not run.',
      evidence: ['Source inspected; test not run.'],
      ...(outcome === 'verified' ? { passed: false } : {}),
    });
    const { outcome: _outcome, ...canonical } = result;
    expect(validateSubmission(outcome, canonical)).toEqual(result);
  },
);

it('accepts evidence-only lists without inventing a conclusion and retains explicit summaries', () => {
  expect(
    validateSubmission('complete', { evidence: ['file.ts:10', 'Tests were not run'] }).summary,
  ).toBe('file.ts:10\nTests were not run');
  expect(
    validateSubmission('complete', { summary: '  Limited inspection  ', evidence: 'file.ts:10' }),
  ).toEqual({ outcome: 'complete', summary: 'Limited inspection', evidence: ['file.ts:10'] });
});

it('bounds long evidence reports into canonical references and an independently bounded summary', () => {
  const report = 'x'.repeat(SUBMISSION_LIMITS.evidenceReport);
  const result = validateSubmission('complete', { evidence: report });
  expect(result.evidence.join('')).toBe(report);
  expect(result.evidence).toHaveLength(6);
  expect(result.evidence.every(item => item.length <= SUBMISSION_LIMITS.evidenceItem)).toBe(true);
  expect(result.summary).toHaveLength(SUBMISSION_LIMITS.summary);
  const { outcome: _outcome, ...canonical } = result;
  expect(validateSubmission('complete', canonical)).toEqual(result);
});

it('does not split surrogate pairs or retain whitespace-only chunks when normalizing reports', () => {
  const report = 'x'.repeat(1999) + '😀' + 'y'.repeat(2000);
  const result = validateSubmission('complete', { evidence: report });
  expect(result.evidence.join('')).toBe(report);
  expect(result.evidence[0]).toHaveLength(1999);
  const { outcome: _outcome, ...canonical } = result;
  expect(validateSubmission('complete', canonical)).toEqual(result);
  const whitespace = validateSubmission('complete', { evidence: 'x' + ' '.repeat(6000) + 'y' });
  expect(whitespace.evidence.every(item => item.trim())).toBe(true);
  const { outcome: _ignored, ...normalized } = whitespace;
  expect(validateSubmission('complete', normalized)).toEqual(whitespace);
});

it.each(
  [
    undefined,
    '',
    ' ',
    [],
    [''],
    [' '],
    [1],
    {},
    true,
    ['x'.repeat(2001)],
    Array(17).fill('file'),
    'x'.repeat(12001),
  ].map(evidence => ({ evidence })),
)('rejects absent, invalid or oversized evidence %#', ({ evidence }) => {
  expect(() => validateSubmission('complete', { evidence })).toThrow(/evidence/);
});

it.each([undefined, 'true', 'false', 1, null])(
  'never infers or coerces a verification verdict %#',
  passed => {
    expect(() => validateSubmission('verified', { evidence: 'file checked', passed })).toThrow(
      /boolean/,
    );
  },
);

it('requires evidence even with an explicit passing verdict and rejects caller-supplied identities', () => {
  expect(() => validateSubmission('verified', { passed: true })).toThrow(/evidence/);
  expect(() => validateSubmission('complete', { evidence: 'file', nodeId: 'foreign' })).toThrow(
    /identity/,
  );
  expect(() => validateSubmission('complete', { evidence: 'file', runId: 'foreign' })).toThrow(
    /identity/,
  );
});

it.each([null, '', ' ', 1, 'x'.repeat(4001)])(
  'rejects a malformed explicitly supplied summary %#',
  summary => {
    expect(() => validateSubmission('complete', { evidence: 'file', summary })).toThrow(/summary/);
  },
);

it('retains the serialized handoff bound after normalization', () => {
  expect(() =>
    validateSubmission('complete', { evidence: Array(16).fill('x'.repeat(2000)) }),
  ).toThrow(/handoff limit/);
  expect(() => validateSubmission('complete', { evidence: '"'.repeat(12000) })).toThrow(
    /handoff limit/,
  );
});

it('feeds back the latest owned native submission error without treating unrelated tool output as instructions', () => {
  const messages = [
    {
      role: 'toolResult',
      toolName: 'swarm_workflow_complete',
      isError: true,
      content: [{ type: 'text', text: 'First submission error' }],
    },
    {
      role: 'custom',
      customType: 'openclaw.nested-tool.v1',
      details: {
        runId: 'run',
        toolName: 'openclaw:swarm-workflow:swarm_workflow_complete',
        isError: true,
        result: { content: [{ type: 'text', text: 'evidence must be array' }] },
      },
    },
    {
      role: 'toolResult',
      toolName: 'read',
      isError: true,
      content: [{ type: 'text', text: 'Unrelated file error' }],
    },
    {
      role: 'custom',
      customType: 'openclaw.nested-tool.v1',
      details: {
        runId: 'foreign',
        toolName: 'swarm_workflow_complete',
        isError: true,
        result: { content: [{ type: 'text', text: 'Foreign submission error' }] },
      },
    },
  ];
  expect(lastSubmissionError(messages, 'run')).toBe('evidence must be array');
  expect(
    lastSubmissionError(
      [
        {
          role: 'toolResult',
          toolName: 'tool_call',
          isError: true,
          content: 'Invalid arguments for openclaw:swarm-workflow:swarm_workflow_complete',
        },
      ],
      'run',
    ),
  ).toContain('Invalid arguments');
  expect(
    lastSubmissionError([{ role: 'assistant', content: 'swarm_workflow_complete failed' }], 'run'),
  ).toBeUndefined();
  expect(
    lastSubmissionError(
      [
        {
          role: 'toolResult',
          toolName: 'exec',
          isError: true,
          content: 'swarm_workflow_complete failed',
        },
      ],
      'run',
    ),
  ).toBeUndefined();
  expect(
    lastSubmissionError(
      [
        {
          role: 'toolResult',
          toolName: 'swarm_workflow_complete',
          isError: true,
          content: 'x'.repeat(3000),
        },
      ],
      'run',
    ),
  ).toHaveLength(2000);
});
