import { afterEach, expect, it, vi } from 'vitest';

const template = vi.hoisted(() => ({ value: '' }));
vi.mock('../../../../resources/openclaw/docs/reference/templates/AGENTS.md?raw', () => ({
  get default() { return template.value; },
}));

afterEach(() => vi.resetModules());

it.each([
  { name: 'LF', newline: '\n' },
  { name: 'CRLF', newline: '\r\n' },
  { name: 'CR', newline: '\r' },
])('keeps the role editor baseline identical across $name template checkouts', async ({ newline }) => {
  template.value = ['', '# Baseline', '', 'Keep existing work.', 'Finish.', ''].join(newline);

  const { assistantTranslations } = await import('./assistantTranslations');

  for (const language of ['zh', 'en'] as const) {
    expect(assistantTranslations[language].agentTemplateBaseRules)
      .toBe('# Baseline\n\nKeep existing work.\nFinish.');
  }
});
