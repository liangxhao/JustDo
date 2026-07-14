import { describe, expect, test } from 'vitest';

import { type SlashCommand, SlashCommandBlacklist } from '../../../shared/slashCommands';
import { justDoSlashCommandPolicy } from './slashCommandPolicies';

const createCommand = (name: string): SlashCommand => ({
  key: name,
  name,
  description: '',
});

describe('justDoSlashCommandPolicy', () => {
  test('hides commands selected for the JustDo blacklist', () => {
    for (const name of SlashCommandBlacklist) {
      expect(
        justDoSlashCommandPolicy.include?.(createCommand(name), {
          options: {},
          source: {},
        }),
      ).toBe(false);
    }
  });

  test('hides the exec approval command', () => {
    expect(
      justDoSlashCommandPolicy.include?.(createCommand('approve'), {
        options: {},
        source: {},
      }),
    ).toBe(false);
  });
});
