import { expect, it } from 'vitest';

import {
  defaultAgentTeamSettings,
  effectiveDiscussionDefaults,
  parseAgentTeamOverrides,
  parseAgentTeamSettings,
  parseDiscussionResources,
  resolveDiscussionResources,
} from './agentTeamSettings';

it('preserves previous defaults and treats automatic values as bounded inheritance', () => {
  const value = defaultAgentTeamSettings();
  expect(parseAgentTeamSettings(value)).toEqual(value);
  expect(resolveDiscussionResources({ version: 1, revision: 2, value }, {}, 3, 2)).toEqual({
    settingsRevision: 2,
    maxRounds: 4,
    maxTurns: 6,
    maxConcurrent: 3,
  });
  value.discussion.maxTurns = 5;
  value.discussion.maxConcurrent = 2;
  expect(
    resolveDiscussionResources(
      { version: 1, revision: 3, value },
      { maxTurns: 24, maxConcurrent: 6 },
      6,
      4,
    ),
  ).toMatchObject({ maxTurns: 5, maxConcurrent: 2 });
});
it.each([0, 7, 2.5, NaN, Infinity, '2', undefined])(
  'rejects malformed member limit %s',
  maxMembers => {
    const value = defaultAgentTeamSettings();
    expect(() =>
      parseAgentTeamSettings({ ...value, discussion: { ...value.discussion, maxMembers } }),
    ).toThrow('agentTeamSettingsInvalid');
  },
);
it('rejects unknown fields, illegal automatic values and incompatible default rounds', () => {
  const value = defaultAgentTeamSettings();
  expect(() => parseAgentTeamSettings({ ...value, enabled: true })).toThrow();
  expect(() =>
    parseAgentTeamSettings({ ...value, discussion: { ...value.discussion, maxRounds: 1 } }),
  ).toThrow('agentTeamSettingsRoundsConflict');
  expect(() => parseAgentTeamOverrides({ maxConcurrent: null }, 'discussion')).toThrow();
  expect(() => parseAgentTeamOverrides({ defaultRounds: 2 }, 'collaboration')).toThrow();
  expect(() =>
    parseDiscussionResources({
      settingsRevision: -1,
      maxRounds: 4,
      maxTurns: 24,
      maxConcurrent: 6,
    }),
  ).toThrow();
});
it('rejects explicit excessive rounds while clamping old team preferences after global tightening', () => {
  const value = defaultAgentTeamSettings();
  value.discussion.maxRounds = 1;
  value.discussion.defaultRounds = 1;
  expect(effectiveDiscussionDefaults(value, { defaultRounds: 4 }).defaultRounds).toBe(1);
  expect(() => resolveDiscussionResources({ version: 1, revision: 0, value }, {}, 2, 2)).toThrow(
    'agentTeamSettingsRoundsExceeded',
  );
});
