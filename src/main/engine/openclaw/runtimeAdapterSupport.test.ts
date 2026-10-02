import path from 'path';
import { expect, test } from 'vitest';

import { isWorkspacePathWithin } from './runtimeAdapterSupport';

test.each([
  ['checkout', true],
  ['checkout/packages/api', true],
  ['checkout-other', false],
  ['checkout/../outside', false],
])('protects checkout directory boundaries for %s', (candidate, expected) => {
  const root = path.resolve('test-worktree-paths', 'checkout');
  const workspace = path.resolve('test-worktree-paths', candidate);
  expect(isWorkspacePathWithin(workspace, root)).toBe(expected);
});
