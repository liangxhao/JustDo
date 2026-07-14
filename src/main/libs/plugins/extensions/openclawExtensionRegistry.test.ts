import { describe, expect, it } from 'vitest';

import { OpenClawExtensionId } from '../../../../shared/openclaw/extensions';
import {
  buildBundledExtensionEntries,
  buildBundledExtensionToolContracts,
} from './openclawExtensionRegistry';

describe('openclawExtensionRegistry', () => {
  it('configures only the AskUser extension callback', () => {
    const entries = buildBundledExtensionEntries(
      {
        askUser: {
          askUserCallbackUrl: 'http://127.0.0.1:1234/askuser',
          secret: 'runtime-secret',
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
        },
      },
    });
  });

  it('does not declare MCP bridge tool contracts', () => {
    expect(buildBundledExtensionToolContracts({ askUser: null }, () => true)).toEqual([]);
  });
});
