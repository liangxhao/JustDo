import { describe, expect, it } from 'vitest';

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import {
  mergeRegisteredSystemPromptReplacementRules,
  normalizePersistedSystemPromptReplacementRules,
  REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES,
} from './systemPromptReplacementRegistry';

const applyRegisteredRules = (prompt: string): string =>
  REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES.reduce(
    (result, rule) =>
      rule.enabled === false
        ? result
        : result.replace(new RegExp(rule.pattern, rule.flags), rule.replacement),
    prompt,
  );

const retiredRuleIds = [
  'remove-skill-version-lines',
  'remove-skill-version-refresh-guidance',
  'compact-runtime-section',
  'remove-source-channel-routing-line',
  'remove-openclaw-diagnostics-guidance',
  'brand-spaced-openclaw-references',
];

const makeCustomRules = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `custom-${index}`,
    pattern: `old-${index}`,
    flags: 'g',
    replacement: `new-${index}`,
    enabled: true,
  }));

const removedSections = [
  {
    title: 'OpenClaw Control',
    body: [
      'Do not invent commands.',
      'For the Gateway hosting this session: In a connected chat, the owner can send `/update` with commands.restart enabled (the default), regardless of the agent\'s tool profile. For a chat update request, direct the user to `/update`. Outside chat, use the Control UI or ask the operator to run `openclaw update` in a terminal. Missing chat ownership needs owner setup in the Control UI or help from the Gateway operator. Never run openclaw update, npm install -g openclaw, swap installations, or stop/restart the gateway service via exec or detached jobs.',
      'For a user-requested update on another host, verify it is not this Gateway, then use exec/SSH with `openclaw update --yes`; normal exec approvals still apply.',
    ],
    nextSection: ['## Skills', 'Use these skills for the requested task.'],
  },
  {
    title: 'Authorized Senders',
    body: ['Allowlisted senders: gateway-client. Allowlisted != owner.'],
    nextSection: [
      '## UI Presentation',
      '`show_widget`: author widgets using this turn\'s schema. pin=true saves to the dashboard; status=pinned means the widget is on the session dashboard. Follow result.presentation when present. Inline availability is per turn, including after restart.',
      'Inspect widgets in their chat/dashboard frame; do not open hosting URLs as browser pages. Verify the delivered interaction or say unverified.',
      '## Control UI Embed',
      'Keep embed guidance.',
    ],
  },
  {
    title: 'Control UI Side Chat',
    body: [
      '- Operator has a read-only Side chat for this session\'s status and explanations.',
      '- On request, do not spawn sub-agents or burn main-thread turns merely to summarize status or re-explain recent work.',
      '- Reserve `sessions_spawn` for delegated work with its own deliverable.',
    ],
    nextSection: ['## Messaging', 'Keep messaging guidance.'],
  },
  {
    title: 'Care',
    body: [
      'Before config/scheduler edits (crontab/systemd/nginx/shell rc/timers): inspect; preserve/merge. Whole-file replacement only explicit.',
      'Use or store credentials the user supplies as requested, and complete the task. In the final reply, briefly acknowledge how the supplied credential was used or stored, without repeating its value. Keep the acknowledgment factual and non-alarming.',
      'For user-requested login or pairing in a group, deliver short-lived codes and verification URLs only to the requesting user in private, then acknowledge in the group without them.',
      'Channel, provider, and credential setup: terminal `openclaw channels add <channel>` or `openclaw configure` masks secrets.',
    ],
    nextSection: ['## Runtime Context', 'Keep runtime context.'],
  },
];

describe('registered system prompt replacements', () => {
  it('keeps registered rules first and authoritative by id', () => {
    const customRule = makeCustomRules(1)[0];
    const merged = mergeRegisteredSystemPromptReplacementRules([
      customRule,
      {
        id: 'normalize-system-prompt-line-endings',
        pattern: 'override',
        flags: 'g',
        replacement: '',
        enabled: false,
      },
    ]);

    expect(merged.map(rule => rule.id)).toEqual([
      'normalize-system-prompt-line-endings',
      'remove-openclaw-reference-links',
      'remove-openclaw-control-section',
      'brand-openclaw-personal-assistant',
      'remove-authorized-senders-section',
      'remove-control-ui-side-chat-section',
      'remove-care-section',
      'brand-webchat-direct-conversation',
      'remove-reasoning-stream-guidance',
      'remove-approve-command-guidance',
      'remove-approval-preview-guidance',
      customRule.id,
    ]);
    expect(merged).toEqual([
      ...REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES,
      customRule,
    ]);
  });

  it('enforces the custom rule limit without counting registered rules', () => {
    expect(mergeRegisteredSystemPromptReplacementRules(makeCustomRules(100)))
      .toHaveLength(REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES.length + 100);
    expect(() => mergeRegisteredSystemPromptReplacementRules(makeCustomRules(101)))
      .toThrow(/custom system prompt replacement rules cannot exceed 100/i);
  });

  it('drops retired built-ins from persisted rules while preserving 100 custom rules', () => {
    const retiredRules = retiredRuleIds.map(id => ({
      id,
      pattern: 'legacy',
      flags: 'g',
      replacement: '',
      enabled: true,
    }));
    const customRules = makeCustomRules(100);
    const persistedRules = [
      ...REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES,
      ...retiredRules,
      ...customRules,
    ];

    const merged = mergeRegisteredSystemPromptReplacementRules(
      normalizePersistedSystemPromptReplacementRules(persistedRules),
    );

    expect(merged).toEqual([
      ...REGISTERED_SYSTEM_PROMPT_REPLACEMENT_RULES,
      ...customRules,
    ]);
    expect(merged.map(rule => rule.id)).not.toEqual(
      expect.arrayContaining(retiredRuleIds),
    );
  });

  it('normalizes final prompt line endings before applying other rules', () => {
    expect(applyRegisteredRules('first\r\nsecond\rlast')).toBe(
      'first\nsecond\nlast',
    );
  });

  it('preserves the content previously changed by retired rules', () => {
    const prompt = [
      '<version>sha256:9ca91d19ad880c94</version>',
      "If a skill's <version> differs from a previous turn, re-read its SKILL.md before using it.",
      "If a skill's <version> differs from a previous turn, re-read that skill before using it.",
      '## Runtime',
      'Runtime: agent=main | session=agent:main:chat:sample | host=DESKTOP | repo=C:\\project | os=Windows_NT | node=v24.18.0 | model=internal/model | shell=pwsh | channel=webchat',
      'Current model identity: internal/model. If asked what model you are, answer with this value for the current run.',
      'Reasoning: stream (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.',
      '- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)',
      'If docs are silent/stale, say so and inspect GitHub source.',
      'Diagnosing issues: run `openclaw status` when possible; ask user only if blocked.',
      "Use OpenClaw's tools. Run OpenClaw now. Keep openclaw and OpenClaw.",
    ].join('\n');

    expect(applyRegisteredRules(prompt)).toBe(prompt);
  });

  it('attributes core capabilities to the product and only the runtime to OpenClaw', () => {
    expect(applyRegisteredRules('You are a personal assistant running inside OpenClaw.'))
      .toBe(`You are a personal assistant whose core capabilities are developed by ${PRODUCT_NAME}. OpenClaw only provides the runtime.`);
  });

  it('brands only the specified WebChat direct-conversation phrase', () => {
    expect(applyRegisteredRules([
      'You are in a WebChat direct conversation with the user.',
      'Other WebChat references remain unchanged.',
      'You are in a WebChat group conversation.',
    ].join('\n'))).toBe([
      `You are in a ${PRODUCT_NAME} direct conversation with the user.`,
      'Other WebChat references remain unchanged.',
      'You are in a WebChat group conversation.',
    ].join('\n'));
  });

  it('removes the exact adjacent mirror and source lines', () => {
    expect(applyRegisteredRules([
      'Before',
      'Mirror: https://docs.openclaw.ai',
      'Source: https://github.com/openclaw/openclaw',
      'After',
    ].join('\r\n'))).toBe('Before\nAfter');

    const otherReferences = [
      'Mirror: https://docs.openclaw.ai/other',
      'Source: https://github.com/openclaw/openclaw',
      'Mirror: https://docs.openclaw.ai',
      'Keep this separator.',
      'Source: https://github.com/openclaw/openclaw',
    ].join('\n');
    expect(applyRegisteredRules(otherReferences)).toBe(otherReferences);
  });

  it.each(removedSections)('removes $title while preserving the next section', ({
    title,
    body,
    nextSection,
  }) => {
    expect(applyRegisteredRules([
      'Before',
      `## ${title}`,
      ...body,
      ...nextSection,
    ].join('\r\n'))).toBe(['Before', ...nextSection].join('\n'));
  });

  it.each(removedSections)('handles $title section boundaries and nested headings', ({ title }) => {
    expect(applyRegisteredRules([
      `## ${title} \t`,
      'Remove this body.',
      '### Nested heading',
      'Remove this child body.',
      '# After',
      'Keep this body.',
    ].join('\n'))).toBe('# After\nKeep this body.');
    expect(applyRegisteredRules(`Before\n## ${title}\nRemove through EOF.`))
      .toBe('Before\n');
    expect(applyRegisteredRules(`Before\n## ${title}`)).toBe('Before\n');
  });

  it.each(removedSections)('preserves headings that only resemble $title', ({ title }) => {
    const prompt = [
      `## ${title} Additional Notes`,
      'Keep this body.',
      `### ${title}`,
      'Keep this child body.',
      `Mention ## ${title} inside a line.`,
    ].join('\n');

    expect(applyRegisteredRules(prompt)).toBe(prompt);
  });

  it('removes only the specified stream reasoning line', () => {
    expect(applyRegisteredRules([
      'Before',
      'Reasoning=stream; hidden unless on/stream. Toggle /reasoning; /status shows when enabled.',
      'Reasoning=on; hidden unless on/stream. Toggle /reasoning; /status shows when enabled.',
      'Reasoning=off; hidden unless on/stream. Toggle /reasoning; /status shows when enabled.',
      'After',
    ].join('\n'))).toBe([
      'Before',
      'Reasoning=on; hidden unless on/stream. Toggle /reasoning; /status shows when enabled.',
      'Reasoning=off; hidden unless on/stream. Toggle /reasoning; /status shows when enabled.',
      'After',
    ].join('\n'));
  });

  it('removes the two approval guidance lines and preserves allow-once', () => {
    expect(applyRegisteredRules([
      'Before',
      '/approve is user command; never execute via shell/tool.',
      'allow-once covers only that exact command; later commands need their own exec policy decision.  ',
      'Approval preview: exact full command/script, including chains/multiline. Keep preview separate from /approve; never use script as approval id/slug.',
      'Approval preview: keep other guidance.',
      'After',
    ].join('\r\n'))).toBe([
      'Before',
      'allow-once covers only that exact command; later commands need their own exec policy decision.  ',
      'Approval preview: keep other guidance.',
      'After',
    ].join('\n'));
  });
});
