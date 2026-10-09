import { describe, expect, test } from 'vitest';

import { defineExternalAgentCatalog, ExternalAgentCommandToken } from './externalAgentCatalog';

describe('external agent build-time catalog', () => {
  test('accepts a bundled custom adapter template', () => {
    expect(
      defineExternalAgentCatalog([
        {
          id: 'example-agent',
          name: 'Example Agent',
          descriptionKey: 'externalAgentsExampleDescription',
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
      descriptionKey: 'duplicateDescription',
      defaultEnabled: false,
    } as const;
    expect(() => defineExternalAgentCatalog([definition, definition])).toThrow(/Duplicate/u);
    expect(() =>
      defineExternalAgentCatalog([{ ...definition, id: '../unsafe' }]),
    ).toThrow(/Invalid/u);
    expect(() =>
      defineExternalAgentCatalog([
        { ...definition, adapter: { command: 'node', args: [''] } },
      ]),
    ).toThrow(/argument/u);
  });
});
