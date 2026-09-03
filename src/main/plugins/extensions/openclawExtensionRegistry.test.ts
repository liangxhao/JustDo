import { describe, expect, it } from 'vitest';

import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import { buildBundledExtensionEntries } from './openclawExtensionRegistry';

describe('openclawExtensionRegistry', () => {
  it('configures the remaining managed extensions', () => {
    const entries = buildBundledExtensionEntries(() => true);

    expect(entries).toEqual({
      [OpenClawExtensionId.ASK_USER_QUESTION]: {
        enabled: true,
      },
      [OpenClawExtensionId.AUTOMATION_PERMISSION]: {
        enabled: true,
        config: {
          unrestrictedAgentIds: ['justdo-scheduler'],
        },
      },
      [OpenClawExtensionId.JUSTDO_RUNTIME_BRIDGE]: {
        enabled: true,
      },
    });
  });
});
