import {
  normalizeSystemPromptReplacementRules,
  SYSTEM_PROMPT_REPLACEMENT_MAX_RULES,
  type SystemPromptReplacementRule,
} from '../../../shared/openclaw/systemPromptReplacements';
import {
  AUTHOR_NAME,
  PRODUCT_NAME,
} from '../../../shared/productMetadata';

/**
 * Built-in final system-prompt replacements belong here. They run before
 * persisted custom rules and are authoritative by id.
 */
export const REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES =
  normalizeSystemPromptReplacementRules([
    {
      id: 'normalize-system-prompt-line-endings',
      pattern: '\\r\\n?',
      flags: 'g',
      replacement: '\n',
    },
    {
      id: 'compact-runtime-section',
      pattern: [
        '^## Runtime\\r?\\n',
        '(?=Runtime:[^\\r\\n]*\\bhost=(?<host>[^|\\r\\n]*?)(?:\\s+\\||\\r?$))',
        '(?=Runtime:[^\\r\\n]*\\brepo=(?<repo>[^|\\r\\n]*?)(?:\\s+\\||\\r?$))',
        '(?=Runtime:[^\\r\\n]*\\bos=(?<os>[^|\\r\\n]*?)(?:\\s+\\||\\r?$))',
        '(?=Runtime:[^\\r\\n]*\\bnode=(?<node>[^|\\r\\n]*?)(?:\\s+\\||\\r?$))',
        '(?=Runtime:[^\\r\\n]*\\bmodel=(?<model>[^|\\r\\n]*?)(?:\\s+\\||\\r?$))',
        '(?=Runtime:[^\\r\\n]*\\bshell=(?<shell>[^|\\r\\n]*?)(?:\\s+\\||\\r?$))',
        'Runtime:[^\\r\\n]*',
        '(?:\\r?\\nCurrent model identity:[^\\r\\n]*)?',
        '(?:\\r?\\nReasoning:[^\\r\\n]*)?',
      ].join(''),
      flags: 'gm',
      replacement:
        '## Runtime\nhost=$<host> | repo=$<repo> | os=$<os> | node=$<node> | model=$<model> | shell=$<shell>',
    },
    {
      id: 'remove-openclaw-reference-links',
      pattern:
        '^Mirror: https://docs\\.openclaw\\.ai\\r?\\nSource: https://github\\.com/openclaw/openclaw(?:\\r?\\n)?',
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'remove-openclaw-control-section',
      pattern: [
        '^## OpenClaw Control\\r?\\n',
        'Do not invent commands\\.\\r?\\n',
        'Config/restart: prefer `gateway` tool \\(`config\\.schema\\.lookup\\|get\\|patch\\|apply`, `restart`\\)\\.\\r?\\n',
        'CLI lifecycle only on explicit user request: `openclaw gateway status\\|restart\\|start\\|stop`\\.\\r?\\n',
        '`restart`, not stop\\+start\\.(?:\\r?\\n)?',
      ].join(''),
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'remove-source-channel-routing-line',
      pattern:
        '^- Reply in current session → automatically routes to the source channel \\(Signal, Telegram, etc\\.\\)(?:\\r?\\n)?',
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'remove-openclaw-diagnostics-guidance',
      pattern: [
        '^If docs are silent/stale, say so and inspect GitHub source\\.\\r?\\n',
        'Diagnosing issues: run `openclaw status` when possible; ask user only if blocked\\.(?:\\r?\\n)?',
      ].join(''),
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'brand-spaced-openclaw-references',
      pattern: " OpenClaw(?='s| )",
      flags: 'g',
      replacement: ` ${PRODUCT_NAME}`,
    },
    {
      id: 'brand-openclaw-personal-assistant',
      pattern: 'You are a personal assistant running inside OpenClaw\\.',
      flags: 'g',
      replacement: `You are a personal assistant developed by ${AUTHOR_NAME} and running inside ${PRODUCT_NAME}, **not OpenClaw**. Your runtime is **not OpenClaw**, and you have **no connection to or affiliation with OpenClaw whatsoever**.`,
    },
  ]);

export const mergeRegisteredSystemPromptReplacementRules = (
  persistedRules: readonly SystemPromptReplacementRule[],
): SystemPromptReplacementRule[] => {
  const registeredIds = new Set(
    REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES.map(rule => rule.id),
  );
  const merged = [
    ...REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES.map(rule => ({ ...rule })),
    ...persistedRules
      .filter(rule => !registeredIds.has(rule.id))
      .map(rule => ({ ...rule })),
  ];
  if (merged.length > SYSTEM_PROMPT_REPLACEMENT_MAX_RULES) {
    throw new RangeError(
      `System prompt replacement rules cannot exceed ${SYSTEM_PROMPT_REPLACEMENT_MAX_RULES} including registered rules`,
    );
  }
  return merged;
};
