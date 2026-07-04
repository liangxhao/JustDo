import { describe, expect, test, vi } from 'vitest';

import { ExtensionInteractionRouter } from './extensionInteractionRouter';

describe('ExtensionInteractionRouter', () => {
  test('stops at the first handler that owns the request', () => {
    const router = new ExtensionInteractionRouter();
    const fallback = vi.fn(() => ({ handled: true }));
    router.register(() => ({ handled: false }));
    router.register(() => ({ handled: true, answers: { Choice: 'A' } }));
    router.register(fallback);

    expect(router.respond('request-1', { behavior: 'allow' })).toEqual({
      handled: true,
      answers: { Choice: 'A' },
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  test('reports an unhandled request when no extension owns it', () => {
    const router = new ExtensionInteractionRouter();
    router.register(() => ({ handled: false }));

    expect(router.respond('request-1', { behavior: 'deny' })).toEqual({ handled: false });
  });
});
