import { describe, expect, test } from 'vitest';

import {
  browserConnectionVerificationReducer,
  initialBrowserConnectionVerificationState,
} from './browserConnectionVerification';

describe('browserConnectionVerificationReducer', () => {
  test('keeps extension verification when user Chrome status becomes invalid', () => {
    const connected = { user: true, extension: true };

    expect(
      browserConnectionVerificationReducer(connected, { type: 'set-user', verified: false }),
    ).toEqual({ user: false, extension: true });
  });

  test('keeps user Chrome verification when an extension test starts', () => {
    const connected = { user: true, extension: true };

    expect(
      browserConnectionVerificationReducer(connected, {
        type: 'set-extension',
        verified: false,
      }),
    ).toEqual({ user: true, extension: false });
  });

  test('resets both verification modes on a browser mode change', () => {
    expect(
      browserConnectionVerificationReducer({ user: true, extension: true }, { type: 'reset' }),
    ).toEqual(initialBrowserConnectionVerificationState);
  });
});
