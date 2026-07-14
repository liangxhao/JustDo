import { expect, test, vi } from 'vitest';

import { MarketplaceSourceId, PluginKind } from '../../../../shared/plugins/marketplace';
import type { OpenClawSkillService } from '../skills';
import { OpenClawClawHubProvider } from './openClawClawHubProvider';

const createSkillService = () =>
  ({
    request: vi.fn(async (method: string) => {
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
    install: vi.fn(async () => ({ ok: true })),
  }) as unknown as OpenClawSkillService;

test('maps ClawHub skill search results to the common plugin model', async () => {
  const skillService = createSkillService();
  const provider = new OpenClawClawHubProvider(skillService);

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
  expect(skillService.request).toHaveBeenCalledWith('skills.search', {
    query: 'writer',
    limit: 10,
  });
});

test('maps detail requirements and installs through OpenClaw', async () => {
  const skillService = createSkillService();
  const provider = new OpenClawClawHubProvider(skillService);

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
  expect(skillService.install).toHaveBeenCalledWith({
    source: 'clawhub',
    slug: 'writer',
    version: '1.2.3',
    force: undefined,
  });
});
