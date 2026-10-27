import { PRODUCT_NAME } from '../../../shared/productMetadata';
import {
  normalizeSystemPromptReplacementRules,
  SYSTEM_PROMPT_REPLACEMENT_MAX_RULES,
  type SystemPromptReplacementRule,
} from '../../../shared/prompts/systemPromptReplacements';

const RETIRED_SYSTEM_PROMPT_REPLACEMENT_IDS = new Set([
  'remove-skill-version-lines',
  'remove-skill-version-refresh-guidance',
  'compact-runtime-section',
  'remove-source-channel-routing-line',
  'remove-openclaw-diagnostics-guidance',
  'brand-spaced-openclaw-references',
  'describe-independent-webpage-embeds',
]);

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
      id: 'remove-openclaw-reference-links',
      pattern:
        '^Mirror: https://docs\\.openclaw\\.ai\\nSource: https://github\\.com/openclaw/openclaw(?:\\n|$)',
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'remove-openclaw-control-section',
      // Stop at the next top-level section or actual EOF, not a multiline $.
      pattern:
        '^## OpenClaw Control[\\t ]*(?:\\n|$)[\\s\\S]*?(?=^#{1,2}[\\t ]|(?![\\s\\S]))',
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'brand-openclaw-personal-assistant',
      pattern: 'You are a personal assistant running inside OpenClaw\\.',
      flags: 'g',
      replacement: `You are a personal assistant whose core capabilities are developed by ${PRODUCT_NAME}. OpenClaw only provides the runtime.`,
    },
    {
      id: 'remove-authorized-senders-section',
      pattern:
        '^## Authorized Senders[\\t ]*(?:\\n|$)[\\s\\S]*?(?=^#{1,2}[\\t ]|(?![\\s\\S]))',
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'describe-supported-embed-urls',
      pattern:
        '^- Never local/file:// or arbitrary URL\\. Only hosted Canvas refs/URLs or YouTube video URLs\\.$',
      flags: 'gm',
      replacement:
        '- Use hosted Canvas refs/URLs or viewer-permitted HTTP(S) webpage URLs; otherwise use regular links. Never use file://, local filesystem paths or arbitrary loopback URLs.',
    },
    {
      id: 'remove-control-ui-side-chat-section',
      pattern:
        '^## Control UI Side Chat[\\t ]*(?:\\n|$)[\\s\\S]*?(?=^#{1,2}[\\t ]|(?![\\s\\S]))',
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'remove-care-section',
      pattern:
        '^## Care[\\t ]*(?:\\n|$)[\\s\\S]*?(?=^#{1,2}[\\t ]|(?![\\s\\S]))',
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'brand-webchat-direct-conversation',
      pattern: 'You are in a WebChat direct conversation\\b',
      flags: 'g',
      replacement: `You are in a ${PRODUCT_NAME} direct conversation`,
    },
    {
      id: 'remove-reasoning-stream-guidance',
      pattern:
        '^Reasoning=stream; hidden unless on/stream\\. Toggle /reasoning; /status shows when enabled\\.[\\t ]*(?:\\n|$)',
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'remove-approve-command-guidance',
      pattern:
        '^/approve is user command; never execute via shell/tool\\.[\\t ]*(?:\\n|$)',
      flags: 'gm',
      replacement: '',
    },
    {
      id: 'remove-approval-preview-guidance',
      pattern:
        '^Approval preview: exact full command/script, including chains/multiline\\. Keep preview separate from /approve; never use script as approval id/slug\\.[\\t ]*(?:\\n|$)',
      flags: 'gm',
      replacement: '',
    },
  ]);

export const normalizePersistedSystemPromptReplacementRules = (
  value: unknown,
): SystemPromptReplacementRule[] =>
  normalizeSystemPromptReplacementRules(
    value,
    SYSTEM_PROMPT_REPLACEMENT_MAX_RULES +
      REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES.length +
      RETIRED_SYSTEM_PROMPT_REPLACEMENT_IDS.size,
  );

export const mergeRegisteredSystemPromptReplacementRules = (
  persistedRules: readonly SystemPromptReplacementRule[],
): SystemPromptReplacementRule[] => {
  const registeredIds = new Set(
    REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES.map((rule) => rule.id),
  );
  const customRules = persistedRules.filter(
    (rule) =>
      !registeredIds.has(rule.id) &&
      !RETIRED_SYSTEM_PROMPT_REPLACEMENT_IDS.has(rule.id),
  );
  if (customRules.length > SYSTEM_PROMPT_REPLACEMENT_MAX_RULES) {
    throw new RangeError(
      `Custom system prompt replacement rules cannot exceed ${SYSTEM_PROMPT_REPLACEMENT_MAX_RULES}`,
    );
  }
  return [
    ...REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES.map((rule) => ({ ...rule })),
    ...customRules.map((rule) => ({ ...rule })),
  ];
};
