import { describe, expect, test } from 'vitest';

import { hasOnlyModelDefaultChanges } from './modelDefaultConfigChange';

const config = {
  models: { providers: { internal: { baseUrl: 'http://model.test/v1', models: [{ id: 'first' }, { id: 'second' }] } } },
  agents: {
    defaults: { model: { primary: 'internal/first' }, modelSelectionScope: 'session' },
    entries: { main: { model: { primary: 'internal/first' } }, review: { model: 'internal/first' } },
  },
  tools: { exec: { mode: 'ask' } },
  plugins: { entries: { optional: { enabled: false } } },
};

describe('hasOnlyModelDefaultChanges', () => {
  test('recognizes changed model defaults without mutating either configuration', () => {
    const previous = structuredClone(config);
    const next = structuredClone(config);
    next.agents.defaults.model.primary = 'internal/second';
    next.agents.entries.main.model.primary = 'internal/second';
    next.agents.entries.review.model = 'internal/second';
    const expectedNext = structuredClone(next);

    expect(hasOnlyModelDefaultChanges(previous, next)).toBe(true);
    expect(previous).toEqual(config);
    expect(next).toEqual(expectedNext);
  });

  test.each(['catalog', 'endpoint', 'permissions', 'plugins', 'agent', 'policy'] as const)(
    'keeps reconciliation when %s also changes', kind => {
      const next = structuredClone(config);
      next.agents.defaults.model.primary = 'internal/second';
      if (kind === 'catalog') next.models.providers.internal.models.pop();
      if (kind === 'endpoint') next.models.providers.internal.baseUrl = 'http://other.test/v1';
      if (kind === 'permissions') next.tools.exec.mode = 'full';
      if (kind === 'plugins') next.plugins.entries.optional.enabled = true;
      if (kind === 'agent') Reflect.deleteProperty(next.agents.entries, 'review');
      if (kind === 'policy') next.agents.defaults.modelSelectionScope = 'agent';

      expect(hasOnlyModelDefaultChanges(config, next)).toBe(false);
    },
  );

  test('requires an existing configuration and accepts an unchanged default', () => {
    expect(hasOnlyModelDefaultChanges(null, config)).toBe(false);
    expect(hasOnlyModelDefaultChanges(config, structuredClone(config))).toBe(true);
  });
});
