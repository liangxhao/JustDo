import { describe, expect, test } from 'vitest';

import {
  hasOnlyModelDefaultChanges,
  matchesProjectedModelDefaults,
  projectModelDefaults,
} from './modelDefaultConfigChange';

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

describe('projectModelDefaults', () => {
  test('changes only existing model primaries and preserves native plugin, permission, credential and roster ownership', () => {
    const current = {
      ...structuredClone(config),
      secrets: { providers: { file: { source: 'file', path: 'private-secrets.json' } } },
      agents: {
        ...config.agents,
        defaults: { ...config.agents.defaults, model: { primary: 'internal/first', fallbacks: ['internal/first'] } },
        entries: { ...config.agents.entries, external: { name: 'Native external', model: 'internal/first' } },
      },
    };
    const original = structuredClone(current);

    const next = projectModelDefaults(current, 'internal/second', { main: 'internal/second', review: 'internal/first' });

    expect(current).toEqual(original);
    expect(next).toEqual({ ...original, agents: {
      ...original.agents,
      defaults: { ...original.agents.defaults, model: { primary: 'internal/second', fallbacks: ['internal/first'] } },
      entries: { ...original.agents.entries, main: { model: { primary: 'internal/second' } } },
    } });
    expect(hasOnlyModelDefaultChanges(current, next)).toBe(true);
    expect(matchesProjectedModelDefaults(next, next)).toBe(true);
    const runtime = structuredClone(next) as typeof current;
    runtime.agents.defaults.model.primary = 'internal/first';
    expect(matchesProjectedModelDefaults(next, runtime)).toBe(false);
  });

  test.each([
    ['internal/missing', { main: 'internal/missing' }],
    ['unknown/first', { main: 'unknown/first' }],
    ['internal/second', { missing: 'internal/second' }],
  ])('rejects an unavailable native route or changed roster before publication (%s)', (primary, agents) => {
    const current = structuredClone(config);
    expect(() => projectModelDefaults(current, primary, agents)).toThrow();
    expect(current).toEqual(config);
  });

  test('accepts native string/object model representations without treating other state as model defaults', () => {
    const next = projectModelDefaults(config, 'internal/second', { main: 'internal/second' });
    const runtime = structuredClone(next) as Record<string, unknown>;
    const agents = runtime.agents as { entries: Record<string, { model: unknown }> };
    agents.entries.main.model = 'internal/second';
    expect(matchesProjectedModelDefaults(next, runtime)).toBe(true);
    delete agents.entries.review;
    expect(matchesProjectedModelDefaults(next, runtime)).toBe(false);
  });
});
