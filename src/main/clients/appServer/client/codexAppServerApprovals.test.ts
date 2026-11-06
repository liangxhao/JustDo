import { expect, it } from 'vitest';

import { createAppServerApprovalPresenter } from '../protocol/appServerApprovals';
import { createCodexApprovalPresenter } from './codexAppServerApprovals';

it('preserves the existing presenter entry point through the shared protocol module', () => {
  expect(createCodexApprovalPresenter).toBe(createAppServerApprovalPresenter);
});
