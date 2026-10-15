import { describe, expect, test } from 'vitest';

import { appendErrorDisplayDetail, readErrorDisplayDetail } from './errorDisplay';

describe('error display details', () => {
  test.each([
    'Provider finish_reason: content_filter',
    'Provider finish_reason: unsupported_terminal',
    'Selected deployment is paused',
  ])('adds a provider-neutral cause to generic copy: %s', detail => {
    expect(
      appendErrorDisplayDetail('⚠️ Agent run failed (model: provider/model).', detail),
    ).toContain(detail);
    expect(appendErrorDisplayDetail('', detail)).toBe(detail);
    expect(
      appendErrorDisplayDetail('The agent run failed before producing a reply.', detail),
    ).toContain(detail);
  });

  test('preserves classified guidance, avoids duplicates and bounds supplemental text', () => {
    expect(
      appendErrorDisplayDetail('Authentication failed. Re-authenticate.', 'private diagnostic'),
    ).toBe('Authentication failed. Re-authenticate.\nprivate diagnostic');
    expect(appendErrorDisplayDetail('Provider request failed.', 'x'.repeat(3000))).toHaveLength(
      'Provider request failed. '.length + 2000,
    );
    expect(
      appendErrorDisplayDetail('Provider request failed. Existing cause', 'Existing cause'),
    ).toBe('Provider request failed. Existing cause');
    expect(appendErrorDisplayDetail('Provider request failed.', {})).toBe(
      'Provider request failed.',
    );
  });

  test('only reads public redacted fields and rejects unclassified placeholders and invalid statuses', () => {
    expect(
      readErrorDisplayDetail({
        providerErrorMessagePreview: 'Deployment unavailable',
        providerErrorType: 'deployment_error',
        httpStatus: 503,
        rawErrorPreview: 'PRIVATE',
        errorBody: 'PRIVATE',
        request: 'PRIVATE',
      }),
    ).toBe('Deployment unavailable · deployment_error · HTTP 503');
    expect(
      readErrorDisplayDetail({
        providerRuntimeFailureKind: 'unclassified',
        failoverReason: 'unknown',
        httpStatus: 200,
      }),
    ).toBe('');
    for (const httpStatus of [NaN, 403.5, '503', 999])
      expect(readErrorDisplayDetail({ httpStatus })).toBe('');
  });
});
