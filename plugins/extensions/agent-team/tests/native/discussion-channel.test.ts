import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import { TEAM_DISCUSSION_CHANNEL } from '../../contracts/teamDiscussion';
import { discussionChannel } from '../../discussion/discussion-channel';

it('declares the same group channel in the native manifest and registration', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../openclaw.plugin.json', import.meta.url), 'utf8'));
  expect(manifest.channels).toEqual([TEAM_DISCUSSION_CHANNEL]);
  expect(Object.keys(manifest.channelConfigs)).toEqual([TEAM_DISCUSSION_CHANNEL]);
  expect(discussionChannel.id).toBe(TEAM_DISCUSSION_CHANNEL);
  expect(discussionChannel.meta.id).toBe(TEAM_DISCUSSION_CHANNEL);
});

it('resolves current room targets without accepting the retired channel namespace', () => {
  const messaging = discussionChannel.messaging!;
  for (const target of ['room', 'group:room', 'agent-team:group:room']) {
    expect(messaging.targetResolver!.looksLikeId!(target)).toBe(true);
    expect(messaging.normalizeTarget!(target)).toBe('room');
  }
  expect(messaging.targetResolver!.looksLikeId!('justdo-team:group:room')).toBe(false);
});
