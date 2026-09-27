// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import hljs from 'highlight.js/lib/common';
import { afterEach, expect, test, vi } from 'vitest';

import SessionReviewPatch from './SessionReviewPatch';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('reuses syntax highlighting across layout changes and recomputes when the patch changes', () => {
  const highlight = vi.spyOn(hljs, 'highlight');
  const patch = '@@ -1 +1 @@\n-const old = 1;\n+const next = 2;';
  const view = render(<SessionReviewPatch patch={patch} path="file.ts" split={false} wrap />);
  const calls = highlight.mock.calls.length;
  expect(calls).toBe(2);
  view.rerender(<SessionReviewPatch patch={patch} path="file.ts" split wrap={false} />);
  expect(highlight).toHaveBeenCalledTimes(calls);
  view.rerender(
    <SessionReviewPatch patch={'@@ -0,0 +1 @@\n+replacement'} path="file.ts" split wrap />,
  );
  expect(highlight).toHaveBeenCalledTimes(calls + 1);
  expect(screen.getByText('replacement')).toBeTruthy();
});

test.each([
  ['@@ -0,0 +1 @@\n+new', 1, '3ch'],
  ['@@ -1 +0,0 @@\n-old', 1, '3ch'],
  ['@@ -12345 +12345 @@\n-old\n+new', 2, '6ch'],
])(
  'sizes line numbers to the patch and omits unused unified columns: %s',
  (patch, count, width) => {
    const { container, rerender } = render(
      <SessionReviewPatch patch={patch} path="file.txt" split={false} wrap />,
    );
    const numbers = container.querySelector('.review-line')!.querySelectorAll('.review-number');
    expect(numbers).toHaveLength(count);
    expect((numbers[0] as HTMLElement).style.width).toBe(width);
    rerender(<SessionReviewPatch patch={patch} path="file.txt" split wrap />);
    for (const line of container.querySelectorAll('.review-line')) {
      expect(line.querySelectorAll('.review-number')).toHaveLength(1);
    }
  },
);
