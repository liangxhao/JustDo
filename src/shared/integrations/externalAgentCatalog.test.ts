import { describe, expect, test } from 'vitest';

import {
  defineExternalAgentCatalog,
  ExternalAgentCommandToken,
  getExternalAgentCliCommand,
} from './externalAgentCatalog';

describe('external agent build-time catalog', () => {
  test('accepts a bundled custom adapter template', () => {
    expect(
      defineExternalAgentCatalog([
        {
          id: 'example-agent',
          name: 'Example Agent',
          cliCommand: 'example-agent',
          defaultEnabled: false,
          adapter: {
            command: ExternalAgentCommandToken.NodeExecutable,
            args: [`${ExternalAgentCommandToken.AcpxPluginRoot}/adapters/example/index.mjs`],
          },
        },
      ]),
    ).toHaveLength(1);
  });

  test('rejects duplicate and unsafe ids', () => {
    const definition = {
      id: 'duplicate',
      name: 'Duplicate',
      defaultEnabled: false,
    } as const;
    expect(() => defineExternalAgentCatalog([definition, definition])).toThrow(/Duplicate/u);
    expect(() => defineExternalAgentCatalog([{ ...definition, id: '../unsafe' }])).toThrow(
      /Invalid/u,
    );
    expect(() =>
      defineExternalAgentCatalog([{ ...definition, adapter: { command: 'node', args: [''] } }]),
    ).toThrow(/argument/u);
  });

  test('uses the configured direct CLI rather than inferring a command from the agent id', () => {
    const definition = {
      id: 'example-agent',
      name: 'Example Agent',
      defaultEnabled: false,
      adapter: { command: 'example-cli', args: ['acp'] },
    };

    expect(getExternalAgentCliCommand(definition)).toBe('example-cli');
    expect(getExternalAgentCliCommand({ ...definition, adapter: { command: 'renamed-cli' } })).toBe(
      'renamed-cli',
    );
  });

  test('shows the installed CLI behind a bundled adapter and hides internal launchers', () => {
    const definition = {
      id: 'example-agent',
      name: 'Example Agent',
      defaultEnabled: false,
      adapter: {
        command: ExternalAgentCommandToken.NodeExecutable,
        args: [`${ExternalAgentCommandToken.AcpxPluginRoot}/adapters/example/index.mjs`],
      },
    };

    expect(getExternalAgentCliCommand({ ...definition, cliCommand: 'example-cli' })).toBe(
      'example-cli',
    );
    expect(getExternalAgentCliCommand(definition)).toBeUndefined();
    expect(
      getExternalAgentCliCommand({
        ...definition,
        adapter: { command: `${ExternalAgentCommandToken.AcpxPluginRoot}/bin/adapter.exe` },
      }),
    ).toBeUndefined();
    expect(getExternalAgentCliCommand({ ...definition, adapter: undefined })).toBeUndefined();
  });

  test('rejects invalid explicit CLI metadata', () => {
    const definition = { id: 'example-agent', name: 'Example Agent', defaultEnabled: false };

    expect(() => defineExternalAgentCatalog([{ ...definition, cliCommand: ' ' }])).toThrow(
      /CLI command/u,
    );
    expect(() => defineExternalAgentCatalog([{ ...definition, cliCommand: 'cli\0' }])).toThrow(
      /CLI command/u,
    );
  });
});
