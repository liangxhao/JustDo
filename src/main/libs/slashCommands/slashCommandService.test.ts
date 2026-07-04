import { describe, expect, test, vi } from 'vitest';

import {
  mapGatewaySlashCommand,
  SlashCommandService,
} from './slashCommandService';

describe('mapGatewaySlashCommand', () => {
  test('normalizes gateway metadata into the shared command contract', () => {
    expect(
      mapGatewaySlashCommand({
        key: 'export-session',
        name: 'ignored',
        textAliases: ['/Export', '/save'],
        description: 'Export the session',
        args: [
          {
            name: 'format',
            required: true,
            choices: ['markdown', { value: 'json' }, { value: 1 }],
          },
        ],
        tier: 'power',
      }),
    ).toEqual({
      key: 'export-session',
      name: 'export',
      aliases: ['save'],
      description: 'Export the session',
      args: '<format>',
      category: 'tools',
      executeLocal: true,
      argOptions: ['markdown', 'json'],
      tier: 'power',
    });
  });

  test('returns null when an entry has no usable name', () => {
    expect(mapGatewaySlashCommand({ textAliases: [null, 1] })).toBeNull();
  });
});

describe('SlashCommandService', () => {
  test('passes agent scope to the gateway and applies policies in order', async () => {
    const request = vi.fn().mockResolvedValue({
      commands: [
        { key: 'help', name: 'help' },
        { key: 'secret', name: 'secret' },
      ],
    });
    const service = new SlashCommandService({
      getGatewayClient: () => ({
        start: vi.fn(),
        stop: vi.fn(),
        request,
      }),
      policies: [
        { include: command => command.key !== 'secret' },
        {
          transform: command => ({
            ...command,
            description: 'Handled locally',
          }),
        },
      ],
    });

    await expect(service.list({ agentId: 'researcher' })).resolves.toEqual([
      expect.objectContaining({
        key: 'help',
        description: 'Handled locally',
      }),
    ]);
    expect(request).toHaveBeenCalledWith('commands.list', {
      agentId: 'researcher',
      includeArgs: true,
      scope: 'text',
    });
  });
});
