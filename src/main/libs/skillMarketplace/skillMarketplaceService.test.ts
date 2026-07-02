import { expect, test, vi } from 'vitest';

import { SkillMarketplaceService } from './skillMarketplaceService';
import type { SkillMarketplaceProvider } from './types';

const createProvider = (): SkillMarketplaceProvider => ({
  kind: 'test',
  search: vi.fn().mockResolvedValue([]),
  getDetail: vi.fn().mockResolvedValue(null),
  install: vi.fn().mockResolvedValue({ success: true }),
});

test('normalizes search input before calling the provider', async () => {
  const provider = createProvider();
  const service = new SkillMarketplaceService(provider);

  await service.search({ query: '  calendar  ', limit: 500 });

  expect(provider.search).toHaveBeenCalledWith({ query: 'calendar', limit: 100 });
});

test('rejects an empty skill slug without calling the provider', async () => {
  const provider = createProvider();
  const service = new SkillMarketplaceService(provider);

  expect(() => service.getDetail('   ')).toThrow('Skill slug is required');
  expect(provider.getDetail).not.toHaveBeenCalled();
});

test('passes a normalized install request to the provider', async () => {
  const provider = createProvider();
  const service = new SkillMarketplaceService(provider);

  await service.install({ slug: ' calendar ', version: ' 1.2.0 ' });

  expect(provider.install).toHaveBeenCalledWith({
    slug: 'calendar',
    version: '1.2.0',
  });
});
