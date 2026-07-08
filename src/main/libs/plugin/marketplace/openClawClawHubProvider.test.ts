import { expect, test, vi } from 'vitest';

import { MarketplaceSourceId, PluginKind } from '../../../../shared/pluginMarketplace';
import type { OpenClawRuntimeAdapter } from '../../agentEngine/openclawRuntimeAdapter';
import { OpenClawClawHubProvider } from './openClawClawHubProvider';

const createAdapter = () =>
  ({
    requestGateway: vi.fn(async (method: string) => {
      if (method === 'skills.search') {
        return {
          results: [
            {
              slug: 'writer',
              name: 'Writer',
              description: 'Writes text',
              version: '1.2.3',
              author: 'ClawHub',
            },
          ],
        };
      }
      return {
        slug: 'writer',
        name: 'Writer',
        description: 'Writes text',
        version: '1.2.3',
        readme: '# Writer',
        install: { requires: { bins: ['node'], env: ['WRITER_TOKEN'] } },
      };
    }),
    installSkill: vi.fn(async () => ({ ok: true })),
  }) as unknown as OpenClawRuntimeAdapter;

test('maps ClawHub skill search results to the common plugin model', async () => {
  const adapter = createAdapter();
  const provider = new OpenClawClawHubProvider(() => adapter);

  const results = await provider.search({ kind: PluginKind.SKILL, query: 'writer', limit: 10 });

  expect(results).toEqual([
    {
      id: 'writer',
      kind: PluginKind.SKILL,
      name: 'Writer',
      description: 'Writes text',
      version: '1.2.3',
      author: 'ClawHub',
      tags: undefined,
      homepage: undefined,
      sourceId: MarketplaceSourceId.DEFAULT,
    },
  ]);
  expect(adapter.requestGateway).toHaveBeenCalledWith('skills.search', {
    query: 'writer',
    limit: 10,
  });
});

test('maps detail requirements and installs through OpenClaw', async () => {
  const adapter = createAdapter();
  const provider = new OpenClawClawHubProvider(() => adapter);

  const detail = await provider.getDetail({
    sourceId: MarketplaceSourceId.DEFAULT,
    pluginId: 'writer',
    kind: PluginKind.SKILL,
  });
  await provider.install({
    sourceId: MarketplaceSourceId.DEFAULT,
    pluginId: 'writer',
    kind: PluginKind.SKILL,
    version: '1.2.3',
  });

  expect(detail?.requirements).toEqual({ bins: ['node'], env: ['WRITER_TOKEN'] });
  expect(adapter.installSkill).toHaveBeenCalledWith({
    source: 'clawhub',
    slug: 'writer',
    version: '1.2.3',
    force: undefined,
  });
});
