// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';

import { useSpeechTranscriptionActivity } from './useSpeechTranscriptionActivity';

it('releases only the exact input owner across draft and layout replacements', () => {
  const { result, unmount } = renderHook(useSpeechTranscriptionActivity);
  const previous = {};
  const current = {};
  act(() => result.current.changed(true, previous));
  act(() => result.current.changed(true, current));
  act(() => result.current.changed(false, previous));
  expect(result.current.busy).toBe(true);
  expect(result.current.isBusy()).toBe(true);
  act(() => result.current.changed(false, previous));
  expect(result.current.busy).toBe(true);
  act(() => result.current.changed(false, current));
  expect(result.current.busy).toBe(false);
  const changed = result.current.changed;
  unmount();
  expect(() => changed(false, previous)).not.toThrow();
});
