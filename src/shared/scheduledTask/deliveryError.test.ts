import { describe, expect, test } from 'vitest';

import { isMissingExternalChannelError } from './deliveryError';

describe('isMissingExternalChannelError', () => {
  test('recognizes the OpenClaw missing-channel routing error', () => {
    expect(
      isMissingExternalChannelError(
        'Channel is required (no configured channels detected). Set delivery.channel explicitly.',
      ),
    ).toBe(true);
  });

  test('does not hide real external delivery failures', () => {
    expect(isMissingExternalChannelError('Webhook returned HTTP 500')).toBe(false);
    expect(isMissingExternalChannelError(null)).toBe(false);
  });
});
