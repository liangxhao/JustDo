import { describe, expect, it } from 'vitest';

import {
  AUTHOR_NAME,
  PRODUCT_NAME,
} from '../../../shared/productMetadata';
import {
  mergeRegisteredSystemPromptReplacementRules,
  REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES,
} from './systemPromptReplacementRegistry';

const applyRegisteredRules = (prompt: string): string =>
  REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES.reduce(
    (result, rule) =>
      rule.enabled === false
        ? result
        : result.replace(
            new RegExp(rule.pattern, rule.flags),
            rule.replacement,
          ),
    prompt,
  );

describe('registered system prompt replacements', () => {
  it('keeps only the useful dynamic runtime fields', () => {
    const prompt = [
      '# Agent',
      '',
      '## Runtime',
      'Runtime: agent=main | session=agent:main:justdo:a6298c3e | sessionId=c57fd921 | host=DESKTOP-43R3H1D | repo=C:\\\\Users\\\\lianghao\\\\justdo\\\\project | os=Windows_NT 10.0.26200 (x64) | node=v24.18.0 | model=custom0/deepseek-v4-flash | default_model=custom0/deepseek-v4-flash | shell=pwsh | channel=webchat | capabilities=none | thinking=medium',
      'Current model identity: custom0/deepseek-v4-flash. If asked what model you are, answer with this value for the current run.',
      'Reasoning: stream (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.',
      '',
      '## Next',
      'Keep this section.',
    ].join('\n');

    expect(applyRegisteredRules(prompt)).toBe(
      [
        '# Agent',
        '',
        '## Runtime',
        'host=DESKTOP-43R3H1D | repo=C:\\\\Users\\\\lianghao\\\\justdo\\\\project | os=Windows_NT 10.0.26200 (x64) | node=v24.18.0 | model=custom0/deepseek-v4-flash | shell=pwsh',
        '',
        '## Next',
        'Keep this section.',
      ].join('\n'),
    );
  });

  it('keeps registered rules first and authoritative by id', () => {
    const merged = mergeRegisteredSystemPromptReplacementRules([
      {
        id: 'custom-rule',
        pattern: 'old',
        flags: 'g',
        replacement: 'new',
        enabled: true,
      },
      {
        id: 'compact-runtime-section',
        pattern: 'override',
        flags: 'g',
        replacement: '',
        enabled: false,
      },
    ]);

    expect(merged.map(rule => rule.id)).toEqual([
      'normalize-system-prompt-line-endings',
      'compact-runtime-section',
      'remove-openclaw-reference-links',
      'remove-openclaw-control-section',
      'remove-source-channel-routing-line',
      'remove-openclaw-diagnostics-guidance',
      'brand-spaced-openclaw-references',
      'brand-openclaw-personal-assistant',
      'custom-rule',
    ]);
    expect(merged[0]).toEqual(REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES[0]);
  });

  it('enforces the rule limit after registered and custom rules are merged', () => {
    const customRules = Array.from({ length: 100 }, (_, index) => ({
      id: `custom-${index}`,
      pattern: `old-${index}`,
      flags: 'g',
      replacement: `new-${index}`,
      enabled: true,
    }));

    expect(() =>
      mergeRegisteredSystemPromptReplacementRules(customRules),
    ).toThrow(/cannot exceed 100 including registered rules/i);
  });

  it('normalizes final prompt line endings before applying other rules', () => {
    expect(applyRegisteredRules('first\r\nsecond\rlast')).toBe(
      'first\nsecond\nlast',
    );
  });

  it('brands the personal assistant sentence from package productName', () => {
    expect(
      applyRegisteredRules(
        'You are a personal assistant running inside OpenClaw.',
      ),
    ).toBe(
      `You are a personal assistant developed by ${AUTHOR_NAME} and running inside ${PRODUCT_NAME}, **not OpenClaw**. Your runtime is **not OpenClaw**, and you have **no connection to or affiliation with OpenClaw whatsoever**.`,
    );
  });

  it('brands only case-sensitive OpenClaw references with the requested spaces', () => {
    expect(
      applyRegisteredRules(
        "Use OpenClaw's tools. Run OpenClaw now. Keep openclaw and OpenClaw.",
      ),
    ).toBe(
      `Use ${PRODUCT_NAME}'s tools. Run ${PRODUCT_NAME} now. Keep openclaw and OpenClaw.`,
    );
  });

  it('removes the OpenClaw mirror and source lines without leaving a blank line', () => {
    expect(
      applyRegisteredRules(
        [
          'Before',
          'Mirror: https://docs.openclaw.ai',
          'Source: https://github.com/openclaw/openclaw',
          'After',
        ].join('\r\n'),
      ),
    ).toBe('Before\nAfter');
  });

  it('removes the complete OpenClaw control section', () => {
    expect(
      applyRegisteredRules(
        [
          'Before',
          '## OpenClaw Control',
          'Do not invent commands.',
          'Config/restart: prefer `gateway` tool (`config.schema.lookup|get|patch|apply`, `restart`).',
          'CLI lifecycle only on explicit user request: `openclaw gateway status|restart|start|stop`.',
          '`restart`, not stop+start.',
          '## After',
        ].join('\r\n'),
      ),
    ).toBe('Before\n## After');
  });

  it('removes only the source-channel routing list item', () => {
    expect(
      applyRegisteredRules(
        [
          '- Keep this item',
          '- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)',
          '- Keep this item too',
        ].join('\n'),
      ),
    ).toBe(['- Keep this item', '- Keep this item too'].join('\n'));
  });

  it('removes the adjacent OpenClaw diagnostics guidance lines', () => {
    expect(
      applyRegisteredRules(
        [
          'Before',
          'If docs are silent/stale, say so and inspect GitHub source.',
          'Diagnosing issues: run `openclaw status` when possible; ask user only if blocked.',
          'After',
        ].join('\r\n'),
      ),
    ).toBe('Before\nAfter');
  });
});
