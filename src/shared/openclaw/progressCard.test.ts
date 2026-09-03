import { describe, expect, test } from 'vitest';

import {
  parseProgressCardChangedEvent,
  parseProgressCardGetResult,
  progressCardIsComplete,
} from './progressCard';

describe('progress card contract', () => {
  const sessionKey = 'agent:main:justdo:session-1';

  test('parses and normalizes an authoritative Gateway card', () => {
    const card = parseProgressCardGetResult(
      {
        card: {
          sessionKey,
          revision: 4,
          updatedAt: 1_000,
          markdown: '  Tests are running.  ',
          steps: [
            { step: ' Inspect ', status: 'completed' },
            { step: 'Verify', status: 'in_progress' },
          ],
          ignored: true,
        },
      },
      sessionKey,
    );

    expect(card).toEqual({
      sessionKey,
      revision: 4,
      updatedAt: 1_000,
      markdown: '  Tests are running.  ',
      steps: [
        { step: ' Inspect ', status: 'completed' },
        { step: 'Verify', status: 'in_progress' },
      ],
    });
  });

  test('distinguishes an empty card from an invalid response', () => {
    expect(parseProgressCardGetResult({ card: null }, sessionKey)).toBeNull();
    expect(parseProgressCardGetResult({}, sessionKey)).toBeUndefined();
    expect(
      parseProgressCardGetResult(
        { card: { sessionKey: 'another-session', revision: 1, updatedAt: 1, markdown: 'x' } },
        sessionKey,
      ),
    ).toBeUndefined();
  });

  test.each([
    { steps: [] },
    { steps: [{ step: '', status: 'pending' }] },
    { steps: [{ step: 'x'.repeat(513), status: 'pending' }] },
    { steps: [{ step: 'Invalid', status: 'failed' }] },
    { markdown: { unexpected: true } },
    { markdown: 'x'.repeat(8_193) },
    {
      steps: [
        { step: 'One', status: 'in_progress' },
        { step: 'Two', status: 'in_progress' },
      ],
    },
  ])('rejects an invalid card body atomically', body => {
    expect(
      parseProgressCardGetResult(
        { card: { sessionKey, revision: 1, updatedAt: 1, ...body } },
        sessionKey,
      ),
    ).toBeUndefined();
  });

  test('accepts only JavaScript Date-range timestamps', () => {
    const cardFor = (updatedAt: number) => ({
      card: { sessionKey, revision: 1, updatedAt, markdown: 'Working' },
    });
    expect(parseProgressCardGetResult(cardFor(-8_640_000_000_000_000), sessionKey)).toBeTruthy();
    expect(parseProgressCardGetResult(cardFor(8_640_000_000_000_000), sessionKey)).toBeTruthy();
    expect(
      parseProgressCardGetResult(cardFor(8_640_000_000_000_001), sessionKey),
    ).toBeUndefined();
  });

  test('parses changed and cleared notifications', () => {
    expect(parseProgressCardChangedEvent({ sessionKey, revision: 5 })).toEqual({
      sessionKey,
      revision: 5,
    });
    expect(parseProgressCardChangedEvent({ sessionKey, revision: null })).toEqual({
      sessionKey,
      revision: null,
    });
    expect(parseProgressCardChangedEvent({ sessionKey, revision: 0 })).toBeNull();
  });

  test('only treats a non-empty, fully completed checklist as dismissible', () => {
    const completed = parseProgressCardGetResult(
      {
        card: {
          sessionKey,
          revision: 1,
          updatedAt: 1,
          steps: [{ step: 'Done', status: 'completed' }],
        },
      },
      sessionKey,
    );
    const note = parseProgressCardGetResult(
      { card: { sessionKey, revision: 2, updatedAt: 2, markdown: 'Done' } },
      sessionKey,
    );
    expect(completed && progressCardIsComplete(completed)).toBe(true);
    expect(note && progressCardIsComplete(note)).toBe(false);
  });
});
