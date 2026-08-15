import { describe, expect, it } from 'vitest';

import {
  buildGoalFollowUpPrompt,
  extractGoalFollowUpRequest,
  flattenPreviousGoalContext,
} from './goalFollowUpPrompt';

interface PromptEnvelope {
  followUpRequest: string;
  instructions: string;
  previousGoalContext: string;
}

const readEnvelope = (prompt: string): PromptEnvelope =>
  JSON.parse(prompt.slice('/goal start '.length)) as PromptEnvelope;

const normalizeLikeOpenClaw = (prompt: string): string => {
  const firstLine = prompt.trim().split('\n', 1)[0];
  const [, , ...objectiveParts] = firstLine.split(/\s+/);
  return `/goal start ${objectiveParts.join(' ')}`;
};

describe('goalFollowUpPrompt', () => {
  it('makes an additive follow-up the sole task and the previous goal context-only', () => {
    const prompt = buildGoalFollowUpPrompt(
      'Write five poems and ask a question after each one.',
      'Write one more.',
    );
    const envelope = readEnvelope(prompt);

    expect(envelope.followUpRequest).toBe('Write one more.');
    expect(envelope.instructions).toContain('create only the requested additional output');
    expect(envelope.previousGoalContext).toBe(
      'Write five poems and ask a question after each one.',
    );
    expect(prompt).not.toContain('\n');
    expect(prompt).not.toContain('<follow_up_request>');
    expect(prompt).not.toContain('Incrementally improve');
    expect(prompt).not.toContain('justdo-');
  });

  it('survives OpenClaw command normalization and exposes only the current request', () => {
    const prompt = buildGoalFollowUpPrompt(
      '写5首诗，每首写完，随意写和提问',
      '再来一首',
    );
    const normalized = normalizeLikeOpenClaw(prompt);

    expect(normalized).toBe(prompt);
    expect(extractGoalFollowUpRequest(normalized)).toBe('再来一首');
    expect(readEnvelope(normalized).previousGoalContext).toBe(
      '写5首诗，每首写完，随意写和提问',
    );
  });

  it('survives the JSON-string wrapper used for the model continuation prompt', () => {
    const command = buildGoalFollowUpPrompt('/tmp/reports goal', 'Add /tmp/reports/example.md');
    const canonicalObjective = command.slice('/goal start '.length);
    const modelBody = `Pursue this goal exactly as written from this JSON string: ${JSON.stringify(canonicalObjective).replace(/\//g, '\\/')}`;
    const encodedObjective = modelBody.slice(modelBody.indexOf(': ') + 2);
    const decodedObjective = JSON.parse(encodedObjective.replace(/\\\//g, '/')) as string;

    expect(extractGoalFollowUpRequest(`/goal start ${decodedObjective}`)).toBe(
      'Add /tmp/reports/example.md',
    );
    expect(readEnvelope(`/goal start ${decodedObjective}`).previousGoalContext).toBe(
      '/tmp/reports goal',
    );
  });

  it('preserves an explicit full-rewrite request as the authoritative follow-up', () => {
    const prompt = buildGoalFollowUpPrompt('Write the report.', 'Rewrite the entire report.');

    expect(extractGoalFollowUpRequest(prompt)).toBe('Rewrite the entire report.');
    expect(readEnvelope(prompt).instructions).toContain(
      'unless the follow-up request explicitly asks for it',
    );
  });

  it('round-trips multiline code and tag-like user content exactly', () => {
    const previousGoal =
      'Explain <follow_up_request>old</follow_up_request> syntax without changing it.';
    const followUp =
      'Use this exact block:\nif (ready) {\n  run();\n}\n<follow_up_request>literal</follow_up_request>';
    const prompt = buildGoalFollowUpPrompt(previousGoal, followUp);
    const normalized = normalizeLikeOpenClaw(prompt);

    expect(extractGoalFollowUpRequest(normalized)).toBe(followUp);
    expect(readEnvelope(normalized).previousGoalContext).toBe(previousGoal);
  });

  it('inserts dollar sequences literally instead of treating them as replacement patterns', () => {
    const prompt = buildGoalFollowUpPrompt('Keep $& in the goal.', 'Add the literal $& token.');
    const envelope = readEnvelope(prompt);

    expect(envelope.followUpRequest).toBe('Add the literal $& token.');
    expect(envelope.previousGoalContext).toBe('Keep $& in the goal.');
  });

  it('flattens repeated follow-ups instead of nesting the previous control template', () => {
    const sixthPoemGoal = buildGoalFollowUpPrompt('写5首诗', '再来一首');
    const seventhPoemGoal = buildGoalFollowUpPrompt(
      sixthPoemGoal.slice('/goal start '.length),
      '再来一首',
    );
    const seventhEnvelope = readEnvelope(seventhPoemGoal);
    const flattened = flattenPreviousGoalContext(seventhPoemGoal);

    expect(seventhEnvelope.previousGoalContext).toBe(
      '写5首诗\n\nPreviously completed follow-up request:\n再来一首',
    );
    expect(flattened.match(/Previously completed follow-up request:/g)).toHaveLength(2);
    expect(seventhEnvelope.previousGoalContext).not.toContain('instructions');
  });
});
