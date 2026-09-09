import { describe, expect, test, vi } from 'vitest';

import { mapGatewaySlashCommand, SlashCommandService } from './slashCommandService';

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

  test('places goal controls in the session category', () => {
    expect(mapGatewaySlashCommand({ key: 'goal', name: 'goal' })?.category).toBe('session');
  });

  test('uses the text command name with the current Gateway response shape', () => {
    expect(
      mapGatewaySlashCommand({
        name: 'goal',
        textAliases: ['/goal'],
        category: 'status',
      }),
    ).toEqual(
      expect.objectContaining({
        key: 'goal',
        category: 'session',
        tier: 'standard',
      }),
    );

    expect(
      mapGatewaySlashCommand({
        name: 'compact',
        textAliases: ['/compact'],
        category: 'session',
      }),
    ).toEqual(expect.objectContaining({ tier: 'essential' }));
  });

  test('hides compact arguments that the current sessions.compact RPC cannot forward', () => {
    expect(
      mapGatewaySlashCommand({
        key: 'compact',
        name: 'compact',
        args: [{ name: 'instructions', required: false, choices: ['keep decisions'] }],
      }),
    ).toEqual(
      expect.objectContaining({
        name: 'compact',
        args: undefined,
        argOptions: undefined,
      }),
    );
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

    await expect(
      service.list({
        agentId: 'researcher',
        sessionKey: 'agent:researcher:justdo:session-1',
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        key: 'help',
        description: 'Handled locally',
      }),
    ]);
    expect(request).toHaveBeenCalledWith('commands.list', {
      agentId: 'researcher',
      sessionKey: 'agent:researcher:justdo:session-1',
      includeArgs: true,
      scope: 'text',
    });
  });
});
