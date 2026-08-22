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
        permissionMode: 'ask',
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
      [OpenClawExtensionId.ACTION_APPROVAL]: {
        enabled: true,
        config: { mode: 'ask', fullAgentIds: ['justdo-scheduler'] },
      },
    });
  });

  it('does not declare MCP bridge tool contracts', () => {
    expect(
      buildBundledExtensionToolContracts(
        {
          askUser: null,
          permissionMode: 'ask',
        },
        () => true,
      ),
    ).toEqual([]);
  });

  it('declares former managed ids for config cleanup', () => {
    expect(listRetiredBundledOpenClawExtensionIds()).toContain('file-permission-policy');
  });
});
