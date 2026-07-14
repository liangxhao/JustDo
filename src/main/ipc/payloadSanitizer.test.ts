import { describe, expect, test } from 'vitest';

import {
  sanitizeCoworkMessageForIpc,
  sanitizeInteractionRequestForIpc,
  sanitizeIpcPayload,
} from './payloadSanitizer';

describe('sanitizeIpcPayload', () => {
  test('replaces circular references and truncates oversized collections', () => {
    const value: Record<string, unknown> = {
      items: Array.from({ length: 42 }, (_, index) => index),
    };
    value.self = value;

    const result = sanitizeIpcPayload(value) as Record<string, unknown>;

    expect(result.self).toBe('[circular]');
    expect(result.items).toHaveLength(41);
    expect((result.items as unknown[]).at(-1)).toBe('[truncated-items:2]');
  });

  test('preserves image attachments while sanitizing message metadata', () => {
    const attachments = [{ data: 'x'.repeat(5_000) }];

    const result = sanitizeCoworkMessageForIpc({
      content: 'hello',
      metadata: {
        attachments,
        label: 'x'.repeat(5_000),
      },
    }) as { metadata: { attachments: unknown; label: string } };

    expect(result.metadata.attachments).toBe(attachments);
    expect(result.metadata.label.length).toBeLessThan(5_000);
  });

  test('sanitizes interaction tool input', () => {
    const result = sanitizeInteractionRequestForIpc({
      toolInput: { command: 'x'.repeat(5_000) },
    }) as { toolInput: { command: string } };

    expect(result.toolInput.command.length).toBeLessThan(5_000);
  });
});
