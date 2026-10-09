import { describe, expect, test } from 'vitest';

import { getSlashCommandCompletions, mergeAppSlashCommands, SLASH_COMMANDS } from './slashCommands';

describe('composer slash commands', () => {
  test('does not add the retired Plan command when Gateway commands refresh', () => {
    const commands = mergeAppSlashCommands([
      {
        key: 'compact',
        name: 'compact',
        description: 'Compact the session.',
        category: 'session',
      },
    ]);

    expect(commands.map(command => command.name)).toEqual(['compact']);
    expect(getSlashCommandCompletions('pla', { commands })).toEqual([]);
    expect(SLASH_COMMANDS.map(command => command.name)).not.toContain('plan');
  });

  test('hides the retired Plan command even when the Gateway advertises it', () => {
    const gatewayPlan = {
      key: 'plan',
      name: 'plan',
      description: 'Gateway Plan command.',
      category: 'session' as const,
    };

    expect(mergeAppSlashCommands([gatewayPlan])).toEqual([]);
  });

  test('removes the retired Plan alias from a Gateway command', () => {
    expect(
      mergeAppSlashCommands([
        {
          key: 'future',
          name: 'future',
          aliases: ['plan', 'later'],
          description: 'Future command.',
        },
      ]),
    ).toEqual([expect.objectContaining({ name: 'future', aliases: ['later'] })]);
  });

  test('keeps the internal side-chat protocol out of the user command menu', () => {
    const commands = mergeAppSlashCommands([
      {
        key: 'btw',
        name: 'btw',
        aliases: ['side'],
        description: 'Internal side question.',
      },
      {
        key: 'future',
        name: 'future',
        aliases: ['btw', 'later'],
        description: 'Future command.',
      },
    ]);

    expect(commands.map(command => command.name)).not.toContain('btw');
    expect(commands).toContainEqual(
      expect.objectContaining({ name: 'future', aliases: ['later'] }),
    );
    expect(SLASH_COMMANDS.map(command => command.name)).not.toContain('btw');
  });
});
