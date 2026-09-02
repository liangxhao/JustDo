import { describe, expect, it } from 'vitest';

import { OpenClawExtensionId } from '../../../shared/openclaw/extensions';
import {
  buildBundledExtensionEntries,
  buildBundledExtensionToolContracts,
  listRetiredBundledOpenClawExtensionIds,
} from './openclawExtensionRegistry';

describe('openclawExtensionRegistry', () => {
  it('configures only the AskUser extension callback', () => {
    const entries = buildBundledExtensionEntries(
      {
        askUser: {
          askUserCallbackUrl: 'http://127.0.0.1:1234/askuser',
          secret: 'runtime-secret',
          timeoutMinutes: 45,
        },
      },
      () => true,
    );

    expect(entries).toEqual({
      [OpenClawExtensionId.ASK_USER_QUESTION]: {
        enabled: true,
        config: {
          callbackUrl: 'http://127.0.0.1:1234/askuser',
          secret: '${JUSTDO_ASK_USER_SECRET}',
          timeoutMinutes: 45,
        },
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

  it('does not declare MCP bridge tool contracts', () => {
    expect(
      buildBundledExtensionToolContracts(
        {
          askUser: null,
        },
        () => true,
      ),
    ).toEqual([]);
  });

  it('declares former managed ids for config cleanup', () => {
    expect(listRetiredBundledOpenClawExtensionIds()).toEqual([
      'action-approval',
      'file-permission-policy',
    ]);
  });
});
