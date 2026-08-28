import { describe, expect, it } from 'vitest';

import { buildLocalSessionDetailStats } from './sessionDetails';

describe('local session detail statistics', () => {
  it('filters the internal Gateway-injected model marker', () => {
    const stats = buildLocalSessionDetailStats({
      messages: [
        {
          id: 'assistant-1',
          type: 'assistant',
          content: 'First response',
          modelName: 'custom0/deepseek-v4-flash',
        },
        {
          id: 'assistant-2',
          type: 'assistant',
          content: 'Injected response',
          modelName: 'openclaw/gateway-injected',
        },
      ],
    });

    expect(stats.models).toEqual(['custom0/deepseek-v4-flash']);
  });
});
