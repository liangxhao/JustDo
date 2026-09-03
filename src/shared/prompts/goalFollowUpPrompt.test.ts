import { describe, expect, it } from 'vitest';

import {
  buildGoalFollowUpPrompt,
  extractGoalFollowUpRequest,
  flattenPreviousGoalContext,
} from './goalFollowUpPrompt';

const legacyPrompt = (previousGoalContext: string, followUpRequest: string): string =>
  `/goal start ${JSON.stringify({
    type: 'goal_follow_up',
    version: 1,
    followUpRequest,
    instructions: 'legacy instructions',
    previousGoalContext,
  })}`;

describe('goalFollowUpPrompt', () => {
  it('starts a native Goal with the literal follow-up as its whole objective', () => {
    const prompt = buildGoalFollowUpPrompt(
      'Write five poems and ask a question after each one.',
      'Write one more.',
    );

    expect(prompt).toBe('/goal start Write one more.');
    expect(prompt).not.toContain('Write five poems');
    expect(extractGoalFollowUpRequest(prompt)).toBe('Write one more.');
  });

  it('preserves multiline and metacharacter content without a transport envelope', () => {
    const followUp = 'Use this exact block:\nif (ready) {\n  run();\n}\n$& <literal>';
    const prompt = buildGoalFollowUpPrompt('Previous task', `  ${followUp}  `);

    expect(prompt).toBe(`/goal start ${followUp}`);
    expect(extractGoalFollowUpRequest(prompt)).toBe(followUp);
  });

  it('keeps reading historical envelope objectives from existing transcripts', () => {
    const prompt = legacyPrompt('Write five poems.', 'Write one more.');

    expect(extractGoalFollowUpRequest(prompt)).toBe('Write one more.');
    expect(flattenPreviousGoalContext(prompt)).toBe(
      'Write five poems.\n\nPreviously completed follow-up request:\nWrite one more.',
    );
  });

  it('does not mistake unrelated text for a follow-up Goal', () => {
    expect(extractGoalFollowUpRequest('Write one more.')).toBeNull();
    expect(extractGoalFollowUpRequest('/goal start   ')).toBeNull();
  });
});
