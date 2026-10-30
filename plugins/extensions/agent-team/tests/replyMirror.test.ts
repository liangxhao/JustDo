import { describe, expect, test } from 'vitest';
import { isTeamDiscussionReplyMirror } from '../app/history/messagePresentation';

describe('isTeamDiscussionReplyMirror', () => {
  const mirror = {
    role: 'assistant',
    provider: 'openclaw',
    model: 'delivery-mirror',
    content: [{ type: 'text', text: 'A public group reply.' }],
    openclawDeliveryMirror: {
      kind: 'channel-final',
      sourceMessageId: 'agent-team:room:discussion:1',
    },
    openclawDelivery: { speakerAgentId: 'review', mediaUrls: [] },
  };

  test('recognizes public mirrors independently of text, speaker or envelope', () => {
    expect(isTeamDiscussionReplyMirror(mirror)).toBe(true);
    expect(isTeamDiscussionReplyMirror({ message: mirror })).toBe(true);
    expect(
      isTeamDiscussionReplyMirror({
        ...mirror,
        content: [],
        openclawDelivery: { speakerAgentId: 'main', mediaUrls: ['report.pdf'] },
      }),
    ).toBe(true);
  });

  test.each([
    { role: 'user' },
    { provider: 'model-provider' },
    { model: 'real-model' },
    { openclawDeliveryMirror: { ...mirror.openclawDeliveryMirror, kind: 'channel-input' } },
    { openclawDelivery: undefined },
    { openclawDelivery: { speakerAgentId: '' } },
    { openclawDelivery: { speakerAgentId: 'invalid:agent' } },
  ])('keeps ordinary or incomplete records with the same text: %o', fields => {
    expect(isTeamDiscussionReplyMirror({ ...mirror, ...fields })).toBe(false);
  });

  test.each([
    undefined,
    'slack:room:discussion:1',
    'agent-team:room:discussion',
    'agent-team:room:discussion:0',
    'agent-team:room:discussion:01',
    'agent-team:room:discussion:1.5',
    'agent-team:room:discussion:9007199254740992',
    'agent-team:room:discussion:1:extra',
    'agent-team::discussion:1',
    'agent-team:room:invalid/discussion:1',
  ])('keeps mirrors without an exact group output locator: %s', sourceMessageId => {
    expect(
      isTeamDiscussionReplyMirror({
        ...mirror,
        openclawDeliveryMirror: { ...mirror.openclawDeliveryMirror, sourceMessageId },
      }),
    ).toBe(false);
  });
});
