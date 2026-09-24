import { expect, test, vi } from 'vitest';

import { OpenClawSkillService } from './openclawSkillService';

test('refreshes skills for the product main assistant rather than the native default agent', async () => {
  const requestGateway = vi.fn().mockResolvedValue({ skills: [] });
  const service = new OpenClawSkillService(() => ({ requestGateway }));
  await service.getStatus();
  expect(requestGateway).toHaveBeenCalledWith('skills.status', { agentId: 'main' });
  await service.getStatus('research');
  expect(requestGateway).toHaveBeenLastCalledWith('skills.status', { agentId: 'research' });
});
