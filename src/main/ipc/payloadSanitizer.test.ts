import { describe, expect, test } from 'vitest';

import {
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

  test('sanitizes interaction tool input', () => {
    const result = sanitizeInteractionRequestForIpc({
      toolInput: { command: 'x'.repeat(5_000) },
    }) as { toolInput: { command: string } };

    expect(result.toolInput.command.length).toBeLessThan(5_000);
  });
});
